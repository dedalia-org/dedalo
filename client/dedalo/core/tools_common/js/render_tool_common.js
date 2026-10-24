// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global  */
/*eslint no-undef: "error"*/

// imports
	import {ui} from '../../../core/common/js/ui.js'



/**
* RENDER_ERROR
* Builds and returns the fallback error UI for a tool instance whose init or
* build phase set `self.error`. Called by `tool_common.prototype.render` when
* `typeof self.error !== 'undefined'`, so the caller never receives a blank or
* broken tool panel — instead the user sees a styled message with an info icon
* and instructions to close and re-open the tool.
*
* When `options.render_level` is `'content'` only the inner `content_data` div
* is returned (used when composing tool panels that already have their own
* wrapper). For any other render level — including the default `'full'` — the
* div is wrapped with `ui.tool.build_wrapper_edit`, which adds the standard
* tool chrome (title bar, close button, etc.).
*
* @param {Object} self - Tool instance; must have `self.error` set to a
*   non-empty string describing what went wrong.
* @param {Object} options - Render options forwarded from `tool_common.prototype.render`.
* @param {string} [options.render_level='full'] - Depth of the rendered output:
*   `'full'` returns a complete wrapper node; `'content'` returns the inner
*   content div only.
* @returns {Promise<HTMLElement>} The error wrapper (full render) or content div
*   (content render).
*/
export const render_error = async function(self, options) {

	// render level
		const render_level = options.render_level || 'full'

	// content_data
		const content_data = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'content_data tool tool_error content_data_error',
			text_content	: 'Error : ' + self.error + ' Try to close the tool and re-open it'
		})

	// icon_info
	// Prepend the info icon so it appears to the left of the error message text.
		const icon_info = ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'button icon info'
		})
		content_data.prepend(icon_info)

	// Early return for content-only render (no outer tool wrapper needed).
		if (render_level==='content') {
			return content_data
		}

	// wrapper. ui build_edit returns tool wrapper
	// For the full render level, wrap content_data in the standard tool shell
	// (title bar, resize handles, close button) so the error panel is dockable.
		const wrapper = ui.tool.build_wrapper_edit(self, {
			content_data : content_data
		})


	return wrapper
}//end render_error



// @license-end
