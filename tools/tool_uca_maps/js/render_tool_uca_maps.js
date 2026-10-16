// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*eslint no-undef: "error"*/



// imports
	import {event_manager} from '../../../core/common/js/event_manager.js'
	import {ui} from '../../../core/common/js/ui.js'



/**
* RENDER_TOOL_UCA_MAPS
* Client-side render module for tool_uca_maps. The real UI lives on the live
* map, one toolbar button (+panel) per functionality; the modal body is only
* a transient notice, closed right after edit() attaches them (tool_uca_maps.js
* close_transient_modal).
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
* Follows the map's destroy event (on_geolocation_destroyed; the token is
* freed by common.prototype.destroy). A full render, not a 'content' refresh,
* attaches every functionality to the live map and closes this tool's modal.
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

	// ORDER MATTERS: every button appends to one shared bar (toolbar.js), so
	// this is the top-to-bottom order. New buttons were appended, never slotted
	// in, so a known order does not move; that is why Legend sits lower than in
	// v6. Catastro/UA are gated on the record's language (catastro.js), as in v6.
		if (self.geolocation && self.map_ready) {
			self.attach_console()
			self.attach_map_image_download_control()
			self.attach_object_viewer()
			self.attach_onexone()
			self.attach_xyz_basemaps()
			self.attach_wms_services()
			self.attach_catastro()
			self.attach_administrative_units()
			self.attach_file_upload()
			self.attach_place_search()
			self.attach_geolocate()
			self.attach_legend()
			self.attach_roman_empire()
			// not a button: permanent map furniture in the bottom-right
			// corner (scale_bar.js)
			self.attach_scale_bar()
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
* Builds the tool's transient modal body: just the map status.
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
		// visible for the window close_transient_modal() waits out: an instant
		// flash reads as broken, not as "it worked" (v6 showed a loading.gif
		// before its own self-close)
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
