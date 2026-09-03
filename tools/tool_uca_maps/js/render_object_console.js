// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global L */
/*eslint no-undef: "error"*/



/**
* RENDER_OBJECT_CONSOLE
* DOM for the panel object_console.js anchors to the live map. Panel shell +
* capabilities (relocated from hito 1's modal body — same server contract,
* `tool_uca_maps.prototype.get_capabilities`). Checkpoint 2b:
* `render_selected_object` builds the full per-geometry-type object section
* (style/properties/download/centroid/uncertainty/hierarchy) — every
* mutation handler it wires lives in `object_console.js`, never here (this
* module only builds DOM and reads state, per the project's render/logic
* split).
*
* @module render_object_console
*/



import {ui} from '../../../core/common/js/ui.js'
import {response_data} from '../../../core/common/js/api_error.js'
import {render_map_image_download_section} from './render_map_image_download.js'

// (!) render → render import above (this file → render_map_image_download.js)
// is the SAFE direction: the risk the one-directional convention guards
// against is a render file importing back from its OWN paired logic file
// (object_console.js), never a render file importing a DIFFERENT render
// file. render_map_image_download.js imports nothing from this file, so no
// cycle. Deliberately NO import from './object_console.js' — object_console.js
// already imports {render_console_panel, render_selected_object,
// render_placeholder} FROM this file (the established one-directional
// convention across every render_X.js/X.js pair in tools/: logic imports
// render, never the reverse); an import back here would close a 2-node
// cycle (review-diff tripwire-integrity finding, 2026-09-02). Every mutator
// this file needs is called as self.<method>(...) — thin prototype wrappers
// defined in tool_uca_maps.js, same pattern as self.get_tool_label(...)/
// self.get_capabilities() already used below since hito 1.



/**
* RENDER_CONSOLE_PANEL
* Builds the panel shell (not yet attached to the DOM — the caller,
* object_console.js attach_console, appends it to the map container).
*
* @param {Object} self - tool_uca_maps instance
* @returns {HTMLElement} panel_node
*/
export const render_console_panel = function(self) {

	const panel = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'uca-maps-console'
	})

	// header
		const header = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'uca-maps-console-header',
			parent			: panel
		})
		ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'uca-maps-console-title',
			text_content	: self.get_tool_label('uca_maps_control_title') || 'UCA Maps',
			parent			: header
		})

	// capabilities — relocated from hito 1's modal body; collapsed by default
	// so the panel opens focused on the map, not on server diagnostics
		const capabilities_section = ui.create_dom_element({
			element_type	: 'details',
			class_name		: 'uca-maps-capabilities',
			parent			: panel
		})
		ui.create_dom_element({
			element_type	: 'summary',
			text_content	: self.get_tool_label('capabilities_title') || 'Server capabilities',
			parent			: capabilities_section
		})
		const capabilities_body = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'uca-maps-capabilities-body',
			parent			: capabilities_section
		})
		ui.load_item_with_spinner({
			container			: capabilities_body,
			preserve_content	: false,
			label				: self.get_tool_label('capabilities_title') || 'Server capabilities',
			callback			: async () => render_capabilities(self)
		})

	// download map as image (hito 3, checkpoint 3b) — a MAP-WIDE action, built
	// once here like capabilities (never per-object-selection, unlike
	// render_download_button below); collapsed by default for the same reason.
		render_map_image_download_section(self, panel)

	// selected-object section — populated by render_selected_object() on click
		const object_section = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'uca-maps-object-section',
			parent			: panel
		})
		render_placeholder(self, object_section)


	return panel
}//end render_console_panel



/**
* RENDER_PLACEHOLDER
* Shown in the object section before any geometry has been clicked, and
* again after the selected layer is removed from the map (Geoman's own
* delete tool — `object_console.js`'s `pm:remove` handler calls this back to
* clear a stale selection instead of leaving the panel showing controls for
* a layer that no longer exists, review-diff correctness finding 2026-09-02).
* Exported so `object_console.js` can call it without a second, duplicate
* placeholder builder.
*
* @param {Object} self - tool_uca_maps instance
* @param {HTMLElement} [container] - defaults to the panel's own object
*   section (self.panel_node)
* @returns {void}
*/
export const render_placeholder = function(self, container) {
	container = container || (self.panel_node && self.panel_node.querySelector('.uca-maps-object-section'))
	if (!container) {
		return
	}
	container.replaceChildren()
	ui.create_dom_element({
		element_type	: 'p',
		class_name		: 'uca-maps-object-placeholder',
		text_content	: self.get_tool_label('no_object_selected') || 'Click a drawn geometry to inspect it.',
		parent			: container
	})
}//end render_placeholder



const GEOMETRY_LABELS = {
	marker		: 'Marker',
	circle		: 'Circle',
	polygon		: 'Polygon',
	polyline	: 'Polyline',
	unknown		: 'Object'
}

/**
* GET_GEOMETRY_KIND
* Order matters: L.Polygon extends L.Polyline, so it must be checked first.
*
* @param {Object} layer - Leaflet layer
* @returns {string} one of 'marker'|'circle'|'polygon'|'polyline'|'unknown'
*/
const get_geometry_kind = function(layer) {
	if (layer instanceof L.Marker)		return 'marker'
	if (layer instanceof L.Circle)		return 'circle'
	if (layer instanceof L.Polygon)	return 'polygon'
	if (layer instanceof L.Polyline)	return 'polyline'
	return 'unknown'
}//end get_geometry_kind



/**
* RENDER_SELECTED_OBJECT
* Populates the panel's object section for the currently selected layer:
* geometry type, coordinates/measurement (matching the core's own native
* popup, see `object_console.js` `compute_info`), style extras (not for
* markers), centroid (circle/polygon only), uncertainty (polygon only),
* hierarchy (not for markers), custom properties CRUD, and GeoJSON
* download — the full functionality #3 scope
* (`docs/Funcionalidades de tool_leaflet_special_tools.md`).
*
* @param {Object} self - tool_uca_maps instance
* @param {Object} layer - Leaflet layer (Marker/Circle/Polygon/Polyline)
* @returns {void}
*/
export const render_selected_object = function(self, layer) {

	if (!self.panel_node) {
		return
	}
	const object_section = self.panel_node.querySelector('.uca-maps-object-section')
	if (!object_section) {
		return
	}
	object_section.replaceChildren()

	const kind = get_geometry_kind(layer)

	ui.create_dom_element({
		element_type	: 'h5',
		text_content	: self.get_tool_label('object_selected_title') || 'Selected object',
		parent			: object_section
	})
	ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'uca-maps-object-type',
		text_content	: GEOMETRY_LABELS[kind],
		parent			: object_section
	})

	const info = self.compute_info(layer)
	if (info) {
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'uca-maps-object-info',
			text_content	: (self.get_tool_label('info_' + info.label_key) || info.label) + ': ' + info.value,
			parent			: object_section
		})
	}

	render_style_controls(self, layer, object_section)
	render_centroid_control(self, layer, object_section)
	render_uncertainty_control(self, layer, object_section)
	render_hierarchy_controls(self, layer, object_section)
	render_properties_editor(self, layer, object_section)
	render_download_button(self, layer, object_section)

}//end render_selected_object



/**
* RENDER_STYLE_CONTROLS
* Fill colour, fill opacity, stroke weight — every `L.Path` (circle/polygon/
* polyline; NOT `L.Marker`, which has no fill/stroke to speak of). Stroke
* COLOUR is deliberately absent: the core's own native popup already edits
* it for free (`object_console.js` `set_style_field` file header).
*
* @param {Object} self
* @param {Object} layer
* @param {HTMLElement} container
* @returns {void}
*/
const render_style_controls = function(self, layer, container) {

	if (!(layer instanceof L.Path)) {
		return
	}

	const properties	= layer.feature && layer.feature.properties || {}
	const style			= (properties.uca_maps && properties.uca_maps.style) || {}

	const fieldset = ui.create_dom_element({element_type: 'div', class_name: 'uca-maps-style-controls', parent: container})
	ui.create_dom_element({
		element_type	: 'h6',
		text_content	: self.get_tool_label('style_title') || 'Style',
		parent			: fieldset
	})

	// fill colour
		const fill_row = ui.create_dom_element({element_type: 'label', class_name: 'uca-maps-field', parent: fieldset})
		ui.create_dom_element({
			element_type	: 'span',
			text_content	: self.get_tool_label('style_fill_color') || 'Fill color',
			parent			: fill_row
		})
		const fill_input = ui.create_dom_element({element_type: 'input', parent: fill_row})
		fill_input.type	 = 'color'
		fill_input.value = style.fillColor || layer.options.fillColor || '#3388ff'
		fill_input.addEventListener('change', () => self.set_style_field(layer, 'fillColor', fill_input.value))

	// fill opacity
		const opacity_row = ui.create_dom_element({element_type: 'label', class_name: 'uca-maps-field', parent: fieldset})
		ui.create_dom_element({
			element_type	: 'span',
			text_content	: self.get_tool_label('style_fill_opacity') || 'Fill opacity',
			parent			: opacity_row
		})
		const opacity_input = ui.create_dom_element({element_type: 'input', parent: opacity_row})
		opacity_input.type	= 'range'
		opacity_input.min	= '0'
		opacity_input.max	= '1'
		opacity_input.step	= '0.05'
		opacity_input.value = style.fillOpacity!=null
			? style.fillOpacity
			: (layer.options.fillOpacity!=null ? layer.options.fillOpacity : 0.2)
		opacity_input.addEventListener('change', () => self.set_style_field(layer, 'fillOpacity', Number(opacity_input.value)))

	// stroke weight
		const weight_row = ui.create_dom_element({element_type: 'label', class_name: 'uca-maps-field', parent: fieldset})
		ui.create_dom_element({
			element_type	: 'span',
			text_content	: self.get_tool_label('style_weight') || 'Stroke weight',
			parent			: weight_row
		})
		const weight_input = ui.create_dom_element({element_type: 'input', parent: weight_row})
		weight_input.type	= 'number'
		weight_input.min	= '1'
		weight_input.step	= '1'
		weight_input.value = style.weight!=null ? style.weight : (layer.options.weight!=null ? layer.options.weight : 3)
		weight_input.addEventListener('change', () => self.set_style_field(layer, 'weight', Number(weight_input.value)))

}//end render_style_controls



/**
* RENDER_CENTROID_CONTROL
* Circle/polygon only — matches v6 (`object_console.js` `toggle_centroid`
* file header).
*
* @param {Object} self
* @param {Object} layer
* @param {HTMLElement} container
* @returns {void}
*/
const render_centroid_control = function(self, layer, container) {

	if (!(layer instanceof L.Circle) && !(layer instanceof L.Polygon)) {
		return
	}

	const properties	= layer.feature && layer.feature.properties || {}
	const has_centroid	= Boolean(properties.uca_maps && properties.uca_maps.centroid_uid)

	const row = ui.create_dom_element({element_type: 'label', class_name: 'uca-maps-field uca-maps-checkbox uca-maps-centroid', parent: container})
	const input = ui.create_dom_element({element_type: 'input', parent: row})
	input.type		= 'checkbox'
	input.checked	= has_centroid
	ui.create_dom_element({
		element_type	: 'span',
		text_content	: self.get_tool_label('centroid_label') || 'Centroid',
		parent			: row
	})
	input.addEventListener('change', () => self.toggle_centroid(layer))

}//end render_centroid_control



/**
* RENDER_UNCERTAINTY_CONTROL
* Polygon only — matches v6 exactly (`object_console.js` `toggle_uncertainty`
* file header). Shows the scale tier + the preserved buggy value alongside
* the checkbox once enabled, so the bug is visible, not silently stored.
*
* @param {Object} self
* @param {Object} layer
* @param {HTMLElement} container
* @returns {void}
*/
const render_uncertainty_control = function(self, layer, container) {

	if (!(layer instanceof L.Polygon)) {
		return
	}

	const properties	= layer.feature && layer.feature.properties || {}
	const uncertainty	= properties.uca_maps && properties.uca_maps.uncertainty

	const row = ui.create_dom_element({element_type: 'label', class_name: 'uca-maps-field uca-maps-checkbox uca-maps-uncertainty', parent: container})
	const input = ui.create_dom_element({element_type: 'input', parent: row})
	input.type		= 'checkbox'
	input.checked	= Boolean(uncertainty)
	ui.create_dom_element({
		element_type	: 'span',
		text_content	: self.get_tool_label('uncertainty_label') || 'Uncertainty',
		parent			: row
	})
	input.addEventListener('change', () => self.toggle_uncertainty(layer))

	if (uncertainty) {
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'uca-maps-uncertainty-badge',
			text_content	: (self.get_tool_label('uncertainty_scale_tier') || 'Scale tier')
				+ ' ' + uncertainty.scale_tier + ' — ' + uncertainty.value,
			parent			: container
		})
	}

}//end render_uncertainty_control



/**
* RENDER_HIERARCHY_CONTROLS
* Circle/polygon/polyline (not marker) — matches v6
* (`object_console.js` `set_hierarchy` file header). The two checkboxes are
* mutually exclusive ON CHECK (checking one visually unchecks the other,
* matching v6's own UI); UNCHECK deliberately does NOT force-check the
* other — after re-render both can show unchecked despite the layer having
* visually jumped (the preserved bug — see `set_hierarchy`).
*
* @param {Object} self
* @param {Object} layer
* @param {HTMLElement} container
* @returns {void}
*/
const render_hierarchy_controls = function(self, layer, container) {

	if (layer instanceof L.Marker) {
		return
	}

	const properties	= layer.feature && layer.feature.properties || {}
	const hierarchy		= (properties.uca_maps && properties.uca_maps.hierarchy) || {}

	const fieldset = ui.create_dom_element({element_type: 'div', class_name: 'uca-maps-hierarchy-controls', parent: container})
	ui.create_dom_element({
		element_type	: 'h6',
		text_content	: self.get_tool_label('hierarchy_title') || 'Hierarchy',
		parent			: fieldset
	})

	const front_row = ui.create_dom_element({element_type: 'label', class_name: 'uca-maps-field uca-maps-checkbox', parent: fieldset})
	const front_input = ui.create_dom_element({element_type: 'input', parent: front_row})
	front_input.type		= 'checkbox'
	front_input.checked	= Boolean(hierarchy.bringToFront)
	ui.create_dom_element({
		element_type	: 'span',
		text_content	: self.get_tool_label('hierarchy_front') || 'Front',
		parent			: front_row
	})

	const back_row = ui.create_dom_element({element_type: 'label', class_name: 'uca-maps-field uca-maps-checkbox', parent: fieldset})
	const back_input = ui.create_dom_element({element_type: 'input', parent: back_row})
	back_input.type		= 'checkbox'
	back_input.checked	= Boolean(hierarchy.bringToBack)
	ui.create_dom_element({
		element_type	: 'span',
		text_content	: self.get_tool_label('hierarchy_back') || 'Back',
		parent			: back_row
	})

	front_input.addEventListener('change', () => {
		if (front_input.checked) {
			back_input.checked = false
		}
		self.set_hierarchy(layer, 'front', front_input.checked)
	})
	back_input.addEventListener('change', () => {
		if (back_input.checked) {
			front_input.checked = false
		}
		self.set_hierarchy(layer, 'back', back_input.checked)
	})

}//end render_hierarchy_controls



/**
* RENDER_PROPERTIES_EDITOR
* Generic key/value CRUD over `layer.feature.properties`, excluding
* RESERVED_PROPERTY_KEYS (core- and tool-managed fields). Each existing
* property is an inline editable text input (commits on change/blur — a
* deliberate gesture, CLAUDE.local.md "nada auto-guarda"), never a native
* `window.prompt` (untestable in headless Chrome, and a worse UX than
* editing in place).
*
* @param {Object} self
* @param {Object} layer
* @param {HTMLElement} container
* @returns {void}
*/
const render_properties_editor = function(self, layer, container) {

	const properties = layer.feature && layer.feature.properties || {}

	const fieldset = ui.create_dom_element({element_type: 'div', class_name: 'uca-maps-properties-editor', parent: container})
	ui.create_dom_element({
		element_type	: 'h6',
		text_content	: self.get_tool_label('properties_title') || 'Properties',
		parent			: fieldset
	})

	const list = ui.create_dom_element({element_type: 'ul', class_name: 'uca-maps-properties-list', parent: fieldset})

	for (const key in properties) {
		if (self.get_reserved_property_keys().includes(key)) {
			continue
		}
		const value = properties[key]
		if (value===null || typeof value==='object') {
			continue // mirrors v6's own filter, special_tools.js modal_properties
		}

		const item = ui.create_dom_element({element_type: 'li', class_name: 'uca-maps-property-item', parent: list})

		ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'uca-maps-property-key',
			text_content	: key + ':',
			parent			: item
		})

		const value_input = ui.create_dom_element({element_type: 'input', class_name: 'uca-maps-property-value', parent: item})
		value_input.type  = 'text'
		value_input.value = String(value)
		value_input.addEventListener('change', () => self.set_property(layer, key, value_input.value))

		const delete_btn = ui.create_dom_element({element_type: 'button', class_name: 'uca-maps-property-delete', text_content: '✕', parent: item})
		delete_btn.type	= 'button'
		delete_btn.title	= self.get_tool_label('properties_delete_button') || 'Delete'
		delete_btn.addEventListener('click', () => self.delete_property(layer, key))
	}

	// add-new mini form
		const add_row = ui.create_dom_element({element_type: 'div', class_name: 'uca-maps-property-add', parent: fieldset})
		const key_input = ui.create_dom_element({element_type: 'input', class_name: 'uca-maps-property-add-key', parent: add_row})
		key_input.type			= 'text'
		key_input.placeholder	= self.get_tool_label('properties_key_placeholder') || 'Key'
		const value_input = ui.create_dom_element({element_type: 'input', class_name: 'uca-maps-property-add-value', parent: add_row})
		value_input.type		 = 'text'
		value_input.placeholder = self.get_tool_label('properties_value_placeholder') || 'Value'
		const add_btn = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'uca-maps-property-add-button',
			text_content	: self.get_tool_label('properties_add_button') || 'Add',
			parent			: add_row
		})
		add_btn.type = 'button'
		add_btn.addEventListener('click', () => {
			if (self.set_property(layer, key_input.value, value_input.value)) {
				key_input.value	= ''
				value_input.value	= ''
			}
		})

}//end render_properties_editor



/** Vector download formats, in menu order — GeoJSON stays client-only
* (`object_console.js` `download_vector`); SHP/KML round-trip through the
* server's `vector_download` action (hito 3). */
const VECTOR_FORMATS = ['geojson', 'shp', 'kml']

/**
* RENDER_DOWNLOAD_BUTTON
* Format `<select>` (GeoJSON/SHP/KML, hito 3 — was a single GeoJSON-only
* button through hito 2b) + one "Download" button reading the select's
* current value at click time.
*
* @param {Object} self
* @param {Object} layer
* @param {HTMLElement} container
* @returns {void}
*/
const render_download_button = function(self, layer, container) {

	const row = ui.create_dom_element({element_type: 'div', class_name: 'uca-maps-download', parent: container})

	const select = ui.create_dom_element({
		element_type	: 'select',
		class_name		: 'uca-maps-download-format',
		parent			: row
	})

	for (const format of VECTOR_FORMATS) {
		ui.create_dom_element({
			element_type	: 'option',
			value			: format,
			text_content	: self.get_tool_label('vector_format_' + format) || format,
			parent			: select
		})
	}

	const button = ui.create_dom_element({
		element_type	: 'button',
		class_name		: 'uca-maps-download-button',
		text_content	: self.get_tool_label('download_button') || 'Download',
		parent			: row
	})
	button.type = 'button'
	button.addEventListener('click', () => self.download_vector(layer, select.value))

}//end render_download_button



/**
* RENDER_CAPABILITIES
* Calls self.get_capabilities() and renders one row per probed binary.
* Unchanged from hito 1 beyond its new home (the anchored panel instead of
* the modal body).
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
