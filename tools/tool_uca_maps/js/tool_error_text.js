// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*eslint no-undef: "error"*/



import {error_text} from '../../../core/common/js/render_api_error.js'



/** The public codes this tool's server refuses with, the concrete reason as
* their public message: a bad input, a target it cannot process, a file that
* is gone. A new public code thrown with a reason belongs here too
* (test/unit/tool_uca_maps_error_disclosure.test.ts). */
export const REASON_CODES = new Set([
	'request.invalid_options',
	'tool.unsupported_target',
	'media.file_not_found'
])



/**
* TOOL_ERROR_TEXT
* Core's `error_text` shows only the code's generic label, never the reason a
* REASON_CODES refusal carries. Here the panel's own lead says what failed, in
* the user's language, and the reason follows on its own line. Other codes:
* core.
*
* @param {ApiError|Object} api_error
* @param {string} lead - the panel's sentence, already resolved (get_tool_label)
* @returns {string}
*/
export const tool_error_text = function(api_error, lead) {

	const reason = (api_error && REASON_CODES.has(api_error.code) && typeof api_error.message==='string')
		? api_error.message.trim()
		: ''

	return reason.length > 0
		? lead + '\n' + reason
		: error_text(api_error)
}//end tool_error_text



/**
* EXCEPTION_TEXT
* The same two lines for a client-side throw (a capture, a decode): no
* envelope ever existed, so the reason is the exception's own message.
*
* @param {Error|*} error
* @param {string} lead - the panel's sentence, already resolved (get_tool_label)
* @returns {string}
*/
export const exception_text = function(error, lead) {

	const reason = (error && typeof error.message==='string')
		? error.message.trim()
		: ''

	return reason.length > 0
		? lead + '\n' + reason
		: lead
}//end exception_text
