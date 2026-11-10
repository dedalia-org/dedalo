// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL*/
/*eslint no-undef: "error"*/



// imports
	import {ui} from '../../common/js/ui.js'
	import {render_value} from '../../common/js/utils/render_escape.js'
	import {set_before_unload} from '../../common/js/events.js'



/**
* VIEW_DEFAULT_EDIT_FILTER_RECORDS
* Default edit-mode view for component_filter_records.
*
* component_filter_records grants individual user accounts access to specific
* records across arbitrary sections. This module is responsible for building the
* interactive DOM for the 'default', 'line', and 'print' edit views.
*
* The component renders a header row (tipo / section label / value columns) and
* then one content-value row per entry in the server-supplied datalist:
*   - When self.permissions === 1 (read-only), only the entries that already have
*     stored values are shown, each as a static read-only row.
*   - When self.permissions > 1 (edit), every datalist section gets a text input
*     allowing the user to type a comma-separated list of record IDs (e.g. "1,2,3").
*
* Data shapes consumed from self.data:
*   datalist  — array of {tipo: string, label: string, permissions: number} objects
*               built by class.component_filter_records.php::get_datalist(); one
*               entry per section the current user is authorised to administer.
*   entries   — array of currently stored values:
*               [{id: *, tipo: string, value: Array<number>}, …]
*
* Main export: view_default_edit_filter_records (constructor placeholder); all
* logic lives on the static .render() method and the module-private helpers.
*
* Invoked by: render_edit_component_filter_records.prototype.edit
*/
export const view_default_edit_filter_records = function() {

	return true
}//end view_default_edit_filter_records



/**
* RENDER
* Build and return the full component DOM node for the default-edit view.
*
* When options.render_level is 'content', only the inner content_data node is
* returned (no outer wrapper, no buttons).  This is the contract used by
* component_common.prototype.refresh to replace the content area in place
* without destroying the outer wrapper's event listeners.
*
* The wrapper is a standard edit-mode container produced by
* ui.component.build_wrapper_edit; it carries a content_data pointer so callers
* can reach individual row nodes via self.node.content_data[i].
*
* When the component is rendered in 'line' view the label is suppressed so that
* the component fits inside compact list rows (e.g. inline portal grids).
*
* @param {Object} self - The component_filter_records instance.
*   Expected: self.permissions {number}, self.data {Object}, self.view {string},
*   self.show_interface {Object}, self.context {Object}.
* @param {Object} options - Render configuration.
*   options.render_level {string} 'full' (default) | 'content' — controls
*   whether to build the outer wrapper+buttons or only the content area.
* @returns {Promise<HTMLElement>} wrapper (render_level='full') or content_data
*   (render_level='content').
*/
view_default_edit_filter_records.render = async function(self, options) {

	// options
		const render_level = options.render_level || 'full'

	// content_data
		const content_data = get_content_data(self)
		if (render_level==='content') {
			return content_data
		}

	// buttons
		const buttons = (self.permissions > 1)
			? get_buttons(self)
			: null


	// ui build_edit returns component wrapper
		const wrapper_options = {
			content_data	: content_data,
			buttons			: buttons
		}
		if (self.view==='line') {
			wrapper_options.label = null // remove label
		}
		const wrapper = ui.component.build_wrapper_edit(self, wrapper_options)
		// set pointers
		wrapper.content_data = content_data

	// help_link. Top-right of the wrapper: opens the component documentation
	// (how the section list is built)
		const help_label = get_label.documentation || 'Documentation'
		const help_link = ui.create_dom_element({
			element_type	: 'a',
			class_name		: 'help_link',
			title			: help_label,
			parent			: wrapper
		})
		help_link.href		= 'https://dedalo.dev/docs/v7/core/components/component_filter_records/'
		help_link.target	= '_blank'
		help_link.rel		= 'noopener noreferrer'
		help_link.setAttribute('aria-label', help_label)
		help_link.addEventListener('click', (e) => e.stopPropagation())


	return wrapper
}//end render



/**
* GET_CONTENT_DATA
* Build the content_data container, including the column header row and all
* data rows for this component instance.
*
* The output structure is a standard ui.component.build_content_data div that
* contains:
*   1. A header_row with three column labels: tipo / section / value.
*   2. One content-value row per datalist entry (edit path, permissions > 1),
*      or one row per matching entry that already has a stored value (read path,
*      permissions === 1).
*
* Permissions routing:
*   permissions === 1 — Iterates self.data.entries.  For each entry whose tipo
*     is present in the datalist, a static read-only row is appended.  If no
*     entries exist at all a single empty read row is produced so the component
*     is never visually blank.
*   permissions > 1  — Iterates self.data.datalist.  Every authorised section
*     gets an interactive row with a text input whose current value (if any) is
*     pre-populated from self.data.entries.
*
* Each produced row node is stored as a numeric index property on content_data
* (content_data[i]) in addition to being appended as a DOM child, giving callers
* O(1) access to individual rows.
*
* @param {Object} self - The component_filter_records instance.
*   Expected: self.data {Object} with .datalist {Array} and .entries {Array},
*   self.permissions {number}.
* @returns {HTMLElement} content_data - The populated content container div.
*/
const get_content_data = function(self) {

	// short vars
		const data				= self.data || {}
		const datalist			= data.datalist || []
		const datalist_length	= datalist.length
		const entries			= data.entries || []
		const permissions		= self.permissions

	// content_data
		const content_data = ui.component.build_content_data(self)

	// sticky_head: filter + column header, stuck together on top of the scrolling list
		const sticky_head = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'sticky_head',
			parent			: content_data
		})

	// filter_bar. Input hides rows whose tipo/section label do not contain the text
		const filter_bar = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'filter_bar',
			parent			: sticky_head
		})
		const filter_input = ui.create_dom_element({
			element_type	: 'input',
			class_name		: 'filter_input',
			placeholder		: get_label.filter || 'Filter by tipo or section',
			parent			: filter_bar
		})
		filter_input.type = 'search'
		filter_input.setAttribute('aria-label', get_label.filter || 'Filter by tipo or section')
		const filter_count = ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'filter_count',
			parent			: filter_bar
		})
		filter_count.setAttribute('aria-live', 'polite')
		const apply_filter = () => {
			const q		= filter_input.value.trim().toLowerCase()
			const rows	= content_data.querySelectorAll(':scope>.content_value')
			let shown	= 0
			for (const row of rows) {
				row.hidden = q.length>0 && !(row.dataset.search || '').includes(q)
				if (!row.hidden) shown++
			}
			filter_count.textContent = q.length>0 ? `${shown} / ${rows.length}` : String(rows.length)
			no_results.hidden = shown>0
		}
		filter_input.addEventListener('input', apply_filter)

	// header_row
		const header_row = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'header_row',
			parent			: sticky_head
		})
		// sort. Reorders the row nodes in place (content_data[i] pointers keep datalist order)
		const sort = { key : 'tipo', dir : 1 }
		const apply_sort = () => {
			const rows = [...content_data.querySelectorAll(':scope>.content_value')]
			// value is read live (the input changes after render); empty values always sink last
			const get_key = (row) => sort.key==='value'
				? (row.querySelector('.input_value')?.value ?? row.children[2]?.textContent ?? '').trim()
				: (row.dataset[sort.key] || '')
			rows.sort((a, b) => {
				const ka = get_key(a), kb = get_key(b)
				if (!ka !== !kb) return ka ? -1 : 1
				return sort.dir * ka.localeCompare(kb, undefined, { numeric: true, sensitivity: 'base' })
			})
			content_data.append(...rows)
			for (const node of header_row.querySelectorAll('.sortable')) {
				node.dataset.sort = node.dataset.key===sort.key
					? (sort.dir===1 ? 'asc' : 'desc')
					: ''
			}
		}
		const create_sorter = (key, class_name, text) => {
			const node = ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'label_item sortable ' + class_name,
				inner_html		: text,
				parent			: header_row
			})
			node.dataset.key = key
			node.addEventListener('click', () => {
				sort.dir = (sort.key===key) ? -sort.dir : 1
				sort.key = key
				apply_sort()
			})
		}
		// header_tipo
		create_sorter('tipo', 'tipo', 'tipo')
		// header_label
		create_sorter('label', 'label', get_label.section || 'Section')

	// no_results. Shown by apply_filter when the filter matches nothing
		const no_results = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'no_results',
			inner_html		: get_label.no_records || 'No records found',
			parent			: sticky_head
		})
		no_results.hidden = true
		// header_value
		create_sorter('value', 'value', get_label.value || 'Value')

	// body rows
	// permissions switch
		if (permissions===1) {

			// filtered_datalist. Datalist values that exists into component value
				for (let i = 0; i < entries.length; i++) {
					const data_value = entries[i]
					const current_datalist_item	= datalist.find(el =>
						el.tipo===data_value.tipo
					)
					if(current_datalist_item){
						const current_value = {
							label	: current_datalist_item.label,
							tipo	: data_value.tipo,
							value	: data_value.value
						}
						// build options
						const content_value_node = get_content_value_read(0, current_value, self)
						content_data.appendChild(content_value_node)
						// set pointers
						content_data[i] = content_value_node
					}
				}

			// fill empty value cases with one empty content_value node
				if(!content_data[0]) {
					const current_value = {}
					const content_value_node = get_content_value_read(0, current_value, self)
					content_data.appendChild(content_value_node)
					// set pointers
					content_data[0] = content_value_node
				}

		}else{

			// build options
				for (let i = 0; i < datalist_length; i++) {
					const input_element_node = get_content_value(i, datalist[i], self)
					content_data.appendChild(input_element_node)
					// set pointers
					content_data[i] = input_element_node
				}
		}

	// initial order: tipo asc; initial count
		apply_sort()
		apply_filter()


	// realocate rendered DOM items
			// const nodes_lenght = inputs_container.childNodes.length
			// // iterate in reverse order to avoid problems on move nodes
			// for (let i = nodes_lenght - 1; i >= 0; i--) {

			// 	const item = inputs_container.childNodes[i]
			// 	if (item.dataset.parent) {
			// 		//const parent_id = datalist_item.parent.section_tipo +'_'+ datalist_item.parent.section_id
			// 		const current_parent = inputs_container.querySelector("[data-id='"+item.dataset.parent+"']")
			// 		if (current_parent) {
			// 			current_parent.appendChild(item)
			// 		}
			// 	}
			// }


	return content_data
}//end get_content_data



/**
* GET_CONTENT_VALUE
* Build a single interactive edit row for one datalist section entry.
*
* Produces a div.content_value with three child columns:
*   1. span.section_tipo — the section's ontology tipo identifier (e.g. 'dd128').
*   2. span — the human-readable label for that section, from the datalist.
*   3. input[type=text].input_value — a free-text field pre-filled with any
*      previously stored comma-separated record IDs for this section.
*
* Two events are wired on the input:
*   'change' — delegates to self.change_handler, which validates the raw string,
*     normalises it to an array of positive integers, and persists immediately.
*     The input value is then updated with the normalised string (e.g. leading
*     zeros and duplicates removed).
*   'keyup'  — pressing Enter synthesises a 'change' event (triggering immediate
*     save) and also calls set_before_unload(true) on every other keystroke so
*     the browser warns the user if they try to navigate away with unsaved changes.
*
* Note: only the 'change' event triggers a server save; 'keyup' merely guards
* against accidental data loss.
*
* @param {number} i - Zero-based index into the datalist array (used by the caller
*   to set the content_data[i] pointer; not embedded in the DOM here).
* @param {Object} datalist_item - One entry from self.data.datalist.
*   Shape: {tipo: string, label: string, permissions: number}
* @param {Object} self - The component_filter_records instance.
*   Expected: self.data.entries {Array}, self.change_handler {Function}.
* @returns {HTMLElement} content_value - The assembled row div.
*/
const get_content_value = (i, datalist_item, self) => {

	// short vars
		const data	= self.data || {}
		const entries	= data.entries || []

	// content_value
		const content_value = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'content_value'
		})

	// tipo
		const tipo	= datalist_item.tipo
		ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'body_item section_tipo',
			inner_html		: render_value(tipo, 'text'),
			parent			: content_value
		})

	// label
		const label	= datalist_item.label
		const label_node = ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'body_item',
			inner_html		: render_value(label, self.context.render_class),
			parent			: content_value
		})
		set_row_keys(content_value, tipo, label_node.textContent)

	// input field
		const item					= entries.find(item => item.tipo===tipo)
		// Join the stored value array to a comma-separated string for display;
		// if this section has no stored entry yet, the input starts empty.
		const input_value_string	= typeof item!=="undefined" ? item.value.join(',') : ''
		const input_node			= ui.create_dom_element({
			element_type	: 'input',
			type			: 'text',
			class_name		: 'body_item input_value',
			value			: input_value_string,
			placeholder		: 'Comma separated id like 1,2,3',
			parent			: content_value
		})
		// change event
			const input_change_handler = function() {
				self.change_handler({
					value		: this.value,
					tipo		: datalist_item.tipo,
					input_node	: input_node
				})
			}
			input_node.addEventListener('change', input_change_handler)

		// keyup event
			const input_keyup_handler = function(e) {
				// Enter key force to dispatchEvent change
					if (e.key==='Enter') {
						input_node.dispatchEvent(new Event('change'))
						return false
					}

				// set as changed to prevent accidentally loose unsaved data
				// Note that because this component have a validator, only change event will be used to save values
					set_before_unload(true)
			}
			input_node.addEventListener('keyup', input_keyup_handler)


	return content_value
}//end get_content_value



/**
* GET_CONTENT_VALUE_READ
* Build a single static (non-interactive) read row for one data entry.
*
* Used when self.permissions === 1.  Renders the section tipo, its human-readable
* label, and the stored value as three plain <span> elements with class 'label'.
* No inputs or event listeners are attached.
*
* If the supplied current_value is an empty object (fallback case when no entries
* exist at all), all three spans render with empty inner HTML.
*
* @param {number} i - Zero-based index; used by the caller for content_data[i]
*   pointer assignment only — not embedded in the DOM by this function.
* @param {Object} current_value - The resolved value object for one entry.
*   Shape: {tipo: string, label: string, value: Array<number>|*} or {} when empty.
* @param {Object} self - The component_filter_records instance (unused internally
*   but retained for API symmetry with get_content_value).
* @returns {HTMLElement} content_value - The assembled read-only row div.
*/
const get_content_value_read = (i, current_value, self) => {

	// create content_value
		const content_value = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'content_value read_only'
		})

	// tipo
		ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'label',
			inner_html		: render_value(current_value.tipo, 'text'),
			parent			: content_value
		})

	// label
		const label_node = ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'label',
			inner_html		: render_value(current_value.label, self.context.render_class),
			parent			: content_value
		})
		set_row_keys(content_value, current_value.tipo || '', label_node.textContent)

	// value
		ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'label',
			inner_html		: render_value(current_value.value, self.context.render_class),
			parent			: content_value
		})


	return content_value
}//end get_content_value_read



/**
* SET_ROW_KEYS
* Stamp the sort keys (data-tipo, data-label) and the lowercase filter haystack
* (data-search) read by the header sorters and the filter input.
* @param {HTMLElement} row
* @param {string} tipo
* @param {string} label - plain text
* @returns {void}
*/
const set_row_keys = (row, tipo, label) => {
	row.dataset.tipo	= tipo
	row.dataset.label	= label
	row.dataset.search	= (tipo + ' ' + label).toLowerCase()
}//end set_row_keys



/**
* GET_BUTTONS
* Build and return the component's buttons container for edit mode.
*
* Conditionally appends:
*   - Tool buttons (via ui.add_tools) when show_interface.tools is true.
*     These are dynamically resolved from self.tools[] and rendered as
*     clickable tool-launcher icons.
*   - A full-screen toggle button when show_interface.button_fullscreen is true.
*     Clicking it calls ui.enter_fullscreen on the component's root node (self.node).
*
* The container is always built (via ui.component.build_buttons_container) and
* returned even if no sub-elements are added, allowing the wrapper to include
* a consistently structured buttons area.
*
* Only called when self.permissions > 1 — read-only users receive no buttons.
*
* @param {Object} self - The component_filter_records instance.
*   Expected: self.show_interface {Object} with optional keys .tools {boolean} and
*   .button_fullscreen {boolean}; self.node {HTMLElement} (for fullscreen target).
* @returns {HTMLElement} buttons_container - The assembled buttons wrapper div.
*/
const get_buttons = (self) => {

	// short vars
		const show_interface = self.show_interface

	// fragment
		const fragment = new DocumentFragment()

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
			button_fullscreen.addEventListener('click', function(e) {
				e.stopPropagation()
				ui.enter_fullscreen(self.node)
			})
		}

	// buttons container
		const buttons_container = ui.component.build_buttons_container(self)
		buttons_container.appendChild(fragment)


	return buttons_container
}//end get_buttons



// @license-end
