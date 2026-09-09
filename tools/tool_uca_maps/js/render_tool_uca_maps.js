// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*eslint no-undef: "error"*/



// imports
	import {event_manager} from '../../../core/common/js/event_manager.js'
	import {ui} from '../../../core/common/js/ui.js'



/**
* RENDER_TOOL_UCA_MAPS
* Client-side render module for tool_uca_maps.
*
* HITO 1 (closed): map_status_container + capabilities_container, both
* rendered INTO the modal body.
*
* HITO 2 (checkpoint 2a): the modal body is now a brief transient notice —
* the real UI moves to panels anchored directly onto the live map, and
* edit() closes this tool's own modal right after attaching them (see
* tool_uca_maps.js file header for the architecture note). content_data
* here exists only for the split second the modal is visible, and for the
* render_level==='content' partial-refresh path.
*
* LEFT TOOLBAR (2026-09-04, before hito 4 — CLAUDE.local.md "Left toolbar:
* un botón por funcionalidad"): what edit() attaches is no longer one
* combined panel — it is now one call per functionality (attach_console,
* attach_map_image_download_control, attach_capabilities_panel, hito 4's
* attach_object_viewer, hito 7's attach_onexone, hito 9's
* attach_xyz_basemaps, hito 10's attach_wms_services, hito 11's
* attach_catastro/attach_administrative_units, this hito's
* attach_file_upload), each building its OWN button (+panel, where the
* functionality actually needs one) through toolbar.js.
*
* @module render_tool_uca_maps
*/
export const render_tool_uca_maps = function() {

	return true
}//end render_tool_uca_maps



/**
* EDIT
* Entry point wired onto tool_uca_maps.prototype.edit by wire_tool().
*
* Subscribes to the live map component's own destroy event so this tool can
* react if the record is torn down elsewhere while its console is still
* anchored (see tool_uca_maps.prototype.on_geolocation_destroyed) — the token
* is pushed to self.events_tokens so common.prototype.destroy unsubscribes it
* for free.
*
* On a full render (not a render_level==='content' partial refresh), attaches
* the console to the live map and schedules this tool's own modal to close
* itself right after — see tool_uca_maps.js close_transient_modal().
*
* @param {Object} options
* @param {string} [options.render_level='full']
* @returns {Promise<HTMLElement>}
*/
render_tool_uca_maps.prototype.edit = async function(options) {

	const self = this

	// react to the live map component being torn down from elsewhere
		if (self.geolocation) {
			const token = event_manager.subscribe(
				'destroy_' + self.geolocation.id,
				() => self.on_geolocation_destroyed()
			)
			self.events_tokens = self.events_tokens || []
			self.events_tokens.push(token)
		}

	// content_data
		const render_level = options.render_level || 'full'
		const content_data = get_content_data(self)
		if (render_level==='content') {
			return content_data
		}

	// wrapper
		const wrapper = ui.tool.build_wrapper_edit(self, {
			content_data : content_data
		})

	// attach every functionality's own button(+panel) to the live map, then
	// self-close (file header) — one call per functionality, per the "Left
	// toolbar: un botón por funcionalidad" convention (tool_uca_maps.js file
	// header, CLAUDE.local.md). ORDER MATTERS: Leaflet's 'topleft' corner
	// stacks controls top-to-bottom in the order they are added
	// (L.Control.addTo appends to that corner's container), so the first
	// attach_* call here ends up as the TOPMOST button. capabilities_panel
	// (the dev-only "DEV" button) attaches first — Sergio, 2026-09-04 —
	// ahead of the real functionalities; "Upload file to map" attaches last,
	// so the corner reads DEV, UCA, IMG, OBJ, 1x1, XYZ, WMS, Catastro, UA,
	// UP top-to-bottom (Catastro/UA may not appear at all — both gated on the
	// record's language, v6 parity, catastro.js is_spanish_official_lang).
		if (self.geolocation && self.map_ready) {
			self.attach_capabilities_panel()
			self.attach_console()
			self.attach_map_image_download_control()
			self.attach_object_viewer()
			self.attach_onexone()
			self.attach_xyz_basemaps()
			self.attach_wms_services()
			self.attach_catastro()
			self.attach_administrative_units()
			self.attach_file_upload()
			// not a button: the image half's own lifecycle hook, which
			// rebuilds the overlays already saved on this record and keeps
			// them following their carrier objects (image_upload.js)
			self.attach_image_overlays()
		}
		self.close_transient_modal()


	return wrapper
}//end edit



/**
* GET_CONTENT_DATA
* Builds the tool's (transient) modal body: just the map status. Capabilities
* and the object console now live in the anchored panel — see file header.
*
* @param {Object} self - tool_uca_maps instance
* @returns {HTMLElement} content_data node
*/
const get_content_data = function(self) {

	const fragment = new DocumentFragment()

	const map_status_container = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'map_status_container',
		parent			: fragment
	})

	if (!self.geolocation) {
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'notice notice_error',
			text_content	: self.get_tool_label('map_not_found') || 'No map component found for this tool.',
			parent			: map_status_container
		})
	}else if (!self.map_ready) {
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'notice notice_warning',
			text_content	: self.get_tool_label('waiting_for_map') || 'Waiting for the map to finish loading…',
			parent			: map_status_container
		})
	}else{
		// visible for the deliberate window close_transient_modal() waits out
		// (tool_uca_maps.js) — v6's own equivalent (`render_tool_leaflet_special_tools.js`)
		// showed a loading.gif before its own setTimeout-driven self-close;
		// Sergio confirmed during 2a validation (2026-09-02) that an instant
		// flash reads as broken, not as "it worked" — this spinner is the fix
		const spinner_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'notice notice_ok activating',
			text_content	: self.get_tool_label('activating_console') || 'Activating UCA Maps…',
			parent			: map_status_container
		})
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'spinner medium',
			parent			: spinner_container
		})
	}

	const content_data = ui.tool.build_content_data(self)
	content_data.appendChild(fragment)


	return content_data
}//end get_content_data



// @license-end
