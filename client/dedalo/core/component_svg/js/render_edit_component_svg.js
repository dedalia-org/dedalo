// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL*/
/*eslint no-undef: "error"*/



// imports
	import {view_default_edit_svg} from './view_default_edit_svg.js'
	// rare views are lazy (CONVENTIONS S3-37 #3): the common render only needs the default view



/**
* RENDER_EDIT_COMPONENT_SVG
* Edit-mode render controller for component_svg.
*
* Acts as the prototype source for component_svg.prototype.edit (assigned in
* component_svg.js). Its sole responsibility is to inspect the component
* instance's `self.context.view` property and delegate rendering to the
* correct view module:
*
*  - view_line_edit_svg    — compact single-row layout (no label)
*  - view_default_edit_svg — full editable layout with tool buttons and optional
*                            fullscreen toggle; also used for print rendering
*                            (with forced read-only permissions)
*
* Exported symbols:
*  - render_edit_component_svg  constructor (prototype host for .edit)
*/
export const render_edit_component_svg = function() {

	return true
}//end render_edit_component_svg



/**
* EDIT
* Entry point for edit-mode rendering. Reads `self.context.view` to select the
* appropriate view module and delegates rendering to it.
*
* Supported views:
*  - 'line'    — compact row layout via view_line_edit_svg; no component label
*                is rendered and an exit-edit button is appended inside
*                content_data
*  - 'print'   — read-only rendering: sets self.permissions = 1 to force the
*                read-only content_value path, then falls through to 'default'
*                so view_default_edit_svg builds the DOM; the wrapper element
*                will carry the CSS class 'view_print' so stylesheets can
*                differentiate it visually (e.g. hide upload controls)
*  - 'default' — full editable layout with lazy-loaded SVG preview, tool
*                buttons, and optional fullscreen button
*
* (!) The 'print' case intentionally falls through to 'default' — there is no
*     break after `self.permissions = 1`. This is by design so that the print
*     view reuses the default DOM layout while rendering content read-only.
*     Do not insert a break or return here without considering that contract.
*
* (!) View is read from `self.context.view`, not `self.view`. This differs from
*     the analogous component_image controller which reads `self.view` directly.
*     The context object is the server-authoritative source for view in this
*     component.
*
* @param {Object} options - render options forwarded verbatim to the active view
*   module; at minimum `options.render_level` ('full' | 'content') controls
*   whether the full wrapper or only content_data is returned
* @returns {Promise<HTMLElement>} the wrapper (or content_data) element produced
*   by the chosen view module
*/
render_edit_component_svg.prototype.edit = async function(options) {

	const self = this

	// view
		const view = self.context.view || 'default'

	switch(view) {

		case 'line': {
			const {view_line_edit_svg} = await import('./view_line_edit_svg.js')
			return view_line_edit_svg.render(self, options)
		}

		case 'print':
			// view print use the same view as default, except it will use read only to render content_value
			// as different view as default it will set in the class of the wrapper
			// sample: <div class="class="wrapper_component component_svg rsc855 rsc170_rsc855 edit view_default disabled_component active">...</div>
			// take account that to change the css when the component will render in print context
			// for print we need to use read of the contect_value and it's necessary force permissions to use read only element render
			self.permissions = 1

		case 'default':
		default:
			return view_default_edit_svg.render(self, options)
	}
}//end edit



// @license-end
