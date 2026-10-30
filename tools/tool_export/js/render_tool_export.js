// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*eslint no-unused-vars: "error"*/
/*global get_label, SHOW_DEBUG, page_globals*/
/*eslint no-undef: "error"*/



/**
 * RENDER_TOOL_EXPORT
 *
 * Client-side view layer for the tool_export data-export tool.
 *
 * Responsibilities
 * ----------------
 * 1. Build and return the full edit DOM for the tool (grid layout: left component
 *    picker, middle user-selected columns, right config panel).
 * 2. Manage the user-selection list: drag-and-drop add/sort, bulk activate/
 *    deactivate, per-component "parents" checkbox, IndexedDB persistence.
 * 3. Render the export config panel: format selector (value | grid_value |
 *    dedalo_raw), breakdown mode (default | rows | columns), option checkboxes
 *    (fill_the_gaps, show_tipo_in_label), Export and Stop.
 * 4. RUN THE SERVER-BUILT EXPORT (tool_export at scale): Export submits the
 *    build_export_artifact background job and follows it (job_follow.js);
 *    the preview is ONE PAGE of the server's spool (get_export_preview) with a
 *    pager and a page-size select; opening the tool reconnects to the latest
 *    export of the section. The DOM never holds more than one page.
 * 5. Downloads (CSV, TSV, ODS, XLSX, HTML, NDJSON, media ZIP): each asks the
 *    server to build the file from the WHOLE export (build_export_file, a
 *    background job) and hands the browser the owner-only download URL —
 *    enabled only when the export ENDED. Print prints the current page only,
 *    and says so.
 * 6. Manage the export-presets UI panel (create / save / select / lazy-load).
 * 7. Keep ar_ddo_to_export (the ordered list of ddo descriptors sent to the
 *    server) in sync with the DOM order of the selection list.
 *
 * Key data shapes
 * ---------------
 * ddo (data-definition object) stored per column in ar_ddo_to_export:
 *   {
 *     id             : string   — composite id (compose_id output)
 *     tipo           : string   — ontology tipo of the component (e.g. 'rsc29')
 *     section_tipo   : string   — section tipo that owns the component
 *     model          : string   — component model (e.g. 'component_image')
 *     parent         : string   — parent tipo
 *     lang           : string   — language code (e.g. 'lg-eng')
 *     mode           : string   — 'edit' | 'list'
 *     label          : string   — human label
 *     value_with_parents : boolean — per-column ancestor-chain export flag
 *     path           : Array    — full path from the current section root
 *   }
 *
 * export_state (self.export_state, new_export_state): the current export —
 * artifact job_id, lane job + pfile (stop handle), status, written/total, the
 * loaded preview page, and the files built in this view. The server is the
 * source of truth (list_export_jobs / get_export_preview); the wire is
 * documented in tool_export.js ("THE SERVER-BUILT EXPORT").
 *
 * Exports
 * -------
 * render_tool_export  — constructor (assigned to tool_export.prototype.edit etc.)
 * get_media_models_in_data — the media models the export's media ZIP can archive (preview media_models)
 * render_download_modal   — the quality-selection modal for the media ZIP
 *
 * Related files
 * -------------
 * tool_export.js           — constructor, wire helpers, runtime lifetime
 * flat_table.js            — one-page renderer
 * drag_tool_export.js      — dragstart / dragover / dragleave / drop handlers
 * export_user_presets.js   — preset CRUD (load / create / save / apply) + storage helpers
 * server/                  — the export job, preview, writers and download route
 */

// imports
	import {render_components_list} from '../../../core/common/js/render_common.js'
	import {render_phone_reorder} from '../../../core/tools_common/js/phone_reorder.js'
	import {is_touch} from '../../../core/common/js/touch_pick.js'
	import {data_manager} from '../../../core/common/js/data_manager.js'
	import {request_failed, response_data, response_extension, normalize_stream_error} from '../../../core/common/js/api_error.js'
	import {error_text, error_debug_suffix} from '../../../core/common/js/render_api_error.js'
	import {ROW_WINDOW_MAX_ROWS} from '../../../core/common/js/row_window.js'
	import {ui} from '../../../core/common/js/ui.js'
	import {dd_request_idle_callback, when_in_viewport} from '../../../core/common/js/events.js'
	import {flat_table} from './flat_table.js'
	import {
		presets_section_tipo,
		load_user_export_presets,
		create_new_export_preset,
		save_export_preset,
		edit_user_export_preset,
		storage_get,
		storage_set
	} from './export_user_presets.js'
	import {render_preset_modal, select_preset} from '../../../core/section/js/view_export_user_presets.js'



/**
 * RENDER_TOOL_EXPORT
 * Prototype namespace for the tool_export view layer.
 * Constructed empty; all logic is attached as prototype methods below and
 * mixed into tool_export via prototype assignment (tool_export.js).
 */
export const render_tool_export = function() {
}//end render_tool_export



/**
 * PARENTS_MODELS
 * Component models eligible for the per-column "parents" checkbox
 * (build_export_component): relation components whose locator targets can be
 * traversed upward through an ancestor chain to produce a sibling 'parents'
 * column in the export output (WC-049 — value and grid_value formats; see
 * PARENTS_FORMATS).
 *
 * The model gate is only the FIRST filter: the checkbox renders only when the
 * server confirms the component's target section actually has a
 * component_relation_parent (tool_export.components_with_parent action —
 * see component_has_parent_targets).
 */
const PARENTS_MODELS = new Set([
	'component_portal',
	'component_autocomplete',
	'component_autocomplete_hi'
])



/**
 * PARENTS_FORMATS
 * Data formats whose export honours the per-column parents flag (WC-049 +
 * addendum 2026-09-25): 'value' (a sibling '<column> | parents' column, one
 * chain per item) and 'grid_value' (per-locator '#parents' atoms). NOT
 * 'dedalo_raw': a raw export carries stored data only and parents are derived,
 * so the checkbox is DISABLED there, with a visible note (the server ignores the
 * flag in raw either way). The ddo keeps its flag, so switching back restores it.
 */
const PARENTS_FORMATS = new Set([
	'value',
	'grid_value'
])



/**
 * SET_PARENTS_CHECK_STATE
 * Enables/disables one column's parents checkbox for the current data format
 * (PARENTS_FORMATS) and shows/hides its 'not in raw' note.
 * @param {Object} self - The tool_export instance
 * @param {HTMLElement} parents_label - The .export_component_parents label
 * @returns {void}
 */
const set_parents_check_state = function(self, parents_label) {

	const supported		= PARENTS_FORMATS.has(self.data_format || 'value')
	const parents_check	= parents_label.querySelector('.export_component_parents_check')
	const note			= parents_label.querySelector('.export_component_parents_note')

	if (parents_check) {
		parents_check.disabled = !supported
	}
	parents_label.classList.toggle('disabled', !supported)
	if (note) {
		note.classList.toggle('hide', supported)
	}
	parents_label.title = supported
		? (self.get_tool_label('value_with_parents') || 'Export parents')
		: (self.get_tool_label('parents_not_in_raw') || 'Parents are not exported in the Dédalo (Raw) format')
}//end set_parents_check_state



/**
 * EDIT
 * Renders the full edit-mode DOM tree for the tool_export widget and returns
 * it wrapped in the standard tool wrapper element.
 *
 * When options.render_level === 'content', skips the outer wrapper and returns
 * only the content_data DocumentFragment (used by partial re-renders / refresh).
 * Otherwise the full wrapper is returned with content_data attached as a
 * property so callers can reach it without re-querying the DOM.
 *
 * Delegates all layout work to get_content_data_edit().
 *
 * @param {Object} options
 * @param {string} [options.render_level='full'] - 'full' | 'content'
 * @returns {Promise<HTMLElement>} wrapper (or content_data when render_level==='content')
 */
render_tool_export.prototype.edit = async function (options) {

	const self = this

	// render level
		const render_level = options.render_level || 'full'

	// content_data
		const content_data = await get_content_data_edit(self)
		if (render_level==='content') {
			return content_data
		}

	// wrapper. ui build_edit returns component wrapper
		const wrapper = ui.tool.build_wrapper_edit(self, {
			content_data : content_data
		})
		// set pointers
		wrapper.content_data = content_data


	return wrapper
}//end render_tool_export



/**
 * GET_CONTENT_DATA_EDIT
 * Builds and returns the complete interior DOM of the tool_export edit view.
 *
 * Layout (three-column grid inside .grid_top):
 *   LEFT  (.components_list_container) — scrollable list of all available
 *         section components, rendered by render_components_list().  Each item
 *         is draggable ('add' drag_type) into the middle panel.
 *   MIDDLE (.selection_list_contaniner) — ordered list of columns chosen for
 *         export, each a draggable export_component node (sort drag_type).
 *         Restored from IndexedDB (tool_export_config) on first render. The
 *         whole column is ONE drop zone (drag_tool_export.js: a marker shows
 *         the insertion point under the pointer).
 *   RIGHT  (.export_buttons_config) — export presets toolbar, record count,
 *         progress bar, format / breakdown selectors, option checkboxes,
 *         Export + Stop buttons, and the export status line.
 *
 * Below .grid_top:
 *   .export_buttons_options — download buttons (CSV / TSV / ODS / XLSX / HTML /
 *     NDJSON / media ZIP) + Print and its "current page only" note. Enabled
 *     only while the current export's status is 'ended'.
 *   .export_pager — first / previous / next / last, "a–b of N", "written /
 *     total" while the job runs, and the page-size selector.
 *   .export_data_container — ONE preview page (flat_table.render_page).
 *
 * Side effects:
 *   - Sets self.user_selection_list, self.components_list_container,
 *     self.selection_list_contaniner, self.export_buttons_options,
 *     self.progress_ui, self.button_export, self.export_ui.
 *   - Populates self.ar_ddo_to_export from persisted IndexedDB data on startup.
 *   - Persists format/breakdown/page-size selectors in localStorage (try/catch).
 *   - Reconnects to the caller's latest export of this section (reconnect_export).
 *
 * @param {Object} self - The tool_export instance
 * @returns {Promise<HTMLElement>} content_data node containing the full UI
 */
const get_content_data_edit = async function(self) {

	const fragment = new DocumentFragment()

	// grid_top
		const grid_top = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'grid_top no_print',
			parent			: fragment
		})

	// components_list_container (left side)
		const components_list_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'components_list_container',
			parent			: grid_top
		})
		self.components_list_container = components_list_container;
		// components_list. render section component list [left]
		// (self.section_elements was fetched by tool_export.build)
		const ar_components = render_components_list({
			self					: self,
			section_tipo			: self.target_section_tipo,
			target_div				: components_list_container,
			path					: [],
			section_elements		: self.section_elements,
			ar_components_exclude	: self.section_elements_components_exclude
		})

	// user_selection_list (right side)
		const selection_list_contaniner = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'selection_list_contaniner',
			parent			: grid_top
		})
		self.selection_list_contaniner = selection_list_contaniner;
		// title
		ui.create_dom_element({
			element_type	: 'h1',
			class_name		: 'list_title',
			text_content	: self.get_tool_label('active_elements') || 'Active elements',
			parent			: selection_list_contaniner
		})
		// user_selection_list
		const user_selection_list = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'user_selection_list',
			parent			: selection_list_contaniner
		})
		// store reference so user presets (apply_export_preset) can rebuild the selection
		self.user_selection_list = user_selection_list
		// empty_space. The free room below the rows; while the list is empty it
		// shows the drop hint (CSS: .user_selection_list:empty + .empty_space)
		const empty_space = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'empty_space',
			parent			: selection_list_contaniner
		})
		// the empty-state hint must name the gesture the user HAS. On a touch
		// screen the fields carry a "+" (a finger cannot drag), so a "drag a field
		// here" hint would be a dead instruction; it points at the "+" instead.
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'drop_hint',
			text_content	: is_touch()
				? '＋ ' + (get_label.add_field || 'Add field')
				: (get_label.drop_field_here || 'Drag a field here'),
			parent			: empty_space
		})

		// drop zone. The WHOLE column (title + rows + free space) is one zone:
		// the pointer picks the insertion index, a marker shows it
		// (drag_tool_export.js)
		selection_list_contaniner.addEventListener('dragover', (e) => self.on_dragover(selection_list_contaniner, e))
		selection_list_contaniner.addEventListener('dragleave', (e) => self.on_dragleave(selection_list_contaniner, e))
		selection_list_contaniner.addEventListener('drop', (e) => self.on_drop(selection_list_contaniner, e))
		// every drag of ours ends inside grid_top ('add' starts in the left list):
		// no marker, highlight or payload outlives it
		grid_top.addEventListener('dragend', () => self.on_dragend())

		// read saved ddo in local DB and restore elements if found
		// The IndexedDB key 'tool_export_config' stores an object keyed by
		// target_section_tipo; each value is an array of serialised ddo objects.
			const id = 'tool_export_config'
			data_manager.get_local_db_data(
				id,
				'data'
			)
			.then(function(response){
				const target_section_tipo = Array.isArray(self.target_section_tipo)
					? self.target_section_tipo[0]
					: self.target_section_tipo
				if (response?.value && response.value[target_section_tipo]) {
					// call for each saved ddo
					for (let i = 0; i < response.value[target_section_tipo].length; i++) {
						const ddo = response.value[target_section_tipo][i]
						self.build_export_component(ddo)
						.then((export_component_node)=>{
							// add DOM node
							user_selection_list.appendChild(export_component_node)
							// Update the ddo_export
							self.ar_ddo_to_export.push(ddo)
							// phone up/down buttons follow the order
							self.update_phone_reorder_state()
						})
					}
					if(SHOW_DEBUG===true) {
						console.log(`Added ddo items from saved local db ${target_section_tipo}. Items:`, response.value[target_section_tipo]);
					}
				}
			})

	// export_buttons_config
		const export_buttons_config = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'export_buttons_config',
			parent			: grid_top
		})

		// user presets (save/load export configurations per user, DB backed)
			render_presets_ui(self, export_buttons_config)

		// records info
			ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'records_info',
				parent			: export_buttons_config
			})
			ui.create_dom_element({
				element_type	: 'h1',
				class_name		: 'section_label',
				text_content	: self.caller.label,
				parent			: export_buttons_config
			})
			const total_records_label = ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'total_records_label',
				text_content	: (get_label.total_records || 'Total records') + ': ',
				parent			: export_buttons_config
			})
			const total_records = ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'total_records',
				parent			: total_records_label
			})
			// section get total (fire and forget; the export's own total comes
			// from the job's meta line)
			self.caller.get_total()
			.then(function(total){
				self.total_records = total;
				total_records.textContent = format_number(total)
			})

		// Progress Bar Container
		// Dual-layer strategy for the "inverted color" text effect: text_bg is dark
		// and sits at the bottom; text_fg is white on top, clipped to the bar.
			const progress_container = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'export_progress_container no_visible',
				parent			: export_buttons_config
			})
			const progress_text_bg = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'export_progress_text bg',
				parent			: progress_container
			})
			const progress_bar = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'export_progress_bar',
				parent			: progress_container
			})
			const progress_text_fg = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'export_progress_text fg',
				parent			: progress_container
			})
			self.progress_ui = { container: progress_container, bar: progress_bar, text_bg: progress_text_bg, text_fg: progress_text_fg };

		// data lang selector: the language the values are resolved in. It starts on
		// the menu's data lang (DEDALO_DATA_LANG) every time the tool opens — the
		// choice is not stored. Dédalo (Raw) carries every stored language, so the
		// selector is disabled for it (see update_lang_state).
			const data_lang = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'data_format data_lang',
				text_content	: self.get_tool_label('data_lang') || 'Data language',
				parent			: export_buttons_config
			})
			const select_lang_export = ui.build_select_lang({
				langs		: self.langs,
				selected	: self.lang,
				class_name	: 'select_lang_export'
			})
			select_lang_export.addEventListener('change', () => {
				self.lang = select_lang_export.value
			})
			data_lang.appendChild(select_lang_export)
			self.select_lang_export = select_lang_export

		// data_format selectors
			const data_format = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'data_format',
				text_content	: (get_label.format || 'Format'),
				parent			: export_buttons_config
			})
			// select
				const select_data_format_export = ui.create_dom_element({
					element_type	: 'select',
					class_name		: 'select_data_format_export',
					parent			: data_format
				})
				const change_handler = () => {
					// fix value
					self.data_format = select_data_format_export.value
					// store to preserve across reloads
					storage_set('selected_data_format_export', select_data_format_export.value)
					// breakdown mode only applies to the breakdown format
					update_breakdown_state()
					// the data lang does not apply to the Dédalo (Raw) format
					self.update_lang_state()
					// the per-column parents checkbox only applies to value/grid_value
					self.update_parents_checks_state()
				}
				select_data_format_export.addEventListener('change', change_handler)

				// select_option_standard
				ui.create_dom_element({
					element_type	: 'option',
					text_content	: get_label.standard || 'standard',
					value			: 'value',
					parent			: select_data_format_export
				})
				// select_option_breakdown
				ui.create_dom_element({
					element_type	: 'option',
					text_content	: self.get_tool_label('breakdown') || 'Breakdown',
					value			: 'grid_value',
					parent			: select_data_format_export
				})
				// select_option_dedalo
				ui.create_dom_element({
					element_type	: 'option',
					text_content	: 'Dédalo (Raw)',
					value			: 'dedalo_raw',
					parent			: select_data_format_export
				})

				// fix selector value (a stale stored value falls back to 'value')
				const stored_data_format = storage_get('selected_data_format_export')
				self.data_format = (stored_data_format && ['value','grid_value','dedalo_raw'].includes(stored_data_format))
					? stored_data_format
					: 'value'
				select_data_format_export.value = self.data_format
				self.update_lang_state()

		// breakdown mode selector (relation explosion, only for the breakdown format)
			const breakdown_container = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'data_format breakdown_mode',
				text_content	: (self.get_tool_label('breakdown') || 'Breakdown'),
				parent			: export_buttons_config
			})
			const select_breakdown_export = ui.create_dom_element({
				element_type	: 'select',
				class_name		: 'select_breakdown_export',
				parent			: breakdown_container
			})
			const breakdown_change_handler = () => {
				self.breakdown = select_breakdown_export.value
				storage_set('selected_breakdown_export', select_breakdown_export.value)
			}
			select_breakdown_export.addEventListener('change', breakdown_change_handler)

			// default: legacy semantics (first relation level rows, nested columns)
			ui.create_dom_element({
				element_type	: 'option',
				text_content	: get_label.standard || 'Default',
				value			: 'default',
				parent			: select_breakdown_export
			})
			// rows: every relation item becomes an extra row
			ui.create_dom_element({
				element_type	: 'option',
				text_content	: get_label.rows || 'Rows',
				value			: 'rows',
				parent			: select_breakdown_export
			})
			// columns: every relation item becomes extra columns (one row per record)
			ui.create_dom_element({
				element_type	: 'option',
				text_content	: get_label.columns || 'Columns',
				value			: 'columns',
				parent			: select_breakdown_export
			})

			const stored_breakdown = storage_get('selected_breakdown_export')
			self.breakdown = (stored_breakdown && ['default','rows','columns'].includes(stored_breakdown))
				? stored_breakdown
				: 'default'
			select_breakdown_export.value = self.breakdown

			// the breakdown mode applies to the grid_value format only
			const update_breakdown_state = () => {
				select_breakdown_export.disabled = (self.data_format!=='grid_value')
			}
			update_breakdown_state()

		// Options to check
			const options_to_check = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'options_to_check',
				parent			: export_buttons_config
			})
			// Fill the gaps check_box
				const fill_the_gaps_node = ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'check_label fill_the_gaps',
					text_content	: self.get_tool_label('fill_the_gaps') || 'Fill the gaps',
					parent			: options_to_check
				})
				const fill_the_gaps_check = ui.create_dom_element({
					element_type	: 'input',
					type			: 'checkbox',
					class_name		: 'option_check_box fill_the_gaps_check',
					parent			: fill_the_gaps_node
				})
				fill_the_gaps_check.checked = true

			// show labels check_box. A presentation option: it re-renders the current
			// preview page at once, and the files are built with the value current
			// at download time.
				const show_tipo_in_label = ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'check_label show_tipo_in_label',
					text_content	: self.get_tool_label('show_tipo_in_label') || 'Show ontology tipo',
					parent			: options_to_check
				})
				const show_tipo_in_label_check = ui.create_dom_element({
					element_type	: 'input',
					type			: 'checkbox',
					class_name		: 'option_check_box show_tipo_in_label_check',
					parent			: show_tipo_in_label
				})
				show_tipo_in_label_check.addEventListener('change', () => {
					render_preview_table(self)
				})

		// button_export
			const button_export = ui.create_dom_element({
				element_type	: 'button',
				class_name		: 'button_export table success',
				text_content	: self.get_tool_label('tool_export') || 'Export',
				parent			: export_buttons_config
			})
			button_export.addEventListener('click', function(e) {
				e.stopPropagation()
				run_export(self, {
					data_format			: self.data_format,
					breakdown			: self.breakdown,
					lang				: self.lang,
					ar_ddo_to_export	: self.ar_ddo_to_export,
					fill_the_gaps		: fill_the_gaps_check.checked
				})
			})
			self.button_export = button_export

		// button_stop. Visible only while THIS tool can stop the running export
		// (it knows the lane job's pfile).
			const button_stop = ui.create_dom_element({
				element_type	: 'button',
				class_name		: 'button_stop_export warning hide',
				text_content	: self.get_tool_label('stop') || 'Stop',
				parent			: export_buttons_config
			})
			button_stop.addEventListener('click', function(e) {
				e.stopPropagation()
				stop_export(self)
			})

		// button_delete. Deletes the shown export with all its files on the
		// server (freeing the user's export quota). Visible only when the export
		// is no longer running: the server refuses a running one
		// (export.artifact_busy) — Stop first.
			const button_delete = ui.create_dom_element({
				element_type	: 'button',
				class_name		: 'button_delete_export light hide',
				text_content	: self.get_tool_label('delete_export') || 'Delete export',
				parent			: export_buttons_config
			})
			button_delete.addEventListener('click', function(e) {
				e.stopPropagation()
				delete_export(self)
			})

		// button_rerun. Visible only when the shown export ENDED INCOMPLETE because
		// an external source could not answer and a re-run can plausibly fix it
		// (list_export_jobs `external_degraded.retryable`). It runs the SAME
		// export again — the server re-reads the recorded options of that export
		// (build_export_artifact `rerun_of`), whatever this form shows now.
			const button_rerun = ui.create_dom_element({
				element_type	: 'button',
				class_name		: 'button_rerun_export light hide',
				text_content	: self.get_tool_label('export_rerun') || 'Run the export again',
				parent			: export_buttons_config
			})
			button_rerun.addEventListener('click', function(e) {
				e.stopPropagation()
				const state = self.export_state
				if (!state || !state.job_id) {
					return
				}
				run_export(self, {rerun_of: state.job_id})
			})

		// response container (the export status line + its reason)
			const response_container = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'response_container',
				parent			: export_buttons_config
			})

		// activate_all_columns
			const activate_all_columns = ui.create_dom_element({
				element_type	: 'button',
				class_name		: 'activation light activate_all_columns',
				text_content	: self.get_tool_label('activate_all_columns') || 'Activate all columns',
				parent			: export_buttons_config
			})
			activate_all_columns.addEventListener('click', function(e) {
				e.stopPropagation()

				const ar_components_length = ar_components.length
				for (let i = 0; i < ar_components_length; i++) {

					const item = ar_components[i]

					// short vars
						const path	= item.path
						const ddo	= item.ddo
						const id	= self.compose_id(ddo, path)

					// rebuild ddo
						const new_ddo = {
							id				: id,
							tipo			: ddo.tipo,
							section_tipo	: ddo.section_tipo,
							model			: ddo.model,
							parent			: ddo.parent,
							lang			: ddo.lang,
							mode			: ddo.mode,
							label			: ddo.label,
							value_with_parents	: false, // per-component parents export (checkbox in the item)
							path			: path // full path from current section replaces ddo single path
						}

					// exists
						const found = self.ar_ddo_to_export.find(el => el.id===new_ddo.id)
						if (found) {
							// Ignored already included item ddo
							continue;
						}

					// Build component html
						self.build_export_component(new_ddo)
						.then((export_component_node)=>{

							// add DOM node
							user_selection_list.appendChild(export_component_node)

							// Update the ddo_export list
							self.ar_ddo_to_export.push(new_ddo)

							// save local db data
							self.update_local_db_data()

							// phone up/down buttons follow the order
							self.update_phone_reorder_state()
						})
				}//end for (let i = 0; i < ar_components_length; i++)
			})

		// deactivate_all_columns
			const deactivate_all_columns = ui.create_dom_element({
				element_type	: 'button',
				class_name		: 'activation light deactivate_all_columns',
				text_content	: self.get_tool_label('disable_all_columns') || 'Disable all columns',
				parent			: export_buttons_config
			})
			deactivate_all_columns.addEventListener('click', function(e) {
				e.stopPropagation()

				const close_buttons = user_selection_list.querySelectorAll('.close') || []
				const close_buttons_length = close_buttons.length
				for (let i = 0; i < close_buttons_length; i++) {
					const item = close_buttons[i]
					item.click()
				}
			})

	// download_buttons_options. Every button asks the SERVER for the file
	// (build_export_file over the whole export) — none of them reads the screen.
		const export_buttons_options = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'export_buttons_options no_print',
			parent			: fragment
		})
		self.export_buttons_options = export_buttons_options;

		const download_label = get_label.download || 'Download'
		const download_buttons = new Map()
		for (const item of DOWNLOAD_FORMATS) {
			const button = ui.create_dom_element({
				element_type	: 'button',
				class_name		: 'processing_import success download download_' + item.format,
				text_content	: download_label + ' ' + (item.label_key ? (self.get_tool_label(item.label_key) || item.label) : item.label),
				parent			: export_buttons_options
			})
			button.disabled = true
			button.addEventListener('click', function(e) {
				e.stopPropagation()
				if (item.format==='media_zip') {
					// modal with the per-model quality selection
					render_download_modal(self)
					return
				}
				download_format(self, item.format, button)
			})
			download_buttons.set(item.format, button)
		}

		// print. The CURRENT PAGE only (the DOM never holds more) — said on screen.
			const button_export_print = ui.create_dom_element({
				element_type	: 'button',
				class_name		: 'processing_import success print',
				text_content	: get_label.print || 'Print',
				parent			: export_buttons_options
			})
			button_export_print.disabled = true
			button_export_print.addEventListener('click', function(e) {
				e.stopPropagation()
				e.preventDefault()
				window.print()
				return false;
			})
			ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'print_note',
				text_content	: self.get_tool_label('print_current_page_note')
					|| 'Print prints the current preview page only. Download HTML for the whole export.',
				parent			: export_buttons_options
			})

		// incomplete note: the downloads stay available, and say what they lack
		// (an external source could not answer — list_export_jobs `external_degraded`)
			const download_incomplete_note = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'download_incomplete_note hide',
				text_content	: self.get_tool_label('export_file_incomplete')
					|| 'These files are incomplete: some values from external sources are missing.',
				parent			: export_buttons_options
			})

		// download status line (a file being built, or why it failed)
			const download_status = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'download_status',
				parent			: export_buttons_options
			})

	// pager
		const pager = render_pager(self, fragment)

	// grid data container (ONE page)
		const export_data_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'export_data_container',
			parent			: fragment
		})

	// export_ui. The nodes the export runtime paints (run / reconnect / pager)
		self.export_ui = {
			button_export			: button_export,
			button_stop				: button_stop,
			button_delete			: button_delete,
			button_rerun			: button_rerun,
			download_incomplete_note: download_incomplete_note,
			response_container		: response_container,
			download_buttons		: download_buttons,
			button_print			: button_export_print,
			download_status			: download_status,
			show_tipo_in_label_check: show_tipo_in_label_check,
			pager					: pager,
			export_data_container	: export_data_container
		}

	// content_data
		const content_data = ui.tool.build_content_data(self)
		content_data.appendChild(fragment)

	// the current export. A re-render of a live instance repaints the export it
	// already holds (its followers read self.export_ui, now these nodes); a fresh
	// open reconnects to the caller's latest export of this section (the job
	// outlives the tool: closing it never stops the export).
		if (self.export_state) {
			render_preview_table(self)
			paint_export(self)
		}else{
			reconnect_export(self)
		}


	return content_data
}//end get_content_data_edit



/**
 * DOWNLOAD_FORMATS
 * The download buttons, in display order. `format` is the server's
 * EXPORT_FORMATS value (tools/tool_export/server/artifact_store.ts).
 */
const DOWNLOAD_FORMATS = [
	{format: 'csv',			label: 'CSV'},
	{format: 'tsv',			label: 'TSV'},
	{format: 'ods',			label: 'ODS'},
	{format: 'xlsx',		label: 'XLSX'},
	{format: 'html',		label: 'HTML'},
	{format: 'ndjson',		label: 'NDJSON', label_key: 'download_ndjson'},
	{format: 'media_zip',	label: 'media', label_key: 'media'}
]

/**
 * PAGE_SIZE_OPTIONS
 * Preview page sizes offered, never above the row window's ceiling (the server
 * clamps to the same 200 — spool_reader.ts PREVIEW_PAGE_SIZE_MAX).
 */
const PAGE_SIZE_OPTIONS = [25, 50, 100, 200].filter(size => size <= ROW_WINDOW_MAX_ROWS)

/** localStorage key of the remembered preview page size. */
const PAGE_SIZE_STORAGE_KEY = 'tool_export_preview_page_size'

/** Minimum spacing of two preview refreshes while the export runs (ms). */
const PREVIEW_REFRESH_MS = 1000

/** Preview poll interval when no job stream can be followed (reconnect) (ms). */
const PREVIEW_POLL_MS = 2000
// reconnect: lane jobs followed at once while looking for this export's writer
const RECONNECT_MAX_CANDIDATES = 2



/**
 * FORMAT_NUMBER
 * Locale-formatted integer ('' for a non-number).
 * @param {number} value
 * @returns {string}
 */
const format_number = function(value) {

	if (typeof value!=='number' || !Number.isFinite(value)) {
		return ''
	}
	try {
		return new Intl.NumberFormat(undefined, {}).format(value)
	} catch (error) {
		return String(value)
	}
}//end format_number



/**
 * EXPORT_TIMEOUT
 * A setTimeout owned by the export runtime (cleared by reset_export_runtime).
 * @param {Object} self
 * @param {Function} fn
 * @param {number} ms
 * @returns {number} timer id
 */
const export_timeout = function(self, fn, ms) {

	const timer = setTimeout(() => {
		self.export_timers.delete(timer)
		fn()
	}, ms)
	self.export_timers.add(timer)

	return timer
}//end export_timeout



/**
 * NEW_EXPORT_STATE
 * The current export's client state. The server is the source of truth; this
 * holds only what the view needs between two answers.
 * @param {Object} [init]
 * @returns {Object}
 */
const new_export_state = function(init={}) {

	return {
		// artifact id (the spool's job id — preview / files / list_export_jobs)
		job_id			: init.job_id || null,
		// lane job (job_follow + stop_process); null when not known
		lane_job_id		: init.lane_job_id || null,
		pfile			: init.pfile || null,
		// 'starting' | 'running' | 'ended' | 'failed' | 'cancelled' | 'interrupted'
		status			: init.status || 'starting',
		error_code		: init.error_code || null,
		// the manifest's error object ({code, label_key, message, retryable,
		// details?} — only {code} for a code the registry no longer knows)
		error			: null,
		error_text		: null,
		// Stop was accepted by the server for this export
		stop_requested	: false,
		written			: init.written || 0,
		total			: init.total ?? null,
		// the ACL frontier narrowed the selection (list_export_jobs `narrowed`):
		// the files hold fewer records than asked for — said on the status line
		narrowed		: false,
		// the external-source summary (list_export_jobs / get_export_preview
		// `external_degraded`): null, or {incomplete, retryable, cells, records,
		// counts, sample} — said on the status line, the downloads say it too
		external_degraded	: null,
		following		: false,
		// reconnect: cancels of the lane-job candidates still unconfirmed
		candidates		: new Set(),
		// preview
		page			: 0,
		page_size		: read_page_size(),
		// the column window (get_export_preview col_page): a wide export is
		// served one window of columns at a time
		col_page		: 0,
		preview			: null,
		preview_seq		: 0,
		preview_loading	: false,
		preview_at		: 0,
		preview_pending	: false,
		// built files of THIS export, by format + options key
		files			: new Map()
	}
}//end new_export_state



/**
 * READ_PAGE_SIZE
 * The remembered preview page size, or null (the server default then applies).
 * @returns {number|null}
 */
const read_page_size = function() {

	const stored = Number(storage_get(PAGE_SIZE_STORAGE_KEY))

	return PAGE_SIZE_OPTIONS.includes(stored) ? stored : null
}//end read_page_size



/**
 * RUN_EXPORT
 * The Export button: release the previous view's runtime (streams, timers,
 * requests — never the previous server job), submit build_export_artifact
 * and follow it.
 * @param {Object} self - tool_export instance
 * @param {Object} options - {data_format, breakdown, ar_ddo_to_export, fill_the_gaps}
 * @returns {Promise<boolean>} true when the job was accepted
 */
const run_export = async function(self, options) {

	const ui_refs = self.export_ui

	self.reset_export_runtime()
	const state = new_export_state()
	self.export_state = state
	ui_refs.export_data_container.replaceChildren()
	paint_export(self)

	// a re-run takes its columns from the recorded export (server side)
	if (!options.rerun_of && (!Array.isArray(options.ar_ddo_to_export) || !options.ar_ddo_to_export.length)) {
		set_export_failed(self, null, self.get_tool_label('no_columns_selected') || 'Select at least one column to export')
		return false
	}

	ui_refs.button_export.classList.add('loading')
	const api_response = await self.start_export_job(options)
	ui_refs.button_export.classList.remove('loading')

	// superseded (a newer run or a destroy) while submitting
	if (self.export_state!==state || state.status!=='starting') {
		return false
	}

	if (request_failed(api_response)) {
		// too_many_jobs (429, details.limit), a refused gate, … — the label says why
		set_export_failed(self, api_response.error.code, error_text(api_response.error))
		return false
	}

	const lane_job_id = response_extension(api_response, 'job_id')
	state.lane_job_id	= lane_job_id || null
	state.pfile			= response_extension(api_response, 'pfile') || null
	state.status		= 'running'
	paint_export(self)

	if (lane_job_id) {
		follow_export_job(self, lane_job_id, null)
	}else{
		// accepted without a followable job: the preview poll is the fallback
		schedule_preview_poll(self)
	}

	return true
}//end run_export



/**
 * FOLLOW_EXPORT_JOB
 * Follow the export's lane job: each progress frame carries the artifact id
 * and written/total; the terminal frame ends it. Through the instance's
 * follower group, so a destroy or a new Export releases the connection.
 *
 * Without `expected_job_id` (run_export) the lane job IS this export's: it is
 * followed at once. With it (reconnect) the lane job is only a CANDIDATE:
 * get_background_jobs cannot say which artifact a lane job writes, and a job
 * still queued in the lane publishes no progress frame. A candidate is
 * CONFIRMED by its first progress frame (or its terminal summary) naming the
 * expected artifact — only then does it arm Stop (pfile) and take over from
 * the preview poll; the other candidates are dropped. A mismatch drops just
 * that candidate. Until a confirmation the poll keeps the view current.
 * @param {Object} self
 * @param {string} lane_job_id
 * @param {string|null} expected_job_id - on reconnect, the artifact the lane
 *   job must be writing
 * @returns {void}
 */
const follow_export_job = function(self, lane_job_id, expected_job_id) {

	const state		= self.export_state
	let confirmed	= !expected_job_id
	if (confirmed) {
		state.following = true
	}

	const confirm = function() {
		confirmed = true
		state.candidates.delete(cancel)
		for (const other of [...state.candidates]) {
			other()
		}
		state.candidates.clear()
		state.following		= true
		state.lane_job_id	= lane_job_id
		state.pfile			= lane_job_id + '.json'
		paint_export(self)
	}

	const drop = function() {
		state.candidates.delete(cancel)
		cancel()
	}

	const cancel = self.job_followers.follow(lane_job_id, {
		on_frame : function(frame) {
			if (self.export_state!==state) {
				return
			}
			const data = frame && frame.data
			if (!data || typeof data.job_id!=='string' || typeof data.written!=='number') {
				return
			}
			if (!confirmed) {
				if (data.job_id!==expected_job_id || state.following) {
					// another export's lane job (or another candidate won)
					drop()
					return
				}
				confirm()
			}
			state.job_id	= data.job_id
			state.written	= data.written
			state.total		= typeof data.total==='number' ? data.total : state.total
			schedule_progress_paint(self)
			maybe_refresh_preview(self)
		},
		on_done : function(frame) {
			if (self.export_state!==state) {
				return
			}
			if (!confirmed) {
				state.candidates.delete(cancel)
				// ended before any progress frame: its terminal summary may
				// still name this export
				const summary = response_data(frame?.data)
				if (state.following || !summary || summary.job_id!==expected_job_id) {
					// not this export (or unknown): the preview poll decides
					return
				}
				confirm()
			}
			if (!state.following) {
				return
			}
			state.following = false
			finish_export_job(self, frame)
		}
	})

	if (!confirmed) {
		state.candidates.add(cancel)
	}
}//end follow_export_job



/**
 * FRAME_ERRORS
 * The failure lines of a job STATUS FRAME (src/core/media/jobs.ts
 * JobStatusFrame {pid, pfile, is_running, data, errors, total_time}) — the
 * lane worker's collected messages, not an envelope field.
 * @param {Object|null} frame
 * @returns {Array<string>}
 */
const frame_errors = function(frame) {

	const lines = frame ? frame.errors : null

	return Array.isArray(lines) ? lines.map(String) : []
}//end frame_errors



/**
 * JOB_FAILURE_TEXT
 * The user text for a lane job that ended without a result. The frame's
 * `errors` lines are the worker's RAW exception messages (English, possibly
 * a path or a SQL message) — they go to the console, never to the screen
 * (ERRORS_SPEC client contract). A typed frame error (envelope v2) renders
 * through error_text; anything else is the generic label.
 * @param {Object} self
 * @param {Object|null} frame
 * @param {Array<string>} errors - frame_errors(frame)
 * @param {string} label_key - tool label for the generic text
 * @param {string} fallback - English fallback of that label
 * @returns {string}
 */
const job_failure_text = function(self, frame, errors, label_key, fallback) {

	if (errors.length) {
		console.error('tool_export: job failed:', errors)
	}
	const api_error = normalize_stream_error(frame)
	if (api_error) {
		return error_text(api_error) + error_debug_suffix(api_error)
	}

	return self.get_tool_label(label_key) || fallback
}//end job_failure_text



/**
 * FINISH_EXPORT_JOB
 * The export's lane job ended (terminal frame, or null when the stream closed
 * without one). The manifest decides the outcome (list_export_jobs): ended →
 * load the final page (final column order) and enable the downloads;
 * cancelled / failed / interrupted → the reason, no downloads.
 * @param {Object} self
 * @param {Object|null} frame
 * @returns {Promise<void>}
 */
const finish_export_job = async function(self, frame) {

	const state = self.export_state

	// the artifact id from the terminal envelope when no progress frame had it
	if (!state.job_id) {
		const summary = response_data(frame?.data)
		if (summary && typeof summary.job_id==='string') {
			state.job_id = summary.job_id
		}
	}

	if (!state.job_id) {
		// No artifact id: the job ended before its first progress frame — a
		// refused gate, a quota, or a Stop (possibly while still queued in the
		// lane). A manifest may exist all the same (a stop between createJob
		// and the first checkpoint): find it by its lane job when the summary
		// names one; otherwise a Stop the server accepted is 'cancelled'.
		const {job, pending, failed} = await find_manifest_of_lane_job(self, state)
		if (self.export_state!==state) {
			return
		}
		if (failed && failed.code!=='client.aborted' && is_transient_failure(failed)) {
			// the list could not be read: never paint an outcome from nothing
			schedule_preview_poll(self)
			return
		}
		if (job) {
			state.job_id = job.job_id
			await sync_export_status(self)
			return
		}
		if (pending && !state.stop_requested) {
			// The stream closed while the job still WAITS in the lane (no
			// manifest yet): it is not over. The poll re-follows it.
			schedule_preview_poll(self)
			return
		}
		if (state.stop_requested) {
			state.status		= 'cancelled'
			state.error_code	= 'export.cancelled'
			state.pfile			= null
			paint_export(self)
			return
		}
		set_export_failed(self, null, job_failure_text(self, frame, frame_errors(frame), 'export_failed', 'The export failed'))
		return
	}

	await sync_export_status(self)
}//end finish_export_job



/**
 * FIND_MANIFEST_OF_LANE_JOB
 * The manifest summary written by this export's lane job, when the server's
 * summary names its lane job (background_job_id). Never a guess by position:
 * the newest manifest of the section may be another tab's export. `pending`
 * says the lane job is still submitted WITHOUT a manifest (queued behind the
 * lane — list_export_jobs `pending`).
 * @param {Object} self
 * @param {Object} state
 * @returns {Promise<{job: Object|null, pending: boolean, failed: Object|null}>}
 */
const find_manifest_of_lane_job = async function(self, state) {

	if (!state.lane_job_id) {
		return {job: null, pending: false, failed: null}
	}
	const api_response = await self.list_export_jobs({signal: self.export_abort.signal})
	if (request_failed(api_response)) {
		return {job: null, pending: false, failed: api_response.error}
	}
	const data		= response_data(api_response)
	const jobs		= data?.jobs || []
	const pending	= Array.isArray(data?.pending) ? data.pending : []

	return {
		job		: jobs.find(el => el && el.background_job_id===state.lane_job_id) || null,
		pending	: pending.some(el => el && el.background_job_id===state.lane_job_id),
		failed	: null
	}
}//end find_manifest_of_lane_job



/**
 * SYNC_EXPORT_STATUS
 * Read the export's manifest summary (list_export_jobs) into the state, paint
 * it, and load the current page when the export ended.
 * @param {Object} self
 * @returns {Promise<void>}
 */
const sync_export_status = async function(self) {

	const state = self.export_state

	const api_response = await self.list_export_jobs({signal: self.export_abort.signal})
	if (self.export_state!==state) {
		return
	}
	if (request_failed(api_response)) {
		if (api_response.error.code!=='client.aborted') {
			set_export_failed(self, api_response.error.code, error_text(api_response.error))
		}
		return
	}

	const jobs	= response_data(api_response)?.jobs || []
	const job	= jobs.find(el => el.job_id===state.job_id)
	if (!job) {
		set_export_failed(self, 'export.artifact_not_found', get_label.error_export_artifact_not_found || 'The export was not found or has expired')
		return
	}

	apply_job_summary(state, job)

	if (state.status==='ended' || state.status==='running') {
		paint_export(self)
		await load_preview(self, state.page)
		return
	}

	// stopped / failed / interrupted: the spool is gone — so is the page
	state.preview = null
	self.export_ui?.export_data_container.replaceChildren()
	paint_export(self)
}//end sync_export_status



/**
 * APPLY_JOB_SUMMARY
 * One list_export_jobs entry into the state.
 * @param {Object} state
 * @param {Object} job - {job_id, status, total, records, error, …}
 * @returns {void}
 */
const apply_job_summary = function(state, job) {

	state.job_id		= job.job_id
	state.status		= job.status
	state.total			= typeof job.total==='number' ? job.total : state.total
	state.written		= typeof job.records==='number' ? job.records : state.written
	state.error_code	= job.error?.code || null
	state.error			= job.error || null
	state.narrowed		= job.narrowed===true
	state.external_degraded	= degraded_summary(job.external_degraded)
	// a transient page failure is not the export's outcome
	state.error_text	= null
	if (state.status!=='running') {
		state.pfile = null
	}
}//end apply_job_summary



/**
 * SET_EXPORT_FAILED
 * Terminal failure of the current export view, with its reason.
 * @param {Object} self
 * @param {string|null} code
 * @param {string} text
 * @returns {void}
 */
const set_export_failed = function(self, code, text) {

	const state = self.export_state
	if (!state) {
		return
	}
	state.status		= 'failed'
	state.error_code	= code
	state.error_text	= text
	state.pfile			= null
	paint_export(self)
}//end set_export_failed



/**
 * STOP_EXPORT
 * Stop the running export through dd_utils_api::stop_process. The server
 * aborts at the next batch boundary and deletes the partial spool; the job
 * stream then ends and finish_export_job paints 'cancelled'.
 * @param {Object} self
 * @returns {Promise<void>}
 */
const stop_export = async function(self) {

	const state = self.export_state
	if (!state || !state.pfile || state.status!=='running') {
		return
	}

	self.export_ui.button_stop.classList.add('loading')
	const api_response = await self.stop_export_process(state.pfile)
	self.export_ui.button_stop.classList.remove('loading')

	if (request_failed(api_response)) {
		// most likely the job ended meanwhile: the manifest has the truth
		if (self.export_state===state && state.job_id) {
			await sync_export_status(self)
		}
		return
	}
	state.stop_requested = true
	if (!state.following && self.export_state===state) {
		// no stream to report the end: ask
		export_timeout(self, () => sync_export_status(self), PREVIEW_REFRESH_MS)
	}
}//end stop_export



/**
 * CAN_DELETE_EXPORT
 * Whether the shown export is one the owner may delete now: a server job
 * (job_id known) that no longer runs, and that the server still has.
 * @param {Object|null} state
 * @returns {boolean}
 */
const can_delete_export = function(state) {

	return !!state
		&& !!state.job_id
		&& ['ended','failed','cancelled','interrupted'].includes(state.status)
		&& state.error_code!=='export.artifact_not_found'
}//end can_delete_export



/**
 * DELETE_EXPORT
 * Delete the shown export (delete_export_job) after the user confirms. On
 * success the view is emptied (the files are gone; the download URLs of this
 * export now answer 404). A refusal is shown in the download status line —
 * export.artifact_busy (a file is being built from it) — and the manifest is
 * re-read; export.artifact_not_found means it is already gone.
 * @param {Object} self
 * @returns {Promise<boolean>} true when the export was deleted
 */
const delete_export = async function(self) {

	const state = self.export_state
	if (!can_delete_export(state)) {
		return false
	}

	const message = self.get_tool_label('delete_export_confirm')
		|| 'Delete this export and all its files from the server? This cannot be undone.'
	if (!window.confirm(message)) {
		return false
	}

	const button = self.export_ui.button_delete
	button.classList.add('loading')
	const api_response = await self.delete_export_job(state.job_id)
	button.classList.remove('loading')

	// superseded (a new Export or a destroy) while deleting
	if (self.export_state!==state) {
		return false
	}

	if (request_failed(api_response) && api_response.error.code!=='export.artifact_not_found') {
		self.export_ui.download_status.textContent = error_text(api_response.error)
		await sync_export_status(self)
		return false
	}

	// gone: release this export's runtime and empty the view
	self.reset_export_runtime()
	self.export_state = null
	self.export_ui.export_data_container.replaceChildren()
	paint_export(self)
	self.export_ui.response_container.textContent = self.get_tool_label('export_deleted') || 'Export deleted'

	return true
}//end delete_export



/**
 * RECONNECT_EXPORT
 * On open: restore the caller's latest export of this section. A running one
 * is polled until the job leaves 'running'; its possible lane jobs
 * (get_background_jobs, reconnect_candidates) are followed as candidates, and
 * the one whose first progress frame names this export takes over (and only
 * then arms Stop). An ended one shows its first page
 * with the downloads enabled; a stopped / failed / interrupted one shows why.
 * @param {Object} self
 * @returns {Promise<void>}
 */
const reconnect_export = async function(self) {

	const signal = self.export_abort.signal

	const api_response = await self.list_export_jobs({signal})
	if (request_failed(api_response) || signal.aborted || self.export_state!==null) {
		// nothing to restore, or an Export click already superseded the reconnect
		return
	}
	const data	= response_data(api_response)
	const job	= (data?.jobs || [])[0]
	// A QUEUED export has no manifest yet (it is written when the walk starts):
	// the server lists it as `pending`, by its lane job — follow THAT, never
	// paint an older manifest as the current export.
	const queued = current_pending_export(data?.pending, job)
	if (queued) {
		follow_pending_export(self, queued)
		return
	}
	if (!job) {
		return
	}

	const state = new_export_state()
	apply_job_summary(state, job)
	self.export_state = state
	paint_export(self)

	if (state.status==='running') {
		const lane_response = await self.get_background_jobs('build_export_artifact', {signal})
		if (self.export_state!==state) {
			return
		}
		const lane_jobs	= request_failed(lane_response) ? [] : (response_data(lane_response) || [])
		// Candidates only: which artifact a lane job writes is proven by its
		// first progress frame (follow_export_job), never assumed — the list
		// holds every export of this user (a global admin: of every user), in
		// any section, queued ones included. An exact background_job_id on the
		// summary settles it; otherwise a lane job scheduled AFTER this
		// export's manifest was created cannot be its writer.
		for (const lane_job of reconnect_candidates(lane_jobs, job)) {
			follow_export_job(self, lane_job.id, state.job_id)
		}
		paint_export(self)
	}

	if (state.status==='ended' || state.status==='running') {
		await load_preview(self, 0)
	}
}//end reconnect_export



/**
 * CURRENT_PENDING_EXPORT
 * The submitted export without a manifest (list_export_jobs `pending`, newest
 * first) that is the CURRENT one on reconnect: the newest pending walk, unless
 * the newest manifest is a running export submitted after it.
 * @param {Array|undefined} pending - [{background_job_id, submitted_at}]
 * @param {Object|undefined} job - the newest manifest summary
 * @returns {Object|null}
 */
const current_pending_export = function(pending, job) {

	const newest = Array.isArray(pending)
		? pending.find(el => el && typeof el.background_job_id==='string' && el.background_job_id.length)
		: null
	if (!newest) {
		return null
	}
	if (!job || job.status!=='running') {
		return newest
	}
	const created_at = Date.parse(job.created_at)

	return (!Number.isFinite(created_at) || !(newest.submitted_at < created_at)) ? newest : null
}//end current_pending_export



/**
 * FOLLOW_PENDING_EXPORT
 * Make a queued export (a pending lane job) the current one: the same state
 * run_export leaves after an accepted submit — its lane job followed, Stop
 * armed from its pfile, the artifact id taken from its first progress frame.
 * @param {Object} self
 * @param {Object} pending - {background_job_id, submitted_at}
 * @returns {void}
 */
const follow_pending_export = function(self, pending) {

	const lane_job_id	= pending.background_job_id
	const state			= new_export_state({
		lane_job_id	: lane_job_id,
		pfile		: lane_job_id + '.json',
		status		: 'running'
	})
	self.export_state = state
	paint_export(self)
	follow_export_job(self, lane_job_id, null)
}//end follow_pending_export



/**
 * RECONNECT_CANDIDATES
 * The running lane jobs that may be writing `job` (a list_export_jobs entry),
 * newest first, at most RECONNECT_MAX_CANDIDATES (each follow holds one HTTP
 * connection).
 * @param {Array} lane_jobs - get_background_jobs rows {id, status, started_at}
 * @param {Object} job - {job_id, created_at, background_job_id?}
 * @returns {Array}
 */
const reconnect_candidates = function(lane_jobs, job) {

	if (!Array.isArray(lane_jobs)) {
		return []
	}
	const running = lane_jobs.filter(el => el && el.status==='running' && typeof el.id==='string')
	if (typeof job.background_job_id==='string' && job.background_job_id.length) {
		return running.filter(el => el.id===job.background_job_id)
	}
	const created_at = Date.parse(job.created_at)
	const possible = Number.isFinite(created_at)
		? running.filter(el => typeof el.started_at!=='number' || el.started_at <= created_at)
		: running

	return possible.slice(0, RECONNECT_MAX_CANDIDATES)
}//end reconnect_candidates



/**
 * LOAD_PREVIEW
 * Ask for one page and render it (REPLACING the previous page). Stale answers
 * (an older request finishing after a newer one) are dropped by sequence.
 * While the export runs and no job stream is followed, the next poll is
 * scheduled from here, so polling stops by itself when the job leaves 'running'.
 * @param {Object} self
 * @param {number} page - 0-based page, in records
 * @returns {Promise<void>}
 */
const load_preview = async function(self, page) {

	const state = self.export_state
	if (!state || !state.job_id) {
		return
	}

	const seq = ++state.preview_seq
	state.preview_loading	= true
	state.preview_at		= Date.now()
	self.export_ui.pager.node.classList.add('loading')

	const api_response = await self.get_export_preview({
		job_id		: state.job_id,
		page		: page,
		page_size	: state.page_size,
		col_page	: state.col_page,
		signal		: self.export_abort.signal
	})

	if (self.export_state!==state || seq!==state.preview_seq) {
		return
	}
	state.preview_loading = false
	self.export_ui.pager.node.classList.remove('loading')

	if (request_failed(api_response)) {
		if (api_response.error.code==='client.aborted') {
			return
		}
		state.error_text = error_text(api_response.error)
		paint_export(self)
		if (state.status==='running' && !state.following) {
			// the poll is the only thing that wakes this view: a failed page
			// must not end it. A transient failure (network, 5xx) retries; a
			// definitive one lets the manifest decide the outcome.
			if (is_transient_failure(api_response.error)) {
				schedule_preview_poll(self)
			}else{
				sync_export_status(self)
			}
		}
		return
	}

	const preview = response_data(api_response)
	if (!preview) {
		return
	}
	state.error_text	= null
	state.preview		= preview
	state.page		= preview.page
	state.page_size	= preview.page_size
	state.col_page	= Number.isInteger(preview.col_page) ? preview.col_page : 0
	state.written	= Math.max(state.written, preview.written_records || 0)
	state.total		= typeof preview.total_records==='number' ? preview.total_records : state.total
	if (preview.external_degraded!==undefined) {
		// LIVE while the export runs (the manifest's, at each checkpoint)
		state.external_degraded = degraded_summary(preview.external_degraded)
	}
	const was_running = state.status==='running'
	if (preview.status && preview.status!=='running' && was_running) {
		// the job left 'running' between two frames: the manifest decides
		state.status = preview.status
		if (!state.following) {
			sync_export_status(self)
		}
	}

	// The fallback poll asks for the SAME page every PREVIEW_POLL_MS while the
	// export runs; once that page is full its rows can no longer change (only
	// the column order, at the end). Redrawing up to 1,000 rows x 100 columns
	// (thumbnails included) every 2 s for an unchanged page is pure waste: an
	// answer with the same shape as the page on screen only repaints the
	// progress line.
	const drawn_key = preview_draw_key(preview)
	if (drawn_key!==state.drawn_key || !page_is_full(state)) {
		state.drawn_key = drawn_key
		render_preview_table(self)
	}
	paint_export(self)

	if (state.status==='running' && !state.following) {
		schedule_preview_poll(self)
	}
}//end load_preview



/**
 * PREVIEW_DRAW_KEY
 * What decides whether a loaded page looks different from the one drawn: its
 * position (page, column window), its size (records, rows, elisions) and
 * whether the column order is final. A full page of a running export with the
 * same key is the same table.
 * @param {Object} preview - get_export_preview data
 * @returns {string}
 */
const preview_draw_key = function(preview) {

	return JSON.stringify([
		preview.page,
		preview.page_size,
		preview.first_record,
		preview.records,
		Array.isArray(preview.rows) ? preview.rows.length : 0,
		Array.isArray(preview.elided) ? preview.elided.length : 0,
		preview.col_page,
		preview.first_col,
		preview.total_cols,
		preview.final_order===true,
		preview.status
	])
}//end preview_draw_key



/**
 * RENDER_PREVIEW_TABLE
 * Draw the last loaded page (also on a show_tipo_in_label change).
 * @param {Object} self
 * @returns {void}
 */
const render_preview_table = function(self) {

	const state		= self.export_state
	const container	= self.export_ui?.export_data_container
	if (!state || !state.preview || !container) {
		return
	}

	const table = new flat_table({
		show_tipo_in_label : self.export_ui.show_tipo_in_label_check.checked
	})
	const column_pager = render_column_pager(self, state.preview)
	container.replaceChildren(
		...(column_pager ? [column_pager] : []),
		table.render_page(state.preview)
	)
}//end render_preview_table



/**
 * RENDER_COLUMN_PAGER
 * A wide export is served one WINDOW of columns per page (preview col_page,
 * server PREVIEW_COLUMN_BUDGET): 'Columns 101–200 of 4,000' with previous /
 * next. Nothing when every column fits one window.
 * @param {Object} self
 * @param {Object} preview - get_export_preview data
 * @returns {HTMLElement|null}
 */
const render_column_pager = function(self, preview) {

	const total	= Number(preview.total_cols) || 0
	const size	= Number(preview.col_page_size) || 0
	const count	= Array.isArray(preview.cols) ? preview.cols.length : 0
	if (!size || total <= size) {
		return null
	}
	const first		= Number(preview.first_col) || 0
	const col_page	= Number(preview.col_page) || 0
	const last_page	= Math.ceil(total / size) - 1

	const node = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'export_column_pager no_print'
	})
	const go = (target) => {
		const state = self.export_state
		if (!state || !state.job_id || target<0 || target>last_page) {
			return
		}
		state.col_page = target
		load_preview(self, state.page)
	}
	const prev = ui.create_dom_element({
		element_type	: 'button',
		class_name		: 'light pager_button column_prev',
		text_content	: '‹',
		title			: get_label.previous || 'Previous',
		parent			: node
	})
	prev.disabled = col_page<=0
	prev.addEventListener('click', (e) => { e.stopPropagation(); go(col_page - 1) })
	ui.create_dom_element({
		element_type	: 'span',
		class_name		: 'column_range',
		text_content	: (get_label.columns || 'Columns') + ' '
			+ format_number(first + 1) + '–' + format_number(first + count) + ' '
			+ (get_label.of || 'of') + ' ' + format_number(total),
		parent			: node
	})
	const next = ui.create_dom_element({
		element_type	: 'button',
		class_name		: 'light pager_button column_next',
		text_content	: '›',
		title			: get_label.next || 'Next',
		parent			: node
	})
	next.disabled = col_page>=last_page
	next.addEventListener('click', (e) => { e.stopPropagation(); go(col_page + 1) })

	return node
}//end render_column_pager



/**
 * PAGE_IS_FULL
 * Whether the loaded page already holds page_size records (its content can no
 * longer change while the job runs, only the column order at the end).
 * @param {Object} state
 * @returns {boolean}
 */
const page_is_full = function(state) {

	return !!(state.preview && state.preview.records >= state.preview.page_size)
}//end page_is_full



/**
 * MAYBE_REFRESH_PREVIEW
 * A progress frame arrived: refresh the current page when it is not full yet,
 * at most once per PREVIEW_REFRESH_MS (one pending timer at a time).
 * @param {Object} self
 * @returns {void}
 */
const maybe_refresh_preview = function(self) {

	const state = self.export_state
	if (!state || !state.job_id || state.status!=='running') {
		return
	}
	if (state.preview && page_is_full(state)) {
		return
	}
	if (state.preview_pending || state.preview_loading) {
		return
	}
	const wait = Math.max(0, PREVIEW_REFRESH_MS - (Date.now() - state.preview_at))
	state.preview_pending = true
	export_timeout(self, () => {
		state.preview_pending = false
		if (self.export_state===state && state.status==='running') {
			load_preview(self, state.page)
		}
	}, wait)
}//end maybe_refresh_preview



/**
 * SCHEDULE_PREVIEW_POLL
 * No job stream to wake the view (a reconnect whose lane job was not found):
 * ask for the page again after PREVIEW_POLL_MS; load_preview reschedules only
 * while the export is still 'running'.
 * @param {Object} self
 * @returns {void}
 */
const schedule_preview_poll = function(self) {

	const state = self.export_state
	if (!state || state.preview_pending) {
		return
	}
	state.preview_pending = true
	export_timeout(self, () => {
		state.preview_pending = false
		if (self.export_state!==state) {
			return
		}
		if (state.job_id) {
			load_preview(self, state.page)
		}else{
			// accepted but no artifact id known yet: the manifest list knows it
			reconnect_poll(self, state)
		}
	}, PREVIEW_POLL_MS)
}//end schedule_preview_poll



/**
 * IS_TRANSIENT_FAILURE
 * Whether the same request may succeed later unchanged (network, timeout,
 * 5xx) — the poll retries those and stops on anything definitive.
 * @param {Object} api_error - ApiError
 * @returns {boolean}
 */
const is_transient_failure = function(api_error) {

	if (!api_error) {
		return false
	}

	return api_error.retryable===true
		|| api_error.transport===true
		|| (typeof api_error.status==='number' && api_error.status>=500)
}//end is_transient_failure



/**
 * RECONNECT_POLL
 * Find the artifact of an accepted export whose job stream could not be
 * followed: the newest export of this section.
 * @param {Object} self
 * @param {Object} state
 * @returns {Promise<void>}
 */
const reconnect_poll = async function(self, state) {

	if (state.lane_job_id) {
		// The lane job is known: its manifest is found BY it, never by position
		// (the newest manifest may be an older or another tab's export).
		const {job, pending, failed} = await find_manifest_of_lane_job(self, state)
		if (self.export_state!==state) {
			return
		}
		if (failed) {
			if (failed.code!=='client.aborted' && is_transient_failure(failed)) {
				schedule_preview_poll(self)
			}
			return
		}
		if (job) {
			state.job_id = job.job_id
			await sync_export_status(self)
			return
		}
		if (pending) {
			// still queued: follow it again (Stop stays armed by its pfile)
			if (!state.following) {
				follow_export_job(self, state.lane_job_id, null)
			}
			return
		}
		// neither written nor waiting: the job ended before its walk began
		if (state.stop_requested) {
			state.status		= 'cancelled'
			state.error_code	= 'export.cancelled'
			state.pfile			= null
			paint_export(self)
			return
		}
		set_export_failed(self, null, self.get_tool_label('export_failed') || 'The export failed')
		return
	}

	const api_response = await self.list_export_jobs({signal: self.export_abort.signal})
	if (self.export_state!==state) {
		return
	}
	if (request_failed(api_response)) {
		// keep polling through a transient failure: nothing else wakes the view
		if (api_response.error.code!=='client.aborted' && is_transient_failure(api_response.error)) {
			schedule_preview_poll(self)
		}
		return
	}
	const job = (response_data(api_response)?.jobs || [])[0]
	if (job) {
		apply_job_summary(state, job)
		paint_export(self)
		if (state.status==='ended' || state.status==='running') {
			await load_preview(self, 0)
			return
		}
	}
	if (state.status==='running') {
		schedule_preview_poll(self)
	}
}//end reconnect_poll



/**
 * SCHEDULE_PROGRESS_PAINT
 * Progress frames can come fast: paint at most once per animation frame.
 * @param {Object} self
 * @returns {void}
 */
const schedule_progress_paint = function(self) {

	if (self.export_raf) {
		return
	}
	self.export_raf = requestAnimationFrame(() => {
		self.export_raf = null
		paint_export(self)
	})
}//end schedule_progress_paint



/**
 * STATUS_TEXT
 * The export status line for the current state.
 * @param {Object} self
 * @param {Object} state
 * @returns {string}
 */
const status_text = function(self, state) {

	const written	= format_number(state.written)
	const total		= state.total===null ? '?' : format_number(state.total)

	switch (state.status) {
		case 'starting':
			return (self.get_tool_label('export_starting') || 'Starting export') + '…'
		case 'running': {
			const line = (self.get_tool_label('export_running') || 'Exporting') + ' ' + written + ' / ' + total
				+ external_suffix(self, state)
			// a failed page request while running (the poll retries it)
			return state.error_text ? line + ' — ' + state.error_text : line
		}
		case 'ended': {
			const line = (self.get_tool_label('export_ended') || 'Export finished') + ': ' + written
			// narrowed by the user's own access: one notice, no coordinates (the
			// same perm.out_of_scope label the request envelope's notice renders)
			return (state.narrowed
				? line + ' — ' + (get_label.error_perm_out_of_scope || 'Some records are outside your scope')
				: line) + external_suffix(self, state)
		}
		case 'cancelled':
			return get_label.error_export_cancelled || 'The export was stopped before it finished'
		case 'interrupted':
			return self.get_tool_label('export_interrupted')
				|| 'The export was interrupted by a server restart. Run it again.'
		case 'failed':
		default: {
			if (state.error_text) {
				return state.error_text
			}
			return failed_text(self, state)
		}
	}
}//end status_text



/**
 * DEGRADED_SUMMARY
 * The wire's `external_degraded` as the state keeps it: the object when it
 * names at least one degraded cell, else null.
 * @param {Object|null|undefined} value
 * @returns {Object|null}
 */
const degraded_summary = function(value) {

	return value && typeof value==='object' && Number(value.cells) > 0
		? value
		: null
}//end degraded_summary



/**
 * EXTERNAL_SUFFIX
 * The status line's external-source warning (' — …'), or ''. Each kind of
 * degraded cell is said for what it is, counted from the exact per-(service,
 * state) `counts`:
 * - MISSING (the source could not be read: the value is not in the files) —
 *   the cells, the records (`missing_cells` / `missing_records`), the services,
 *   and what to do: run it again once the source is back (retryable) or ask the
 *   administrator (disabled / misconfigured);
 * - TRUNCATED (the export's size limits cut a value: part of it IS in the
 *   files) — said alone, with no advice: neither a re-run nor an administrator
 *   changes it;
 * - STALE (the last saved copy was used: the value IS in the files) — a softer
 *   note.
 * Labels come from register.json; {cells} {records} {services} are filled here.
 * @param {Object} self
 * @param {Object} state
 * @returns {string}
 */
const external_suffix = function(self, state) {

	const degraded = state.external_degraded
	if (!degraded) {
		return ''
	}
	const counts = Array.isArray(degraded.counts) ? degraded.counts : []
	const group = (states) => {
		const items = counts.filter(item => states.includes(item.state))
		return {
			cells		: items.reduce((sum, item) => sum + (Number(item.cells) || 0), 0),
			services	: [...new Set(items.map(item => item.service))].join(', ')
		}
	}
	const missing	= group(['unavailable','timeout','circuit_open','disabled','misconfigured'])
	const truncated	= group(['truncated'])
	const stale		= group(['stale'])
	// the server's own missing counts (a manifest written before they existed
	// has none: the per-state sum, and every degraded record)
	const missing_cells		= typeof degraded.missing_cells==='number' ? degraded.missing_cells : missing.cells
	const missing_records	= typeof degraded.missing_records==='number' ? degraded.missing_records : degraded.records
	const fill = (label, cells, records, services) => label
		.replace('{cells}', format_number(cells))
		.replace('{records}', format_number(records))
		.replace('{services}', services)

	const parts = []
	if (missing_cells > 0) {
		parts.push(fill(self.get_tool_label('export_external_incomplete')
			|| 'Incomplete: {cells} values from external sources ({services}) could not be read, in {records} records.',
			missing_cells, missing_records, missing.services))
		parts.push(degraded.retryable
			? (self.get_tool_label('export_external_rerun_advice') || 'Run the export again once the source is available.')
			: (self.get_tool_label('export_external_admin_advice') || 'The external source is disabled or misconfigured: contact the administrator.'))
	}
	if (truncated.cells > 0) {
		parts.push(fill(self.get_tool_label('export_external_truncated')
			|| 'Incomplete: {cells} values from external sources ({services}) were cut to the export\'s size limits.',
			truncated.cells, 0, truncated.services))
	}
	if (stale.cells > 0) {
		parts.push(fill(self.get_tool_label('export_external_stale')
			|| '{cells} values from external sources ({services}) come from a saved copy and may be out of date.',
			stale.cells, 0, stale.services))
	}

	return parts.length ? ' — ' + parts.join(' ') : ''
}//end external_suffix



/**
 * FAILED_TEXT
 * The reason of a failed export from its manifest error. The registry's
 * label_key (with its details) renders through error_text when the summary
 * carries it. A bare {code} falls back to the label of the same spelling
 * ONLY when it needs no {placeholder} (unfilled, it would leak the template)
 * — else the generic text; the code itself rides only in the debug suffix.
 * @param {Object} self
 * @param {Object} state
 * @returns {string}
 */
const failed_text = function(self, state) {

	const generic	= self.get_tool_label('export_failed') || 'The export failed'
	const error		= state.error && typeof state.error==='object'
		? state.error
		: (state.error_code ? {code: state.error_code} : null)
	if (!error || typeof error.code!=='string') {
		return generic
	}
	if (typeof error.label_key==='string' && error.label_key.length) {
		return error_text(error) + error_debug_suffix(error)
	}
	const label = get_label['error_' + error.code.replace(/\./g, '_')]
	if (typeof label==='string' && label.length && !/\{[a-z_]+\}/i.test(label)) {
		return label
	}

	return generic + error_debug_suffix(error)
}//end failed_text



/**
 * PAINT_EXPORT
 * Paint every export-dependent node from the state: status line, progress
 * bar, Export / Stop, download buttons (enabled ONLY when 'ended'), pager.
 * @param {Object} self
 * @returns {void}
 */
const paint_export = function(self) {

	const ui_refs	= self.export_ui
	const state		= self.export_state
	if (!ui_refs) {
		return
	}

	const running	= !!state && (state.status==='running' || state.status==='starting')
	const ended		= !!state && state.status==='ended'

	// status line
		const response_container = ui_refs.response_container
		response_container.textContent = state ? status_text(self, state) : ''
		response_container.classList.toggle('error', !!state && ['failed','cancelled','interrupted'].includes(state.status))
		const incomplete = !!state && !!state.external_degraded && state.external_degraded.incomplete===true
		response_container.classList.toggle('external_incomplete', incomplete && (running || ended))

	// progress bar
		const progress = self.progress_ui
		if (progress) {
			progress.container.classList.toggle('no_visible', !running)
			const percent = (state && state.total)
				? Math.min(100, Math.round((state.written / state.total) * 100))
				: 0
			const text = state ? (format_number(state.written) + ' / ' + (state.total===null ? '?' : format_number(state.total))) : ''
			progress.bar.style.width			= percent + '%'
			progress.text_bg.textContent		= text
			progress.text_fg.textContent		= text
			progress.text_fg.style.clipPath		= `inset(0 ${100 - percent}% 0 0)`
		}

	// Export / Stop. A second export while this tool can stop the first is
	// refused here (Stop first); a reconnected export it cannot stop does not
	// block a new one (the server's per-user cap still applies).
		const can_stop = running && !!state.pfile
		ui_refs.button_stop.classList.toggle('hide', !can_stop)
		ui_refs.button_export.disabled = can_stop || (!!state && state.status==='starting')
		ui_refs.button_delete.classList.toggle('hide', !can_delete_export(state))
		ui_refs.button_rerun.classList.toggle('hide', !(ended && incomplete && state.external_degraded.retryable===true))

	// downloads
		const media_models = ended ? get_media_models_in_data(self) : []
		self.media_components_in_data = media_models
		// an export made before related media were recorded, with a column
		// that may hold some: the ZIP is still offered, and its info.txt lists
		// those columns as rerun_required (the reason is never hidden behind a
		// disabled button)
		const media_rerun_required = ended && state?.preview?.media_rerun_required===true
		for (const [format, button] of ui_refs.download_buttons) {
			// a button whose file is being built stays busy
			button.disabled = !ended
				|| (format==='media_zip' && !media_models.length && !media_rerun_required)
				|| button.classList.contains('loading')
		}
		// the files stay downloadable, and say they are incomplete
		ui_refs.download_incomplete_note.classList.toggle('hide', !(ended && incomplete))
		ui_refs.button_print.disabled = !(state && state.preview)
		if (!ended) {
			ui_refs.download_status.textContent = ''
		}

	// pager
		paint_pager(self)
}//end paint_export



/**
 * RENDER_PAGER
 * The preview pager: first / previous / next / last, the range and progress
 * readouts and the page-size select.
 * @param {Object} self
 * @param {DocumentFragment|HTMLElement} parent
 * @returns {Object} {node, first, prev, next, last, range, progress, select}
 */
const render_pager = function(self, parent) {

	const node = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'export_pager no_print hide',
		parent			: parent
	})

	const make_button = (class_name, text, title, handler) => {
		const button = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'light pager_button ' + class_name,
			text_content	: text,
			title			: title,
			parent			: node
		})
		button.disabled = true
		button.addEventListener('click', (e) => {
			e.stopPropagation()
			handler()
		})
		return button
	}

	const go = (page) => {
		const state = self.export_state
		if (!state || !state.job_id) {
			return
		}
		load_preview(self, Math.max(0, page))
	}

	const first = make_button('pager_first', '«', self.get_tool_label('first_page') || 'First page', () => go(0))
	const prev = make_button('pager_prev', '‹', get_label.previous || 'Previous', () => go((self.export_state?.page || 0) - 1))
	const range = ui.create_dom_element({
		element_type	: 'span',
		class_name		: 'pager_range',
		parent			: node
	})
	const next = make_button('pager_next', '›', get_label.next || 'Next', () => go((self.export_state?.page || 0) + 1))
	const last = make_button('pager_last', '»', self.get_tool_label('last_page') || 'Last page', () => go(last_page_index(self.export_state)))

	const progress = ui.create_dom_element({
		element_type	: 'span',
		class_name		: 'pager_progress',
		parent			: node
	})

	// page size
		const size_label = ui.create_dom_element({
			element_type	: 'label',
			class_name		: 'pager_size',
			text_content	: (self.get_tool_label('records_per_page') || 'Records per page') + ' ',
			parent			: node
		})
		const select = ui.create_dom_element({
			element_type	: 'select',
			class_name		: 'pager_size_select',
			parent			: size_label
		})
		for (const size of PAGE_SIZE_OPTIONS) {
			ui.create_dom_element({
				element_type	: 'option',
				value			: String(size),
				text_content	: String(size),
				parent			: select
			})
		}
		select.addEventListener('change', () => {
			const size = Number(select.value)
			if (!PAGE_SIZE_OPTIONS.includes(size)) {
				return
			}
			storage_set(PAGE_SIZE_STORAGE_KEY, String(size))
			const state = self.export_state
			if (!state) {
				return
			}
			// keep the first visible record on screen
			const first_record = state.preview ? state.preview.first_record : 0
			state.page_size = size
			if (state.job_id) {
				load_preview(self, Math.floor(first_record / size))
			}
		})

	return {node, first, prev, next, last, range, progress, select}
}//end render_pager



/**
 * KNOWN_RECORDS
 * Records the pager can reach: the total once ended, what is written so far
 * while the job runs.
 * @param {Object} state
 * @returns {number}
 */
const known_records = function(state) {

	if (!state) {
		return 0
	}
	if (state.status==='ended') {
		return state.total ?? state.written
	}
	return state.written
}//end known_records



/**
 * LAST_PAGE_INDEX
 * @param {Object} state
 * @returns {number} 0-based index of the last reachable page
 */
const last_page_index = function(state) {

	const size = state?.page_size || state?.preview?.page_size || 1

	return Math.max(0, Math.ceil(known_records(state) / size) - 1)
}//end last_page_index



/**
 * PAINT_PAGER
 * Range "a–b of N", progress "written / total", button states, page size.
 * @param {Object} self
 * @returns {void}
 */
const paint_pager = function(self) {

	const pager = self.export_ui?.pager
	const state = self.export_state
	if (!pager) {
		return
	}

	const preview = state?.preview || null
	pager.node.classList.toggle('hide', !preview)
	if (!preview) {
		return
	}

	const last		= last_page_index(state)
	const page		= preview.page
	const records	= known_records(state)

	pager.first.disabled	= page<=0
	pager.prev.disabled		= page<=0
	pager.next.disabled		= !(preview.has_more || page < last)
	pager.last.disabled		= page >= last

	const from	= preview.records ? preview.first_record + 1 : 0
	const to	= preview.first_record + preview.records
	pager.range.textContent = format_number(from) + '–' + format_number(to)
		+ ' ' + (get_label.of || 'of') + ' '
		+ format_number(state.status==='ended' ? records : (state.total ?? records))
		+ ' ' + (self.get_tool_label('records') || 'records')

	pager.progress.textContent = state.status==='running'
		? '(' + format_number(state.written) + ' / ' + (state.total===null ? '?' : format_number(state.total)) + ')'
		: ''

	// the select shows the size the server actually served (its default when
	// nothing is remembered)
	const size = String(preview.page_size)
	if (![...pager.select.options].some(option => option.value===size)) {
		ui.create_dom_element({
			element_type	: 'option',
			value			: size,
			text_content	: size,
			parent			: pager.select
		})
	}
	pager.select.value = size
}//end paint_pager



/**
 * DOWNLOAD_FORMAT
 * One file build at a time per tool view: the server admits one running
 * build_export_file per user by default (export_job.ts exportFileLaneShare),
 * so a second click while a file is being prepared is QUEUED here — its
 * button shows as busy with a "waiting" status — and submitted when the
 * previous build settles, instead of being refused with export.too_many_jobs.
 * A queued click whose export was replaced meanwhile (a new Export, a destroy)
 * is dropped.
 * @param {Object} self
 * @param {string} format
 * @param {HTMLElement|null} button
 * @param {Object} [extra]
 * @returns {Promise<boolean>}
 */
const download_format = function(self, format, button, extra={}) {

	const state		= self.export_state
	const previous	= self.export_file_chain || null
	if (previous && button) {
		button.classList.add('loading')
		button.disabled = true
		const status_node = self.export_ui.download_status
		status_node.classList.remove('error')
		status_node.textContent = (self.get_tool_label('waiting_file') || 'Waiting for the file being prepared') + ' (' + format.toUpperCase() + ')…'
	}
	const run = async () => {
		if (self.export_state!==state) {
			if (button) {
				button.classList.remove('loading')
				button.disabled = false
			}
			return false
		}
		return download_format_now(self, format, button, extra)
	}
	const current = previous ? previous.then(run, run) : run()
	const chained = current.catch(() => false)
	self.export_file_chain = chained
	chained.then(() => {
		if (self.export_file_chain===chained) {
			self.export_file_chain = null
		}
	})
	return current
}//end download_format



/**
 * DOWNLOAD_FORMAT_NOW
 * Ask the server for one file of the ENDED export (build_export_file, a
 * background job), follow it, then hand the browser the owner-only download
 * URL through a hidden <a download> — no Blob, no data: URL, no DOM copy.
 * A file already built for the same options in this view is not asked for
 * again; one built before (a reopened tool, another tab) is answered by the
 * server as already built (writers/index.ts buildArtifactFile, BUILT ONCE) —
 * the file name, not this cache, is the key. EXCEPT the media ZIP: its bytes
 * depend on the records' stored media and the files on disk NOW (derivatives
 * finished, a file replaced), so every press asks the server, which rebuilds it.
 * @param {Object} self
 * @param {string} format - csv | tsv | ods | xlsx | html | ndjson | media_zip
 * @param {HTMLElement|null} button - the clicked button (spinner)
 * @param {Object} [extra] - {media_qualities: {model: quality}}
 * @returns {Promise<boolean>} true when the download was handed to the browser
 */
const download_format_now = async function(self, format, button, extra={}) {

	const state = self.export_state
	if (!state || state.status!=='ended' || !state.job_id) {
		return false
	}

	const show_tipo_in_label = self.export_ui.show_tipo_in_label_check.checked
	const file_options = {
		job_id				: state.job_id,
		format				: format,
		show_tipo_in_label	: show_tipo_in_label,
		media_qualities		: extra.media_qualities || null
	}
	const key = JSON.stringify([format, show_tipo_in_label, extra.media_qualities || null])

	const cached = format==='media_zip' ? null : state.files.get(key)
	if (cached) {
		trigger_download(self, cached)
		return true
	}

	const status_node = self.export_ui.download_status
	const set_busy = (busy) => {
		if (button) {
			button.classList.toggle('loading', busy)
			button.disabled = busy
		}
	}
	set_busy(true)
	status_node.classList.remove('error')
	status_node.textContent = (self.get_tool_label('preparing_file') || 'Preparing file') + ' ' + format.toUpperCase() + '…'

	const api_response = await self.start_export_file(file_options)
	if (self.export_state!==state) {
		// superseded (a new Export, a destroy) while submitting: the button is
		// reused by the next export, so it must not stay busy
		set_busy(false)
		return false
	}
	if (request_failed(api_response)) {
		set_busy(false)
		status_node.classList.add('error')
		status_node.textContent = error_text(api_response.error)
		return false
	}

	const lane_job_id = response_extension(api_response, 'job_id')
	if (!lane_job_id) {
		set_busy(false)
		status_node.textContent = ''
		return false
	}

	return new Promise((resolve) => {
		// settle: exactly once, from on_done OR from a runtime reset (which
		// cancels the follow, so on_done never comes)
		let settled = false
		const settle = (value) => {
			if (settled) {
				return false
			}
			settled = true
			self.export_pending?.delete(abandon)
			set_busy(false)
			resolve(value)
			return true
		}
		const abandon = () => settle(false)
		self.export_pending?.add(abandon)

		self.job_followers.follow(lane_job_id, {
			on_done : function(frame) {
				if (settled) {
					return
				}
				if (self.export_state!==state) {
					settle(false)
					return
				}
				const envelope	= frame && frame.data
				const result	= envelope && envelope.ok!==false ? response_data(envelope) : null
				const errors	= frame_errors(frame)
				if (!result || typeof result.url!=='string' || errors.length) {
					settle(false)
					status_node.classList.add('error')
					status_node.textContent = job_failure_text(self, frame, errors, 'file_failed', 'The file could not be built')
					return
				}
				state.files.set(key, result)
				status_node.textContent = ''
				settle(true)
				trigger_download(self, result)
			}
		})
	})
}//end download_format_now



/**
 * TRIGGER_DOWNLOAD
 * Navigate a hidden <a download> to the artifact route: the browser streams
 * the file to disk itself (the route answers Content-Disposition: attachment).
 * @param {Object} self
 * @param {Object} file - {url, basename, format}
 * @returns {void}
 */
const trigger_download = function(self, file) {

	const extension	= String(file.basename || '').split('.').pop() || 'dat'
	const date		= new Date().toISOString().slice(0, 10)
	const suffix	= file.format==='media_zip' ? '_media' : ''
	const name		= 'export_' + (self.caller.label || '') + '_' + date + '-' + self.caller.section_tipo + suffix + '.' + extension

	const link = document.createElement('a')
	link.style.display	= 'none'
	link.href			= file.url
	link.download		= name.replace(/[\\/:*?"<>|]+/g, '_')
	document.body.appendChild(link)
	link.click()
	link.remove()
}//end trigger_download






/**
 * RENDER_PRESETS_UI
 * Builds the user export presets toolbar: a panel (hidden by default) holding
 * the presets list plus 'New preset' / 'Save preset' buttons, and a toggle
 * button that opens the panel and lazy-loads the list.
 *
 * Structure:
 *   .export_presets
 *     .export_presets_header  — always visible; contains title, '+' new button, chevron
 *     .export_presets_panel   — collapsible body (display_none by default)
 *       button.button_save_preset — hidden until a preset is selected
 *       .export_presets_list      — preset section list is lazy-mounted on first open
 *
 * Side effects:
 *   - Sets self.export_presets_panel, self.export_presets_list, self.button_save_preset.
 *   - Lazy-loads presets via load_user_export_presets() on first panel open.
 *
 * Mirrors the search presets UI (core/search/js/render_search.js).
 *
 * @param {Object} self - The tool_export instance
 * @param {HTMLElement} parent - DOM node to append the presets block to
 * @returns {HTMLElement} presets_block
 */
const render_presets_ui = function(self, parent) {

	// presets_block. Themed, collapsible block placed at the top of the config column
		const presets_block = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'export_presets',
			parent			: parent
		})

	// header. Always visible: title + New + collapse toggle
		const presets_header = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'export_presets_header',
			parent			: presets_block
		})
		// title
		ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'export_presets_title',
			text_content	: get_label.export_presets || 'Export presets',
			parent			: presets_header
		})
		// button_new_preset
		const button_add_preset = ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'export_presets_new',
			text_content	: '+',
			title			: get_label.new || 'New',
			parent			: presets_header
		})
		// toggle chevron (visual; the whole header is the click target)
		ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'export_presets_toggle',
			title			: get_label.preset || 'Presets',
			parent			: presets_header
		})

	// panel. Collapsible body: save button + presets list (collapsed by default)
		const presets_panel = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'export_presets_panel display_none',
			parent			: presets_block
		})
		self.export_presets_panel = presets_panel

		// button_save_preset (hidden until a preset is selected)
		const button_save_preset = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'export_presets_save button_save_preset hide',
			text_content	: (get_label.save || 'Save') + ' ' + (get_label.changes || 'changes'),
			parent			: presets_panel
		})
		self.button_save_preset = button_save_preset

		// list container (the presets section list mounts here)
		const presets_list = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'export_presets_list',
			parent			: presets_panel
		})
		self.export_presets_list = presets_list

	// events

		// new preset
		button_add_preset.addEventListener('click', async (e) => {
			e.stopPropagation()

			// make sure the panel is open so the new preset is visible in the list
			open_export_presets(self)

			// create_new_export_preset (stores current config as the new preset)
			const section_id = await create_new_export_preset({
				self			: self,
				section_tipo	: presets_section_tipo
			})
			if (!section_id) {
				return
			}

			// launch the editor for name / public / default
			const section = await edit_user_export_preset(self, section_id)

			// open modal to edit the new preset
			render_preset_modal({
				caller		: section,
				section_id	: section_id,
				on_close	: async () => {

					// force refresh the presets list
					if (self.user_presets_section) {
						self.user_presets_section.total = null
						await self.user_presets_section.refresh()
					}

					// activate created preset (mark selected, do not re-apply)
					dd_request_idle_callback(
						() => {
							const button_apply = document.getElementById('apply_preset_' + section_id)
							if (button_apply) {
								select_preset({
									self			: self,
									section_id		: section_id,
									button_apply	: button_apply,
									load_preset		: false
								})
							}
						}
					)
				}
			})
		})

		// save current config to the selected preset
		button_save_preset.addEventListener('click', (e) => {
			e.stopPropagation()

			// check user_preset_section_id is already set
			if (!self.user_preset_section_id) {
				return
			}

			save_export_preset({
				self			: self,
				section_id		: self.user_preset_section_id,
				section_tipo	: presets_section_tipo
			})
			.then(function(response){
				// save_export_preset answers the envelope (or false when it refused)
				if (response && !request_failed(response)) {
					button_save_preset.classList.add('hide')
				}
			})
		})

		// toggle the panel (clicking anywhere on the header except the New button)
		presets_header.addEventListener('click', function(){
			toggle_export_presets(self)
		})


	return presets_block
}//end render_presets_ui



/**
 * TOGGLE_EXPORT_PRESETS
 * Shows or hides the export presets panel and lazy-loads the presets list on
 * first open. Delegates the open path to open_export_presets() so that
 * create_new_export_preset can also call open without toggling.
 * @param {Object} self - The tool_export instance
 * @returns {Promise<boolean>} true on success; undefined when panel node is missing
 */
const toggle_export_presets = async function(self) {

	const panel = self.export_presets_panel

	// validate
		if (!panel || !(panel instanceof HTMLElement)) {
			console.error('toggle_export_presets: panel not found or invalid');
			return
		}

	// close case
		if (!panel.classList.contains('display_none')) {
			panel.classList.add('display_none')
			self.export_presets_panel.parentNode?.classList.remove('open')
			return true
		}

	// open case
		await open_export_presets(self)


	return true
}//end toggle_export_presets



/**
 * OPEN_EXPORT_PRESETS
 * Opens the export presets panel and lazy-loads the presets list on first open.
 * Guards against repeated loads with the self.user_presets_section sentinel.
 * Called by both toggle_export_presets (user header click) and the 'New preset'
 * button handler so the panel is visible before the new preset is added.
 * @param {Object} self - The tool_export instance
 * @returns {Promise<boolean>} true on success, false when panel node is missing
 */
const open_export_presets = async function(self) {

	const panel	= self.export_presets_panel
	const list	= self.export_presets_list

	// validate
		if (!panel || !(panel instanceof HTMLElement)) {
			return false
		}

	// reveal panel
		panel.classList.remove('display_none')
		panel.parentNode?.classList.add('open')

	// load presets list on first open
		if (!self.user_presets_section && list) {

			// loading message
			const loading_node = ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'export_presets_loading notes loading',
				text_content	: (get_label.loading || 'Loading') + '..',
				parent			: list
			})

			self.user_presets_section = await load_user_export_presets(self)
			const user_presets_node = await self.user_presets_section.render()
			loading_node.remove()
			list.appendChild(user_presets_node)
		}


	return true
}//end open_export_presets



/**
 * BUILD_EXPORT_COMPONENT
 * Creates one selection-list DOM item representing a single export column.
 *
 * The returned element is a .export_component div with:
 *   - .component_label <li>: breadcrumb label (path names joined with ' > ')
 *     plus a <span> with the tipo and model for quick identification.
 *   - (hierarchical relation columns only — PARENTS_MODELS model + server-
 *     confirmed hierarchical target) .export_component_parents <label>: a
 *     checkbox that activates the ancestor-chain 'parents' column for this
 *     column (WC-049). Prevented from triggering drag start/drag events.
 *   - .button.close <span>: removes the item from the list and persists the
 *     updated selection to IndexedDB.
 *
 * The returned element has element.ddo attached directly as a property so that
 * sync_ar_ddo_to_export can walk the DOM and reconstruct ar_ddo_to_export
 * without keeping a separate parallel data structure.
 *
 * do_sortable() is applied to the element to enable intra-list drag-to-sort.
 *
 * @param {Object} ddo - Column descriptor (see file module header for shape)
 * @returns {Promise<HTMLElement>} The .export_component element
 */
render_tool_export.prototype.build_export_component = async function(ddo) {

	const self = this

	// short vars
		const path = ddo.path

	// export_component container. Create DOM element before load html from trigger
		const export_component = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'export_component'
		})
		export_component.ddo = ddo
		do_sortable(export_component, self)

		// export_component component_label
			const label = path.map((el)=>{
				return el.name
			}).join(' > ')
			const component_label = ui.create_dom_element({
				element_type	: 'li',
				class_name		: 'component_label',
				text_content	: label,
				parent			: export_component
			})
			ui.create_dom_element({
				element_type	: 'span',
				text_content	: ' [' + ddo.tipo + '] ' + ddo.model,
				parent			: component_label
			})

	// parents check (WC-049). Rendered only for PARENTS_MODELS columns whose
	// target section the server confirms hierarchical (has a
	// component_relation_parent — tool_export.components_with_parent action).
	// When checked, ddo.value_with_parents makes the value and grid_value
	// exports emit the targets' ancestor chain as a sibling 'parents' column;
	// disabled (with a note) in dedalo_raw — see PARENTS_FORMATS. Persisted with
	// the ddo in the local DB config (update_local_db_data saves whole ddos).
		if (PARENTS_MODELS.has(ddo.model) && await self.component_has_parent_targets(ddo)) {
			const parents_label = ui.create_dom_element({
				element_type	: 'label',
				class_name		: 'export_component_parents',
				title			: self.get_tool_label('value_with_parents') || 'Export parents',
				parent			: export_component
			})
			const parents_check = ui.create_dom_element({
				element_type	: 'input',
				type			: 'checkbox',
				class_name		: 'option_check_box export_component_parents_check',
				parent			: parents_label
			})
			parents_check.checked = ddo.value_with_parents===true
			ui.create_dom_element({
				element_type	: 'span',
				text_content	: get_label.parents || 'parents',
				parent			: parents_label
			})
			// the 'not in raw' note (visible only while dedalo_raw is selected)
			ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'export_component_parents_note hide',
				text_content	: self.get_tool_label('parents_not_in_raw_short') || '(not in Raw)',
				parent			: parents_label
			})
			// initial state for the CURRENT format (re-evaluated on format change
			// by update_parents_checks_state)
			set_parents_check_state(self, parents_label)
			// prevent the click/drag of the checkbox from triggering the
			// item sort drag handlers (the export_component is draggable)
			parents_label.addEventListener('click', e => e.stopPropagation())
			parents_label.addEventListener('mousedown', e => e.stopPropagation())
			parents_label.draggable = false
			parents_check.addEventListener('change', () => {
				ddo.value_with_parents = parents_check.checked
				// save local db data (ddo reference is shared with ar_ddo_to_export)
				self.update_local_db_data()
			})
		}

	// button close
		const export_component_button_close = ui.create_dom_element({
			element_type	: 'span',
			parent			: export_component,
			class_name		: 'button close'
		})
		export_component_button_close.addEventListener('click', function(e) {
			e.stopPropagation()

			// remove search box and content (component) from DOM
			export_component.parentNode.removeChild(export_component)

			// derive the ddo_export list from the remaining DOM order
			self.sync_ar_ddo_to_export()

			// save local db data
			self.update_local_db_data()
		})

	// phone reorder. Drag-sort is desktop-only; at the phone tier (CSS:
	// tools_common/css/tool_responsive.less) these up/down buttons show instead
	// and perform the SAME move (move_export_component). The initial
	// is_first/is_last are corrected by update_phone_reorder_state after every
	// list mutation (called at the end of sync_ar_ddo_to_export).
		const phone_reorder = render_phone_reorder({
			labels	: {
				up		: self.get_tool_label('move_up') || 'Move up',
				down	: self.get_tool_label('move_down') || 'Move down'
			},
			on_move	: (direction) => self.move_export_component(export_component, direction)
		})
		// BEFORE the close ✕, so the row reads label · parents · ▲▼ · ✕
		// (remove at the trailing edge, as elsewhere)
		export_component.insertBefore(phone_reorder, export_component_button_close)


	return export_component
}//end build_export_component



/**
 * UPDATE_LANG_STATE
 * The data-lang selector applies to every format but Dédalo (Raw), which carries
 * every stored language. Called on format change and after a preset is applied.
 * @returns {void}
 */
render_tool_export.prototype.update_lang_state = function() {

	const self = this

	if (self.select_lang_export) {
		self.select_lang_export.disabled = (self.data_format==='dedalo_raw')
	}
}//end update_lang_state

/**
 * UPDATE_PARENTS_CHECKS_STATE
 * Re-evaluates every selected column's parents checkbox against the current
 * self.data_format (PARENTS_FORMATS): called by the format select's change
 * handler and after a preset restores its format.
 * @returns {void}
 */
render_tool_export.prototype.update_parents_checks_state = function() {

	const self = this

	const root = self.user_selection_list
	if (!root) {
		return
	}
	const labels = root.querySelectorAll('.export_component_parents')
	for (let i = 0; i < labels.length; i++) {
		set_parents_check_state(self, labels[i])
	}
}//end update_parents_checks_state



/**
 * COMPONENT_HAS_PARENT_TARGETS
 * Whether the given column ddo's component points at a section that can carry
 * an ancestor chain (a target with a component_relation_parent) — the second
 * half of the per-column parents-checkbox gate (WC-049), answered by the
 * tool_export.components_with_parent server action.
 *
 * The per-instance cache stores the request PROMISE keyed by component tipo,
 * so concurrent build_export_component calls (activate_all_columns, preset
 * apply) resolve the same tipo with ONE request. A failed request resolves
 * false (no checkbox — degraded, never blocking).
 *
 * @param {Object} ddo - Column descriptor ({tipo, section_tipo, model, ...})
 * @returns {Promise<boolean>} true when the component has a hierarchical target
 */
render_tool_export.prototype.component_has_parent_targets = async function(ddo) {

	const self = this

	if (!self.components_with_parent) {
		self.components_with_parent = new Map()
	}
	const cached = self.components_with_parent.get(ddo.tipo)
	if (cached !== undefined) {
		return cached
	}

	const request_promise = self.tool_request({
		action	: 'components_with_parent',
		options	: {
			section_tipo	: self.caller.section_tipo, // permission gate target (the exported section)
			components		: [{
				tipo			: ddo.tipo,
				section_tipo	: ddo.section_tipo // owner section ('self' targets resolve against it)
			}]
		}
	})
	.then(response => response_data(response)?.[ddo.tipo]===true)
	.catch(() => false)

	self.components_with_parent.set(ddo.tipo, request_promise)

	return request_promise
}//end component_has_parent_targets



/**
 * SYNC_AR_DDO_TO_EXPORT
 * Rebuilds self.ar_ddo_to_export from the current DOM order of the selection list.
 *
 * The DOM (user_selection_list children) is the single source of truth for
 * column order: deriving the array from it after every add / sort / remove
 * keeps the export column order exactly equal to the visual order and avoids
 * the fragile index math (off-by-one, stale-index, async-race bugs) that
 * previously tried to keep the two in sync by hand.
 *
 * Only nodes with class 'export_component' AND a .ddo property are included;
 * any transient DOM nodes (e.g. drag placeholders) are silently skipped.
 *
 * @returns {void}
 */
render_tool_export.prototype.sync_ar_ddo_to_export = function() {

	const self = this

	const container = self.user_selection_list
	if (!container) {
		return
	}

	self.ar_ddo_to_export = [...container.children]
		.filter(node => node.classList && node.classList.contains('export_component') && node.ddo)
		.map(node => node.ddo)

	// the phone up/down buttons' first/last disabled state follows the order
	self.update_phone_reorder_state()
}//end sync_ar_ddo_to_export



/**
 * DO_SORTABLE
 * Makes an .export_component row draggable for reordering. Only the drag
 * SOURCE lives here: where the row lands is decided by the one drop zone
 * (the selection column — see drag_tool_export.js: pointer-midpoint index,
 * a single insertion marker, drop at that index).
 *
 * @param {HTMLElement} element - The .export_component node to make sortable
 * @param {Object} self - The tool_export instance
 * @returns {void}
 */
const do_sortable = function(element, self) {

	element.draggable = true

	element.addEventListener('dragstart', (event) => {
		event.stopPropagation()

		element.classList.add('dragging')
		self.set_sort_payload(element)

		// the drag API needs data to start (Firefox); the handlers read self.drag_payload
		event.dataTransfer.effectAllowed = 'move'
		event.dataTransfer.setData('text/plain', JSON.stringify({drag_type : 'sort'}))
	})

	element.addEventListener('dragend', () => {
		element.classList.remove('dragging')
	})
}//end do_sortable



/**
 * GET_MEDIA_MODELS_IN_DATA
 * The media models the export's media ZIP can archive — which quality
 * selectors the download modal renders, and whether the media download is
 * offered at all. Read from the preview's `media_models` (the SERVER's answer
 * over EVERY column, not only the drawn window): each column's own media
 * model PLUS the media the export READ through relations at any depth — a
 * portal column's model is component_portal while its targets hold images, so
 * the column models (`col_models`) are not the media signal.
 *
 * @param {Object} self - The tool_export instance
 * @returns {Array<string>} e.g. ['component_image', 'component_av']; empty
 *   without a loaded preview
 */
export const get_media_models_in_data = (self) => {

	const models = self.export_state?.preview?.media_models
	if (!Array.isArray(models)) {
		return []
	}

	return [...new Set(models.filter(model => typeof model==='string' && self.media_components.has(model)))]
}//end get_media_models_in_data



/**
 * RENDER_DOWNLOAD_MODAL
 * The quality choice before the media ZIP is built. One <select> per media
 * model present in the export:
 *   component_image — the ar_quality list from a component_image context;
 *   component_av    — [dedalo_av_quality_default, 'original'];
 *   component_3d | component_pdf | component_svg — ['web', 'original'].
 *
 * OK asks the SERVER for the archive: build_export_file format 'media_zip'
 * with options.media_qualities = {model: quality} (the server resolves every
 * file at that quality, applies the media access rules and writes the ZIP —
 * tools/tool_export/server/writers/media_zip.ts). An unknown quality is
 * refused by the server (media.invalid_quality) and shown in the modal.
 *
 * @param {Object} self - The tool_export instance
 * @returns {HTMLElement} The dd_modal DOM node (already attached to the document)
 */
export const render_download_modal = (self) => {

	// body
	const body = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'body content'
	})
	// media_qualities. model → target quality
	const media_qualities = {}
	// selectors still filling their options (OK waits for them: what is sent
	// must be what the select shows)
	const pending_selectors = []
	const models_unique = self.media_components_in_data || [];
	for (const model of models_unique) {

		// selector_container
			const selector_container = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'selector_container',
				parent			: body
			})

		// selector_title
			ui.create_dom_element({
				element_type	: 'h3',
				class_name		: 'selector_title',
				text_content	: (self.get_tool_label('quality_for') || 'Quality for') + ' ' + model,
				parent			: selector_container
			})

		// quality_selector
			const quality_selector = ui.create_dom_element({
				element_type	: 'select',
				class_name		: 'quality_selector for_' + model,
				parent			: selector_container
			})
			const add_option = (quality, selected) => {
				const option = ui.create_dom_element({
					element_type	: 'option',
					value			: quality,
					text_content	: quality,
					parent			: quality_selector
				})
				if (selected) {
					option.selected = true
				}
			}
			switch (model) {

				case 'component_image':
					// a generic component_image context gives the quality ladder
					// (features.ar_quality). The value sent is read back from the
					// select once filled: a ladder without the default selects
					// its first entry, and that is what the user sees.
					media_qualities[model] = page_globals.dedalo_image_quality_default
					pending_selectors.push(
						data_manager.get_element_context({
							model			: 'component_image',
							tipo			: 'rsc29',
							section_tipo	: 'rsc170'
						})
						.then(function(api_response){
							const context_data	= response_data(api_response)
							const ar_quality	= context_data?.[0]?.features?.ar_quality || []
							if(!context_data) {
								console.error('Failed component image context request:', api_response);
							}
							if (!ar_quality.length) {
								add_option(page_globals.dedalo_image_quality_default, true)
							}
							for (const quality of ar_quality) {
								add_option(quality, quality===page_globals.dedalo_image_quality_default)
							}
							if (quality_selector.value) {
								media_qualities[model] = quality_selector.value
							}
						})
						.catch(function(error){
							console.error('Failed component image context request:', error)
						})
					)
					break;

				case 'component_av':
					media_qualities[model] = page_globals.dedalo_av_quality_default
					add_option(page_globals.dedalo_av_quality_default, true)
					add_option('original', false)
					break;

				case 'component_3d':
				case 'component_pdf':
				case 'component_svg':
					media_qualities[model] = 'web'
					add_option('web', true)
					add_option('original', false)
					break;

				default:
					// not a known media model: the server default applies
					break;
			}
			quality_selector.addEventListener('change', (e) => {
				media_qualities[model] = e.target.value
			})
	}

	// status (build progress / refusal reason)
	const modal_status = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'modal_status',
		parent			: body
	})

	// footer
	const footer = ui.create_dom_element({
		element_type	: 'div',
		class_name 		: 'content'
	})

	// button_ok
	const button_ok = ui.create_dom_element({
		element_type	: 'button',
		class_name		: 'success',
		text_content	: get_label.ok || 'OK',
		parent			: footer
	})
	const click_handler = async (e) => {
		e.stopPropagation()

		body.classList.add('loading')
		button_ok.classList.add('button_spinner')
		button_ok.disabled = true
		modal_status.textContent = (self.get_tool_label('preparing_file') || 'Preparing file') + '…'

		// the quality ladders must be on screen before their values are sent
		await Promise.all(pending_selectors)

		const done = await download_format(
			self,
			'media_zip',
			self.export_ui?.download_buttons?.get('media_zip') || null,
			{media_qualities: {...media_qualities}}
		)

		body.classList.remove('loading')
		button_ok.classList.remove('button_spinner')
		button_ok.disabled = false
		// the reason (if any) is on the tool's download status line
		modal_status.textContent = done
			? ''
			: (self.export_ui?.download_status?.textContent || '')
		if (done) {
			modal.close?.()
		}
	}
	button_ok.addEventListener('click', click_handler)
	when_in_viewport(button_ok, () => {
		button_ok.focus()
	})

	// header as a node (text only — no HTML-parsing sink)
	const header = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'header content',
		text_content	: self.get_tool_label('download_media') || 'Download media'
	})

	const modal = ui.attach_to_modal({
		header		: header,
		body		: body,
		footer		: footer,
		size		: 'normal',
		callback	: (dd_modal) => {
			dd_modal.modal_content.style.width = '50rem'
			dd_modal.classList.add('tool_export_modal')
		}
	})


	return modal
}//end render_download_modal



// @license-end
