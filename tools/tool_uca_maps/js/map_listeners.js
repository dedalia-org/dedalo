// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*eslint no-undef: "error"*/

/**
 * MAP_LISTENERS
 * The teardown every detach_* shares for the listeners it hung on the live map.
 *
 * @module map_listeners
 */

/**
 * REMOVE_MAP_LISTENERS
 * Unsubscribes each stored map listener a detach_* owns. One failing `off`
 * is reported and does not stop the rest.
 *
 * @param {Object} self - tool_uca_maps instance (its map must exist)
 * @param {string} scope - the detach_* name, for the warning
 * @param {Array<[string, string]>} listeners - [event name, `self` key of the handler]
 * @returns {void}
 */
export const remove_map_listeners = function (self, scope, listeners) {
	for (const [event_name, key] of listeners) {
		if (!self[key]) {
			continue;
		}
		try {
			self.geolocation.map.off(event_name, self[key]);
		} catch (error) {
			console.warn(`tool_uca_maps ${scope}: error removing ${event_name} listener`, error);
		}
	}
}; //end remove_map_listeners

// @license-end
