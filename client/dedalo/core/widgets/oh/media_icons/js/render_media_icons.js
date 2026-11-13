// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL */
/*eslint no-undef: "error"*/



/**
* RENDER_MEDIA_ICONS
* Client-side renderer for the `media_icons` Oral History widget.
*
* This module renders the edit- and list-mode DOM for the `media_icons` widget,
* which displays a compact row of action icons for each audiovisual (A/V) record
* linked to the current section (typically an Oral History interview).
*
* For every linked A/V record the widget produces one `<li>` row that contains:
*   - ID cell         — numeric section_id; clicking opens the media record in a
*                       new browser window for review.
*   - A/V icon (av)   — clicking opens the media viewer (component_tipo-rooted URL).
*   - TR link         — opens the transcription tool in a modal via `open_tool`.
*   - IN link         — opens the indexation tool in a modal via `open_tool`.
*   - TL link         — opens the translation tool in a modal via `open_tool`.
*   - TC cell         — time-code / duration string read from the server value
*                       (e.g. "00:05:23").
*
* Data contract (populated by class.media_icons.php → `self.value`):
*   `self.value` is an Array of per-locator Objects.  Each object has the shape:
*   {
*     widget        : "media_icons",
*     id            : {
*       widget      : "media_icons",
*       key         : {number},          // IPO index
*       widget_id   : "id",
*       locator     : {                  // dd151 relation locator
*         type              : "dd151",
*         section_id        : {string},
*         section_tipo      : {string},  // e.g. "rsc167"
*         from_component_tipo : {string} // e.g. "oh25"
*       },
*       value       : {string}           // section_id as string
*     },
*     transcription : { widget_id: "transcription", tool_context: {Object}|null, locator: {Object} },
*     indexation    : { widget_id: "indexation",    tool_context: {Object}|null, locator: {Object} },
*     translation   : { widget_id: "translation",   tool_context: {Object}|null, locator: {Object} },
*     tc            : { widget_id: "tc",             value: {string},            locator: {Object} }
*   }
*
* `self.ipo` is the raw IPO config array coming from the ontology (one entry per
* widget state).  The renderer uses `self.ipo[i].input.paths[0][0]` to resolve
* the `section_tipo` / `component_tipo` needed to build the A/V viewer URL.
*
* The exported constructor `render_media_icons` is a no-op stub; all logic lives
* on its prototype and is mixed into the `media_icons` class via:
*   `media_icons.prototype.edit = render_media_icons.prototype.edit`
*   `media_icons.prototype.list = render_media_icons.prototype.list`
* (see media_icons.js).  This object is never instantiated directly.
*
* Companion files:
*   - media_icons.js            — constructor + prototype wiring
*   - class.media_icons.php     — PHP server-side data builder
*   - css/media_icons.less      — widget styles (flex-row layout per record)
*
* @module render_media_icons
*/

// imports
	import {ui} from '../../../../common/js/ui.js'
	import {open_tool} from '../../../../../core/tools_common/js/tool_common.js'
	import {get_caller_by_model, object_to_url_vars, open_window} from '../../../../common/js/utils/index.js'



/**
* RENDER_MEDIA_ICONS
* Constructor stub for the render_media_icons prototype mixin.
* All render logic is defined on the prototype and mixed into `media_icons`.
* @returns {boolean} true
*/
export const render_media_icons = function() {

	return true
}//end render_media_icons



/**
* EDIT
* Builds the DOM subtree for the widget when displayed in `edit` or
* `edit_in_list` mode.
*
* The rendering is delegated to the private `get_content_data_edit` helper,
* which iterates over every linked A/V record in `self.value` and produces a
* `<ul>` list of icon rows.
*
* When `options.render_level === 'content'` the raw `content_data` `<div>` is
* returned without any wrapper, allowing the caller to embed it inline.
* Otherwise the content is wrapped with `ui.widget.build_wrapper_edit`.
*
* @param {Object} options
* @param {string} options.render_level - Rendering scope: `'content'` returns
*   only the inner node; any other value returns the full wrapper element.
* @returns {Promise<HTMLElement>} Resolves to either the content_data div (when
*   render_level is 'content') or the full wrapper element.
*/
render_media_icons.prototype.edit = async function(options) {

	const self = this

	const render_level = options.render_level

	// content_data
		const content_data = await get_content_data_edit(self)
		if (render_level==='content') {
			return content_data
		}

	// wrapper. ui build_edit returns widget wrapper
		const wrapper = ui.widget.build_wrapper_edit(self, {
			content_data : content_data
		})


	return wrapper
}//end edit



/**
* LIST
* Builds the DOM subtree for the widget when displayed in `list` or
* `list_in_list` mode.
*
* The list view renders the same icon rows as the edit view — there is no
* read-only simplification.  Both modes call `get_content_data_edit` and wrap
* the result with `ui.widget.build_wrapper_edit`.
*
* @param {Object} options
* @param {string} options.render_level - Rendering scope: `'content'` returns
*   only the inner node; any other value returns the full wrapper element.
* @returns {Promise<HTMLElement>} Resolves to either the content_data div (when
*   render_level is 'content') or the full wrapper element.
*/
render_media_icons.prototype.list = async function(options) {

	const self = this

	const render_level = options.render_level

	// content_data
		const content_data = await get_content_data_edit(self)
		if (render_level==='content') {
			return content_data
		}

	// wrapper. ui build_list returns widget wrapper
		const wrapper = ui.widget.build_wrapper_edit(self, {
			content_data : content_data
		})


	return wrapper
}//end list



/**
* GET_CONTENT_DATA_EDIT
* Builds the inner content DOM — a `<ul class="values_container">` holding one
* `<li>` per linked A/V record per IPO entry.
*
* Iteration strategy:
*   Outer loop → `self.value`  (one item per linked A/V locator)
*   Inner loop → `self.ipo`    (one entry per ontology widget-state / IPO config)
* Each combination produces one row via `get_value_element`.
*
* (!) Both loops use the loop variable `i`, with the inner loop shadowing the
* outer `i`.  This does not cause incorrect output because the outer `i` is
* never read inside the inner loop body — only `data_item` (captured before the
* inner loop) is used — but the shadowing may be confusing.
*
* @param {Object} self - The `media_icons` instance (bound via closure; not
*   injected via `this` because this function is called as a plain function,
*   not as a method).
* @param {Array}  self.value - Array of per-locator data objects from the PHP
*   server response (see module doc-block for full shape).
* @param {Array}  self.ipo   - Array of IPO config objects from the ontology.
* @returns {Promise<HTMLElement>} A `<div>` containing the DocumentFragment with
*   the complete `<ul>` of icon rows.
*/
const get_content_data_edit = async function(self) {

	// DocumentFragment
		const fragment = new DocumentFragment()

	// values container
		const values_container = ui.create_dom_element({
			element_type	: 'ul',
			class_name 		: 'values_container',
			parent 			: fragment
		})

	// values
		const ipo			= self.ipo
		const ipo_length	= ipo.length
		const value			= self.value
		const value_length	= value.length
		for (let i = 0; i < value_length; i++) {

			const data_item = value[i]

			for (let j = 0; j < ipo_length; j++) {

				const current_ipo = ipo[j]

				const value_element_node = get_value_element(j, data_item, self, current_ipo)
				values_container.appendChild(value_element_node)
			}
		}

	// content_data
		const content_data = ui.create_dom_element({
			element_type : 'div'
		})
		content_data.appendChild(fragment)


	return content_data
}//end get_content_data_edit



/**
* GET_VALUE_ELEMENT
* Builds one `<li class="widget_item media_icons">` row for a single linked
* A/V record and its associated IPO configuration entry.
*
* The row is composed of six child `<div>` elements, each carrying a BEM-style
* class that the LESS stylesheet maps to its flex column:
*
*   .value.id    — Numeric section_id, clickable. Opens the media record in a
*                  new browser window using `open_window` (target: 'record_viewer').
*                  The URL is built from DEDALO_CORE_URL as `tipo` (the media
*                  section_tipo) + `id` (the section_id) — the page contract; a
*                  stray `section_tipo` url var makes the page reject the target.  `session_save: false` prevents
*                  overwriting the opener tab's stored session.
*
*   .value.av    — Icon button (font-icon .file_av). Opens the media viewer in a
*                  new window (target: 'viewer', 1024×720).  The viewer URL uses
*                  the component/section info from `current_ipo.input.paths[0][0]`
*                  and `data_id.value` as the record id.
*
*   .value.tr    — "TR" transcription link. If `data.transcription.tool_context`
*                  is present, clicking calls `open_tool` passing the tool_context
*                  and the owning section (get_caller_by_model) as the caller.
*
*   .value.in    — "IN" indexation link, same pattern as TR.
*
*   .value.tl    — "TL" translation link, same pattern as TR.
*
*   .value.tc    — Read-only time-code / duration cell; displays `data_tc.value`
*                  or an empty string if absent.
*
* Tool links (TR/IN/TL) are only wired with a click listener when their
* `tool_context` is truthy.  When `tool_context` is null/undefined (tool not
* registered for the current user) the element is rendered but is inert.
*
* The owning section is resolved by MODEL via get_caller_by_model, never by
* walking a fixed number of caller links: the depth differs by surface (an
* edit-mode component reaches its section through a section_group, a list cell
* through a section_record), and the helper is cycle-safe.
*
* @param {number}  i           - IPO index (0-based), used to disambiguate rows
*   when multiple IPO entries share the same locator.
* @param {Object}  data        - One data item from `self.value`; see module
*   doc-block for the full shape.  Must have at minimum: `data.id`, `data.transcription`,
*   `data.indexation`, `data.translation`, `data.tc`.
* @param {Object}  self        - The `media_icons` widget instance.
* @param {Object}  current_ipo - The IPO config for this row's index.  The
*   `.input.paths[0][0]` sub-object must expose `section_tipo` and
*   `component_tipo` for the A/V viewer URL.
* @returns {HTMLElement} The populated `<li>` element ready to append.
*/
const get_value_element = (i, data, self, current_ipo) => {

	// data_id
		const data_id = data.id
		// {
		// 	"id": "id",
		// 	"key": 0,
		// 	"value": "13",
		// 	"widget": "media_icons",
		// 	"locator": {
		// 		"type": "dd151",
		// 		"section_id": "13",
		// 		"section_tipo": "rsc167",
		// 		"from_component_tipo": "oh25"
		// 	}
		// }
		const locator	= data_id.locator
		const value		= data_id.value

	// data
		const data_transcription	= data.transcription
		const data_indexation		= data.indexation
		const data_translation		= data.translation
		const data_tc				= data.tc

	// li
		const li = ui.create_dom_element({
			element_type	: 'li',
			class_name		: 'widget_item media_icons'
		})

	// column_id
		const column_id_value = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'value id link',
			text_content		: data_id.value,
			parent			: li
		})
		column_id_value.addEventListener('click', (e) => {
			e.stopPropagation();

			// open a new window
				const width		= window.screen.width < 1350 ? window.screen.width : 1350;
				const height	= window.screen.height < 1024 ? window.screen.height : 1024;
				const url		= DEDALO_CORE_URL + '/page/?' + object_to_url_vars({
					tipo			: locator.section_tipo,
					id				: locator.section_id,
					mode			: 'edit',
					session_save	: false, // prevent to overwrite current section session
					menu			: false
				})
				open_window({
					url		: url,
					target	: 'record_viewer',
					width	: width,
					height	: height
				})
		})

	// icon media
		const icon_media_node = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'value av link',
			parent			: li
		})
		ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'button file_av icon',
			parent			: icon_media_node
		})
		icon_media_node.addEventListener('click', (e) => {
			e.stopPropagation();

			const ipo_input_paths = current_ipo?.input?.paths?.[0]?.[0];
			if (!ipo_input_paths) {
				console.warn('media_icons: missing ipo input paths', current_ipo);
				return;
			}

			// open a new window
				const url = DEDALO_CORE_URL + '/page/?' + object_to_url_vars({
					tipo			: ipo_input_paths.component_tipo,
					section_tipo	: ipo_input_paths.section_tipo,
					id				: value,
					mode			: 'edit',
					view			: 'viewer',
					menu			: false
				})
				open_window({
					url		: url,
					target	: 'viewer',
					width	: 1024,
					height	: 720
				})
		})

	// transcription
		const transcription_value = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'value tr link',
			inner_html		: 'TR ',
			parent			: li
		})
		if(data_transcription.tool_context){
			transcription_value.addEventListener('click', (e) => {
				e.stopPropagation();

				const tool_context = data_transcription.tool_context

				// open_tool (tool_common)
				open_tool({
					tool_context	: tool_context,
					caller			: get_caller_by_model(self, 'section')
				})
			})
		}

	// indexation
		const indexation_value = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'value in link',
			inner_html		: 'IN ',
			parent			: li
		})
		if(data_indexation.tool_context){
			indexation_value.addEventListener('click', e => {
				e.stopPropagation();

				const tool_context = data_indexation.tool_context

				// open_tool (tool_common)
				open_tool({
					tool_context	: tool_context,
					caller			: get_caller_by_model(self, 'section')
				})
			})
		}

	// translation
		const translation_value = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'value tl link',
			inner_html		: 'TL ',
			parent			: li
		})
		if(data_translation.tool_context){
			translation_value.addEventListener('click', e => {
				e.stopPropagation();

				const tool_context = data_translation.tool_context

				// open_tool (tool_common)
				open_tool({
					tool_context	: tool_context,
					caller			: get_caller_by_model(self, 'section')
				})
			})
		}

	// time code
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'value tc',
			text_content		: data_tc.value || '',
			parent			: li
		})


	return li
}//end get_value_element




// @license-end
