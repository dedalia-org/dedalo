// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/* global get_label, Promise, SHOW_DEBUG, DEDALO_CORE_URL */
/*eslint no-undef: "error"*/



// imports
	import {view_default_list_portal} from './view_default_list_portal.js'
	import {view_mini_portal} from './view_mini_portal.js'
	import {view_text_list_portal} from './view_text_list_portal.js'
	import {view_line_list_portal} from './view_line_list_portal.js'
	//indexation
	import {view_indexation_list_portal} from './view_indexation_list_portal.js'
	// dataframe views (outside this portal)
	import {view_default_list_dataframe} from '../../component_dataframe/js/view_default_list_dataframe.js'
	import {view_mini_list_dataframe} from '../../component_dataframe/js/view_mini_list_dataframe.js'



/**
* RENDER_LIST_COMPONENT_PORTAL
*
* Prototype mixin that provides the `list` render method for `component_portal`
* (and for `component_dataframe` when rendered in list mode).
*
* The constructor is a no-op stub — its sole purpose is to act as the prototype
* host so that `component_portal.prototype` can be augmented with the methods
* defined here via `Object.assign` or direct prototype assignment.
*
* Exported symbol mixed into `component_portal` in component_portal.js:
*   Object.assign(component_portal.prototype, render_list_component_portal.prototype)
*
* View routing table (resolved by `list()`):
*   'line'             → view_line_list_portal
*   'mini'             → view_mini_portal
*   'text'             → view_text_list_portal
*   'indexation'       → view_indexation_list_portal
*   'dataframe_default'→ view_default_list_dataframe
*   'dataframe_text'   → view_mini_list_dataframe
*   'dataframe_mini'   → view_mini_list_dataframe
*   'mosaic' | 'default' | (fallback) → view_default_list_portal
*
* When the caller's model is 'component_dataframe' the view name is automatically
* prefixed with 'dataframe_' so that the same view string ('default', 'mini', …)
* resolves to the correct dataframe-specific renderer instead of the portal one.
*
* @see component_portal.js for the host constructor and mixin wiring.
* @see render_edit_component_portal.js, render_search_component_portal.js
*      for the equivalent edit/search render mixins.
* @see docs/core/components/component_portal.md for the full specification.
*/
export const render_list_component_portal = function() {

	return true
}//end render_list_component_portal



/**
* LIST
* Entry point for list-mode rendering of a portal (or dataframe) component.
*
* Resolves the active view name from `self.view`, `self.context.view`, or the
* 'default' fallback, then delegates to the matching view module's static
* `render()` method.
*
* When the component model is 'component_dataframe' the view name is prefixed
* with 'dataframe_' before the switch so that identical context.view strings
* (e.g. 'default') route to dataframe-specific renderers without changing the
* value stored in the context.  The guard `!current_view.startsWith('dataframe_')`
* prevents double-prefixing if a caller has already set the prefixed form.
*
* @param {Object} options               - Render options passed through unchanged to the view module.
* @param {string} [options.render_level='full'] - 'full' builds the complete wrapper;
*                                          'content' rebuilds only the inner content area.
* @returns {Promise<HTMLElement|null>} Resolves to the wrapper HTMLElement produced by
*                                      the selected view renderer, or null on error.
*/
render_list_component_portal.prototype.list = async function(options) {

	const self = this

	// view
		// used the prefix dataframe for component_dataframes view
		const dataframe	= (self.model === 'component_dataframe')
			? 'dataframe_'
			: ''

		// get the view defined in context; if it is not set, use default
		const current_view	= self.view || self.context?.view || 'default'
		// Prefix with 'dataframe_' only when needed: skip if already prefixed
		// to avoid producing 'dataframe_dataframe_default'.
		const view			= (dataframe && !current_view.startsWith('dataframe_'))
			? `${dataframe}${current_view}`
			: current_view

	switch(view) {

		case 'line':
		// 'tree' (relation parent/children) rows are view_text inline runs: the
		// default view's column grid would scatter their values and separators
		case 'tree':
			return view_line_list_portal.render(self, options)

		case 'mini':
			return view_mini_portal.render(self, options)

		case 'text':
			return view_text_list_portal.render(self, options)

		case 'indexation':
			return view_indexation_list_portal.render(self, options)

		case 'dataframe_default':
			return view_default_list_dataframe.render(self, options)

		// dataframe_text and dataframe_mini share the same compact renderer
		case 'dataframe_text':
		case 'dataframe_mini':
			return view_mini_list_dataframe.render(self, options)

		// 'mosaic' is accepted for forward-compatibility but falls through to 'default'
		case 'mosaic':
		case 'default':
		default:
			return view_default_list_portal.render(self, options)
	}
}//end list



// @license-end
