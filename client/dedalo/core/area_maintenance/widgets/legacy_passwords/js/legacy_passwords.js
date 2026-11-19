// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global SHOW_DEBUG */
/*eslint no-undef: "error"*/

// imports
import { area_maintenance } from '../../../../area_maintenance/js/area_maintenance.js';
import { request_failed, response_data } from '../../../../common/js/api_error.js';
import { data_manager } from '../../../../common/js/data_manager.js';
import { widget_common } from '../../../../widgets/widget_common/js/widget_common.js';
import { render_legacy_passwords } from './render_legacy_passwords.js';

/**
 * LEGACY_PASSWORDS
 * Maintenance widget: the accounts still on a Dédalo v6 password, and their
 * conversion to the current format (Argon2id), run FROM THE SERVER.
 *
 * After a migration from v6 an account whose password was never converted
 * cannot log in. The server counts those accounts (`get_value`) and converts
 * them (`migrate`) with the two v6 key values the administrator types — the
 * same conversion as the command line `bun run dedalo:migrate-passwords`.
 *
 * `this.value` (server get_value):
 *   { accounts, argon2, legacy, command, default_info_key, batch }
 *
 * The server examines at most `batch` accounts per request and answers a cursor
 * (`next_after`); `migrate` below walks the batches and adds their reports up.
 *
 * NOTHING SECRET IS KEPT HERE: the two typed values travel in the request body
 * of each batch and are never stored on the instance, logged, or written to
 * browser storage. No password value ever reaches the browser.
 *
 * Server peer: src/core/area_maintenance/widgets/legacy_passwords.ts
 * Door:        src/core/security/legacy_password_migration.ts
 */
export const legacy_passwords = function () {
	this.id;

	this.section_tipo;
	this.section_id;
	this.lang;
	this.mode;

	this.value;

	this.node;

	this.events_tokens = [];
	this.ar_instances = [];

	this.status;

	// the last run's summed report, kept across the refresh that follows it
	this.last_report = null;
}; //end legacy_passwords

/**
 * COMMON FUNCTIONS
 * extend functions from common
 */
// prototypes assign
// // lifecycle
legacy_passwords.prototype.init = widget_common.prototype.init;
legacy_passwords.prototype.build = widget_common.prototype.build;
legacy_passwords.prototype.render = widget_common.prototype.render;
legacy_passwords.prototype.refresh = widget_common.prototype.refresh;
legacy_passwords.prototype.destroy = widget_common.prototype.destroy;
legacy_passwords.prototype.get_value = area_maintenance.prototype.get_value;
// // render
legacy_passwords.prototype.edit = render_legacy_passwords.prototype.list;
legacy_passwords.prototype.list = render_legacy_passwords.prototype.list;

/**
 * EMPTY_REPORT
 * The sum a run starts from.
 * @param {boolean} execute
 * @returns {Object}
 */
export const empty_report = (execute) => {
	return {
		execute: execute === true,
		batches: 0,
		examined: 0,
		recoverable: 0,
		converted: 0,
		failed: 0,
		skipped: 0,
		remaining: null,
		failed_accounts: [],
	};
}; //end empty_report

/**
 * ADD_BATCH
 * Pure: one batch report added to the run's sum. The counts add up; `remaining`
 * is the LAST batch's (the server recounts it after each one); the accounts
 * that could not be converted are listed once each.
 * @param {Object} total - an empty_report(), or a previous add_batch result
 * @param {Object} batch - the server's report for one request
 * @returns {Object} a new sum (the input is not mutated)
 */
export const add_batch = (total, batch) => {
	const count = (name) => total[name] + (Number.isFinite(batch[name]) ? batch[name] : 0);
	const known = new Set(total.failed_accounts.map((account) => account.section_id));
	const failed_accounts = total.failed_accounts.concat(
		(Array.isArray(batch.failed_accounts) ? batch.failed_accounts : []).filter(
			(account) => !known.has(account.section_id),
		),
	);
	return {
		execute: total.execute,
		batches: total.batches + 1,
		examined: count('examined'),
		recoverable: count('recoverable'),
		converted: count('converted'),
		failed: count('failed'),
		skipped: count('skipped'),
		remaining: Number.isFinite(batch.remaining) ? batch.remaining : total.remaining,
		failed_accounts,
	};
}; //end add_batch

/**
 * NEXT_CURSOR
 * Pure: where the next batch starts, or null when the run is over. A cursor
 * that does not move forward ends the run — never a loop on the same accounts.
 * @param {number|null} previous - the cursor this batch was asked with
 * @param {Object} batch - the server's report
 * @returns {number|null}
 */
export const next_cursor = (previous, batch) => {
	const next = batch.next_after;
	if (!Number.isSafeInteger(next)) {
		return null;
	}
	return previous === null || next > previous ? next : null;
}; //end next_cursor

/**
 * MIGRATE
 * Run the conversion (or, dry, the check) over every legacy account, batch by
 * batch, and answer the summed report.
 * @param {Object} options
 * @param {string} options.information - the v6 DEDALO_INFORMATION ('' = the v6 default)
 * @param {string} options.info_key - the v6 DEDALO_INFO_KEY ('' = this entity)
 * @param {boolean} options.execute - true writes; anything else only checks
 * @param {function} [options.on_progress] - called with the running sum after each batch
 * @returns {Promise<{report:Object, error:(Object|null)}>} `error` is the API
 *   error of the batch that failed (the sum so far still stands), else null
 */
legacy_passwords.prototype.migrate = async (options) => {
	let report = empty_report(options.execute);
	let after = null;

	// bounded: a run is at most this many requests, whatever the server answers
	for (let i = 0; i < 100000; i++) {
		const api_response = await data_manager.request({
			use_worker: true,
			body: {
				dd_api: 'dd_area_maintenance_api',
				action: 'widget_request',
				prevent_lock: true,
				source: {
					type: 'widget',
					model: 'legacy_passwords',
					action: 'migrate',
				},
				options: {
					information: options.information || '',
					info_key: options.info_key || '',
					execute: options.execute === true,
					...(after === null ? {} : { after: after }),
				},
			},
			retries: 1, // one try only: a batch is never re-sent behind the operator's back
			timeout: 600 * 1000,
		});
		if (SHOW_DEBUG === true) {
			// counts and account names only — the server sends nothing else
			console.log('legacy_passwords migrate api_response:', api_response);
		}
		if (request_failed(api_response)) {
			return { report: report, error: api_response.error || {} };
		}
		// An answer that is neither a failure nor a report is NOT an empty batch:
		// counting it would end the run as if every account had been examined.
		const batch = response_data(api_response);
		if (!batch || typeof batch !== 'object' || !Number.isFinite(batch.examined)) {
			return {
				report: report,
				error: api_response?.error || {
					code: 'client.bad_response',
					label_key: 'error_client_bad_response',
					message: 'The server answered with an unreadable response',
				},
			};
		}
		report = add_batch(report, batch);
		if (typeof options.on_progress === 'function') {
			options.on_progress(report);
		}
		after = next_cursor(after, batch);
		if (after === null) {
			break;
		}
	}

	return { report: report, error: null };
}; //end migrate

// @license-end
