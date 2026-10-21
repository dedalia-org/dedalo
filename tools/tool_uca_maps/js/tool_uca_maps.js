// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global SHOW_DEVELOPER, L */
/*eslint no-undef: "error"*/



/**
 * TOOL_UCA_MAPS
 * Native port of v6 `tool_leaflet_special_tools`. The modal is transient: edit()
 * attaches one toolbar button (+ panel) per functionality to the LIVE map and
 * closes the modal; the instance lives until component_geolocation is destroyed.
 */



// imports
	import {pause} from '../../../core/common/js/utils/index.js'
	import {get_caller_by_model} from '../../../core/common/js/utils/util.js'
	import {common} from '../../../core/common/js/common.js'
	import {event_manager} from '../../../core/common/js/event_manager.js'
	import {dd_request_idle_callback} from '../../../core/common/js/events.js'
	import {tool_common, wire_tool} from '../../../core/tools_common/js/tool_common.js'
	import {render_tool_uca_maps} from './render_tool_uca_maps.js'
	import {
		attach_console,
		detach_console,
		compute_info,
		fetch_elevation,
		RESERVED_PROPERTY_KEYS,
		computed_property_keys,
		is_protected_property_key,
		set_style_field,
		set_object_color,
		set_property,
		delete_property,
		download_vector,
		download_object_pdf,
		toggle_centroid,
		toggle_uncertainty,
		set_hierarchy,
		format_polygon_area,
		sync_measurements,
		is_geoman_edition,
		has_geoman_edition,
		set_geoman_edition
	} from './object_console.js'
	import {
		download_map_image,
		attach_map_image_download_control,
		detach_map_image_download_control
	} from './map_image_download.js'
	import {
		associate_image,
		object_images,
		object_image_url,
		remove_object_image,
		linked_images,
		external_images_enabled,
		import_linked_images
	} from './object_image.js'
	import {
		attach_object_viewer,
		detach_object_viewer,
		collect_objects,
		set_object_display,
		center_on_object
	} from './object_viewer.js'
	import {attach_onexone, detach_onexone} from './onexone.js'
	import {
		attach_xyz_basemaps,
		detach_xyz_basemaps,
		add_basemap,
		delete_basemap,
		move_basemap
	} from './xyz_basemaps.js'
	import {
		attach_wms_services,
		detach_wms_services,
		search_wms_layers,
		clear_wms_search,
		add_wms_layer,
		toggle_wms_layer,
		set_wms_layer_opacity,
		delete_wms_layer
	} from './wms_services.js'
	import {attach_catastro, detach_catastro} from './catastro.js'
	import {attach_administrative_units, detach_administrative_units} from './administrative_units.js'
	import {attach_file_upload, detach_file_upload, upload_vector_file} from './vector_upload.js'
	import {
		attach_image_overlays,
		detach_image_overlays,
		upload_image_file,
		set_image_display,
		get_image_href,
		download_image
	} from './image_upload.js'
	import {is_image_editing, set_image_interactive} from './image_edit.js'
	import {
		attach_place_search,
		clear_place_search,
		detach_place_search,
		focus_place_result,
		search_places
	} from './place_search.js'
	import {attach_geolocate, detach_geolocate} from './geolocate.js'
	import {attach_scale_bar, detach_scale_bar} from './scale_bar.js'
	import {
		attach_legend,
		detach_legend,
		set_legend_title,
		set_legend_visible,
		add_legend_column,
		delete_legend_column,
		set_legend_column_name,
		add_legend_element,
		delete_legend_element,
		set_legend_element_name,
		set_legend_element_icon,
		set_legend_element_symbol,
		move_legend_column,
		move_legend_element
	} from './legend.js'
	import {
		attach_roman_empire,
		detach_roman_empire,
		search_roman,
		add_roman_result,
		clear_roman_search,
		close_roman_suggestions,
		hold_roman_suggestions,
		cancel_roman_search_timer,
		roman_min_query
	} from './roman_empire.js'



/** wait_for_map budget and poll interval. */
const MAP_WAIT_TIMEOUT_MS	= 8000
const MAP_WAIT_INTERVAL_MS	= 100



/**
* TOOL_UCA_MAPS
* Tool constructor. Declares the base tool fields and the first modules' state.
* Not exhaustive: later modules create their own fields when they need them and
* clear them in their detach_X.
*/
export const tool_uca_maps = function () {

	this.id						= null
	this.model						= null
	this.mode						= null
	this.node						= null
	this.ar_instances				= null
	this.events_tokens				= null
	this.status						= null
	this.type						= null
	this.caller						= null
	this.geolocation				= null
	this.map_ready					= false
	this.map_control				= null
	this.panel_node					= null
	this.active_console_layer		= null
	this._popupopen_handler		= null
	this._popupclose_handler		= null
	this._click_handler				= null
	this._pmcreate_handler			= null
	this._pmremove_handler			= null
	this.map_image_control			= null
	this.map_image_panel			= null
	this.object_viewer_control		= null
	this.object_viewer_panel		= null
	this.onexone_control			= null
	this._onexone_popupopen_handler	= null
	this._onexone_pmremove_handler	= null
	this.xyz_control				= null
	this.xyz_panel					= null
	this.basemaps					= null
	this._xyz_tile_layers			= null
	this._xyz_took_over_tiles		= false
	this._xyz_created_layer_control	= false
	this.wms_control				= null
	this.wms_panel					= null
	this.wms_layers					= null
	this._wms_tile_layers			= null
	this._wms_search_results		= null
	this.catastro_control			= null
	this._catastro_tile_layer		= null
	this._catastro_previous_base_layers	= null
	this._catastro_created_layer_control	= false
	this._catastro_click_handler	= null
	this._catastro_busy			= false
	this.ua_control					= null
	this.ua_panel					= null
	this._ua_level					= null
	this._ua_tile_layer			= null
	this._ua_previous_base_layers	= null
	this._ua_created_layer_control	= false
	this._ua_click_handler			= null
	this._ua_busy					= false
	this.upload_control				= null
	this.upload_panel				= null
	this._upload_busy				= false
	this._image_upload_busy		= false
	this._image_overlays			= null
	this._image_overlay_remove_handler = null
	this._image_overlay_token		= null
	this._toolbar_bar				= null
	this._toolbar_nodes			= null
}//end tool_uca_maps



// wire_tool performs the standard prototype assignments (render/destroy/refresh/
// tool_request from tool_common/common, edit from render_tool_uca_maps). destroy is then
// overridden below to add the map-control teardown.
wire_tool(tool_uca_maps, render_tool_uca_maps)



/**
* INIT
* Seeds common tool properties via tool_common.prototype.init, then resolves
* the LIVE component_geolocation instance this tool operates on.
*
* @param {Object} options - init options forwarded from open_tool
* @returns {Promise<boolean>} the common_init sentinel value
*/
tool_uca_maps.prototype.init = async function(options) {

	const self = this

	const common_init = await tool_common.prototype.init.call(this, options);

	try {

		// never a fixed-depth walk: the caller chain differs between edit, a list
		// cell and a portal. self.caller is set by tool_common.prototype.init above.
			self.geolocation = self.caller
				? get_caller_by_model(self.caller, 'component_geolocation')
				: null

		if (!self.geolocation) {
			console.error('tool_uca_maps: no component_geolocation found in the caller chain', self.caller);
		}

	} catch (error) {
		self.error = error
		console.error(error)
	}


	return common_init
}//end init



/**
* BUILD
* Loads the tool CSS but skips the default ddo_map loader: with no `ontology`
* entry in register.json it would build a fresh, never-rendered
* component_geolocation clone. This tool works on the live one (self.geolocation).
*
* @param {boolean} [autoload=false]
* @returns {Promise<boolean>} the common_build sentinel value
*/
tool_uca_maps.prototype.build = async function(autoload=false) {

	const self = this

	const common_build = await tool_common.prototype.build.call(this, autoload, {
		load_ddo_map : async () => { self.ar_instances = [] }
	});

	try {

		self.map_ready = await self.wait_for_map()

	} catch (error) {
		self.error = error
		console.error(error)
	}


	return common_build
}//end build



/**
* WAIT_FOR_MAP
* Polls for `self.geolocation.map`: component_geolocation builds Leaflet lazily
* (`lazy_in_viewport`, un-awaited) and publishes no "map ready" event. Gives up
* if this instance is destroyed meanwhile, so a slow map never revives a
* torn-down tool. destroy() nulls self.geolocation before its status turns
* 'destroyed', so every read after a pause checks both.
*
* @returns {Promise<boolean>} true once self.geolocation.map exists; false on
*   timeout or if self.geolocation is null (no map component found at all)
*/
tool_uca_maps.prototype.wait_for_map = async function() {

	const self = this

	if (!self.geolocation) {
		return false
	}

	const deadline = Date.now() + MAP_WAIT_TIMEOUT_MS
	while (Date.now() < deadline) {

		if (self.status==='destroyed' || !self.geolocation) {
			return false
		}
		if (self.geolocation.map) {
			return true
		}
		await pause(MAP_WAIT_INTERVAL_MS)
	}


	return Boolean(self.geolocation?.map)
}//end wait_for_map



/**
* GET_CAPABILITIES
* Calls the server 'get_capabilities' action (GDAL/ImageMagick availability).
* Permission 'record_tipo': needs the map component's tipo + a record in scope.
*
* @returns {Promise<Object>} API response envelope; response.result on success
*   is the UcaMapsCapabilities shape (tools/tool_uca_maps/server/capabilities.ts)
*/
tool_uca_maps.prototype.get_capabilities = async function() {

	const self = this

	const response = await self.tool_request({
		action	: 'get_capabilities',
		options	: {
			tipo			: self.geolocation.tipo,
			section_id		: self.geolocation.section_id,
			section_tipo	: self.geolocation.section_tipo
		}
	})

	if(SHOW_DEVELOPER===true) {
		console.log('-> get_capabilities API response:', response);
	}

	return response
}//end get_capabilities



/**
* ATTACH_CONSOLE
* The render files call these self.<method> wrappers instead of importing the
* logic modules: each X.js already imports its render_X.js (as this file imports
* render_tool_uca_maps.js), and the reverse import would close a cycle.
*
* @returns {void}
*/
tool_uca_maps.prototype.attach_console = function() {
	attach_console(this)
}//end attach_console



tool_uca_maps.prototype.attach_map_image_download_control = function() {
	attach_map_image_download_control(this)
}//end attach_map_image_download_control

tool_uca_maps.prototype.attach_object_viewer = function() {
	attach_object_viewer(this)
}//end attach_object_viewer

tool_uca_maps.prototype.attach_onexone = function() {
	attach_onexone(this)
}//end attach_onexone



/** xyz_basemaps.js wrappers. */
tool_uca_maps.prototype.attach_xyz_basemaps = function() {
	attach_xyz_basemaps(this)
}//end attach_xyz_basemaps

tool_uca_maps.prototype.add_basemap = function(fields) {
	return add_basemap(this, fields)
}//end add_basemap

tool_uca_maps.prototype.delete_basemap = function(index) {
	return delete_basemap(this, index)
}//end delete_basemap

tool_uca_maps.prototype.move_basemap = function(index, direction) {
	return move_basemap(this, index, direction)
}//end move_basemap



/** wms_services.js wrappers. */
tool_uca_maps.prototype.attach_wms_services = function() {
	attach_wms_services(this)
}//end attach_wms_services

tool_uca_maps.prototype.search_wms_layers = function(raw_url) {
	return search_wms_layers(this, raw_url)
}//end search_wms_layers

tool_uca_maps.prototype.clear_wms_search = function() {
	return clear_wms_search(this)
}//end clear_wms_search

tool_uca_maps.prototype.add_wms_layer = function(fields) {
	return add_wms_layer(this, fields)
}//end add_wms_layer

tool_uca_maps.prototype.toggle_wms_layer = function(index) {
	return toggle_wms_layer(this, index)
}//end toggle_wms_layer

tool_uca_maps.prototype.set_wms_layer_opacity = function(index, opacity) {
	return set_wms_layer_opacity(this, index, opacity)
}//end set_wms_layer_opacity

tool_uca_maps.prototype.delete_wms_layer = function(index) {
	return delete_wms_layer(this, index)
}//end delete_wms_layer



/**
* catastro.js / administrative_units.js: attach only. Catastro has no panel and
* render_administrative_units.js writes self._ua_level directly.
*/
tool_uca_maps.prototype.attach_catastro = function() {
	attach_catastro(this)
}//end attach_catastro

tool_uca_maps.prototype.attach_administrative_units = function() {
	attach_administrative_units(this)
}//end attach_administrative_units



/** vector_upload.js (vector half) / image_upload.js / image_edit.js (image half) wrappers. */
tool_uca_maps.prototype.attach_file_upload = function() {
	attach_file_upload(this)
}//end attach_file_upload

tool_uca_maps.prototype.upload_vector_file = function(file, projection) {
	return upload_vector_file(this, file, projection)
}//end upload_vector_file

tool_uca_maps.prototype.upload_image_file = function(file) {
	return upload_image_file(this, file)
}//end upload_image_file

tool_uca_maps.prototype.attach_image_overlays = function() {
	attach_image_overlays(this)
}//end attach_image_overlays

tool_uca_maps.prototype.set_image_display = function(layer, values, do_commit) {
	set_image_display(this, layer, values, do_commit)
}//end set_image_display

tool_uca_maps.prototype.get_image_href = function(layer) {
	return get_image_href(layer)
}//end get_image_href

tool_uca_maps.prototype.download_image = function(layer, format, quality, file_name) {
	return download_image(this, layer, format, quality, file_name)
}//end download_image

tool_uca_maps.prototype.is_image_editing = function(layer) {
	return is_image_editing(layer)
}//end is_image_editing

tool_uca_maps.prototype.set_image_interactive = function(layer, active) {
	set_image_interactive(this, layer, active)
}//end set_image_interactive



/**
* place_search.js / geolocate.js / scale_bar.js wrappers. The scale bar takes no
* user input, so it needs nothing beyond attach.
*/
tool_uca_maps.prototype.attach_place_search = function() {
	attach_place_search(this)
}//end attach_place_search

tool_uca_maps.prototype.search_places = function(raw_query) {
	return search_places(this, raw_query)
}//end search_places

tool_uca_maps.prototype.focus_place_result = function(index) {
	return focus_place_result(this, index)
}//end focus_place_result

tool_uca_maps.prototype.clear_place_search = function() {
	clear_place_search(this)
}//end clear_place_search

tool_uca_maps.prototype.attach_geolocate = function() {
	attach_geolocate(this)
}//end attach_geolocate

tool_uca_maps.prototype.attach_scale_bar = function() {
	attach_scale_bar(this)
}//end attach_scale_bar



/** legend.js wrappers. */
tool_uca_maps.prototype.attach_legend = function() {
	attach_legend(this)
}//end attach_legend

tool_uca_maps.prototype.set_legend_title = function(text) {
	return set_legend_title(this, text)
}//end set_legend_title

tool_uca_maps.prototype.set_legend_visible = function(visible) {
	return set_legend_visible(this, visible)
}//end set_legend_visible

tool_uca_maps.prototype.add_legend_column = function() {
	return add_legend_column(this)
}//end add_legend_column

tool_uca_maps.prototype.delete_legend_column = function(index) {
	return delete_legend_column(this, index)
}//end delete_legend_column

tool_uca_maps.prototype.set_legend_column_name = function(index, text) {
	return set_legend_column_name(this, index, text)
}//end set_legend_column_name

tool_uca_maps.prototype.add_legend_element = function(column_index) {
	return add_legend_element(this, column_index)
}//end add_legend_element

tool_uca_maps.prototype.delete_legend_element = function(column_index, element_index) {
	return delete_legend_element(this, column_index, element_index)
}//end delete_legend_element

tool_uca_maps.prototype.set_legend_element_name = function(column_index, element_index, text) {
	return set_legend_element_name(this, column_index, element_index, text)
}//end set_legend_element_name

tool_uca_maps.prototype.set_legend_element_icon = function(column_index, element_index, file) {
	return set_legend_element_icon(this, column_index, element_index, file)
}//end set_legend_element_icon

tool_uca_maps.prototype.set_legend_element_symbol = function(column_index, element_index, symbol) {
	return set_legend_element_symbol(this, column_index, element_index, symbol)
}//end set_legend_element_symbol

tool_uca_maps.prototype.move_legend_column = function(index, offset) {
	return move_legend_column(this, index, offset)
}//end move_legend_column

tool_uca_maps.prototype.move_legend_element = function(column_index, element_index, offset) {
	return move_legend_element(this, column_index, element_index, offset)
}//end move_legend_element



/** roman_empire.js wrappers. */
tool_uca_maps.prototype.attach_roman_empire = function() {
	attach_roman_empire(this)
}//end attach_roman_empire

tool_uca_maps.prototype.search_roman = function(source, params) {
	return search_roman(this, source, params)
}//end search_roman

tool_uca_maps.prototype.add_roman_result = function(index) {
	return add_roman_result(this, index)
}//end add_roman_result

tool_uca_maps.prototype.clear_roman_search = function() {
	return clear_roman_search(this)
}//end clear_roman_search

tool_uca_maps.prototype.roman_min_query = function(source, type) {
	return roman_min_query(source, type)
}//end roman_min_query

tool_uca_maps.prototype.close_roman_suggestions = function() {
	return close_roman_suggestions(this)
}//end close_roman_suggestions

tool_uca_maps.prototype.hold_roman_suggestions = function() {
	return hold_roman_suggestions(this)
}//end hold_roman_suggestions

tool_uca_maps.prototype.cancel_roman_search_timer = function() {
	return cancel_roman_search_timer(this)
}//end cancel_roman_search_timer



/** object_viewer.js wrappers. */
tool_uca_maps.prototype.collect_objects = function() {
	return collect_objects(this)
}//end collect_objects

tool_uca_maps.prototype.set_object_display = function(layer, visible) {
	return set_object_display(this, layer, visible)
}//end set_object_display

tool_uca_maps.prototype.center_on_object = function(layer) {
	return center_on_object(this, layer)
}//end center_on_object



/**
* object_console.js / object_image.js wrappers. Both modules still export the raw
* functions, which the client gate calls without building a tool instance.
*/
tool_uca_maps.prototype.compute_info = function(layer) {
	return compute_info(this, layer)
}//end compute_info

tool_uca_maps.prototype.format_polygon_area = function(area_m2) {
	return format_polygon_area(area_m2)
}//end format_polygon_area

tool_uca_maps.prototype.fetch_elevation = function(layer) {
	return fetch_elevation(this, layer)
}//end fetch_elevation

tool_uca_maps.prototype.associate_image = function(layer, file) {
	return associate_image(this, layer, file)
}//end associate_image

tool_uca_maps.prototype.object_images = function(layer) {
	return object_images(layer)
}//end object_images

tool_uca_maps.prototype.object_image_url = function(image) {
	return object_image_url(image)
}//end object_image_url

tool_uca_maps.prototype.remove_object_image = function(layer, index) {
	return remove_object_image(this, layer, index)
}//end remove_object_image

tool_uca_maps.prototype.linked_images = function(layer) {
	return linked_images(layer)
}//end linked_images

tool_uca_maps.prototype.external_images_enabled = function() {
	return external_images_enabled(this)
}//end external_images_enabled

tool_uca_maps.prototype.import_linked_images = function(layer, on_progress) {
	return import_linked_images(this, layer, on_progress)
}//end import_linked_images

tool_uca_maps.prototype.get_reserved_property_keys = function() {
	return RESERVED_PROPERTY_KEYS
}//end get_reserved_property_keys

tool_uca_maps.prototype.get_computed_property_keys = function(layer) {
	return computed_property_keys(layer)
}//end get_computed_property_keys

tool_uca_maps.prototype.is_protected_property_key = function(layer, key) {
	return is_protected_property_key(layer, key)
}//end is_protected_property_key

tool_uca_maps.prototype.set_style_field = function(layer, field, value) {
	return set_style_field(this, layer, field, value)
}//end set_style_field

tool_uca_maps.prototype.set_object_color = function(layer, value) {
	return set_object_color(this, layer, value)
}//end set_object_color

tool_uca_maps.prototype.set_property = function(layer, key, value) {
	return set_property(this, layer, key, value)
}//end set_property

tool_uca_maps.prototype.delete_property = function(layer, key) {
	return delete_property(this, layer, key)
}//end delete_property

tool_uca_maps.prototype.download_vector = function(layer, format) {
	return download_vector(this, layer, format)
}//end download_vector

tool_uca_maps.prototype.download_object_pdf = function(layer) {
	return download_object_pdf(this, layer)
}//end download_object_pdf

/** map_image_download.js wrapper. */
tool_uca_maps.prototype.download_map_image = function(format, file_name) {
	return download_map_image(this, format, file_name)
}//end download_map_image

tool_uca_maps.prototype.toggle_centroid = function(layer) {
	return toggle_centroid(this, layer)
}//end toggle_centroid

tool_uca_maps.prototype.toggle_uncertainty = function(layer) {
	return toggle_uncertainty(this, layer)
}//end toggle_uncertainty

tool_uca_maps.prototype.set_hierarchy = function(layer, edge, checked) {
	return set_hierarchy(this, layer, edge, checked)
}//end set_hierarchy

tool_uca_maps.prototype.sync_measurements = function(layer) {
	return sync_measurements(this, layer)
}//end sync_measurements

tool_uca_maps.prototype.is_geoman_edition = function(layer) {
	return is_geoman_edition(layer)
}//end is_geoman_edition

tool_uca_maps.prototype.has_geoman_edition = function(layer) {
	return has_geoman_edition(layer)
}//end has_geoman_edition

tool_uca_maps.prototype.set_geoman_edition = function(layer, enabled) {
	return set_geoman_edition(this, layer, enabled)
}//end set_geoman_edition



/**
* ON_CLOSE_ACTIONS
* view_modal runs this instead of its default destroy+refresh on close. Does
* nothing on purpose: the modal is transient (close_transient_modal) and the
* instance must survive it. Real teardown is on_geolocation_destroyed().
*
* @returns {boolean} always true
*/
tool_uca_maps.prototype.on_close_actions = function() {
	return true
}//end on_close_actions



/**
* CLOSE_TRANSIENT_MODAL
* Closes the modal as soon as the tool is on the map: core's own spinner already
* covered the load, so no fixed wait (v6's loading.gif + 3 s) is kept. Deferred to
* an idle callback because view_modal sets `self.node.modal` only after render()
* resolves. `transient = true` skips <dd-modal>'s unsaved-data guard: this modal
* owns no editable data, so the prompt would be a bug.
*
* @returns {void}
*/
tool_uca_maps.prototype.close_transient_modal = function() {

	const self = this

	dd_request_idle_callback(() => {
		const modal = self.node && self.node.modal
		if (modal && typeof modal.close==='function') {
			modal.transient = true
			modal.close()
		}
	})
}//end close_transient_modal



/**
* DESTROY
* Detaches every button, panel and listener this tool put on the map. The map
* belongs to component_geolocation and outlives the tool, so anything left
* behind would stay stuck to it (the v6 defect). Every detach_* tolerates an
* already-gone map; common.prototype.destroy then unsubscribes events_tokens.
*
* @param {boolean} [delete_self=true]
* @param {boolean} [delete_dependencies=false]
* @param {boolean} [remove_dom=false]
* @returns {Promise<Object>} same shape as common.prototype.destroy
*/
tool_uca_maps.prototype.destroy = async function(delete_self=true, delete_dependencies=false, remove_dom=false) {

	const self = this

	detach_console(self)
	detach_map_image_download_control(self)
	detach_object_viewer(self)
	detach_onexone(self)
	detach_xyz_basemaps(self)
	detach_wms_services(self)
	detach_catastro(self)
	detach_administrative_units(self)
	detach_file_upload(self)
	detach_image_overlays(self)
	detach_place_search(self)
	detach_geolocate(self)
	detach_scale_bar(self)
	detach_legend(self)
	detach_roman_empire(self)
	self.geolocation = null

	// common.destroy drops events_tokens only with delete_self; with the map
	// detached above, a kept subscription would only fire into a torn-down tool
	for (const token of self.events_tokens || []) {
		event_manager.unsubscribe(token)
	}
	self.events_tokens = []

	// the standard instance teardown, same pattern as component_geolocation's own
	// destroy override
		return common.prototype.destroy.call(self, delete_self, delete_dependencies, remove_dom)
}//end destroy



/**
* ON_GEOLOCATION_DESTROYED
* Subscribed in render_tool_uca_maps.js to 'destroy_' + geolocation.id: the only
* real teardown trigger, since the modal closes itself. Returns destroy()'s
* promise so a caller awaiting it waits for teardown and sees its rejections.
*
* @returns {Promise<Object>} same shape as destroy()/common.prototype.destroy
*/
tool_uca_maps.prototype.on_geolocation_destroyed = async function() {
	return this.destroy(true, true, true)
}//end on_geolocation_destroyed



// @license-end
