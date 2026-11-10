// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL*/
/*eslint no-undef: "error"*/



/**
* MODULE render_edit_component_filter
*
* Client-side edit-mode renderer for component_filter — Dédalo's project-access-control
* component. A component_filter holds an array of project locators that determine which
* projects a section record belongs to; this module builds the entire checkbox tree UI,
* button bar, and read-only variant used when printing.
*
* Exports (used by view_default_edit_filter and view_line_edit_filter):
*   - render_edit_component_filter  constructor / prototype carrier for the .edit() entry point
*   - get_content_data              builds the hierarchical checkbox <ul> tree
*   - get_input_element             creates an interactive checkbox <li> for one project node
*   - get_input_element_read        creates a read-only <li> for one project node (permissions===1)
*   - get_buttons                   assembles the action button bar fragment
*
* Data shapes (from server JSON):
*   self.data.datalist  — Array of project objects:
*     { type, label, section_tipo, section_id, value: locator, parent: locator|null, order: number }
*     where `parent` is null for root nodes and a {section_tipo, section_id} locator for children.
*   self.data.entries   — Array of currently-selected locators:
*     { section_tipo, section_id, id?, from_component_tipo?, ... }
*
* Context flags consumed:
*   self.context.view           — 'default' | 'line' | 'print'
*   self.context.target_sections — Array of { tipo, label } for button_list rendering
*   self.permissions            — integer; 1 = read-only, >1 = editable
*   self.show_interface         — Object with boolean flags: button_list, button_delete,
*                                 button_fullscreen, tools
*/

// imports
	import {ui} from '../../common/js/ui.js'
	import {render_value} from '../../common/js/utils/render_escape.js'
	import {object_to_url_vars, open_window, same_section_id} from '../../common/js/utils/index.js'
	import {view_default_edit_filter} from './view_default_edit_filter.js'
	import {view_line_edit_filter} from './view_line_edit_filter.js'



/**
* RENDER_EDIT_COMPONENT_FILTER
* Constructor / prototype carrier for the component_filter edit renderer.
* Instances are never created directly; the constructor exists only so that
* component_filter.prototype.edit can be assigned from
* render_edit_component_filter.prototype.edit, following Dédalo's prototype-delegation
* pattern for render modules.
*/
export const render_edit_component_filter = function() {

	return true
}//end render_edit_component_filter



/**
* EDIT
* Entry point for the component_filter edit renderer. Selects and delegates to the
* correct view implementation based on self.context.view.
*
* Supported views:
*   'line'    — Compact inline edit, rendered by view_line_edit_filter.
*   'print'   — Same DOM structure as 'default' but forces self.permissions to 1 so
*               that get_input_element_read is used throughout, producing a static
*               checkbox snapshot suitable for print stylesheets. The 'print' case
*               intentionally falls through to 'default' after setting permissions.
*   'default' — Full edit tree (also used as the catch-all fallback).
*
* @param {Object} options - Render options forwarded to the view renderer.
*   @param {string} [options.render_level='full'] - 'full' builds the entire wrapper;
*     'content' returns only the content_data node (used by partial refreshes).
* @returns {Promise<HTMLElement>} The rendered wrapper element (or content_data when
*   render_level==='content').
*/
render_edit_component_filter.prototype.edit = async function(options) {

	const self = this

	// view
		const view = self.context.view || 'default'

	switch(view) {

		case 'line':
			return view_line_edit_filter.render(self, options)

		case 'print':
			// view print use the same view as default, except it will use read only to render content_value
			// as different view as default it will set in the class of the wrapper
			// sample: <div class="wrapper_component component_input_text oh14 oh1_oh14 edit view_print disabled_component">...</div>
			// take account that to change the css when the component will render in print context
			// for print we need to use read of the content_value and it's necessary force permissions to use read only element render
			// (!) Intentional fall-through: setting permissions=1 here forces get_input_element_read
			// in get_content_data, then execution continues into the 'default' case below.
			self.permissions = 1

		case 'default':
		default:
			return view_default_edit_filter.render(self, options)
	}
}//end edit



/**
* GET_CONTENT_DATA
* Builds and returns the main content-data container for the component, populated with a
* hierarchical checkbox tree that reflects the project structure available to the current user.
*
* Algorithm:
*   1. Reads self.data.datalist (flat array of project objects with optional parent locators).
*   2. Separates root nodes (parent === null) from child nodes.
*   3. For each root node, recursively collects children via get_children_node, mutating each
*      datalist item to set its has_children flag before delegating to get_input_element /
*      get_input_element_read.
*   4. Appends the resulting <li> tree into a root <ul class="content_value branch">.
*
* Sorting: at each level, nodes are sorted first by `order` (ascending), then alphabetically
* by `label` as a stable tiebreaker.
*
* Read-only mode: when self.permissions === 1 (e.g. forced by 'print' view), each node is
* rendered via get_input_element_read instead of get_input_element.
*
* Side effect: mutates each datalist item by adding/overwriting `has_children` (boolean).
*
* @param {Object} self - Component instance. Must expose:
*   self.data.datalist  {Array}  - Flat list of project node objects.
*   self.permissions    {number} - 1 = read-only; >1 = interactive.
* @returns {HTMLElement} content_data - The populated content-data container node.
*/
export const get_content_data = function(self) {

	// short vars
		const data		= self.data || {}
		const datalist	= data.datalist || []

	// content_data
		const content_data = ui.component.build_content_data(self)

	// parent ul
	const ul_branch = ui.create_dom_element({
		element_type	: 'ul',
		class_name		: 'content_value branch',
		parent			: content_data
	})

	// get tree nodes with children recursively
	// Recursively resolves a single project node and all its descendants into a
	// <li> element. Children are identified by matching their parent locator
	// (section_tipo + section_id) against the current element's identity.
	const get_children_node = function(element) {

		const children_elements = datalist
			.filter(
				el => el.parent &&
				el.parent.section_tipo === element.section_tipo &&
				same_section_id(el.parent.section_id, element.section_id)
			)
			.sort((a, b) =>
				(a.order - b.order) || ((a.label || '').localeCompare(b.label || ''))
			);

		const children_elements_len = children_elements.length
		// modify has_children property
		// (!) Mutates the datalist item in place so that get_input_element/read can branch
		// on it for CSS class and collapsible-branch rendering.
		element.has_children = (children_elements_len > 0)

		// element_node
		// Delegate to the read-only renderer when permissions === 1 (e.g. print view).
		const element_node = (self.permissions===1)
			? get_input_element_read(element, self)
			: get_input_element(element, self)

		if(children_elements_len > 0) {
			for (let i = 0; i < children_elements_len; i++) {
				const current_child	= children_elements[i]
				const child_node	= get_children_node(current_child)
				// Attach each child <li> to element_node.branch (<ul class="branch">).
				element_node.branch.appendChild(child_node)
			}
		}

		return element_node;
	}

	// root nodes
	// Filter projects without parent (root nodes) and sort by order if defined.
	// If not, sort by label alphabetically.
	const root_elements	= datalist
		.filter(el => el.parent === null)
		.sort((a, b) =>
			(a.order - b.order) || ((a.label || '').localeCompare(b.label || ''))
		);

	// Iterate root nodes and get children adding everyone to the parent ul branch.
	const root_elements_len	= root_elements.length
	for (let i = 0; i < root_elements_len; i++) {
		const current_element	= root_elements[i]
		const element_node		= get_children_node(current_element)
		ul_branch.appendChild(element_node)
	}


	return content_data
}//end get_content_data



/**
* GET_INPUT_ELEMENT
* Creates an interactive <li> node for one project entry in the filter checkbox tree.
*
* The rendered structure is:
*   <li class="item_li[ grouper]">
*     <input type="checkbox" class="item_input" />
*     <label class="item_label" title="ID: {section_id}">{label}</label>
*     [if has_children:]
*       <span class="icon_arrow" />     ← collapse/expand toggle
*       <ul class="branch" />           ← child <li> nodes appended by get_children_node
*   </li>
*
* The returned <li> exposes `li.branch` (the child <ul>) when has_children is true, so
* that get_children_node in get_content_data can append child nodes after this call.
*
* Checkbox state: checked when the entry matches any item in self.data.entries by
* (section_tipo + section_id).
*
* Minimum-selection guard: unchecking the last selected checkbox in non-search mode is
* blocked via alert() and the checkbox is restored. This prevents a record from being
* left with no project assignment. (!) Uses alert() for the guard message — a
* non-blocking UI notification pattern would be preferable.
*
* Collapse state: each group's open/collapsed state is persisted across renders using
* ui.collapse_toggle_track with a stable key of 'collapsed_component_filter_group_{tipo}_{id}'.
*
* Side effect on datalist_value: augments element.value with `from_component_tipo = self.tipo`
* before it is passed to self.change_handler. This annotates the locator so the save layer
* can record which component issued the change.
*
* @param {Object} element - One datalist entry. Expected shape:
*   { type: string, label: string, section_tipo: string, section_id: string|number,
*     value: Object (locator), parent: Object|null, order: number, has_children: boolean }
* @param {Object} self - component_filter instance. Must expose:
*   self.data.entries  {Array}   - currently-selected locators.
*   self.node.content_data {HTMLElement} - root DOM node used to query all checkboxes.
*   self.tipo          {string}  - component tipo; stamped onto datalist_value.
*   self.mode          {string}  - 'edit' | 'search'; guard skipped in 'search' mode.
*   self.change_handler {Function} - component_filter.prototype.change_handler.
* @returns {HTMLElement} li - The constructed <li> element (with optional .branch property).
*/
export const get_input_element = (element, self) => {

	// short vars
		const entries			= self.data.entries || []
		const entries_length	= entries.length
		const label				= element.label || ''
		const section_id		= element.section_id
		const section_tipo		= element.section_tipo
		const datalist_value	= element.value
		// Annotate the locator with the originating component tipo so the server-side
		// relation can record from_component_tipo on save.
		if (datalist_value) {
			datalist_value.from_component_tipo = self.tipo
		}

	// li container
		// 'grouper' class is added when the node has children, enabling group-level CSS styling.
		const li_class_name = (element.has_children) ? ' grouper' : ''
		const li = ui.create_dom_element({
			element_type	: 'li',
			class_name		: 'item_li' + li_class_name
		})

	// input checkbox
		const input_node = ui.create_dom_element({
			element_type	: 'input',
			type			: 'checkbox',
			class_name		: 'item_input',
			parent			: li
		})
		// change event
		const input_change_handler = (e) => {
				e.preventDefault()

				// check all values
				// Collect all checked checkboxes within this component's content_data to
				// enforce the minimum-one-selection rule in edit mode.
					const checked_items = []
					const all_inputs = self.node.content_data.querySelectorAll('.item_input')
					for (let i = 0; i < all_inputs.length; i++) {
						if(all_inputs[i].checked) {
							checked_items.push(all_inputs[i])
						}
					}
					if (checked_items.length<1 && self.mode!=='search') {
						// restore checked
						// (!) alert() used here — UX improvement pending.
						input_node.checked = true
						alert( get_label.select_one_project || 'You must select at least one project' );
						return
					}

				// common change handler
				self.change_handler({
					checked			: input_node.checked,
					datalist_value	: datalist_value
				})
			}
		input_node.addEventListener('change', input_change_handler)
		// mousedown event
		// Stop propagation to prevent the parent section from receiving the mousedown,
		// which could trigger unwanted section-level focus or drag behaviour.
		const mousedown_handler = (e) => {
			e.stopPropagation()
		}
		input_node.addEventListener('mousedown', mousedown_handler)


	// label
		ui.create_dom_element({
			element_type	: 'label',
			class_name		: 'item_label',
			inner_html		: render_value(label, self.context.render_class),
			title			: 'ID: ' + section_id,
			parent			: li
		})

	// children
		if(element.has_children){

			// Unique key per group node used by collapse_toggle_track to persist open/closed state.
			const key = section_tipo +'_'+ section_id

			// icon_arrow
				const icon_arrow = ui.create_dom_element({
					element_type	: 'span',
					class_name		: 'icon_arrow',
					parent 			: li
				})

			// branch
				const branch = ui.create_dom_element({
					element_type	: 'ul',
					class_name		: 'branch',
					parent 			: li
				})
				// Expose branch on the <li> so get_children_node can append child nodes.
				li.branch = branch

			// collapse_toggle_track
			// Registers the icon_arrow as a toggler for the branch <ul>, persisting
			// the collapsed/expanded state via localStorage under the collapsed_id key.
				ui.collapse_toggle_track({
					toggler				: icon_arrow,
					container			: branch,
					collapsed_id		: 'collapsed_component_filter_group_' + key,
					collapse_callback	: () => {
						icon_arrow.classList.remove('up')
					},
					expose_callback		: () => {
						icon_arrow.classList.add('up')
					}
				})
		}

		// checked option set on match
		// Linear scan over entries to mark the checkbox if this node's locator is already
		// saved. Matching is done by section_id + section_tipo identity (type is not compared).
			for (let j = 0; j < entries_length; j++) {
				if (entries[j] && datalist_value &&
					same_section_id(entries[j].section_id, datalist_value.section_id) &&
					entries[j].section_tipo===datalist_value.section_tipo
					) {
						input_node.checked = true
				}
			}


	return li
}//end get_input_element



/**
* GET_INPUT_ELEMENT_READ
* Creates a read-only <li> node for one project entry in the filter tree.
* Used when self.permissions === 1, which occurs in 'print' view and when the
* component is rendered in a read-only context.
*
* Unlike get_input_element, this function does NOT render a checkbox or attach any event
* listeners. It renders only the entries that are currently selected (i.e. present in
* self.data.entries): selected entries get a label with a prepended check icon; unselected
* entries produce an empty <li> (still needed to preserve tree structure for child nodes).
*
* The returned <li> exposes `li.branch` (child <ul>) when has_children is true, matching
* the contract expected by get_children_node in get_content_data.
*
* Label fallback: if element.label is absent, falls back to '{section_tipo}_{section_id}'
* to ensure the node is always identifiable in the UI.
*
* Rendered structure (when found):
*   <li class="item_li[ grouper]">
*     <label class="item_label">
*       <span class="icon_button icon check " />   ← check icon prepended
*       {label}
*     </label>
*     [if has_children:] <ul class="branch" />
*   </li>
*
* Rendered structure (when not found / not selected):
*   <li class="item_li[ grouper]">
*     [if has_children:] <ul class="branch" />
*   </li>
*
* @param {Object} element - One datalist entry. Expected shape:
*   { label: string, section_tipo: string, section_id: string|number,
*     value: Object (locator), has_children: boolean }
* @param {Object} self - component_filter instance. Must expose:
*   self.data.entries  {Array} - currently-selected locators.
* @returns {HTMLElement} li - The constructed read-only <li> element.
*/
export const get_input_element_read = (element, self) => {

	// short vars
		const entries			= self.data.entries || []
		const datalist_value	= element.value
		// Fallback label uses tipo_id format when the server did not supply a display label.
		const label				= element.label || (element.section_tipo+'_'+element.section_id)

	// checked option set on match
		const found = entries.find(el => datalist_value &&
			same_section_id(el.section_id, datalist_value.section_id) &&
			el.section_tipo===datalist_value.section_tipo
		)

	// li container
		const li_class_name = (element.has_children) ? ' grouper' : ''
		const li = ui.create_dom_element({
			element_type	: 'li',
			class_name		: 'item_li' + li_class_name
		})

	// label
	// Only render the label element when this entry is among the selected values.
	// Unselected entries contribute an (optionally branchable) empty <li> to keep
	// tree depth correct for child nodes.
		if(found){
			// label
				const label_node = ui.create_dom_element({
					element_type	: 'label',
					class_name		: 'item_label',
					inner_html		: render_value(label, self.context.render_class),
					parent			: li
				})

			// icon_node check
				const icon_node = ui.create_dom_element({
					element_type	: 'span',
					class_name		: 'icon_button icon check '
				})
				label_node.prepend(icon_node)
		}

	// has_children case
	// Always create the branch <ul> for grouper nodes so that get_children_node can
	// append child <li> elements regardless of whether this node is selected.
		if(element.has_children) {
			// branch
			const branch = ui.create_dom_element({
				element_type	: 'ul',
				class_name		: 'branch',
				parent 			: li
			})
			// Expose branch on the <li> so get_children_node can append child nodes.
			li.branch = branch
		}


	return li
}//end get_input_element_read



/**
* GET_BUTTONS
* Assembles the action button bar for the component_filter edit view and returns it
* wrapped in a standard buttons_container element.
*
* The set of rendered buttons is controlled by the boolean flags on self.show_interface:
*
*   button_list {boolean}
*     Renders one 'pen' button per entry in self.context.target_sections (typically the
*     Projects section). Clicking opens that section's list view in a new named window
*     ('section_view') via open_window(). When the window loses focus (on_blur), the
*     component is refreshed with build_autoload:true so any newly-created project entries
*     are reflected without a full page reload. In SHOW_DEBUG mode, the button title
*     appends the section tipo for diagnostics.
*
*   button_delete {boolean}
*     Renders a 'reset' button that bulk-clears all project assignments for this record.
*     Guards: (1) no-op if entries is already empty; (2) requires user confirmation via
*     confirm(). On confirm, sends a single frozen changed_data item with action:'clear',
*     the EXPLICIT wipe (DATA-06, 2026-08-30) — every entry, in every language. The old
*     spelling (action:'remove' with a null id) is refused now, client-side and server-side.
*     (!) Uses confirm() for the confirmation prompt — a non-blocking dialog would be
*     preferable.
*
*   tools {boolean}
*     Delegates to ui.add_tools(self, fragment), which appends any tools registered
*     for this component type (e.g. history, export tools).
*
*   button_fullscreen {boolean}
*     Appends a fullscreen toggle button. Clicking calls ui.enter_fullscreen(self.node),
*     which uses the browser's Fullscreen API on the component's root DOM node.
*
* All buttons are accumulated in a DocumentFragment for a single DOM insertion into the
* buttons_container, avoiding multiple reflows.
*
* @param {Object} self - component_filter instance. Must expose:
*   self.show_interface   {Object}  - boolean flag map (see above).
*   self.context.target_sections {Array}  - [{tipo, label}] for button_list.
*   self.data.entries     {Array}   - currently-selected locators for empty-guard.
*   self.node             {HTMLElement} - component root for fullscreen.
*   self.permissions      {number}  - typically checked by the caller before invoking;
*                                      get_buttons is only called when permissions > 1.
*   self.refresh          {Function} - called after window blur.
*   self.change_value     {Function} - called on bulk reset.
* @returns {HTMLElement} buttons_container - The populated button bar container.
*/
export const get_buttons = (self) => {

	// short vars
		const show_interface = self.show_interface

	// fragment
	// Accumulate all button nodes in a DocumentFragment so they are inserted into the
	// buttons_container in a single DOM operation.
		const fragment = new DocumentFragment()

	// button edit (go to target section: Projects)
	// One button is rendered per target_section, allowing navigation to each project
	// list independently when multiple target sections are configured.
		if(show_interface.button_list === true){

			const target_sections			= self.context.target_sections
			const target_sections_length	= target_sections.length
			for (let i = 0; i < target_sections_length; i++) {

				const item = target_sections[i]

				// In debug mode, append the tipo to the title so developers can identify
				// the ontology node without inspecting the DOM.
				const label = (SHOW_DEBUG===true)
					? `${item.label} [${item.tipo}]`
					: item.label

				const button_list = ui.create_dom_element({
					element_type	: 'span',
					class_name		: 'button pen',
					title			: label,
					parent			: fragment
				})
				// mousedown event
				const mousedown_handler = (e) => {
					e.stopPropagation()

					// open a new window
					// Opens the target section list in a shared named window ('section_view').
					// Using a fixed name means repeated clicks reuse the same window tab.
					const url = DEDALO_CORE_URL + '/page/?' + object_to_url_vars({
						tipo	: item.tipo,
						mode	: 'list',
						menu	: false
					})
					open_window({
						url		: url,
						name	: 'section_view',
						on_blur : () => {
							// refresh current instance
							// Triggers a full data reload when the user returns from the project
							// list window, picking up any newly-created projects.
							return self.refresh({
								build_autoload : true
							})
						}
					})
				}
				button_list.addEventListener('mousedown', mousedown_handler)
			}
		}

	// button reset (button_delete)
	// Despite the show_interface flag name ('button_delete'), this is a *reset* button
	// that removes all project assignments rather than deleting the record itself.
		if(show_interface.button_delete === true){

			const button_reset = ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'button reset',
				parent			: fragment
			})
			button_reset.addEventListener('click', function(e) {
				e.stopPropagation()

				// Guard: no-op when there is nothing to clear.
				if (self.data.entries.length===0) {
					return true
				}

				// (!) confirm() used here — a non-blocking confirmation dialog would be
				// preferable for a consistent UX.
				if (!confirm(get_label.sure || 'Sure?')) {
					return
				}

				// DELIBERATE WIPE (DATA-06, 2026-08-30): drop EVERY project assignment,
				// in every language. `action:'clear'` is the ONE explicit wildcard
				// (component_common.update_data_value + the server's
				// save_component.ts clear branch). The previous spelling — a `remove`
				// carrying a null id — is now REFUSED at both doors
				// (record.remove_without_id), because it is indistinguishable from an
				// unresolved SINGLE-row delete (component_filter.js builds
				// `locator?.id || null`), and that ambiguity used to empty the whole
				// component and answer ok. Never restore it here.
				const changed_data = [Object.freeze({
					action	: 'clear',
					value	: null
				})]
				self.change_value({
					changed_data	: changed_data,
					label			: 'All',
					refresh			: true
				})

				return true
			})
		}

	// buttons tools
		if(show_interface.tools === true){
			ui.add_tools(self, fragment)
		}

	// button_fullscreen
		if(show_interface.button_fullscreen === true){
			const button_fullscreen = ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'button full_screen',
				title			: get_label.full_screen || 'Full screen',
				parent			: fragment
			})
			// click event
			const click_handler = (e) => {
				e.stopPropagation()
				ui.enter_fullscreen(self.node)
			}
			button_fullscreen.addEventListener('click', click_handler)
		}

	// buttons container
	// Append all accumulated buttons in a single insertion into the standard container.
		const buttons_container = ui.component.build_buttons_container(self)
		buttons_container.appendChild(fragment)


	return buttons_container
}//end get_buttons



// @license-end
