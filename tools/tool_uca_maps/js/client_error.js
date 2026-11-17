// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*eslint no-undef: "error"*/

/**
 * CLIENT_ERROR
 * The global toast for a client-side throw, the path server failures already
 * take; not panel_error_text.js, whose line is for what core never shows.
 *
 * @module client_error
 */

import { ApiError } from '../../../core/common/js/api_error.js';
import { event_manager } from '../../../core/common/js/event_manager.js';

/**
 * REPORT_CLIENT_ERROR
 * Surfaces a thrown client-side exception (no envelope to read) through the same
 * global toast as server failures (`api_error`, subscribed in page.js). The
 * `client.` prefix marks it client-origin and falls through error_policy.js's '*'
 * wildcard, so nothing needs registering.
 *
 * @param {string} message
 * @returns {void}
 */
export const report_client_error = function (message) {
	event_manager.publish(
		'api_error',
		new ApiError({
			code: 'client.tool_uca_maps_failed',
			message: message,
			source: 'client',
			// NOT a transport (network/CSRF/retry) failure — the `client.` prefix
			// defaults `transport` to true, which is the wrong default for "a
			// screenshot capture or a decode threw", so it is overridden explicitly.
			transport: false,
		}),
	);
}; //end report_client_error

// @license-end
