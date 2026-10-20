// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global L */
/*eslint no-undef: "error"*/



/**
* WMS_SERVICES
* Session-only WMS layers, as XYZ: a tool cannot provision a section to keep them, so
* nothing survives F5. As in v6 (`special_tools_wms.js`) they are plain map layers, never
* in `layer_control`. Only GetCapabilities needs the server (an SSRF-guarded proxy); its
* XML is parsed here with `DOMParser`, as v6 does.
*/



import {response_data, request_failed} from '../../../core/common/js/api_error.js'
import {tool_error_text} from './tool_error_text.js'
import {safe_url} from '../../../core/common/js/utils/util.js'
import {
	create_toolbar_button,
	create_toolbar_panel,
	set_toolbar_panel_visible,
	is_toolbar_panel_visible,
	remove_toolbar_button,
	remove_toolbar_panel
} from './toolbar.js'
import {render_wms_services_panel, populate_wms_layers} from './render_wms_services.js'
import {report_client_error} from './object_console.js'



/**
* ATTACH_WMS_SERVICES
* Builds the "WMS" button+panel (toolbar.js pattern) and seeds the session-
* only layer list. Idempotent.
*
* @param {Object} self - tool_uca_maps instance
* @returns {void}
*/
export const attach_wms_services = function(self) {

	if (self.wms_control || !self.geolocation || !self.geolocation.map) {
		return
	}

	self.wms_layers			= []
	self._wms_tile_layers		= []
	self._wms_search_results	= null

	// v6's own dedicated pane (special_tools_wms.js init_wms), kept above the
	// base tiles but below Geoman's own vector panes
	self.geolocation.map.createPane('wms')
	self.geolocation.map.getPane('wms').style.zIndex = 200

	const title = self.get_tool_label('wms_control_title') || 'WMS services'

	self.wms_control = create_toolbar_button(self, {
		title		: title,
		text		: 'WMS',
		class_name	: 'uca-maps-wms-control',
		on_click	: () => toggle_wms_panel(self)
	})

	self.wms_panel = create_toolbar_panel(self, {
		class_name	: 'uca-maps-wms-panel',
		centered	: true,
		title		: title
	})
	render_wms_services_panel(self, self.wms_panel)

}//end attach_wms_services



/**
* TOGGLE_WMS_PANEL
* Reads the panel's real state, never a flag: a sibling opening closes this one
* without passing here.
*
* @param {Object} self
* @returns {void}
*/
const toggle_wms_panel = function(self) {

	const next_visible = !is_toolbar_panel_visible(self.wms_panel)

	if (next_visible) {
		populate_wms_layers(self, self.wms_panel)
	}

	set_toolbar_panel_visible(self, self.wms_panel, self.wms_control, next_visible)

}//end toggle_wms_panel



/**
* DIRECT_CHILD
* First direct-child element named `tag`, never a nested descendant —
* `Element.getElementsByTagName` searches the WHOLE subtree, which would
* pull a nested `<Layer>`'s own `<Name>` up into its unnamed parent group.
*
* @param {Element} node
* @param {string} tag
* @returns {Element|null}
*/
const direct_child = function(node, tag) {
	return Array.from(node.children).find((child) => child.tagName===tag) || null
}//end direct_child



/**
* PARSE_WMS_CAPABILITIES_XML
* Every `<Layer queryable>` with its OWN `<Name>` (v6's criterion): a layout group
* without one is not addable. Pure (no network, no `self`), so a hand-written XML
* fixture tests it.
*
* @param {string} xml_text
* @returns {{ok: boolean, error?: string, layers?: Array<{name: string, title: string}>}}
*/
export const parse_wms_capabilities_xml = function(xml_text) {

	const parser	= new DOMParser()
	const xml_doc	= parser.parseFromString(String(xml_text || ''), 'text/xml')

	if (xml_doc.querySelector('parsererror')) {
		return {ok: false, error: 'invalid GetCapabilities response'}
	}

	const layers = []
	const layer_nodes = xml_doc.getElementsByTagName('Layer')
	for (let i = 0; i < layer_nodes.length; i++) {
		const layer_node = layer_nodes[i]
		if (layer_node.getAttribute('queryable')===null) {
			continue
		}
		const name = direct_child(layer_node, 'Name')?.textContent
		if (!name) {
			continue
		}
		const title = direct_child(layer_node, 'Title')?.textContent
		layers.push({name, title: title || name})
	}

	return {ok: true, layers}
}//end parse_wms_capabilities_xml



/**
* SEARCH_WMS_LAYERS
* Absolute http(s) first, then `safe_url`: alone it would resolve a relative string
* against the page's origin. UX only; the address policy is server-side. Never throws:
* a rejection would leave the panel's Search button disabled.
*
* @param {Object} self - tool_uca_maps instance
* @param {string} raw_url
* @returns {Promise<{ok: boolean, error?: string, layers?: Array<{name: string, title: string}>}>}
*/
export const search_wms_layers = async function(self, raw_url) {

	const trimmed = String(raw_url || '').trim()
	if (!trimmed) {
		return {ok: false, error: self.get_tool_label('wms_error_url_required') || 'The WMS server URL is required.'}
	}
	if (!/^https?:\/\//i.test(trimmed) || !safe_url(trimmed)) {
		return {ok: false, error: self.get_tool_label('wms_error_url_invalid') || 'Please enter a valid URL.'}
	}

	const unreadable = self.get_tool_label('wms_error_parse') || 'Could not read the server response.'

	try {

		const response = await self.tool_request({
			action	: 'get_wms_layers',
			options	: {
				tipo			: self.geolocation.tipo,
				section_id		: self.geolocation.section_id,
				section_tipo	: self.geolocation.section_tipo,
				url				: trimmed
			}
		})

		// torn down while in flight (detach nulled wms_panel): writing results
		// into a dead instance would resurrect state nothing shows
		if (!self.wms_panel) {
			return {ok: false}
		}

		if (request_failed(response)) {
			const failed = self.get_tool_label('wms_error_failed') || 'The WMS server could not be queried.'
			return {ok: false, error: tool_error_text(response.error, failed)}
		}

		const data		= response_data(response)
		const parsed	= parse_wms_capabilities_xml(data && data.xml)
		if (!parsed.ok) {
			return {ok: false, error: unreadable}
		}

		self._wms_search_results = {base_url: data.url, layers: parsed.layers}

		return {ok: true, layers: parsed.layers}

	} catch (error) {
		// torn down while in flight: the page toast would report work the
		// user already left behind
		if (!self.wms_panel) {
			return {ok: false}
		}
		console.error('tool_uca_maps: search_wms_layers failed unexpectedly', error)
		report_client_error((error && error.message) || 'WMS layer search failed')
		return {ok: false, error: unreadable}
	}
}//end search_wms_layers



/**
* CLEAR_WMS_SEARCH
* Backs the "Clear search" button (v6 `wms_clear_btn`).
*
* @param {Object} self
* @returns {void}
*/
export const clear_wms_search = function(self) {
	self._wms_search_results = null
}//end clear_wms_search



/**
* ADD_WMS_LAYER
* Adds the layer already visible. v6 files it with `view:false` until its eye is
* clicked, but v6's list is a saved catalogue; this one only lives for the session.
*
* @param {Object} self - tool_uca_maps instance
* @param {Object} fields - {url, name, title}
* @returns {{ok: boolean}}
*/
export const add_wms_layer = function(self, {url, name, title}) {

	if (!url || !name) {
		return {ok: false}
	}

	const tile_layer = L.tileLayer.wms(url + '?', {
		request		: 'GetMap',
		layers		: name,
		format		: 'image/png',
		transparent	: false,
		opacity		: 0.7,
		pane		: 'wms'
	})

	self.wms_layers.push({url, name, title: title || name, opacity: 0.7, visible: true})
	self._wms_tile_layers.push(tile_layer)
	tile_layer.addTo(self.geolocation.map)

	return {ok: true}
}//end add_wms_layer



/**
* TOGGLE_WMS_LAYER
* @param {Object} self
* @param {number} index
* @returns {{ok: boolean}}
*/
export const toggle_wms_layer = function(self, index) {

	const entry			= self.wms_layers[index]
	const tile_layer	= self._wms_tile_layers[index]
	if (!entry || !tile_layer) {
		return {ok: false}
	}

	entry.visible = !entry.visible
	if (entry.visible) {
		tile_layer.addTo(self.geolocation.map)
	} else {
		tile_layer.removeFrom(self.geolocation.map)
	}

	return {ok: true}
}//end toggle_wms_layer



/**
* SET_WMS_LAYER_OPACITY
* @param {Object} self
* @param {number} index
* @param {number|string} opacity - 0-1
* @returns {{ok: boolean}}
*/
export const set_wms_layer_opacity = function(self, index, opacity) {

	const entry			= self.wms_layers[index]
	const tile_layer	= self._wms_tile_layers[index]
	const value			= parseFloat(opacity)
	if (!entry || !tile_layer || !Number.isFinite(value) || value<0 || value>1) {
		return {ok: false}
	}

	entry.opacity = value
	tile_layer.setOpacity(value)

	return {ok: true}
}//end set_wms_layer_opacity



/**
* DELETE_WMS_LAYER
* @param {Object} self
* @param {number} index
* @returns {{ok: boolean}}
*/
export const delete_wms_layer = function(self, index) {

	const tile_layer = self._wms_tile_layers[index]
	if (!tile_layer) {
		return {ok: false}
	}

	tile_layer.removeFrom(self.geolocation.map)
	self.wms_layers.splice(index, 1)
	self._wms_tile_layers.splice(index, 1)

	return {ok: true}
}//end delete_wms_layer



/**
* DETACH_WMS_SERVICES
* Every WMS layer this tool added comes off the map. The pane stays: Leaflet has no
* `removePane`, and an empty pane is inert.
*
* @param {Object} self
* @returns {void}
*/
export const detach_wms_services = function(self) {

	remove_toolbar_button(self, self.wms_control)
	remove_toolbar_panel(self, self.wms_panel)

	const map = self.geolocation && self.geolocation.map
	if (map) {
		for (const tile_layer of self._wms_tile_layers || []) {
			if (map.hasLayer(tile_layer)) {
				map.removeLayer(tile_layer)
			}
		}
	}

	self.wms_control			= null
	self.wms_panel				= null
	self.wms_layers				= null
	self._wms_tile_layers		= null
	self._wms_search_results	= null

}//end detach_wms_services



// @license-end
