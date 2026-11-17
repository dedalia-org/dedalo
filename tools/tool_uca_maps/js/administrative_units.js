// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*eslint no-undef: "error"*/

/**
 * ADMINISTRATIVE_UNITS
 * "Administrative Units" (UA): Catastro's language gate. The open panel lays the IGN units
 * over the basemap and arms the click; closing it, by any path, disarms. Core's
 * `ign_admin_units_featureinfo` answers one unit of no chosen level, without geometry, so
 * v6's level select and polygon (`special_tools_UA_es.js`) cannot be served. `ign_unidades`
 * (`properties.map_sources`) is optional, e.g. IGN's units with their names, as v6 drew them.
 */

import { request_failed, response_data } from '../../../core/common/js/api_error.js';
import {
	disable_armed_layer,
	enable_armed_layer,
	is_spanish_official_lang,
	reset_armed_layer_state,
	wms_point_options,
} from './armed_layer.js';
import { report_client_error } from './client_error.js';
import {
	clear_ua_message,
	render_administrative_units_panel,
	show_ua_message,
} from './render_administrative_units.js';
import { LOOKUP_TIMEOUT_MS } from './request_budgets.js';
import {
	create_toolbar_button,
	create_toolbar_panel,
	is_toolbar_panel_visible,
	remove_toolbar_button,
	remove_toolbar_panel,
	set_toolbar_panel_visible,
} from './toolbar.js';

/**
 * ATTACH_ADMINISTRATIVE_UNITS
 * Idempotent; a no-op when the record's language does not gate it in (v6).
 *
 * @param {Object} self - tool_uca_maps instance
 * @returns {void}
 */
export const attach_administrative_units = function (self) {
	if (self.ua_control || !self.geolocation || !self.geolocation.map) {
		return;
	}
	if (!is_spanish_official_lang(self)) {
		return;
	}

	const title = self.get_tool_label('ua_control_title') || 'Administrative Units';

	self.ua_control = create_toolbar_button(self, {
		title: title,
		icon: 'administrative_units',
		class_name: 'uca-maps-ua-control',
		on_click: () => toggle_ua_panel(self),
	});

	// on_hide: a SIBLING panel forcing this one shut must disarm too, or the
	// overlay and click listener keep running with no panel to show for them
	self.ua_panel = create_toolbar_panel(self, {
		class_name: 'uca-maps-ua-panel',
		centered: true,
		title: title,
		on_hide: () => disable_ua(self),
	});
	render_administrative_units_panel(self, self.ua_panel);
}; //end attach_administrative_units

/**
 * TOGGLE_UA_PANEL
 * Opening arms the overlay and click; closing disarms. Direction read from the
 * panel's real state before the flip, never a flag.
 *
 * @param {Object} self - tool_uca_maps instance
 * @returns {void}
 */
const toggle_ua_panel = function (self) {
	const next_visible = !is_toolbar_panel_visible(self.ua_panel);

	set_toolbar_panel_visible(self, self.ua_panel, self.ua_control, next_visible);

	if (next_visible) {
		enable_ua(self);
	} else {
		disable_ua(self);
	}
}; //end toggle_ua_panel

// the `id` an administrator gives a units layer of their own in `properties.map_sources`
const UA_SOURCE_ID = 'ign_unidades';

/**
 * ENABLE_UA
 * Lays the administrative units over the active basemap and arms the click.
 *
 * @param {Object} self - tool_uca_maps instance
 * @returns {void}
 */
const enable_ua = function (self) {
	// both through the tile proxy: the page may not name www.ign.es itself (the CSP
	// admits no tile host it can relay)
	// a configured `ign_unidades` is core's own checkbox, ticked; the built-in is the tool's
	enable_armed_layer(self, 'ua', {
		source_key: 'default:' + UA_SOURCE_ID,
		build_layer: () => self.geolocation.get_builtin_layer('ign_admin_units', { opacity: 1 }),
		label: self.get_tool_label('ua_control_title') || 'Administrative Units',
		on_click: (latlng) => check_administrative_unit_at_point(self, latlng),
		// the panel goes with the swap: an open panel over a disarmed map lies
		disarm: () => {
			set_toolbar_panel_visible(self, self.ua_panel, self.ua_control, false);
			disable_ua(self);
		},
	});
}; //end enable_ua

/**
 * DISABLE_UA
 * Reverses ENABLE_UA. Also the panel's on_hide, so any path that closes it disarms.
 *
 * @param {Object} self - tool_uca_maps instance
 * @returns {void}
 */
const disable_ua = function (self) {
	disable_armed_layer(self, 'ua');
}; //end disable_ua

/**
 * CHECK_ADMINISTRATIVE_UNIT_AT_POINT
 * Names, in the panel, the unit at the click. Nothing is created: core's service
 * has no geometry to draw. Exported for the client gate.
 *
 * @param {Object} self - tool_uca_maps instance
 * @param {Object} latlng - a Leaflet LatLng
 * @returns {Promise<void>}
 */
export const check_administrative_unit_at_point = async function (self, latlng) {
	if (self._ua_busy || self.geolocation.map.pm.globalEditModeEnabled()) {
		return;
	}
	self._ua_busy = true;

	try {
		const response = await self.tool_request({
			action: 'get_administrative_unit',
			retries: 1,
			timeout: LOOKUP_TIMEOUT_MS,
			options: wms_point_options(self, latlng),
		});

		// torn down or closed (by any path) while in flight: a late response must
		// not speak in a panel nobody looks at any more
		if (!self.ua_panel || !is_toolbar_panel_visible(self.ua_panel)) {
			return;
		}

		if (request_failed(response)) {
			// core's page notice says why, once and translated: an earlier
			// line must not stand beside it
			clear_ua_message(self.ua_panel);
			return;
		}

		const data = response_data(response);
		if (!data || !data.found || !data.unit) {
			show_ua_message(
				self.ua_panel,
				self.get_tool_label('ua_not_found') ||
					'No administrative unit could be found at this point.',
				'warning',
			);
			return;
		}

		show_ua_message(self.ua_panel, administrative_unit_text(self, data.unit), 'ok');
	} catch (error) {
		// torn down while in flight: the page toast would report work the
		// user already left behind
		if (!self.ua_panel) {
			return;
		}
		console.error('tool_uca_maps: administrative unit lookup failed unexpectedly', error);
		report_client_error((error && error.message) || 'Administrative unit lookup failed');
	} finally {
		self._ua_busy = false;
	}
}; //end check_administrative_unit_at_point

/**
 * ADMINISTRATIVE_UNIT_TEXT
 * "Name (level)", the level in the user's language; the bare name for a level
 * the server could not name.
 *
 * @param {Object} self - tool_uca_maps instance
 * @param {{name: string, level: ?string}} unit
 * @returns {string}
 */
const administrative_unit_text = function (self, unit) {
	if (!unit.level) {
		return unit.name;
	}
	const level = self.get_tool_label('ua_level_' + unit.level.toLowerCase()) || unit.level;

	return unit.name + ' (' + level + ')';
}; //end administrative_unit_text

/**
 * DETACH_ADMINISTRATIVE_UNITS
 * Disarms first, so the armed layer and the click listener are reversed.
 *
 * @param {Object} self - tool_uca_maps instance
 * @returns {void}
 */
export const detach_administrative_units = function (self) {
	if (self.geolocation && self.geolocation.map) {
		disable_ua(self);
	}

	remove_toolbar_button(self, self.ua_control);
	remove_toolbar_panel(self, self.ua_panel);

	self.ua_control = null;
	self.ua_panel = null;
	self._ua_busy = false;
	reset_armed_layer_state(self, 'ua');
}; //end detach_administrative_units

// @license-end
