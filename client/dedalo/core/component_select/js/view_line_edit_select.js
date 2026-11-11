// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL*/
/*eslint no-undef: "error"*/



// imports
	import {object_to_url_vars, open_window, same_section_id} from '../../common/js/utils/index.js'
	import {ui} from '../../common/js/ui.js'
	import {render_value} from '../../common/js/utils/render_escape.js'
	import {handle_select_change} from './component_select.js'
	import {
		get_content_data
	} from './render_edit_component_select.js'



/**
* VIEW_LINE_EDIT_SELECT
* Compact inline edit view for component_select.
*
* This is the 'line' rendering variant of the component_select edit mode,
* activated when context.view === 'line'. It is designed for embedded/grid
* contexts where screen real estate is constrained. Key differences from
* view_default_edit_select:
*   - No get_buttons() panel (no button_add, no button_list toolbar).
*   - The exit-edit button is placed inside the content_value node at slot 0
*     rather than in the wrapper's button area.
*   - The optional button_edit navigates to the target section's list view
*     (mode:'list'), not to an individual record's edit view.
*   - No dataframe rendering — component_select line view is value-only.
*
* The 'line' layout produces a minimal wrapper containing a single <select>
* element. Activation is triggered by focus (keyboard tab navigation is
* supported). The wrapper carries no labels and skips the full buttons panel.
*
* Exported symbols:
*   view_line_edit_select  — namespace object / no-op constructor
*   view_line_edit_select.render  — async static entry point
*/
export const view_line_edit_select = function() {

	return true
}//end view_line_edit_select



/**
* RENDER
* Builds the full wrapper DOM node for the 'line' edit view.
*
* Delegates content_data construction to get_content_data (shared with
* view_default_edit_select) by supplying get_content_value as the edit-slot
* builder. When render_level === 'content', returns the raw content_data node
* without a wrapper (used by portals and section grids that manage layout
* themselves). Otherwise wraps it via ui.component.build_wrapper_edit and
* attaches a content_data pointer on the wrapper for callers that need direct
* access to the slot container.
*
* @param {Object} self - Component instance (component_select)
* @param {Object} options - Render options
* @param {string} [options.render_level='full'] - 'full' returns the full
*   component wrapper; 'content' returns only the content_data node
* @returns {Promise<HTMLElement>} Resolved with the wrapper node (render_level
*   'full') or the content_data node (render_level 'content')
*/
view_line_edit_select.render = async function(self, options) {

	// options
		const render_level = options.render_level || 'full'

	// content_data
		const content_data = get_content_data(self, {
			render_content_data			: get_content_value,
			render_content_value_read	: get_content_value_read
		})
		// content_data.appendChild(button_exit_edit)
		if (render_level==='content') {
			return content_data
		}

	// wrapper. ui build_edit returns component wrapper
		const wrapper = ui.component.build_wrapper_edit(self, {
			content_data	: content_data,
			label			: null
		})
		// set pointers
		wrapper.content_data = content_data


	return wrapper
}//end render



/**
* GET_CONTENT_VALUE
* Builds one interactive content_value slot containing a <select> element for
* the 'line' edit view. Called by get_content_data once per value slot (in
* practice at most once, since component_select is single-value).
*
* Differences from view_default_edit_select's get_content_value:
*   - Prepends the exit-edit button into slot 0 (not into the wrapper).
*   - No dataframe rendering (line view is value-only).
*   - button_edit navigates to the target section's list view (mode:'list')
*     rather than to a specific record's edit view.
*   - The change handler reads the entry id dynamically from self.data on
*     every change (not captured in the closure), preventing stale-id bugs
*     after the first save creates the entry.
*
* (!) datalist.unshift mutates the array coming from self.data.datalist —
* the empty sentinel option is added in-place. This means calling
* get_content_value more than once on the same self instance would push
* duplicate empty options into the datalist. In current usage get_content_data
* only calls this once per render cycle.
*
* @param {number} i - Slot index within the current render loop (0-based)
* @param {Object|null} current_value - Saved locator for this slot, e.g.
*   {section_id: '2', section_tipo: 'rsc740', id: 5}, or null when empty
* @param {Object} self - Component instance (component_select)
* @returns {HTMLElement} content_value div containing exit-edit button (slot 0
*   only), <select> with all datalist options, and optionally button_edit
*/
const get_content_value = (i, current_value, self) => {

	// short vars
		const data		= self.data || {}
		// add empty option at beginning of the datalist array.
		// (!) mutates self.data.datalist in-place — safe only for single render per lifecycle
		const empty_option = {
			label	: '',
			value	: null
		}
		const datalist	= [empty_option, ...(data.datalist || [])]

	// content_value
		const content_value = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'content_value'
		})

	// button_exit_edit. Add once
		// In the line view the exit-edit button lives inside the content_value node
		// (not in the wrapper's button panel, which is absent in this view).
		if (i===0) {
			const button_exit_edit = ui.component.build_button_exit_edit(self)
			content_value.appendChild(button_exit_edit)
		}

	// select
		const select = ui.create_dom_element({
			element_type	: 'select',
			class_name		: 'select',
			parent			: content_value
		})
		// focus event
			select.addEventListener('focus', function(){
				// force activate on input focus (tabulating case)
				if (!self.active) {
					ui.component.activate(self)
				}
			})
		// change event
			select.addEventListener('change', async function(){
				// common change handler (parse, build changed_data_item, set_changed_data, change_value)
				// read id dynamically from self.data (not from stale closure)
				const current_id = self.data.entries?.[0]?.id ?? null
				await handle_select_change(self, select, current_id)
			})
		// click event
			// Stop propagation so a click on the select does not bubble up and
			// trigger parent section or portal click handlers.
			select.addEventListener('click', function(e){
				e.stopPropagation()
			})

	// select options
		const datalist_length = datalist.length
		for (let i = 0; i < datalist_length; i++) {

			const datalist_item = datalist[i]

			// datalist_item.section_id is the short id of the ontology record,
			// available for debug display; it is NOT the same as value.section_id
			// (which is the data record id). May be absent on the empty sentinel.
			const current_section_id = typeof datalist_item.section_id!=='undefined'
				? datalist_item.section_id
				: null

			// In debug mode, append the ontology section_id in brackets after the label
			// so developers can identify which ontology record each option maps to.
			const current_label = (SHOW_DEBUG===true)
				? datalist_item.label + (current_section_id ? " [" + current_section_id + "]" : '')
				: datalist_item.label

			// option value is JSON-serialized so the change handler can parse the
			// full locator object ({section_id, section_tipo}) from select.value
			const option_node = ui.create_dom_element({
				element_type	: 'option',
				value			: JSON.stringify(datalist_item.value),
				inner_html		: render_value(current_label, self.context.render_class),
				parent			: select
			})
			// selected options set on match
			// Match by both section_id and section_tipo to uniquely identify the locator.
			if (current_value && datalist_item.value &&
				same_section_id(current_value.section_id, datalist_item.value.section_id) &&
				current_value.section_tipo===datalist_item.value.section_tipo
				) {
				option_node.selected = true
			}

			// developer_info
				// if (current_section_id) {
				// 	// developer_info
				// 	ui.create_dom_element({
				// 		element_type	: 'span',
				// 		class_name		: 'developer_info hide show_on_active',
				// 		text_content	: ` [${current_section_id}]`,
				// 		parent			: option_node
				// 	})
				// }
		}//end for (let i = 0; i < datalist_length; i++)

	// button_edit. Default is hidden
		// In the 'line' view, button_edit opens the target section in list mode
		// so the user can browse/find records, unlike the default view which opens
		// a specific record in edit mode. show_interface.button_edit defaults to
		// false and is only set true for global admins (see render_edit_component_select).
		if(self.show_interface.button_edit===true) {
			const button_edit = ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'button edit show_on_active',
				parent			: content_value
			})
			button_edit.addEventListener('click', function(e) {
				e.stopPropagation()

				// short vars
					const target_section_tipo = self.context.target_sections[0].tipo

				// open a new window
					const url = DEDALO_CORE_URL + '/page/?' + object_to_url_vars({
						tipo	: target_section_tipo,
						mode	: 'list',
						menu	: false
					})
					open_window({
						url		: url,
						name	: 'record_view',
						on_blur : () => {
							// refresh current instance after the user closes/blurs the popup
							// window, so any new or changed records are picked up in the datalist
							return self.refresh({
								build_autoload : true
							})
						}
					})
			})
			// if (!current_value) {
			// 	button_edit.classList.add('hide')
			// }
		}


	return content_value
}//end get_content_value



/**
* GET_CONTENT_VALUE_READ
* Builds a read-only content_value slot displaying the resolved label string.
* Used by get_content_data when self.permissions === 1 (read-only / print mode).
*
* The caller (get_content_data) has already looked up the human-readable label
* from the datalist by matching the saved locator's section_id + section_tipo,
* so this function receives the label string directly rather than a locator
* object.
*
* @param {number} i - Slot index (0-based); unused here but part of the shared
*   callback contract required by get_content_data
* @param {string|null} current_value - Human-readable label text to display,
*   or empty string when no matching datalist entry was found
* @param {Object} self - Component instance; unused here but part of the shared
*   callback contract required by get_content_data
* @returns {HTMLElement} content_value div with class 'content_value read_only'
*   containing the label as inner HTML
*/
const get_content_value_read = (i, current_value, self) => {

	// create content_value
		const content_value = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'content_value read_only',
			inner_html		: render_value(current_value, self.context.render_class)
		})


	return content_value
}//end get_content_value_read



// @license-end
