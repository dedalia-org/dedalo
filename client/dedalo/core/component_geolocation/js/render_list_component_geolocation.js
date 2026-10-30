// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL */
/*eslint no-undef: "error"*/



// imports
	import {view_default_list_geolocation} from './view_default_list_geolocation.js'



/**
* RENDER_LIST_COMPONENT_GEOLOCATION
* View-dispatcher for component_geolocation in list (read-only) contexts.
*
* This module is the render entry point for every list-mode display of
* geolocation data. It is assigned to component_geolocation.prototype.list
* from component_geolocation.js and is never instantiated directly — the
* constructor is a no-op placeholder required by Dédalo's prototype-assignment
* pattern.
*
* The active view is determined by `self.context.view` (populated by the
* server context layer). Supported values:
*   'mini'    — compact inline representation; used in relation-picker
*               autocomplete lists and datalist popups
*   'text'    — renders geolocation entries serialised to JSON inside a
*               <span> wrapper; suited for inline/portal contexts
*   'default' — standard list column wrapper produced by
*               ui.component.build_wrapper_list; entries are JSON-serialised
*               and joined with self.context.fields_separator
*
* All view modules receive `self` (the component instance) and `options`
* unchanged, so they have full access to self.data, self.context, etc.
*/
export const render_list_component_geolocation = function() {

	return true
}//end render_list_component_geolocation



/**
* LIST
* View-dispatch entry point for component_geolocation list-mode rendering.
*
* Reads `self.context.view` (set by the server context layer) to select the
* appropriate view module and delegates all DOM construction to it. When the
* view is absent or unrecognised the method falls back to 'default'.
*
* Geolocation data shape (self.data):
*   { entries: Array<Object> }
* Each entry is a GeoJSON-compatible coordinate/feature object; the view
* modules serialise them with JSON.stringify and join them via
* self.context.fields_separator before inserting into the DOM.
*
* @param {Object} options - render options forwarded verbatim to the chosen
*   view module (e.g. render_level, mode overrides)
* @returns {Promise<HTMLElement>} the rendered wrapper element
*/
render_list_component_geolocation.prototype.list = async function(options) {

	const self = this

	// view
		const view	= self.context.view || 'default'

	switch(view) {

		// rare views are lazy (S3-37 #3)
		case 'mini': {
			const {view_mini_geolocation} = await import('./view_mini_geolocation.js')
			return view_mini_geolocation.render(self, options)
		}

		case 'text': {
			const {view_text_list_geolocation} = await import('./view_text_list_geolocation.js')
			return view_text_list_geolocation.render(self, options)
		}

		case 'default':
		default:
			return view_default_list_geolocation.render(self, options)
	}
}//end list



// @license-end
