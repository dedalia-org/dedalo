// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL*/
/*eslint no-undef: "error"*/



/**
* VIEW_DEFAULT_LIST_IRI
* Standard list-row renderer for `component_iri` in 'default' list/tm mode.
*
* Converts the component's `data.entries` array into a single plain-text summary
* string that is injected into a standard list wrapper built by
* `ui.component.build_wrapper_list`. Clicking the wrapper opens the edit modal so
* the user can modify URLs and titles without leaving the list context.
*
* This view is the fallback chosen by `render_list_component_iri.prototype.list`
* when `self.context.view` is 'default' or unrecognised.
*
* Data shape consumed (`self.data`):
*   {
*     entries: Array<{ iri: string, title: string, id: number|string }>
*   }
*
* Each entry is collapsed to a pipe-separated string ("title | iri"); entries are
* then joined with '<br>' so multiple IRIs each appear on their own line inside
* the list cell.
*
* Compare with:
*   - `view_mini_iri`       — renders live anchor links; used by datalists / autocomplete
*   - `view_text_list_iri`  — renders plain text with title-dataframe lookup; used for exports
*
* @exports {Function} view_default_list_iri - constructor (namespace host for static render)
*/



// imports
	import {ui} from '../../common/js/ui.js'
	import {render_value} from '../../common/js/utils/render_escape.js'
	import {bind_edit_in_list} from '../../component_common/js/component_common.js'



/**
* VIEW_DEFAULT_LIST_IRI
* Constructor / namespace host.
* This function is never instantiated with `new`; it acts purely as a namespace
* that carries the static `render` method below. The pattern is shared across all
* Dédalo view modules (view_default_edit_iri, view_mini_iri, etc.).
*/
export const view_default_list_iri = function() {

	return true
}//end view_default_list_iri



/**
* RENDER
* Builds and returns the list-row wrapper node for a `component_iri` instance
* rendered in 'default' list view.
*
* Behaviour:
*  1. Iterates `data.entries`; for each entry joins the optional `title` and `iri`
*     fields with ' | '.  Entries where both are absent are silently skipped.
*  2. Joins the per-entry strings with '<br>' to produce a multi-line HTML snippet
*     (`value_string`).  If all entries are empty, `value_string` is `null` and
*     `build_wrapper_list` renders an empty cell.
*  3. Delegates DOM construction to `ui.component.build_wrapper_list`, which
*     attaches standard CSS classes, custom ontology CSS, and debug mouse
*     handlers. The resulting `<div>` is returned as the component node.
*  4. Attaches a click listener that calls `activate_edit_in_list` in 'modal' mode
*     with a 40 rem width.  `activate_edit_in_list` is a no-op when the component
*     is read-only (`self.permissions < 2`) or is nested inside a dataframe, so no
*     guard is needed here.
*
* Note: `value_string` is embedded via `inner_html` inside `build_wrapper_list`,
* so `<br>` tags render as real line breaks. The title and IRI values come from
* `entries[i].title` (legacy inline label) directly — this view does NOT resolve
* the paired label dataframe (see `view_text_list_iri` for the dataframe-aware
* equivalent).
*
* @param {Object} self    - The `component_iri` instance; must have `self.data`
*   populated by the API response. `self.data.entries` defaults to `[]` when absent.
* @param {Object} options - Render options object forwarded from the list dispatcher.
*   Currently unused in this view but kept for interface parity.
* @returns {Promise<HTMLElement>} Resolves to the list-row wrapper `<div>` element,
*   ready to be inserted into the record grid.
*/
view_default_list_iri.render = async function(self, options) {

	// short vars
		const data		= self.data || {}
		const entries	= data.entries || []

	// Value as string
		const ar_value_string	= [];
		const entries_length	= entries.length
		for (let i = 0; i < entries_length; i++) {

			const ar_line = []

			// Prefer the legacy inline title over a bare IRI; both are appended
			// when present so the cell shows "My Site | https://example.com".
			if (entries[i].title) {
				ar_line.push(render_value(entries[i].title, 'text'))
			}
			if (entries[i].iri) {
				ar_line.push(render_value(entries[i].iri, self.context.render_class))
			}

			// Only add a row when at least one field carries data.
			if (ar_line.length>0) {
				ar_value_string.push(ar_line.join(' | '))
			}
		}
		// Join entries with <br> so each IRI appears on its own line in the cell.
		// Null signals an empty component to build_wrapper_list (no <span> is injected).
		const value_string = (ar_value_string && ar_value_string.length)
			? ar_value_string.join('<br>') // lines rendered above (title text, iri url)
			: null

	// wrapper
		const wrapper = ui.component.build_wrapper_list(self, {
			value_string : value_string
		})

	// click handler for edit mode activation (modal)
		// 'modal' mode is enforced here (not 'auto') because IRI editing requires
		// two fields per entry (title + URL) which need the extra width of the modal.
		// activate_edit_in_list skips silently when the component is read-only or
		// nested inside a dataframe, so no additional guard is required.
		bind_edit_in_list(self, wrapper, { mode: 'modal', modal_width: '40rem' })


	return wrapper
}//end render



// @license-end
