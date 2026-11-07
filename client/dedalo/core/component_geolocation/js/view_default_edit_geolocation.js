// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, L, SHOW_DEBUG */
/*eslint no-undef: "error"*/



// imports
	import {lazy_in_viewport, fade_in_on_reveal, dd_request_idle_callback} from '../../common/js/events.js'
	import {ui} from '../../common/js/ui.js'
	import {clone} from '../../common/js/utils/index.js'



/**
* VIEW_DEFAULT_EDIT_GEOLOCATION
* Default edit view for component_geolocation.
*
* Builds the interactive editing shell for a single geolocation entry: a set of
* coordinate text inputs (lat, lon, zoom, alt) wired to a Leaflet map.  Map
* initialisation is deferred via when_in_viewport so the Leaflet instance is only
* created when the container scrolls into view, avoiding hidden-element sizing bugs.
*
* Entry point: view_default_edit_geolocation.render() — called by
* render_edit_component_geolocation when view is 'default', 'line', or 'print'.
*
* Value shape stored in self.current_value[0]:
* {
*   lat      : {number}  - latitude   (WGS-84 decimal degrees) ┐ THE VIEW
*   lon      : {number}  - longitude  (WGS-84 decimal degrees) │ the map framing
*   zoom     : {number}  - Leaflet zoom level (integer 0–19)   ┘
*   alt      : {number}  - altitude in metres
*   lib_data : {Array}   - THE FEATURES: drawn geometry, managed by component_geolocation
* }
*
* (!) THE VIEW AND THE FEATURES ARE INDEPENDENT. lat/lon/zoom are the framing an
* operator chose, not the position of any feature; lib_data holds the features.
* Both are savable data. In this view the two are set by two different controls:
* a map gesture sets the VIEW (the inputs track it live), and the map_point
* button reads those inputs and creates a FEATURE.
*
* (!) A record with no stored value renders the four inputs EMPTY and leaves
* current_value[0] undefined — rendering fabricates nothing. The value is born on
* the first user action (a gesture, a typed coordinate, a drawn shape); until
* then the save button is a no-op.
*
* Public exports: view_default_edit_geolocation (namespace), get_content_data,
* get_content_value, get_content_value_read.
*/
export const view_default_edit_geolocation = function() {

	return true
}//end view_default_edit_geolocation



/**
* FN_INPUT_VALUE
* Renders a stored coordinate into an <input> value. Absence (null/undefined)
* becomes the empty string; 0 renders as '0' because 0 is a legal coordinate.
* @param {*} value - Stored coordinate, or null/undefined when nothing is stored.
* @returns {string|number} Value for the input node.
*/
const fn_input_value = (value) => (value===null || value===undefined)
	? ''
	: value



/**
* RENDER
* Build and return the full component wrapper for edit mode.
*
* Switches between a content-only fragment (render_level 'content') and a complete
* wrapper element that includes optional buttons.  When view is 'line' the label
* node is suppressed so the component fits inline.
*
* @param {Object} self    - component_geolocation instance
* @param {Object} options - render options
*   @param {string} [options.render_level='full'] - 'full' returns the wrapper; 'content' returns only content_data
* @returns {Promise<HTMLElement>} wrapper element (or content_data when render_level is 'content')
*/
view_default_edit_geolocation.render = async function(self, options) {

	// options
		const render_level = options.render_level || 'full'

	// content_data
		const content_data = get_content_data(self)
		if (render_level==='content') {
			return content_data
		}

	// buttons
		const buttons = (self.permissions > 1)
			? get_buttons(self)
			: null

	// wrapper. ui build_edit returns component wrapper
		const wrapper_options = {
			content_data	: content_data,
			buttons			: buttons
		}
		if (self.view==='line') {
			wrapper_options.label = null // prevent to crate label node
		}
		const wrapper = ui.component.build_wrapper_edit(self, wrapper_options)
		// set pointers
		wrapper.content_data = content_data


	return wrapper
}//end render



/**
* GET_CONTENT_DATA
* Build the content_data container and populate it with the single geolocation input
* element (read-only or editable depending on self.permissions).
*
* Geolocation is always a single-entry component (only one map per instance).
*
* (!) NO side effect on self.current_value. Rendering is not editing: seeding
* current_value[0] here made an untouched record dirty-looking, so opening a record
* and pressing save committed a coordinate the user never entered. get_map clones
* the stored entry into current_value when — and only when — one exists.
*
* @param {Object} self - component_geolocation instance
* @returns {HTMLElement} content_data container with the input element attached as content_data[0]
*/
export const get_content_data = function(self) {

	// content_data
		const content_data = ui.component.build_content_data(self)

	// inputs - Expected only one value in geolocation
		const i = 0
		// stored entry or null — never a fabricated fallback
		const stored_entry = self.get_stored_entry(i)

		const input_element_node = (self.permissions===1)
			? get_content_value_read(i, stored_entry, self)
			: get_content_value(i, stored_entry, self)

		content_data.appendChild(input_element_node)

		// set the pointer
		content_data[i] = input_element_node


	return content_data
}//end get_content_data



/**
* GET_CONTENT_VALUE
* Build the full editable geolocation input: four coordinate text inputs plus a
* Leaflet map container wired with pan/zoom synchronisation.
*
* Layout (inside content_value):
*   .map_inputs  — labels + inputs for lat, lon, zoom, alt; refresh button; add-point button
*   .leaflet_map — Leaflet map container (initialised lazily via when_in_viewport)
*
* Coordinate change flow:
*   user types in an input → 'change' event → fn_coord_change → self.handle_coord_change
*   self.handle_coord_change updates self.current_value[i] and pans/zooms the map.
*
* Map drag/zoom sets the VIEW: it writes lat/lon/zoom through
* self.update_input_values, so the inputs track the map live and the component
* goes dirty — on an empty record too, that is how a view is first created. It
* does NOT auto-save (intentional — use the save button).
*
* A ResizeObserver calls self.refresh_map whenever the content_value element is resized
* so Leaflet recalculates tile positions after CSS-driven layout changes.
*
* @param {number} i            - entry index (always 0 for geolocation)
* @param {Object|null} stored_entry - the STORED coordinate object, or null when the
*   record has no geolocation value (then all four inputs render empty)
*   { lat: {number}, lon: {number}, zoom: {number}, alt: {number}, lib_data: {Array} }
* @param {Object} self          - component_geolocation instance
* @returns {HTMLElement} content_value element containing inputs and map container
*/
export const get_content_value = (i, stored_entry, self) =>{

	// content_value
		const content_value = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'content_value'
		})

	// inputs container
		const inputs_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'map_inputs',
			parent			: content_value
		})

	// unified change handler - delegates to component method
		const fn_coord_change = (e) => {
			const node = e.target
			const name = node.dataset.name
			const val  = (node.value.length > 0) ? parseFloat(node.value) : null

			self.handle_coord_change(i, name, val)
		}

		// latitude
			// label field latitude
				ui.create_dom_element({
					element_type	: 'label',
					inner_html		: get_label.latitude || 'Latitude',
					parent			: inputs_container
				})

			// input field latitude
				ui.create_dom_element({
					element_type	: 'input',
					type			: 'text',
					class_name		: 'geo_active_input lat',
					dataset			: { name : 'lat' },
					value			: fn_input_value(stored_entry?.lat),
					parent			: inputs_container
				})
				.addEventListener('change', fn_coord_change)

		// longitude
			// label field longitude
				ui.create_dom_element({
					element_type	: 'label',
					inner_html		: get_label.longitude || 'Longitude',
					parent			: inputs_container
				})

			// input field longitude
				ui.create_dom_element({
					element_type	: 'input',
					type			: 'text',
					class_name		: 'geo_active_input lon',
					dataset			: { name : 'lon'},
					value			: fn_input_value(stored_entry?.lon),
					parent			: inputs_container
				})
				.addEventListener('change', fn_coord_change)

		// zoom
			// label field zoom
				ui.create_dom_element({
					element_type	: 'label',
					inner_html		: get_label.zoom || 'Zoom',
					parent			: inputs_container
				})

			// input field zoom
				ui.create_dom_element({
					element_type	: 'input',
					type			: 'text',
					class_name		: 'geo_active_input zoom',
					dataset			: { name : 'zoom' },
					value			: fn_input_value(stored_entry?.zoom),
					parent			: inputs_container
				})
				.addEventListener('change', fn_coord_change)

		// altitude
			// label field altitude
				ui.create_dom_element({
					element_type	: 'label',
					inner_html		: get_label.altitude || 'Alt',
					parent			: inputs_container
				})

			// input field altitude
				ui.create_dom_element({
					element_type	: 'input',
					type			: 'text',
					class_name		: 'altitude',
					dataset			: { name : 'alt' },
					value			: fn_input_value(stored_entry?.alt),
					parent			: inputs_container
				})
				.addEventListener('change', fn_coord_change)

		// refresh
			// Clicking the refresh button discards unsaved in-memory changes and restores the last
			// persisted state of self.data.entries[i].  It also resets is_data_changed so the
			// "unsaved changes" indicator disappears and triggers a full layer reload.
			// (!) "the last persisted state" includes ABSENCE: when the record stores
			// nothing, refresh must clear the value and the inputs, not re-fabricate a
			// coordinate. The map then returns to the camera (default_view).
			const refresh_node = ui.create_dom_element({
				element_type	: 'span',
				parent			: inputs_container,
				class_name		: 'map_reload'
			})
			refresh_node.addEventListener('click', fn_refresh)
			function fn_refresh(e) {
				e.stopPropagation()

				const entry	= self.get_stored_entry(i)
				const view	= self.get_view(i)

				// FN_MOVE_CAMERA
				// (!) self.move_camera is the single door for a programmatic map
				// move (one setView, animate:false, map event feedback suppressed).
				// It replaced panTo + setZoom here for two measured reasons:
				//  a) the zoom CANCELS the pan animation, so the map does not move at all;
				//  b) setZoom fires zoomend ASYNCHRONOUSLY (~250ms) and that handler calls
				//     update_input_values, which re-marks the component dirty and writes
				//     the map CENTRE into current_value — both AFTER this function has
				//     returned. On a record with no stored value that resurrected a
				//     fabricated view: click refresh, wait, and the camera (20/0)
				//     had become a saveable value.
				// move_camera's camera_is_moving mask is the whole defence here: this
				// is the component's own move, not the operator's, so it must write
				// nothing at all.
					const fn_move_camera = () => {
						self.move_camera(view.lat, view.lon, view.zoom)
					}

				if (!entry) {
					// no stored value → restore absence (camera FIRST, see above)
						fn_move_camera()
						delete self.current_value[i]
						inputs_container.querySelectorAll('input[data-name]').forEach(
							(input) => { input.value = '' }
						)
						self.is_data_changed = false
						self.layers_loader({load:'full'})
					return
				}

				fn_move_camera()

				// geometry framing — when the entry holds a drawn shape and no
				// coordinate, get_view centred on the shape and this fits the zoom
				// to its extent. Fitting writes nothing by itself — but a later user
				// gesture can commit the fitted framing, which is the point of a view.
					self.fit_camera_to_geometry(i)

				// alt is not written by update_input_values (it READS it back from the
				// DOM), so restore it here or the stale altitude survives a refresh
					const alt_node = inputs_container.querySelector("input[data-name='alt']")
					if (alt_node) {
						alt_node.value = fn_input_value(entry.alt)
					}

				// Update input values (writes the inputs AND current_value[i]) —
				// these are the STORED values being restored.
				// (!) fn_input_value on ALL FOUR: update_input_values assigns
				// data.lat/lon/zoom straight into the input nodes, and a
				// geometry-only entry has none of them — unguarded that renders the
				// string 'undefined' in the VALUE fields, which add-point and
				// handle_coord_change then read. Absence renders empty, everywhere.
					self.update_input_values(
						i,
						{
							lat		: fn_input_value(entry.lat),
							lon		: fn_input_value(entry.lon),
							zoom	: fn_input_value(entry.zoom),
							alt		: fn_input_value(entry.alt)
						},
						map_container
					)

				// Update current_value — restore the stored entry verbatim, including lib_data
				// (!) a deep CLONE, never a shallow copy: the stored entry's `sources`,
				// `legend` and `lib_data` are arrays/objects, and sharing them with
				// data.entries would let an edit of the buffer rewrite the baseline the
				// unchanged-guard compares against
					self.current_value[i] = clone(entry)

				// Reset changed flag
				// (!) must come AFTER update_input_values, which marks the component dirty
					self.is_data_changed = false

				// load all layers
					self.layers_loader({load:'full'})
			}//end fn_refresh

		// create point
			// The FEATURE half of the model. Reads lat/lon from the text inputs — which
			// track the map live, so an operator can frame a spot and turn it into
			// geometry — and calls self.create_point to add a Leaflet marker there,
			// then persists it via update_draw_data. The view is left as it is: a
			// feature does not assert the view and the view does not assert a feature.
			// (!) Uses .lng (Leaflet LatLng property) in the point object, not .lon.
			const add_point_node = ui.create_dom_element({
				element_type	: 'span',
				parent			: inputs_container,
				class_name		: 'map_point'
			})
			add_point_node.addEventListener('click', fn_click_add_point)
			function fn_click_add_point(e) {
				e.stopPropagation()

				const lat_node = inputs_container.querySelector('.lat')
				const lon_node = inputs_container.querySelector('.lon')

				// (!) both coordinates must be finite: parseFloat('') is NaN and
				// L.marker then throws "Invalid LatLng object". An empty record has
				// empty inputs, so this is the normal case, not an edge case.
					const lat = parseFloat(lat_node.value)
					const lng = parseFloat(lon_node.value)
					if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
						if (SHOW_DEBUG===true) {
							console.warn('Ignored add point: lat/lon are not both set', lat_node.value, lon_node.value)
						}
						return
					}

				// create the point in the coordinates
					self.create_point({ lat: lat, lng: lng })
			}//end fn_click_add_point

	// map container
		// data-key attribute stores the entry index so component methods (update_draw_data,
		// update_input_values) can resolve map_container → parent content_value reliably.
		const map_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'leaflet_map',
			dataset			: { key : i },
			parent			: content_value
		})
		// set pointers
		content_value.map_container = map_container
		// start invisible for a smooth fade-in once the map is ready (shared contract)
		const reveal = fade_in_on_reveal(map_container)

	// init the map with the wrapper when container node is in viewport
		// Deferring map init until the element is visible avoids a known Leaflet issue where
		// tiles are mis-sized when initialised inside a hidden/zero-height container.
		lazy_in_viewport(
			map_container,
			() => {
				self.get_map(map_container, i)
				.then(()=>{
					// fade the map in now that Leaflet has initialised
					reveal()
					self.layers_loader({
						load: 'full'
					})
					// add resize content_value event to allow user to resize the map.
					// store the observer so destroy() can disconnect it (otherwise it
					// outlives the component and keeps the map graph alive).
					self.resize_observers = self.resize_observers || []
					const resize_observer = new ResizeObserver( function(){
						self.refresh_map(self.map)
					})
					resize_observer.observe( content_value )
					self.resize_observers.push(resize_observer)
				})
				.catch(()=> reveal())
			}
		);


	return content_value
}//end get_content_value



/**
* GET_CONTENT_VALUE_READ
* Build a read-only geolocation display: a Leaflet map container with no coordinate
* inputs or editing controls.
*
* Used when self.permissions === 1 (read-only) or when the component is rendered in
* 'print' view (render_edit_component_geolocation forces permissions to 1 for print).
* The map is still interactive (panning, zooming) — it is just not editable.
*
* Map initialisation is deferred via when_in_viewport for the same sizing reasons as
* the editable variant (see get_content_value).
*
* @param {number} i            - entry index (always 0 for geolocation)
* @param {Object|null} stored_entry - the stored coordinate object, or null (used only to
*   satisfy the caller contract; the map centre comes from self.get_view via get_map)
*   { lat: {number}, lon: {number}, zoom: {number}, alt: {number}, lib_data: {Array} }
* @param {Object} self          - component_geolocation instance
* @returns {HTMLElement} content_value element containing only the map container
*/
export const get_content_value_read = (i, stored_entry, self) =>{

	// content_value
		const content_value = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'content_value read_only'
		})

	// map container
		const map_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'leaflet_map',
			dataset			: { key : i },
			parent			: content_value
		})
		// set pointers
		content_value.map_container = map_container
		// start invisible for a smooth fade-in once the map is ready (shared contract)
		const reveal = fade_in_on_reveal(map_container)

	// init the map with the wrapper when container node is in viewport
		lazy_in_viewport(
			map_container,
			() => {
				self.get_map(map_container, i)
				.then(()=>{
					// fade the map in now that Leaflet has initialised
					reveal()
					self.layers_loader({
						load: 'full'
					})
					// add resize content_value event to allow user to resize the map.
					// store the observer so destroy() can disconnect it (otherwise it
					// outlives the component and keeps the map graph alive).
					self.resize_observers = self.resize_observers || []
					const resize_observer = new ResizeObserver( function(){
						self.refresh_map(self.map)
					})
					resize_observer.observe( content_value )
					self.resize_observers.push(resize_observer)
				})
				.catch(()=> reveal())
			}
		);


	return content_value
}//end get_content_value_read



/**
* GET_BUTTONS
* Build the button bar for the edit wrapper.
*
* Only called when self.permissions > 1 (see render).  Which buttons are rendered is
* governed by self.show_interface, which is populated from ontology/properties config.
*
* Supported slots (all conditional):
*   - tools            — standard toolbar via ui.add_tools
*   - button_fullscreen — enters browser fullscreen on self.node; invalidates Leaflet
*                         tile sizes afterwards so the map fills the new viewport
*   - button_save      — calls self.build_changed_data_item(0) then self.change_value,
*                         resets self.is_data_changed on success. NO-OP when there is
*                         no value (null item) or when nothing was touched.
*
* Buttons are wrapped in a .buttons_fold div (enables sticky positioning on tall
* components) inside the standard buttons_container built by ui.component.
*
* (!) Save uses hard-coded key 0 because geolocation only ever has one entry.
*
* @param {Object} self - component_geolocation instance
* @returns {HTMLElement} buttons_container element with all enabled buttons appended
*/
const get_buttons = (self) => {

	// short vars
		const show_interface = self.show_interface

	// fragment
		const fragment = new DocumentFragment()

	// buttons tools
		if(show_interface.tools === true){
			ui.add_tools(self, fragment)
		}

	// button_fullscreen
		if(show_interface.button_fullscreen === true){
			const button_fullscreen = ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'button full_screen',
				title			: get_label.full_screen || 'Full screen',
				parent			: fragment
			})
			button_fullscreen.addEventListener('click', function(e) {
				e.stopPropagation()
				ui.enter_fullscreen(self.node)
				if (self.map) {
					self.map.invalidateSize()
				}
			})
		}

	// save
		if(show_interface.button_save === true){
			const save = ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'button tool save',
				title			: get_label.save || 'Save',
				parent			: fragment
			})
			save.addEventListener('click', fn_save)
			function fn_save(e) {
				e.stopPropagation()

				// (!) TWO gates, both load-bearing. Without them, opening a record and
				// pressing save committed a value nobody entered.
					// They gate ABSENCE, never a gesture: setting the VIEW by panning or
					// zooming creates current_value and marks the component dirty, so a
					// pure view change passes both and saves.
				// 1. no value at all → build_changed_data_item returns null
					const changed_data_item = self.build_changed_data_item(0)
					if (!changed_data_item) {
						if (SHOW_DEBUG===true) {
							console.log('Ignored geolocation save: the record has no value to send')
						}
						return
					}
				// 2. a value that nobody touched → nothing to commit.
					// is_data_changed is set by every edit path (handle_coord_change,
					// update_input_values on drag/zoom, update_draw_data) and cleared by
					// fn_refresh and by a successful save. It used to be written in four
					// places and READ NOWHERE — a write-only dirty flag in the save path
					// is exactly what let the fabricated-value bug exist.
					if (self.is_data_changed!==true) {
						if (SHOW_DEBUG===true) {
							console.log('Ignored geolocation save: no changes since load')
						}
						return
					}

				self.change_value({
					changed_data	: [changed_data_item],
					refresh			: false
				})
				.then(()=>{
					// set the data_changed to false to control that the data was changed
						self.is_data_changed = false
				})
			}//end fn_save
		}

	// buttons container
		const buttons_container = ui.component.build_buttons_container(self)

	// buttons_fold (allow sticky position on large components)
		const buttons_fold = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'buttons_fold',
			parent			: buttons_container
		})
		buttons_fold.appendChild(fragment)


	return buttons_container
}//end get_buttons



// @license-end
