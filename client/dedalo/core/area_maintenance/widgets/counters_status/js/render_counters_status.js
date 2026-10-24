// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL, DEDALO_API_URL */
/*eslint no-undef: "error"*/



// imports
	import {ui} from '../../../../common/js/ui.js'
	import {open_window, object_to_url_vars} from '../../../../common/js/utils/index.js'



/**
* RENDER_COUNTERS_STATUS
* Client-side render layer for the counters_status area_maintenance widget.
*
* This module owns the visual representation of the PostgreSQL matrix_counter
* audit report produced by counter::check_counters() (PHP). It renders one row
* per section tipo showing:
*   - The ontology tipo identifier (clickable link to open that section in list mode)
*   - The human-readable section label
*   - The current counter value persisted in matrix_counter
*   - The actual highest section_id found in the live data matrix table
*   - A "Fix counter" action button, visible ONLY when the counter LAGS the data
*     (counter_value < last_section_id), which RAISES the counter server-side via
*     counter_action='fix'
*
* There is no "Reset counter" button: deleting a counter row destroyed the
* high-water mark and made the allocator re-mint deleted records' ids (P0-14).
* The server refuses counter_action='reset'.
*
* Data shape consumed from self.value (populated by counters_status PHP class
* via counter::check_counters()):
* {
*   datalist: Array<{
*     section_tipo:   string   — ontology tipo, e.g. 'oh1'
*     label:          string   — human-readable section name
*     counter_value:  number   — last-issued section_id stored in matrix_counter
*     last_section_id: number  — actual maximum section_id in the data matrix table
*                                (0 when the table is empty or unreachable)
*     floor_value:    number   — the section's HIGH-WATER MARK: the greater of
*                                last_section_id and the maximum section_id still
*                                witnessed by matrix_time_machine for deleted
*                                records. This is what drift is measured against.
*   }>
*   errors: Array<string>    — diagnostic messages from non-section tipo rows or
*                              DB failures (rendered in a pre block at the top)
* }
*
* counter_value is a HIGH-WATER MARK of the ids ever minted for the section, not
* a count of live records — so counter_value > last_section_id is the NORMAL
* state of any section that has had a record deleted from its tail, and nothing
* is flagged. Only counter_value < last_section_id is a defect (typically a bulk
* import that bypassed the allocator); the "Fix counter" button calls
* self.modify_counter() (counters_status.js) which posts counter_action='fix'
* and raises the counter to the real maximum section_id.
*
* Exports:
*   render_counters_status  — constructor (prototype used by counters_status.js)
*/



/**
* RENDER_COUNTERS_STATUS
* Constructor for the render prototype. counters_status.js assigns the render
* methods onto the counters_status prototype via prototype delegation so that
* each counters_status instance uses these render functions directly.
* The constructor itself is a no-op; the real work happens in list().
* @returns {boolean} Always true
*/
export const render_counters_status = function() {

	return true
}//end render_counters_status



/**
* COUNTER_LAGS
* THE ONE drift predicate, used by BOTH the per-row decoration and the bulk
* "Repair all counters" count — they diverged once (the per-row test carried an
* extra `last_section_id !== 'empty'` conjunct) and the page then offered to
* repair rows it was not flagging.
*
* A counter is a HIGH-WATER MARK: it lags only when it stands BELOW the
* section's floor_value (the highest id ever minted, witnessed by the live rows
* AND by the time-machine rows of deleted ones). A counter AHEAD of the live
* data is healthy.
* @param {Object} item - one audit datalist row
* @returns {boolean}
*/
const counter_lags = function(item) {
	return Number(item.counter_value) < Number(item.floor_value ?? item.last_section_id ?? 0)
}//end counter_lags



/**
* BULK_REPAIRABLE
* A lagging row the BULK button may raise. `bulk_repair_excluded` marks a row
* whose high-water mark sits far above its live data: the raise is correct but
* IRREVERSIBLE (no writer may lower a counter, and 'reset' is gone), so it is a
* per-row decision with the number in view, never a side effect of one click.
* The button's count must equal what the server will actually repair, or it
* promises work it will not do.
* @param {Object} item - one audit datalist row
* @returns {boolean}
*/
const bulk_repairable = function(item) {
	return counter_lags(item) && item.bulk_repair_excluded!==true
}//end bulk_repairable



/**
* LIST
* Creates the nodes of current widget.
* The created wrapper will be append to the widget body in area_maintenance
* @param {Object} options
* 	Sample:
* 	{
*		render_level : "full"
*		render_mode : "list"
*   }
* @returns {HTMLElement} wrapper
* 	To append to the widget body node (area_maintenance)
*/
render_counters_status.prototype.list = async function(options) {

	const self = this

	const render_level = options.render_level || 'full'

	// content_data
		const content_data = await get_content_data_edit(self)
		if (render_level==='content') {
			return content_data
		}

	// wrapper. ui build_edit returns widget wrapper
		const wrapper = ui.widget.build_wrapper_edit(self, {
			content_data : content_data
		})
		// set pointers
		wrapper.content_data = content_data


	return wrapper
}//end list



/**
* GET_CONTENT_DATA_EDIT
* Builds the full audit-report DOM tree for the counters_status widget.
*
* Renders three sections inside a container div:
*   1. A counters_total headline showing the number of matrix_counter rows audited.
*   2. An errors_container (only when self.value.errors is non-empty) showing each
*      error string in a <pre> block. Errors represent non-section tipo counter rows
*      or DB access failures found by counter::check_counters().
*   3. A datalist_container with one row per audited section, prepended by a header
*      row. Each data row shows section_tipo (link), label, counter_value, and
*      last_section_id. When counter_value < last_section_id the last_section_id
*      cell is decorated with the 'state_alert' CSS class and a "Fix counter"
*      button appears.
*
* The body_response div is created here and passed into the fn_fix_counter
* closure so that API operation status messages can be written
* into it by modify_counter() (counters_status.js). It is appended to content_data
* at the end of this function after the datalist is fully built.
*
* @param {Object} self - The counters_status instance. Must have self.value (set
*   by get_value API call before render) and self.modify_counter() method
*   (inherited from counters_status.prototype).
* @returns {HTMLElement} content_data - The fully-built widget content node
*/
const get_content_data_edit = async function(self) {

	// short vars
		const value		= self.value || {}
		const datalist	= value.datalist || []
		const errors	= value.errors

	// content_data
		const content_data = ui.create_dom_element({
			element_type : 'div',
			class_name	 : 'content_data'
		})

	// counters_total
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'counters_total',
			text_content	: 'Counters total: ' + datalist.length,
			parent			: content_data
		})

	// errors
		if (errors && errors.length>0) {
			const errors_container = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'errors_container',
				inner_html		: 'Some errors found',
				parent			: content_data
			})
			// server error text NEVER reaches an HTML sink
			ui.create_dom_element({
				element_type	: 'pre',
				class_name		: 'error_pre',
				text_content	: errors.join('\n'),
				parent			: errors_container
			})
		}

	// body_response
	// Created early so that the fn_fix_counter closure can
	// reference it via closure capture. Appended to content_data at the end of
	// this function, after the datalist is built, so it appears below the rows.
		const body_response = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'body_response'
		})

	// repair_all_container
	// The BULK form of "Fix counter" (P0-14). Shown only when at least one row
	// stands below its high-water mark — the state an install is left in when the
	// old consolidate-down button was pressed before that button was removed.
	// Raise-only and idempotent server-side, so it is safe to press twice.
		const lagging_count = (self.value?.datalist ?? []).filter(bulk_repairable).length
		if (lagging_count > 0) {
			const repair_all_container = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'repair_all_container',
				parent			: content_data
			})
			const button_repair_all = ui.create_dom_element({
				element_type	: 'button',
				class_name		: 'light button_action repair_all_counters',
				text_content	: 'Repair all counters (' + lagging_count + ')',
				parent			: repair_all_container
			})
			button_repair_all.addEventListener('click', async function(e){
				e.stopPropagation()
				button_repair_all.classList.add('button_spinner')
				try {
					await self.repair_all_counters({
						body_response : body_response
					})
				} finally {
					button_repair_all.classList.remove('button_spinner')
				}
			})
		}

	// reconcile_media_container
	// THE RESTORE-DAY ACTION (P0-14 / LIFE-08). A pg_restore rolls the counters
	// back WITH the data while the media filesystem keeps every file written up
	// to the disaster, so the disk is the only witness left of the ids in
	// between. Always shown — the panel cannot know a restore happened, and this
	// is the step engineering/PRODUCTION.md §6.1 tells the operator to run.
	// DRY by default: the first press reports and writes nothing.
		const reconcile_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'reconcile_media_container',
			parent			: content_data
		})
		const button_reconcile_dry = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'light button_action reconcile_media_counters',
			inner_html		: 'Check counters against the media tree',
			parent			: reconcile_container
		})
		button_reconcile_dry.addEventListener('click', async function(e){
			e.stopPropagation()
			button_reconcile_dry.classList.add('button_spinner')
			try {
				await self.reconcile_media_counters({
					body_response	: body_response,
					apply			: false
				})
			} finally {
				button_reconcile_dry.classList.remove('button_spinner')
			}
		})
		const button_reconcile_apply = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'light warning button_action reconcile_media_counters_apply',
			inner_html		: 'Raise counters from the media tree',
			parent			: reconcile_container
		})
		button_reconcile_apply.addEventListener('click', async function(e){
			e.stopPropagation()
			// Raising a counter cannot be undone — and a surprising number here
			// usually means the media root is not the one this database belongs to.
			if (!confirm('Raise every counter the media tree proves is too low?\n\nRun the CHECK first and read the list: a raise cannot be undone, and an unexpected result usually means MEDIA_PATH points at another installation\'s tree.')) {
				return false
			}
			button_reconcile_apply.classList.add('button_spinner')
			try {
				await self.reconcile_media_counters({
					body_response	: body_response,
					apply			: true
				})
			} finally {
				button_reconcile_apply.classList.remove('button_spinner')
			}
		})

	// datalist
		const datalist_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'datalist_container dd_table',
			parent			: content_data
		})
		// header

		// list
		// Prepend a synthetic header item so the header row is rendered by the
		// same loop as the data rows, avoiding duplicated DOM-building code.
		// The header item uses type='header' to skip click listeners and action buttons.
			const full_list = [{
				type			: 'header',
				section_tipo	: 'Section tipo',
				label			: 'Section name',
				counter_value	: 'Counter value',
				last_section_id	: 'Last section_id'
			}, ...datalist]
			const full_list_length = full_list.length
			for (let i = 0; i < full_list_length; i++) {

				const item = full_list[i]

				// last_section_id falls back to 'empty' for sections whose data
				// matrix table is empty or could not be read (check_counters returns 0
				// for both; the header item carries the string 'Last section_id').
				const last_section_id	= item.last_section_id || 'empty'
				// counter_lagging: true ONLY when the stored counter is BELOW the
				// section's HIGH-WATER MARK (floor_value: the highest id ever minted,
				// witnessed by the live rows AND by the time-machine rows of deleted
				// ones). The counter is a high-water mark, not a row count, so
				// counter > last_section_id is the NORMAL state of any section that
				// has had a record deleted from its tail — flagging that as drift is
				// what made an operator press a button that re-minted dead ids (P0-14).
				// Comparing against last_section_id instead of floor_value would
				// report an ALREADY-damaged install as healthy: after the old
				// consolidate-down button ran, counter == last_section_id exactly
				// while the ids above it are minted and dead. And the test must NOT
				// be conjoined with `last_section_id !== 'empty'`: a section whose
				// records were ALL deleted has last_section_id 0 (rendered 'empty')
				// and a floor above 0 — the most damaged row on the install — which
				// that guard silently excluded while the bulk count still counted it.
				const counter_lagging	= counter_lags(item)
				const is_header = item.type==='header'

				// datalist_item_container
					const datalist_item_container = ui.create_dom_element({
						element_type	: 'div',
						class_name		: 'dd_tr',
						parent			: datalist_container
					})

				// section_tipo
				// Data rows get a 'link' class and a click listener that opens the
				// section in list mode in a new window named 'section_view'.
					const section_tipo_node = ui.create_dom_element({
						element_type	: 'div',
						class_name		: (is_header ? 'dd_th' : 'dd_td'),
						text_content	: String(item.section_tipo ?? ''),
						parent			: datalist_item_container
					})
					if (item.type!=='header') {
						section_tipo_node.classList.add('link')
						section_tipo_node.addEventListener('click', function(e) {
							// open a new window
							const url = DEDALO_CORE_URL + '/page/?' + object_to_url_vars({
								tipo	: item.section_tipo,
								mode	: 'list',
								menu	: false
							})
							const new_window = open_window({
								url		: url,
								name	: 'section_view'
							})
						})
					}

				// section_name
					ui.create_dom_element({
						element_type	: 'div',
						class_name		: (is_header ? 'dd_th' : 'dd_td'),
						text_content	: String(item.label ?? ''),
						parent			: datalist_item_container
					})

				// counter_value
					ui.create_dom_element({
						element_type	: 'div',
						class_name		: (is_header ? 'dd_th num' : 'dd_td num'),
						text_content	: String(item.counter_value ?? ''),
						parent			: datalist_item_container
					})

				// last_section_id
				// state_alert highlights only a LAGGING counter — a counter ahead of
				// the data is healthy and is left undecorated.
					const lsid_class = is_header
					? 'dd_th num'
					// state_alert, NOT alert: the bare name collides with the global
					// .alert component in layout/general.less (see widget_kit.less).
					: ('dd_td num' + (counter_lagging===true ? ' state_alert' : ''))
					ui.create_dom_element({
						element_type	: 'div',
						class_name		: lsid_class,
						text_content	: String(last_section_id ?? ''),
						parent			: datalist_item_container
					})

				// fix_counter_container
				// The "Fix counter" button is shown only on rows whose counter LAGS
				// the data. It calls self.modify_counter() with counter_action='fix',
				// which RAISES the matrix_counter row to the real maximum section_id
				// (GREATEST upsert — it can never lower it).
					const fix_counter_container = ui.create_dom_element({
						element_type	: 'div',
						class_name		: (is_header ? 'dd_th' : 'dd_td') + ' act fix_counter_container',
						parent			: datalist_item_container
					})
					if (item.type==='header') {
						fix_counter_container.insertAdjacentHTML('afterbegin', 'Fix counter')
					}else if(counter_lagging) {
						const button_fix = ui.create_dom_element({
							element_type	: 'button',
							class_name		: 'light button_action fix_counter',
							inner_html		: 'Fix counter',
							parent			: fix_counter_container
						})
						button_fix.addEventListener('click', fn_fix_counter)
						async function fn_fix_counter(e) {
							e.stopPropagation()

							// confirm action
								if (!confirm( get_label.sure || 'Sure?' )) {
									return false;
								}

							// button_spinner
								button_fix.classList.add('button_spinner')

							try {
								// modify_counter
									await self.modify_counter({
										counter_action	: 'fix',
										section_tipo	: item.section_tipo,
										body_response	: body_response
									})
							} finally {
									button_fix.classList.remove('button_spinner')
							}
						}//end fn_fix_counter
					}

			}//end for (let i = 0; i < full_list_length; i++)

	// add at end body_response
		content_data.appendChild(body_response)


	return content_data
}//end get_content_data_edit



// @license-end
