// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global L */
/*eslint no-undef: "error"*/



/**
* XYZ_BASEMAPS
* Fila #5 del audit. Persistencia SOLO DE SESIÓN por ahora (Sergio,
* 2026-09-07 — `docs/PREGUNTAS_FORO.md` #7), y arregla el bug real del
* audit ("OSM duplicado", v6 mutaba `layer_control._layers` mientras lo
* recorría). Traza completa, incluida la toma de posesión del tile layer
* raíz para el provider OSM: `docs/hitos/hito_9.md`.
*/



import {strip_tags, safe_url} from '../../../core/common/js/utils/util.js'
import {
	create_toolbar_button,
	create_toolbar_panel,
	register_toolbar_node,
	set_toolbar_panel_visible,
	is_toolbar_panel_visible,
	remove_toolbar_button,
	remove_toolbar_panel
} from './toolbar.js'
import {render_xyz_basemaps_panel, populate_xyz_basemaps} from './render_xyz_basemaps.js'



/** Los 3 de fábrica de v6 para `section_tipo` no-numisdata (única rama que
* aplica aquí — Mupreva es inmueble/yacimiento), byte-parity con
* `class.tool_leaflet_special_tools.php:1181-1198`. Session-only (file header). */
export const DEFAULT_BASEMAPS = [
	{
		url			: '//{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
		name		: 'OSM',
		attribution	: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
		minzoom		: 0,
		maxzoom		: 20
	},
	{
		url			: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
		name		: 'ARCGIS',
		attribution	: 'Tiles &copy; Esri — Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community',
		minzoom		: 0,
		maxzoom		: 19
	},
	{
		url			: 'https://mt1.google.com/vt/lyrs=r&x={x}&y={y}&z={z}',
		name		: 'Google Maps',
		attribution	: '@copy Google Maps',
		minzoom		: 0,
		maxzoom		: 22
	}
]



/**
* ATTACH_XYZ_BASEMAPS
* Construye el botón+panel "XYZ" (patrón toolbar.js) y toma posesión del
* ciclo de vida de la capa base del mapa (ver file header). Idempotente.
*
* @param {Object} self - tool_uca_maps instance
* @returns {void}
*/
export const attach_xyz_basemaps = function(self) {

	if (self.xyz_control || !self.geolocation || !self.geolocation.map) {
		return
	}

	self.basemaps = DEFAULT_BASEMAPS.map((basemap) => ({...basemap}))

	self.xyz_control = create_toolbar_button(self, {
		title		: self.get_tool_label('xyz_control_title') || 'XYZ basemaps',
		text		: 'XYZ',
		class_name	: 'uca-maps-xyz-control',
		on_click	: () => toggle_xyz_panel(self)
	})

	self.xyz_panel = create_toolbar_panel(self, {class_name: 'uca-maps-xyz-panel'})
	render_xyz_basemaps_panel(self, self.xyz_panel)

	rebuild_xyz_layer_control(self, {activate_index: 0})

}//end attach_xyz_basemaps



/**
* TOGGLE_XYZ_PANEL
* Mismo criterio que el resto del tool (toolbar.js file header): estado
* leído del propio DOM, nunca una bandera cacheada.
*
* @param {Object} self
* @returns {void}
*/
const toggle_xyz_panel = function(self) {

	const next_visible = !is_toolbar_panel_visible(self.xyz_panel)

	if (next_visible) {
		populate_xyz_basemaps(self, self.xyz_panel)
	}

	set_toolbar_panel_visible(self, self.xyz_panel, self.xyz_control, next_visible)

}//end toggle_xyz_panel



/**
* REBUILD_XYZ_LAYER_CONTROL
* Único punto de reconstrucción (montaje + toda mutación). Instantánea-y-
* borra, nunca el array vivo de Leaflet — el bug real de v6 (file header,
* `docs/hitos/hito_9.md`).
*
* @param {Object} self
* @param {Object} [options]
* @param {number} [options.activate_index=0] - entrada de self.basemaps activa tras reconstruir
* @returns {void}
*/
const rebuild_xyz_layer_control = function(self, {activate_index = 0} = {}) {

	const geolocation	= self.geolocation
	const map			= geolocation.map

	// one-time takeover (review-diff correctness finding, hito 9): a raw
	// swept map.eachLayer(), not just the OSM branch's named `tile_layer`
	// property — GOOGLE/ARCGIS never store their own single base layer on
	// any property at all (component_geolocation.js), so a name-based check
	// alone missed them, leaving an untracked layer bleeding through
	if (!self._xyz_took_over_tiles) {
		if (geolocation.theme_observer && typeof geolocation.theme_observer.disconnect==='function') {
			geolocation.theme_observer.disconnect()
		}
		const raw_tile_layers = []
		map.eachLayer((layer) => { if (layer instanceof L.TileLayer) raw_tile_layers.push(layer) })
		for (const layer of raw_tile_layers) {
			map.removeLayer(layer)
		}
		self._xyz_took_over_tiles = true
	}

	if (!geolocation.layer_control) {
		geolocation.layer_control = L.control.layers({}).addTo(map)
		self._xyz_created_layer_control = true
		register_toolbar_node(self, geolocation.layer_control.getContainer())
	}
	const layer_control = geolocation.layer_control

	// snapshot-then-remove — the actual fix (file header)
	const existing_tile_entries = Object.values(layer_control._layers || {})
		.filter((entry) => entry.layer instanceof L.TileLayer)
	for (const entry of existing_tile_entries) {
		layer_control.removeLayer(entry.layer)
		if (map.hasLayer(entry.layer)) {
			map.removeLayer(entry.layer)
		}
	}

	self._xyz_tile_layers = self.basemaps.map((basemap) => {
		const tile_layer = L.tileLayer(basemap.url, {
			attribution	: basemap.attribution,
			minZoom		: basemap.minzoom,
			maxZoom		: basemap.maxzoom
		})
		layer_control.addBaseLayer(tile_layer, basemap.name)
		return tile_layer
	})

	const active_layer = self._xyz_tile_layers[activate_index] || self._xyz_tile_layers[0]
	if (active_layer) {
		active_layer.addTo(map)
	}

}//end rebuild_xyz_layer_control



/**
* VALIDATE_BASEMAP_FIELDS
* Zoom 0-22 both ways and min<=max; name AND attribution stripped of tags
* (review-diff security finding, hito 9 — Leaflet's attribution control
* renders that string via innerHTML, unlike a layer name). URL must be
* absolute (`//host/...` or `http(s)://...` — a bare relative string is not
* a tile-server template) and pass the app's one centralized scheme
* allowlist, `safe_url` (`util.js`), never a bespoke regex.
*
* @param {Object} self
* @param {Object} fields - {url, name, attribution, minzoom, maxzoom} (strings crudos del form)
* @returns {{ok: boolean, error?: string, basemap?: Object}}
*/
const validate_basemap_fields = function(self, fields) {

	const raw_url		= String(fields.url || '').trim()
	const name			= strip_tags(String(fields.name || '').trim())
	const attribution	= strip_tags(String(fields.attribution || '').trim())
	const minzoom		= parseInt(fields.minzoom, 10)
	const maxzoom		= parseInt(fields.maxzoom, 10)

	if (!raw_url) {
		return {ok: false, error: self.get_tool_label('xyz_error_url_required') || 'The base map URL is required.'}
	}
	const url = /^(https?:)?\/\//i.test(raw_url) ? safe_url(raw_url) : null
	if (!url) {
		return {ok: false, error: self.get_tool_label('xyz_error_url_invalid') || 'Please enter a valid URL.'}
	}
	if (!name) {
		return {ok: false, error: self.get_tool_label('xyz_error_name_required') || 'The base map name is required.'}
	}
	if (!Number.isInteger(minzoom) || minzoom<0 || minzoom>22) {
		return {ok: false, error: self.get_tool_label('xyz_error_minzoom') || 'Min zoom must be an integer between 0 and 22.'}
	}
	if (!Number.isInteger(maxzoom) || maxzoom<0 || maxzoom>22) {
		return {ok: false, error: self.get_tool_label('xyz_error_maxzoom') || 'Max zoom must be an integer between 0 and 22.'}
	}
	if (minzoom>maxzoom) {
		return {ok: false, error: self.get_tool_label('xyz_error_zoom_range') || 'Min zoom cannot be greater than max zoom.'}
	}

	return {ok: true, basemap: {url, name, attribution, minzoom, maxzoom}}
}//end validate_basemap_fields



/**
* ADD_BASEMAP
* Valida, añade al final de `self.basemaps` y reconstruye activando la
* recién creada — mismo desenlace que v6 tras un alta con éxito.
*
* @param {Object} self
* @param {Object} fields - ver validate_basemap_fields
* @returns {{ok: boolean, error?: string}}
*/
export const add_basemap = function(self, fields) {

	const validation = validate_basemap_fields(self, fields)
	if (!validation.ok) {
		return validation
	}

	self.basemaps.push(validation.basemap)
	rebuild_xyz_layer_control(self, {activate_index: self.basemaps.length - 1})

	return {ok: true}
}//end add_basemap



/**
* DELETE_BASEMAP
* Rechaza borrar la última entrada — un mapa sin ninguna capa base queda en
* blanco, una regresión peor que el descuido de v6 (que no guarda contra
* esto); mejora deliberada, no paridad estricta.
*
* @param {Object} self
* @param {number} index
* @returns {{ok: boolean, error?: string}}
*/
export const delete_basemap = function(self, index) {

	if (index<0 || index>=self.basemaps.length) {
		return {ok: false}
	}
	if (self.basemaps.length<=1) {
		return {ok: false, error: self.get_tool_label('xyz_error_last_basemap') || 'At least one base map must remain.'}
	}

	self.basemaps.splice(index, 1)
	rebuild_xyz_layer_control(self, {activate_index: 0})

	return {ok: true}
}//end delete_basemap



/**
* MOVE_BASEMAP
* Reordena una posición arriba/abajo (botones ▲/▼) — sustituye el
* drag-and-drop HTML5 de v6, intestable de forma fiable en Mocha headless;
* mismo resultado funcional, desviación deliberada (mismo criterio que
* hito 7's onexone.js: robustez/testabilidad sobre réplica literal).
*
* @param {Object} self
* @param {number} index
* @param {number} direction - -1 (subir) o +1 (bajar)
* @returns {{ok: boolean}}
*/
export const move_basemap = function(self, index, direction) {

	const target = index + direction
	if (index<0 || index>=self.basemaps.length || target<0 || target>=self.basemaps.length) {
		return {ok: false}
	}

	const [moved] = self.basemaps.splice(index, 1)
	self.basemaps.splice(target, 0, moved)
	rebuild_xyz_layer_control(self, {activate_index: 0})

	return {ok: true}
}//end move_basemap



/**
* DETACH_XYZ_BASEMAPS
* Destrucción real (CLAUDE.local.md) — llamado desde tool_uca_maps.js
* destroy(). Además del botón+panel, retira del mapa cada tile layer que
* este tool añadió y, si fue este tool quien creó el layer_control (provider
* sin uno propio, ver rebuild_xyz_layer_control), el control entero — un
* control reutilizado (NUMISDATA/VARIOUS) se deja, solo vacío de los
* nuestros (review-diff correctness finding, hito 9).
*
* @param {Object} self
* @returns {void}
*/
export const detach_xyz_basemaps = function(self) {

	remove_toolbar_button(self, self.xyz_control)
	remove_toolbar_panel(self, self.xyz_panel)

	const geolocation	= self.geolocation
	const map			= geolocation && geolocation.map
	if (map) {
		for (const tile_layer of self._xyz_tile_layers || []) {
			if (geolocation.layer_control) {
				geolocation.layer_control.removeLayer(tile_layer)
			}
			if (map.hasLayer(tile_layer)) {
				map.removeLayer(tile_layer)
			}
		}
		if (self._xyz_created_layer_control && geolocation.layer_control) {
			map.removeControl(geolocation.layer_control)
			geolocation.layer_control = false
		}
	}

	self.xyz_control				= null
	self.xyz_panel					= null
	self.basemaps					= null
	self._xyz_tile_layers			= null
	self._xyz_took_over_tiles		= false
	self._xyz_created_layer_control	= false

}//end detach_xyz_basemaps



// @license-end
