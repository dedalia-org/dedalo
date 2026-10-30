// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/* global get_label, page_globals, SHOW_DEBUG */
/*eslint no-undef: "error"*/



// imports
	import {view_default_edit_json} from './view_default_edit_json.js'



/**
* RENDER_EDIT_COMPONENT_JSON
* Edit-mode render mixin for component_json.
*
* This module is NOT a standalone class. It is a prototype-assignment vehicle:
* component_json.prototype.edit is wired to
* render_edit_component_json.prototype.edit (see component_json.js).
* The constructor itself is a no-op placeholder so that the prototype.edit
* method can be attached to it in the standard Dédalo pattern.
*
* View routing (delegated to view modules):
*   'mini'    — compact representation for service_autocomplete dropdowns
*               (view_mini_json.render)
*   'text'    — bare inline span with the serialized JSON string; no chrome
*               (view_text_json.render)
*   'print'   — forces read-only (permissions=1) then falls through to 'default';
*               renders a <pre>-formatted JSON block via view_default_edit_json
*   'line'    — same widget as 'default' but without the label row
*               (view_default_edit_json.render)
*   'default' — full wrapper with label, toolbar buttons, and the JSONEditor
*               (svelte-jsoneditor / CodeMirror 6) lazy-loaded on viewport entry
*               (view_default_edit_json.render)
*
* Data shape expected on self.data:
*   entries {Array<{id: number|null, lang: string, value: Object|null}>}
*     Exactly one item is used at index 0; the stored value is a plain JSON
*     object (not a string). Multi-entry JSON is not supported and will log a
*     console warning if encountered.
*
* Global references (declared in /*global*\/ directive above):
*   get_label       — localised label map
*   page_globals    — runtime page configuration (used by child view modules)
*   SHOW_DEBUG      — debug verbosity flag (used by child view modules)
*/
export const render_edit_component_json = function() {

	return true
}//end render_edit_component_json



/**
* EDIT
* Entry point for all edit-mode rendering of component_json.
*
* Reads self.context.view (defaulting to 'default') and delegates to the
* appropriate view renderer. Each view renderer returns a fully constructed
* HTMLElement that the caller appends to the DOM.
*
* View routing:
*   'mini'    — compact widget for service_autocomplete; calls view_mini_json.render
*   'text'    — bare <span> containing the serialized JSON value; calls view_text_json.render
*   'print'   — mutates self.permissions to 1 (read-only) and falls through to 'default'
*   'line'    — same full editor as 'default', rendered without a label row
*   'default' — full wrapper with label, download button, and lazy-loaded JSONEditor
*
* (!) The 'print' case intentionally falls through to 'default' (no break/return).
*     It sets self.permissions = 1 so that view_default_edit_json renders a read-only
*     <pre>-formatted block instead of the interactive JSONEditor. This mutation is
*     side-effectful on the component instance for the duration of the render call.
*
* @param {Object} options - Render options forwarded verbatim to the selected view renderer
* @returns {Promise<HTMLElement>} Resolved component wrapper node
*/
render_edit_component_json.prototype.edit = async function(options) {

	const self = this

	// view
		const view = self.context.view || 'default'

	switch(view) {

		case 'mini':
			{
			// rare view: lazy-imported (S3-37 #3)
			const {view_mini_json} = await import('./view_mini_json.js')
			return view_mini_json.render(self, options)
		}

		case 'text':
			{
			// rare view: lazy-imported (S3-37 #3)
			const {view_text_json} = await import('./view_text_json.js')
			return view_text_json.render(self, options)
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
			return view_default_edit_json.render(self, options)
	}
}//end edit



// @license-end
