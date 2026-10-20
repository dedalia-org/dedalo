// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global L */
/*eslint no-undef: "error"*/



/**
* RENDER_OBJECT_CONSOLE
* DOM for the object console panel: a header and the per-geometry object
* section. Every mutation handler it wires lives in `object_console.js`;
* this module only builds DOM and reads state.
*
* @module render_object_console
*/



import {ui} from '../../../core/common/js/ui.js'
import {is_onexone_marker, is_onexone_rectangle} from './onexone_flags.js'
import {carrier_image} from './uca_maps_data.js'
import {svg_node} from './svg.js'
import {DEFAULT_IMAGE_DOWNLOAD_NAME} from './download_filename.js'
import {bind_download_button, create_panel_message, show_panel_message} from './render_download_line.js'

// No import from './object_console.js': it imports this file (logic imports
// render, never the reverse), and an import back would close a cycle. Every
// mutator is called as self.<method>(...), a thin wrapper in tool_uca_maps.js.



/**
* RENDER_CONSOLE_PANEL
* Populates the panel shell `toolbar.js` create_toolbar_panel built: the
* header and the selected-object section.
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
* Shown before any geometry is clicked, and again when the selected layer is
* removed (`object_console.js` `pm:remove`), so the panel never keeps
* controls for a layer that no longer exists.
*
* @param {Object} self - tool_uca_maps instance
* @param {HTMLElement} [given_container] - defaults to the panel's own object
*   section (self.panel_node)
* @returns {void}
*/
export const render_placeholder = function(self, given_container) {
	const container = given_container || (self.panel_node && self.panel_node.querySelector('.uca-maps-object-section'))
	if (!container) {
		return
	}
	container.replaceChildren()
	ui.create_dom_element({
		element_type	: 'p',
		class_name		: 'uca-maps-empty-state',
		text_content	: self.get_tool_label('no_object_selected') || 'Click a drawn geometry to inspect it.',
		parent			: container
	})
}//end render_placeholder



/**
* GEOMETRY_LABEL
* The object's kind as the console heads it. One literal key per kind, so the
* label census sees every one.
*
* @param {Object} self - tool_uca_maps instance
* @param {string} kind - get_geometry_kind's answer
* @returns {string}
*/
const geometry_label = function(self, kind) {
	switch (kind) {
		case 'marker'	: return self.get_tool_label('geometry_marker') || 'Marker'
		case 'circle'	: return self.get_tool_label('geometry_circle') || 'Circle'
		case 'polygon'	: return self.get_tool_label('geometry_polygon') || 'Polygon'
		case 'polyline'	: return self.get_tool_label('geometry_polyline') || 'Polyline'
		default			: return self.get_tool_label('geometry_object') || 'Object'
	}
}//end geometry_label

/** v6's `img/escala-<tier>.png` bands (240x32, six 40px bands) as one inline
* SVG: no binary to serve, and it scales. The hues live in the sheet
* (`--uca_maps_uncertainty_1..6`), where the palette reaches them, and are
* theme-invariant: the strip means the same thing in both themes. */
const UNCERTAINTY_TIERS = 6



/**
* RENDER_UNCERTAINTY_SCALE
* The green-to-red band strip with the ring on the current tier, shared by
* the polygon and the 1x1 marker as in v6 (`create_div_incertidumbre`,
* `create_div_oneXone`). `title` carries the stored area, as v6's did.
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
* v6's `create_div_oneXone` (`special_tools.js`): the marker a 1x1 was built
* around says what it is and shows the scale of its rectangle. The tier is
* always 1, as in v6: a 1 m² polygon can fall in no other band.
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
	render_uncertainty_scale(1, self.format_polygon_area(1), container)

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
* RENDER_CHECKBOX_ROW
* The shape every checkbox row of the console shares: a `label` holding an
* unclassed checkbox and its text, so the whole row toggles it.
*
* @param {HTMLElement} container
* @param {string} class_name - the row's classes
* @param {boolean} checked
* @param {string} text
* @returns {HTMLInputElement} the checkbox
*/
const render_checkbox_row = (container, class_name, checked, text) => {

	const row = ui.create_dom_element({element_type: 'label', class_name: class_name, parent: container})
	const input = ui.create_dom_element({element_type: 'input', parent: row})
	input.type		= 'checkbox'
	input.checked	= checked
	ui.create_dom_element({
		element_type	: 'span',
		text_content	: text,
		parent			: row
	})

	return input
}//end render_checkbox_row



/**
* SET_RANGE
* Makes `input` a slider. `value` goes LAST: set before `max`, the browser
* clamps it to the default 0..100.
*
* @param {HTMLInputElement} input
* @param {string} min
* @param {string} max
* @param {string} step
* @param {*} value
* @returns {void}
*/
const set_range = (input, min, max, step, value) => {
	input.type	= 'range'
	input.min	= min
	input.max	= max
	input.step	= step
	input.value	= value
}//end set_range



/**
* RENDER_NEW_TAB_LINK
* A link that opens in a new tab without handing the opened page
* `window.opener`.
*
* @param {string} class_name
* @param {string|undefined} text
* @param {string} href
* @param {HTMLElement} parent
* @returns {HTMLAnchorElement}
*/
const render_new_tab_link = (class_name, text, href, parent) => {

	const link = ui.create_dom_element({
		element_type	: 'a',
		class_name		: class_name,
		text_content	: text,
		parent			: parent
	})
	link.href	= href
	link.target	= '_blank'
	link.rel	= 'noopener noreferrer'

	return link
}//end render_new_tab_link



/**
* RENDER_PROPERTY_DELETE
* The delete button every property row ends with, link rows included.
*
* @param {Object} self
* @param {Object} layer
* @param {string} key
* @param {HTMLElement} item - the list row
* @returns {void}
*/
const render_property_delete = (self, layer, key, item) => {

	const delete_btn = ui.create_dom_element({element_type: 'button', class_name: 'uca-maps-property-delete', text_content: '✕', parent: item})
	delete_btn.type	= 'button'
	delete_btn.title	= self.get_tool_label('properties_delete_button') || 'Delete'
	delete_btn.addEventListener('click', () => self.delete_property(layer, key))
}//end render_property_delete



/**
* RENDER_SELECTED_OBJECT
* Populates the panel's object section for the currently selected layer:
* geometry type, measurement (as the core's popup, `object_console.js`
* `compute_info`), elevation and its checkboxes, style, hierarchy, downloads,
* images and properties; each section decides itself which geometries it fits.
*
* @param {Object} self - tool_uca_maps instance
* @param {Object} layer - Leaflet layer (Marker/Circle/Polygon/Polyline)
* @returns {void}
*/
export const render_selected_object = function(self, layer) {

	if (!self.panel_node) {
		return
	}

	// BEFORE the container is cleared: writing the measurement marks the record
	// dirty, and `update_draw_data`'s publish re-enters this function. Done
	// first, the re-entrant pass finishes before this one starts, instead of
	// two builds interleaving in one container.
	if (!is_image_carrier(layer)) {
		self.sync_measurements(layer)
	}

	const object_section = self.panel_node.querySelector('.uca-maps-object-section')
	if (!object_section) {
		return
	}
	object_section.replaceChildren()

	const kind = get_geometry_kind(layer)

	// An image's carrier is not measured or styled (v6 shows no area,
	// elevation, centroid or style for it), but it IS an object of the record:
	// v6 follows its image controls with the downloads and the properties
	// (`special_tools.js` `info_console_load_properties`). Polygon order.
	if (is_image_carrier(layer)) {
		render_image_controls(self, layer, object_section)
		render_image_download(self, layer, object_section)
		render_download_button(self, layer, object_section)
		render_object_images(self, layer, object_section)
		render_properties_editor(self, layer, object_section)
		return
	}
	ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'uca-maps-object-type',
		text_content	: geometry_label(self, kind),
		parent			: object_section
	})

	render_onexone_reference(self, layer, object_section)

	const info_rows = self.compute_info(layer)
	if (info_rows) {
		const info = ui.create_dom_element({element_type: 'div', class_name: 'uca-maps-object-info', parent: object_section})
		for (const row of info_rows) {
			ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'uca-maps-object-info-row',
				text_content	: (self.get_tool_label('info_' + row.label_key) || row.label) + ': ' + row.value,
				parent			: info
			})
		}
	}

	// v6's order (`special_tools.js` `set_info_console`, polygon branch): the
	// elevation line HEADS the section holding the Geoman, centroid and
	// uncertainty checkboxes; properties go LAST, the PDF export inside them
	// because what it exports is the properties.
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
* v6's "Edición Geoman activa" checkbox (`special_tools.js`
* `create_div_geoman_edition_mode`). It shows the stored state when there is
* one, otherwise what the CORE has on the layer: this tool only overrides
* explicit states (`object_console.js` `is_geoman_edition`).
*
* @param {Object} self
* @param {Object} layer
* @param {HTMLElement} container
* @returns {void}
*/
const render_geoman_control = function(self, layer, container) {

	const checked = self.has_geoman_edition(layer)
		? self.is_geoman_edition(layer)
		: Boolean(layer.pm && typeof layer.pm.enabled==='function' && layer.pm.enabled())
	const input = render_checkbox_row(container, 'uca-maps-field uca-maps-checkbox uca-maps-geoman', checked,
		self.get_tool_label('geoman_edition_label') || 'Geoman editing active')
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
	return Boolean(carrier_image(layer))
}//end is_image_carrier



/**
* RENDER_IMAGE_CONTROLS
* The console's image branch (v6 `special_tools.js`): open the original,
* "Activar edición" (the overlay's three control points become draggable
* handles, image_edit.js), opacity and z-index.
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
		render_new_tab_link('uca-maps-image-view', self.get_tool_label('image_view') || 'View image', href, container)
	}

	// v6's own order: view, edit, opacity, z-index
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
	set_range(opacity_input, '0', '1', '0.05', String(typeof image.opacity==='number' ? image.opacity : 1))
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
	// v6's own slider, 0..1000
	set_range(z_input, '0', '1000', '1', String(typeof image.z_index==='number' ? image.z_index : 200))
	// same preview/commit split as the opacity slider above
	z_input.addEventListener('input', () => {
		self.set_image_display(layer, {z_index: parseInt(z_input.value, 10)}, false)
	})
	z_input.addEventListener('change', () => {
		self.set_image_display(layer, {z_index: parseInt(z_input.value, 10)}, true)
	})

}//end render_image_controls



/** v6's formats, in its order, the first one selected (`special_tools.js`
* `show_modal_raster_download`). */
const IMAGE_DOWNLOAD_FORMATS = ['geotiff', 'png', 'jpg']

/** v6's seven quality steps and their names; 0.8 ("media") is its default.
* A factor over the on-screen size — see `image_upload.js` image_download_width. */
const IMAGE_DOWNLOAD_QUALITIES = [
	{value: 0.4, key: 'very_low'},
	{value: 0.6, key: 'low'},
	{value: 0.8, key: 'medium', selected: true},
	{value: 0.9, key: 'medium_high'},
	{value: 1, key: 'high'},
	{value: 1.5, key: 'very_high'},
	{value: 2, key: 'excellent'}
]

/**
* RENDER_IMAGE_DOWNLOAD
* v6's "Descargar Imagen" (`special_tools.js`), inline like the vector
* download beside it instead of v6's modal: format, quality, name, button.
*
* @param {Object} self
* @param {Object} layer - the image carrier
* @param {HTMLElement} container
* @returns {void}
*/
const render_image_download = function(self, layer, container) {

	const fieldset = ui.create_dom_element({element_type: 'div', class_name: 'uca-maps-section uca-maps-image-download-section', parent: container})
	ui.create_dom_element({
		element_type	: 'h6',
		text_content	: self.get_tool_label('image_download_title') || 'Image download',
		parent			: fieldset
	})

	const options_row = ui.create_dom_element({element_type: 'div', class_name: 'uca-maps-download', parent: fieldset})

	const format_select = ui.create_dom_element({
		element_type	: 'select',
		class_name		: 'uca-maps-download-format uca-maps-image-download-format',
		parent			: options_row
	})
	format_select.title = self.get_tool_label('image_download_format_label') || 'Export as'
	format_select.setAttribute('aria-label', format_select.title)
	for (const format of IMAGE_DOWNLOAD_FORMATS) {
		ui.create_dom_element({
			element_type	: 'option',
			value			: format,
			text_content	: self.get_tool_label('raster_format_' + format) || format,
			parent			: format_select
		})
	}

	const quality_select = ui.create_dom_element({
		element_type	: 'select',
		class_name		: 'uca-maps-download-format uca-maps-image-download-quality',
		parent			: options_row
	})
	quality_select.title = self.get_tool_label('image_download_quality_label') || 'Quality'
	quality_select.setAttribute('aria-label', quality_select.title)
	for (const quality of IMAGE_DOWNLOAD_QUALITIES) {
		const option = ui.create_dom_element({
			element_type	: 'option',
			value			: String(quality.value),
			text_content	: self.get_tool_label('image_quality_' + quality.key) || quality.key,
			parent			: quality_select
		})
		option.selected = quality.selected===true
	}

	const name_row = ui.create_dom_element({element_type: 'div', class_name: 'uca-maps-download', parent: fieldset})

	const name_input = ui.create_dom_element({
		element_type	: 'input',
		class_name		: 'uca-maps-image-download-name',
		parent			: name_row
	})
	name_input.type			= 'text'
	name_input.value		= DEFAULT_IMAGE_DOWNLOAD_NAME
	name_input.placeholder	= DEFAULT_IMAGE_DOWNLOAD_NAME
	name_input.title		= self.get_tool_label('map_image_name_label') || 'Name'
	name_input.setAttribute('aria-label', name_input.title)

	const button = ui.create_dom_element({
		element_type	: 'button',
		class_name		: 'uca-maps-image-download-button',
		text_content	: self.get_tool_label('download_button') || 'Download',
		parent			: name_row
	})
	button.type = 'button'
	bind_download_button(button, create_panel_message(fieldset, 'uca-maps-download-message'), () => self.download_image(
		layer, format_select.value, parseFloat(quality_select.value), name_input.value
	))

}//end render_image_download



/**
* RENDER_STYLE_CONTROLS
* Every `L.Path` (not `L.Marker`, which has no fill or stroke). Fields and
* ranges are v6's "Editar estilos" modal (`special_tools.js`
* `polygon_circle_style`): width 1..100 step 1, opacities 0..1 step 0.1,
* dash 0..100 step 2, and ONE colour for border and body, its single wheel.
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

	// the stored colour may carry alpha: cut to the 7 characters an
	// `input type=color` accepts, as v6 does
		const color_row = ui.create_dom_element({element_type: 'label', class_name: 'uca-maps-field', parent: fieldset})
		ui.create_dom_element({
			element_type	: 'span',
			text_content	: self.get_tool_label('style_color') || 'Color',
			parent			: color_row
		})
		const color_input = ui.create_dom_element({element_type: 'input', class_name: 'uca-maps-style-color', parent: color_row})
		color_input.type  = 'color'
		color_input.value = String(properties.color || layer.options.color || style.fillColor || '#3388ff').slice(0, 7)
		color_input.addEventListener('change', () => self.set_object_color(layer, color_input.value))

	// fill opacity
		const opacity_row = ui.create_dom_element({element_type: 'label', class_name: 'uca-maps-field', parent: fieldset})
		ui.create_dom_element({
			element_type	: 'span',
			text_content	: self.get_tool_label('style_fill_opacity') || 'Fill opacity',
			parent			: opacity_row
		})
		const opacity_input = ui.create_dom_element({element_type: 'input', parent: opacity_row})
		set_range(opacity_input, '0', '1', '0.1', style.fillOpacity!=null
			? style.fillOpacity
			: (layer.options.fillOpacity!=null ? layer.options.fillOpacity : 0.2))
		opacity_input.addEventListener('change', () => self.set_style_field(layer, 'fillOpacity', Number(opacity_input.value)))

	// stroke weight
		const weight_row = ui.create_dom_element({element_type: 'label', class_name: 'uca-maps-field', parent: fieldset})
		ui.create_dom_element({
			element_type	: 'span',
			text_content	: self.get_tool_label('style_weight') || 'Stroke weight',
			parent			: weight_row
		})
		const weight_input = ui.create_dom_element({element_type: 'input', class_name: 'uca-maps-style-weight', parent: weight_row})
		set_range(weight_input, '1', '100', '1', style.weight!=null ? style.weight : (layer.options.weight!=null ? layer.options.weight : 3))
		weight_input.addEventListener('change', () => self.set_style_field(layer, 'weight', Number(weight_input.value)))

	// stroke opacity
		const stroke_opacity_row = ui.create_dom_element({element_type: 'label', class_name: 'uca-maps-field', parent: fieldset})
		ui.create_dom_element({
			element_type	: 'span',
			text_content	: self.get_tool_label('style_stroke_opacity') || 'Stroke opacity',
			parent			: stroke_opacity_row
		})
		const stroke_opacity_input = ui.create_dom_element({element_type: 'input', class_name: 'uca-maps-style-stroke-opacity', parent: stroke_opacity_row})
		set_range(stroke_opacity_input, '0', '1', '0.1', style.opacity!=null
			? style.opacity
			: (layer.options.opacity!=null ? layer.options.opacity : 1))
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
		set_range(dash_input, '0', '100', '2', style.dashArray!=null ? parseInt(style.dashArray, 10) : 0)
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

	const input = render_checkbox_row(container, 'uca-maps-field uca-maps-checkbox uca-maps-centroid', has_centroid,
		self.get_tool_label('centroid_label') || 'Centroid')
	input.addEventListener('change', () => self.toggle_centroid(layer))

}//end render_centroid_control



/**
* RENDER_UNCERTAINTY_CONTROL
* Polygon only — matches v6 exactly (`object_console.js` `toggle_uncertainty`
* file header). Shows the scale tier and the stored area once enabled.
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

	const input = render_checkbox_row(container, 'uca-maps-field uca-maps-checkbox uca-maps-uncertainty', Boolean(uncertainty),
		self.get_tool_label('uncertainty_label') || 'Uncertainty')
	input.addEventListener('change', () => self.toggle_uncertainty(layer))

	if (uncertainty) {
		const area = typeof uncertainty.area_m2==='number'
			? self.format_polygon_area(uncertainty.area_m2)
			: null
		render_uncertainty_scale(uncertainty.scale_tier, area, container)
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'uca-maps-uncertainty-badge',
			text_content	: (self.get_tool_label('uncertainty_scale_tier') || 'Scale tier')
				+ ' ' + uncertainty.scale_tier + (area ? ' — ' + area : ''),
			parent			: container
		})
	}

}//end render_uncertainty_control



/**
* RENDER_HIERARCHY_CONTROLS
* Circle/polygon/polyline (not marker) — matches v6
* (`object_console.js` `set_hierarchy` file header). The two checkboxes are
* mutually exclusive ON CHECK (checking one unchecks the other, as in v6);
* unchecking leaves both clear and the layer back in its natural order.
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

	const front_input = render_checkbox_row(fieldset, 'uca-maps-field uca-maps-checkbox', Boolean(hierarchy.bringToFront),
		self.get_tool_label('hierarchy_front') || 'Front')
	const back_input = render_checkbox_row(fieldset, 'uca-maps-field uca-maps-checkbox', Boolean(hierarchy.bringToBack),
		self.get_tool_label('hierarchy_back') || 'Back')

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
* RESERVED_PROPERTY_KEYS (core- and tool-managed fields) and showing the
* layer's computed keys as read-only text. Each property is
* edited in place and commits on change, a deliberate gesture; never a
* `window.prompt`, untestable headless and worse to use.
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

	const reserved_keys = self.get_reserved_property_keys()
	const computed_keys = self.get_computed_property_keys(layer)
	// the geometry's keys lead, in their own order; the user's follow as stored
	const keys = [
		...computed_keys.filter((key) => Object.hasOwn(properties, key)),
		...Object.keys(properties).filter((key) => !computed_keys.includes(key))
	]
	for (const key of keys) {
		if (reserved_keys.includes(key)) {
			continue
		}
		const value = properties[key]
		if (value===null || typeof value==='object') {
			continue // mirrors v6's own filter, special_tools.js modal_properties
		}

		const item = ui.create_dom_element({element_type: 'li', class_name: 'uca-maps-property-item', parent: list})

		const href = catastro_link_href(properties, key, value)
		if (href) {
			render_property_link(self, layer, key, href, item)
			continue
		}

		ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'uca-maps-property-key',
			text_content	: key + ':',
			parent			: item
		})

		// still listed, since the exports and the PDF carry it, but not offered for
		// editing: the tool rewrites it from the geometry
		if (computed_keys.includes(key)) {
			ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'uca-maps-property-value uca-maps-property-computed',
				text_content	: String(value),
				parent			: item
			})
			continue
		}

		const value_input = ui.create_dom_element({element_type: 'input', class_name: 'uca-maps-property-value', parent: item})
		value_input.type  = 'text'
		value_input.value = String(value)
		value_input.addEventListener('change', () => self.set_property(layer, key, value_input.value))

		render_property_delete(self, layer, key, item)
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
		// a refused key says why, instead of the silent no-op it was in v6
		const add_message = create_panel_message(fieldset, 'uca-maps-property-add-message')
		add_btn.addEventListener('click', () => {
			const key = key_input.value.trim()
			if (key && self.is_protected_property_key(layer, key)) {
				show_panel_message(
					add_message,
					self.get_tool_label('properties_key_refused', key) || `"${key}" is already part of this object and cannot be added as a property.`,
					'warning'
				)
				return
			}
			add_message.hidden = true
			if (self.set_property(layer, key_input.value, value_input.value)) {
				key_input.value	= ''
				value_input.value	= ''
			}
		})

	render_pdf_export(self, layer, fieldset)

}//end render_properties_editor



/**
* CATASTRO_LINK_HREF
* The parcel's record URL (`catastro.js` create_catastro_parcel) reads as a
* link, like v6's `is_url` branch in `special_tools.js`, but only on a parcel
* this tool drew: a free-typed property stays text. Only http(s) — the value
* is stored data, and an `href` must never carry a `javascript:` URL.
*
* @param {Object} properties
* @param {string} key
* @param {*} value
* @returns {string|null} the href, or null to render the plain editor
*/
const catastro_link_href = function(properties, key, value) {
	if (key!=='url' || !(properties.uca_maps && properties.uca_maps.catastro===true)) {
		return null
	}
	try {
		const url = new URL(String(value))
		return (url.protocol==='https:' || url.protocol==='http:') ? url.href : null
	} catch {
		return null
	}
}//end catastro_link_href



/**
* RENDER_PROPERTY_LINK
* Read-only row: the link, titled "Catastro" instead of v6's "Más
* información", plus the same delete button every property has.
*
* @param {Object} self
* @param {Object} layer
* @param {string} key
* @param {string} href
* @param {HTMLElement} item - the list row
* @returns {void}
*/
const render_property_link = function(self, layer, key, href, item) {

	render_new_tab_link('uca-maps-property-link', self.get_tool_label('catastro_control_title') || 'Catastro', href, item)
	render_property_delete(self, layer, key, item)

}//end render_property_link



/**
* RENDER_PDF_EXPORT
* One button at the foot of the PROPERTIES section, because what the
* document carries is the properties (plus the geometry and the associated
* images), which is where v6 puts it too (`special_tools.js` `create_pdf`).
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
	bind_download_button(pdf_btn, create_panel_message(container, 'uca-maps-download-message'), () => self.download_object_pdf(layer))

}//end render_pdf_export



/** Vector download formats, in menu order. GeoJSON stays client-only
* (`object_console.js` `download_vector`); SHP/KML round-trip through the
* server's `vector_download` action. */
const VECTOR_FORMATS = ['geojson', 'shp', 'kml']

/**
* RENDER_DOWNLOAD_BUTTON
* Format `<select>` + one "Download" button reading it at click time, under
* a title: a bare "Download" beside a format list does not say WHAT is
* downloaded. v6 says it on the button, "Descargar Vectorial"
* (`special_tools.js` `create_div_options_buttons`), having no picker.
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
	bind_download_button(button, create_panel_message(fieldset, 'uca-maps-download-message'), () => self.download_vector(layer, select.value))

}//end render_download_button


/**
* RENDER_ELEVATION
* Heads the checkboxes' section (labels: v6 `special_tools.js`
* `create_div_elevation`), drawn at once and completed with the altitude when
* `fetch_elevation` answers, if the node is still connected. A failed lookup
* leaves the bare heading, as in v6: the third-party service can be down for days.
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
* A file picker that uploads and associates in ONE gesture (the record only
* turns dirty, as drawing does), then the gallery. v6's two modals live inline
* here: a modal would hide the very geometry the pictures belong to. Thumbnails
* open in a new tab instead of v6's `simpleLightbox`: no dependency to vendor.
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

	// the action first, what it produced second: a gallery above the picker
	// would push the picker down every time a picture is associated. The
	// gallery subtitle is v6's "Galería" button.
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

	// filled once the install answers whether the import is allowed
	const linked = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'uca-maps-object-linked-images',
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
	render_linked_images_import(self, layer, linked)

	// choosing the file IS the gesture: a confirm button that can only be
	// pressed once, right after, is a step that asks nothing
	file_input.addEventListener('change', async function() {

		// the state is read off the DOM, never a cached flag: the picker stays
		// disabled for the whole round trip
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
* RENDER_LINKED_IMAGES_IMPORT
* "Import N linked images", only when the install allows it and the object
* links to images not yet in Dédalo (`object_image.js` `import_linked_images`).
* An import that brings anything in commits and re-renders this panel, so the
* failures are read back from the instance while their links remain.
*
* @param {Object} self - tool_uca_maps instance
* @param {Object} layer
* @param {HTMLElement} holder
* @returns {Promise<void>}
*/
const render_linked_images_import = async function(self, layer, holder) {

	if (self.linked_images(layer).length===0 || !(await self.external_images_enabled())) {
		return
	}
	// the panel may be gone, or showing another object, by now
	if (!holder.isConnected) {
		return
	}

	const button = ui.create_dom_element({
		element_type	: 'button',
		class_name		: 'uca-maps-object-linked-import',
		parent			: holder
	})
	button.type = 'button'
	const count = self.linked_images(layer).length
	button.textContent = self.get_tool_label('object_images_import_linked', count)
		|| `Import ${count} linked images`

	const status = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'uca-maps-object-linked-status',
		parent			: holder
	})

	const show_report = function() {
		status.replaceChildren()
		const report = self._linked_import_report
		if (!report || report.layer!==layer) {
			return
		}
		const pending = self.linked_images(layer).map(entry => entry.url.trim())
		const failures = report.failures.filter(failure => pending.includes(failure.url))
		if (failures.length===0) {
			return
		}
		ui.create_dom_element({
			element_type	: 'div',
			text_content	: self.get_tool_label('object_images_import_failed')
				|| 'These links could not be imported and stay on the object:',
			parent			: status
		})
		failures.forEach(function(failure) {
			ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'uca-maps-object-linked-failure',
				text_content	: failure.url + ' — ' + failure.error,
				parent			: status
			})
		})
	}
	show_report()

	button.addEventListener('click', async function() {

		if (button.disabled) {
			return
		}
		button.disabled = true

		await self.import_linked_images(layer, function(done, total) {
			status.textContent = self.get_tool_label('object_images_importing', done + 1, total)
				|| `Importing ${done + 1} of ${total}…`
		})

		// nothing imported, nothing committed: this panel is still the live one
		if (holder.isConnected) {
			button.disabled = false
			show_report()
		}
	})
}//end render_linked_images_import



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
			class_name		: 'uca-maps-empty-state uca-maps-object-gallery-empty',
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

		const link = render_new_tab_link('uca-maps-object-gallery-link', undefined, url, item)
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
