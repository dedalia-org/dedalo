// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, Promise, SHOW_DEBUG, DEDALO_CORE_URL*/
/*eslint no-undef: "error"*/



// imports
	import {event_manager} from '../../common/js/event_manager.js'
	import {get_section_records} from '../../section/js/section.js'
	import {ui} from '../../common/js/ui.js'
	import {
		activate_autocomplete,
		render_column_component_info
	} from './render_edit_component_portal.js'



/**
* RENDER_SEARCH_COMPONENT_PORTAL
*
* Prototype mixin that provides the `search` render method for `component_portal`
* in search mode.  In search mode the portal lets users pick filter values from
* a linked section — it renders either an autocomplete trigger (when no value is
* selected yet) or the already-selected section records with a remove button.
*
* The constructor is a no-op stub; its prototype is mixed into `component_portal`
* via direct prototype assignment in component_portal.js:
*
*   component_portal.prototype.search = render_search_component_portal.prototype.search
*
* Exported symbols:
*   - `render_search_component_portal`  — prototype host (constructor is never called).
*   - `render_column_remove`            — standalone remove-button column renderer.
*                                         (!) Exported, but NOT imported anywhere else on
*                                         disk: the edit/list/mosaic views import the
*                                         SAME NAME from render_edit_component_portal.js
*                                         (the heavier, confirmation-modal variant).
*                                         Its only consumer is rebuild_columns_map below.
*
* Private helpers (module-scoped, not exported):
*   - `render_content_data`   — assembles the inner content_data element.
*   - `rebuild_columns_map`   — extends the base columns_map with control columns.
*
* Key data shapes consumed from the component instance (`self`):
*   - `self.data.q_operator` {string|null}   — persisted boolean operator ('AND'/'OR'); written
*                                              by the q_operator input on change.
*   - `self.q_operator`      {string|null}   — legacy fallback slot for the operator value
*                                              (set by some sibling components; read-only here).
*   - `self.data.entries`    {Array}          — locator array for already-selected records.
*   - `self.context.children_view` {string}  — view name forwarded to child section records;
*                                              falls back to `self.context.view`.
*   - `self.show_interface.show_autocomplete` {boolean} — when true and no records are selected,
*                                              shows the fake-input autocomplete trigger.
*   - `self.columns_map`     {Array}          — base column descriptors resolved by `get_columns_map`.
*   - `self.add_component_info` {boolean}     — when true, appends the optional 'ddinfo' info column.
*   - `self.fixed_columns_map`  {boolean}     — guards against `rebuild_columns_map` running twice.
*   - `self.ar_instances`    {Array}          — accumulator for child section-record instances
*                                              (used for cleanup during destroy).
*   - `self.events_tokens`   {Array}          — accumulator for event subscription tokens
*                                              (used for cleanup during destroy).
*   - `self.request_config_object` {Object}   — request-config (search/show branches) used to
*                                              propagate `fixed_mode` to child ddo_map items.
*   - `self.node`            {HTMLElement}    — root DOM node of the component (set by render()).
*
* Event bus interactions:
*   - Publishes `change_search_element` with `self` whenever the q_operator or the
*     remove button changes the search state.  The search bar header reacts to this
*     event to reflect the updated operator label and value count.
*   - Subscribes to `deactivate_component` to reset the fake-input visibility when the
*     autocomplete panel closes (token stored in `self.events_tokens`).
*
* @module render_search_component_portal
* @see component_portal.js            for the constructor and prototype wiring.
* @see render_edit_component_portal.js for `activate_autocomplete` and
*                                      `render_column_component_info` (imported here).
* @see docs/core/components/component_portal.md for the full specification.
*/
export const render_search_component_portal = function() {

	return true
}//end render_search_component_portal



/**
* SEARCH
* Entry point for search-mode rendering of a `component_portal` instance.
*
* Orchestrates the full search render pipeline:
*   1. Ensures the columns_map is complete (adds control columns via `rebuild_columns_map`).
*   2. Determines the `children_view` used when rendering the linked section records.
*   3. Fetches and renders child section-record instances via `get_section_records`.
*   4. Builds the inner `content_data` element via `render_content_data`.
*   5. Wraps content in a standard search wrapper via `ui.component.build_wrapper_search`
*      and adds the 'portal' and 'view_line' CSS classes for layout.
*
* When `options.render_level === 'content'`, only the `content_data` element is returned
* (bypassing wrapper creation) — used during partial refreshes that update only the
* inner region without rebuilding the outer wrapper.
*
* Child section-record instances are appended to `self.ar_instances` so that they can be
* destroyed as part of the standard component lifecycle (`common.destroy`).
*
* @param {Object} options                        - Render options.
* @param {string} [options.render_level='full']  - 'full' builds the complete wrapper element;
*                                                   'content' rebuilds only the inner content area.
* @returns {Promise<HTMLElement>} Resolves to the wrapper (render_level 'full') or the
*                                  content_data element (render_level 'content').
*/
render_search_component_portal.prototype.search = async function(options) {

	const self = this

	// options
		const render_level = options.render_level || 'full'

	// columns_map
		const columns_map	= await rebuild_columns_map(self)
		self.columns_map	= columns_map

	// view
		const children_view	= self.context.children_view || self.context.view || 'default'

	// ar_section_record
		const ar_section_record = await get_section_records({
			caller	: self,
			mode	: self.mode, // 'search',
			view	: children_view
		})
		// store to allow destroy later
		self.ar_instances.push(...ar_section_record)

	// content_data
		const content_data = await render_content_data(self, ar_section_record)
		if (render_level==='content') {
			return content_data
		}

	// wrapper. ui build_edit returns component wrapper
		const wrapper = ui.component.build_wrapper_search(self, {
			content_data : content_data
		})
		wrapper.classList.add('portal','view_line')
		// set pointers
		wrapper.content_data = content_data


	return wrapper
}//end search



/**
* RENDER_CONTENT_DATA
* Builds the inner content_data HTMLElement for search-mode rendering.
*
* The element contains up to three kinds of children, appended in order:
*
* 1. **q_operator input** (most models) — a small text input holding the boolean
*    query operator (e.g. 'AND'/'OR').  Skipped for models in `non_q_operator_models`
*    (currently only 'component_relation_children', which always implies a single
*    record match).  Initial value comes from `self.data.q_operator` (persisted in
*    search state) or `self.q_operator` (legacy fallback written by some sibling
*    components).  On `change` the new value is written to `self.data.q_operator`
*    and `change_search_element` is published so the search bar header can react.
*    A click stopPropagation prevents the wrapper activation logic from firing.
*
* 2. **Fake-input autocomplete trigger** — rendered only when no section records have
*    been selected yet (`ar_section_record_length === 0`) AND
*    `self.show_interface.show_autocomplete === true`.  On click:
*      a. The fake input is hidden (CSS class 'input_disable').
*      b. A skeleton autocomplete wrapper is inserted immediately in the same DOM
*         position to occupy space and prevent layout shift while the real service loads.
*      c. `activate_autocomplete(self, self.node)` is awaited — this lazily constructs
*         the `service_autocomplete` instance and mounts it onto `self.node`.
*      d. The skeleton is removed once the real autocomplete is in the DOM.
*    A `deactivate_component` subscription re-shows the fake input if the user closes
*    the autocomplete without selecting a value (token stored in `self.events_tokens`).
*    Models in `non_q_operator_models` receive the extra CSS class 'no_operator' on the
*    fake input because the q_operator field is absent and the layout must compensate.
*
* 3. **Section record nodes** — each resolved `ar_section_record` instance has its
*    `render()` method called and the resulting node appended.  These show the already-
*    selected values including child-component columns and the remove button.
*
* @param {Object} self               - The `component_portal` instance.
* @param {Array}  ar_section_record  - Array of section_record instances already fetched
*                                      by `get_section_records`; may be empty.
* @returns {Promise<HTMLElement>} Populated content_data div element.
*/
const render_content_data = async function(self, ar_section_record) {

	const ar_section_record_length = ar_section_record.length

	// DocumentFragment
		const fragment = new DocumentFragment()

	// q operator (search only)
		const non_q_operator_models = [
			'component_relation_children'
		]
		if (!non_q_operator_models.includes(self.model)) {
			const q_operator = self.data.q_operator || self.q_operator
			const input_q_operator = ui.create_dom_element({
				element_type	: 'input',
				type			: 'text',
				value			: q_operator,
				class_name		: 'q_operator',
				title			: get_label.operator || 'Operator',
				parent			: fragment
			})
			input_q_operator.addEventListener('click', function(e){
				e.stopPropagation()
			})
			input_q_operator.addEventListener('change', function(){
				// value
					const value = (input_q_operator.value.length>0) ? input_q_operator.value : null
				// q_operator. Fix the data in the instance previous to save
					self.data.q_operator = value
				// publish search. Event to update the DOM elements of the instance
					event_manager.publish('change_search_element', self)
			})
		}

	// Input value fake
	// show a field with magnify glass to be used to indicate where click
	// users will click in it in the middle of the component
	// to activate the autocomplete service
		if (ar_section_record_length===0 && self.show_interface.show_autocomplete===true ) {

			const fake_input_value = ui.create_dom_element({
				element_type	: 'input',
				type			: 'text',
				class_name		: 'input_value',
				parent			: fragment
			})
			fake_input_value.setAttribute('readonly', true);
			if (non_q_operator_models.includes(self.model)) {
				fake_input_value.classList.add('no_operator')
			}
			// click event
			const click_handler = async (e) => {
				e.stopPropagation()
				e.preventDefault()

				// Hide immediately so the autocomplete appears in place without a gap
				fake_input_value.classList.add('input_disable')

				// Show skeleton input instantly while the real service loads.
				// Uses the same CSS classes as the real autocomplete wrapper/input
				// so it occupies the exact same position with no visual gap.
				const skeleton_wrapper = ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'wrapper_service_autocomplete search active',
					parent			: self.node
				})
				const skeleton_input = ui.create_dom_element({
					element_type	: 'input',
					type			: 'text',
					class_name		: 'autocomplete_input',
					parent			: skeleton_wrapper
				})
				skeleton_input.setAttribute('placeholder', (get_label.find || 'Find') + '...')
				skeleton_input.setAttribute('readonly', true)

				// Fire service autocomplete load and activation
				await activate_autocomplete(self, self.node)

				// Remove skeleton once real autocomplete is in the DOM
				skeleton_wrapper.remove()
			}
			fake_input_value.addEventListener('click', click_handler)
			// deactivate_component event
			const deactivate_component_handler = (component) => {
				// Ignore others components deactivation events
				if(component.id !== self.id){
					return
				}
				// Display again the fake input
				fake_input_value.classList.remove('input_disable')
			}
			self.events_tokens.push(
				event_manager.subscribe('deactivate_component', deactivate_component_handler)
			);
		}

	// ar_section_record
		for (let i = 0; i < ar_section_record_length; i++) {
			// section_record
			const section_record_node = await ar_section_record[i].render()
			// snake_case values (ontology model names) get a break opportunity
			// after each '_': a narrow search card wraps them at a word joint,
			// never mid-word. Plain-text values only; textContent is unchanged
			const value_node = section_record_node.querySelector(':scope > .wrapper_component')
			if (value_node && value_node.childNodes.length===1 && value_node.firstChild.nodeType===Node.TEXT_NODE && value_node.textContent.includes('_')) {
				const parts = value_node.textContent.split('_')
				value_node.replaceChildren(...parts.flatMap((part, j) => j===0 ? [part] : ['_', document.createElement('wbr'), part]))
			}
			// console.log('>> section_record TO RENDER:', ar_section_record[i]);
			fragment.appendChild(section_record_node)
		}

	// content_data
		const content_data = ui.component.build_content_data(self)
			  content_data.appendChild(fragment)


	return content_data
}//end render_content_data



/**
* REBUILD_COLUMNS_MAP
* Extends the portal's base columns_map with search-specific control columns.
*
* Runs once per component lifecycle: after the first run `self.fixed_columns_map`
* is set to `true` so subsequent calls return the already-built map immediately,
* preventing duplicate control columns from being appended on re-renders.
*
* Side effects (only on the first run):
*   1. **fixed_mode propagation** — iterates the ddo_map of whichever
*      request_config branch contains a ddo_map (preferring the 'search' branch,
*      falling back to 'show') and stamps `fixed_mode = true` on every item.
*      This forces child `section_record` instances to preserve the search
*      component mode rather than switching to their default mode.
*   2. **ddinfo column** — if `self.add_component_info === true` (set during
*      `build()` when any ddo_map item includes `value_with_parents`) a column
*      descriptor for the 'ddinfo' overlay is pushed.  The `callback` is
*      `render_column_component_info` from render_edit_component_portal.
*   3. **remove column** — always appended last; a remove-button column using
*      `render_column_remove` (defined in this module and exported).
*
* @param {Object} self - The `component_portal` instance.
* @returns {Promise<Array>} Resolves to the complete columns_map array, including
*                            any control columns appended by this function.
*/
const rebuild_columns_map = async function(self) {

	// columns_map already rebuilt case
		if (self.fixed_columns_map===true) {
			return self.columns_map
		}

	// fixed_mode. To force section_record to preserve the search ddo_map items mode,
	// add 'fixed_mode' to all if they don't already have it
		const search_config = self.request_config_object?.search
		const show_config	= self.request_config_object?.show
		const ddo_map_path	= search_config && search_config.ddo_map
			? 'search'
			: 'show'

		const config_to_process = self.request_config_object ? self.request_config_object[ddo_map_path] : null
		if (config_to_process && config_to_process.ddo_map) {
			config_to_process.ddo_map.map(el => {
				el.fixed_mode = true
			})
		}

	const columns_map = []

	// base_columns_map
		const base_columns_map = await self.columns_map
		columns_map.push(...base_columns_map)

	// column component_info check
		if (self.add_component_info===true) {
			columns_map.push({
				id			: 'ddinfo',
				label		: 'Info',
				callback	: render_column_component_info
			})
		}

	// button_remove
		columns_map.push({
			id			: 'remove',
			label		: get_label.delete || 'Delete',
			width		: 'auto',
			callback	: render_column_remove
		})

	// fixed as calculated
		self.fixed_columns_map = true


	return columns_map
}//end rebuild_columns_map



/**
* RENDER_COLUMN_REMOVE
* Renders the remove-button column cell for a selected portal record in search mode.
*
* Unlike the heavier `render_column_remove` in render_edit_component_portal.js, this
* search-mode variant performs an immediate, silent clear without a confirmation modal.
* Clicking the button:
*   1. Builds a frozen `changed_data_item` with `action: 'clear'` — the deliberate,
*      explicit wipe of `self.data.entries`.
*   2. Calls `self.update_data_value(changed_data_item)` to update the component's
*      in-memory SEARCH model. This is LOCAL ONLY: no change_value(), no save(),
*      nothing reaches the wire. The selected locators are search FILTER values,
*      not stored record data — they leave this instance later, as part of the SQO
*      the search bar builds.
*   3. Publishes `change_search_element` so the surrounding search bar header rerenders.
*   4. Calls `self.refresh({ build_autoload: true })` to rebuild the component's DOM
*      with the updated (now empty) state, restoring the fake-input trigger.
*
* The click handler calls `e.stopPropagation()` to prevent the component activation
* logic from firing alongside the removal.
*
* (!) SCOPE, stated as it is (DATA-06, 2026-08-30): this button empties the WHOLE
* selection, not just its own row — the pre-2026-08-30 spelling (`action:'remove'`
* with a null id) hit update_data_value's wildcard branch, which set
* `entries = []`. The port to `clear` preserves that behaviour EXACTLY and makes
* it legible; narrowing it to the clicked row is a separate, deliberate UX change
* (the row is addressable by `options.section_id` / `options.section_tipo`, not by
* an entry `id`, so it needs its own mechanism and its own review).
*
* Do NOT re-spell this as a `remove` with a null id. On the WIRE that is refused
* since DATA-06 — by `save()` and by the server (`record.remove_without_id`) —
* and `clear` is the spelling that says what this gesture means. In SEARCH mode
* `update_data_value` would in fact accept it (a search instance is a transient
* filter with no save path, and the model door carves that case out by
* `self.mode`), so the objection here is not that it would fail: it is that a
* wildcard spelling in a file that also renders EDIT columns is one copy-paste
* away from the shape that destroyed records.
*
* @param {Object} options        - Column renderer options (standard columns_map callback contract).
* @param {Object} options.caller - The `component_portal` instance (`self`).
* @returns {DocumentFragment} Fragment containing the remove button with its icon span.
*/
export const render_column_remove = function(options) {

	// options
		const self = options.caller

	// DocumentFragment
		const fragment = new DocumentFragment()

	// button_remove
		const button_remove = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'button_remove',
			parent			: fragment
		})
		button_remove.addEventListener('click', function(e){
			e.stopPropagation()

			const unlink_record = function() {
				// changed_data
				// 'clear' — THE EXPLICIT WIPE (DATA-06). Local to this instance's
				// search model. `clear` is explicit; see the docblock for why the
				// id-less 'remove' spelling is avoided here even though search mode
				// would accept it.
				const changed_data_item = Object.freeze({
					action	: 'clear',
					value	: null
				})
				// update the instance data (previous to save)
					self.update_data_value(changed_data_item)
				// set data.changed_data. The change_data to the instance
					// self.data.changed_data = changed_data
				// publish search. Event to update the DOM elements of the instance
					event_manager.publish('change_search_element', self)

					self.refresh({
						build_autoload : true
					})
			}

			unlink_record()
		})

	// remove_icon
		ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'button delete_light icon',
			parent			: button_remove
		})


	return fragment
}//end render_column_remove



// @license-end
