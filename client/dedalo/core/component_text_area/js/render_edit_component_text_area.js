// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/* global get_label, page_globals, SHOW_DEBUG */
/*eslint no-undef: "error"*/



// imports
	import {view_default_edit_text_area} from './view_default_edit_text_area.js'
	import {view_mini_text_area} from './view_mini_text_area.js'
	import {view_line_edit_text_area} from './view_line_edit_text_area.js'
	import {ui} from '../../common/js/ui.js'
	import {schedule_ckeditor_preload} from '../../services/service_ckeditor/js/service_ckeditor.js'



/**
* RENDER_EDIT_COMPONENT_TEXT_AREA
* Edit-mode render dispatcher for component_text_area.
*
* This module provides the constructor used as a prototype mixin on
* component_text_area and two standalone exported helpers that other
* components (component_image, component_geolocation, component_pdf) call
* when they need to present interactive selectors inside the text editor:
*
*   - render_layer_selector  — inline widget listing selectable image/geo layers
*   - render_page_selector   — modal dialog for picking a specific PDF page number
*
* The prototype method `edit` acts as a view router: it reads
* `self.context.view` and delegates rendering to the appropriate view
* module (view_default_edit_text_area, view_mini_text_area, or
* view_line_edit_text_area).
*
* Supported view values:
*   'default'   → full rich-text CKEditor wrapper (also used for 'html_text')
*   'mini'      → compact single-value display, used in autocomplete / datalists
*   'line'      → single-line editor, used for inline list editing
*   'print'     → same layout as 'default' but forced to read-only (permissions=1)
*/
export const render_edit_component_text_area = function() {

	return true
}//end render_edit_component_text_area



/**
* EDIT
* Route the edit-mode render to the correct view module based on context.view.
*
* Reads `self.context.view` (set from the ontology property definition) and
* delegates to the matching view renderer. The 'print' case intentionally
* falls through to 'default' after forcing read-only permissions so that the
* same layout is used (label included) but no editing controls are shown.
*
* Side effect: in the 'print' case, `self.permissions` is mutated to 1
* before the render call so downstream code treats the component as read-only.
* @param {Object} options - render options forwarded to the view module
* @returns {Promise<HTMLElement>} wrapper node returned by the chosen view renderer
*/
render_edit_component_text_area.prototype.edit = async function(options) {

	const self = this

	// view
		const view = self.context.view || 'default'

	// warm the shared CKEditor engine (bundle + langs) off the click path.
	// Instance creation stays on demand — see schedule_ckeditor_preload().
	// 'mini' and 'print' never build an editor.
		if (self.permissions > 1 && view !== 'mini' && view !== 'print') {
			schedule_ckeditor_preload()
		}

	switch(view) {

		case 'mini':
			return view_mini_text_area.render(self, options)

		case 'line':
			return view_line_edit_text_area.render(self, options)

		case 'print':
			// view print use the same view as default, except it will use read only to render content_value
			// as different view as default it will set in the class of the wrapper
			// sample: <div class="wrapper_component component_text_area oh23 oh1_oh23 edit view_default disabled_component active inside">...</div>
			// take account that to change the css when the component will render in print context
			// for print we need to use read of the context_value and it's necessary force permissions to use read only element render
			self.permissions = 1

		case 'html_text':
		case 'default':
		default:
			return view_default_edit_text_area.render(self, options)
	}
}//end edit



/**
* RENDER_LAYER_SELECTOR
* Build an inline layer-selection widget and attach it to the component node.
*
* Called by component_image and component_geolocation when the editor user
* needs to choose which visual layer a 'draw' or 'geo' tag should reference.
* The widget lists all available layers for the current media tag (received in
* data_tag.layers) and, on selection, mutates data_tag in place and calls the
* provided callback before removing itself.
*
* Singleton guard: if `self.node.layer_selector` is already set (a previous
* selector is still open), the function returns null immediately to prevent
* duplicate widgets. The pointer is cleared when the widget closes.
*
* The returned node is NOT automatically inserted into the DOM; the caller is
* responsible for appending it (typically to `self.node`).
*
* data_tag shape:
* {
*   type     : {string}  tag type, e.g. 'geo' or 'draw'
*   tag_id   : {string}  identifier of the tag being created/edited
*   label    : {string}  display label (mutated on layer selection)
*   data     : {Array}   data payload (mutated on layer selection)
*   layers   : {Array}   array of layer descriptors: [{layer_id, user_layer_name}, …]
* }
*
* @param {Object} options
* @param {Object} options.self        - component_text_area instance (provides node reference)
* @param {Object} options.text_editor - active service_ckeditor instance
* @param {Function} options.callback  - invoked with {data_tag, text_editor} after layer selection
* @param {Object} options.data_tag    - tag descriptor object (mutated in place on selection)
* @returns {HTMLElement|null} the layer_selector node, or null if one is already open
*/
export const render_layer_selector = function(options){

	// options
		const self			= options.self
		const text_editor	= options.text_editor
		const callback		= options.callback
		const data_tag		= options.data_tag

	// prevent open already created selector
		if (self.node.layer_selector) {
			return null
		}

	const fragment = new DocumentFragment()

	// add_layer button
		// const add_layer = ui.create_dom_element({
		// 	element_type	: 'span',
		// 	class_name		: 'button add',
		// 	title			: get_label.new || 'New',
		// 	parent			: fragment
		// })
		// add_layer.addEventListener('click', (e) =>{
		// 	e.preventDefault()
		// 	e.stopPropagation()
		// 	data_tag.data = [data_tag.last_layer_id]
		// 	const tag 	= self.build_view_tag_obj(data_tag, tag_id)
		// 	text_editor.set_content(tag)
		// 	layer_selector.remove()
		// })

	// layer_selector_header
		const layer_selector_header = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'layer_selector_header',
			parent			: fragment
		})

		// layer_icon
		ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'layer_icon',
			text_node		: data_tag.type + ': ' + (get_label.layer_selector || 'Layer selector'),
			parent			: layer_selector_header,
		})

		// close button
		const close = ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'button close',
			parent			: layer_selector_header
		})
		const click_handler = (e) => {
			e.preventDefault()
			e.stopPropagation()
			// remove pointer
			self.node.layer_selector = null
			// remove node
			layer_selector.remove()
		}
		close.addEventListener('click', click_handler)

	// inputs container
		const layer_ul = ui.create_dom_element({
			element_type	: 'ul',
			class_name		: 'layer_ul',
			parent			: fragment
		})
		// iterate all layers
		const ar_layers = data_tag.layers
		for (let i = 0; i < ar_layers.length; i++) {

			const layer = ar_layers[i]

			const layer_li = ui.create_dom_element({
				element_type	: 'li',
				parent			: layer_ul
			})
			// Each list item gets its own click_handler in closure over 'layer'.
			// Note: this shadows the outer click_handler declared above for the
			// close button — both are used in different contexts, no conflict.
			const click_handler = (e) => {
				e.preventDefault()
				e.stopPropagation()

				// Mutate data_tag in place: the label encodes "tag_id:layer_id"
				// so parent components can reconstruct the locator from the tag.
				data_tag.label = `${data_tag.tag_id}:${layer.layer_id}`
				data_tag.data = [layer.layer_id]

				callback({
					data_tag	: data_tag,
					text_editor	: text_editor
				})

				// remove pointer
				self.node.layer_selector = null
				// remove node
				layer_selector.remove()
			}
			layer_li.addEventListener('click', click_handler)

			// layer_id
				ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'layer_id',
					parent			: layer_li,
					text_node		: layer.layer_id
				})

			// user_layer_name
				ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'user_layer_name',
					parent			: layer_li,
					text_node		: layer.user_layer_name
				})

				// const layer_color_box = ui.create_dom_element({
				// 	element_type	: 'div',
				// 	class_name 		: 'layer_color_box',
				// 	parent 			: layer_li,
				// })
				// const layer_color = ui.create_dom_element({
				// 	element_type	: 'div',
				// 	class_name 		: 'layer_color',
				// 	parent 			: layer_color_box,
				// })
				// layer_color.style.backgroundColor = typeof layer.layer_color !== 'undefined'
				// 	? layer.layer_color
				// 	: 'black'
		}//end for (let i = 0; i < ar_layers.length; i++)

	const layer_selector = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'layer_selector'
	})
	layer_selector.appendChild(fragment)

	// fix pointer
	self.node.layer_selector = layer_selector


	return layer_selector
}//end render_layer_selector



/**
* RENDER_PAGE_SELECTOR
* Open a modal dialog that lets the user type a PDF page number to embed as a tag.
*
* Used by component_pdf (and potentially other document components) when the
* user triggers an F2 keypress that resolves to a 'page' tag type.  The modal
* validates the entered value against the document's page range (page_in to
* page_out) before calling build_view_tag_obj and inserting the tag into the
* editor.
*
* The function calls text_editor.save() before opening the modal to flush any
* pending editor state, preventing conflicts between the modal component tree
* and the open editor.
*
* data_tag shape expected by this function:
* {
*   total_pages : {number}  total page count in the document
*   offset      : {number}  first page number (1-based document start page)
*   type        : {string}  should be 'page'
*   label       : {string}  (mutated) the user-entered page number as display label
*   data        : {Array}   (mutated) single-element array with the relative page index
* }
*
* (!) The 'ok' handler contains `modal.renove()` (line with typo — missing 'a')
* at the null-value guard path, which is never reached because body_input.value
* is always a string. The real removal is done by `modal.remove()` further down.
*
* @param {Object}  self        - component_text_area instance (provides build_view_tag_obj)
* @param {Object}  data_tag    - tag descriptor with page range metadata (mutated in place)
* @param {string}  tag_id      - identifier for the tag being created
* @param {Object}  text_editor - active service_ckeditor instance
* @returns {boolean} always returns true
*/
export const render_page_selector = function(self, data_tag, tag_id, text_editor) {

	// short vars
		const total_pages	= data_tag.total_pages
		const offset		= data_tag.offset
		const page_in		= offset
		const page_out		= (offset -1) + total_pages

	// header
		const header = ui.create_dom_element({
			element_type	: 'div',
			text_node		: get_label.select_page_of_the_doc
		})

	// body
		const body = ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'body'
		})

		// Interpolate page_in/page_out/total_pages into the localised label
		// template (get_label.choose_page_between) by EXPLICIT placeholder
		// replacement — never eval(). eval of a label breaks under the strict
		// Content-Security-Policy (no 'unsafe-eval') and would execute arbitrary
		// code if a label ever became user-editable; replaceAll also degrades
		// gracefully on a mistranslated placeholder instead of throwing.
		const label = String(get_label.choose_page_between ?? '')
			.replaceAll('${page_in}', page_in)
			.replaceAll('${page_out}', page_out)
			.replaceAll('${total_pages}', total_pages)
		const body_title = ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'body_title',
			text_node		: label,
			parent			: body
		})

		const body_input = ui.create_dom_element({
			element_type	: 'input',
			type			: 'text',
			class_name		: 'body_title',
			parent			: body
		})

		// error_input: inline error message shown when the entered value is out of range
		const error_input = ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'body_title',
			text_node		: '',
			parent			: body
		})


	// footer
		const footer = ui.create_dom_element({
			element_type	: 'span'
		})

		const user_option_cancel = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'user_option ',
			inner_html		: get_label.cancel || 'Cancel',
			parent			: footer
		})

		const user_option_ok = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'user_option',
			inner_html		: get_label.insert_tag || 'Insert tag',
			parent			: footer
		})

	// save editor changes to prevent conflicts with modal components changes
		text_editor.save()

	// modal
		const modal = ui.attach_to_modal({
			header	: header,
			body	: body,
			footer	: footer,
			size	: 'normal'
		})

	user_option_ok.addEventListener('click', (e) =>{
		e.preventDefault()
		e.stopPropagation()
		const user_value = body_input.value
		if(user_value === null) {
			modal.renove()
		}
		if(user_value > page_out || user_value < page_in){
			error_input.textContent = get_label.value_out_of_range || 'Value out of range'
			return
		}
		// Convert the absolute user-entered page number to a relative page index
		// by subtracting (offset - 1).  The editor stores relative indices so
		// the PDF viewer can navigate correctly regardless of document start page.
		const data		= body_input.value - (offset -1)
		data_tag.label	= body_input.value
		data_tag.data	= [data]
		const tag		= self.build_view_tag_obj(data_tag, tag_id)
		text_editor.set_content(tag)
		modal.remove()
	})

	user_option_cancel.addEventListener('click', (e) =>{
		e.stopPropagation()
		modal.remove()
	})


	return true
}//end render_page_selector



// @license-end
