// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*eslint no-undef: "error"*/



/**
* RENDER_FILE_UPLOAD
* DOM for the "Upload file to map" panel (functionality #11). ONE panel, TWO
* independent sub-flows — v6 has one icon opening two separate modals
* ("Subir archivo" for vectors, hito 12; "Subir imagen" for overlays, hito
* 13), and the row is one row, so it stays one button + one panel (the "one
* button per FUNCTIONALITY, never a panel of unrelated sections" law in
* CLAUDE.local.md is about mixing DIFFERENT audit rows, which this does not).
* Shell built once at attach, same shape as `render_wms_services.js`
* render_search_form: mutations reach `self.upload_vector_file(...)` /
* `self.upload_image_file(...)`, never `vector_upload.js`/`image_upload.js`
* directly.
*
* @module render_file_upload
*/



import {ui} from '../../../core/common/js/ui.js'



const EPSG_IO_URL = 'https://epsg.io/'

// v6's list, verbatim (`special_tools_upload.js:307`): GDAL reads every EPSG
// code, these are just the ones v6 knew without being told
const DEFAULT_PROJECTIONS = [
	'EPSG:4230', 'EPSG:4326', 'EPSG:4258', 'EPSG:3857', 'EPSG:32628', 'EPSG:32629',
	'EPSG:32630', 'EPSG:32631', 'EPSG:25828', 'EPSG:25829', 'EPSG:25830', 'EPSG:25831',
	'EPSG:23028', 'EPSG:23029', 'EPSG:23030', 'EPSG:23031', 'EPSG:4082', 'EPSG:4083'
]



/**
* RENDER_FILE_UPLOAD_PANEL
* The two halves upload differently (functional audit, 2026-09-28). An image
* uploads as soon as it is chosen, as in v6. A vector file has its own Upload
* button, because the projection fields under the picker have to be filled
* in first, and uploading on pick would skip them. Each half has its own
* status line, so an image result never lands in the vector half.
*
* @param {Object} self - tool_uca_maps instance
* @param {HTMLElement} panel - the panel shell (toolbar.js create_toolbar_panel)
* @returns {HTMLElement} panel
*/
export const render_file_upload_panel = function(self, panel) {

	const header = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'uca-maps-panel-header',
		parent			: panel
	})
	ui.create_dom_element({
		element_type	: 'span',
		class_name		: 'uca-maps-panel-title',
		text_content	: self.get_tool_label('upload_control_title') || 'Upload file to map',
		parent			: header
	})

	// v6's "Subir archivo vectorial" modal, in its order: picker first, the
	// manual projection after it, then the button that reads both
	ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'uca-maps-panel-subtitle uca-maps-upload-vector-title',
		text_content	: self.get_tool_label('upload_vector_title') || 'Upload vector file',
		parent			: panel
	})

	const file_input = ui.create_dom_element({element_type: 'input', class_name: 'uca-maps-upload-file', parent: panel})
	file_input.type	= 'file'
	file_input.accept	= '.zip,.geojson,.kml'

	ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'uca-maps-upload-hint',
		text_content	: self.get_tool_label('upload_vector_extensions_hint')
			|| 'Allowed extensions: .zip (shapefile), .geojson and .kml',
		parent			: panel
	})

	const projection = render_projection_fields(self, panel)

	const submit_button = ui.create_dom_element({
		element_type	: 'button',
		class_name		: 'uca-maps-upload-submit',
		text_content	: self.get_tool_label('upload_submit_button') || 'Upload',
		parent			: panel
	})
	submit_button.type = 'button'

	const message = render_upload_message(panel)

	bind_vector_upload(self, file_input, submit_button, message, projection)

	render_image_section(self, panel)

	return panel
}//end render_file_upload_panel



/**
* RENDER_PROJECTION_FIELDS
* v6's manual UTM projection: the "default projections" toggle, its
* explanation, EPSG + zone + band and the epsg.io link that follows the typed
* code (`special_tools_upload.js:188-368`). The field names stay literal, as
* in v6; the server decides what a set of three means (vector_upload.ts).
*
* @param {Object} self - tool_uca_maps instance
* @param {HTMLElement} panel
* @returns {{read: function(): {epsg: string, zone: string, band: string}}}
*/
const render_projection_fields = function(self, panel) {

	const list_button = ui.create_dom_element({
		element_type	: 'button',
		class_name		: 'uca-maps-upload-projections-button',
		text_content	: self.get_tool_label('upload_projections_button') || 'Default projections',
		parent			: panel
	})
	list_button.type = 'button'
	list_button.setAttribute('aria-expanded', 'false')

	ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'uca-maps-upload-hint',
		text_content	: self.get_tool_label('upload_projection_info')
			|| 'Include a UTM (Universal Transverse Mercator) projection if it is not among the default projections (make sure the file you are uploading is projected. For example: urn:ogc:def:crs:EPSG::32619)',
		parent			: panel
	})

	const row = ui.create_dom_element({element_type: 'div', class_name: 'uca-maps-upload-epsg-row', parent: panel})

	const field = function(label, class_name, placeholder) {
		ui.create_dom_element({element_type: 'span', text_content: label + ': ', parent: row})
		const input = ui.create_dom_element({element_type: 'input', class_name, parent: row})
		input.type			= 'text'
		input.placeholder	= placeholder
		input.setAttribute('aria-label', label)
		return input
	}
	const epsg_input = field('EPSG', 'uca-maps-upload-epsg', '32619')
	const zone_input = field('zone', 'uca-maps-upload-zone', '19')
	const band_input = field('band', 'uca-maps-upload-band', 'N')

	const epsg_link = ui.create_dom_element({
		element_type	: 'a',
		class_name		: 'uca-maps-upload-epsg-link',
		text_content	: EPSG_IO_URL,
		parent			: row
	})
	epsg_link.href		= EPSG_IO_URL
	epsg_link.target	= '_blank'
	epsg_link.rel		= 'noopener noreferrer'

	// `input`, not v6's keyup: a pasted code has to move the link too
	epsg_input.addEventListener('input', () => {
		const url = EPSG_IO_URL + encodeURIComponent(epsg_input.value.trim())
		epsg_link.href			= url
		epsg_link.textContent	= url
	})

	const list = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'uca-maps-upload-hint uca-maps-upload-projections-list',
		text_content	: (self.get_tool_label('upload_projections_list_intro')
			|| 'The default projections are listed below:') + ' ' + DEFAULT_PROJECTIONS.join(' '),
		parent			: panel
	})
	list.hidden = true

	// the direction is read off the DOM, never a cached flag (hito 3c law)
	list_button.addEventListener('click', () => {
		list.hidden = !list.hidden
		list_button.setAttribute('aria-expanded', String(!list.hidden))
	})

	return {
		read : () => ({epsg: epsg_input.value, zone: zone_input.value, band: band_input.value})
	}
}//end render_projection_fields



/**
* RENDER_IMAGE_SECTION
* The second sub-flow of the SAME row (hito 13): file input only, no EPSG
* field — a raster carries its own georeferencing or none at all, and GDAL
* reads it server-side (`server/image_overlay.ts`); there is no "the numbers
* are UTM but the file forgot to say so" case to override, unlike a vector.
*
* @param {Object} self - tool_uca_maps instance
* @param {HTMLElement} panel
* @returns {void}
*/
const render_image_section = function(self, panel) {

	ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'uca-maps-panel-subtitle',
		text_content	: self.get_tool_label('upload_image_title') || 'Upload image',
		parent			: panel
	})

	ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'uca-maps-upload-hint',
		text_content	: self.get_tool_label('upload_image_extensions_hint')
			|| 'Allowed extensions: .tif (georeferenced), .jpg, .jpeg and .png',
		parent			: panel
	})

	const file_input = ui.create_dom_element({
		element_type	: 'input',
		class_name		: 'uca-maps-upload-image-file',
		parent			: panel
	})
	file_input.type	= 'file'
	file_input.accept	= '.tif,.tiff,.jpg,.jpeg,.png'

	const message = render_upload_message(panel)

	bind_upload_on_pick(file_input, message, async (file) => {

		// the ingest + derivative build is measurably slower than a vector
		// conversion, so this one says so instead of looking frozen
		show_upload_message(message, self.get_tool_label('upload_image_working') || 'Uploading the image…')

		const result = await self.upload_image_file(file)

		if (!result.ok) {
			return result.error || null
		}
		// three distinct outcomes, never collapsed into two: "no coordinates"
		// and "this server cannot read coordinates" look identical on screen
		// but mean completely different things to whoever has to fix it
		const text = result.georeferenced
			? (self.get_tool_label('upload_image_success_placed') || 'Image placed at its own coordinates.')
			: result.georeference_unavailable
				? (self.get_tool_label('upload_image_no_gdal')
					|| 'GDAL is not installed on this server, so the image could not be placed by its own coordinates: placed over the current view.')
				: (self.get_tool_label('upload_image_success_viewport')
					|| 'The image carries no coordinates: placed over the current view.')
		// the image is on the map, which is the real confirmation: the line
		// only has to be read once, not greet every later reopening of the panel
		return {text, hide_after_ms: UPLOAD_MESSAGE_MS}
	})

}//end render_image_section



/**
* BIND_VECTOR_UPLOAD
* The vector half's Upload button. The chosen file stays in the picker after
* a failure, so correcting EPSG/zone/band and pressing Upload again is the
* whole retry. Only a success empties it. Every line hides itself: a
* success after UPLOAD_MESSAGE_MS, an error after UPLOAD_ERROR_MESSAGE_MS.
*
* @param {Object} self - tool_uca_maps instance
* @param {HTMLInputElement} file_input
* @param {HTMLButtonElement} submit_button
* @param {HTMLElement} message - the vector half's status line
* @param {{read: function(): Object}} projection - render_projection_fields
* @returns {void}
*/
const bind_vector_upload = function(self, file_input, submit_button, message, projection) {

	submit_button.addEventListener('click', async () => {

		if (submit_button.disabled) {
			return
		}

		clear_upload_message(message)
		submit_button.disabled	= true
		file_input.disabled		= true

		const file		= file_input.files && file_input.files[0]
		const result	= await self.upload_vector_file(file, projection.read())

		// the panel may be gone (tool closed mid-upload) — nothing to update
		if (!message.isConnected) {
			return
		}
		submit_button.disabled	= false
		file_input.disabled		= false

		if (!result.ok) {
			if (result.error) {
				show_upload_message(message, result.error, UPLOAD_ERROR_MESSAGE_MS)
			}
			return
		}
		if (result.feature_count===0) {
			show_upload_message(
				message,
				self.get_tool_label('upload_no_features') || 'No objects could be read from this file.',
				UPLOAD_ERROR_MESSAGE_MS
			)
			return
		}

		file_input.value = ''
		show_upload_message(
			message,
			(self.get_tool_label('upload_success_message') || 'File uploaded successfully.') + ' (' + result.feature_count + ')',
			UPLOAD_MESSAGE_MS
		)
	})

}//end bind_vector_upload



/**
* BIND_UPLOAD_ON_PICK
* The image half: one upload per pick. The picker is disabled for the round
* trip and its direction read off the DOM, never a cached flag (hito 3c law).
* It is emptied after every attempt, failed ones too, so that choosing the
* SAME file again still fires `change`.
*
* @param {HTMLInputElement} file_input
* @param {HTMLElement} message - this sub-flow's own status line
* @param {function(File): Promise<string|{text: string, hide_after_ms: number}|null>} run
*	resolves what to show; a bare string is an error (UPLOAD_ERROR_MESSAGE_MS)
* @returns {void}
*/
const bind_upload_on_pick = function(file_input, message, run) {

	file_input.addEventListener('change', async () => {

		const file = file_input.files && file_input.files[0]
		// a cancelled picker fires no file
		if (!file || file_input.disabled) {
			return
		}

		clear_upload_message(message)
		file_input.disabled = true

		const text = await run(file)

		// the panel may be gone (tool closed mid-upload) — nothing to update
		if (!message.isConnected) {
			return
		}
		file_input.disabled	= false
		file_input.value	= ''

		clear_upload_message(message)
		const answer = (text && typeof text==='object') ? text : {text, hide_after_ms: UPLOAD_ERROR_MESSAGE_MS}
		if (answer.text) {
			show_upload_message(message, answer.text, answer.hide_after_ms)
		}
	})

}//end bind_upload_on_pick



/**
* RENDER_UPLOAD_MESSAGE
* @param {HTMLElement} parent
* @returns {HTMLElement} the hidden status line
*/
const render_upload_message = function(parent) {
	const message = ui.create_dom_element({element_type: 'div', class_name: 'uca-maps-upload-message', parent})
	message.hidden = true
	return message
}//end render_upload_message



/** How long a transient line stays: "un par de segundos", the same window as
 * the self-closing "UCA Maps" modal (`tool_uca_maps.js`). */
export const UPLOAD_MESSAGE_MS = 2000

/** An error stays longer, v6's own default for every message
 * (`special_tools.js:3473` modal_message): it has to be read, not glimpsed. */
export const UPLOAD_ERROR_MESSAGE_MS = 3500

/**
* SHOW_UPLOAD_MESSAGE
* Plain in-flow status/error line — same reasoning as `render_wms_services.js`
* show_wms_message (used for both success and error text here, unlike WMS,
* since there is no separate results list to react to). The hide timer lives
* on the node, so a newer message or the teardown cancels it.
*
* @param {HTMLElement} message
* @param {string} text
* @param {number} [hide_after_ms] - omitted: the line stays (the "working" one)
* @returns {void}
*/
const show_upload_message = function(message, text, hide_after_ms) {
	clear_upload_message(message)
	message.textContent	= text
	message.hidden		= false
	if (typeof hide_after_ms==='number') {
		message._uca_maps_hide_timer = setTimeout(() => clear_upload_message(message), hide_after_ms)
	}
}//end show_upload_message



/**
* CLEAR_UPLOAD_MESSAGE
* Also what the teardown calls on every line (`clear_upload_messages`).
*
* @param {HTMLElement} message
* @returns {void}
*/
const clear_upload_message = function(message) {
	clearTimeout(message._uca_maps_hide_timer)
	message._uca_maps_hide_timer = null
	message.hidden = true
}//end clear_upload_message



/**
* CLEAR_UPLOAD_MESSAGES
* Teardown hook for `detach_file_upload`: no hide timer outlives the panel.
*
* @param {HTMLElement|null} panel
* @returns {void}
*/
export const clear_upload_messages = function(panel) {
	if (!panel) {
		return
	}
	panel.querySelectorAll('.uca-maps-upload-message').forEach(clear_upload_message)
}//end clear_upload_messages



/**
* RESET_FILE_UPLOAD_PANEL
* What v6 gets by rebuilding its modal on every open: no message, no file
* chosen, empty EPSG/zone/band, the projections list closed. Called on OPEN,
* not on close: a sibling panel can close this one without going through
* this module (toolbar.js close_other_toolbar_panels). A half whose upload is
* still in flight (its picker disabled) is left alone, file and line included.
*
* @param {HTMLElement|null} panel
* @returns {void}
*/
export const reset_file_upload_panel = function(panel) {
	if (!panel) {
		return
	}

	const messages		= panel.querySelectorAll('.uca-maps-upload-message')
	const vector_picker	= panel.querySelector('.uca-maps-upload-file')
	const image_picker	= panel.querySelector('.uca-maps-upload-image-file')

	if (vector_picker && !vector_picker.disabled) {
		reset_picker(vector_picker, messages[0])

		const epsg_input = panel.querySelector('.uca-maps-upload-epsg')
		panel.querySelectorAll('.uca-maps-upload-epsg-row input').forEach((input) => {
			input.value = ''
		})
		// the epsg.io link follows this field (render_projection_fields)
		if (epsg_input) {
			epsg_input.dispatchEvent(new Event('input'))
		}

		const list			= panel.querySelector('.uca-maps-upload-projections-list')
		const list_button	= panel.querySelector('.uca-maps-upload-projections-button')
		if (list && list_button) {
			list.hidden = true
			list_button.setAttribute('aria-expanded', 'false')
		}
	}

	if (image_picker && !image_picker.disabled) {
		reset_picker(image_picker, messages[1])
	}
}//end reset_file_upload_panel



/**
* RESET_PICKER
* @param {HTMLInputElement} picker
* @param {HTMLElement|undefined} message - the same half's status line
* @returns {void}
*/
const reset_picker = function(picker, message) {
	picker.value = ''
	if (message) {
		clear_upload_message(message)
	}
}//end reset_picker



// @license-end
