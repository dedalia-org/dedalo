// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL, DEDALO_API_URL */
/*eslint no-undef: "error"*/

// imports
import { ui } from '../../../../common/js/ui.js';
import { last_run_text, schedule_text } from './reconcile_status_text.js';

/**
 * RENDER_RECONCILE_STATUS
 * Render layer of the reconcile_status widget: one row per registered
 * reconcile (name, stores, schedule, last run) with CHECK / APPLY buttons, a
 * shared body_response for the server sentence, and the last report as JSON.
 * Every server string reaches the DOM through textContent (SEC-XSS-011).
 */
export const render_reconcile_status = function () {
	// NOT an arrow: `render_reconcile_status.prototype.list` is assigned below,
	// and an arrow has no prototype — the module would throw while evaluating
	// and the widget would resolve null (client_prototype_contract_tripwire).
	return true;
}; //end render_reconcile_status

/**
 * LIST
 * @param {Object} options
 * @returns {HTMLElement} wrapper
 */
render_reconcile_status.prototype.list = async function (options) {
	const render_level = options.render_level || 'full';

	// content_data
	const content_data = await get_content_data_edit(this);
	if (render_level === 'content') {
		return content_data;
	}

	// wrapper
	const wrapper = ui.widget.build_wrapper_edit(this, {
		content_data: content_data,
	});
	wrapper.content_data = content_data;

	return wrapper;
}; //end list

/**
 * GET_CONTENT_DATA_EDIT
 * @param {Object} self - the reconcile_status instance (self.value set by get_value)
 * @returns {HTMLElement} content_data
 */
const get_content_data_edit = async (self) => {
	// short vars
	const value = self.value || {};
	const reconciles = value.reconciles || [];

	// content_data
	const content_data = ui.create_dom_element({
		element_type: 'div',
		class_name: 'content_data',
	});

	// lead
	ui.create_dom_element({
		element_type: 'div',
		class_name: 'reconcile_total',
		text_content: `Registered reconciles: ${reconciles.length} — CHECK reports drift and writes nothing; APPLY repairs it.`,
		parent: content_data,
	});

	// body_response (created early: the buttons write into it)
	const body_response = ui.create_dom_element({
		element_type: 'div',
		class_name: 'body_response',
	});

	// table
	const table = ui.create_dom_element({
		element_type: 'div',
		class_name: 'reconcile_table dd_table',
		parent: content_data,
	});
	const header = ui.create_dom_element({
		element_type: 'div',
		class_name: 'dd_tr header',
		parent: table,
	});
	for (const text of ['Reconcile', 'Stores compared', 'Schedule', 'Last run', 'Actions']) {
		ui.create_dom_element({
			element_type: 'div',
			class_name: text === 'Actions' ? 'dd_th act' : 'dd_th',
			text_content: text,
			parent: header,
		});
	}

	const reconciles_length = reconciles.length;
	for (let i = 0; i < reconciles_length; i++) {
		const item = reconciles[i];
		const row = ui.create_dom_element({
			element_type: 'div',
			class_name: 'dd_tr',
			parent: table,
		});
		// name + description
		const name_cell = ui.create_dom_element({
			element_type: 'div',
			class_name: 'dd_td name',
			parent: row,
		});
		ui.create_dom_element({
			element_type: 'strong',
			text_content: item.name,
			parent: name_cell,
		});
		ui.create_dom_element({
			element_type: 'div',
			class_name: 'description',
			text_content: item.description,
			parent: name_cell,
		});
		// stores
		ui.create_dom_element({
			element_type: 'div',
			class_name: 'dd_td stores',
			text_content: `${item.stores[0]} ↔ ${item.stores[1]}`,
			parent: row,
		});
		// schedule
		ui.create_dom_element({
			element_type: 'div',
			class_name: 'dd_td schedule',
			text_content: schedule_text(item.schedule) + (item.auto_apply ? ' (auto-apply)' : ''),
			parent: row,
		});
		// last run
		// state_alert goes on the CELL: .dd_tr is display: contents, so a class
		// on the row would paint nothing (kit styles .dd_td.state_alert).
		ui.create_dom_element({
			element_type: 'div',
			class_name:
				'dd_td last_run' +
				(item.last_run && item.last_run.drift > 0 ? ' state_alert' : ''),
			text_content: last_run_text(item.last_run),
			parent: row,
		});
		// actions
		// `act` is the kit's right-rail button cell (children never shrink, so the
		// labels cannot wrap to "Che ck"); `actions` only adds the gap.
		const actions = ui.create_dom_element({
			element_type: 'div',
			class_name: 'dd_td act actions',
			parent: row,
		});
		const button_check = ui.create_dom_element({
			element_type: 'button',
			class_name: 'light button_action reconcile_check',
			inner_html: 'Check',
			parent: actions,
		});
		button_check.addEventListener('click', async (e) => {
			e.stopPropagation();
			button_check.classList.add('button_spinner');
			try {
				await self.run_reconcile({ body_response, name: item.name, apply: false });
			} finally {
				button_check.classList.remove('button_spinner');
			}
		});
		// APPLY only where THIS viewer may apply (row.can_apply — the registry's apply
		// policy, WC-2026-09-03 addendum 2026-10-21): a refused or root-only apply is a
		// disabled button that says why, never a click the server answers with a refusal.
		if (item.can_apply !== true) {
			const why =
				item.apply === 'refused'
					? 'Apply is not offered here'
					: 'Only the root user can apply this reconcile';
			ui.create_dom_element({
				element_type: 'button',
				class_name: 'light button_action reconcile_apply',
				inner_html: 'Apply',
				title: item.apply_reason ? `${why}: ${item.apply_reason}` : why,
				parent: actions,
			}).disabled = true;
			continue;
		}
		const button_apply = ui.create_dom_element({
			element_type: 'button',
			class_name: 'light warning button_action reconcile_apply',
			inner_html: 'Apply',
			parent: actions,
		});
		button_apply.addEventListener('click', async (e) => {
			e.stopPropagation();
			// A repair writes a shared store — never behind the operator's back.
			if (
				!confirm(
					`Apply reconcile "${item.name}"?\n\nRun CHECK first and read the drift: the repair writes ${item.stores[1]} / ${item.stores[0]} and is not reverted by this panel.`,
				)
			) {
				return false;
			}
			button_apply.classList.add('button_spinner');
			try {
				await self.run_reconcile({ body_response, name: item.name, apply: true });
			} finally {
				button_apply.classList.remove('button_spinner');
			}
		});
	}

	// body_response after the table
	content_data.appendChild(body_response);

	// last report (kept across the refresh by run_reconcile)
	if (self.last_report) {
		ui.create_dom_element({
			element_type: 'pre',
			class_name: 'report_pre',
			text_content: JSON.stringify(self.last_report, null, 2),
			parent: content_data,
		});
	}

	return content_data;
}; //end get_content_data_edit

// @license-end
