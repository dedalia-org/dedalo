// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*eslint no-undef: "error"*/



import {error_text} from '../../../core/common/js/render_api_error.js'



/**
* TOOL_ERROR_TEXT
* `request.invalid_options` is how this tool's server refuses an input, with
* the concrete reason as its public message; core's `error_text` shows only
* the code's generic label. Here the panel's own lead says what failed, in the
* user's language, and the reason follows on its own line. Other codes: core.
*
* @param {ApiError|Object} api_error
* @param {string} lead - the panel's sentence, already resolved (get_tool_label)
* @returns {string}
*/
export const tool_error_text = function(api_error, lead) {

	const reason = (api_error && api_error.code==='request.invalid_options' && typeof api_error.message==='string')
		? api_error.message.trim()
		: ''

	return reason.length > 0
		? lead + '\n' + reason
		: error_text(api_error)
}//end tool_error_text
