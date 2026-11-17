// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global L */
/*eslint no-undef: "error"*/

/**
 * OBJECT_ELEVATION
 * The selected object's centre elevation, asked once per position and kept on
 * `self._elevation` so the console and its PDF show the same number.
 *
 * @module object_elevation
 */

import { request_failed, response_data } from '../../../core/common/js/api_error.js';
import { LOOKUP_TIMEOUT_MS } from './request_budgets.js';

/**
 * LAYER_CENTER
 * The point an elevation is asked about: a marker's own position, anything
 * else's bounds centre — v6 verbatim (`special_tools.js` `create_div_elevation`,
 * which prints a different label for each of the two cases).
 *
 * @param {Object} layer
 * @returns {Object|null} L.LatLng
 */
// exported for the client gate
export const layer_center = function (layer) {
	if (!layer) {
		return null;
	}
	if (layer instanceof L.Marker) {
		return layer.getLatLng();
	}
	if (typeof layer.getBounds !== 'function') {
		return null;
	}
	const bounds = layer.getBounds();

	return bounds && bounds.isValid() ? bounds.getCenter() : null;
}; //end layer_center

/**
 * FETCH_ELEVATION
 * The selected object's centre elevation (`tools/tool_uca_maps/server/elevation.ts`).
 * Not persisted, unlike v6, which saved it on a mere click: nothing auto-saves; it
 * is shown and handed to the PDF in memory. Never throws: a service outage must
 * not stop the console from opening.
 *
 * @param {Object} self - tool_uca_maps instance
 * @param {Object} layer
 * @returns {Promise<{elevation: number|null, unavailable: boolean, attribution?: string|null}>}
 */
export const fetch_elevation = async function (self, layer) {
	const center = layer_center(layer);
	if (!center) {
		return { elevation: null, unavailable: true };
	}

	// THE CACHE IS NOT AN OPTIMISATION: commit() re-renders the section after every
	// mutation and Open-Elevation rate-limits. Keyed on layer AND coordinates, so a
	// moved shape re-asks; the PROMISE is cached at once, so a burst of renders
	// shares one request.
	const cache_key = center.lat + ',' + center.lng;
	const cached = self._elevation;
	if (cached && cached.layer === layer && cached.key === cache_key) {
		return cached.promise;
	}

	// `elevation` is filled on arrival for the PDF export, which must print the
	// number the user is LOOKING AT — asking the service a second time could
	// legitimately answer differently and make the document disagree with the panel
	const entry = { layer: layer, key: cache_key, elevation: null, promise: null };
	entry.promise = request_elevation(self, center).then(function (result) {
		if (result.failed) {
			// a refused or thrown request is not an answer: the next render asks again
			if (self._elevation === entry) {
				self._elevation = null;
			}
		} else {
			entry.elevation = result.elevation;
		}
		return {
			elevation: result.elevation,
			unavailable: result.unavailable,
			attribution: result.attribution || null,
		};
	});
	self._elevation = entry;

	return entry.promise;
}; //end fetch_elevation

/**
 * REQUEST_ELEVATION
 * The one round trip behind `fetch_elevation`. `failed` separates a refusal or
 * a throw (not cached) from an answer that has no elevation (cached).
 *
 * @param {Object} self - tool_uca_maps instance
 * @param {Object} center - L.LatLng
 * @returns {Promise<{elevation: number|null, unavailable: boolean, failed: boolean, attribution?: string|null}>}
 */
const request_elevation = async function (self, center) {
	try {
		const response = await self.tool_request({
			action: 'get_elevation',
			retries: 1,
			timeout: LOOKUP_TIMEOUT_MS,
			options: {
				tipo: self.geolocation.tipo,
				section_id: self.geolocation.section_id,
				section_tipo: self.geolocation.section_tipo,
				lat: center.lat,
				lon: center.lng,
			},
		});

		if (request_failed(response)) {
			return { elevation: null, unavailable: true, failed: true };
		}

		const data = response_data(response);

		return data && typeof data.elevation === 'number'
			? {
					elevation: data.elevation,
					unavailable: false,
					failed: false,
					attribution: typeof data.attribution === 'string' ? data.attribution : null,
				}
			: { elevation: null, unavailable: true, failed: false };
	} catch (error) {
		console.error('tool_uca_maps: get_elevation failed unexpectedly', error);
		return { elevation: null, unavailable: true, failed: true };
	}
}; //end request_elevation

// @license-end
