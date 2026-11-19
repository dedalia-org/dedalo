// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global page_globals, FileReader, Image, document */
/*eslint no-undef: "error"*/



// imports
	import { when_in_viewport } from '../../../core/common/js/events.js'
	import {ui} from '../../../core/common/js/ui.js'
	import {request_failed, response_data} from '../../../core/common/js/api_error.js'
	import {error_text} from '../../../core/common/js/render_api_error.js'



// screenshot capture tuning. The wire caps the whole report at 256 KiB; keep a
// single screenshot comfortably under that (base64 chars ≈ bytes).
	const SCREENSHOT_BUDGET_CHARS	= 150 * 1024
	const SCREENSHOT_MAX_DIM		= 1600



/**
* READ_FILE_AS_IMAGE
* Load a user-chosen image File into a decoded HTMLImageElement (via a data URL,
* so nothing is fetched over the network).
* @param {File} file
* @returns {Promise<HTMLImageElement>}
*/
const read_file_as_image = function(file) {

	return new Promise((resolve, reject) => {
		const reader = new FileReader()
		reader.onerror = () => reject(new Error('read_failed'))
		reader.onload = () => {
			const img = new Image()
			img.onerror	= () => reject(new Error('decode_failed'))
			img.onload	= () => resolve(img)
			img.src		= reader.result
		}
		reader.readAsDataURL(file)
	})
}//end read_file_as_image



/**
* COMPRESS_IMAGE
* Re-encode a decoded image to a compact image/jpeg data URL that fits the byte
* budget: downscale to SCREENSHOT_MAX_DIM, then step quality down; if the lowest
* quality still overruns, shrink further and retry. Re-encoding also strips any
* original metadata (EXIF) for free. Returns the highest-quality URL that fits,
* or the smallest achievable (the server re-checks the hard cap regardless).
* @param {HTMLImageElement} img
* @returns {string} image/jpeg data URL
*/
const compress_image = function(img) {

	const src_w		= img.naturalWidth || img.width
	const src_h		= img.naturalHeight || img.height
	const qualities	= [0.85, 0.7, 0.55, 0.4, 0.3]
	let scale		= Math.min(1, SCREENSHOT_MAX_DIM / Math.max(src_w, src_h))
	let best		= null

	for (let attempt = 0; attempt < 4; attempt++) {
		const w = Math.max(1, Math.round(src_w * scale))
		const h = Math.max(1, Math.round(src_h * scale))
		const canvas	= document.createElement('canvas')
		canvas.width	= w
		canvas.height	= h
		const ctx = canvas.getContext('2d')
		// white matte so transparent PNGs don't flatten to black under JPEG
		ctx.fillStyle = '#ffffff'
		ctx.fillRect(0, 0, w, h)
		ctx.drawImage(img, 0, 0, w, h)
		for (const q of qualities) {
			const url = canvas.toDataURL('image/jpeg', q)
			if (!best || url.length < best.length) {
				best = url
			}
			if (url.length <= SCREENSHOT_BUDGET_CHARS) {
				return url
			}
		}
		scale = scale * 0.75 // still too big at lowest quality: shrink, retry
	}

	return best
}//end compress_image



/**
* RENDER_TOOL_ERROR_REPORT
* Client-side render module for tool_error_report.
*
* Layout (top to bottom):
*  1. intro note — what will be sent and where (the disclosure/consent line:
*     the report is stored here and emailed, on explicit send only);
*  2. context summary — section locator, page path, captured-errors count,
*     with the captured errors expandable inside a <details> block;
*  3. description <textarea> (required);
*  4. send button + response line.
*
* SECURITY (DS-1): every dynamic string in this UI renders through
* `text_content` / `textContent` — NEVER `inner_html` — so a malicious error
* message captured from the page can not become markup here or anywhere the
* payload is later displayed.
*
* `render_tool_error_report` is a constructor-as-namespace; the single
* prototype method `edit` is mixed into tool_error_report by wire_tool().
*
* @module render_tool_error_report
*/
export const render_tool_error_report = function() {

	return true
}//end render_tool_error_report



/**
* EDIT
* Render tool DOM nodes.
* @param {Object} options
* @param {string} [options.render_level='full']
* @returns {Promise<HTMLElement>}
*/
render_tool_error_report.prototype.edit = async function(options) {

	const self = this

	// options
		const render_level = options.render_level || 'full'

	// content_data
		const content_data = get_content_data(self)
		if (render_level==='content') {
			return content_data
		}

	// wrapper. ui build_edit returns a standard built tool wrapper
		const wrapper = ui.tool.build_wrapper_edit(self, {
			content_data : content_data
		})


	return wrapper
}//end edit



/**
* GET_CONTENT_DATA
* Build the report form. All values render via text_content (DS-1).
* @param {Object} self - the tool_error_report instance
* @returns {HTMLElement} content_data node
*/
const get_content_data = function(self) {

	const fragment = new DocumentFragment()

	// non-admins never get the form (the server refuses regardless).
		if (page_globals.is_global_admin!==true) {
			ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'error_report_note',
				text_content	: self.get_tool_label('admin_only') || 'This tool is available to administrators only.',
				parent			: fragment
			})
			const content_data_denied = ui.tool.build_content_data(self)
			content_data_denied.appendChild(fragment)
			return content_data_denied
		}

	// collected context (same collector the submit uses — what you see is
	// what is sent).
		const collected = self.collect_report_data()

	// 1. intro / disclosure
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'error_report_intro',
			text_content	: self.get_tool_label('intro') || 'Describe the problem. The page context and the captured JavaScript errors shown below will be saved on this installation and, if an error-report address is configured, emailed to it when you press send.',
			parent			: fragment
		})

	// 2. context summary
		const summary_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'error_report_summary',
			parent			: fragment
		})
		const label_none	= self.get_tool_label('value_none') || '(none)'
		const label_unknown	= self.get_tool_label('value_unknown') || '(unknown)'
		const summary_rows = [
			[self.get_tool_label('summary_section') || 'Section', collected.section_tipo
				? collected.section_tipo + (collected.section_id ? ' / ' + collected.section_id : '')
				: label_none],
			[self.get_tool_label('summary_page') || 'Page', collected.page_url || label_unknown],
			[self.get_tool_label('summary_user_id') || 'User id', collected.client_globals.user_id!==null ? String(collected.client_globals.user_id) : label_unknown],
			[self.get_tool_label('summary_js_errors') || 'Captured JS errors', String(collected.js_errors.length)]
		]
		for (const [row_label, row_value] of summary_rows) {
			const row = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'error_report_summary_row',
				parent			: summary_container
			})
			ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'error_report_summary_label',
				text_content	: row_label + ': ',
				parent			: row
			})
			ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'error_report_summary_value',
				text_content	: row_value,
				parent			: row
			})
		}

	// 2b. captured errors, expandable. <pre> + textContent only (DS-1).
		if (collected.js_errors.length > 0) {
			const details = ui.create_dom_element({
				element_type	: 'details',
				class_name		: 'error_report_errors',
				parent			: fragment
			})
			ui.create_dom_element({
				element_type	: 'summary',
				text_content	: self.get_tool_label('errors_details', collected.js_errors.length) || ('Captured JavaScript errors (' + collected.js_errors.length + ')'),
				parent			: details
			})
			for (const item of collected.js_errors) {
				const line = [
					'[' + (item.type || 'error') + ']' + (item.count > 1 ? ' ×' + item.count : ''),
					item.msg || (self.get_tool_label('no_message') || '(no message)'),
					item.source ? item.source + (item.line!==null ? ':' + item.line : '') : null,
					item.stack
				].filter(el => el!==null).join('\n')
				ui.create_dom_element({
					element_type	: 'pre',
					class_name		: 'error_report_error_item',
					text_content	: line,
					parent			: details
				})
			}
		}

	// 3. description
		const description_label = self.get_tool_label('description') || 'Description'
		ui.create_dom_element({
			element_type	: 'label',
			class_name		: 'error_report_description_label',
			text_content	: description_label,
			parent			: fragment
		})
		const description_input = ui.create_dom_element({
			element_type	: 'textarea',
			class_name		: 'error_report_description',
			parent			: fragment
		})
		description_input.setAttribute('maxlength', '8000')
		description_input.setAttribute('rows', '6')
		description_input.setAttribute('placeholder', self.get_tool_label('description_placeholder') || 'What were you doing, and what went wrong?')
		when_in_viewport(description_input, () => {
			setTimeout(() => {
				description_input.focus()
			}, 100)
		})

	// 3b. optional screenshot. Deliberately non-technical: one big area you can
	// click, drag onto, or paste into. The image is compressed in the browser
	// and only travels with the report when you press send.
		ui.create_dom_element({
			element_type	: 'label',
			class_name		: 'error_report_screenshot_label',
			text_content	: self.get_tool_label('screenshot_label') || 'Add a screenshot (optional)',
			parent			: fragment
		})
		const screenshot_section = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'error_report_screenshot',
			parent			: fragment
		})
		// hidden native file picker
		const file_input = ui.create_dom_element({
			element_type	: 'input',
			class_name		: 'error_report_file_input',
			parent			: screenshot_section
		})
		file_input.setAttribute('type', 'file')
		file_input.setAttribute('accept', 'image/png,image/jpeg,image/webp')
		file_input.style.display = 'none'
		// the big friendly drop/click/paste zone
		const dropzone = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'error_report_dropzone',
			parent			: screenshot_section
		})
		dropzone.setAttribute('tabindex', '0')
		dropzone.setAttribute('role', 'button')
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'error_report_dropzone_icon',
			text_content	: '🖼',
			parent			: dropzone
		})
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'error_report_dropzone_hint',
			text_content	: self.get_tool_label('screenshot_hint') || 'Click to choose an image, drag one here, or paste a copied screenshot.',
			parent			: dropzone
		})
		// preview (hidden until an image is attached)
		const preview = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'error_report_screenshot_preview',
			parent			: screenshot_section
		})
		preview.style.display = 'none'
		const preview_img = ui.create_dom_element({
			element_type	: 'img',
			class_name		: 'error_report_screenshot_thumb',
			parent			: preview
		})
		preview_img.setAttribute('alt', self.get_tool_label('screenshot_ready') || 'Screenshot ready to send')
		ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'error_report_screenshot_caption',
			text_content	: self.get_tool_label('screenshot_ready') || 'Screenshot ready to send',
			parent			: preview
		})
		const remove_button = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'error_report_screenshot_remove',
			text_content	: self.get_tool_label('screenshot_remove') || 'Remove',
			parent			: preview
		})
		remove_button.setAttribute('type', 'button')
		// error line for this control
		const screenshot_error = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'error_report_screenshot_error',
			parent			: screenshot_section
		})
		screenshot_error.style.display = 'none'

		const set_screenshot_error = function(message) {
			screenshot_error.textContent		= message || ''
			screenshot_error.style.display		= message ? 'block' : 'none'
		}
		const show_screenshot = function(data_url) {
			self.screenshot				= data_url
			preview_img.src					= data_url
			preview.style.display			= 'flex'
			dropzone.style.display			= 'none'
			set_screenshot_error('')
		}
		const clear_screenshot = function() {
			self.screenshot					= null
			preview_img.removeAttribute('src')
			preview.style.display			= 'none'
			dropzone.style.display			= ''
			file_input.value				= ''
			set_screenshot_error('')
		}
		const handle_file = async function(file) {
			if (!file) {
				return
			}
			if (typeof file.type!=='string' || file.type.indexOf('image/')!==0) {
				set_screenshot_error(self.get_tool_label('screenshot_error_type') || 'That file is not an image. Please choose a PNG or JPG.')
				return
			}
			try {
				const img		= await read_file_as_image(file)
				const data_url	= compress_image(img)
				show_screenshot(data_url)
			} catch (error) {
				console.error(error)
				set_screenshot_error(self.get_tool_label('screenshot_error_read') || 'The image could not be read. Please try another file.')
			}
		}
		const on_paste = function(event) {
			// DataTransferItemList is array-like but not reliably for..of-iterable
			// across browsers — index it.
			const items = event.clipboardData && event.clipboardData.items
			if (!items) {
				return
			}
			for (let i = 0; i < items.length; i++) {
				const item = items[i]
				if (item && item.kind==='file' && typeof item.type==='string' && item.type.indexOf('image/')===0) {
					const file = item.getAsFile()
					if (file) {
						// a pasted screenshot is an image, not text: keep it out
						// of the description textarea.
						event.preventDefault()
						handle_file(file)
						return
					}
				}
			}
		}

		// wire the interactions — click, keyboard, drag-drop, paste
		dropzone.addEventListener('click', () => file_input.click())
		dropzone.addEventListener('keydown', (event) => {
			if (event.key==='Enter' || event.key===' ') {
				event.preventDefault()
				file_input.click()
			}
		})
		file_input.addEventListener('change', () => handle_file(file_input.files && file_input.files[0]))
		dropzone.addEventListener('dragover', (event) => {
			event.preventDefault()
			dropzone.classList.add('dragover')
		})
		dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'))
		dropzone.addEventListener('drop', (event) => {
			event.preventDefault()
			dropzone.classList.remove('dragover')
			const dt = event.dataTransfer
			handle_file(dt && dt.files && dt.files[0])
		})
		remove_button.addEventListener('click', clear_screenshot)
		// paste works while typing the description (the auto-focused field) or
		// while the drop zone is focused — no need to hunt for the right spot.
		description_input.addEventListener('paste', on_paste)
		dropzone.addEventListener('paste', on_paste)

	// 4. send + response line
		const footer = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'error_report_footer',
			parent			: fragment
		})
		const send_button = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'error_report_send light',
			text_content	: self.get_tool_label('send_report') || 'Send report',
			parent			: footer
		})
		const response_node = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'error_report_response',
			parent			: footer
		})

		send_button.addEventListener('click', async function() {
			const description = description_input.value.trim()
			if (description.length===0) {
				response_node.classList.add('error')
				response_node.textContent = self.get_tool_label('error_empty_description') || 'Please describe the problem before sending.'
				return
			}
			send_button.disabled			= true
			response_node.classList.remove('error','success')
			response_node.textContent		= self.get_tool_label('sending') || 'Sending…'
			try {
				// envelope v2: the payload is `{delivered, report_id, ref, mailed}` and a
				// refusal carries the coded, translated error — no prose on success.
				// delivered + !mailed = stored here, not emailed (no address / mail failed).
				const response		= await self.send_report(description)
				const report_data	= (response && !request_failed(response)) ? response_data(response) : null
				if (report_data && report_data.delivered===true) {
					response_node.classList.add('success')
					response_node.textContent = report_data.mailed===true
						? (self.get_tool_label('sent_ok') || 'Report sent.')
						: (self.get_tool_label('sent_stored_only') || 'Report saved on this installation. It was not emailed (no recipient configured, or the mail could not be sent).')
					description_input.value = ''
				} else {
					response_node.classList.add('error')
					response_node.textContent = (response && request_failed(response))
						? error_text(response.error)
						: (self.get_tool_label('send_failed') || 'The report could not be sent.')
					send_button.disabled = false
				}
			} catch (error) {
				console.error(error)
				response_node.classList.add('error')
				response_node.textContent	= self.get_tool_label('send_failed') || 'The report could not be sent.'
				send_button.disabled		= false
			}
		})

	// content_data wrapper
		const content_data = ui.tool.build_content_data(self)
		content_data.appendChild(fragment)


	return content_data
}//end get_content_data



// @license-end
