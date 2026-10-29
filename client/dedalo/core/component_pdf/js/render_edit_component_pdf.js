// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/* global get_label, page_globals, SHOW_DEBUG */
/*eslint no-undef: "error"*/



// imports
	import {view_default_edit_pdf} from './view_default_edit_pdf.js'
	// rare views are lazy (CONVENTIONS S3-37 #3): the common render only needs the default view



/**
* RENDER_EDIT_COMPONENT_PDF
* Edit-mode render controller for component_pdf.
*
* Acts as the prototype source for component_pdf.prototype.edit (assigned in
* component_pdf.js). Dispatches rendering to the appropriate view module based
* on the view string read from self.context.view.
*
* Supported views and their delegates:
*  - 'mini'            — compact thumbnail/icon for autocomplete/list contexts (view_mini_pdf)
*  - 'player'/'viewer' — standalone PDF viewer without label or edit buttons (view_viewer_pdf)
*  - 'print'           — same DOM structure as 'default' but forces read-only permissions;
*                        the CSS class 'view_print' on the wrapper lets stylesheets target it
*  - 'line'            — same render as 'default' but without the label node
*  - 'default'         — full editable view with the embedded pdfjs iframe and tool buttons
*
* Exported symbol:
*  - render_edit_component_pdf  constructor (prototype host for .edit)
*/
export const render_edit_component_pdf = function() {

	return true
}//end render_edit_component_pdf



/**
* EDIT
* Entry point for edit-mode rendering. Reads the active view from
* self.context.view (not self.view — unlike component_image, this component
* reads context.view directly) and delegates to the correct view module.
*
* (!) The 'print' case intentionally falls through to the 'default' handler —
*     there is no `break` after `self.permissions = 1`. This is by design:
*     the print view reuses the full default DOM layout but forces permissions
*     to 1 so content_value renders in read-only mode. The wrapper will carry
*     the additional CSS class 'view_print' applied by build_wrapper_edit when
*     it detects a 'print' view, allowing print-specific CSS rules to apply.
*     Example generated class string:
*       "wrapper_component component_input_text oh14 oh1_oh14 edit view_print disabled_component"
*
* @param {Object} options - render options forwarded verbatim to the active view module
* @returns {Promise<HTMLElement>} the wrapper element (or content_data node when
*   render_level === 'content') produced by the chosen view module
*/
render_edit_component_pdf.prototype.edit = async function(options) {

	const self = this

	// view
		const view = self.context.view || 'default'

	switch(view) {

		case 'mini': {
			const {view_mini_pdf} = await import('./view_mini_pdf.js')
			return view_mini_pdf.render(self, options)
		}

		case 'player':
		case 'viewer': {
			const {view_viewer_pdf} = await import('./view_viewer_pdf.js')
			return view_viewer_pdf.render(self, options)
		}

		case 'print':
			// view print use the same view as default, except it will use read only to render content_value
			// as different view as default it will set in the class of the wrapper
			// sample: <div class="wrapper_component component_input_text oh14 oh1_oh14 edit view_print disabled_component">...</div>
			// take account that to change the css when the component will render in print context
			// for print we need to use read of the content_value and it's necessary force permissions to use read only element render
			self.permissions = 1

		case 'line':
		case 'default':
		default:
			return view_default_edit_pdf.render(self, options)
	}
}//end edit



// @license-end
