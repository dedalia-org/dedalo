// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL*/
/*eslint no-undef: "error"*/



/**
* COMPONENT_SELECT
* Client-side model for the component_select component — a single-value
* dropdown that stores a locator ({section_id, section_tipo}) pointing to a
* record in a fixed set of allowed target sections.
*
* Responsibilities:
* - Holds instance state (tipo, section_tipo, context, data, …).
* - Delegates lifecycle (init/build/render/refresh/destroy) and persistence
*   (save/update_data_value/change_value) to the shared component_common and
*   common prototypes.
* - Exposes render entry-points (edit/list/tm/search) implemented by the
*   dedicated render_* sub-modules.
* - Exports the stateless helpers `build_changed_data_item` and
*   `handle_select_change` for use by all view sub-modules.
*
* Data shape (self.data):
*   {
*     entries  : [{id, section_id, section_tipo}, …],  // at most one entry for select
*     datalist : [{label, value: {section_id, section_tipo}}, …]
*   }
*
* @module component_select
*/

// imports
	import {common, create_source} from '../../common/js/common.js'
	import {component_common} from '../../component_common/js/component_common.js'
	import {data_manager} from '../../common/js/data_manager.js'
	import {clone} from '../../common/js/utils/index.js'
	import {render_edit_component_select} from './render_edit_component_select.js'
	import {render_list_component_select} from './render_list_component_select.js'
	import {render_search_component_select} from './render_search_component_select.js'
	import {request_failed, response_data} from '../../common/js/api_error.js'
	import {handle_api_error} from '../../common/js/error_dispatch.js'



/**
* COMPONENT_SELECT
* Constructor for the component_select instance.
* All properties are intentionally left uninitialized here (undefined) so that
* component_common.prototype.init populates them from the options object.
* The only exception is minimum_width_px, which carries a UI default that
* view sub-modules may override.
*/
export const component_select = function(){

	this.id

	// element properties declare
	this.model        // {string} structure model name, e.g. 'component_select'
	this.tipo         // {string} component structure tipo, e.g. 'dd745'
	this.section_tipo // {string} parent section tipo, e.g. 'oh1'
	this.section_id   // {number|string} current record's section_id
	this.mode         // {string} rendering mode: 'edit' | 'list' | 'search'
	this.lang         // {string} active language code, e.g. 'lg-eng'

	this.section_lang // {string} section-level language (may differ from component lang)
	this.context      // {Object} server-side context: properties, tools, permissions, view, etc.
	this.data         // {Object} component data: entries array + datalist for option rendering
	this.parent       // {string} tipo of the structural parent (section group, portal, etc.)
	this.node         // {HTMLElement|null} the component's root DOM node once rendered

	this.tools        // {Array} tool instances attached to this component

	this.datum        // {Object|null} full datum payload including dependent data (portals, etc.)

	// ui
	this.minimum_width_px = 120 // integer pixels — minimum CSS width applied to the select wrapper
}//end component_select



/**
* COMMON FUNCTIONS
* Extend component_select with shared lifecycle, persistence, and render
* prototypes. No logic is defined here — these assignments wire in the
* canonical implementations from component_common and common so that all
* Dédalo components behave uniformly.
*
* Commented-out lines (build_rqo / build_rqo_show) are preserved as future
* override points: when component_select needs custom request-query-object
* construction, uncomment and implement locally.
*/
	// prototypes assign
	// lifecycle
	component_select.prototype.init					= component_common.prototype.init
	component_select.prototype.build				= component_common.prototype.build
	component_select.prototype.render				= common.prototype.render
	component_select.prototype.refresh				= common.prototype.refresh
	component_select.prototype.destroy				= common.prototype.destroy

	// change data
	component_select.prototype.save					= component_common.prototype.save
	component_select.prototype.update_data_value	= component_common.prototype.update_data_value
	component_select.prototype.update_datum			= component_common.prototype.update_datum
	component_select.prototype.change_value			= component_common.prototype.change_value
	component_select.prototype.set_changed_data		= component_common.prototype.set_changed_data
	// component_select.prototype.build_rqo			= common.prototype.build_rqo
	// component_select.prototype.build_rqo_show	= common.prototype.build_rqo_show

	// render — delegates to the matching render_* sub-module
	component_select.prototype.list					= render_list_component_select.prototype.list
	component_select.prototype.edit					= render_edit_component_select.prototype.edit
	component_select.prototype.search				= render_search_component_select.prototype.search

	component_select.prototype.change_mode			= component_common.prototype.change_mode



/**
* ADD_NEW_ELEMENT
* Creates a new record in the target section and stores the returned locator
* as the component's value. Triggered by the "Add" toolbar button.
*
* Because component_select is single-value, any existing entry is wiped by an
* explicit `action:'clear'` save before the 'add_new_element' save is issued.
* The server answers envelope v2 and the created record's datum arrives in
* `data` (read through response_data); the component is then rebuilt so the new
* value renders.
*
* WHY 'clear' AND NOT A REMOVE BY ID (DATA-06, 2026-08-30). Emptying the one
* slot before creating its replacement is a deliberate wipe of everything the
* component holds, which is exactly what `clear` means on both ends
* (component_common.update_data_value and save_component.ts applySaveComponentData
* both treat it as "wipe entries, every language"). A `remove` would have to name
* an id, and the two ids available here are both wrong for this gesture: an
* entry with NO id (an unsaved or malformed slot — null, undefined or '', not
* `0`, which is a real and deletable id) is REFUSED by the server
* (`record.remove_without_id`), and naming only entries[0].id would leave
* any extra locator behind in a component that is supposed to hold at most one.
* `clear` restores the single-value invariant unconditionally.
*
* NOT ATOMIC: this is two saves. When the clear succeeds and the creation save
* fails, the component is left empty (the local model is emptied to match) and
* the function returns false — the previous value is gone. Merging both changes
* into ONE rqo is not done here because the save handler's echo branch keys on
* `changed_data[0].action` (src/core/api/handlers/dd_core_api.ts) and would stop
* seeing the add.
*
* Default project assignment (based on user privileges) is handled server-side.
*
* @param {string} target_section_tipo - Structure tipo of the section in which
*   to create the new record, e.g. 'rsc197'.
* @returns {Promise<boolean>} true on success; false when either the clear save
*   or the creation save fails.
*/
component_select.prototype.add_new_element = async function(target_section_tipo) {

	const self = this

	// check current value. LImit to one
	// (component_select is single-value: remove any pre-existing entry before adding)
		const current_data	= self.data || {}
		const entries		= current_data.entries || []
		if (entries.length>0) {
			// wipe the previous value. 'clear' is the deliberate-wipe action; a
			// remove with id:null is refused by BOTH ends since DATA-06 (see the
			// docblock above).
			const clear_changed_data_item = {
				action	: 'clear',
				id		: null,
				value	: null
			}
			const source = create_source(self, null)
			const data = clone(self.data)
			data.changed_data = [clear_changed_data_item]
			const rqo = {
				action	: 'save',
				source	: source,
				data	: data
			}
			// data_manager. wipe the current value
				const api_response = await data_manager.request({
					body : rqo
				})
				if(SHOW_DEBUG===true) {
					console.log('add_new_element clear previous api_response:', api_response);
				}
				// THE failure test on a data_manager envelope (envelope v2): the
				// transport attaches an ApiError under `error` on every failure and
				// nothing on success. There is no `response` key at all, so the old
				// `api_response.response===false` read `undefined===false` and could
				// never fire — a guard that had been dead here for as long as the
				// envelope has been v2.
				//
				// It cost nothing while the clearing save always succeeded, which is
				// why nobody noticed. It stopped being free the moment the server
				// began REFUSING an id-less remove (DATA-06, 2026-08-30): this call
				// hand-builds its own rqo and posts it straight through
				// data_manager.request, bypassing both client doors, so the refusal
				// would have fallen through the dead guard into the creation save and
				// left a single-value component holding TWO locators plus a newly
				// created target record, with no visible symptom. The clear spelling
				// above and this test landed together for that reason.
				if (request_failed(api_response)) {
					console.error('Error clearing previous value. api_response:', api_response);
					alert("Error on remove previous value"); // (!) alert used intentionally for user-facing blocking error
					return false;
				}
			// keep the local model in step with what the server just did, so the
			// component does not go on showing a value the database no longer has.
				self.update_data_value(clear_changed_data_item)
		}

	// source
		const source = create_source(self, null)

	// data
	// pass target_section_tipo as the value so the server knows which section to create in
		const data = clone(self.data)
		data.changed_data = [{
			action	: 'add_new_element',
			id		: null,
			value	: target_section_tipo
		}]

	// rqo
		const rqo = {
			action	: 'save',
			source	: source,
			data	: data
		}

	// data_manager. create new record
		const api_response = await data_manager.request({
			body : rqo
		})
		if(SHOW_DEBUG===true) {
			console.log('add_new_element api_response:', api_response);
		}
		// add value to current data
		// (same envelope-v2 contract: a failure carries `error` and no payload;
		// response_data is the accessor for a SUCCESS payload, and the refresh
		// below feeds on it as a pre-fetched read answer)
		if (request_failed(api_response)) {
			console.error('Error on api_response on try to create new row:', api_response);
			// REFUSED creation: ONE toast, render kept — never silent (page.js
			// draws nothing for perm.* with page_scope:false). No wrapper, no
			// page_scope = render_scoped_panel's toast; a code already toasted by
			// the page listener is dropped by deduped_toast. Rationale in full:
			// component_portal add_new_element_locked.
			await handle_api_error(api_response.error, {wrapper: null})
			return false
		}
		if (response_data(api_response)) {

			// save return the datum of the component
			// to refresh the component, inject this api_response to use as "read" api_response
			// the build process will use it and does not re-call to API.
				await self.refresh({
					destroy				: false,
					build_autoload		: true,
					tmp_api_response	: api_response
				})

		}else{
			console.error('Error on api_response on try to create new row:', api_response);
			return false
		}


	return true
}//end add_new_element



/**
* BUILD_CHANGED_DATA_ITEM
* Parses the current value of a <select> element and constructs the
* changed_data_item descriptor used by the persistence layer.
*
* The select option values are JSON-stringified locators
* ({section_id, section_tipo}); the empty first option has value ''.
* When the empty option is selected, parsed_value is null and the action
* becomes 'remove', telling the server to delete the stored entry.
*
* The returned changed_data_item is frozen to prevent accidental mutation
* before it is handed off to set_changed_data / change_value.
*
* Exported so that render_search_component_select can call it directly
* (the search view builds the item inline rather than going through
* handle_select_change).
*
* @param {HTMLSelectElement} select - The <select> DOM element whose current
*   .value is a JSON-stringified locator or an empty string.
* @param {number|null} id - The entry id from data.entries[i].id, or null
*   when the component had no prior value. The id is injected into
*   parsed_value so the server can locate the existing database row.
* @returns {Object} An object with two keys:
*   - changed_data_item {Object} — frozen; safe to pass to save routines.
*   - parsed_value {Object|null} — the decoded locator, or null for empty.
*/
export const build_changed_data_item = function(select, id=null) {

	// parse select value from JSON string to object locator
	const parsed_value = (select.value.length > 0)
		? JSON.parse(select.value)
		: null

	// add id to parsed_value if available
	// (needed so the server can UPDATE the existing row rather than INSERT)
	if (parsed_value && id) {
		parsed_value.id = id
	}

	// build changed_data_item
	// action is 'remove' when the user picks the empty option (parsed_value === null)
	const changed_data_item = Object.freeze({
		action	: (parsed_value != null) ? 'update' : 'remove',
		id		: id,
		value	: parsed_value // object locator or null expected
	})

	return {
		changed_data_item	: changed_data_item,
		parsed_value		: parsed_value
	}
}//end build_changed_data_item



/**
* HANDLE_SELECT_CHANGE
* Shared change handler wired to the <select> element's 'change' event in
* all edit views (view_default_edit_select, view_line_edit_select, …).
*
* Flow:
*   1. Resolves the entry id from live instance data rather than a stale
*      closure, so re-selections after the first save carry the correct row id.
*   2. Delegates parsing and item construction to build_changed_data_item.
*   3. Registers the changed item on the instance via set_changed_data.
*   4. Immediately persists the change with change_value (refresh: false avoids
*      a full DOM rebuild on every keystroke; remove_dialog: false suppresses the
*      unsaved-changes prompt that would otherwise appear on navigation).
*   5. Returns parsed_value so callers can update derived UI (e.g. a linked
*      preview node) without re-parsing the select value a second time.
*
* @param {Object} self - The component_select instance.
* @param {HTMLSelectElement} select - The <select> DOM element that fired the
*   change event.
* @param {number|null} id - Entry id captured at render time; may be null when
*   the component had no prior value. The function re-reads the live id from
*   self.data.entries[0].id to handle the post-first-save case.
* @returns {Promise<Object|null>} The parsed locator object
*   ({section_id, section_tipo}), or null when the empty option was chosen.
*/
export const handle_select_change = async function(self, select, id=null) {

	// resolve id from current data if not provided
	// (when component was initially empty, the closure id is null,
	// but after first save the entry gets an id from the API)
	if (id === null) {
		id = self.data.entries?.[0]?.id ?? null
	}

	// build changed_data_item (parse + freeze)
	const {changed_data_item, parsed_value} = build_changed_data_item(select, id)

	// fix instance changed_data
	self.set_changed_data(changed_data_item)

	// force to save on every change
	await self.change_value({
		changed_data	: [changed_data_item],
		refresh			: false,
		remove_dialog	: false
	})

	return parsed_value
}//end handle_select_change



// @license-end
