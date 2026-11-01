// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL*/
/*eslint no-undef: "error"*/



/**
* TOOL_NUMISDATA_ORDER_COINS (module)
* Client-side controller for the numismatic coin ordering/grouping tool.
*
* This tool provides a two-panel UI for managing numismatic coin records:
*   - Left panel  — a mosaic view (`coins` portal, role "coins") showing all coins in a
*                   collection, sortable by weight (numisdata133) or diameter (numisdata135).
*                   Each coin tile exposes original/copy radio buttons and a drag handle.
*   - Right panel — a relation portal (`ordered_coins`, role "ordered_coins") where users
*                   drop coin locators to define the authoritative ordering for a lot.
*
* Drag-and-drop contract:
*   Coin tiles in the left mosaic carry a JSON-encoded locator in their `dataTransfer`
*   payload (text/plain). Dropping onto an `ordered_coins` cell calls `assign_element`,
*   which issues an 'insert' change_value to the target component.  After every drop the
*   right panel is rebuilt (`get_ordered_coins`), which binds the delegated drop
*   listener (`bind_ordered_coins_drop`) on the new portal wrapper.
*
* Original / copy workflow:
*   Each coin tile also shows radio buttons (Original / Copy) rendered by
*   `render_column_original_copy` in `view_coins_mosaic_portal.js`. When the user
*   selects one or more originals and copies and clicks "Set Original / Copy", the tool
*   calls `set_original_copy`, which:
*     1. Writes the discard code (section_id '1' = original, '2' = copy) to the
*        numisdata157 component of each selected coin section.
*     2. Writes the set of copy locators into the numisdata55 (equivalents) relation
*        component on each original section.
*
* Exports:
*   tool_numisdata_order_coins — constructor / ES-module default export; prototype
*       methods are assigned below and by tool_common / common / render_tool_*.
*/

// import
	import {common} from '../../../core/common/js/common.js'
	import {event_manager} from '../../../core/common/js/event_manager.js'
	import {get_instance} from '../../../core/common/js/instances.js'
	import {tool_common} from '../../../core/tools_common/js/tool_common.js'
	import {bind_ordered_coins_drop, render_tool_numisdata_order_coins } from './render_tool_numisdata_order_coins.js'



/**
* TOOL_NUMISDATA_ORDER_COINS
* Constructor for the coin-ordering tool instance.
* All shared tool lifecycle methods (init, build, render, destroy, refresh) are wired
* via prototype assignment from tool_common, common, and render_tool_numisdata_order_coins.
*
* Instance properties seeded here are overwritten during `init` / `build`; they exist
* as null sentinels so that introspection before init returns predictable values.
*
* @returns {boolean} Always true (Dédalo constructor sentinel).
*/
export const tool_numisdata_order_coins = function () {

	this.id							= null
	this.model						= null
	this.mode						= null
	this.node						= null
	this.ar_instances				= null
	this.status						= null
	this.events_tokens				= []
	this.type						= null
	this.source_lang				= null
	this.target_lang				= null
	this.langs						= null
	this.caller						= null
	this.media_component			= null // component av that will be transcribed (it could be the caller)
	this.epigraphy	= null // component text area where we are working into the tool
	this.relation_list				= null // datum of relation_list (to obtaim list of top_section_tipo/id)

	return true
}//end tool_numisdata_order_coins



/**
* COMMON FUNCTIONS
* Prototype assignments that wire the shared tool/component lifecycle into this
* constructor.  These overwrite the null defaults set in the constructor above.
*
* render  — from tool_common: delegates to the concrete edit/read view depending on mode.
* destroy — from common: tears down event subscriptions, child instances, and DOM.
* refresh — from common: re-runs build + render without creating a new instance.
* edit    — from render_tool_numisdata_order_coins: the concrete two-panel edit view.
*/
// prototypes assign
	tool_numisdata_order_coins.prototype.render		= tool_common.prototype.render
	tool_numisdata_order_coins.prototype.destroy	= common.prototype.destroy
	tool_numisdata_order_coins.prototype.refresh	= common.prototype.refresh
	tool_numisdata_order_coins.prototype.edit		= render_tool_numisdata_order_coins.prototype.edit



/**
* INIT
* Initialises the tool instance by calling the generic tool_common init and then
* resolving the tool-specific properties that tool_common does not know about.
*
* Specific properties set here:
*   - `langs`       — full list of project languages from `page_globals` (used by the
*                     render layer when populating language-sensitive UI elements).
*   - `source_lang` — inherited from the calling component's `lang`, or null when the
*                     tool is opened independently (e.g. from a window URL).
*   - `target_lang` — not used by this tool; left null for API parity with translation
*                     tools that share the same init signature.
*
* @param {Object} options - Standard tool init options forwarded verbatim to tool_common.
* @returns {Promise<*>} Resolves to the return value of `tool_common.prototype.init`
*     (typically the initialised instance or a sentinel value).
*/
tool_numisdata_order_coins.prototype.init = async function(options) {

	const self = this

	// call the generic common tool init
		const common_init = await tool_common.prototype.init.call(this, options);

	try {

		// set the self specific vars not defined by the generic init (in tool_common)
			self.langs			= page_globals.dedalo_projects_default_langs
			self.source_lang	= self.caller && self.caller.lang
				? self.caller.lang
				: null
			self.target_lang	= null

	} catch (error) {
		self.error = error
		console.error(error)
	}


	return common_init
}//end init



/**
* BUILD
* Runs after `init`. Delegates first to `tool_common.prototype.build` to load the
* tool CSS and resolve all `ddo_map` entries into live instances stored in
* `self.ar_instances`.  Then resolves the two named roles:
*
*   "coins"         — the source portal (component_portal / mosaic view) listing all
*                     coins in the current collection.  Stored as `self.coins`.
*   "ordered_coins" — the destination portal where users drop locators to define the
*                     sorted order.  Stored as `self.ordered_coins`.
*
* For `ordered_coins` two event subscriptions are added to its own `events_tokens` so
* that drop-zone listeners are re-wired whenever the portal refreshes internally
* (window_blur_ = external-window close refresh) or gains a new row (add_row_):
*
*   'window_blur_<ordered_coins.id>' → `bind_ordered_coins_drop` on the portal's current
*                                      wrapper (idempotent per wrapper)
*   'add_row_<ordered_coins.id>'     → same as above
*
* Roles missing from the Ontology's ddo_map are skipped with a console warning
* rather than throwing, allowing partial configurations to render gracefully.
*
* @param {boolean} [autoload=false] - When true, tool_common will auto-fetch remote data
*     for each ddo_map component.  Pass false to defer loading.
* @returns {Promise<*>} Resolves to the return value of `tool_common.prototype.build`.
*/
tool_numisdata_order_coins.prototype.build = async function(autoload=false) {

	const self = this

	// call generic common tool build
		const common_build = await tool_common.prototype.build.call(this, autoload);

	try {
		const roles = [
			'coins',
			'ordered_coins',
		];
		const roles_length = roles.length
		for (let i = 0; i < roles_length; i++) {
			const role = roles[i]

			// fix media_component for convenience
			const ddo = self.tool_config.ddo_map.find(el => el.role===role)
			if (!ddo) {
				console.warn(`Warning: \n\tThe role '${role}' it's not defined in Ontology and will be ignored`);
				continue;
			}
			self[role] = self.ar_instances.find(el => el.tipo===ddo.tipo)

			if(role === 'ordered_coins'){
				// the portal refreshes itself (external window close, a new row): a full
				// refresh replaces its wrapper node, so the delegated drop listener is
				// bound again on the CURRENT node (idempotent per wrapper)
				const rebind_drop = () => {
					bind_ordered_coins_drop(self, self.ordered_coins.node)
				}
				self.ordered_coins.events_tokens.push(
					event_manager.subscribe(`window_blur_${self.ordered_coins.id}`, rebind_drop)
				)
				self.ordered_coins.events_tokens.push(
					event_manager.subscribe(`add_row_${self.ordered_coins.id}`, rebind_drop)
				)
			}
		}

		// relation_list. load_relation_list. Get the relation list.
			// This is used to build a select element to allow
			// user select the top_section_tipo and top_section_id of current transcription
			// self.relation_list = await self.load_relation_list()

	} catch (error) {
		self.error = error
		console.error(error)
	}


	return common_build
}//end build



/**
* ASSIGN_ELEMENT
* Inserts a coin locator into the target `ordered_coins` relation component.
* Called by the drop handler bound by `bind_ordered_coins_drop`
* each time the user drops a coin tile onto a cell in the ordered-coins portal.
*
* A single 'insert' change_value action is issued against `caller` (the component
* instance that owns the drop-zone cell, i.e. the numisdata9 component of the
* target ordered_coins row).  The `refresh` flag is set to false because the caller
* (`get_ordered_coins`) manually rebuilds the right panel after this promise resolves.
*
* @param {Object} options
* @param {Object} options.locator - Locator object describing the coin to insert
*     (typically `{section_tipo, section_id}` matching the dragged tile).
* @param {Object} options.caller  - The component instance of the drop-zone cell.
*     Must expose a `change_value` method compatible with the Dédalo component API.
* @returns {Promise<Object>} Resolves to the API response returned by `change_value`.
*/
tool_numisdata_order_coins.prototype.assign_element = function(options){

	const locator	= options.locator
	const caller	= options.caller

	const changed_data = [{
		action	: 'insert',
		value	: locator
	}]
	// change_value (save data)
	const change = caller.change_value({
		changed_data	: changed_data,
		refresh			: false
	})

	return change
}//end assign_element



/**
* SET_ORIGINAL_COPY
* Persists the "original" or "copy" status for each user-selected coin and writes
* the equivalence (copy) relations on the originals.
*
* This method is triggered by the "Set Original / Copy" header button.  It receives
* two arrays of checked radio-button DOM nodes from the left-panel mosaic and writes
* the correct discard-status values to the numisdata157 component of each affected
* coin section.  It also wires up the numisdata55 (equivalents) relation on every
* original so that the system knows which copies correspond to which originals.
*
* Data written per ORIGINAL coin (section_id supplied by the radio input node):
*   - numisdata157 (discard/status component): 'update' action; value =
*       {section_id: '1', section_tipo: 'numisdata341'}
*       (section_id '1' in numisdata341 = "original" code value)
*   - numisdata55 (component_relation_related, equivalents): 'set_data' action; value =
*       array of {section_id, section_tipo} locators for every copy in `ar_copies`.
*
* Data written per COPY coin:
*   - numisdata157: 'update' action; value =
*       {section_id: '2', section_tipo: 'numisdata341'}
*       (section_id '2' in numisdata341 = "copy" code value)
*
* After writing, the radio node is unchecked and its sibling label gains the
* appropriate CSS class ('label_original' or 'label_copy') for visual feedback.
*
* (!) `discard_context` is read once from `self.coins.datum.context` and reused for
*     all iterations; only `section_id` is mutated on `discard_options` per loop.
*
* @param {Object} options
* @param {Array}  options.ar_original - Checked input[type=radio].input_original nodes
*     from the left-panel mosaic; each must carry a `.section_id` property.
* @param {Array}  options.ar_copies   - Checked input[type=radio].input_copy nodes
*     from the left-panel mosaic; each must carry a `.section_id` property.
* @returns {Promise<boolean>} Always resolves to true when all writes complete.
*/
tool_numisdata_order_coins.prototype.set_original_copy = async function(options) {

	const self = this

	const ar_original	= options.ar_original
	const ar_copies		= options.ar_copies
	// resolve the discard component context once; section_id is overwritten per iteration
	const discard_context	= self.coins.datum.context.find(item => item.tipo === 'numisdata157')

	const discard_options	= {
			model			: discard_context.model,
			mode			: discard_context.mode,
			tipo			: discard_context.tipo,
			section_tipo	: discard_context.section_tipo,
			lang			: discard_context.lang,
			section_lang	: discard_context.section_lang,
			type			: discard_context.type,
			context 		: discard_context
		}

	const ar_original_len	= ar_original.length
	for (let i = ar_original_len - 1; i >= 0; i--) {
		const original_node		= ar_original[i]
		const section_id		= original_node.section_id

		// discard
			discard_options.section_id	= section_id
			const discard_instance		= await get_instance(discard_options)
			await discard_instance.build(false)
			// force to save current input if changed
			const changed_data = [{
				action	: 'update',
				id		: discard_instance.data.entries[0]?.id || null,
				value	: {section_id: '1', section_tipo: 'numisdata341'}
			}]
			// change_value (save data)
			discard_instance.change_value({
				changed_data	: changed_data,
				refresh			: false
			})

		// reset node
			original_node.checked = false
			original_node.label.classList.add('label_original')

		// equivalents
			const equivalents_instance	= await get_instance({
				model			: 'component_relation_related',
				mode			: 'edit',
				tipo			: 'numisdata55',
				section_tipo	: discard_context.section_tipo,
				section_id		: section_id,
				lang			: 'lg_nolan',
				section_lang	: discard_context.section_lang,
				type			: discard_context.type,

			})
			await equivalents_instance.build(true)
			// force to save current input if changed
			// build copy locators from the copy-node array using the coins section_tipo
			const copy_values = ar_copies.map((el) =>
				({section_id:el.section_id, section_tipo: discard_context.section_tipo})
			)

			const equivalents_changed_data = [{
				action	: 'set_data',
				value	: copy_values
			}]
			// change_value (save data)
			equivalents_instance.change_value({
				changed_data	: equivalents_changed_data,
				refresh			: false
			})
	}//end for (let i = ar_original_len - 1; i >= 0; i--)


	const ar_copies_len	= ar_copies.length
	for (let i = ar_copies_len - 1; i >= 0; i--) {
		const copy_node		= ar_copies[i]
		const section_id	= copy_node.section_id

		// discard
			discard_options.section_id	= section_id
			const discard_instance		= await get_instance(discard_options)
			await discard_instance.build(false)
			// force to save current input if changed
			const changed_data = [{
				action	: 'update',
				id		: discard_instance.data.entries[0]?.id || null,
				value	: {section_id: '2', section_tipo: 'numisdata341'}
			}]
			// change_value (save data)
			discard_instance.change_value({
				changed_data	: changed_data,
				refresh			: false
			})

		// reset node
			copy_node.checked = false
			copy_node.label.classList.add('label_copy')
	}//end for (let i = ar_copies_len - 1; i >= 0; i--)

	return true
}//end set_original_copy



// @license-end
