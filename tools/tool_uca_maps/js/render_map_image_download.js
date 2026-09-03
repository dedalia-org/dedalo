// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*eslint no-undef: "error"*/



/**
* RENDER_MAP_IMAGE_DOWNLOAD
* DOM for the "Download map as image" section (hito 3, checkpoint 3b) —
* built once into the panel shell (`render_object_console.js`
* `render_console_panel`), never per-object-selection (this is a map-wide
* action, unlike the per-object download in `render_download_button`).
*
* Same render/logic split as the rest of this tool: this file only builds
* DOM and reads state; the mutation (`download_map_image`) lives in
* `map_image_download.js`, reached through `self.download_map_image(...)` —
* the thin-prototype-wrapper pattern (`tool_uca_maps.js`), never a direct
* import from a render file (the established one-directional convention:
* logic imports render, never the reverse — review-diff tripwire-integrity
* finding, hito 2).
*
* @module render_map_image_download
*/



import {ui} from '../../../core/common/js/ui.js'



/** Raster formats, in menu order — the 5 of v6's "Download map as image"
* (functionality #10). PNG stays client-only (`map_image_download.js`);
* the rest round-trip through the server's `raster_download` action. */
const RASTER_FORMATS = ['png', 'jpg', 'gif', 'webp', 'geotiff']

/**
* RENDER_MAP_IMAGE_DOWNLOAD_SECTION
* A collapsible `<details>` section (same shell as "Server capabilities"),
* with a format `<select>` + one "Download" button — no filename input,
* consistent with the per-object download (3a): a fixed base name
* (`raster_download.ts`) rather than reintroducing the free-text field v6
* had, which nothing else in this tool offers either.
*
* @param {Object} self - tool_uca_maps instance
* @param {HTMLElement} panel - the panel shell (`render_console_panel`)
* @returns {void}
*/
export const render_map_image_download_section = function(self, panel) {

	const section = ui.create_dom_element({
		element_type	: 'details',
		class_name		: 'uca-maps-map-image-download',
		parent			: panel
	})
	ui.create_dom_element({
		element_type	: 'summary',
		text_content	: self.get_tool_label('map_image_download_title') || 'Download map as image',
		parent			: section
	})

	const row = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'uca-maps-map-image-row',
		parent			: section
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
	button.addEventListener('click', () => self.download_map_image(select.value))

}//end render_map_image_download_section



// @license-end
