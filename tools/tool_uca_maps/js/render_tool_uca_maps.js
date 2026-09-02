// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*eslint no-undef: "error"*/



// imports
	import {event_manager} from '../../../core/common/js/event_manager.js'
	import {ui} from '../../../core/common/js/ui.js'
	import {response_data} from '../../../core/common/js/api_error.js'



/**
* RENDER_TOOL_UCA_MAPS
* Client-side render module for tool_uca_maps (hito 1 vertical slice).
*
* Layout:
*  1. map_status_container — reports whether the live component_geolocation map
*     was found within budget (self.map_ready). On success, attaches this
*     tool's single Leaflet control (self.add_map_control(), idempotent) so
*     open/close/reopen never leaves a duplicate — the acceptance criterion for
*     this hito.
*  2. capabilities_container — calls the server 'get_capabilities' action and
*     renders GDAL/ogr2ogr/gdal_translate/ImageMagick availability.
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
* react if the record is torn down elsewhere while its modal is still open
* (see tool_uca_maps.prototype.on_geolocation_destroyed) — the token is pushed
* to self.events_tokens so common.prototype.destroy unsubscribes it for free.
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


	return wrapper
}//end edit



/**
* GET_CONTENT_DATA
* Builds the tool body: map status (+ control attach) and the capabilities panel.
*
* @param {Object} self - tool_uca_maps instance
* @returns {HTMLElement} content_data node
*/
const get_content_data = function(self) {

	const fragment = new DocumentFragment()

	// map_status_container
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
			// attach this tool's control to the live map — idempotent, so a
			// second render pass (e.g. a refresh) never duplicates it
				self.add_map_control()
			ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'notice notice_ok',
				text_content	: '✓ ' + (self.get_tool_label('uca_maps_control_title') || 'UCA Maps'),
				parent			: map_status_container
			})
		}

	// capabilities_container
		const capabilities_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'capabilities_container',
			parent			: fragment
		})
		ui.create_dom_element({
			element_type	: 'h4',
			text_content	: self.get_tool_label('capabilities_title') || 'Server capabilities',
			parent			: capabilities_container
		})
		const capabilities_body = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'capabilities_body',
			parent			: capabilities_container
		})
		// loaded only when there is a real target to gate the action on
		// ('record_tipo' needs section_tipo + tipo + section_id — all read from
		// self.geolocation, so with no map component there is nothing to ask)
		if (self.geolocation) {
			ui.load_item_with_spinner({
				container			: capabilities_body,
				preserve_content	: false,
				label				: self.get_tool_label('capabilities_title') || 'Server capabilities',
				callback			: async () => render_capabilities(self)
			})
		}

	// content_data
		const content_data = ui.tool.build_content_data(self)
		content_data.appendChild(fragment)


	return content_data
}//end get_content_data



/**
* RENDER_CAPABILITIES
* Calls self.get_capabilities() and renders one row per probed binary.
*
* @param {Object} self - tool_uca_maps instance
* @returns {Promise<HTMLElement>} node to insert (via ui.load_item_with_spinner)
*/
const render_capabilities = async function(self) {

	const response		= await self.get_capabilities()
	const capabilities	= response_data(response)

	const node = ui.create_dom_element({ element_type: 'ul', class_name: 'capabilities_list' })

	if (!capabilities) {
		ui.create_dom_element({
			element_type	: 'li',
			class_name		: 'notice notice_error',
			text_content	: response?.msg || 'Error reading server capabilities.',
			parent			: node
		})
		return node
	}

	const rows = [
		{ label: self.get_tool_label('capabilities_gdal') || 'GDAL', capability: capabilities.gdal },
		{ label: 'ogr2ogr', capability: capabilities.ogr2ogr },
		{ label: 'gdal_translate', capability: capabilities.gdalTranslate },
		{
			label		: self.get_tool_label('capabilities_imagemagick') || 'ImageMagick',
			capability	: capabilities.imagemagick
		}
	]

	for (const row of rows) {
		const available	= Boolean(row.capability?.available)
		const li = ui.create_dom_element({
			element_type	: 'li',
			class_name		: available ? 'capability_available' : 'capability_unavailable',
			parent			: node
		})
		const status_label = available
			? (self.get_tool_label('capability_available') || 'available')
			: (self.get_tool_label('capability_unavailable') || 'not installed on this server')
		ui.create_dom_element({
			element_type	: 'span',
			text_content	: (available ? '✓ ' : '✗ ') + row.label + ': ' + status_label,
			parent			: li
		})
	}


	return node
}//end render_capabilities



// @license-end
