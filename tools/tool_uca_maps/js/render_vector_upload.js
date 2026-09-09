// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*eslint no-undef: "error"*/



/**
* RENDER_VECTOR_UPLOAD
* DOM for the "Upload file to map" panel (functionality #11, vector half —
* hito 12). Shell built once at attach, same shape as `render_wms_services.js`
* render_search_form: a file input + optional EPSG override + submit button,
* mutations reach `self.upload_vector_file(...)`, never `vector_upload.js`
* directly.
*
* @module render_vector_upload
*/



import {ui} from '../../../core/common/js/ui.js'



/**
* RENDER_FILE_UPLOAD_PANEL
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

	const message = ui.create_dom_element({element_type: 'div', class_name: 'uca-maps-upload-message', parent: panel})
	message.hidden = true

	ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'uca-maps-upload-hint',
		text_content	: self.get_tool_label('upload_vector_extensions_hint')
			|| 'Allowed extensions: .zip (shapefile), .geojson and .kml',
		parent			: panel
	})

	const file_input = ui.create_dom_element({element_type: 'input', class_name: 'uca-maps-upload-file', parent: panel})
	file_input.type	= 'file'
	file_input.accept	= '.zip,.geojson,.kml'

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

	const submit_btn = ui.create_dom_element({
		element_type	: 'button',
		class_name		: 'uca-maps-upload-submit',
		text_content	: self.get_tool_label('upload_submit_button') || 'Upload vector file',
		parent			: panel
	})
	submit_btn.type = 'button'
	submit_btn.addEventListener('click', async () => {

		clear_upload_message(panel)

		const file = file_input.files && file_input.files[0]

		submit_btn.disabled = true
		const result = await self.upload_vector_file(file, epsg_input.value)
		submit_btn.disabled = false

		if (!result.ok) {
			if (result.error) {
				show_upload_message(panel, result.error)
			}
			return
		}

		if (result.feature_count===0) {
			show_upload_message(
				panel,
				self.get_tool_label('upload_no_features') || 'No objects could be read from this file.'
			)
			return
		}

		file_input.value = ''
		show_upload_message(
			panel,
			(self.get_tool_label('upload_success_message') || 'File uploaded successfully.')
				+ ' (' + result.feature_count + ')'
		)

	})

	return panel
}//end render_file_upload_panel



/**
* SHOW_UPLOAD_MESSAGE
* Plain in-flow status/error line — same reasoning as `render_wms_services.js`
* show_wms_message (used for both success and error text here, unlike WMS,
* since there is no separate results list to react to).
*
* @param {HTMLElement} panel
* @param {string} text
* @returns {void}
*/
const show_upload_message = function(panel, text) {
	const message = panel.querySelector('.uca-maps-upload-message')
	message.textContent	= text
	message.hidden			= false
}//end show_upload_message



/**
* CLEAR_UPLOAD_MESSAGE
* @param {HTMLElement} panel
* @returns {void}
*/
const clear_upload_message = function(panel) {
	panel.querySelector('.uca-maps-upload-message').hidden = true
}//end clear_upload_message



// @license-end
