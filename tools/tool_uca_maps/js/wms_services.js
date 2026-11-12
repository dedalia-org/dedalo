// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*eslint no-undef: "error"*/



/**
* WMS_SERVICES
* WMS layers saved in the record (`map_sources.js`): the component draws them through the
* tile proxy and offers them in its layer control; this panel lists them with v6's eye,
* opacity and delete (`special_tools_wms.js`). Only GetCapabilities needs a tool action
* (an SSRF-guarded proxy); its XML is parsed here with `DOMParser`, as v6 does.
*/



import {response_data, request_failed} from '../../../core/common/js/api_error.js'
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
import {LOOKUP_TIMEOUT_MS} from './request_budgets.js'
import {add_source, delete_source, plain_attribution, reapply_source_opacity, source_layer, stored_sources} from './map_sources.js'



/** v6's opacity for a new WMS layer. A view setting: it is not saved with the source. */
// exported for the client gate
export const DEFAULT_WMS_OPACITY = 0.7

import {WMS_CRS, WMS_SAVED_FORMAT, WMS_VERSIONS} from './core_limits.js'



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

	self._wms_search_results	= null
	self._source_opacity			= {}

	const title = self.get_tool_label('wms_control_title') || 'WMS services'

	self.wms_control = create_toolbar_button(self, {
		title		: title,
		icon		: 'wms_services',
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
		reapply_source_opacity(self)
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
* LAYER_CRS
* The CRSs a `<Layer>` offers: its own `<CRS>` (1.3.0) or `<SRS>` (1.1.1, possibly a
* space-separated list) and every ancestor's, which a WMS layer inherits.
*
* @param {Element} layer_node
* @returns {Set<string>} upper-cased codes
*/
const layer_crs = function(layer_node) {

	const codes = new Set()
	for (let node = layer_node; node && node.tagName==='Layer'; node = node.parentElement) {
		for (const child of node.children) {
			if (child.tagName==='CRS' || child.tagName==='SRS') {
				for (const code of String(child.textContent || '').trim().split(/\s+/)) {
					if (code) codes.add(code.toUpperCase())
				}
			}
		}
	}

	return codes
}//end layer_crs



/**
* PARSE_WMS_CAPABILITIES_XML
* Every `<Layer queryable>` with its OWN `<Name>` (v6's criterion): a layout group
* without one is not addable. Each layer carries the CRS it will be saved with: the
* first of WMS_CRS it offers, the map's own projection when it lists none (what Leaflet
* asked before), and null when it lists only others (it cannot be drawn). Pure (no
* network, no `self`), so a hand-written XML fixture tests it.
*
* @param {string} xml_text
* @returns {{ok: boolean, error?: string, version?: string, layers?: Array<{name: string, title: string, crs: string|null}>}}
*/
export const parse_wms_capabilities_xml = function(xml_text) {

	const parser	= new DOMParser()
	const xml_doc	= parser.parseFromString(String(xml_text || ''), 'text/xml')

	if (xml_doc.querySelector('parsererror')) {
		return {ok: false, error: 'invalid GetCapabilities response'}
	}

	const root_version	= xml_doc.documentElement.getAttribute('version')
	const version		= WMS_VERSIONS.includes(root_version) ? root_version : WMS_VERSIONS[0]

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
		const title		= direct_child(layer_node, 'Title')?.textContent
		const offered	= layer_crs(layer_node)
		const crs		= offered.size===0
			? WMS_CRS[0]
			: (WMS_CRS.find((code) => offered.has(code)) || null)
		layers.push({name, title: title || name, crs})
	}

	return {ok: true, version, layers}
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
			retries	: 1,
			timeout	: LOOKUP_TIMEOUT_MS,
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

		// a refusal: core's page notice says why, once and translated
		if (request_failed(response)) {
			return {ok: false}
		}

		const data		= response_data(response)
		const parsed	= parse_wms_capabilities_xml(data && data.xml)
		if (!parsed.ok) {
			return {ok: false, error: unreadable}
		}

		self._wms_search_results = {base_url: data.url, version: parsed.version, layers: parsed.layers}

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
* "Add and save": the layer is saved in the record as a WMS source, then the component
* draws it through the tile proxy and it is switched on at v6's opacity. `transparent:
* false` and PNG, as the session layer v6 built.
*
* @param {Object} self - tool_uca_maps instance
* @param {Object} fields - {url, name, title, version, crs}
* @returns {Promise<{ok: boolean, error?: string}>}
*/
export const add_wms_layer = async function(self, {url, name, title, version, crs}) {

	if (!url || !name) {
		return {ok: false}
	}
	if (!WMS_CRS.includes(crs)) {
		return {ok: false, error: self.get_tool_label('wms_error_crs') || 'This layer offers no projection the map can draw (EPSG:3857, EPSG:4326 or EPSG:4258).'}
	}

	const result = await add_source(self, {
		type		: 'wms',
		url			: url,
		params		: {
			version		: WMS_VERSIONS.includes(version) ? version : WMS_VERSIONS[0],
			layers		: name,
			styles		: '',
			format		: WMS_SAVED_FORMAT,
			transparent	: false,
			crs			: crs
		},
		// a source has no name of its own: the layer control lists it by its attribution
		attribution	: plain_attribution(title || name)
	})
	// torn down while saving: the session state is gone, the record has what was saved
	if (!self.wms_panel) {
		return {ok: false}
	}
	if (!result.ok) {
		return {ok: false, error: self.get_tool_label('wms_error_save') || 'The WMS layer could not be saved.'}
	}

	if (result.id && self._source_opacity[result.id]===undefined) {
		self._source_opacity[result.id] = DEFAULT_WMS_OPACITY
	}
	reapply_source_opacity(self)

	return {ok: true}
}//end add_wms_layer




/**
* WMS_SOURCES
* The WMS layers the record stores, for the panel's list.
*
* @param {Object} self
* @returns {Array<{id: number, title: string, url: string, visible: boolean, opacity: number}>}
*/
export const wms_sources = function(self) {

	const map = self.geolocation.map

	return stored_sources(self, 'wms').map((source) => {
		const layer = source_layer(self, source.id)
		return {
			id		: source.id,
			title	: source.attribution || (source.params && source.params.layers) || ('#' + source.id),
			url		: source.url,
			visible	: Boolean(layer && map && map.hasLayer(layer)),
			opacity	: self._source_opacity[source.id] ?? 1
		}
	})
}//end wms_sources



/**
* TOGGLE_WMS_LAYER
* The same switch as the layer control's checkbox: the state is the map's.
*
* @param {Object} self
* @param {number} id - the stored source's number
* @returns {{ok: boolean}}
*/
export const toggle_wms_layer = function(self, id) {

	const layer	= source_layer(self, id)
	const map	= self.geolocation.map
	if (!layer || !map) {
		return {ok: false}
	}

	if (map.hasLayer(layer)) {
		layer.removeFrom(map)
	} else {
		layer.addTo(map)
		layer.setOpacity(self._source_opacity[id] ?? 1)
	}

	return {ok: true}
}//end toggle_wms_layer



/**
* SET_WMS_LAYER_OPACITY
* Kept per source for the session: a save rebuilds the component's layers at full opacity,
* and the panel puts this value back when it shows or toggles the layer.
*
* @param {Object} self
* @param {number} id - the stored source's number
* @param {number|string} opacity - 0-1
* @returns {{ok: boolean}}
*/
export const set_wms_layer_opacity = function(self, id, opacity) {

	const layer	= source_layer(self, id)
	const value	= parseFloat(opacity)
	if (!layer || !Number.isFinite(value) || value<0 || value>1) {
		return {ok: false}
	}

	self._source_opacity[id] = value
	layer.setOpacity(value)

	return {ok: true}
}//end set_wms_layer_opacity



/**
* DELETE_WMS_LAYER
* Removes the source from the record and saves.
*
* @param {Object} self
* @param {number} id - the stored source's number
* @returns {Promise<{ok: boolean, error?: string}>}
*/
export const delete_wms_layer = async function(self, id) {

	const result = await delete_source(self, id)
	// torn down while saving (see add_wms_layer)
	if (!self.wms_panel) {
		return {ok: false}
	}
	if (!result.ok) {
		return {ok: false, error: self.get_tool_label('wms_error_save') || 'The WMS layer could not be saved.'}
	}
	delete self._source_opacity[id]
	reapply_source_opacity(self)

	return {ok: true}
}//end delete_wms_layer



/**
* DETACH_WMS_SERVICES
* Button and panel go. The layers stay: they are the record's, drawn by the component and
* switched in its layer control, which outlives the tool.
*
* @param {Object} self
* @returns {void}
*/
export const detach_wms_services = function(self) {

	remove_toolbar_button(self, self.wms_control)
	remove_toolbar_panel(self, self.wms_panel)

	self.wms_control			= null
	self.wms_panel				= null
	self._wms_search_results	= null
	self._source_opacity			= null

}//end detach_wms_services



// @license-end
