// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*eslint no-undef: "error"*/



/**
* RENDER_MAP_IMAGE_DOWNLOAD
* DOM for the "Download map as image" panel (functionality #10). Toolbar
* refactor (2026-09-04, CLAUDE.local.md "Left toolbar: un botón por
* funcionalidad"): this used to be a collapsed `<details>` section built
* INTO the "UCA" object-console panel (hito 3, checkpoint 3b); it is now its
* OWN panel behind its OWN button, both built through `toolbar.js` — see
* `map_image_download.js`'s `attach_map_image_download_control`.
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
* RENDER_MAP_IMAGE_DOWNLOAD_PANEL
* Populates the panel shell `toolbar.js`'s `create_toolbar_panel` already
* built and appended to the map container — header + a format `<select>` +
* one "Download" button. No filename input, consistent with the per-object
* download (functionality #3a): a fixed base name (`raster_download.ts`)
* rather than reintroducing the free-text field v6 had, which nothing else
* in this tool offers either.
*
* @param {Object} self - tool_uca_maps instance
* @param {HTMLElement} panel - the panel shell (`toolbar.js` create_toolbar_panel)
* @returns {HTMLElement} panel
*/
export const render_map_image_download_panel = function(self, panel) {

	const header = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'uca-maps-panel-header',
		parent			: panel
	})
	ui.create_dom_element({
		element_type	: 'span',
		class_name		: 'uca-maps-panel-title',
		text_content	: self.get_tool_label('map_image_download_title') || 'Download map as image',
		parent			: header
	})

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
	button.addEventListener('click', () => self.download_map_image(select.value))


	return panel
}//end render_map_image_download_panel



// @license-end
