// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global page_globals, SHOW_DEVELOPER, L */
/*eslint no-undef: "error"*/



/**
 * TOOL_UCA_MAPS
 *
 * Native v7 port of v6 `tool_leaflet_special_tools` (Museu de Prehistòria de
 * València / hispanicode-UCA). Plan: `plan_implementacion.md` (repo root).
 * Diary: `docs/DIARY.md` (this dir, local, not committed).
 *
 * HITO 1 SCOPE (vertical slice): reach the live map, prove open/close/reopen
 * adds no duplicate control, and show server capabilities. Hitos 2-7 add the
 * Leaflet/Geoman console, downloads, external services and persistence.
 *
 * WHY THIS FILE DOES NOT USE tool_config.ddo_map / self.main_element (unlike
 * tool_dev_template): this tool has no `ontology` entry in register.json, so
 * tool_common's cascade falls to its synthetic fallback, which builds a FRESH
 * component_geolocation instance via get_instance({..., id_variant: self.model})
 * — a different instance key than the one the user is already looking at, so a
 * SEPARATE, unrendered Leaflet map would exist nobody ever sees. This tool
 * targets the LIVE instance instead: `self.caller` is the component itself
 * (`ui.tool.build_component_tool_button` opens tools with `caller: self`, the
 * component), reached via `get_caller_by_model` — never a fixed-depth walk,
 * per CLAUDE.local.md and `test/unit/client_caller_chain_tripwire.test.ts` —
 * so the same code keeps working if this tool is ever opened from a portal.
 * The default ddo_map loader is therefore disabled (see build() below) rather
 * than left to build an instance nothing in this tool reads.
 */



// imports
	import {pause} from '../../../core/common/js/utils/index.js'
	import {get_caller_by_model} from '../../../core/common/js/utils/util.js'
	import {common} from '../../../core/common/js/common.js'
	import {tool_common, wire_tool} from '../../../core/tools_common/js/tool_common.js'
	import {render_tool_uca_maps} from './render_tool_uca_maps.js'



/** Deterministic map wait (plan §3.5): budget + poll interval. */
export const MAP_WAIT_TIMEOUT_MS	= 8000
export const MAP_WAIT_INTERVAL_MS	= 100



/**
* TOOL_UCA_MAPS
* Tool constructor. Declares every instance property used by this tool.
*
* Properties:
*   id            - unique tool instance identifier (set by tool_common.init)
*   model         - string model name, always 'tool_uca_maps'
*   mode          - display mode: 'edit', 'list', etc.
*   node          - root HTMLElement rendered by render()
*   ar_instances  - kept empty (see file header); never populated from ddo_map
*   events_tokens - array of event subscription tokens for cleanup in destroy()
*   status        - current lifecycle state (null | 'inited' | 'built' | 'ready')
*   type          - tool type as declared in register.json
*   caller        - the component_geolocation instance that opened this tool
*   langs         - project default languages array from page_globals
*   geolocation   - the LIVE component_geolocation instance (get_caller_by_model
*                   result); this is what get_map()/self.map belong to, NOT a
*                   ddo_map-built clone
*   map_ready     - true once self.geolocation.map was found within budget
*   map_control   - the Leaflet control this tool adds to the live map; removed
*                   in destroy() so closing/reopening never leaves a duplicate
*/
export const tool_uca_maps = function () {

	this.id				= null
	this.model			= null
	this.mode			= null
	this.node			= null
	this.ar_instances	= null
	this.events_tokens	= null
	this.status			= null
	this.type			= null
	this.caller			= null
	this.langs			= null
	this.geolocation	= null
	this.map_ready		= false
	this.map_control	= null
}//end tool_uca_maps



// wire_tool performs the standard prototype assignments (render/destroy/refresh
// from tool_common/common, edit from render_tool_uca_maps). destroy is then
// overridden below to add the map-control teardown.
wire_tool(tool_uca_maps, render_tool_uca_maps)

// (!) wire_tool does NOT copy tool_request (verified against its source: only
// render/destroy/refresh/edit/list are wired) — every production tool that
// calls self.tool_request() assigns it explicitly (tools/tool_export/js/tool_export.js:121
// is the confirmed-working reference). tool_dev_template's own copy calls
// self.tool_request() without this assignment; that looks like a pre-existing
// scaffold gap, not a contract this tool can rely on — documented here, not
// "fixed" in a file outside this tool's directory.
tool_uca_maps.prototype.tool_request = tool_common.prototype.tool_request



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

		self.lang	= options.lang
		self.langs	= page_globals.dedalo_projects_default_langs

		// resolve the live map owner. Cycle-safe, depth-agnostic (file header).
		// self.caller is set by tool_common.prototype.init above.
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
* Loads the tool CSS (via tool_common) but skips the default ddo_map loader
* (see file header) — this tool builds nothing of its own; it waits for the
* live component_geolocation's map instead.
*
* @param {boolean} [autoload=false]
* @returns {Promise<boolean>} the common_build sentinel value
*/
tool_uca_maps.prototype.build = async function(autoload=false) {

	const self = this

	const common_build = await tool_common.prototype.build.call(this, autoload, {
		// no ddo_map entries to resolve — see file header
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
* Deterministic wait for `self.geolocation.map` (plan §3.5: "espera
* determinista del mapa"). component_geolocation defers Leaflet init to an
* IntersectionObserver callback (`lazy_in_viewport`, un-awaited at its call
* site — see `client/dedalo/core/component_geolocation/js/view_default_edit_geolocation.js`),
* so the map can legitimately not exist yet the instant this tool opens.
*
* Polls rather than subscribing to an event because component_geolocation
* publishes no "map ready" event to hook into. Bails early — WITHOUT setting
* map_ready — if this tool instance is destroyed while waiting (e.g. the user
* closes the modal before the map finished loading), so a slow map can never
* resurrect a torn-down instance.
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

		if (self.status==='destroyed') {
			return false
		}
		if (self.geolocation.map) {
			return true
		}
		await pause(MAP_WAIT_INTERVAL_MS)
	}


	return Boolean(self.geolocation.map)
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
* ADD_MAP_CONTROL
* Adds this tool's Leaflet control to the live map. Idempotent — a second call
* while a control is already attached is a no-op, so a stray extra render pass
* can never attach two. This is deliberately the ONLY thing hito 1 adds to the
* shared map: it exists to PROVE the open/close/reopen contract (destroy()
* below removes exactly what this adds) before hitos 2+ add real functionality
* onto the same map instance.
*
* @returns {L.Control|null} the attached control, or null when there is no map
*/
tool_uca_maps.prototype.add_map_control = function() {

	const self = this

	if (self.map_control || !self.geolocation || !self.geolocation.map) {
		return self.map_control
	}

	const UcaMapsControl = L.Control.extend({
		options : { position: 'topright' },
		onAdd : function() {
			const container = L.DomUtil.create('div', 'leaflet-bar uca-maps-control')
			container.title = self.get_tool_label('uca_maps_control_title') || 'UCA Maps'
			container.textContent = 'UCA'
			// prevent map drag/zoom/click from reaching the map through this control
			L.DomEvent.disableClickPropagation(container)
			L.DomEvent.disableScrollPropagation(container)
			return container
		}
	})

	self.map_control = new UcaMapsControl()
	self.map_control.addTo(self.geolocation.map)

	return self.map_control
}//end add_map_control



/**
* DESTROY
* Real teardown (CLAUDE.local.md "destrucción real"): removes the control THIS
* tool added from the shared map — the map itself belongs to component_geolocation
* and outlives this tool's modal close, so leaving the control behind is exactly
* the v6 "controls stay stuck to the map" defect the plan (§7 item 7) requires
* fixed. Guarded: the map may already be gone if component_geolocation itself
* was destroyed first (e.g. navigating away while the tool was open).
*
* self.events_tokens is unsubscribed generically by common.prototype.destroy
* (called at the end here) — nothing else to release in hito 1.
*
* @param {boolean} [delete_self=true]
* @param {boolean} [delete_dependencies=false]
* @param {boolean} [remove_dom=false]
* @returns {Promise<Object>} same shape as common.prototype.destroy
*/
tool_uca_maps.prototype.destroy = async function(delete_self=true, delete_dependencies=false, remove_dom=false) {

	const self = this

	if (self.map_control && self.geolocation && self.geolocation.map) {
		try {
			self.geolocation.map.removeControl(self.map_control)
		} catch (error) {
			console.warn('tool_uca_maps destroy: error removing map control', error)
		}
	}
	self.map_control	= null
	self.geolocation	= null

	// delegate to the standard instance teardown (unsubscribes events_tokens,
	// removes self from instances_map, nullifies heavy props, DOM removal) —
	// same pattern as component_geolocation.prototype.destroy's own override
		return common.prototype.destroy.call(self, delete_self, delete_dependencies, remove_dom)
}//end destroy



/**
* ON_GEOLOCATION_DESTROYED
* Subscribed in render (see render_tool_uca_maps.js) to 'destroy_' + geolocation.id
* so this tool reacts if the underlying component is torn down while its modal
* is still open (e.g. the record is closed from elsewhere) — nulls the
* references so destroy() above does not touch a map that is already gone.
*/
tool_uca_maps.prototype.on_geolocation_destroyed = function() {

	const self = this

	self.map_control	= null
	self.geolocation	= null
	self.map_ready		= false
}//end on_geolocation_destroyed



// @license-end
