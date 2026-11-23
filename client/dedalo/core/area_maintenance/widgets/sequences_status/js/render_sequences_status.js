// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL, DEDALO_API_URL */
/*eslint no-undef: "error"*/



// imports
	import {ui} from '../../../../common/js/ui.js'



/**
* RENDER_SEQUENCES_STATUS
* Client-side render layer for the sequences_status area_maintenance widget.
*
* This module owns the visual representation of the PostgreSQL sequence-health
* audit produced by db_tasks::check_sequences() (PHP). The server walks every
* public-schema table, compares the sequence's last_value against the actual
* highest `id` in that table, auto-repairs any lagging sequence via setval(),
* and returns an HTML-formatted diagnostic report together with a structured
* per-table value array.
*
* Why sequences matter: PostgreSQL primary-key sequences must always be ahead
* of (or equal to) the highest existing id. A lagging sequence causes the next
* INSERT to attempt an id that is already in use, raising a unique-constraint
* violation. This widget surfaces that state — and the server's auto-repair
* outcome — so administrators can confirm correctness at a glance.
*
* Data shape consumed from self.value (populated by area_maintenance PHP via
* db_tasks::check_sequences() and stored in self.value by widget_common.build
* before the render call):
* {
*   result : boolean — true when all sequences were healthy or auto-repaired
*                      successfully; false when at least one problem persists
*   msg    : string  — HTML-formatted diagnostic output; one block per table,
*                      with <b>WARNING</b> spans and setval() SQL hints for any
*                      table whose sequence lagged behind its highest id
*   values : Array<{
*     table_name   : string — PostgreSQL table name
*     start_value  : number — sequence START WITH value (should always be 1)
*     last_value   : number — sequence's current last_value (next - 1)
*     last_id      : number — actual highest id found in the table
*   }>
* }
*
* Because area_maintenance inlines the value directly on the item descriptor
* passed to widget_factory (see class.area_maintenance.php), this widget has
* no get_value API call of its own — self.value is ready before render() fires.
*
* Exports:
*   render_sequences_status — constructor whose prototype methods are mixed into
*                             sequences_status by sequences_status.js
*/



/**
* RENDER_SEQUENCES_STATUS
* Constructor for the render prototype. sequences_status.js delegates render
* methods onto the sequences_status prototype via prototype assignment so every
* sequences_status instance inherits list() (aliased as both .edit and .list).
* The constructor itself is intentionally a no-op; all real work happens in
* list() and the private get_content_data_edit() helper.
* @returns {boolean} Always true
*/
export const render_sequences_status = function() {

	return true
}//end render_sequences_status



/**
* LIST
* Creates the nodes of current widget.
* The created wrapper will be append to the widget body in area_maintenance
* @param {Object} options
* 	Sample:
* 	{
*		render_level : "full"
		render_mode : "list"
*   }
* @returns {HTMLElement} wrapper
* 	To append to the widget body node (area_maintenance)
*/
render_sequences_status.prototype.list = async function(options) {

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
* Builds the audit table from the STRUCTURED rows (self.value.values) of the
* server's check_sequences(). value.msg (the PHP-parity HTML report) is NOT
* rendered: server text may never reach an HTML sink, and as plain text it reads
* as raw markup. Row state is derived here with the server's own verdict rules
* (src/core/area_maintenance/widgets/sequences_status.ts sequenceVerdict).
* @param {Object} self - sequences_status instance (self.value set before render)
* @returns {HTMLElement} content_data
*/
const get_content_data_edit = async function(self) {

	// short vars
		const value		= self.value || {}
		const rows		= Array.isArray(value.values) ? value.values : []

	// content_data
		const content_data = ui.create_dom_element({
			element_type : 'div',
			class_name	 : 'content_data dd_section'
		})

	// verdict. result=false: a start_value != 1 or a failed auto-repair setval
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'dd_note' + (value.result===false ? ' state_danger' : ''),
			text_content	: (value.result===false
				? 'Some sequences need attention (see status column). '
				: '') + rows.length + ' sequences checked. Lagging sequences are advanced automatically on load.',
			parent			: content_data
		})

	// table
		const table = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'dd_table',
			parent			: content_data
		})
		const add_row = (cells, is_header) => {
			const tr = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'dd_tr',
				parent			: table
			})
			for (const [text, cls, node] of cells) {
				const cell = ui.create_dom_element({
					element_type	: 'div',
					class_name		: (is_header ? 'dd_th' : 'dd_td') + (cls ? ' ' + cls : ''),
					text_content	: text,
					parent			: tr
				})
				if (node) cell.appendChild(node)
			}
		}
		add_row([['Table'], ['Start', 'num'], ['Seq last value', 'num'], ['Last id', 'num'], ['Status', 'act']], true)

		for (const row of rows) {
			const start_value	= String(row.start_value)
			const last_value	= String(row.last_value)
			const last_id		= String(row.last_id)

			// same rules as server sequenceVerdict (numeric compare for the repair)
			const [label, pill, title] = start_value!=='1'
				? ['start ≠ 1', 'pill_danger', `ALTER SEQUENCE ${row.table_name}_id_seq START WITH 1;`]
				: Number(last_id) > Number(last_value)
					? ['repaired', 'pill_warning', `Sequence was behind last id; advanced with setval('public.${row.table_name}_id_seq', ${last_id}, true)`]
					: last_value!==last_id
						? ['ahead', 'pill_neutral', 'Sequence ahead of last id (deleted rows) — normal']
						: ['ok', 'pill_ok', '']

			const badge = ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'dd_badge ' + pill,
				text_content	: label,
				title			: title
			})
			add_row([
				[row.table_name, 'mono'],
				[start_value, 'num' + (start_value!=='1' ? ' state_alert' : '')],
				[last_value, 'num'],
				[last_id, 'num'],
				['', 'act', badge]
			], false)
		}


	return content_data
}//end get_content_data_edit



// @license-end
