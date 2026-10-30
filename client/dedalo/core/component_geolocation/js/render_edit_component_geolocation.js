// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/* global */
/*eslint no-undef: "error"*/



/**
* RENDER_EDIT_COMPONENT_GEOLOCATION
* Edit-mode render module for the geolocation component.
*
* This module provides:
* - `render_edit_component_geolocation`: the prototype constructor whose `.edit()` method
*   is assigned to `component_geolocation.prototype.edit` in component_geolocation.js.
* - `render_popup_text`: standalone helper that builds the HTML subtree shown in Leaflet
*   layer popups (measurement labels + optional line separators).
* - `render_color_picker`: standalone helper that builds an iro.js colour-picker widget
*   embedded in layer popups, allowing the user to change the draw colour of a selected
*   Leaflet layer without saving.
*
* The `.edit()` dispatcher on the prototype reads `self.context.view` to select among
* the available layout variants ('mini', 'print', 'line', 'default').  The 'print' branch
* intentionally falls through to 'default' after forcing read-only permissions
* (self.permissions = 1), which causes the view to suppress all editing controls.
*
* External dependencies (globals injected at runtime, not imported):
* - `iro`  — colour-picker library (iro.js), loaded on demand by render_color_picker (first swatch click)
*/

// imports
	import {ui} from '../../common/js/ui.js'
	import {render_value} from '../../common/js/utils/render_escape.js'
	import {load_script} from '../../common/js/utils/index.js'
	import {view_default_edit_geolocation} from './view_default_edit_geolocation.js'



/**
* RENDER_EDIT_COMPONENT_GEOLOCATION
* Constructor function for the edit-mode renderer prototype.
* Its methods are copied onto `component_geolocation.prototype` in component_geolocation.js.
*/
export const render_edit_component_geolocation = function() {

	return true
}//end render_edit_component_geolocation



/**
* EDIT
* Dispatches rendering to the correct view template based on `self.context.view`.
*
* Supported views:
* - 'mini'    → compact inline representation via view_mini_geolocation (e.g. autocomplete lists).
* - 'print'   → same DOM as 'default' but forces self.permissions = 1 so inputs are read-only.
*               Falls through intentionally; no break/return between 'print' and 'default'.
* - 'line'    → suppresses the component label; otherwise identical to 'default'.
* - 'default' → full interactive Leaflet map with coordinate inputs and draw toolbar.
*
* (!) The 'print' case mutates self.permissions before falling through.  Any caller that
* caches the permissions value before calling edit() will observe the side effect.
*
* @param {Object} options - Render options forwarded verbatim to the chosen view renderer.
* @returns {Promise<HTMLElement>} wrapper node produced by the selected view renderer.
*/
render_edit_component_geolocation.prototype.edit = async function(options) {

	const self = this

	// view
		const view = self.context.view || 'default'

	switch(view) {

		case 'mini': {
			const {view_mini_geolocation} = await import('./view_mini_geolocation.js')
			return view_mini_geolocation.render(self, options)
		}

		// case 'text':
		// 		return view_text_geolocation.render(self, options)

		case 'print':
			// view print use the same view as default, except it will use read only to render content_value
			// as different view as default it will set in the class of the wrapper
			// sample: <div class="wrapper_component component_input_text oh14 oh1_oh14 edit view_print disabled_component">...</div>
			// take account that to change the css when the component will render in print context
			// for print we need to use read of the content_value and it's necessary force permissions to use read only element render
			self.permissions = 1

		case 'line':
		case 'default':
		default:
			return view_default_edit_geolocation.render(self, options)
	}
}//end edit



/**
* RENDER_POPUP_TEXT
* Builds the text portion of a Leaflet layer popup from an array of label/measure objects.
*
* Each element in `ar_text_obj` may contain:
* - `label`     {string} — human-readable text (e.g. "Center: (39.46, -0.38)").
* - `messure`   {string} — unit string appended after the label (e.g. 'm', 'km²').
*                           Note: the property name "messure" is a misspelling of "measure"
*                           that is part of the data contract used across the geolocation module.
* - `separator` {boolean} — when explicitly `false`, the trailing `<br>` element is omitted.
*                            Defaults to true.
*
* The function creates one `<span>` per entry (label + space + messure) and optionally
* appends a `<br>` so each measurement appears on its own line inside the popup.
* The colour-picker widget is appended to the returned container by the caller
* (component_geolocation.get_popup_content).
*
* @param {Array} ar_text_obj - Array of `{label, messure, separator}` descriptor objects.
* @returns {HTMLElement} text_container - A `<div>` containing the assembled popup content.
*/
export const render_popup_text = function(ar_text_obj) {

	const text_container = ui.create_dom_element({
		element_type : 'div'
	})

	const text_len = ar_text_obj.length
	for (let i = 0; i < text_len; i++) {
		const current_obj	= ar_text_obj[i]
		const label			= current_obj.label || ''
		const messure		= current_obj.messure || ''
		const separator		= current_obj.separator === false
			? false
			: true

		// text_node
			ui.create_dom_element({
				element_type	: 'span',
				inner_html		: render_value(label + ' ' + messure, 'text'),
				parent			: text_container
			})

		// separator_node (br)
			if(separator) {
				ui.create_dom_element({
					element_type	: 'br',
					parent			: text_container
				})
			}
	}


	return text_container
}//end render_popup_text



/**
* RENDER_COLOR_PICKER
* Builds a colour-picker widget for a Leaflet draw layer and embeds it in the popup.
*
* The widget is a `<span>` container that holds:
* 1. A coloured swatch `<span>` (button_color_picker) — clicking toggles the colour wheel.
* 2. A text `<input>` showing the current hex colour — a 'change' event updates both the
*    swatch and the layer style and calls self.update_draw_data() to stage the change for saving.
* 3. A hidden `<div>` (color_wheel_contaniner) — contains the iro.ColorPicker instance.
*    Visibility is toggled by mouseup on the swatch.
*
* The iro.js ColorPicker emits 'color:change' events.  The `color_selected` callback
* updates the layer style via `layer.setStyle({color})`, syncs the swatch and text input,
* and calls self.update_draw_data(layer_id) to keep the in-memory GeoJSON up to date.
*
* (!) `iro` is a runtime global loaded on the first swatch click (not by load_libs).
*
* (!) The layer colour change is NOT automatically saved to the database.  The user must
* click the explicit Save button to persist draw data.
*
* @param {Object} self      - The component_geolocation instance (provides update_draw_data).
* @param {Object} layer     - A Leaflet layer (L.Circle, L.Polygon, L.Polyline, etc.).
* @param {string} layer_id  - The layer identifier used to look up the layer in self.ar_layer_loaded.
* @returns {HTMLElement} color_container - Assembled `<span>` containing swatch, input, and wheel.
*/
export const render_color_picker = function(self, layer, layer_id) {

	const layer_color = layer.options.color || '#31df25'

	const color_container = ui.create_dom_element({
		element_type	: 'span'
	})

	// color_picker
	const button_color_picker = ui.create_dom_element({
		element_type	: 'span',
		class_name		: 'button tool button_color_picker',
		parent			: color_container
	})
	button_color_picker.style.backgroundColor = layer_color

	const text_color = ui.create_dom_element({
		element_type	: 'input',
		type			: 'text',
		value 			: layer_color,
		class_name		: 'text_color',
		parent			: color_container
	})
	text_color.addEventListener('change', function() {
		button_color_picker.style.backgroundColor = text_color.value
		layer.setStyle({color: text_color.value});
		self.update_draw_data(layer_id)
	})

	const color_wheel_contaniner = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'hide color_wheel_contaniner',
		parent			: color_container
	})

	// iro is loaded and the wheel built on first open (most popups never open it);
	// one shared promise so a click during the load cannot build a second wheel
	let picker_promise = null
	let picker_loading = false
	button_color_picker.addEventListener('mouseup', async (e) =>{
		e.stopPropagation()
		if (picker_loading) {
			return
		}
		if (!picker_promise) {
			picker_loading = true
			picker_promise = load_script(DEDALO_ROOT_WEB + '/lib/iro/dist/iro.min.js')
			.then(()=>{
				const color_picker = new iro.ColorPicker(
					color_wheel_contaniner,
					{
						// Set the size of the color picker
						width: 160,
						// Set the initial color
						color: layer_color,
						// color wheel will not fade to black when the lightness decreases.
						wheelLightness: true,
						// transparency: true,
						layout: [
							{
								component: iro.ui.Wheel, //can be iro.ui.Box
								options: {
									sliderShape: 'circle'
								}
							},
							{
								component: iro.ui.Slider,
								options: {
									sliderType: 'value' // can also be 'saturation', 'value', 'alpha' or 'kelvin'
								}
							},
							// {
							// 	component: iro.ui.Slider,
							// 	options: {
							// 		sliderType: 'alpha'
							// 	}
							// },
						]
					}
				)//end new iro.ColorPicker
				color_picker.on(['color:change'], color_selected)
				return color_picker
			})
			try {
				await picker_promise
			} catch (error) {
				// reset so the next click retries (load_script drops the failed tag)
				picker_promise = null
				console.error('render_color_picker: iro load failed', error)
				return
			} finally {
				picker_loading = false
			}
		}
		color_wheel_contaniner.classList.toggle('hide')
		// the popup grew upward: re-layout + auto-pan so the wheel is not clipped by the
		// map edge nor hidden under the top toolbar (~70px)
		const popup = layer.getPopup?.()
		if (popup) {
			popup.options.autoPanPaddingTopLeft = [5, 80]
			popup.update()
		}
	})
	// color:change event callback
	// color:change callbacks receive the current color and a changes object
	const color_selected = (color) =>{
		// if(this.path !== null){
		// 	this.path.fillColor = color.hex8String
		// }
		layer.setStyle({color: color.hex8String});
		button_color_picker.style.backgroundColor = color.hex8String
		text_color.value = color.hex8String
		// update the instance with the new layer information, prepared to save
		// (but is not saved directly, the user need click in the save button)
		self.update_draw_data(layer_id)
		// event_manager.publish('color_change_'+this.active_layer.data.layer_id, color.hex8String)
	}


	return color_container
}//end render_color_picker



// @license-end
