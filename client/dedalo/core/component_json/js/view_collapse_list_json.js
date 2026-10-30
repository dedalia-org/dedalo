// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL, JSONEditor */
/*eslint no-undef: "error"*/



// imports
	import {ui} from '../../common/js/ui.js'
	import {render_value} from '../../common/js/utils/render_escape.js'
	import {json_preview} from './json_preview.js'



/**
* VIEW_COLLAPSE_LIST_JSON
* Collapsible list-mode view for component_json.
*
* Activated when `context.view === 'collapse'` (see render_list_component_json.js).
* Renders the JSON component value as a summary string inside a wrapper that
* starts collapsed and expands on click.  Clicking also synchronizes all sibling
* `.view_collapse` elements inside the same section record row so that the whole
* record expands / collapses together.
*
* Special case: when the host section is the Activity log (dd542), the stored
* JSON object is treated as a flat key→value map and each pair is displayed on
* its own line instead of using the configurable `list_show_key`.
*
* Main exports:
*   - view_collapse_list_json        – view namespace / constructor stub
*   - view_collapse_list_json.render – async factory that returns the wrapper node
*   - get_value_lines                – pure helper for computing the display lines
*   - build_record_link              – Activity (dd542) "Go to record" button builder
*/
export const view_collapse_list_json = function() {

	return true
}//end view_collapse_list_json



/**
* RENDER
* Render node for use in this view
*
* Builds a `build_wrapper_list` node (standard list-mode shell), immediately
* marks it `.collapsed`, and attaches a click handler that:
*   1. Toggles `.collapsed` on the clicked wrapper.
*   2. Propagates the same toggle to every other `.view_collapse` element that
*      belongs to the same section-record row (wrapper.parentNode.parentNode),
*      so all collapsible components in the row expand/collapse in unison.
*
* The `.collapsed` CSS class is expected to be handled by the host stylesheet
* (typically applied to `.view_collapse` wrappers inside `.section_record`).
*
* @param {Object} self    - Component instance (component_json).  Must have
*                           `self.data`, `self.context`, and `self.section_tipo`.
* @param {Object} options - Reserved; currently unused in this view.
* @returns {Promise<HTMLElement>} wrapper - The constructed, event-bound DOM node.
*/
view_collapse_list_json.render = async function(self, options) {

	// value_string
		const value_string = render_value(get_value_lines(self), 'text').join('<br>')

	// wrapper
		const wrapper = ui.component.build_wrapper_list(self, {
			value_string : value_string
		})
		wrapper.classList.add('collapsed')
		wrapper.addEventListener('click', function(e) {
			e.stopPropagation()
			wrapper.classList.toggle('collapsed')

			// propagate to siblings
				const section_record = wrapper.parentNode.parentNode
				const elements_collapsed = section_record.querySelectorAll('.view_collapse')
				const elements_collapsed_length = elements_collapsed.length
				for (let i = 0; i < elements_collapsed_length; i++) {
					const item = elements_collapsed[i]
					if (item!==wrapper) {
						item.classList.toggle('collapsed')
					}
				}
		})

	// Activity (dd542): append a "Go to record" button that opens the visited
	// record in edit mode in a new browser tab. Rendered as a real anchor with
	// its own click handler so it neither toggles the row collapse nor relies on
	// the value_string innerHTML; CSS pins it to the row's right-hand zone so it
	// stays visible whether the row is collapsed or expanded. build_record_link
	// returns null when the entry has no usable section_id / tipo (older rows
	// logged before section_id was captured), in which case the row keeps the
	// plain key:value summary with no button.
		if (self.section_tipo==='dd542') {
			const record_link = build_record_link( self.data.entries?.[0]?.value )
			if (record_link) {
				wrapper.appendChild(record_link)
			}
		}


	return wrapper
}//end render



/**
* GET_VALUE_STRING
* Get component value as string
*
* Derives a human-readable summary string from `self.data.entries[0].value`
* using one of two strategies:
*
* 1. **Activity section (dd542):** The JSON value is a flat `{ key: value, … }`
*    map.  Each entry is rendered as `"key: value"` and the pairs are joined
*    with `<br>` tags for HTML display.
*
* 2. **Default:** A configurable key (`context.properties.list_show_key`,
*    falling back to `'msg'`) is read from the stored JSON object.  If the key
*    exists the corresponding sub-value is returned; otherwise the whole object
*    is JSON-stringified and truncated to 100 characters with " …" appended.
*    Returns an empty string when the entry value is falsy (null / undefined).
*
* Note: `data.entries[0].value` is expected to be a plain JS object (the
* component stores one entry per language; index 0 is the primary entry for
* the current request lang, as returned by the server API).
*
* @param {Object} self - Component instance.  Must expose:
*                        `self.data.entries` {Array}, `self.section_tipo` {string},
*                        and `self.context.properties` {Object|undefined}.
* @returns {string} value_string - HTML-safe display string (may contain <br>).
*/
export const get_value_lines = function(self) {

	// short vars
		const data	= self.data.entries
		const value	= data?.[0].value || {}

	// value_string
		// dd542 Activity section case
		if(self.section_tipo==='dd542') {
			// activity section case
			const ar_values	= []

			for (let [key, current_value] of Object.entries(value)) {
				ar_values.push( key + ': ' + current_value )
			}

			return ar_values
		}

	// default cases
		// list_show_key: the property name inside the stored JSON object whose value
		// should be used as the list display string.  Configured via ontology
		// properties; falls back to 'msg' when not set.
		const list_show_key = typeof self.context.properties!=='undefined'
			? self.context.properties.list_show_key
			: 'msg'

		// If the configured key is present, use its value directly.
		// Otherwise stringify the whole object (capped at 100 chars) so the cell
		// is never empty or misleading, even for unrecognised JSON shapes.
		const value_string = value && (typeof value[list_show_key]!=='undefined')
			? value[list_show_key]
			: value
				? json_preview(value, 100)+' ...'
				: ''


	return [value_string]
}//end get_value_lines



/**
* BUILD_RECORD_LINK
* Build a "Go to record" icon button (an anchor rendered as an icon) that opens
* the record referenced by an Activity (dd542) DATA entry in edit mode, in a new
* browser tab. The "Go to record" text is exposed as the icon's title / aria-label.
*
* The activity DATA value has the shape `{ id, msg, tipo }`, where `id` is the
* section_id of the record the user visited in edit mode and `tipo` is its
* section_tipo (for a section, section_tipo === tipo). The button uses Dédalo's
* deep-link URL scheme, resolved by the server `start` action on a fresh page
* load:
*
*   <page_path>?tipo=<tipo>&id=<section_id>&mode=edit&menu=false&session_save=false
*
* `section_tipo` is omitted because the server falls back to `section_tipo = tipo`
* (correct for a section). `menu=false` opens a clean standalone record view;
* `session_save=false` prevents the new tab from overwriting the main window's
* session SQO for this section.
*
* Returns null when the value lacks a usable section_id or tipo — e.g. older
* activity rows logged before section_id capture, or non-edit events — so the
* caller renders the plain key:value summary with no button (no regression).
*
* The returned anchor stops click propagation so that pressing the button does
* not also toggle the row's collapse state.
*
* @param {Object} value - Stored activity DATA object `{ id, msg, tipo }`.
* @returns {HTMLAnchorElement|null} Button anchor node, or null when not linkable.
*/
export const build_record_link = function(value) {

	// section_id. Require a positive integer (older rows log null / absent)
		const section_id = parseInt(value?.id, 10)
		if (!Number.isInteger(section_id) || section_id < 1) {
			return null
		}

	// tipo. Require a non-empty string (section_tipo of the visited record)
		const tipo = value?.tipo
		if (typeof tipo!=='string' || tipo==='') {
			return null
		}

	// href. Deep-link to the record in edit mode. Resolved by the server
	// `start` action when the new tab loads (reads these URL params).
		const href = window.location.pathname
			+ '?tipo='          + encodeURIComponent(tipo)
			+ '&id='            + encodeURIComponent(section_id)
			+ '&mode=edit'
			+ '&menu=false'
			+ '&session_save=false'

	// icon button (anchor rendered as an icon via .activity_record_button; the
	// icon shape is a CSS mask, see component_json.less). Icon-only to stay
	// unobtrusive in the row; the label is exposed via title (tooltip) and
	// aria-label only. Kept as an <a target="_blank"> so middle-click and
	// modifier-click open new tabs natively.
		const label = get_label.go_to_record || 'Go to record'
		const anchor = ui.create_dom_element({
			element_type	: 'a',
			class_name		: 'activity_record_button'
		})
		anchor.href		= href
		anchor.target	= '_blank'
		anchor.rel		= 'noopener'
		anchor.title	= label
		anchor.setAttribute('aria-label', label)
		anchor.addEventListener('click', (e) => {
			// Do not toggle the row collapse when the button itself is clicked.
			e.stopPropagation()
			// Mark as visited for immediate feedback so already-opened records
			// are easy to spot while scanning a long activity list. (The native
			// :visited pseudo-class also softens the icon across reloads via
			// browser history — see component_json.less.)
			anchor.classList.add('visited')
		})


	return anchor
}//end build_record_link



// @license-end
