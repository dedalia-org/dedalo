// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label*/
/*eslint no-undef: "error"*/



/**
 * RENDER_SEARCH
 *
 * Rendering layer for the Dédalo search interface. This module provides all
 * DOM-construction functions consumed by `search` (core/search/js/search.js),
 * which mixes them onto its prototype. The module itself exports the constructor
 * stub `render_search`, plus the standalone helpers `render_filter`,
 * `toggle_search_panel`, `toggle_fields`, `toggle_presets`, and `toggle_type`.
 *
 * Architecture overview
 * ---------------------
 * The search interface is split into three visual panels:
 *
 *  Left panel  — "Fields" (.search_container_selector)
 *    A flat list of every component the user can drag into a filter group.
 *    For thesaurus/ontology callers the list changes when the user picks
 *    a typology or a subset of sections from the section-selector overlay.
 *
 *  Centre panel — "Filter canvas" (.search_container_selection)
 *    Zero or more nested `$and`/`$or` groups, each containing zero or more
 *    `search_component` rows. This is the editable query being built. The
 *    structure is kept authoritative in the in-memory model (`self.filter_model`)
 *    maintained by `search.js`; the DOM is a rendering of that model.
 *
 *  Right panel — "Presets" (.search_container_selection_presets)
 *    A lazily-loaded list of saved user-search-presets stored as Dédalo
 *    section records (section_tipo dd623). Presets can be loaded, edited,
 *    saved, and deleted.
 *
 * Panel open/close state is persisted in the local IndexedDB via
 * `data_manager.set_local_db_data` / `delete_local_db_data`, so that the
 * last-used layout survives a page reload.
 *
 * Model ↔ DOM contract
 * --------------------
 * Every `.search_group` DOM node carries a `.__node` reference to its
 * canonical group node ({node_type:'group', operator, children, …}). Every
 * `.search_component` DOM node carries a `.__node` reference to its canonical
 * component node ({node_type:'component', path, section_id, instance, …}).
 * Mutations (add/remove/reorder) must be applied to the model via the helpers
 * defined in search.js (`create_group_model_node`, `remove_model_node`,
 * `move_model_node`) AND reflected in the DOM, never in the DOM alone.
 * Serialisation (`serialize_filter_model`) reads the model tree exclusively.
 *
 * Caller context
 * --------------
 * `self` throughout this module is a `search` instance (see search.js).
 * `self.caller` is the section or area instance that owns this search widget.
 * `self.caller.model` discriminates between regular sections (`'section'`),
 * `'area_thesaurus'`, and `'area_ontology'`, which affects which panels and
 * options are displayed.
 *
 * @module render_search
 */


// imports
	import {render_components_list} from '../../common/js/render_common.js'
	import {event_manager} from '../../common/js/event_manager.js'
	import {data_manager} from '../../common/js/data_manager.js'
	import {ui} from '../../common/js/ui.js'
	import {when_in_viewport, dd_request_idle_callback} from '../../common/js/events.js'
	import {render_preset_modal, select_preset} from '../../section/js/view_search_user_presets.js'
	import {
		create_new_search_preset,
		edit_user_search_preset,
		save_preset,
		load_user_search_presets,
		delete_user_search_preset,
		load_search_preset,
		presets_section_tipo
	} from './search_user_presets.js'
	import {get_scope} from '../../common/js/section_map.js'
	import {same_section_id} from '../../common/js/utils/index.js'
	import {response_data} from '../../common/js/api_error.js'
	import {
		apply_semantic_from_preset
	} from './render_semantic.js'



/**
* RENDER_SEARCH
* Constructor stub for the render layer. All public methods are assigned to
* `render_search.prototype` and then mixed onto `search.prototype` in search.js.
* The constructor itself performs no work; it exists solely as the namespace
* carrier for prototype-based method organisation.
* @constructor
* @returns {boolean} Always true (Dédalo constructor convention)
*/
export const render_search = function() {

	return true
}//end render_section



/**
* LIST
* Entry-point render method for the search interface — wired as both
* `search.prototype.list` and `search.prototype.edit` from search.js.
*
* Build order (all three blocks run concurrently where possible):
*  1. `render_base()` — builds the empty DOM skeleton and stores node
*     pointers on `self`.
*  2. `get_section_elements()` → `render_components_list()` — populates the
*     left "Fields" panel with the draggable component list.
*  3. `render_filter()` — populates the centre canvas with the groups and
*     components from the current `self.json_filter` preset (loaded during
*     `search.build()`).
*  4. `render_search_buttons()` — appends max/reset/apply controls.
*  5. `get_panels_status()` — reads the persisted open/close state for each
*     panel and fires the appropriate toggle helpers so the UI reflects the
*     last-used layout.
*
* `use_real_sections` controls whether the fields panel shows generic model
* sections (false, for regular sections like 'es1') or the actual loaded
* thesaurus/ontology sections (true, for `area_thesaurus`/`area_ontology`
* callers that expose `get_sections_selector_data`).
*
* @returns {Promise<HTMLElement>} The wrapper div inserted into the page
*/
render_search.prototype.list = async function() {

	const self = this

	// wrapper base html bounds
		const wrapper = self.render_base()

	// components_list. render section component list [left]
		const use_real_sections = self.caller.model==='section'
			? false // searching from regular section like 'es1'
			: true // searching from 'area_thesaurus' or 'area_ontology'
		const section_elements = await self.get_section_elements({
			use_real_sections : use_real_sections
		})
		render_components_list({
			self				: self,
			section_tipo		: self.target_section_tipo,
			target_div			: self.search_container_selector,
			path				: [],
			section_elements	: section_elements
		})

	// filter. render components from temp preset [center]
		render_filter({
			self				: self,
			editing_preset		: self.json_filter,
			allow_duplicates	: true
		})

	// render buttons
		self.render_search_buttons()

	// panels status (close/open)
		self.get_panels_status()
		.then(function(ui_status){
			if (ui_status) {
				// search_panel cookie state track
				// if(self.cookie_track("search_panel")===true) {
					if(ui_status.value.search_panel && ui_status.value.search_panel.is_open) {
						// Open search panel
						toggle_search_panel(self) // toggle to open from default state close
					}
				// fields_panel cookie state track
					// if(self.cookie_track("fields_panel")===true) {
					if(ui_status.value.fields_panel && ui_status.value.fields_panel.is_open) {
						// Open search panel
						toggle_fields(self) // toggle to open from default state close
					}
				// presets_panel cookie state track
					// if(self.cookie_track("presets_panel")===true) {
					if(ui_status.value.presets_panel && ui_status.value.presets_panel.is_open) {
						// Open search panel
						toggle_presets(self) // toggle to open from default state close
					}
				// type_panel cookie state track
					// if(self.cookie_track("type_panel")===true) {
					if(ui_status.value.type_panel && ui_status.value.type_panel.is_open) {
						// Open search panel
						toggle_type(self) // toggle to open from default state close
					}
			}//end if (ui_status)
		})


	return wrapper
}//end list



/**
* RENDER_BASE
* Constructs the complete DOM skeleton for the search interface and stores
* node pointers on `self`. Returns a single top-level `wrapper` div that the
* caller inserts into the page.
*
* DOM structure produced (class names shown):
*
*   .wrapper_search.full_width.<mode>
*     [thesaurus_options_node]            — only for area_thesaurus / area_ontology
*     .toggle_container_selector          — "Fields" accordion button
*     .search_container_selector          — left fields list (initially hidden)
*     .search_container_selection         — centre filter canvas (sticky)
*       .search_group_container           — root of all $and/$or groups
*     .search_container_selection_presets — right presets panel (initially hidden)
*       .component_presets_label
*         #button_new_preset              — "+" add preset button
*       .button_save_preset               — "Save changes" (hidden until a preset is loaded)
*     .toggle_container_selection_presets — "Preset" accordion button
*
* Notable side effects:
* - `self.search_global_container`, `.search_container_selector`,
*   `.search_group_container`, `.search_container_selection_presets`,
*   `.wrapper_sections_selector` (thesaurus only), `.button_save_preset`,
*   and `.wrapper` are all set here for use by later render methods.
* - The sticky `top` of `.search_container_selection` is computed once the
*   node enters the viewport, dynamically reading the menu bar height.
*
* @returns {HTMLElement} The outer `.wrapper_search` div
*/
render_search.prototype.render_base = function() {

	const self = this

	const section_tipo = self.section_tipo

	const fragment = new DocumentFragment()

	// search_global_container . Main search div
		const search_global_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'search_global_container hide', // initial hide
			parent			: fragment
		})
		// set
		self.search_global_container = search_global_container

	// thesaurus add on
		if (self.caller.model==='area_thesaurus' || self.caller.model==='area_ontology') {
			const thesaurus_options_node = render_sections_selector(self)
			search_global_container.appendChild(thesaurus_options_node)
		}

	// toggle_container_selector (Show/hide where section fields list are loaded)
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'toggle_container_selector',
			inner_html		: get_label.fields || 'Fields',
			parent			: search_global_container
		})
		.addEventListener('click',function(e){
			e.stopPropagation()
			toggle_fields(self)
		})

	// fields list . List of section fields usable in search
		const search_container_selector = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'components_list_container search_container_selector display_none',
			parent			: search_global_container
		})
		// set
		self.search_container_selector = search_container_selector

	// search_container_selection canvas. Where fields are dragged and stored
		const search_container_selection = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'search_container_selection',
			parent			: search_global_container
		})

		// fix top based on menu(sticky)
		when_in_viewport(
			search_container_selection,
			() => {
				// get menu height to optimize sticky position top
				const menu_wrapper = document.querySelector('.menu_wrapper')
				if (menu_wrapper) {
					const menu_height = menu_wrapper.offsetHeight
					search_container_selection.style.top = (menu_height + 1) + 'px'
				}
			}
		)
		// semantic (RAG): the ONE semantic input is the quick input in the list
		// toolbar (render_semantic.js build_semantic_quick_input) — the panel
		// deliberately mounts no duplicate block; the shared instance state
		// (self.semantic) still composes with the structured filter on submit.

		const search_group_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'search_group_container',
			parent			: search_container_selection
		})
		// Set
		self.search_group_container = search_group_container

	// user presets. List of stored selection presets
		const search_container_selection_presets = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'search_container_selection_presets display_none',
			dataset			: {'section_tipo':section_tipo},
			parent			: search_global_container
		})
		// set
		self.search_container_selection_presets = search_container_selection_presets
		// component_presets_label
		const component_presets_label = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'component_presets_label',
			inner_html		: get_label.search_presets || 'User search preset',
			parent			: self.search_container_selection_presets
		})
		// button_new_preset
			const button_add_preset = ui.create_dom_element({
				id 				: 'button_new_preset',
				element_type	: 'span',
				class_name		: 'button add',
				parent			: component_presets_label
			})
			// click event
			const add_click_handler = async (e) => {
				e.stopPropagation()

				// create_new_search_preset
				const section_id = await create_new_search_preset({
					self			: self,
					section_tipo	: presets_section_tipo
				})

				// launch the editor
				const section = await edit_user_search_preset(self, section_id)

				// open modal to edit the new preset
				render_preset_modal({
					caller		: section,
					section_id	: section_id,
					on_close	: async () => {

						// force to recalculate total records
						self.user_presets_section.total = null
						// force refresh the section
						await self.user_presets_section.refresh()

						// activate created preset
						dd_request_idle_callback(
							() => {
								const button_apply = document.getElementById('apply_preset_' + section_id)
								if (button_apply) {
									// button_apply.click()
									select_preset({
										self			: self,
										section_id		: section_id,
										button_apply	: button_apply,
										load_preset		: false
									})
								}
							}
						)
					}
				})
			}
			button_add_preset.addEventListener('click', add_click_handler)

		// button save preset
			const button_save_preset = ui.create_dom_element({
				element_type	: 'button',
				class_name		: 'button_save_preset hide',
				inner_html		: get_label.save +' '+ get_label.changes,
				parent			: search_container_selection_presets
			})
			// click event
			const save_click_handler = (e) => {
				e.stopPropagation()

				// check user_preset_section_id is already set
					if (!self.user_preset_section_id) {
						console.log('Unable to save non defined section_id preset:', self.user_preset_section_id);
						return
					}

				const section_id = self.user_preset_section_id

				// save_preset
					save_preset({
						self			: self,
						section_id		: section_id,
						section_tipo	: 'dd623' // Search presets
					})
					.then(function(response){
						console.log('Preset saved!', response);
						if (response_data(response)) {
							button_save_preset.classList.add('hide')
						}
					})
			}
			button_save_preset.addEventListener('click', save_click_handler)
			// fix
			self.button_save_preset = button_save_preset

	// toggle_container_selection_presets. button toggle user presets
		const toggle_container_selection_presets = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'toggle_container_selection_presets',
			inner_html		: get_label.preset || 'Preset',
			parent			: search_global_container
		})
		toggle_container_selection_presets.addEventListener('click',function(){
			toggle_presets(self)
		})


	// wrapper . Top div where elements are placed
		const wrapper = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'wrapper_search full_width ' + self.caller.mode
		})
		wrapper.appendChild(fragment)
		// fix wrapper
		self.wrapper = wrapper


	return wrapper
}//end render_base



/**
* RENDER_FILTER
* Reconstructs the entire filter canvas (`.search_group_container`) from a
* JSON filter preset, replacing whatever was there before.
*
* Steps performed:
*  1. Clears all children of `self.search_group_container`.
*  2. Resets `self.ar_resolved_elements` (tracks which section_ids have already
*     been rendered to avoid duplicate component loading).
*  3. Resets `self.filter_model` to null — it will be rebuilt as a side effect
*     of `build_dom_group` → `render_search_group` → `create_group_model_node`
*     walking the preset structure.
*  4. Calls `self.build_dom_group()` (search.js) which recursively creates
*     `$and`/`$or` group nodes and loads each field component asynchronously.
*
* `editing_preset` must be the full preset object (with a `.value` property
* holding `{"$and": [...]}` or similar). The plain `{"$and": []}` sentinel used
* as the default in `search.init()` is safe to pass here.
*
* This function is exported because external callers (e.g. the `toggle_presets`
* preset load and `select_preset`) need to re-render the filter canvas after
* loading a new preset without going through `list()` again.
*
* @param {Object} options
* @param {Object} options.self - The search instance
* @param {Object} options.editing_preset - Preset object; `.value` is the actual filter JSON
* @param {boolean} [options.clean_q=false] - If true, component input values are cleared after render
* @param {boolean} [options.allow_duplicates=false] - If true, the same field can appear more than once
* @returns {HTMLElement} The `.search_group_container` node (now repopulated)
*/
export const render_filter = function(options) {

	// options
		const self				= options.self
		const editing_preset	= options.editing_preset.value || {"$and": []}
		const clean_q			= options.clean_q || false
		const allow_duplicates	= options.allow_duplicates || false

	// search_group_container
		const search_group_container = self.search_group_container
		// Clean target_div
		while (search_group_container.hasChildNodes()) {
			search_group_container.removeChild(search_group_container.lastChild);
		}

	// Reset resolved
		self.ar_resolved_elements = []

	// Reset canonical model. Rebuilt as a side effect of render_search_group /
	// build_search_component while build_dom_group walks the preset.
		self.filter_model = null

	// Build global_group
		self.build_dom_group(editing_preset, search_group_container, {
			is_root				: true,
			clean_q				: clean_q,
			allow_duplicates	: allow_duplicates
		})


	return search_group_container
}//end render_filter



/**
* RENDER_SEARCH_BUTTONS
* Builds and appends the action-button row at the bottom of the filter canvas
* (`.search_group_container`). This row contains:
*
*  - Max input (.max_input): numeric field controlling `self.limit` (row count
*    returned by search). On 'input' it updates `self.limit` and calls
*    `update_local_db_pagination()`; on 'change' it triggers `exec_search()`.
*
*  - Recursive-children checkbox (.children_recursive): only created when the
*    section has a `component_relation_children` and the section_map declares
*    a 'thesaurus' scope. Stored as `self.search_children_recursive_node`.
*
*  - Reset button (.button.reset_search, labelled): calls `self.reset()` on mousedown, which
*    clears the current filter and re-renders.
*
*  - Submit button (#button_submit): on mousedown it blurs the active element
*    (to flush in-progress value edits), then schedules `exec_search()` via
*    `dd_request_idle_callback` so the browser can update the UI first. After
*    search completes, if the caller has results the filter panel is toggled
*    closed so the results are visible.
*
* (!) `mousedown` rather than `click` is used for submit and reset to avoid
* losing focus events that set component dato before the search fires.
*
* @returns {HTMLElement} The `.search_buttons_container` div
*/
render_search.prototype.render_search_buttons = function(){

	const self = this

	const search_buttons_container = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'search_buttons_container',
		parent			: self.search_group_container
	})

	// max group
		const max_group = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'max_group',
			parent			: search_buttons_container
		})
	// max_input_label
		ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'max_input_label unselectable',
			inner_html		: get_label.max || 'max',
			parent			: max_group
		})
	// max input
		const max_input = ui.create_dom_element({
			element_type	: 'input',
			class_name		: 'max_input', // btn css_max_rows
			value			: self.limit, // default 10
			parent			: max_group
		})
		// input event
		const max_input_input_handler = (e) => {
			self.limit = parseInt(max_input.value)
			if(self.limit<1) self.limit = 1
			// update local DB pagination
			self.update_local_db_pagination()
		}
		max_input.addEventListener('input', max_input_input_handler)
		// change event
		const change_handler = (e) => {
			e.preventDefault()
			// Update list
			self.exec_search()
		}
		max_input.addEventListener('change', change_handler)
		// focus event
		const focus_handler = (e) => {
		   max_input.select();
		}
		max_input.addEventListener('focus', focus_handler)
		// set node pointer
		self.max_input = max_input

	// recursive children. Appended to the column AFTER Apply (see below): an
	// option of the search, not part of the Max field.
		let recursive_label = null
		if (get_scope(self.caller.context?.section_map, 'thesaurus', true)) {
			// re-check if this section have really a component_relation_children before create the option
			const section_components_list		= self.components_list[self.section_tipo]
			const component_relation_children	= section_components_list.find(el => el.model==='component_relation_children')
			if (component_relation_children) {
				recursive_label = ui.create_dom_element({
					element_type	: 'label',
					text_content	: get_label['children_recursive'] || 'Children',
					class_name		: 'children_recursive_label'
				})
				const search_children_recursive_node = ui.create_dom_element({
					element_type	: 'input',
					type			: 'checkbox',
					value			: '',
					class_name		: 'children_recursive'
				})
				recursive_label.prepend(search_children_recursive_node)
				// set node pointer
				self.search_children_recursive_node	= search_children_recursive_node
			}
		}

	// reset group
		const reset_group = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'reset_group',
			parent			: search_buttons_container
		})

	// Reset button: a labelled button (icon + "Reset"), paired with Show all
		const reset_button = ui.create_dom_element({
			element_type	: 'button',
			type			: 'button',
			class_name		: 'button reset_search',
			inner_html		: get_label.reset || 'Reset',
			title			: get_label.reload || 'Reload',
			parent			: reset_group
		})
		const reset_mousedown_handler = (e) => {
			e.stopPropagation()
			self.reset()
		}
		reset_button.addEventListener('mousedown', reset_mousedown_handler)

	// Show all
		const show_all_fn = (e) => {
			e.stopPropagation()
			self.show_all(show_all_button)
			// Close search div
			toggle_search_panel(self) // toggle to open from default state close
		}
		// Labelled button with the list glyph, matching the reset_search icon
		// beside it and the section list-mode show_all button.
		const show_all_button = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'button show_all',
			inner_html		: get_label.show_all || 'Show all',
			parent			: reset_group
		})
		show_all_button.addEventListener('mousedown', show_all_fn)

	// tooltips
	ui.activate_tooltips(reset_group, '.button')

	// Submit button
		const submit_fn = (e) => {
			e.stopPropagation()
			// always blur active component to force set dato (!)
			document.activeElement.blur()
			// exec decoupled to allow UI to update before search starts
			dd_request_idle_callback(async ()=>{
				// exec search command (return promise resolved as bool)
				await self.exec_search()
				// toggle filter container if there are results
				const caller = self.caller
				if (!caller) return
				const entries = caller.data?.entries || []
				if(entries.length > 0) {
					toggle_search_panel(self) // toggle to open from default state close
				}
			})
		}
		const submit_button = ui.create_dom_element({
			element_type	: 'button',
			id				: 'button_submit',
			class_name		: 'button submit',
			inner_html		: get_label.apply || 'Apply',
			parent			: search_buttons_container
		})
		submit_button.addEventListener('mousedown', submit_fn)

	// recursive children option, under Apply
		if (recursive_label) {
			search_buttons_container.appendChild(recursive_label)
		}


	return search_buttons_container
}//end render_search_buttons



/**
* RENDER_SEARCH_GROUP
* Creates a single `$and`/`$or` group container div (.search_group) and
* appends it to `parent_div`. This is called recursively by `build_dom_group`
* (search.js) when the preset contains nested groups.
*
* What this function builds inside the group:
*  - A canonical group model node (`create_group_model_node`) linked to
*    `parent_div.__node` (the parent group's model node). The root group sets
*    `self.filter_model`; sub-groups are attached to their parent's children.
*    The DOM node gets `.__node` set so close/operator-click handlers can
*    reach the model directly without re-traversing the tree.
*  - All drag-and-drop events (delegated to search_drag.js handlers).
*  - An operator toggle element showing "AND [n]" / "OR [n]". Clicking it
*    calls `toggle_operator_value()` to flip the display and also writes the
*    new operator back to `search_group.__node.operator`.
*  - A close button (non-root groups only) that calls `remove_model_node` then
*    removes the DOM node.
*  - A dashed "Drag a field here" slot (.add_field) marking the drop target;
*    a click opens the FIELDS panel when it is closed.
*  - An "Add group" button (.add_group) that adds a nested sub-group by
*    recursively calling this method.
*
* (!) The `data_set.id` counter value is derived from the total number of
* `.search_group` elements already in `self.search_group_container` at the
* time this function runs. It is display-only and is NOT stable across
* re-renders — do not use it as a persistent identifier.
*
* @param {HTMLElement} parent_div - Element to append the new group to
* @param {Object} [options={}]
* @param {string} [options.operator='$and'] - Initial logical operator for this group
* @param {boolean} [options.is_root=false] - True for the top-level group; omits the close button
* @returns {HTMLElement} The new `.search_group` div
*/
render_search.prototype.render_search_group = function(parent_div, options={}) {

	const self = this

	// options
		const operator	= options.operator || '$and'
		const is_root	= options.is_root || false

	// Check already created root_search_group
		//if (options.is_root===true && document.getElementById("root_search_group")) {
		//	return false
		//}

		const all_search_groups	= self.search_group_container.querySelectorAll(".search_group")
		const total				= all_search_groups.length
		const counter			= total + 1

	// search_group
		const search_group = ui.create_dom_element({
			element_type	: 'div',
			//id			: is_root ? 'root_search_group' : null
			class_name		: "search_group",
			data_set		: {id:counter},
			parent			: parent_div
		})

		// Check already created root_search_group and store if not
		if(is_root===true){
			self.root_search_group = search_group
		}

	// model node. Create the canonical group node and link DOM ↔ model.
	// Root attaches to self.filter_model; sub groups attach to their parent node.
		const parent_group_node	= is_root ? null : (parent_div.__node || null)
		const group_node		= self.create_group_model_node(operator, parent_group_node, search_group)
		search_group.__node		= group_node
		if (is_root===true) {
			self.filter_model = group_node
		}

	// drag and drop events
		search_group.addEventListener('dragstart',function(e){self.on_dragstart(this,e)})
		search_group.addEventListener('dragend',function(e){self.on_drag_end(this,e)})
		search_group.addEventListener('drop',function(e){self.on_drop(this,e)})
		search_group.addEventListener('dragover',function(e){self.on_dragover(this,e)})
		search_group.addEventListener('dragleave',function(e){self.on_dragleave(this,e)})

	// Add operator
		const search_group_operator = ui.create_dom_element({
			element_type	: 'div',
			parent			: search_group,
			// operator word + group number chip (see operator_inner_html)
			inner_html		: operator_inner_html(operator, counter),
			title			: get_label.search_operator || 'Search operator',
			data_set		: { value : operator, counter : counter },
			class_name		: "operator search_group_operator" + (operator==="$and" ? " and" : " or")
		})
		search_group_operator.addEventListener('click', function(e){
			e.stopPropagation()
			//console.log("Clicked search_group_operator:",search_group_operator );
			toggle_operator_value(this)
			// sync the canonical model operator (source of truth)
			if (search_group.__node) {
				search_group.__node.operator = this.dataset.value
			}
			// Set initial state as unchanged
			self.update_state({state:'changed'})
		})

	// Add button x close
		if (is_root===false) {
		const search_group_button_close = ui.create_dom_element({
			element_type	: 'span',
			parent			: search_group,
			class_name		: "button close"
		})
		search_group_button_close.addEventListener('click', function(e){
			e.stopPropagation()
			// detach from the canonical model
			self.remove_model_node(search_group.__node)
			// remove from dom
			search_group.parentNode.removeChild(search_group);
			// Set as changed
			self.update_state({state:'changed'})
		})
		}

	// Add field slot: the dashed drop target after the group's fields (kept
	// there by CSS order — fields dropped later are appended after it in the
	// DOM). Fields come from the FIELDS panel by drag, so a click opens it.
		const search_group_add_field = ui.create_dom_element({
			element_type	: 'button',
			type			: 'button',
			class_name		: 'add_field',
			inner_html		: get_label.drop_field_here || 'Drag a field here',
			parent			: search_group
		})
		search_group_add_field.addEventListener('click', function(e){
			e.stopPropagation()
			if (self.search_container_selector?.classList.contains('display_none')) {
				toggle_fields(self)
			}
		})

	// Add button + group. A labelled button, kept LAST in the group's grid by
	// CSS order (fields dropped later are appended after it in the DOM).
		const search_group_button_plus = ui.create_dom_element({
			element_type	: 'button',
			type			: 'button',
			class_name		: 'add_group',
			inner_html		: get_label.add_group || 'Add group',
			parent			: search_group
		})
		search_group_button_plus.addEventListener('click', function(e){
			e.stopPropagation()
			//self.add_search_group_to_dom(this, search_group)
			self.render_search_group( search_group )
			// Set as changed
			self.update_state({state:'changed'})
		})


	return search_group
}//end render_search_group



/**
* BUILD_SEARCH_COMPONENT
* Asynchronously instantiates a search-mode component and inserts it into
* `parent_div` as a `.search_component` wrapper. This is the innermost
* building block called by `build_dom_group` (search.js) for each field entry
* in a preset group.
*
* Execution steps:
*  1. Creates the `.search_component` wrapper div and sets `data-path` and
*     `data-section_id` attributes.
*  2. Creates a canonical component model node synchronously via
*     `create_component_model_node` and sets `wrapper.__node`. The model node
*     is created before the async component load so that insertion order in
*     `parent_div.__node.children` matches DOM insertion order, even when
*     multiple async calls run concurrently.
*  3. Calls `get_component_instance()` with the last path element's identifiers
*     (`section_tipo`, `component_tipo`, `model`, `ar_target_section_tipo`)
*     and the injected `entries`, `q_operator`, `q_lang`.
*  4. Calls `component_instance.render()` and appends the result. Falls back to
*     an `.invalid_component.error` div if the instance could not be created.
*  5. Binds `component_model_node.instance` now that the instance is ready.
*  6. Adds a close button that calls `remove_model_node`, removes the DOM node,
*     splices the instance from `self.ar_instances`, calls `instance.destroy()`,
*     and refreshes up/down reorder buttons on remaining siblings.
*  7. Adds up/down reorder buttons. Each button calls `move_model_node` to keep
*     the canonical model in sync with the DOM order and then refreshes
*     `.disabled` state via `update_reorder_buttons`.
*  8. The inner `update_reorder_buttons` helper disables the up button on the
*     first component and the down button on the last component in the group.
*  9. If the `path` has more than one element (the component is reached through
*     a portal or cross-section path), the source section name is prepended to
*     any `.label_add` span already present in `parent_div`.
*
* `path_plain` is the JSON-serialised array of path-step objects. Each element
* has `{section_tipo, component_tipo, model, name, …}`. The last element
* identifies the actual component; earlier elements describe the traversal
* through relations/portals.
*
* @param {Object} options
* @param {HTMLElement} options.parent_div - The `.search_group` or nested group element
* @param {string} options.path_plain - JSON string of the field path array
* @param {*} options.entries - Existing filter values to pre-populate the component
* @param {string} options.q_operator - Query operator (e.g. 'like', '=', 'in')
* @param {string} options.q_lang - ISO language code scoping the query
* @param {string} options.section_id - Row ID context (0 for search mode)
* @returns {Promise<boolean>} Resolves to true when the component is fully rendered
*/
render_search.prototype.build_search_component = async function(options) {

	const self = this

	const parent_div		= options.parent_div
	const path_plain		= options.path_plain
	const entries			= options.entries
	const q_operator		= options.q_operator
	const q_lang			= options.q_lang
	const section_id		= options.section_id

	// short vars
		let path
		try {
			path = JSON.parse(path_plain)
		} catch (error) {
			console.error('build_search_component: invalid path_plain JSON', path_plain, error)
			return false
		}
		const last_item		= path[path.length-1]
		const first_item	= path[0]

	// search_component container. Create dom element before load html from trigger
		const search_component = ui.create_dom_element({
			element_type	: 'div',
			class_name		: "search_component",
			data_set		: {
				path		: path_plain,
				section_id	: section_id
			},
			parent			: parent_div
		})

		// model node. Create the canonical node synchronously so the model child
		// order matches DOM insertion order (components load async and may resolve
		// out of order). The built instance is bound below.
			const component_model_node = self.create_component_model_node({
				path		: path,
				section_id	: section_id,
				instance	: null,
				parent_node	: parent_div.__node || null,
				dom			: search_component
			})
			search_component.__node = component_model_node

		// component_instance. Get functional component, build and returns it ready to render
			const component_instance = await self.get_component_instance({
				section_id				: section_id,
				section_tipo			: last_item.section_tipo,
				component_tipo			: last_item.component_tipo,
				model					: last_item.model,
				ar_target_section_tipo	: last_item.ar_target_section_tipo || null,
				mode					: 'search',
				entries					: entries || null, // entries will be injected to data.entries
				q_operator				: q_operator || null,
				q_lang					: q_lang || null,
				path					: path
			})

		// render component
			// note that component here is already built with custom injected data
			const component_node = component_instance
				? await component_instance.render()
				: ui.create_dom_element({
					element_type	: 'div',
					class_name		: "invalid_component error",
					inner_html 		: get_label.invalid_component || 'Invalid component',
				})

		// add component node
			search_component.appendChild(component_node)

		// model node. Bind the now-built instance into the canonical node that was
		// created synchronously above (keeps model child order aligned with DOM order).
			component_model_node.instance = component_instance

	// button close
		const search_component_button_close = ui.create_dom_element({
			element_type	: 'span',
			parent			: search_component,
			class_name		: 'button close'
		})
		search_component_button_close.addEventListener('click', function(e){
			e.stopPropagation()
			// detach from the canonical model
			self.remove_model_node(component_model_node)
			// remove search box and content (component) from dom
			search_component.parentNode.removeChild(search_component)
			// delete the instance from search ar_instances
			const delete_instance_index = self.ar_instances.findIndex( instance => instance.id===component_instance.id )

			if(delete_instance_index !== -1){
				self.ar_instances.splice(delete_instance_index, 1)
				// destroy component instance
				component_instance.destroy(
					true // delete_self
				)
			}

			// Set as changed
			self.update_state({state:'changed'})

			// update sibling reorder buttons after removal
			const remaining = parent_div.querySelectorAll('.search_component')
			remaining.forEach(sib => update_reorder_buttons(sib))
		})

	// button up (reorder)
		const button_up = ui.create_dom_element({
			element_type	: 'span',
			parent			: search_component,
			class_name		: 'button up'
		})
		button_up.addEventListener('click', function(e){
			e.stopPropagation()
			if (button_up.classList.contains('disabled')) return
			const prev = search_component.previousElementSibling
			if (prev && prev.classList.contains('search_component')) {
				parent_div.insertBefore(search_component, prev)
				// mirror the reorder in the canonical model
				self.move_model_node(component_model_node, 'up')
				self.update_state({state:'changed'})
				update_reorder_buttons(search_component)
				update_reorder_buttons(prev)
			}
		})

	// button down (reorder)
		const button_down = ui.create_dom_element({
			element_type	: 'span',
			parent			: search_component,
			class_name		: 'button down'
		})
		button_down.addEventListener('click', function(e){
			e.stopPropagation()
			if (button_down.classList.contains('disabled')) return
			const next = search_component.nextElementSibling
			if (next && next.classList.contains('search_component')) {
				parent_div.insertBefore(next, search_component)
				// mirror the reorder in the canonical model
				self.move_model_node(component_model_node, 'down')
				self.update_state({state:'changed'})
				update_reorder_buttons(search_component)
				update_reorder_buttons(next)
			}
		})

	// update_reorder_buttons: toggle disabled state on up/down based on sibling position
		const update_reorder_buttons = function(el) {
			const up_btn	= el.querySelector('.button.up')
			const down_btn	= el.querySelector('.button.down')
			const has_prev	= el.previousElementSibling && el.previousElementSibling.classList.contains('search_component')
			const has_next	= el.nextElementSibling && el.nextElementSibling.classList.contains('search_component')
			if (up_btn) {
				up_btn.classList.toggle('disabled', !has_prev)
			}
			if (down_btn) {
				down_btn.classList.toggle('disabled', !has_next)
			}
		}

	// set initial button state
		update_reorder_buttons(search_component)
		// also update siblings since this insertion may change their state
		const prev_sib = search_component.previousElementSibling
		const next_sib = search_component.nextElementSibling
		if (prev_sib && prev_sib.classList.contains('search_component')) update_reorder_buttons(prev_sib)
		if (next_sib && next_sib.classList.contains('search_component')) update_reorder_buttons(next_sib)

	// label component source if exists
		if (first_item!==last_item) {
			//console.log("first_item:",first_item);
			const label_add = parent_div.querySelector('span.label_add')
			if (label_add) {
				label_add.innerHTML = first_item.name +' '+ label_add.innerHTML
			}
		}

	// Check update_component_with_value_state
	// If component have any value or q_operator, set style with different color to remark it
	//	component_common.update_component_with_value_state( search_component.querySelector("div.wrap_component") )

	// show hidden parent container
		parent_div.classList.remove("hide")


	return true
}//end build_search_component




/**
* RENDER_SECTIONS_SELECTOR
* Builds the Thesaurus/Ontology section-selector overlay — a `<select>` of
* typologies (e.g. "Thematic", "Toponymy") plus a checkbox list of the
* individual loaded sections (e.g. countries) belonging to the selected
* typology. The overlay is only rendered when `self.sections_selector_data`
* is non-null (i.e. the caller is an `area_thesaurus` or `area_ontology`).
*
* The returned `DocumentFragment` is prepended to `search_global_container`
* by `render_base()` before any other children.
*
* Interaction flow:
*  1. The `<select>` (typology_selector) value change calls
*     `build_sections_check_boxes` to repopulate the checkbox list and fires
*     the `update_sections_list_<id>` event channel so drag-and-drop handlers
*     can refresh the field list.
*  2. The selected typology id is stored in `localStorage` under the key
*     `selected_typology_<caller_model>` so the choice survives page reload.
*  3. On first render, `build_sections_check_boxes` is called immediately
*     with `typology_selector.value` (which will be the localStorage-restored
*     value if present, or the first `<option>` otherwise).
*
* `self.sections_selector_data` shape:
*  {
*    typologies: [{section_id, label, order}, …],
*    value: [{typology_section_id, target_section_tipo, target_section_name, …}, …]
*  }
*
* @param {Object} self - The search instance
* @returns {DocumentFragment|false} Fragment containing the overlay, or false if no data
*/
const render_sections_selector = (self) => {

	if(!self.sections_selector_data) return false

	// fragment
		const fragment = new DocumentFragment()

	// button toggle type
		const toggle_container_selector = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'toggle_container_selector sections',
			inner_html		: get_label.type || 'Type',
			parent			: fragment
		})
		.addEventListener('click', function(e){
			e.stopPropagation()
			toggle_type(self)
		})

	// wrapper
		const wrapper_sections_selector = ui.create_dom_element({
			class_name		: 'wrapper_sections_selector display_none',
			element_type	: 'div',
			parent			: fragment
		})
		// set wrapper_sections_selector
		self.wrapper_sections_selector = wrapper_sections_selector

	// typologies
		const caller_model				= self.caller.model || ''
		const typologies_cookie_name	= `selected_typology_${caller_model}`
		const typologies = self.sections_selector_data.typologies || []
		// typologies.sort((a, b) => new Intl.Collator().compare(a.label, b.label));
		typologies.sort((a, b) => parseFloat(a.order) - parseFloat(b.order));

		// selector (list of typologies)
			const typology_selector = ui.create_dom_element({
				element_type	: 'select',
				class_name		: 'dd_input typology_selector',
				parent			: wrapper_sections_selector
			})
			typology_selector.addEventListener('change', function(event){
				const typology_id = event.target.value
				build_sections_check_boxes(self, typology_id, wrapper_sections_selector_ul)
				// update_sections_list fire
				event_manager.publish('update_sections_list_' + self.id)

				// Store selected value as cookie to recover later
				localStorage.setItem(typologies_cookie_name, typology_id)
			})

		// options for selector
			const typologies_length = typologies.length
			for (let i = 0; i < typologies_length; i++) {
				ui.create_dom_element({
					element_type	: 'option',
					value			: typologies[i].section_id,
					inner_html		: typologies[i].label,
					parent			: typology_selector
				})
			}

		// cookie. previous cookie stored value
			// get the model to set into the cookie / area_thesaurus || area_ontology
			const selected_typology	= localStorage.getItem(typologies_cookie_name)
			if (selected_typology) {
				typology_selector.value = selected_typology
			}

		// checkbox list wrapper (sections of current selected thesaurus typology, like 'thematic')
			const wrapper_sections_selector_ul = ui.create_dom_element({
				element_type	: 'ul',
				class_name 		: 'wrapper_sections_selector_ul',
				parent			: wrapper_sections_selector
			})

		// trigger first selected value
			build_sections_check_boxes(
				self,
				typology_selector.value,
				wrapper_sections_selector_ul
			)


	return fragment
}//end render_sections_selector



/**
* BUILD_SECTIONS_CHECK_BOXES
* Populates the `<ul>` with one `<li>` checkbox per section belonging to the
* given `typology_id`. A "Select all" checkbox is appended when there are two
* or more sections.
*
* Checkbox state is persisted in `localStorage` under the key
* `'selected_search_sections'` as a JSON object keyed by `typology_id`:
*
*   { "1": ["numisdata665"], "2": ["es1", "fr1"] }
*
* When no stored value exists for the current typology, all checkboxes are
* checked by default.
*
* Side effects on `self`:
*  - `self.target_section_tipo` is reset to an empty array and then rebuilt
*    from the checked items. This array is the live filter of which sections
*    appear in the left "Fields" panel and are included in the SQO.
*  - An `update_sections_list_<id>` event subscription is pushed to
*    `self.events_tokens` on every call. Each call to this function therefore
*    adds a new subscription; the subscriptions are all cleaned up when the
*    search instance is destroyed via `self.destroy()`.
*
* The internal `update_sections_list` async closure:
*  - Adds the `.loading` class to `self.search_container_selector`.
*  - Rebuilds `self.target_section_tipo` from checked boxes.
*  - Calls `self.get_section_elements()` + `render_components_list()` to
*    refresh the left fields list.
*  - Persists the new selection to `localStorage`.
*  - Removes the `.loading` class.
*
* @param {Object} self - The search instance
* @param {string|number} typology_id - The section_id of the selected typology
* @param {HTMLElement} parent - The `<ul>` element to populate (cleared first)
* @returns {boolean} Always true
*/
const build_sections_check_boxes = (self, typology_id, parent) => {

	// sections list
		const all_sections	= self.sections_selector_data.value || []
		const ar_sections	= all_sections.filter(item => same_section_id(item.typology_section_id, typology_id))

	// ul node
		const ul = parent

	// reset the sqo sections
		self.target_section_tipo.splice(0,self.target_section_tipo.length)

	// cookie value (selected_search_sections)
		const cookie_name						= 'selected_search_sections'
		const selected_search_sections_value	= localStorage.getItem(cookie_name)
		let selected_search_sections = {}
		if (selected_search_sections_value) {
			try {
				selected_search_sections = JSON.parse(selected_search_sections_value)
			} catch (error) {
				console.error('Invalid selected_search_sections in localStorage', error)
			}
		}
		// sample expected parsed format
			// {
			// 	"1": [
			// 		"numisdata665"
			// 	],
			// 	"2": [
			// 		"es1",
			// 		"fr1"
			// 	]
			// }
		// saved sections still available in current typology. If none match (stale or empty value), select all
		const saved_value		= selected_search_sections[typology_id]
		const saved_sections	= (Array.isArray(saved_value) ? saved_value : []).filter(
			tipo => ar_sections.some(el => el.target_section_tipo===tipo)
		)
		const use_saved_sections = saved_sections.length > 0

	// update sections components list (left)
		const update_sections_list = async () => {

			// loading add
				self.search_container_selector.classList.add('loading')

			// reset and update var value
				self.target_section_tipo = []
				const ar_check_box_length = ar_check_box.length
				for (let i = 0; i < ar_check_box_length; i++) {
					const item = ar_check_box[i]
					if (item.checked) {
						self.target_section_tipo.push(item.value)
					}
				}

			// refresh the section list at left (use_real_sections)
				const section_elements = await self.get_section_elements({
					use_real_sections : true
				})
				render_components_list({
					self				: self,
					section_tipo		: self.target_section_tipo,
					target_div			: self.search_container_selector,
					path				: [],
					section_elements	: section_elements
				})

			// Store selected value as cookie to recover later
				selected_search_sections[typology_id] = self.target_section_tipo
				localStorage.setItem(cookie_name, JSON.stringify(selected_search_sections))

			// loading remove
				self.search_container_selector.classList.remove('loading')
		}//end update_sections_list

	// clean wrapper_sections_selector_ul
		while (ul.hasChildNodes()) {
			ul.removeChild(ul.lastChild);
		}

	// li nodes
		const ar_check_box = []
		const ar_sections_len = ar_sections.length
		for (let i = 0; i < ar_sections_len; i++) {

			const item = ar_sections[i]

			// li
				const li = ui.create_dom_element({
					element_type	: 'li',
					class_name		: 'dd_input',
					parent			: ul
				})

			// label
				const label = ui.create_dom_element({
					element_type	: 'label',
					parent			: li,
					inner_html		: item.target_section_name
				})

			// checkbox
				const check_box = ui.create_dom_element({
					element_type	: 'input',
					type			: 'checkbox',
					// id			: 'section_option_'+item.target_section_tipo,
					// name			: item.hierarchy_target_section_tipo,
					value			: item.target_section_tipo
				})
				ar_check_box.push(check_box)

				// selected. Saved value case or all when not defined
				check_box.checked = use_saved_sections
					? saved_sections.includes(item.target_section_tipo)
					: true

				// only checked sections are searched
				if (check_box.checked) {
					self.target_section_tipo.push(item.target_section_tipo)
				}

				check_box.addEventListener('change', update_sections_list)
				label.prepend(check_box)
		}//end for (let i = 0; i < ar_sections_len; i++)

	// select all option
		if (ar_check_box.length>1) {
			// li
				const li = ui.create_dom_element({
					element_type	: 'li',
					class_name		: 'dd_input',
					parent			: ul
				})
			// label
				const label = ui.create_dom_element({
					element_type	: 'label',
					parent			: li,
					inner_html		: get_label.all || 'All'
				})
			// checkbox
				const check_box = ui.create_dom_element({
					element_type	: 'input',
					type			: 'checkbox',
					value			: null
				})
				check_box.checked = ar_check_box.every(el => el.checked)
				label.prepend(check_box)
				const fn_change = function() {
					// update checked states in all elements
					ar_check_box.map(el => {
						el.checked = this.checked
					})
					// fire update_sections_list
					update_sections_list()
				}
				check_box.addEventListener('change', fn_change)
		}//end if (ar_check_box.length>1)

	// event subscription. Fire update on each publication of update_sections_list_
	// Remove previous typology subscription to avoid stale handlers overwriting current selection
		if (self.update_sections_list_token) {
			event_manager.unsubscribe(self.update_sections_list_token)
		}
		const update_sections_list_handler = () => {
			update_sections_list()
		}
		self.update_sections_list_token = event_manager.subscribe('update_sections_list_' + self.id, update_sections_list_handler)
		self.events_tokens.push(self.update_sections_list_token)


	return true
}//end build_sections_check_boxes



// toggles



	/**
	* TOGGLE_SEARCH_PANEL
	* Shows or hides the main `.search_global_container` (the entire search UI).
	* Persists the open/close state in the local IndexedDB via `data_manager`:
	* open → `set_local_db_data({id, value:true}, 'status')`;
	* close → `delete_local_db_data(id, 'status')`.
	*
	* The `status_id` key encodes both the caller's `tipo` and `mode` so that
	* the state is scoped to the specific search widget instance rather than
	* being shared globally.
	*
	* Exported so that the submit button inside `render_search_buttons` can
	* close the panel after a successful search, and so that callers outside
	* this module (e.g. `list()` panel-state restoration) can open it.
	*
	* (!) Guards against a missing `search_global_container` with a console.error
	* and early return so the function is safe to call before full render.
	*
	* @param {Object} self - The search instance
	* @returns {Promise<void>}
	*/
	export const toggle_search_panel = async (self) => {

		// short vars
			const search_global_container	= self.search_global_container
			const caller					= self.caller || {}
			const status_id					= `open_search_panel_${caller.tipo || ''}_${caller.mode || ''}`
			const status_table				= 'status'

		// Add null check
		if (!search_global_container) {
			console.error('search_global_container not found');
			return;
		}

		if (search_global_container.classList.contains('hide')) {

			search_global_container.classList.remove('hide');

			self.search_panel_is_open = true;

			const data = {
				id : status_id,
				value : true
			};

			await data_manager.set_local_db_data(data, status_table);
		} else {

			search_global_container.classList.add('hide');

			self.search_panel_is_open = false;

			await data_manager.delete_local_db_data(status_id, status_table);
		}
	}//end toggle_search_panel



	/**
	* TOGGLE_FIELDS
	* Shows or hides the left "Fields" panel (`.search_container_selector`).
	* Persists the open/close state via `self.track_show_panel({name:'fields_panel', action})`.
	*
	* Default state is hidden (`display_none`). The function toggles based on the
	* current CSS class, so calling it twice returns the panel to its original state.
	*
	* Exported so that `list()` can restore the panel to its last-used state
	* after the initial render.
	*
	* @param {Object} self - The search instance
	* @returns {boolean} Always true
	*/
	export const toggle_fields = (self) => {

		const search_container_selector = self.search_container_selector

		// cookie to track state
		const cookie_name = 'fields_panel'

		if (search_container_selector.classList.contains('display_none')) {

			search_container_selector.classList.remove('display_none')

			// Set search panel as closed
				self.track_show_panel({
					name	: cookie_name,
					action	: 'open'
				})

		}else{

			if (search_container_selector && !search_container_selector.classList.contains('display_none')) {
				search_container_selector.classList.add('display_none')
			}

			// Set search panel as closed
				self.track_show_panel({
					name	: cookie_name,
					action	: 'close'
				})
		}

		return true
	}//end toggle_fields



	/**
	* TOGGLE_PRESETS
	* Shows or hides the right "Presets" panel
	* (`.search_container_selection_presets`). On first open, lazily loads and
	* renders the user's saved presets via `load_user_search_presets` and
	* `user_presets_section.render()`.
	*
	* The panel is considered unloaded when `self.user_presets_section` is null
	* (either initial state or after an edit that set it to null to force reload).
	* While loading, a temporary "Loading.." span is shown inside the panel.
	*
	* State persistence: delegates to `self.track_show_panel` with the key
	* `'presets_panel'`.
	*
	* (!) Guards against a missing or non-HTMLElement container with
	* `console.error` and early return.
	*
	* Exported so that `list()` can restore the panel state and so that
	* preset-edit `on_close` callbacks can force a reload.
	*
	* @param {Object} self - The search instance
	* @returns {Promise<boolean>} Resolves to true once toggled (and loaded if opening)
	*/
	export const toggle_presets = async (self) => {

		const search_container_selection_presets = self.search_container_selection_presets // button.parentNode.querySelector(".search_container_selection_presets")

		// Validate that we have a valid element before proceeding
			if (!search_container_selection_presets || !(search_container_selection_presets instanceof HTMLElement)) {
				console.error("toggle_presets: Target search_container_selection_presets element not found or is not a valid HTMLElement.");
				return; // Exit if no container
			}

		// Determine the action (open or close) and toggle visibility before toggle
			const is_hidden	= search_container_selection_presets.classList.contains('display_none');
			const action	= is_hidden ? 'open' : 'close';

		// Toggle the visibility class concisely
			search_container_selection_presets.classList.toggle('display_none');

		// Set search panel as open/close
			self.track_show_panel({
				name	: 'presets_panel', // cookie_name
				action	: action
			})

		// user_presets_section . get section of users presets
			if (action==='open' && !self.user_presets_section) {

				// loading_node. Message waiting load
				const loading_node = ui.create_dom_element({
					element_type	: 'span',
					class_name		: 'notes loading',
					inner_html		: 'Loading..',
					parent			: search_container_selection_presets
				})

				self.user_presets_section = await load_user_search_presets(self)
				const user_presets_node = await self.user_presets_section.render()
				loading_node.remove()
				search_container_selection_presets.appendChild(user_presets_node)
			}


		return true
	}//end toggle_presets



	/**
	* OPERATOR_INNER_HTML
	* Label markup of a group's operator bar: the localized operator word plus
	* the group number in a `.group_counter` chip (e.g. "AND" + chip "1").
	*
	* @param {string} operator - '$and' | '$or'
	* @param {string|number} counter - the display-only group number
	* @returns {string} HTML
	*/
	const operator_inner_html = (operator, counter) => {
		return localize_operator(operator) + '<span class="group_counter">' + counter + '</span>'
	}//end operator_inner_html



	/**
	* TOGGLE_OPERATOR_VALUE
	* Flips the logical operator of a search group operator element between
	* `$and` and `$or`, updating both its `data-value` attribute, its visible
	* label (via `operator_inner_html`), and its CSS classes (`.and` / `.or`).
	*
	* The group number is read from `data-counter` (set by
	* `render_search_group`), not parsed from the label markup.
	*
	* This is a pure DOM mutation helper. The caller in `render_search_group` is
	* responsible for syncing the canonical model node's `operator` property after
	* this function returns.
	*
	* @param {HTMLElement} element - The `.operator.search_group_operator` div
	* @returns {boolean} Always true
	*/
	const toggle_operator_value = (element) => {

		// group number lives in data-counter (the label is markup, not text)
		const number = element.dataset.counter

		if (element.dataset.value==="$and") {
			// Replace dataset value
			element.dataset.value = "$or";

			// Inject new html value
			element.innerHTML = operator_inner_html(element.dataset.value, number)

			element.classList.remove("and")
			element.classList.add("or")

		}else{
			// Replace dataset value
			element.dataset.value = "$and";

			// Inject new html value
			element.innerHTML = operator_inner_html(element.dataset.value, number)

			element.classList.remove("or")
			element.classList.add("and")
		}

		return true
	}//end toggle_operator_value



	/**
	* TOGGLE_TYPE
	* Shows or hides the typology/type selector panel
	* (`.wrapper_sections_selector`) which is the area_thesaurus / area_ontology
	* overlay for picking which sections to search.
	*
	* Returns false immediately and makes no DOM changes when
	* `self.wrapper_sections_selector` is null (i.e. the caller is not a
	* thesaurus/ontology area, so the panel was never created).
	*
	* Default state is hidden (`display_none`). State is persisted via
	* `self.track_show_panel({name:'type_panel', action})`.
	*
	* Exported so that `list()` can restore the panel state on page load.
	*
	* @param {Object} self - The search instance
	* @returns {boolean} true if the panel was toggled, false if it does not exist
	*/
	export const toggle_type = (self) => {

		const wrapper_sections_selector = self.wrapper_sections_selector
		// check if exists (only exists in thesaurus)
		if (!wrapper_sections_selector) {
			return false
		}

		// cookie to track state
		const cookie_name = 'type_panel'

		if (wrapper_sections_selector.classList.contains('display_none')) {

			wrapper_sections_selector.classList.remove('display_none')

			// Set search panel as closed
				self.track_show_panel({
					name	: cookie_name,
					action	: 'open'
				})

		}else{

			if (wrapper_sections_selector && !wrapper_sections_selector.classList.contains('display_none')) {
				wrapper_sections_selector.classList.add('display_none')
			}

			// Set search panel as closed
				self.track_show_panel({
					name	: cookie_name,
					action	: 'close'
				})
		}

		return true
	}//end toggle_type
//end toggles



/**
* LOCALIZE_OPERATOR
* Returns the i18n label for a MongoDB-style logical operator string.
* Strips the leading `$` character and looks up the remainder in `get_label`
* (the global label map injected by the Dédalo page globals).
*
* Examples:
*   localize_operator('$and')  → get_label.and  (e.g. "AND" or "Y")
*   localize_operator('$or')   → get_label.or   (e.g. "OR"  or "O")
*
* Falls back to an empty string if `get_label[name]` is undefined, which
* prevents raw operator strings (e.g. "$and") from appearing in the UI.
*
* @param {string} operator - A query operator prefixed with '$' (e.g. '$and', '$or')
* @returns {string} The localised operator label, or '' if unknown
*/
const localize_operator = (operator) => {

	// Remove '$' (first char)
	const clean_operator = operator.slice(1)

	const name = (clean_operator==='and') ? 'and' :
				 (clean_operator==='or') ? 'or' :
				 clean_operator

	const localized = get_label[name] || ''


	return localized
}//end localize_operator



// @license-end
