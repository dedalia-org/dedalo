// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*eslint no-undef: "error"*/



/**
* RENDER_CAPABILITIES_PANEL
* DOM for the dev-only server-capabilities diagnostic (GDAL/ImageMagick
* availability). Moved out of `render_object_console.js` in the toolbar
* refactor (2026-09-04, CLAUDE.local.md "Left toolbar") — content unchanged
* since hito 1 beyond its new home (its own panel behind its own dev-only
* button, `capabilities_panel.js`, instead of a collapsed `<details>` section
* inside the "UCA" object-console panel).
*
* @module render_capabilities_panel
*/



import {ui} from '../../../core/common/js/ui.js'
import {response_data} from '../../../core/common/js/api_error.js'



/**
* RENDER_CAPABILITIES_PANEL
* Populates the panel shell `toolbar.js`'s `create_toolbar_panel` already
* built and appended to the map container — header + the async capabilities
* list (`ui.load_item_with_spinner`, unchanged behaviour).
*
* @param {Object} self - tool_uca_maps instance
* @param {HTMLElement} panel - the panel shell (`toolbar.js` create_toolbar_panel)
* @returns {HTMLElement} panel
*/
export const render_capabilities_panel = function(self, panel) {

	const header = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'uca-maps-panel-header',
		parent			: panel
	})
	ui.create_dom_element({
		element_type	: 'span',
		class_name		: 'uca-maps-panel-title',
		text_content	: self.get_tool_label('capabilities_title') || 'Server capabilities',
		parent			: header
	})

	const body = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'uca-maps-capabilities-body',
		parent			: panel
	})
	ui.load_item_with_spinner({
		container			: body,
		preserve_content	: false,
		label				: self.get_tool_label('capabilities_title') || 'Server capabilities',
		callback			: async () => render_capabilities(self)
	})


	return panel
}//end render_capabilities_panel



/**
* RENDER_CAPABILITIES
* Calls self.get_capabilities() and renders one row per probed binary.
* Unchanged since hito 1 beyond its home moving twice (modal body → the
* "UCA" panel's collapsed section → this dev-only panel).
*
* @param {Object} self - tool_uca_maps instance
* @returns {Promise<HTMLElement>} node to insert (via ui.load_item_with_spinner)
*/
const render_capabilities = async function(self) {

	const response		= await self.get_capabilities()
	const capabilities	= response_data(response)

	const node = ui.create_dom_element({ element_type: 'ul', class_name: 'capabilities_list' })

	if (!capabilities) {
		ui.create_dom_element({
			element_type	: 'li',
			class_name		: 'notice notice_error',
			text_content	: response?.msg || 'Error reading server capabilities.',
			parent			: node
		})
		return node
	}

	const rows = [
		{ label: self.get_tool_label('capabilities_gdal') || 'GDAL', capability: capabilities.gdal },
		{ label: 'ogr2ogr', capability: capabilities.ogr2ogr },
		{ label: 'gdal_translate', capability: capabilities.gdalTranslate },
		{
			label		: self.get_tool_label('capabilities_imagemagick') || 'ImageMagick',
			capability	: capabilities.imagemagick
		},
		// hito 18: the gazetteer store is not a binary but the same question —
		// what this install can serve — and this is where an admin looks to see
		// whether `gazetteer_data_path` resolved at all
		{
			label		: self.get_tool_label('capabilities_gazetteer_pleiades') || 'Pleiades index',
			capability	: { available: Boolean(capabilities.gazetteers?.pleiades) }
		},
		{
			label		: (self.get_tool_label('capabilities_gazetteer_pelagios') || 'Pelagios layers')
							+ ' (' + ((capabilities.gazetteers?.pelagios || []).length) + ')',
			capability	: { available: (capabilities.gazetteers?.pelagios || []).length > 0 }
		}
	]

	for (const row of rows) {
		const available	= Boolean(row.capability?.available)
		const li = ui.create_dom_element({
			element_type	: 'li',
			class_name		: available ? 'capability_available' : 'capability_unavailable',
			parent			: node
		})
		const status_label = available
			? (self.get_tool_label('capability_available') || 'available')
			: (self.get_tool_label('capability_unavailable') || 'not installed on this server')
		ui.create_dom_element({
			element_type	: 'span',
			text_content	: (available ? '✓ ' : '✗ ') + row.label + ': ' + status_label,
			parent			: li
		})
	}


	return node
}//end render_capabilities



// @license-end
