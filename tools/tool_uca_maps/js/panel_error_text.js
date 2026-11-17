// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*eslint no-undef: "error"*/

/**
 * PANEL_ERROR_TEXT
 * The panel line for the two failures core's page notice never shows: a
 * client-side throw and a refused file upload. A refused tool request has no
 * line here: core shows it once, translated (`details.reason_key`).
 *
 * @module panel_error_text
 */

import { error_text } from '../../../core/common/js/render_api_error.js';

/**
 * UPLOAD_REFUSAL_TEXT
 * The upload transport publishes no page notice, so its refusal is the panel's
 * to show: the lead, then the receiver's own reason on its own line (core's
 * generic `media.upload_rejected` label would hide it). Other codes: core.
 *
 * @param {ApiError|Object} api_error
 * @param {string} lead - the panel's sentence, already resolved (get_tool_label)
 * @returns {string}
 */
export const upload_refusal_text = function (api_error, lead) {
	const reason =
		api_error && api_error.code === 'media.upload_rejected' && typeof api_error.message === 'string'
			? api_error.message.trim()
			: '';

	return reason.length > 0 ? lead + '\n' + reason : error_text(api_error);
}; //end upload_refusal_text

/**
 * EXCEPTION_TEXT
 * The same two lines for a client-side throw (a capture, a decode): no
 * envelope ever existed, so the reason is the exception's own message.
 *
 * @param {Error|*} error
 * @param {string} lead - the panel's sentence, already resolved (get_tool_label)
 * @returns {string}
 */
export const exception_text = function (error, lead) {
	const reason = error && typeof error.message === 'string' ? error.message.trim() : '';

	return reason.length > 0 ? lead + '\n' + reason : lead;
}; //end exception_text

// @license-end
