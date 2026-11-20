// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label */
/*eslint no-undef: "error"*/

// imports
import { is_api_error } from '../../../../common/js/api_error.js';
import { format_label } from '../../../../common/js/common.js';
import { handle_api_error } from '../../../../common/js/error_dispatch.js';
import { dd_request_idle_callback } from '../../../../common/js/events.js';
import { error_text } from '../../../../common/js/render_api_error.js';
import { ui } from '../../../../common/js/ui.js';

/**
 * RENDER_LEGACY_PASSWORDS
 * Client-side render module for the legacy_passwords maintenance widget.
 *
 * Panel: how many accounts hold a password, how many are already in the
 * current format and how many are still on a Dédalo v6 password (those cannot
 * log in). While any remain: the two v6 key values, a CHECK (writes nothing)
 * and a CONVERT (confirmed), and the report of the last run.
 *
 * Every text goes through textContent (never markup). The two key fields are
 * never pre-filled, never read back from the server and never stored.
 */
// biome-ignore lint/complexity/useArrowFunction: `.prototype.list` is assigned below and an arrow has no prototype — the module would throw while evaluating (client_prototype_contract_tripwire)
export const render_legacy_passwords = function () {
	return true;
}; //end render_legacy_passwords

/**
 * LIST
 * Creates the nodes of the widget. Assigned as both `edit` and `list`.
 * @param {Object} options
 * @param {string} [options.render_level='full'] - 'content' returns the content_data alone
 * @returns {Promise<HTMLElement>} wrapper, or content_data
 */
render_legacy_passwords.prototype.list = async function (options) {
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
 * REPORT_TEXT
 * Pure: the sentence of a run's summed report — what was checked (a dry run
 * wrote nothing) or what was converted, failed, skipped and is left.
 * @param {Object} report - legacy_passwords add_batch sum
 * @returns {string}
 */
export const report_text = (report) => {
	return report.execute === true
		? format_label(
				get_label.legacy_passwords_report_run ||
					'Converted ${converted} of ${examined}. Could not be converted: ${failed}. Skipped (password changed meanwhile): ${skipped}. Still on a v6 password: ${remaining}.',
				{ ...report, remaining: report.remaining ?? '—' },
			)
		: format_label(
				get_label.legacy_passwords_report_check ||
					'Checked ${examined}: ${recoverable} can be converted, ${failed} cannot. Nothing was written.',
				report,
			);
}; //end report_text

/**
 * GET_CONTENT_DATA_EDIT
 * @param {Object} self - widget instance
 * @returns {Promise<HTMLElement>} content_data
 */
const get_content_data_edit = async (self) => {
	// content_data
	const content_data = ui.create_dom_element({
		element_type: 'div',
		class_name: 'content_data legacy_passwords_content',
	});

	// lead
	ui.create_dom_element({
		element_type: 'div',
		class_name: 'legacy_passwords_lead',
		text_content:
			get_label.legacy_passwords_lead ||
			'After a migration from Dédalo v6, an account whose password was never converted cannot log in. Here you convert those passwords to the current format; nobody has to choose a new one.',
		parent: content_data,
	});

	// not loaded yet (the host loads the value when the panel opens): the lead
	// only — never a count that was not read, never a form over an unknown state
	if (!self.value) {
		return content_data;
	}

	// short vars
	const value = self.value;
	const legacy = Number.isFinite(value.legacy) ? value.legacy : null;

	// census
	const readout = ui.create_dom_element({
		element_type: 'div',
		class_name: 'dd_readout legacy_passwords_census',
		parent: content_data,
	});
	const add_row = (label, row_value, class_name = '') => {
		const row = ui.create_dom_element({
			element_type: 'div',
			class_name: 'dd_row',
			parent: readout,
		});
		ui.create_dom_element({
			element_type: 'div',
			class_name: 'dd_k',
			text_content: label,
			parent: row,
		});
		return ui.create_dom_element({
			element_type: 'div',
			class_name: `dd_v ${class_name}`.trim(),
			text_content: row_value === null || row_value === undefined ? '—' : String(row_value),
			parent: row,
		});
	};
	add_row(get_label.legacy_passwords_accounts || 'Accounts with a password', value.accounts);
	add_row(get_label.legacy_passwords_current || 'Already in the current format', value.argon2);
	add_row(
		get_label.legacy_passwords_legacy || 'Still on a v6 password (cannot log in)',
		legacy,
		`legacy_count ${legacy === 0 ? 'state_ok' : 'state_danger'}`,
	);

	// body_response (created early: the buttons write into it)
	const body_response = ui.create_dom_element({
		element_type: 'div',
		class_name: 'body_response',
	});

	if (legacy === 0) {
		// nothing to convert: no form, no keys asked for
		ui.create_dom_element({
			element_type: 'div',
			class_name: 'dd_note state_ok legacy_passwords_none',
			text_content:
				get_label.legacy_passwords_none || 'Every account is in the current format. Nothing to do.',
			parent: content_data,
		});
	} else {
		render_form(self, value, content_data, body_response);
	}

	content_data.appendChild(body_response);

	// the last run's report (kept across the refresh that follows a run)
	if (self.last_report) {
		render_report(content_data, self.last_report);
	}

	return content_data;
}; //end get_content_data_edit

/**
 * RENDER_FORM
 * The two v6 key values and the two actions.
 * @param {Object} self
 * @param {Object} value - server panel value
 * @param {HTMLElement} content_data
 * @param {HTMLElement} body_response
 * @returns {HTMLElement} form
 */
const render_form = (self, value, content_data, body_response) => {
	const form = ui.create_dom_element({
		element_type: 'form',
		class_name: 'legacy_passwords_form',
		parent: content_data,
	});
	form.setAttribute('autocomplete', 'off');
	form.addEventListener('submit', (e) => {
		e.preventDefault();
	});

	const add_field = (name, label, placeholder) => {
		const field = ui.create_dom_element({
			element_type: 'label',
			class_name: 'legacy_passwords_field',
			parent: form,
		});
		ui.create_dom_element({
			element_type: 'span',
			class_name: 'legacy_passwords_field_label',
			text_content: label,
			parent: field,
		});
		const input = ui.create_dom_element({
			element_type: 'input',
			// masked, and never offered to (or by) the browser's password manager
			type: 'password',
			class_name: `legacy_passwords_input ${name}`,
			placeholder: placeholder,
			parent: field,
		});
		input.name = name;
		input.setAttribute('autocomplete', 'new-password');
		input.setAttribute('spellcheck', 'false');
		return input;
	};
	const input_information = add_field(
		'information',
		get_label.legacy_passwords_information || 'v6 DEDALO_INFORMATION',
		get_label.legacy_passwords_information_placeholder || 'empty = the v6 default',
	);
	const input_info_key = add_field(
		'info_key',
		get_label.legacy_passwords_info_key || 'v6 DEDALO_INFO_KEY',
		format_label(get_label.legacy_passwords_info_key_placeholder || 'empty = ${entity}', {
			entity: value.default_info_key ?? '',
		}),
	);

	ui.create_dom_element({
		element_type: 'div',
		class_name: 'dd_note legacy_passwords_keys_hint',
		text_content:
			get_label.legacy_passwords_keys_hint ||
			'Both values are in the configuration of the v6 installation (config.php). They are used for this conversion only and are not stored.',
		parent: form,
	});
	if (value.command) {
		ui.create_dom_element({
			element_type: 'div',
			class_name: 'dd_note legacy_passwords_cli_hint',
			text_content: format_label(
				get_label.legacy_passwords_cli_hint ||
					'The same conversion can be run on the command line of the server: ${command}',
				{ command: value.command },
			),
			parent: form,
		});
	}

	const actions = ui.create_dom_element({
		element_type: 'div',
		class_name: 'legacy_passwords_actions',
		parent: form,
	});
	const button_check = ui.create_dom_element({
		element_type: 'button',
		type: 'button',
		class_name: 'light button_action legacy_passwords_check',
		text_content: get_label.legacy_passwords_check || 'Check',
		parent: actions,
	});
	const button_convert = ui.create_dom_element({
		element_type: 'button',
		type: 'button',
		class_name: 'light warning button_action legacy_passwords_convert',
		text_content: get_label.legacy_passwords_convert || 'Convert passwords',
		parent: actions,
	});

	const run = async (button, execute) => {
		button_check.disabled = true;
		button_convert.disabled = true;
		button.classList.add('button_spinner');
		body_response.textContent = '';
		try {
			const { report, error } = await self.migrate({
				information: input_information.value,
				info_key: input_info_key.value,
				execute: execute,
				on_progress: (running) => {
					body_response.textContent = report_text(running);
				},
			});
			self.last_report = report.batches > 0 ? report : null;
			// a run that wrote changed the count — also one that stopped half-way:
			// the panel value follows the server's own recount of the last batch
			if (
				execute === true &&
				Number.isFinite(report.remaining) &&
				Number.isFinite(self.value.accounts)
			) {
				self.value = {
					...self.value,
					legacy: report.remaining,
					argon2: self.value.accounts - report.remaining,
				};
			}
			if (error) {
				body_response.textContent = error_text(error);
				if (is_api_error(error)) {
					await handle_api_error(error, { wrapper: body_response });
				}
				return;
			}
			body_response.textContent = report_text(report);
			if (execute === true) {
				// re-state the panel (the typed keys go with the form — a fresh one renders empty)
				dd_request_idle_callback(() => {
					self.refresh({ build_autoload: false, destroy: true });
				});
			} else {
				const previous = content_data.querySelector('.legacy_passwords_report');
				if (previous) {
					previous.remove();
				}
				render_report(content_data, report);
			}
		} finally {
			button.classList.remove('button_spinner');
			button_check.disabled = false;
			button_convert.disabled = false;
		}
	};

	button_check.addEventListener('click', (e) => {
		e.stopPropagation();
		return run(button_check, false);
	});
	button_convert.addEventListener('click', (e) => {
		e.stopPropagation();
		// a write on the accounts — never behind the operator's back
		if (
			!confirm(
				get_label.legacy_passwords_confirm ||
					'Convert the passwords that these values decrypt?\n\nRun Check first. Each converted account keeps its password; the conversion cannot be undone from this panel.',
			)
		) {
			return false;
		}
		return run(button_convert, true);
	});

	return form;
}; //end render_form

/**
 * RENDER_REPORT
 * The run's sentence and — when some accounts could not be converted — who.
 * @param {HTMLElement} parent
 * @param {Object} report - legacy_passwords add_batch sum
 * @returns {HTMLElement}
 */
const render_report = (parent, report) => {
	const block = ui.create_dom_element({
		element_type: 'div',
		class_name: 'legacy_passwords_report',
		parent: parent,
	});
	ui.create_dom_element({
		element_type: 'div',
		class_name: `dd_note ${report.failed > 0 ? 'state_warning' : 'state_ok'} legacy_passwords_report_text`,
		text_content: report_text(report),
		parent: block,
	});

	const failed_accounts = Array.isArray(report.failed_accounts) ? report.failed_accounts : [];
	if (failed_accounts.length > 0) {
		ui.create_dom_element({
			element_type: 'div',
			class_name: 'legacy_passwords_failed_title',
			text_content:
				get_label.legacy_passwords_failed_title ||
				'Not converted — these values do not decrypt them',
			parent: block,
		});
		const list = ui.create_dom_element({
			element_type: 'ul',
			class_name: 'legacy_passwords_failed_list',
			parent: block,
		});
		failed_accounts.forEach((account) => {
			ui.create_dom_element({
				element_type: 'li',
				text_content: `${account.username} (${account.section_id})`,
				parent: list,
			});
		});
		ui.create_dom_element({
			element_type: 'div',
			class_name: 'legacy_passwords_failed_hint',
			text_content:
				get_label.legacy_passwords_failed_hint ||
				'Check the two values against the v6 configuration that was in use when these passwords were last set, or set a new password for these accounts in the Users section.',
			parent: block,
		});
	}

	return block;
}; //end render_report

// @license-end
