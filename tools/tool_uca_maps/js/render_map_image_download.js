// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*eslint no-undef: "error"*/



/**
* RENDER_MAP_IMAGE_DOWNLOAD
* DOM for the "Download map as image" panel, behind its own toolbar button
* (`map_image_download.js` attach_map_image_download_control). It only builds
* DOM and reads state; the download is reached through
* `self.download_map_image(...)`, since logic imports render, never the reverse.
*
* @module render_map_image_download
*/



import {ui} from '../../../core/common/js/ui.js'
import {DEFAULT_MAP_IMAGE_NAME} from './download_filename.js'
import {bind_download_button, create_panel_message} from './render_download_line.js'



/** Raster formats, in menu order: the 5 of v6's "Download map as image".
* PNG stays client-only (`map_image_download.js`); the rest round-trip
* through the server's `raster_download` action. */
const RASTER_FORMATS = ['png', 'jpg', 'gif', 'webp', 'geotiff']

/**
* RENDER_MAP_IMAGE_DOWNLOAD_PANEL
* Populates the panel shell `toolbar.js` create_toolbar_panel built: a name
* field (v6's own, `special_tools_map_image_download.js`), a format `<select>`,
* one "Download" button and the line a failure is shown on.
*
* @param {Object} self - tool_uca_maps instance
* @param {HTMLElement} panel - the panel shell (`toolbar.js` create_toolbar_panel)
* @returns {HTMLElement} panel
*/
export const render_map_image_download_panel = function(self, panel) {

	// the header (title + ×) is toolbar.js's: the panel opens centred

	// name before format, as v6 orders it; pre-filled with the default base
	// name, so leaving it alone still names the file
	const name_row = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'uca-maps-map-image-row',
		parent			: panel
	})
	ui.create_dom_element({
		element_type	: 'span',
		class_name		: 'uca-maps-map-image-name-label',
		text_content	: self.get_tool_label('map_image_name_label') || 'File name',
		parent			: name_row
	})
	const name_input = ui.create_dom_element({
		element_type	: 'input',
		class_name		: 'uca-maps-map-image-name',
		parent			: name_row
	})
	name_input.type			= 'text'
	name_input.value		= DEFAULT_MAP_IMAGE_NAME
	name_input.placeholder	= DEFAULT_MAP_IMAGE_NAME

	const row = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'uca-maps-map-image-row',
		parent			: panel
	})

	const select = ui.create_dom_element({
		element_type	: 'select',
		class_name		: 'uca-maps-map-image-format',
		parent			: row
	})
	for (const format of RASTER_FORMATS) {
		ui.create_dom_element({
			element_type	: 'option',
			value			: format,
			text_content	: self.get_tool_label('raster_format_' + format) || format,
			parent			: select
		})
	}

	const button = ui.create_dom_element({
		element_type	: 'button',
		class_name		: 'uca-maps-map-image-button',
		text_content	: self.get_tool_label('download_button') || 'Download',
		parent			: row
	})
	button.type = 'button'
	const message = create_panel_message(panel, 'uca-maps-map-image-message')
	bind_download_button(button, message, () => self.download_map_image(select.value, name_input.value))


	return panel
}//end render_map_image_download_panel



// @license-end
