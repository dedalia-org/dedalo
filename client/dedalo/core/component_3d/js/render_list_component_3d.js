// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_LIB_URL, DEDALO_CORE_URL */
/*eslint no-undef: "error"*/



// imports
	import {view_default_list_3d} from './view_default_list_3d.js'
	// rare views are lazy (CONVENTIONS S3-37 #3): the common render only needs the default view



/**
* RENDER_LIST_COMPONENT_3D
* List-mode render controller for the 3D model component.
*
* Acts as a view router: the single exported constructor is mixed into
* component_3d.prototype.list (and .tm) so that Dédalo's lifecycle can call
* instance.list(options) uniformly regardless of the configured view.
*
* Supported views (resolved from self.context.view):
*   'mini'    — compact thumbnail representation (view_mini_list_3d)
*   'text'    — plain-text / URL representation (view_text_list_3d)
*   'column'  — falls through to default (grid-column layout)
*   'default' — full media thumbnail with viewer launcher (view_default_list_3d)
*
* This file intentionally contains no rendering logic itself; all DOM work
* lives in the per-view modules imported above.
*/
export const render_list_component_3d = function() {

	return true
}//end  render_list_component_3d



/**
* LIST
* Entry point for list-mode (and time-machine-mode) rendering of a 3D component.
* Reads `self.context.view` to select the correct view module and delegates
* rendering to it. Falls back to 'default' when the view is unrecognised or absent.
*
* The 'column' view name is an alias for 'default', kept for ontology back-compat —
* both fall through to view_default_list_3d.
*
* @param {Object} options - Render options forwarded verbatim to the view module.
*   Notable key: `options.render_level` ('full' | 'content') — when 'content',
*   view_default_list_3d short-circuits and returns the inner content_data node
*   rather than the full wrapper (used for in-place refresh without re-wrapping).
* @returns {Promise<HTMLElement>} Resolves to the wrapper (or content_data) node
*   produced by the selected view module.
*/
render_list_component_3d.prototype.list = async function(options) {

	const self = this

	// view
	// Resolve the display variant from the component context; default is 'default'.
		const view = self.context.view || 'default'

	switch(view) {

		case 'mini': {
			const {view_mini_list_3d} = await import('./view_mini_list_3d.js')
			return view_mini_list_3d.render(self, options)
		}

		case 'text': {
			const {view_text_list_3d} = await import('./view_text_list_3d.js')
			return view_text_list_3d.render(self, options)
		}

		case 'column':
		// (!) 'column' is an ontology alias for the default grid-column layout;
		// it intentionally falls through to 'default'.
		case 'default':
		default:
			return view_default_list_3d.render(self, options)
	}
}//end list



// @license-end
