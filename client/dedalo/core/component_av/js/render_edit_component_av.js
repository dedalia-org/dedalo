// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global */
/*eslint no-undef: "error"*/



// imports
	import {view_default_edit_av} from './view_default_edit_av.js'
	// player/viewer views are lazy (CONVENTIONS S3-37 #3, tool-scale: transcription/indexation/viewer): the common edit
	// render only needs the default view



/**
* RENDER_EDIT_COMPONENT_AV
* View-router for the audio/video component in edit mode.
*
* This constructor is the prototype host for the component's edit-side rendering
* logic. Its single public method, `edit`, reads `self.context.view` and
* delegates rendering to one of three specialised view modules:
*
*   - view_default_edit_av  — standard thumbnail + inline video player (default/line/print)
*   - view_player_edit_av   — full-featured timecode-aware player (used by the annotator)
*   - view_viewer_edit_av   — lightweight read-only viewer (used inside autocomplete/service UIs)
*
* Prototype instances are mixed into component_av instances by the component's
* build pipeline; callers always invoke `instance.render()` rather than
* constructing this class directly.
*/
export const render_edit_component_av = function() {

	return true
}//end render_edit_component_av



/**
* EDIT
* Selects and delegates to the appropriate view renderer based on `context.view`.
*
* The `view` value originates from the server-side context object and controls
* which UI variant is presented to the editor:
*
*   'player'  → full timecode-aware player (view_player_edit_av)
*   'viewer'  → lightweight viewer, e.g. inside autocomplete overlays (view_viewer_edit_av)
*   'print'   → falls through to 'default' after forcing read-only permissions (permissions=1)
*   'line'    → compact single-row layout via view_default_edit_av
*   'default' → standard edit layout with posterframe + inline video + quality selector
*
* (!) The 'print' case intentionally falls through to 'default' without a break/return.
*     It first downgrades `self.permissions` to 1 (read-only) so that view_default_edit_av
*     suppresses interactive controls, then renders the default layout. This is a
*     deliberate switch fall-through — do not add a break here.
*
* @param {Object} options - Render options forwarded unchanged to the chosen view renderer.
*   Recognised keys include `render_level` ('full'|'content') as consumed by sub-renderers.
* @returns {Promise<HTMLElement>} The rendered wrapper (or content_data node when
*   render_level === 'content') produced by the selected view module.
*/
render_edit_component_av.prototype.edit = async function(options) {

	const self = this

	// view
		const view = self.context.view || 'default'

	switch(view) {

		case 'player': {
			const {view_player_edit_av} = await import('./view_player_edit_av.js')
			return view_player_edit_av.render(self, options)
		}

		case 'viewer': {
			const {view_viewer_edit_av} = await import('./view_viewer_edit_av.js')
			return view_viewer_edit_av.render(self, options)
		}

		case 'print':
			// for print we need to use read of the content_value and it's necessary force permissions to use read only element render
			self.permissions = 1

		case 'line':
		case 'default':
		default:
			return view_default_edit_av.render(self, options)
	}
}//end edit



// @license-end
