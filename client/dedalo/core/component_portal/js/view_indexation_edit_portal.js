// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, SHOW_DEBUG, Promise, DEDALO_CORE_URL */
/*eslint no-undef: "error"*/



/**
* VIEW_INDEXATION_EDIT_PORTAL
*
* Edit-mode view for `component_portal` when its configured view is `'indexation'`.
* This view is designed for the tool_indexation workflow: it displays the set of
* portal entries that have been tagged inside a companion text-area component (typically
* `component_text_area`) and lets the cataloguer interact with those tags directly from
* the portal UI.
*
* Key differences from the default (`view_default_edit_portal`) table view:
* - Autocomplete is intentionally disabled (`self.autocomplete = false`), because new
*   entries are created by tagging text in the editor, not by searching and adding.
* - The 'delete link and record' button is hidden (`show_interface.button_delete_link_and_record
*   = false`) — indexation entries are managed through the tagging workflow.
* - Entries are de-duplicated by `section_tipo`+`section_id` before fetching section
*   records, because the same target record may be tagged multiple times (once per tag
*   anchor). The tag column renders all individual tag instances.
* - When `self.active_tag` is set the list is filtered to the matching tag; a
*   "Remove filter" button in the footer calls `self.reset_filter_data()`.
* - Each row carries a clickable tag chip (rendered by `render_tag_column`) that fires
*   the `click_tag_index_<id_base>` or `click_tag_reference_<id_base>` event on the
*   matching `component_text_area` instance, scrolling and selecting the tag in the editor.
*
* Exports:
* - `view_indexation_edit_portal`   — constructor stub (never instantiated directly).
* - `view_indexation_edit_portal.render(self, options)` — async entry point called by
*   `render_edit_component_portal.prototype.edit` for the `'indexation'` case.
*
* Data shapes consumed from `self` (the `component_portal` instance):
* - `self.data.entries`            — `Array<Locator>` where each Locator is
*                                    `{ id, type, section_tipo, section_id,
*                                       from_component_tipo, tag_id?, tag_type?,
*                                       tag_component_tipo? }`.
* - `self.data.references`         — optional `Array<Reference>` for relation-related items.
* - `self.active_tag`              — `{ caller, text_editor, tag: { tag_id, … } }` set by
*                                    `filter_data_by_tag_id`; null when no filter is active.
* - `self.columns_map`             — base column definitions (extended by rebuild_columns_map).
* - `self.fixed_columns_map`       — boolean guard: true once columns have been augmented.
* - `self.add_component_info`      — boolean: add a ddinfo column when true.
* - `self.target_section`          — `Array<DDO>` descriptors for the target section(s).
* - `self.permissions`             — `1` = read-only, `2` = full edit.
* - `self.ar_instances`            — child instance registry (section_record instances are
*                                    pushed here so they are destroyed on component refresh).
*
* @module view_indexation_edit_portal
* @see render_edit_component_portal.js  for the view-dispatch switch.
* @see component_portal.js              for the full constructor and prototype.
* @see view_default_edit_portal.js      for the canonical default table view.
* @see docs/core/components/component_portal.md for the full specification.
*/



// imports
	import {window_section_rows} from '../../section/js/section.js'
	import {place_list_after} from '../../common/js/common.js'
	import {row_of} from '../../section_record/js/record_window.js'
	import {ui} from '../../common/js/ui.js'
	import {render_value} from '../../common/js/utils/render_escape.js'
	import {event_manager} from '../../common/js/event_manager.js'
	import {get_all_instances} from '../../common/js/instances.js'
	import {when_in_dom, dd_request_idle_callback} from '../../common/js/events.js'
	import {object_to_url_vars, open_window, same_section_id} from '../../common/js/utils/index.js'
	import {render_relation_list} from '../../section/js/render_common_section.js'
	import {
		render_column_component_info,
		render_list_after,
		get_buttons
	} from './render_edit_component_portal.js'



/**
* VIEW_INDEXATION_EDIT_PORTAL
* Constructor stub for the indexation edit view.
*
* Never instantiated directly. Its role is purely as a namespace for the static
* `render` method assigned below. `render_edit_component_portal.prototype.edit`
* calls `view_indexation_edit_portal.render(self, options)` directly when the
* configured portal view is `'indexation'`.
*/
export const view_indexation_edit_portal = function() {

	return true
}//end view_indexation_edit_portal



/**
* RENDER
* Main entry point for the indexation edit view of `component_portal`.
*
* Builds the complete wrapper DOM node (or just the inner content_data when
* `render_level === 'content'`). The function:
* 1. Disables autocomplete — indexation portals are populated by the tagging workflow,
*    not by the standard autocomplete search box.
* 2. De-duplicates `self.data.entries` by `section_tipo`+`section_id` to obtain a
*    unique list of target records (`entries_combined`). The same record may be tagged
*    multiple times (e.g. two index tags pointing at the same authority record), but
*    the row window needs one row per unique record.
* 3. Builds a stable `id_variant` for the section-record cache key: when a tag filter
*    is active (`self.active_tag`) it appends the tag_id so filtered and unfiltered
*    render passes do not collide in the instance cache.
* 4. Sorts the unique entries alphabetically by their DATA text (`entry_sort_key`,
*    from the shared datum) and hands them to a row window that builds and renders
*    a `section_record` only for the rows the viewport reaches.
* 5. Wraps everything in the standard `ui.component.build_wrapper_edit` shell and
*    appends the `'portal'` and `'view_indexation'` CSS classes.
*
* @param {Object} self    - The `component_portal` instance (the component being rendered).
* @param {Object} options - Render options forwarded from the view dispatcher.
* @param {string} [options.render_level='full'] - `'full'` renders the entire wrapper
*   including toolbar buttons; `'content'` returns only the inner content_data node
*   (used by `self.refresh()` to update the record list without rebuilding the shell).
* @returns {Promise<HTMLElement>} The rendered wrapper node (full render) or the
*   `content_data` node (content-level render).
*/
view_indexation_edit_portal.render = async function(self, options) {

	// prevents to load autocomplete service
		self.autocomplete = false

	// options
		const render_level = options.render_level || 'full'

	// columns_map
		self.columns_map = await rebuild_columns_map(self)

	// entries_combined (grouped by tag id)
	// De-duplicate entries so that each unique target record (section_tipo + section_id)
	// appears only once as a row, even if it is tagged multiple times.
		const data				= self.data || {}
		const entries			= data.entries || []
		const entries_combined	= []
		const entries_length	= entries.length
		for (let i = 0; i < entries_length; i++) {
			const item = entries[i]
			const found = entries_combined.find(el => el.section_tipo===item.section_tipo && same_section_id(el.section_id, item.section_id))
			if (!found) {
				entries_combined.push(item)
			}
		}

	// id_variant
	// Build a tag-aware cache key: if a tag filter is active, include its tag_id in
	// the id_variant so filtered renders are cached independently of the full list.
		const id_variant = self.active_tag && self.active_tag.tag
			? self.id_variant + '_' + self.active_tag.tag.tag_id
			: self.id_variant + '_' + (new Date()).getTime()

	// sort. Alphabetical by the record's text, read from the shared datum (the
	// rows are windowed, so the rendered text of every row is not available)
		const keyed = entries_combined.map(entry => ({ entry, key: entry_sort_key(self, entry) }))
		keyed.sort((a, b) => a.key > b.key ? 1 : -1)
		const rows = keyed.map(el => el.entry)

	// content_data
	// (!) The de-duplicated list is what the window rows are: handing it the raw
	// entries would render one row PER TAG (each showing every chip of the record)
	// instead of one row per record.
		self.ar_instances = self.ar_instances || []
		const content_data = await get_content_data(self, rows, id_variant)
		if (render_level==='content') {
			return content_data
		}

	// buttons
		// ! configure interface to avoid display modal button_delete_link_and_record
		// Indexation entries are managed via the tag workflow; the "delete link and record"
		// action would bypass that workflow and is therefore suppressed.
		self.show_interface.button_delete_link_and_record = false
		const buttons = get_buttons(self)

	// wrapper. ui build_edit returns component wrapper
		const wrapper = ui.component.build_wrapper_edit(self, {
			content_data	: content_data,
			buttons			: buttons
		})
		wrapper.classList.add(
			'portal',
			'view_indexation'
		)
		// set pointers
		wrapper.content_data = content_data

	// list_after. The non-row sibling, right after content_data
		place_list_after(wrapper, content_data)


	return wrapper
}//end render



/**
* GET_CONTENT_DATA
* Build the (empty) `content_data` container and hand the (sorted, de-duplicated)
* rows to the ROW DOOR (section.js window_section_rows →
* section_record/js/record_window.js) on EVERY content render, N=0 included — a
* tag filter that matches nothing retires the previous window like any other
* transition. The window keeps the row invariant and builds at most
* ROW_WINDOW_MAX_ROWS rows at once (audit P2-31 / CLI-29). The fill is done before
* this resolves. The indexation view has no drag source.
*
* Non-row content goes to the `.list_after` slot (expando `content_data.list_after`,
* never inside content_data, WC-2026-10-30-section-record-row-box):
* 1. `self.data.references` back-references (relation-related indexation portals);
* 2. when a tag filter is active (`self.active_tag`), the footer bar with the
*    "Remove filter" button that calls `self.reset_filter_data()`;
* 3. the print notice.
*
* @param {Object} self       - The `component_portal` instance.
* @param {Array}  rows       - The unique, sorted locator entries. May be empty when
*                              there are no matching indexed entries.
* @param {string} id_variant - Instance id variant for the rows of this render.
* @returns {Promise<HTMLElement>} The assembled `content_data` DOM node, ready to be
*   inserted into the wrapper.
*/
const get_content_data = async function(self, rows, id_variant) {

	// content_data
		const content_data = ui.component.build_content_data(self)

	// rows. The door, always (N=0 included)
		const record_window = await window_section_rows({
			caller			: self,
			container		: content_data,
			rows			: rows,
			records_options	: {
				mode		: 'list',
				columns_map	: self.columns_map,
				id_variant	: id_variant,
				view		: 'text'
			},
			layout			: 'list'
		})

	// active_tag
	// When a tag filter is active, add a footer button that lets the cataloguer
	// clear the filter and return to the full unfiltered entry list.
		const list_footer = self.active_tag
			? ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'list_footer'
			  })
			: null
		if (list_footer) {
			const button_remove_filter = ui.create_dom_element({
				element_type	: 'button',
				class_name		: 'primary button_remove_filter icon eye',
				inner_html		: get_label.remove_filter || 'Remove filter',
				parent			: list_footer
			})
			const fn_click = function(e) {
				e.stopPropagation()
				// reset filter
				self.reset_filter_data()
			}
			button_remove_filter.addEventListener('click', fn_click)
		}

	// list_after. References, list footer, print notice
		content_data.list_after = render_list_after(self, {
			content_data	: content_data,
			record_window	: record_window,
			list_footer		: list_footer
		})


	return content_data
}//end get_content_data



/**
* ENTRY_SORT_KEY
* The text a row sorts by, read from the shared datum instead of the rendered
* row: the rows are windowed, so only the reachable ones are ever rendered.
* Walks the portal's data columns (the ontology-defined ones in `self.columns_map`)
* in order and concatenates the list-mode values stored for the entry's record;
* a locator value contributes the first text value stored for its own record
* (one hop — the same datum carries the related records' data).
*
* @param {Object} self  - The `component_portal` instance.
* @param {Object} entry - A locator `{section_tipo, section_id}`.
* @returns {string} The sort key ('' when the datum holds nothing for the record).
*/
const entry_sort_key = function(self, entry) {

	const datum_data = self.datum?.data || []
	const columns	 = (self.columns_map || []).map(el => el.id)

	const text_of = function(value, depth) {
		if (value===null || value===undefined) {
			return ''
		}
		if (typeof value==='string' || typeof value==='number') {
			return String(value)
		}
		if (Array.isArray(value)) {
			return value.map(el => text_of(el, depth)).filter(Boolean).join(' ')
		}
		if (typeof value==='object') {
			if (value.section_tipo && value.section_id!==undefined && depth < 1) {
				const related = datum_data.find(el =>
					el.section_tipo===value.section_tipo
					&& same_section_id(el.section_id, value.section_id)
					&& el.value!==null && el.value!==undefined
				)
				return related ? text_of(related.value, depth + 1) : ''
			}
			// lang-keyed or other object: its string leaves in order
			return Object.values(value).map(el => text_of(el, depth)).filter(Boolean).join(' ')
		}
		return ''
	}

	const parts = []
	for (const tipo of columns) {
		const row = datum_data.find(el =>
			el.tipo===tipo
			&& el.section_tipo===entry.section_tipo
			&& same_section_id(el.section_id, entry.section_id)
		)
		if (row) {
			const text = text_of(row.value, 0)
			if (text) {
				parts.push(text)
			}
		}
	}

	return parts.join(' ')
}//end entry_sort_key



/**
* REBUILD_COLUMNS_MAP
* Extends the base `self.columns_map` (set from the ontology / request config) with
* control columns specific to the indexation view.
*
* Column order after rebuild:
* 1. `section_id`  — "open record in new window" button (`render_column_id`).
* 2. *base columns* — ontology-defined content columns (labels, dates, etc.).
* 3. `tag`         — tag chips for each locator pointing at this record (`render_tag_column`).
* 4. `ddinfo`      — optional debug/admin info overlay, added only when
*                    `self.add_component_info === true`.
* 5. `info`        — section label + (when permissions ≥ 2) the unlink/delete button,
*                    rendered by `render_info_column`.
*
* The flag `self.fixed_columns_map` is set to `true` after the first run so that
* repeated calls (e.g. on content-level refreshes) return the already-extended map
* without duplicating columns.
*
* @param {Object} self - The `component_portal` instance.
* @returns {Promise<Array>} The augmented columns_map array. Each entry is an object:
*   `{ id: string, label: string, width?: string, callback: Function }`.
*/
const rebuild_columns_map = async function(self) {

	// columns_map already rebuilt case
	// Guard against calling rebuild more than once per component lifecycle.
		if (self.fixed_columns_map===true) {
			return self.columns_map
		}

	const columns_map = []

	// section_id column add
	// Provides the "open record" navigation button at the start of each row.
		columns_map.push({
			id			: 'section_id',
			label		: 'Id',
			width		: 'auto',
			callback	: render_column_id
		})

	// regular columns add
	// Splice in the base columns from the ontology/request config (e.g. title, date).
		const base_columns_map = self.columns_map || []
		columns_map.push(...base_columns_map)

	// tag column add
	// Shows the tag chips for each index anchor that points at the current row's record.
		columns_map.push({
			id			: 'tag',
			label		: 'Tag',
			width		: 'auto',
			callback	: render_tag_column
		})

	// ddinfo. column_component_info column add
	// Only included when value_with_parents is configured on the ddo_map (self.add_component_info).
		if (self.add_component_info===true) {
			columns_map.push({
				id			: 'ddinfo',
				label		: 'Info',
				callback	: render_column_component_info
			})
		}

	// info. render_info_column column add
	// Appended last: shows the section type label and the unlink/delete control.
		columns_map.push({
			id			: 'info',
			label		: 'Info',
			callback	: render_info_column
		})

	// button_remove column (Moved to inside render_info_column for readability)

	// fixed as calculated
	// Mark columns as already built so subsequent refreshes skip this augmentation.
		self.fixed_columns_map = true


	return columns_map
}//end rebuild_columns_map



/**
* RENDER_COLUMN_ID
* Renders the first cell of each portal row: a button that opens the target record in
* a new window (reusing a stable window name `'edit_window'`).
*
* The button fires on `mousedown` (not `click`) to avoid focus-loss side effects in
* the main editing context. It uses `open_window` from utils, which manages window
* reuse and optional tab opening.
*
* Note: this is a simplified version of the `render_column_id` exported by
* `render_edit_component_portal.js`. It omits the drag handle and drop zone because
* reordering is not meaningful in the indexation view (order is determined by the text
* editor's tag sequence, not a manual sort).
*
* @param {Object} options              - Options object supplied by `section_record` per row.
* @param {Object} options.caller       - The `component_portal` instance.
* @param {string} options.section_id   - The section_id of the target record for this row.
* @param {string} options.section_tipo - The section_tipo of the target record for this row.
* @returns {DocumentFragment} Fragment containing the open-record button and its icon.
*/
const render_column_id = function(options) {

	// options
		const self 			= options.caller
		const section_id	= options.section_id
		const section_tipo	= options.section_tipo

	const fragment = new DocumentFragment()

	// button_edit
		const button_edit = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'button_edit',
			title_label		: get_label.open || 'Open',
			parent			: fragment
		})
		// event click
		const click_handler = (e) => {
			e.stopPropagation()

			const url = DEDALO_CORE_URL + '/page/?' + object_to_url_vars({
				tipo			: section_tipo,
				id				: section_id,
				mode			: 'edit',
				menu			: false,
				session_save	: false
			})

			open_window({
				url			: url,
				target		: 'edit_window'
			})
		}
		button_edit.addEventListener('mousedown', click_handler)

	// edit icon
		ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'button edit icon',
			parent			: button_edit
		})


	return fragment
}//end render_column_id



/**
* GET_ROW_LOCATORS
* Every entry of `self.data.entries` that the given row is displaying: the locators
* that share the row's `section_tipo` + `section_id`.
*
* This is THE definition of what a row *is* in this view. A row is one target record
* (one thesaurus term), and the same record is tagged once per anchor in the companion
* text editor, so a row stands for N locators — the N chips `render_tag_column` paints.
*
* (!) `render_tag_column` (what the user sees) and `render_column_remove_indexation`
* (what a delete removes) MUST resolve the same set, or the delete silently acts on
* something other than what the row shows. That is why both go through this helper.
*
* When a tag filter is active, `self.data.entries` has already been narrowed to the
* selected tag by `component_portal.filter_data_by_tag_id`, so this returns exactly
* that one locator — no special case needed here or in either caller.
*
* @param {Object} self    - The `component_portal` instance.
* @param {Object} locator - The row's canonical locator (section_tipo + section_id).
* @returns {Array<Object>} The locators this row represents; possibly empty.
*/
const get_row_locators = function(self, locator) {

	const data		= self.data || {}
	const entries	= data.entries || []

	return entries.filter(el =>
		el.section_tipo===locator.section_tipo &&
		String(el.section_id)===String(locator.section_id)
	)
}//end get_row_locators



/**
* RENDER_TAG_COLUMN
* Renders the tag-chip column for a single portal row.
*
* Each entry in `self.data.entries` that matches the current row's `section_tipo` and
* `section_id` produces one chip. A single target record can have multiple chips when
* it is tagged more than once in the companion text editor.
*
* Chip appearance:
* - `class_name` is `'no_tag'` when `tag_id` is absent (provisional/unsaved tag),
*   or `'tags'` when a stable tag_id is assigned.
* - `tag_type` defaults to `'index'` when absent. It is also used as an additional
*   CSS class and to choose the `event_manager` channel (`'indexIn'` or the raw type).
* - The chip's text content is the `tag_id` string (e.g. `"4"`) for a confirmed tag,
*   or the localised string `'Provisional'` for an unsaved anchor.
*
* On click, the chip:
* 1. Resolves `tag_component_tipo` from the locator (preferred) or falls back to
*    `self.context.properties.config_relation.tag_component_tipo`. If neither is
*    available the click is silently aborted and a warning is logged.
* 2. Builds the `id_base` of the companion `component_text_area` as:
*    `<caller.section_tipo>_<caller.section_id>_<tag_component_tipo>`.
* 3. Looks up that component in the global instance registry via `get_all_instances`.
* 4. Calls `text_editor.get_view_tag_attributes` to obtain the live tag object from
*    the editor's current DOM/model state.
* 5. Publishes the appropriate `click_tag_index_*` or `click_tag_reference_*` event
*    on `event_manager`, which the text editor subscribes to in order to scroll to and
*    highlight the tag.
*
* @param {Object} options              - Options object supplied by `section_record` per row.
* @param {Object} options.locator      - The canonical locator for this row (section_tipo + section_id).
* @param {Object} options.caller       - The `component_portal` instance.
* @returns {DocumentFragment} Fragment containing one chip `<div>` per matching entry.
*/
const render_tag_column = function(options) {

	// options
		const locator		= options.locator
		const caller		= options.caller
		// Filter all locators that belong to this row's record (there may be several tags).
		const entries_tags	= get_row_locators(caller, locator)

	const self = caller

	const fragment = new DocumentFragment()

	// add a tag for each value
		const entries_tags_length = entries_tags.length
		for (let i = 0; i < entries_tags_length; i++) {

			const current_locator = entries_tags[i]

			// Determine chip CSS class: unconfirmed tags (no tag_id) get 'no_tag'.
			const class_name = !current_locator.tag_id
				? 'no_tag'
				: 'tags'

			// Normalise tag_type: the server may omit it for legacy index annotations.
			const tag_type = !current_locator.tag_type
				? 'index'
				: current_locator.tag_type

			// Display the tag_id for confirmed tags, or the 'Provisional' label for new ones.
			const text_value = !current_locator.tag_id
				? (get_label.provisional || 'Provisional')
				: (current_locator.tag_id || null)

			const tag_node = ui.create_dom_element({
				element_type	: 'div',
				class_name		: class_name+' '+tag_type,
				inner_html		: render_value(text_value, 'text'),
				parent			: fragment
			})
			tag_node.addEventListener('click', function(e) {
				e.stopPropagation()
				e.preventDefault()

				if(SHOW_DEBUG===true) {
					console.log('Clicked tag_id from column:', current_locator.tag_id);
				}

				// tag_component_tipo
				// The locator must carry tag_component_tipo to locate the companion text editor.
				// If it is absent (older data or a bug in the add-link flow), fall back to the
				// portal's own properties before giving up.
					if (!current_locator.tag_component_tipo) {
						// get from properties
						const tag_component_tipo = self.context.properties?.config_relation?.tag_component_tipo
						if (tag_component_tipo) {
							current_locator.tag_component_tipo = tag_component_tipo
							console.warn('WARNING: locator tag_component_tipo is mandatory! Adding auto tag_component_tipo from properties', current_locator);
						}else{
							console.warn('ERROR: locator tag_component_tipo is mandatory! Not received into current locator and unable to get it from properties fallback', self.context.properties);
							return
						}
					}

				// id_base build like rsc167_5_rsc36
				// Construct the id_base used by the companion component_text_area instance.
				// Pattern: <host section_tipo>_<host section_id>_<tag_component_tipo>
					const id_base = [
						caller.section_tipo,
						caller.section_id,
						current_locator.tag_component_tipo
					].join('_')

				// locate component into the global array of instances
				// Search the live instance registry for the matching text-area component.
					const all_instances	= get_all_instances()
					const component		= all_instances.find(el => el.id_base===id_base)
					if (component) {

						// text_area_instance
						const text_area_instance = component

						// get the text_editor (service)
						// (!) text_editor is an array; take the first (and normally only) entry.
						const text_editor = text_area_instance.text_editor[0]

						// id_base of component_text_area
						// (!) This shadows the outer `id_base` variable — both refer to the same value.
						const id_base = text_area_instance.id_base

						// tag. Get the tag object selecting the tag into the text_area editor (get the tag attributes)
						// needed to get the tag state, to show the tag info inside the tool_indexation
						// 'indexIn' is the ProseMirror mark name for standard index tags.
						const tag = text_editor.get_view_tag_attributes({
							type	: tag_type==='index' ? 'indexIn' : tag_type,
							tag_id	: current_locator.tag_id
						})
						switch (tag_type) {
							case 'reference':
								event_manager.publish('click_tag_reference_'+ id_base, {tag: tag})
								break;

							default:
								// fire the event to select tag
								event_manager.publish('click_tag_index_'+ id_base, {tag: tag})
								break;
						}

					}else{
						console.error('Unable to locate component into instances. id_base:', id_base);
					}
			})//end event click
		}


	return fragment
}//end render_tag_column



/**
* RENDER_INFO_COLUMN
* Renders the final cell of each portal row: the target section's display label and,
* when the user has edit permissions, the unlink/delete button.
*
* The section label is read from `self.target_section` — the DDO array that was built
* from the request config during `component_portal.build()`. Each entry has a `tipo`
* and a `label` property. When the `section_tipo` for the current row cannot be matched
* (e.g. the target section was removed from the ontology), the label falls back to an
* empty string and an empty fragment is returned early.
*
* The remove control is appended directly inside `info_node` rather than as a sibling
* column — this is a deliberate layout choice (see inline comment in
* `rebuild_columns_map`) for readability. It is the indexation-specific
* `render_column_remove_indexation`, NOT the shared `render_column_remove`: see that
* function's header for why the two cannot be the same here.
*
* @param {Object} options              - Options object supplied by `section_record` per row.
* @param {Object} options.locator      - Locator for this row; used by the remove control.
* @param {Object} options.caller       - The `component_portal` instance.
* @returns {DocumentFragment} Fragment containing the label div (and optionally the remove button).
*/
const render_info_column = function(options) {

	// options
		const locator	= options.locator
		const self		= options.caller

	// short vars
		const section_tipo		= locator.section_tipo
		const target_section	= self.target_section

	const fragment = new DocumentFragment()

	// check vars
	// Guard: both section_tipo and target_section are required to resolve the label.
		if (!section_tipo || !target_section) {
			return fragment // null
		}

		const found			= target_section.find(el => el.tipo===section_tipo)
		const section_label	= found
			? found.label
			: ''

	// info_node
	// The section label is displayed as a bracketed italicised note, e.g. "[Objects]".
		const info_node = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'note italic',
			inner_html		: '[' + render_value(section_label, 'text') + ']',
			parent			: fragment
		})

	// remove node (former column_remove)
	// The remove button is nested inside info_node (not a separate column) for layout compactness.
		if (self.permissions>1) {
			info_node.appendChild(
				render_column_remove_indexation(options, section_label)
			)
		}


	return fragment
}//end render_info_column



/**
* RENDER_COLUMN_REMOVE_INDEXATION
* The row's unlink control — the indexation view's own, deliberately NOT the shared
* `render_column_remove` from `render_edit_component_portal.js`.
*
* WHY IT CANNOT BE THE SHARED ONE. Everywhere else a portal row is one locator, so the
* shared control's `unlink_record(options.locator)` removes exactly what the row shows.
* Here a row is one TERM and stands for every tag anchor pointing at it, so the shared
* control would delete the row's FIRST locator and leave the term on screen with N-1
* chips — the record half-unlinked, and which link died decided by array order. (This
* was invisible while the view rendered one row per tag; it is the v6 behaviour the
* de-duplication fix exposed.) So the rule here is: **delete exactly the locators the
* row is displaying** — `get_row_locators`, the same set `render_tag_column` paints:
*
*   - no tag selected  → the row shows all N chips  → all N locators go, in ONE save.
*   - a tag selected   → `filter_data_by_tag_id` has already narrowed `data.entries`,
*                        the row shows that one chip → only that locator goes.
*
* Both cases fall out of the same expression; there is no branch on `active_tag`.
*
* MARKS ARE NOT TOUCHED. This removes links only; the `[index-n-…]` marks stay in the
* transcription exactly as they are, orphaned or not. Deleting a tag for real (marks in
* every lang + its locator) is the text editor's job — `tag_delete` server-side, driven
* from the editor, not from this list. The modal says so, because a user who removes
* five links from a term needs to know the highlighted text will still be highlighted.
*
* The button is gated exactly like the shared control: it renders only when the target
* section's ontology-declared `button_delete` descriptor is present, so visibility stays
* server-authoritative. `show_interface.button_delete_link_and_record` is forced false by
* this view (indexation entries are managed through the tagging workflow), so the
* "delete resource and all links" branch of the shared control has no counterpart here.
*
* @param {Object} options              - Options object supplied by `section_record` per row.
* @param {Object} options.caller       - The `component_portal` instance.
* @param {Object} options.locator      - The row's canonical locator.
* @param {string} options.section_id   - Target record's section_id.
* @param {string} options.section_tipo - Target record's section_tipo.
* @param {number|string} options.row_key - Zero-based position in the full data array.
* @param {string} section_label        - Resolved target-section label, for the dialog.
* @returns {DocumentFragment} Fragment containing an optional `.button_remove` button.
*/
const render_column_remove_indexation = function(options, section_label) {

	// options
		const self			= options.caller
		const locator		= options.locator
		const row_key		= options.row_key
		const section_id	= options.section_id
		const section_tipo	= options.section_tipo

	const fragment = new DocumentFragment()

	// button_delete. Server-authoritative gate (ontology-declared), as in the shared control
		const target_section_ddo	= (self.target_section || []).find(el => el.tipo===section_tipo) || {}
		const section_buttons		= target_section_ddo.buttons || []
		const button_delete			= section_buttons.find(el => el.model==='button_delete')
		if (!button_delete) {
			return fragment
		}

	// button_remove
		const button_remove = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'button_remove',
			title			: (get_label.delete || 'Delete'),
			parent			: fragment
		})
		button_remove.tabIndex = -1

		// event click
		button_remove.addEventListener('click', function(e){
			e.stopPropagation()

			// invalid permissions
				if (self.permissions<2) {
					return
				}

			// row_locators. Resolved at CLICK time, not at render time: the user may have
			// selected or cleared a tag since the row was painted, and the set to delete
			// must match what is on screen right now.
				const row_locators = get_row_locators(self, locator)
				if (row_locators.length===0) {
					console.warn('// remove ignored: the row resolves no locator', locator);
					return
				}

			// term_label. What the user reads in this very row, so the dialog names the
			// term the way the list does. Falls back to the raw locator when the row node
			// cannot be resolved (defensive: the button always lives inside its row).
			// row_of, never closest(): a nested record would stop the walk too early.
				const row_hit		= row_of(self.node?.content_data, button_remove)
				const row_node		= row_hit ? row_hit.node : null
				const label_node	= row_node
					? row_node.querySelector(':scope >.wrapper_component')
					: null
				const term_label	= (label_node && label_node.innerText.trim())
					? label_node.innerText.trim()
					: (section_tipo + '_' + section_id)

			// header
				const header = ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'header'
				})
				const header_label = ui.create_dom_element({
					element_type	: 'span',
					class_name		: 'label',
					text_content	: (get_label.delete || 'Delete') + ' ' + term_label,
					parent			: header
				})
				ui.create_dom_element({
					element_type	: 'span',
					class_name		: 'note',
					text_content	: ' [' + section_label + ']',
					parent			: header_label
				})

			// body
				const body = ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'body content'
				})

			// indexation_delete_info. WHAT this deletion does, stated before it happens:
			// the affected tags, one chip per link, then the two consequences.
				const delete_info = ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'indexation_delete_info block',
					parent			: body
				})
				const tags_line = ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'indexation_delete_tags',
					text_content	: (get_label.indexations || 'Indexations') + ': ' + row_locators.length,
					parent			: delete_info
				})
				// the same chips the row paints, so the dialog is visually the row's own set
				for (let i = 0; i < row_locators.length; i++) {
					const current_locator	= row_locators[i]
					const tag_type			= current_locator.tag_type || 'index'
					ui.create_dom_element({
						element_type	: 'div',
						class_name		: (!current_locator.tag_id ? 'no_tag ' : 'tags ') + tag_type,
						text_content	: !current_locator.tag_id
							? (get_label.provisional || 'Provisional')
							: String(current_locator.tag_id),
						parent			: tags_line
					})
				}
				// scope of the deletion: every link of the term, or only the selected one
				ui.create_dom_element({
					element_type	: 'p',
					class_name		: 'indexation_delete_scope',
					text_content	: self.active_tag
						? (get_label.delete_selected_indexation_link || 'Only the selected link will be deleted.')
						: (get_label.delete_all_indexation_links || 'All the links of this term will be deleted.'),
					parent			: delete_info
				})
				// what survives: the marks in the transcription
				ui.create_dom_element({
					element_type	: 'p',
					class_name		: 'indexation_delete_note note',
					text_content	: get_label.text_tags_preserved || 'The tags in the text will be preserved.',
					parent			: delete_info
				})

			// relation_list. Where else this record is used (lazy: loads on expand)
				const relation_list_placeholder = ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'relation_list_placeholder',
					parent			: body
				})
				const relation_list = render_relation_list({
					self			: self,
					section_id		: section_id,
					section_tipo	: section_tipo
				})
				relation_list_placeholder.replaceWith(relation_list)

			// footer
				const footer = ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'footer content'
				})

			// button_unlink_record (Only deletes the locators, never the target record)
				const button_unlink_record = ui.create_dom_element({
					element_type	: 'button',
					class_name		: 'warning remove',
					text_content	: (get_label.delete_only_the_link || 'Delete only link')
						+ (row_locators.length>1 ? ' (' + row_locators.length + ')' : ''),
					parent			: footer
				})
				const fn_click_unlink_record = async function(e){
					e.stopPropagation()

					// stop if the user don't confirm
					if (!confirm(get_label.sure)) {
						return
					}

					footer.classList.add('loading')

					// deletes every locator of the row in ONE save and refreshes the component
					// (!) unlink_record re-applies the active tag filter after the refresh.
					// dataframe cleanup is server-authoritative (single-writer rule).
					const removed = await self.unlink_record(row_locators)

					footer.classList.remove('loading')

					// close modal only after the unlink landed: a closing modal is the
					// grammar of "removed" (a false answer is already surfaced by the
					// save path's handle_api_error, or was the user's own cancel)
					if (removed===true) {
						modal.close()
					}
				}
				button_unlink_record.addEventListener('click', fn_click_unlink_record)

			// modal
				const modal = ui.attach_to_modal({
					header		: header,
					body		: body,
					footer		: footer,
					size		: 'normal', // string size small|big|normal
					callback	: (dd_modal) => {
						dd_modal.modal_content.style.width = '54rem'
						dd_modal.modal_content.style.maxWidth = '100%'
					}
				})
				// set the default button to be fired when the modal is active
				// when the user press the Enter key in the keyboard
				const focus_the_button = function() {
					dd_request_idle_callback(
						() => {
							button_unlink_record.focus()
							button_unlink_record.classList.add('focus')
						}
					)
					button_unlink_record.addEventListener('keyup', (e)=>{
						e.preventDefault()
						if(e.key==='Enter'){
							button_unlink_record.click()
						}
					})
				}
				when_in_dom(button_unlink_record, focus_the_button)

			// data pagination offset. Check and update self data to allow save API request
			// return the proper paginated data (same guard as the shared control)
				const key = parseInt(row_key)
				if (key===0 && self.data.pagination?.offset>0) {
					const next_offset = (self.data.pagination.offset - self.data.pagination.limit)
					self.data.pagination.offset = next_offset>0
						? next_offset
						: 0
				}
		})//end event click

		// icon delete
		ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'button delete_light icon',
			parent			: button_remove
		})

		// activate_tooltips
		ui.activate_tooltips(button_remove.parentNode, '.button_remove')


	return fragment
}//end render_column_remove_indexation



// @license-end
