// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_LIB_URL, DEDALO_CORE_URL */
/*eslint no-undef: "error"*/



// imports
	import {view_default_list_av} from './view_default_list_av.js'
	// mini/text views are lazy (CONVENTIONS S3-37 #3, rarely hit)



/**
* RENDER_LIST_COMPONENT_AV
* View-dispatcher for component_av in list and TM modes.
*
* This module acts as the render entry point for all list-context display of
* audio/video components. It is mounted on component_av.prototype.list from
* component_av.js; Time Machine cells are list cells and reuse it.
*
* The constructor is a no-op placeholder required by the prototype-assignment
* pattern: all behaviour lives in the prototype methods below.
*
* Supported views (controlled via self.context.view):
*   'mini'    — compact thumbnail; used in relation pickers and inline grids
*   'text'    — thumbnail inside a <span> wrapper; used when inline block
*               layout is required (e.g. portal inline display)
*   'column'  — alias for 'default'; included so that column-layout callers
*               can name the view explicitly without falling through to the
*               default case
*   'default' — standard list column: wrapper + content_data with lazy-loaded
*               thumbnail that opens the media viewer on click
*/
export const render_list_component_av = function() {

	return true
}//end  render_list_component_av



/**
* LIST
* View-dispatch entry point for component_av list and TM render modes.
*
* Reads `self.context.view` (set by the server context layer) to choose the
* appropriate view module and delegates rendering entirely to it. Falls back
* to 'default' when the view is absent or unrecognised.
*
* Time Machine cells reuse this same list presentation — they are emitted as
* LIST cells (WC-2026-08-14-tm-ddo-mode-retired).
*
* @param {Object} options - render options forwarded verbatim to the view module
* @param {string} [options.render_level='full'] - 'full' builds the wrapper +
*   content_data; 'content' returns only the content_data fragment (used when
*   the caller controls the outer wrapper)
* @returns {Promise<HTMLElement>} the rendered wrapper (or content_data fragment
*   when render_level === 'content')
*/
render_list_component_av.prototype.list = async function(options) {

	const self = this

	// view
	// Resolve from the server-provided context; defaults to 'default' when absent.
		const view = self.context.view || 'default'

	switch(view) {

		case 'mini': {
			const {view_mini_list_av} = await import('./view_mini_list_av.js')
			return view_mini_list_av.render(self, options)
		}

		case 'text': {
			const {view_text_list_av} = await import('./view_text_list_av.js')
			return view_text_list_av.render(self, options)
		}

		case 'column':
		case 'default':
		default:
			return view_default_list_av.render(self, options)
	}
}//end list



// @license-end
