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



/**
* RENDER_FILE_UPLOAD_PANEL
* CHOOSING THE FILE IS THE WHOLE GESTURE, in both sub-flows (functional
* audit, 2026-09-24): v6 uploads on selection, and a confirm button that can
* only ever be pressed right after asks nothing — the same call already made
* for "Associate image" in the object console. Each sub-flow owns its status
* line, under its own picker, so an image result never lands in the vector half.
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

	ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'uca-maps-upload-hint',
		text_content	: self.get_tool_label('upload_vector_extensions_hint')
			|| 'Allowed extensions: .zip (shapefile), .geojson and .kml',
		parent			: panel
	})

	// ABOVE the picker: with no confirm button, picking the file is what
	// reads this field, so it has to be filled in before, not after
	const epsg_row = ui.create_dom_element({element_type: 'div', class_name: 'uca-maps-upload-epsg-row', parent: panel})

	const epsg_input = ui.create_dom_element({element_type: 'input', class_name: 'uca-maps-upload-epsg', parent: epsg_row})
	epsg_input.type			= 'text'
	epsg_input.placeholder	= self.get_tool_label('upload_epsg_placeholder')
		|| 'EPSG code (only for a file with no embedded projection)'

	const epsg_link = ui.create_dom_element({
		element_type	: 'a',
		class_name		: 'uca-maps-upload-epsg-link',
		text_content	: 'https://epsg.io/',
		parent			: epsg_row
	})
	epsg_link.href		= 'https://epsg.io/'
	epsg_link.target	= '_blank'
	epsg_link.rel		= 'noopener noreferrer'

	const file_input = ui.create_dom_element({element_type: 'input', class_name: 'uca-maps-upload-file', parent: panel})
	file_input.type	= 'file'
	file_input.accept	= '.zip,.geojson,.kml'

	const message = render_upload_message(panel)

	bind_upload_on_pick(file_input, message, async (file) => {

		const result = await self.upload_vector_file(file, epsg_input.value)

		if (!result.ok) {
			return result.error || null
		}
		if (result.feature_count===0) {
			return self.get_tool_label('upload_no_features') || 'No objects could be read from this file.'
		}
		return (self.get_tool_label('upload_success_message') || 'File uploaded successfully.')
			+ ' (' + result.feature_count + ')'
	})

	render_image_section(self, panel)

	return panel
}//end render_file_upload_panel



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
		return {text, transient: true}
	})

}//end render_image_section



/**
* BIND_UPLOAD_ON_PICK
* One upload per pick. The picker is disabled for the round trip and its
* direction read off the DOM, never a cached flag (hito 3c law). It is
* emptied after every attempt, failed ones too: re-picking the SAME file —
* e.g. after typing the EPSG code a failure asked for — must fire `change`.
*
* @param {HTMLInputElement} file_input
* @param {HTMLElement} message - this sub-flow's own status line
* @param {function(File): Promise<string|{text: string, transient: boolean}|null>} run
*	resolves what to show; a `transient` answer hides itself after UPLOAD_MESSAGE_MS
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
		const answer = (text && typeof text==='object') ? text : {text, transient: false}
		if (answer.text) {
			show_upload_message(message, answer.text, answer.transient)
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

/**
* SHOW_UPLOAD_MESSAGE
* Plain in-flow status/error line — same reasoning as `render_wms_services.js`
* show_wms_message (used for both success and error text here, unlike WMS,
* since there is no separate results list to react to). The hide timer lives
* on the node, so a newer message or the teardown cancels it.
*
* @param {HTMLElement} message
* @param {string} text
* @param {boolean} [transient=false]
* @returns {void}
*/
const show_upload_message = function(message, text, transient) {
	clear_upload_message(message)
	message.textContent	= text
	message.hidden		= false
	if (transient===true) {
		message._uca_maps_hide_timer = setTimeout(() => clear_upload_message(message), UPLOAD_MESSAGE_MS)
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



// @license-end
