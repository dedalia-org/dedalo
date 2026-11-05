// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL, DEDALO_API_URL */
/*eslint no-undef: "error"*/

import { area_maintenance } from '../../../../area_maintenance/js/area_maintenance.js';
import {
	request_failed,
	response_data,
	response_extension,
} from '../../../../common/js/api_error.js';
// imports
import { data_manager } from '../../../../common/js/data_manager.js';
import { handle_api_error } from '../../../../common/js/error_dispatch.js';
import { dd_request_idle_callback } from '../../../../common/js/events.js';
import { error_text } from '../../../../common/js/render_api_error.js';
import { widget_common } from '../../../../widgets/widget_common/js/widget_common.js';
import { render_reconcile_status } from './render_reconcile_status.js';

/**
 * RECONCILE_STATUS
 * Widget controller for the "Reconcile" panel of the maintenance area — the
 * ONE door onto the server's reconcile registry (src/core/reconcile, S-10).
 *
 * Purpose:
 *   Lists every registered cross-store reconcile (the two stores it compares,
 *   its schedule, the last run this server process recorded) and runs one:
 *   CHECK (dry — reports drift, writes nothing) or APPLY (repairs).
 *
 * Data flow:
 *   `this.value` is fetched on open by area_maintenance.get_value:
 *     { reconciles: Array<{
 *         name, stores:[a,b], description, scope_label, schedule,
 *         auto_apply: string|null,
 *         last_run: {ranAt, apply, drift, applied, durationMs, deferred, refused, error}|null
 *     }> }
 *   `run_reconcile` posts {name, apply} and the response carries the fresh
 *   listing (`reconciles`) plus the run `report` and `record`.
 *
 * Server peer:  src/core/area_maintenance/widgets/reconcile_status.ts
 * Render peer:  ./render_reconcile_status.js
 */
export const reconcile_status = function () {
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
}; //end reconcile_status

/**
 * COMMON FUNCTIONS
 * extend functions from common
 */
// prototypes assign
// lifecycle
reconcile_status.prototype.init = widget_common.prototype.init;
reconcile_status.prototype.build = widget_common.prototype.build;
reconcile_status.prototype.render = widget_common.prototype.render;
reconcile_status.prototype.refresh = widget_common.prototype.refresh;
reconcile_status.prototype.destroy = widget_common.prototype.destroy;
reconcile_status.prototype.get_value = area_maintenance.prototype.get_value;
// render
reconcile_status.prototype.edit = render_reconcile_status.prototype.list;
reconcile_status.prototype.list = render_reconcile_status.prototype.list;

/**
 * RUN_RECONCILE
 * Run ONE registered reconcile. DRY unless `options.apply===true`.
 *
 * On success the server message is written to body_response (textContent —
 * it names stores, tipos and file names), the fresh listing replaces
 * `this.value.reconciles`, and the panel re-renders. On error the coded error
 * goes through handle_api_error().
 *
 * @param {Object} options
 * @param {HTMLElement} options.body_response - node that receives the status text.
 * @param {string} options.name - the registered reconcile name.
 * @param {boolean} [options.apply=false] - repair instead of report.
 * @param {string[]} [options.scope] - narrow the run (the row's scope_label values); omitted = all.
 * @returns {Promise<boolean>}
 */
reconcile_status.prototype.run_reconcile = async function (options) {
	const body_response = options.body_response;

	const api_response = await data_manager.request({
		use_worker: true,
		body: {
			dd_api: 'dd_area_maintenance_api',
			action: 'widget_request',
			prevent_lock: true,
			source: {
				type: 'widget',
				model: 'reconcile_status',
				action: 'run_reconcile',
			},
			options: {
				name: options.name,
				apply: options.apply === true,
				...(Array.isArray(options.scope) ? { scope: options.scope } : {}),
			},
		},
		retries: 1, // one try only: a reconcile must never be re-run behind the operator's back
		timeout: 3600 * 1000, // 1 hour: several walk a whole store
	});
	if (SHOW_DEBUG === true) {
		console.log('run_reconcile api_response:', api_response);
	}

	if (request_failed(api_response) === false && response_data(api_response) === true) {
		// SEC-XSS-011: the message names stores, tipos and file names from disk.
		body_response.textContent = response_extension(api_response, 'msg');
		this.last_report = response_extension(api_response, 'report') || null;

		if (Array.isArray(api_response.reconciles)) {
			this.value = this.value || {};
			this.value.reconciles = api_response.reconciles;
		}
		dd_request_idle_callback(() => {
			this.refresh({ build_autoload: false, destroy: true });
		});
	} else {
		console.error('reconcile_status run_reconcile failed:', api_response);
		body_response.textContent = request_failed(api_response)
			? error_text(api_response.error)
			: response_extension(api_response, 'msg') || 'Unknown error';
		if (request_failed(api_response)) {
			await handle_api_error(api_response.error, { wrapper: body_response });
		}
	}

	return true;
}; //end run_reconcile

// @license-end
