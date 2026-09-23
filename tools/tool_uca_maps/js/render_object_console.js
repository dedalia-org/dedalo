// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global L */
/*eslint no-undef: "error"*/



/**
* RENDER_OBJECT_CONSOLE
* DOM for the panel object_console.js anchors to the live map. Toolbar
* refactor (2026-09-04, CLAUDE.local.md "Left toolbar"): this panel is now
* functionality #3 ONLY (header + the selected-object section) — server
* capabilities moved to `render_capabilities_panel.js` (dev-only, its own
* button) and "Download map as image" moved to `render_map_image_download.js`
* (its own button), both through `toolbar.js`. `render_selected_object`
* builds the full per-geometry-type object section (style/properties/
* download/centroid/uncertainty/hierarchy) — every mutation handler it wires
* lives in `object_console.js`, never here (this module only builds DOM and
* reads state, per the project's render/logic split).
*
* @module render_object_console
*/



import {ui} from '../../../core/common/js/ui.js'
import {is_onexone_marker, is_onexone_rectangle} from './onexone_flags.js'
import {svg_node} from './svg.js'

// Deliberately NO import from './object_console.js' — object_console.js
// already imports {render_console_panel, render_selected_object,
// render_placeholder} FROM this file (the established one-directional
// convention across every render_X.js/X.js pair in tools/: logic imports
// render, never the reverse); an import back here would close a 2-node
// cycle (review-diff tripwire-integrity finding, 2026-09-02). Every mutator
// this file needs is called as self.<method>(...) — thin prototype wrappers
// defined in tool_uca_maps.js, same pattern as self.get_tool_label(...)/
// self.get_capabilities() already used since hito 1.



/**
* RENDER_CONSOLE_PANEL
* Populates the panel shell `toolbar.js`'s `create_toolbar_panel` already
* built and appended to the map container — header + the selected-object
* section only (see file header for where capabilities/map-image moved).
*
* @param {Object} self - tool_uca_maps instance
* @param {HTMLElement} panel - the panel shell (`toolbar.js` create_toolbar_panel)
* @returns {HTMLElement} panel
*/
export const render_console_panel = function(self, panel) {

	// header
		const header = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'uca-maps-panel-header',
			parent			: panel
		})
		ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'uca-maps-panel-title',
			text_content	: self.get_tool_label('uca_maps_control_title') || 'UCA Maps',
			parent			: header
		})

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

/** v6's `img/escala-<tier>.png` bands, sampled from the binaries themselves
* (240x32, six 40px bands). Six PNGs became one inline SVG for the reason
* C-01 and the compass give: no binary to serve, and it scales.
*
* The six hues live in the stylesheet (`--uca_maps_uncertainty_1..6`), not
* here: a data ramp is a paint like any other, and a paint spelled in JS is
* one the palette cannot reach (colour_literal_ratchet_tripwire). They are
* theme-INVARIANT on purpose — the strip means the same thing in both themes,
* so its dark twins carry the same values. */
const UNCERTAINTY_TIERS = 6



/**
* RENDER_UNCERTAINTY_SCALE
* The green-to-red band strip with the ring on the current tier — v6 draws
* it in BOTH consoles it appears in (`create_div_incertidumbre` for the
* polygon, `create_div_oneXone` for the 1x1 marker), so it is built once
* here. `title` carries the stored value, as v6's `img.title` did.
*
* @param {number} tier - 1..6
* @param {string|null} title
* @param {HTMLElement} container
* @returns {HTMLElement}
*/
const render_uncertainty_scale = function(tier, title, container) {

	const index	= Math.min(Math.max(parseInt(tier, 10) || 1, 1), UNCERTAINTY_TIERS) - 1
	const cx	= (index * 40) + 20

	const children = []
	for (let i = 0; i < UNCERTAINTY_TIERS; i++) {
		children.push(svg_node('rect', {
			class	: 'uca-maps-uncertainty-band uca-maps-uncertainty-band-' + (i + 1),
			x		: i * 40,
			y		: 0,
			width	: 40,
			height	: 32
		}))
	}
	// the ring marking the current tier: two circles, painted by the sheet
	children.push(svg_node('circle', {class: 'uca-maps-uncertainty-ring', cx: cx, cy: 16, r: 7}))
	children.push(svg_node('circle', {class: 'uca-maps-uncertainty-pip', cx: cx, cy: 16, r: 2.5}))

	const node = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'uca-maps-uncertainty-scale',
		parent			: container
	})
	node.appendChild(svg_node('svg', {
		viewBox			: '0 0 240 32',
		'aria-hidden'	: 'true',
		focusable		: 'false'
	}, children))
	// an attribute, never markup: the stored value is data
	if (title) {
		node.setAttribute('title', title)
	}

	return node
}//end render_uncertainty_scale



/**
* RENDER_ONEXONE_REFERENCE
* v6's `create_div_oneXone` (`special_tools.js:5200`, called from the marker
* branch of its console): the marker a 1x1 was built around says what it is
* and shows the scale of the rectangle it anchors. The tier is hardcoded 1,
* as in v6 — a 1 m² polygon can fall in no other band.
*
* @param {Object} self
* @param {Object} layer
* @param {HTMLElement} container
* @returns {void}
*/
const render_onexone_reference = function(self, layer, container) {

	if (!is_onexone_marker(layer)) {
		return
	}

	ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'uca-maps-onexone-reference',
		text_content	: self.get_tool_label('onexone_point_reference')
			|| 'Reference point of a 1 m² polygon',
		parent			: container
	})
	ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'uca-maps-onexone-uncertainty-label',
		text_content	: (self.get_tool_label('uncertainty_label') || 'Uncertainty') + ':',
		parent			: container
	})
	render_uncertainty_scale(1, '1', container)

}//end render_onexone_reference



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

	// BEFORE the container is cleared, never during the build: writing the
	// measurement marks the record dirty, and `update_draw_data`'s own
	// `updated_layer_data_*` publish re-enters this very function. Doing it
	// first means the re-entrant pass finishes before this one starts
	// clearing and appending, instead of interleaving two builds in one
	// container.
	if (!is_image_carrier(layer)) {
		self.sync_measurements(layer)
	}

	const object_section = self.panel_node.querySelector('.uca-maps-object-section')
	if (!object_section) {
		return
	}
	object_section.replaceChildren()

	const kind = get_geometry_kind(layer)

	// An image overlay's carrier rectangle is NOT a drawn geometry the user
	// styles or measures — it is a handle on a picture. v6 swaps the whole
	// panel body for the image controls too (`special_tools.js:6230`,
	// `load_overlay`), rather than showing "Area: 0.4 km²" for a photograph.
	if (is_image_carrier(layer)) {
		render_image_controls(self, layer, object_section)
		return
	}
	ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'uca-maps-object-type',
		text_content	: GEOMETRY_LABELS[kind],
		parent			: object_section
	})

	render_onexone_reference(self, layer, object_section)

	const info = self.compute_info(layer)
	if (info) {
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'uca-maps-object-info',
			text_content	: (self.get_tool_label('info_' + info.label_key) || info.label) + ': ' + info.value,
			parent			: object_section
		})
	}

	// ORDER IS v6's (`special_tools.js` `set_info_console`, the polygon
	// branch): type → measurement → elevation → the three checkboxes that
	// belong under it (Geoman edition, centroid, uncertainty) → hierarchy →
	// the action sections → properties LAST. Restored 2026-09-21 (functional
	// audit): style used to sit between the elevation and the checkboxes,
	// and properties above the images and the download.
	// The elevation line is the HEADING of the block the three checkboxes
	// live in, not a line of its own above them (functional audit,
	// 2026-09-22) — and the PDF export rides inside the properties
	// section, because what it exports is the properties.
	const elevation_section = render_elevation(self, layer, object_section)

	render_geoman_control(self, layer, elevation_section)
	render_centroid_control(self, layer, elevation_section)
	render_uncertainty_control(self, layer, elevation_section)

	render_style_controls(self, layer, object_section)
	render_hierarchy_controls(self, layer, object_section)
	render_download_button(self, layer, object_section)
	render_object_images(self, layer, object_section)
	render_properties_editor(self, layer, object_section)

}//end render_selected_object



/**
* RENDER_GEOMAN_CONTROL
* v6's "Edición Geoman activa" checkbox, directly under the elevation line
* (`special_tools.js` `create_div_geoman_edition_mode`). Ported 2026-09-21.
*
* The box shows the object's stored state when it has one, and otherwise
* whatever the CORE currently has on that layer — an object nobody has
* ticked is not lying about being editable just because this tool has no
* opinion on it yet (see `object_console.js` `is_geoman_edition` for why
* this tool only overrides explicit states).
*
* @param {Object} self
* @param {Object} layer
* @param {HTMLElement} container
* @returns {void}
*/
const render_geoman_control = function(self, layer, container) {

	const row = ui.create_dom_element({element_type: 'label', class_name: 'uca-maps-field uca-maps-checkbox uca-maps-geoman', parent: container})
	const input = ui.create_dom_element({element_type: 'input', parent: row})
	input.type		= 'checkbox'
	input.checked	= self.has_geoman_edition(layer)
		? self.is_geoman_edition(layer)
		: Boolean(layer.pm && typeof layer.pm.enabled==='function' && layer.pm.enabled())
	ui.create_dom_element({
		element_type	: 'span',
		text_content	: self.get_tool_label('geoman_edition_label') || 'Geoman editing active',
		parent			: row
	})
	input.addEventListener('change', () => self.set_geoman_edition(layer, input.checked))

}//end render_geoman_control



/**
* IS_IMAGE_CARRIER
* True for the transparent rectangle an uploaded image overlay rides on
* (`image_upload.js` — `properties.uca_maps.image` is what the descriptor is
* stored under, and it is the ONLY thing that distinguishes the carrier from
* a rectangle the user drew).
*
* @param {Object} layer
* @returns {boolean}
*/
const is_image_carrier = function(layer) {
	const properties = layer && layer.feature && layer.feature.properties
	return !!(properties && properties.uca_maps && properties.uca_maps.image)
}//end is_image_carrier



/**
* RENDER_IMAGE_CONTROLS
* The console's image branch (functionality #3's image half, v6
* `special_tools.js:6453-6523`): open the original, and edit opacity +
* z-index, and "Activar edición" — the checkbox that puts the overlay's three
* control points on the map as draggable handles (hito 14, image_edit.js).
*
* @param {Object} self
* @param {Object} layer
* @param {HTMLElement} container
* @returns {void}
*/
const render_image_controls = function(self, layer, container) {

	const image = layer.feature.properties.uca_maps.image

	const href = self.get_image_href(layer)
	if (href) {
		const link = ui.create_dom_element({
			element_type	: 'a',
			class_name		: 'uca-maps-image-view',
			text_content	: self.get_tool_label('image_view') || 'View image',
			parent			: container
		})
		link.href	= href
		link.target	= '_blank'
		link.rel	= 'noopener noreferrer'
	}

	// v6's own order: view, edit, opacity, z-index (`special_tools.js:6453`)
	const edit_row = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'uca-maps-image-row',
		parent			: container
	})
	const edit_input = ui.create_dom_element({
		element_type	: 'input',
		class_name		: 'uca-maps-image-edit',
		parent			: edit_row
	})
	edit_input.type		= 'checkbox'
	edit_input.checked	= self.is_image_editing(layer)
	ui.create_dom_element({
		element_type	: 'label',
		text_content	: self.get_tool_label('image_edit') || 'Enable editing',
		parent			: edit_row
	})
	edit_input.addEventListener('change', () => {
		self.set_image_interactive(layer, edit_input.checked)
	})

	const opacity_row = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'uca-maps-image-row',
		parent			: container
	})
	ui.create_dom_element({
		element_type	: 'label',
		text_content	: self.get_tool_label('image_opacity') || 'Opacity',
		parent			: opacity_row
	})
	const opacity_input = ui.create_dom_element({
		element_type	: 'input',
		class_name		: 'uca-maps-image-opacity',
		parent			: opacity_row
	})
	opacity_input.type	= 'range'
	opacity_input.min	= '0'
	opacity_input.max	= '1'
	opacity_input.step	= '0.05'
	opacity_input.value	= String(typeof image.opacity==='number' ? image.opacity : 1)
	// 'input' previews while dragging, 'change' is the one that commits — see
	// set_image_display's own do_commit note
	opacity_input.addEventListener('input', () => {
		self.set_image_display(layer, {opacity: parseFloat(opacity_input.value)}, false)
	})
	opacity_input.addEventListener('change', () => {
		self.set_image_display(layer, {opacity: parseFloat(opacity_input.value)}, true)
	})

	const z_row = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'uca-maps-image-row',
		parent			: container
	})
	ui.create_dom_element({
		element_type	: 'label',
		text_content	: self.get_tool_label('image_z_index') || 'z-index',
		parent			: z_row
	})
	const z_input = ui.create_dom_element({
		element_type	: 'input',
		class_name		: 'uca-maps-image-z-index',
		parent			: z_row
	})
	z_input.type	= 'number'
	z_input.step	= '1'
	z_input.value	= String(typeof image.z_index==='number' ? image.z_index : 200)
	z_input.addEventListener('change', () => {
		self.set_image_display(layer, {z_index: parseInt(z_input.value, 10)}, true)
	})

}//end render_image_controls



/**
* RENDER_STYLE_CONTROLS
* Every `L.Path` (circle/polygon/polyline; NOT `L.Marker`, which has no
* fill/stroke to speak of).
*
* The fields and their ranges are v6's, from the modal its "Editar estilos"
* button opens (`special_tools.js` `polygon_circle_style`): width 1..100
* step 1, both opacities 0..1 step 0.1, dash 0..100 step 2. Stroke opacity
* and dashed border were missing until 2026-09-21, and the width was a
* number box rather than the slider v6 gives it (functional audit).
* ONE colour field paints border and body alike, which is v6's own model
* (`polygon_circle_style` has a single wheel). This port started with a fill
* colour only — the core's popup edits the stroke for free — then briefly
* had two fields; the audit settled on v6's single colour on 2026-09-22.
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

	const fieldset = ui.create_dom_element({element_type: 'div', class_name: 'uca-maps-section uca-maps-style-controls', parent: container})
	ui.create_dom_element({
		element_type	: 'h6',
		text_content	: self.get_tool_label('style_title') || 'Style',
		parent			: fieldset
	})

	// ONE colour for the whole object — border and body, as in v6. The stored
	// stroke colour may carry alpha, so it is cut to the 7 characters an
	// `input type=color` accepts, exactly as v6 does.
		const color_row = ui.create_dom_element({element_type: 'label', class_name: 'uca-maps-field', parent: fieldset})
		ui.create_dom_element({
			element_type	: 'span',
			text_content	: self.get_tool_label('style_color') || 'Color',
			parent			: color_row
		})
		const color_input = ui.create_dom_element({element_type: 'input', class_name: 'uca-maps-style-color', parent: color_row})
		color_input.type  = 'color'
		color_input.value = String(properties.color || layer.options.color || style.fillColor || '#3388ff').substr(0, 7)
		color_input.addEventListener('change', () => self.set_object_color(layer, color_input.value))

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
		opacity_input.step	= '0.1'
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
		const weight_input = ui.create_dom_element({element_type: 'input', class_name: 'uca-maps-style-weight', parent: weight_row})
		weight_input.type	= 'range'
		weight_input.min	= '1'
		weight_input.max	= '100'
		weight_input.step	= '1'
		weight_input.value = style.weight!=null ? style.weight : (layer.options.weight!=null ? layer.options.weight : 3)
		weight_input.addEventListener('change', () => self.set_style_field(layer, 'weight', Number(weight_input.value)))

	// stroke opacity
		const stroke_opacity_row = ui.create_dom_element({element_type: 'label', class_name: 'uca-maps-field', parent: fieldset})
		ui.create_dom_element({
			element_type	: 'span',
			text_content	: self.get_tool_label('style_stroke_opacity') || 'Stroke opacity',
			parent			: stroke_opacity_row
		})
		const stroke_opacity_input = ui.create_dom_element({element_type: 'input', class_name: 'uca-maps-style-stroke-opacity', parent: stroke_opacity_row})
		stroke_opacity_input.type	= 'range'
		stroke_opacity_input.min	= '0'
		stroke_opacity_input.max	= '1'
		stroke_opacity_input.step	= '0.1'
		stroke_opacity_input.value	= style.opacity!=null
			? style.opacity
			: (layer.options.opacity!=null ? layer.options.opacity : 1)
		stroke_opacity_input.addEventListener('change', () => self.set_style_field(layer, 'opacity', Number(stroke_opacity_input.value)))

	// dashed border — 0 means solid, and is stored as a cleared field rather
	// than the string '0' so `layer.options.dashArray` goes back to null
		const dash_row = ui.create_dom_element({element_type: 'label', class_name: 'uca-maps-field', parent: fieldset})
		ui.create_dom_element({
			element_type	: 'span',
			text_content	: self.get_tool_label('style_dash') || 'Dashed border',
			parent			: dash_row
		})
		const dash_input = ui.create_dom_element({element_type: 'input', class_name: 'uca-maps-style-dash', parent: dash_row})
		dash_input.type		= 'range'
		dash_input.min		= '0'
		dash_input.max		= '100'
		dash_input.step		= '2'
		dash_input.value	= style.dashArray!=null ? parseInt(style.dashArray, 10) : 0
		dash_input.addEventListener('change', () => {
			const dash = parseInt(dash_input.value, 10)
			self.set_style_field(layer, 'dashArray', dash>0 ? String(dash) : null)
		})

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

	// v6 hides it on a 1x1 (`create_div_centroid`'s own `!is_oneXone` guard):
	// the rectangle already IS the reference around a point.
	if ((!(layer instanceof L.Circle) && !(layer instanceof L.Polygon)) || is_onexone_rectangle(layer)) {
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
		render_uncertainty_scale(uncertainty.scale_tier, uncertainty.value, container)
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

	const fieldset = ui.create_dom_element({element_type: 'div', class_name: 'uca-maps-section uca-maps-hierarchy-controls', parent: container})
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

	const fieldset = ui.create_dom_element({element_type: 'div', class_name: 'uca-maps-section uca-maps-properties-editor', parent: container})
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

	render_pdf_export(self, layer, fieldset)

}//end render_properties_editor



/**
* RENDER_PDF_EXPORT
* One button at the foot of the PROPERTIES section, because what the
* document carries is the properties (plus the geometry and the associated
* images) — which is where v6 puts it too (`special_tools.js` `create_pdf`).
* It spent 2026-09-21 as a titled section of its own; the audit undid that
* the next day.
*
* @param {Object} self
* @param {Object} layer
* @param {HTMLElement} container - the properties section
* @returns {void}
*/
const render_pdf_export = function(self, layer, container) {

	const pdf_btn = ui.create_dom_element({
		element_type	: 'button',
		class_name		: 'uca-maps-property-pdf-button',
		text_content	: self.get_tool_label('properties_pdf_button') || 'Export as PDF',
		parent			: container
	})
	pdf_btn.type = 'button'
	pdf_btn.addEventListener('click', async function() {

		// direction read off the DOM, never a cached flag (hito 3c corollary)
		if (pdf_btn.disabled) {
			return
		}
		pdf_btn.disabled = true
		try {
			await self.download_object_pdf(layer)
		} finally {
			if (pdf_btn.isConnected) {
				pdf_btn.disabled = false
			}
		}
	})

}//end render_pdf_export



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
* Titled since 2026-09-21 (functional audit): a bare "Download" next to a
* format list does not say WHAT is downloaded. v6 names it on the button
* itself — "Descargar Vectorial" (`special_tools.js`
* `create_div_options_buttons`) — which it can afford because it has no
* format picker beside it.
*
* @param {Object} self
* @param {Object} layer
* @param {HTMLElement} container
* @returns {void}
*/
const render_download_button = function(self, layer, container) {

	const fieldset = ui.create_dom_element({element_type: 'div', class_name: 'uca-maps-section uca-maps-download-section', parent: container})
	ui.create_dom_element({
		element_type	: 'h6',
		text_content	: self.get_tool_label('download_title') || 'Vector download',
		parent			: fieldset
	})

	const row = ui.create_dom_element({element_type: 'div', class_name: 'uca-maps-download', parent: fieldset})

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
* RENDER_ELEVATION
* The section heading the three checkboxes hang from, and the altitude at
* the same time: "Elevation of the centre" while nothing is known,
* "Elevation of the centre: 412 m" once the server answers
* (`object_console.js` `fetch_elevation`). The two labels are v6's
* (`special_tools.js` `create_div_elevation`: a marker gets "Elevación",
* everything else "Elevación del centro").
*
* A FAILED lookup leaves the bare heading — no "not available" (functional
* audit, 2026-09-22): the service is third-party and can be down for days
* (its TLS certificate expired on 2026-09-20), and a heading that accuses
* itself on every click is noise. v6 leaves the line blank for the same
* outcome, having no error branch at all.
*
* The heading is drawn IMMEDIATELY and completed later: the request is a
* third-party round trip and the rest of the console must not wait for it.
* The panel may be closed, or another object selected, before the answer
* lands, so the fill checks that this very node is still in the document —
* writing into a detached node would be harmless; writing into the node of
* a DIFFERENT object would be a lie.
*
* @param {Object} self - tool_uca_maps instance
* @param {Object} layer
* @param {HTMLElement} parent
* @returns {HTMLElement} the section the checkboxes are appended to
*/
const render_elevation = function(self, layer, parent) {

	const is_marker	= layer instanceof L.Marker
	const label		= is_marker
		? (self.get_tool_label('elevation') || 'Elevation')
		: (self.get_tool_label('elevation_center') || 'Elevation of the centre')

	const fieldset = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'uca-maps-section uca-maps-elevation-section',
		parent			: parent
	})
	const node = ui.create_dom_element({
		element_type	: 'h6',
		class_name		: 'uca-maps-object-elevation',
		text_content	: label,
		parent			: fieldset
	})

	self.fetch_elevation(layer).then(function(result) {

		if (!node.isConnected || result.unavailable) {
			return
		}
		node.textContent = label + ': ' + result.elevation + ' m'
	})

	return fieldset
}//end render_elevation


/**
* RENDER_OBJECT_IMAGES
* Fila #3's associated-image block: a file picker that uploads and associates
* in ONE gesture, then, under its own subtitle, the gallery of what is
* already associated. Nothing is saved to the record behind the user's back —
* the association marks it dirty, exactly as drawing a shape does, and the
* component's own save button is still what commits it.
*
* v6 splits this across two modal dialogs ("Asociar imagen al objeto" and
* "Galería", `special_tools.js:4528`/`:4717`), and asks for a confirming
* click inside the first. Here both live in the console panel that is already
* open on that object, because there is nothing modal about either: a modal
* would hide the very geometry the pictures belong to.
*
* Each thumbnail is a LINK to the full image, opened in a new tab rather than
* through a lightbox library — v6 vendors `simpleLightbox` for this; a new tab
* costs no dependency and gives the user the browser's own zoom, download and
* back button.
*
* @param {Object} self - tool_uca_maps instance
* @param {Object} layer
* @param {HTMLElement} parent
* @returns {void}
*/
const render_object_images = function(self, layer, parent) {

	const container = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'uca-maps-section uca-maps-object-images',
		parent			: parent
	})

	ui.create_dom_element({
		element_type	: 'h6',
		text_content	: self.get_tool_label('object_images_title') || 'Associate image',
		parent			: container
	})

	// ORDER: the action first, what it produced second (2026-09-21,
	// functional audit). The gallery used to be built here, ABOVE the file
	// picker, so associating a picture pushed the picker and its button down
	// the panel — the control moved every time it was used. v6 does not have
	// the problem because they are two separate buttons/modals, "Asociar
	// imagen" and "Galería" (`special_tools.js` `info_console_load_properties`),
	// which is also where the subtitle below comes from.
	const file_input = ui.create_dom_element({
		element_type	: 'input',
		type			: 'file',
		class_name		: 'uca-maps-object-image-file',
		parent			: container
	})
	file_input.accept = 'image/jpeg,image/png'

	const status = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'uca-maps-object-image-status',
		parent			: container
	})

	ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'uca-maps-object-gallery-title',
		text_content	: self.get_tool_label('object_images_gallery_title') || 'Gallery',
		parent			: container
	})

	const gallery = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'uca-maps-object-gallery',
		parent			: container
	})
	populate_object_gallery(self, layer, gallery)

	// CHOOSING THE FILE IS THE WHOLE GESTURE (2026-09-22, functional audit):
	// there is no second "Associate" button. Picking a picture for an object
	// means associating it, and a confirm button that can only ever be
	// pressed once, right after, is a step that asks nothing.
	file_input.addEventListener('change', async function() {

		// the direction is read off the DOM, never off a cached flag: the
		// picker is disabled for the whole round trip and re-enabled from the
		// node itself (same law as toolbar panel visibility, hito 3c)
		if (file_input.disabled) {
			return
		}
		file_input.disabled = true
		status.textContent = self.get_tool_label('object_images_uploading') || 'Uploading…'

		const result = await self.associate_image(layer, file_input.files && file_input.files[0])

		// the panel may be gone, or showing another object, by now
		if (!status.isConnected) {
			return
		}
		file_input.disabled = false

		if (!result.ok) {
			status.textContent = result.error || ''
			return
		}
		status.textContent = ''
		file_input.value = ''
		// the association landed on `layer` either way; the gallery is only
		// repainted when `layer` is still the object this panel is showing
		if (result.still_shown) {
			populate_object_gallery(self, layer, gallery)
		}
	})

}//end render_object_images



/**
* POPULATE_OBJECT_GALLERY
* Rebuilds the thumbnail list from the stored descriptors. Rebuilt whole on
* every change rather than patched, the same criterion `populate_object_viewer`
* uses: the list is short and bounded (30), and a patched list is where a
* stale index silently detaches the wrong picture.
*
* @param {Object} self - tool_uca_maps instance
* @param {Object} layer
* @param {HTMLElement} gallery
* @returns {void}
*/
const populate_object_gallery = function(self, layer, gallery) {

	gallery.replaceChildren()

	const images = self.object_images(layer)
	if (images.length===0) {
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'uca-maps-object-gallery-empty',
			text_content	: self.get_tool_label('object_images_empty') || 'No images associated yet.',
			parent			: gallery
		})
		return
	}

	images.forEach(function(image, index) {

		const url = self.object_image_url(image)
		if (!url) {
			return
		}

		const item = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'uca-maps-object-gallery-item',
			parent			: gallery
		})

		const link = ui.create_dom_element({
			element_type	: 'a',
			class_name		: 'uca-maps-object-gallery-link',
			parent			: item
		})
		link.href	= url
		link.target	= '_blank'
		link.rel	= 'noopener noreferrer'
		link.title	= image.name || String(image.section_id)

		const thumb = ui.create_dom_element({
			element_type	: 'img',
			class_name		: 'uca-maps-object-gallery-thumb',
			parent			: link
		})
		thumb.src = url
		thumb.alt = image.name || ''

		const remove = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'uca-maps-object-gallery-remove',
			text_content	: '×',
			parent			: item
		})
		remove.title = self.get_tool_label('object_images_remove') || 'Remove from this object'

		remove.addEventListener('click', function() {
			self.remove_object_image(layer, index)
			populate_object_gallery(self, layer, gallery)
		})
	})

}//end populate_object_gallery



// @license-end
