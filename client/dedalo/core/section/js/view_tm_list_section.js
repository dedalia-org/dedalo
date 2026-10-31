// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global page_globals */
/*eslint no-undef: "error"*/



// imports
	import {ui} from '../../common/js/ui.js'
	import {event_manager} from '../../common/js/event_manager.js'
	import {place_list_after} from '../../common/js/common.js'
	import {row_of, apply_table_semantics} from '../../section_record/js/record_window.js'
	import {set_element_css} from '../../page/js/css.js'
	import {view_default_list_section} from './view_default_list_section.js'
	import {render_column_id as default_render_column_id} from './render_list_section.js'
	import {response_data, request_failed} from '../../common/js/api_error.js'
	import {error_text} from '../../common/js/render_api_error.js'



/**
* VIEW_TM_LIST_SECTION
* The Time Machine list view — a THIN variant of the ordinary section list.
*
* WHY IT LIVES HERE, IN section/js/
* ---------------------------------
* A Time Machine surface IS an ordinary read-only section list whose rows come
* from a different table (WC-2026-08-14-tm-ddo-mode-retired: `sqo.mode:'tm'` is a
* ROW SOURCE, not a render mode). Everything about it — the grid, the paginator,
* the header, the columns_map, the per-row section_record render — is the section
* family's own machinery, and the ONE thing that differs is what the leading Id
* cell does when you click it.
*
* So this file overrides exactly that: `render_column_id`, the per-caller hook the
* section family already publishes (`view_default_list_section.rebuild_columns_map`
* reads `this.render_column_id || render_column_id`). Render, content and column
* assembly are delegated verbatim. There is no second list implementation here.
*
* It supersedes the deleted `services/service_time_machine/` list fork,
* which did the same delegation from inside a private list service. Three defects
* of that version are fixed rather than ported:
*
*   1. SCOPED HANDLERS. The old row-click reset scanned the WHOLE document for
*      '.button_view' and cleared them all, so opening two Time Machine panels let
*      one clear the other's active marker. The reset is scoped to this list's own
*      container now.
*   2. NO NATIVE DIALOGS. `confirm()`/`alert()` are replaced by `ui.confirm` and
*      the standard error modal. A native dialog also FREEZES the CDP/devtools
*      connection, which is why the restore path could never be exercised by an
*      automated browser check.
*   3. NO IDLE-CALLBACK DOM WALK. Sibling cells were made clickable by a deferred
*      `dd_request_idle_callback` walk of `parentNode.parentNode.children`. The
*      whole-row action is now ONE delegated listener on the list's content_data
*      (bind_row_action), riding the row window's signal; the cursor affordance
*      is CSS (`.link`, stamped by decorate_row).
*
* ROWS (WC-2026-10-30-section-record-row-box). Every shape hands the page's
* locator entries to the row window door through
* view_default_list_section.get_content_data — the tool list and the compact
* panels alike; nothing is pre-built. Per-row state that must survive a late
* build (a placeholder swap) lives in the window's `decorate` / the row render
* options (`mark_empty_columns`), never in a pass over the list.
*
* Exports: view_tm_list_section
*/
export const view_tm_list_section = function() {

	return true
}//end view_tm_list_section



/**
* GET_CONTENT_DATA
* The section list content (view_default_list_section.get_content_data: the row
* window door, list_after) plus the Time Machine row action.
*
* A new content_data is a new window over new entries, so the active-row marker
* (`self.tm_active_index`, a row index of ONE window) is dropped first: decorate
* runs during the fill, and a stale index must not mark a row of the new page.
* @param {Object} self - The dd15 section instance
* @param {Array} rows - The page's locator entries (`self.data.entries`)
* @param {Object} [options] - Row shaping (records_options, render_options,
*   layout, decorate), forwarded
* @returns {Promise<HTMLElement>} content_data
*/
view_tm_list_section.get_content_data = async function(self, rows, options={}) {

	// active marker belongs to the previous window
		self.tm_active_index = null

	const content_data = await view_default_list_section.get_content_data(self, rows, options)

	// whole-row action (tool shape: the Id column is the restore/preview button)
		if (self.tm_no_id_column!==true) {
			bind_row_action(self, content_data)
		}


	return content_data
}//end get_content_data



/**
* RENDER
* Two shapes, chosen by `self.tm_view`:
*
*   'tool' (default) — the full-width list: the ordinary section render,
*                      delegated verbatim.
*   'mini' / 'history' — the INSPECTOR's two side panels. These are NOT the
*                      section grid: they are compact, two-line blocks (an orange
*                      date line over the value, a note icon at the right) driven
*                      by CSS in section/css/view_tm_list_section.less. That look
*                      predates the unification and is preserved verbatim — it is
*                      what fits a 300px panel, where a 4-column grid is unusable.
*
* The compact shape reproduces the DOM the deleted service produced, because the
* CSS is keyed to it: a `paginator_container` in `mini` paginator mode, a
* `list_body` whose grid template comes from `config.template_columns`, an
* optional header row, and rows rendered as `view:'line'` section_records.
*/
view_tm_list_section.render = async function(self, options={}) {

	const tm_view = self.tm_view || 'tool'
	if (tm_view==='tool') {
		// (!) `.call(view_tm_list_section, …)`, never a bare call: the section render
		// resolves the row action through `this.render_column_id` (see
		// view_default_list_section.rebuild_columns_map). A bare
		// `view_default_list_section.render(...)` binds `this` to THAT module, whose
		// render_column_id is undefined, so the list silently falls back to the plain
		// Id cell and every row loses its restore/preview action — no error, just a
		// dead list.
		return view_default_list_section.render.call(view_tm_list_section, self, {
			...options,
			// per row, so rows built later by the window are marked too
			render_options	: { mark_empty_columns : true },
			decorate		: (node, index) => decorate_row(self, node, index)
		})
	}

	return compact_render(self, options, tm_view)
}//end render



/**
* DECORATE_ROW
* The row window's `decorate` of the tool list: run on every built row (the
* fill AND a later placeholder swap), so what is per-row state lives here.
* A row whose Id cell is the Time Machine action (render_column_id's
* `.button_view`) gets the `link` cursor affordance and, when it is the row the
* user previewed (`self.tm_active_index`), the active `warning` marker.
* @param {Object} self - The dd15 section instance
* @param {HTMLElement} node - The built row (`.section_record`)
* @param {number} index - Its page position (data-index)
* @returns {void}
*/
const decorate_row = function(self, node, index) {

	const button_view = node.querySelector(':scope > .column > .button_view')
	if (!button_view) {
		return
	}
	node.classList.add('link')
	button_view.classList.toggle('warning', self.tm_active_index===index)
}//end decorate_row



/**
* BIND_ROW_ACTION
* The whole-row click of the tool list: ONE delegated `mousedown` on the list's
* content_data, registered with the row window's signal (gone with the window
* on retire / destroy), resolving the row with `row_of` — never a per-row
* listener, never a `closest` walk that a nested record could stop.
*
* Clicking anywhere on a history row triggers its action, not only the small
* button — that is how this list has always behaved and what makes a dense list
* usable. Everything the action needs comes from the window: the snapshot
* address is the row's frozen entry (`entry_of`), the When component its built
* record's instance (`record_at`).
*
*   SECTION caller   → restore the WHOLE record to this snapshot (confirmed).
*   COMPONENT caller → preview this snapshot's value (no write).
*
* THE STANDALONE dd15 PAGE has no host (`?tipo=dd15&mode=list`, the bare browse
* of every section's history): no tool, no record to restore INTO, and its Id
* cell is the ordinary one — nothing is bound.
* @param {Object} self - The dd15 section instance
* @param {HTMLElement} content_data - The window's container
* @returns {boolean} true when bound
*/
const bind_row_action = function(self, content_data) {

	// list.caller is the HOST — tool_time_machine, or the inspector; tool.caller
	// is the section or component the history is OF.
		const tool			= self.caller
		const main_caller	= tool?.caller
		const record_window	= self.record_windows?.rows || null
		if (!tool || !main_caller || !record_window) {
			return false
		}

	content_data.addEventListener('mousedown', (e) => {
		const hit = row_of(content_data, e.target)
		if (!hit || hit.node.classList.contains('placeholder')) {
			return
		}
		const button_view = hit.node.querySelector(':scope > .column > .button_view')
		if (!button_view) {
			return
		}
		e.stopPropagation()
		if (main_caller.model==='section') {
			restore_section(self, tool, main_caller, record_window.entry_of(hit.index))
			return
		}
		preview_component(self, content_data, record_window, hit.index)
	}, { signal : record_window.signal })


	return true
}//end bind_row_action



/**
* RESTORE_SECTION
* The WRITE path. Confirmation first; on success the section refreshes before
* the list, so the list re-reads a store that already holds the restored value.
* @param {Object} list - The dd15 section instance
* @param {Object} tool - Its host (tool_time_machine)
* @param {Object} main_caller - The section the history is OF
* @param {Object} locator - The row's entry: carries caller_section_id /
*   caller_section_tipo / matrix_id, stamped by the server onto the envelope
*   entry (tmEnvelopeExtra)
* @returns {Promise<void>}
*/
const restore_section = async function(list, tool, main_caller, locator) {

	if (!locator) {
		return
	}
	const msg = tool.get_tool_label('recover_section_alert') || '*Are you sure you want to restore this section?'
	const confirmed = await ui.confirm({
		header	: tool.get_tool_label('tool_time_machine') || 'Time machine',
		body	: msg
	})
	if (confirmed!==true) {
		return
	}
	// lang is NOLAN: a whole-record snapshot is language-neutral.
	const response = await tool.apply_value({
		section_id		: locator.caller_section_id,
		section_tipo	: locator.caller_section_tipo,
		tipo			: locator.caller_section_tipo,
		lang			: page_globals.dedalo_data_nolan,
		matrix_id		: locator.matrix_id
	})
	if (response_data(response)===true) {
		await main_caller.refresh()
		await list.refresh()
		return
	}
	console.warn('tool_time_machine apply_value response:', response)
	await ui.confirm({
		header	: 'Error',
		body	: request_failed(response) ? error_text(response.error) : 'Error. Unknown error on apply tm value'
	})
}//end restore_section



/**
* PREVIEW_COMPONENT
* The READ path. Publishes the snapshot for the tool's preview pane and marks
* this row active — scoped to THIS list's rows, never the whole document (two
* open panels must not clear each other's marker). The marker is stored as the
* row index (`list.tm_active_index`) so decorate_row re-applies it to a row the
* window builds again later.
* @param {Object} list - The dd15 section instance
* @param {HTMLElement} content_data - The window's container
* @param {Object} record_window - The window handle
* @param {number} index - The clicked row
* @returns {void}
*/
const preview_component = function(list, content_data, record_window, index) {

	const locator			= record_window.entry_of(index)
	const section_record	= record_window.record_at(index)
	if (!locator || !section_record) {
		return
	}

	const modification_component_date = (section_record.ar_instances || []).find(instance => instance.tipo==='dd559')
	event_manager.publish('tm_edit_record', {
		tipo			: locator.caller_section_tipo,
		section_id		: locator.caller_section_id,
		matrix_id		: locator.matrix_id,
		modification_component_date	: modification_component_date,
		bulk_process_id	: locator.bulk_process_id || null,
		mode			: 'list',
		caller			: section_record
	})

	// active marker: this list's rows only
	list.tm_active_index = index
	const marked = content_data.querySelectorAll(':scope > .section_record > .column > .button_view.warning')
	for (let i = marked.length - 1; i >= 0; i--) {
		marked[i].classList.remove('warning')
	}
	const row = content_data.children[index]
	const button_view = row ? row.querySelector(':scope > .column > .button_view') : null
	if (button_view) {
		button_view.classList.add('warning')
	}
}//end preview_component



/**
* COMPACT_RENDER
* The inspector panel shape (ported from the deleted service's common_render, so
* the stylesheet keeps matching). `no_header` is the 'history' panel's contract:
* every row there is the same component, so a repeated header is noise.
*
* Rows are LINE section_records handed to the row window door like every list
* (view_tm_list_section.get_content_data). 'mini' is a table (`layout_table`
* list_body, header row, table roles); 'history' has no header and keeps its
* own row grid, so it is a list layout. Either way the no_records node and the
* print notice travel in `.list_after`, placed AFTER the list_body (never inside
* a role=table).
*/
const compact_render = async function(self, options, tm_view) {

	const no_header		= tm_view==='history'
	const layout_table	= tm_view!=='history'

	// columns_map (Id-less — these panels never had the synthetic Id column)
		const columns_map = await view_tm_list_section.rebuild_columns_map(self)
		self.columns_map = columns_map

	// rows. The page's locator entries; instances are built by the row window
		const rows = self.data?.entries || []
		self.ar_instances = self.ar_instances || []

	// content_data
		const content_data = await view_tm_list_section.get_content_data(self, rows, {
			// LINE rows (the compact shape), namespaced by view so the inspector's
			// two panels, which list the same record, cannot collide in the
			// instances registry
			records_options	: {
				mode		: 'list',
				view		: 'line',
				id_variant	: (self.id_variant || self.model) + '_' + tm_view
			},
			layout			: layout_table ? 'table' : 'list'
		})
		if ((options.render_level || 'full')==='content') {
			return content_data
		}

	// fragment
		const fragment = new DocumentFragment()

	// paginator (compact: '1-10 of 47', not the full page-number input)
		if (self.paginator) {
			const paginator_div = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'paginator_container',
				parent			: fragment
			})
			self.paginator.mode = 'mini'
			await self.paginator.build()
			self.paginator.render().then(paginator_wrapper => {
				paginator_div.appendChild(paginator_wrapper)
			})
		}

	// list_body
		const list_body = ui.create_dom_element({
			element_type	: 'div',
			class_name		: layout_table ? 'list_body layout_table' : 'list_body',
			parent			: fragment
		})
		// node_body. section.navigate marks `self.node_body` as the page-turn
		// loading surface (and gets .loading removed again on arrival); without it
		// these panels had no row-level cue at all. Same contract as
		// view_default_list_section (its list_body IS node_body).
		self.node_body = list_body
		const items				= ui.flat_column_items(columns_map)
		const template_columns	= self.tm_template_columns || items.join(' ')
		set_element_css(
			`${self.section_tipo}_${self.tipo}.tm_view_${tm_view}`,
			{ '.list_body' : { 'grid-template-columns' : template_columns } }
		)

	// header
		const header = (rows.length>0 && no_header!==true)
			? ui.render_list_header(columns_map, self)
			: null
		if (header) {
			list_body.appendChild(header)
		}
		list_body.appendChild(content_data)

	// a11y. Static table semantics (the window owns the dynamic part, incl.
	// dropping role=table from a header-less table with no rows)
		if (layout_table) {
			apply_table_semantics(list_body, header)
		}

	// wrapper. The tm_view class is what the stylesheet keys on.
		const wrapper = ui.create_dom_element({
			element_type	: 'div',
			class_name	: `wrapper_section section tm_list tm_view_${tm_view} ${self.section_tipo}_${self.tipo} ${self.tipo} ${self.mode}`
		})
		wrapper.appendChild(fragment)
		// (!) the content_data POINTER is the refresh contract: common.render with
		// render_level 'content' (every paginator navigation) replaces
		// `self.node.content_data` in place, and renders the "Invalid content_data
		// DOM node" error card when the pointer is missing. view_default_list_section
		// sets it too; this render must as well.
		wrapper.content_data	= content_data
		// the list_body pointer anchors `.list_after` AFTER the list_body (the
		// common.render 'content' swap reads it), never inside the role=table
		wrapper.list_body		= list_body
		place_list_after(wrapper, content_data)
		self.node = wrapper

	return wrapper
}//end compact_render



/**
* REBUILD_COLUMNS_MAP
* The section list prepends a synthetic Id column carrying the row action. The
* TOOL wants it — it is the restore/preview button. The INSPECTOR's two history
* panels never had one: they are a few columns wide in a side panel, and an extra
* column there both wastes space and mismatches what those panels have always
* shown. `self.tm_no_id_column` (set by the caller) suppresses it.
*/
view_tm_list_section.rebuild_columns_map = async function(self) {

	if (self.tm_no_id_column!==true) {
		return view_default_list_section.rebuild_columns_map.call(this, self)
	}

	// Id-less variant: the ontology columns as-is, one-shot like the default.
	if (self.fixed_columns_map===true) {
		return self.columns_map || []
	}
	self.fixed_columns_map = true
	return self.columns_map || []
}



/**
* RENDER_COLUMN_ID
* The leading Id cell of one Time Machine row — and the row's primary action.
*
* Two behaviours, chosen by what the tool was opened ON:
*
*   SECTION caller   → 'history' icon. Clicking asks for confirmation and then
*                      restores the WHOLE record to this snapshot, refreshing the
*                      section and then this list.
*   COMPONENT caller → 'eye' icon. Clicking publishes 'tm_edit_record' so the
*                      tool's preview pane loads this snapshot's value. No write.
*
* The cell only RENDERS the button: the click is the list's delegated row
* action (bind_row_action / restore_section / preview_component).
*
* @param {Object} options - Column-render options from section_record.
*   @param {Object} options.caller   - The list instance rendering this row.
*   @param {Object} options.locator  - The snapshot address; carries
*     caller_section_id / caller_section_tipo / matrix_id / bulk_process_id,
*     which the server stamps onto the envelope entry (tmEnvelopeExtra).
* @returns {DocumentFragment}
*/
view_tm_list_section.render_column_id = function(options) {

	// options
		const list				= options.caller
		const section_id		= options.locator.caller_section_id

	// short vars
		// list.caller is the HOST — tool_time_machine, or the inspector; tool.caller
		// is the section or component the history is OF.
		const tool			= list.caller
		const main_caller	= tool?.caller

	// THE STANDALONE dd15 PAGE has no host: `?tipo=dd15&mode=list` is the bare
	// browse of every section's history, opened directly, with no tool and no
	// record to restore INTO. There is nothing for a restore/preview action to act
	// on, so the cell is the ordinary section Id cell.
	// (Without this the page threw once per row — 25 render_callback failures on a
	// 25-row page — and rendered a broken list.)
		if (!tool || !main_caller) {
			return default_render_column_id(options)
		}

		const fragment		= new DocumentFragment()

	// button_view
		const button_view = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'button_view',
			parent			: fragment
		})

	// (!) no listener here: the whole row, button included, is ONE delegated
	// mousedown on the list's content_data (bind_row_action), which resolves
	// the row and reads its snapshot address from the window entry.

	// section_id
		ui.create_dom_element({
			element_type	: 'span',
			text_content	: section_id,
			class_name		: 'section_id',
			parent			: button_view
		})

	// icon: 'history' = restore the whole record, 'eye' = preview one component
		ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'button icon ' + (main_caller.model==='section' ? 'history' : 'eye'),
			parent			: button_view
		})


	return fragment
}//end render_column_id



// @license-end
