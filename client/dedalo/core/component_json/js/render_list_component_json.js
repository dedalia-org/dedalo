// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL */
/*eslint no-undef: "error"*/



// imports
	import {view_default_list_json} from './view_default_list_json.js'



/**
* RENDER_LIST_COMPONENT_JSON
* View-router for component_json in list and time-machine (tm) modes.
*
* This module is a thin dispatch layer: it reads `self.context.view` and
* delegates DOM construction to the matching view module:
*
*   - 'default'  → view_default_list_json     (standard list row; click opens a
*                                               full-screen modal JSON editor)
*   - 'mini'     → view_mini_json             (compact pill for autocomplete /
*                                               datalist contexts)
*   - 'text'     → view_text_json             (bare <span> for embedding in
*                                               rich-text or read-only contexts)
*   - 'collapse' → view_collapse_list_json    (collapsible row that also propagates
*                                               the toggle to sibling elements)
*
* component_json assigns this module's `list` prototype method to both
* `component_json.prototype.list`, so
* time-machine rows reuse the same rendering path without duplication.
*
* The constructor is never called directly; it exists only as a prototype
* carrier, following the Dédalo render-module pattern where the export is a
* no-op function and all real behaviour lives on its prototype.
*/
export const render_list_component_json = function() {

	return true
}//end render_list_component_json



/**
* LIST
* Entry point for rendering a component_json instance in list (or tm) mode.
* Reads `self.context.view` to select the appropriate view renderer and
* delegates to it, passing the live component instance (`self`) and any
* caller-supplied `options`.
*
* Called by `common.prototype.render` via `component_json.prototype.list`
*. The returned wrapper node is appended to the
* section's list row by the framework.
*
* The 'collapse' case is the only view specific to this component's list
* router; the 'mini' and 'text' views are shared with the edit router
* (render_edit_component_json) through the same view modules.
*
* @param {Object} options - Caller options forwarded verbatim to the chosen
*   view renderer. Most list-mode views do not consume this parameter.
* @returns {Promise<HTMLElement>} Resolves to the DOM wrapper built by the
*   selected view renderer.
*/
render_list_component_json.prototype.list = async function(options) {

	const self = this

	// view: read from context; fall back to 'default' when not set by the caller
		const view = self.context.view || 'default'

	// dispatch to the matching view module; each returns a Promise<HTMLElement>
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

		case 'collapse':
			// collapsible view – also toggles sibling .view_collapse elements in the same section row
			{
			// rare view: lazy-imported (S3-37 #3)
			const {view_collapse_list_json} = await import('./view_collapse_list_json.js')
			return view_collapse_list_json.render(self, options)
		}

		case 'default':
		default:
			// default: standard list wrapper with click-to-edit modal activation
			return view_default_list_json.render(self, options)
	}
}//end list



// @license-end
