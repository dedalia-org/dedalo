// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global page_globals */
/*eslint no-undef: "error"*/



// imports
	import {ui} from '../../common/js/ui.js'
	import {event_manager} from '../../common/js/event_manager.js'
	import {dd_request_idle_callback} from '../../common/js/events.js'
	import {get_section_records} from './section.js'
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
*      row element is a known ancestor at render time; the listener goes on the
*      row, and the cursor affordance is CSS.
*
* Exports: view_tm_list_section
*/
export const view_tm_list_section = function() {

	return true
}//end view_tm_list_section



view_tm_list_section.get_content_data	= view_default_list_section.get_content_data



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
		const node = await view_default_list_section.render.call(view_tm_list_section, self, options)
		mark_empty_columns(node)
		return node
	}

	return compact_render(self, options, tm_view)
}//end render



/**
* MARK_EMPTY_COLUMNS
* Stamps `empty_column` on every value-less cell of every row (tool list only).
*
* WHY: on small screens the list stacks ALL columns of a snapshot vertically
* under its Id header, and a section carries ~15 fields while a snapshot touches
* a handful — the empty cells drown the data. The class is only a MARKER: the
* hiding is CSS, scoped to the phone breakpoint (tool_time_machine.less), so the
* desktop table keeps every column aligned.
*
* A column counts as empty when it has no text AND no media/control inside —
* image-only values (thumbnails) must survive. Runs on every render, so list
* refreshes re-mark; the class is idempotent.
*/
const mark_empty_columns = function(node) {

	const rows = node.querySelectorAll('.section_record')
	for (const row of rows) {
		const columns = row.querySelectorAll(':scope > .column')
		for (const column of columns) {
			const has_content = column.querySelector('img, svg, iframe, video, canvas, button, input, textarea')
			if (!has_content && column.textContent.trim()==='') {
				column.classList.add('empty_column')
			}
		}
	}
}//end mark_empty_columns



/**
* COMPACT_RENDER
* The inspector panel shape (ported from the deleted service's common_render, so
* the stylesheet keeps matching). `no_header` is the 'history' panel's contract:
* every row there is the same component, so a repeated header is noise.
*/
const compact_render = async function(self, options, tm_view) {

	const no_header = tm_view==='history'

	// columns_map (Id-less — these panels never had the synthetic Id column)
		const columns_map = await view_tm_list_section.rebuild_columns_map(self)
		self.columns_map = columns_map

	// section_record instances, rendered as LINE rows (the compact shape)
		const ar_section_record = await get_section_records({
			caller		: self,
			mode		: 'list',
			view		: 'line',
			// namespace by view so the inspector's two panels, which list the same
			// record, cannot collide in the instances registry
			id_variant	: (self.id_variant || self.model) + '_' + tm_view
		})
		self.ar_instances = []
		self.ar_instances.push(...ar_section_record)

	// content_data
		const content_data = await view_default_list_section.get_content_data(self, ar_section_record)
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
			class_name		: 'list_body',
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
		if (ar_section_record.length>0 && no_header!==true) {
			list_body.appendChild(ui.render_list_header(columns_map, self))
		}
		list_body.appendChild(content_data)

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
		// sets it at :235; this render must too.
		wrapper.content_data = content_data
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
* @param {Object} options - Column-render options from section_record.
*   @param {Object} options.caller   - The list instance rendering this row.
*   @param {Object} options.locator  - The snapshot address; carries
*     caller_section_id / caller_section_tipo / matrix_id / bulk_process_id,
*     which the server stamps onto the envelope entry (tmEnvelopeExtra).
*   @param {Array}  options.ar_instances - This row's component instances.
* @returns {DocumentFragment}
*/
view_tm_list_section.render_column_id = function(options) {

	// options
		const list				= options.caller
		const section_id		= options.locator.caller_section_id
		const section_tipo		= options.locator.caller_section_tipo
		const matrix_id			= options.locator.matrix_id
		const bulk_process_id	= options.locator.bulk_process_id

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

	// restore_section
	// The WRITE path. Confirmation first; on success the section refreshes before
	// the list, so the list re-reads a store that already holds the restored value.
		const restore_section = async () => {
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
				section_id		: section_id,
				section_tipo	: section_tipo,
				tipo			: section_tipo,
				lang			: page_globals.dedalo_data_nolan,
				matrix_id		: matrix_id
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
		}

	// preview_component
	// The READ path. Publishes the snapshot for the tool's preview pane and marks
	// this row active — scoped to THIS list's container, never the whole document.
		const preview_component = () => {
			const modification_component_date = options.ar_instances.find(instance => instance.tipo==='dd559')
			event_manager.publish('tm_edit_record', {
				tipo			: section_tipo,
				section_id		: section_id,
				matrix_id		: matrix_id,
				modification_component_date	: modification_component_date,
				bulk_process_id	: bulk_process_id || null,
				mode			: 'list',
				caller			: options
			})
			// Scope the active-row reset to this list (list.node when the instance
			// is built, else this row's own grid) — two open panels must not clear
			// each other's marker.
			const scope = list.node || button_view.closest('.list_body') || button_view.parentNode
			const buttons = scope ? scope.querySelectorAll('.button_view') : []
			for (let i = buttons.length - 1; i >= 0; i--) {
				buttons[i].classList.remove('warning')
			}
			button_view.classList.add('warning')
		}

	// click handler
		const click_handler = (e) => {
			e.stopPropagation()
			if (main_caller.model==='section') {
				restore_section()
				return
			}
			preview_component()
		}
		button_view.addEventListener('mousedown', click_handler)

	// WHOLE-ROW CLICK.
	// Clicking anywhere on a history row triggers it, not only the small button —
	// that is how this list has always behaved and what makes a dense list usable.
	// Scoped to THIS row (`closest('.section_record')`), unlike the deleted
	// service's walk of `parentNode.parentNode.children`, so a nested list cannot
	// be caught by an outer one. Deferred to idle because the row element does not
	// exist yet while its first cell is being built.
		dd_request_idle_callback(() => {
			const row = button_view.closest('.section_record')
			if (!row) {
				return
			}
			row.classList.add('link')
			row.addEventListener('mousedown', (e) => {
				// the button has its own listener; do not fire twice
				if (button_view.contains(e.target)) {
					return
				}
				click_handler(e)
			})
		})

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
