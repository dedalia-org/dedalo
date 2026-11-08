// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label */
/*eslint no-undef: "error"*/

/**
 * MOVE_TRANSFORM
 * The ONE run flow of the five move_* maintenance widgets (move_lang,
 * move_locator, move_tld, move_to_portal, move_to_table): PREVIEW first, then
 * EXECUTE the very selection that was previewed.
 *
 * WHY. The server runs a move_* transform only when `dry_run` is EXACTLY false
 * (WC-025); anything else is a dry run. The widgets used to send no `dry_run`
 * at all, so the panel could only ever preview — no control reached the
 * execute. Both runs are server JOBS answering `{pid, pfile}` at once
 * (WC-2026-09-30-move-transform-execute-job); the job stream renders here.
 *
 * THE FLOW.
 *  1. The form's submit runs the PREVIEW (dry_run: true) of the checked files
 *     and streams its job.
 *  2. Only a preview that ENDED CLEAN (no coded error, report ok, a dry run —
 *     dry_run_cleared) reveals the Execute button, bound to a SNAPSHOT of the
 *     files that were previewed — and only the LATEST preview: a superseded
 *     one's late end is ignored.
 *  3. Execute refuses when the checked files changed since the preview (the
 *     operator must preview what runs), asks for an explicit confirm, then runs
 *     the snapshot with dry_run: false and streams that job. The button is
 *     hidden again: a new execute needs a new preview.
 *  A run the server REFUSES (no job: a bad option, a lost session) is stated
 *  in the panel (render_refusal) — never only a toast the area does not show.
 *  A run whose submission outcome is UNKNOWN (outcome_unknown: a deadline or a
 *  dropped connection after the request may have landed, or the server's own
 *  idempotency "do not know") is NOT a refusal: the job may be running, and
 *  the panel says so (render_outcome_unknown) instead of inviting a second run.
 *  AN EXECUTE OWNS THE PANEL UNTIL IT ENDS. The form does not lock while a job
 *  streams, but while an execute job runs (or its submission outcome is
 *  unknown) no other run starts: a Preview would empty the panel the execute
 *  streams into and take its re-attach entry, and the outcome of a transform
 *  that cannot be undone (rolled back, PARTIAL, UNKNOWN) would never reach the
 *  operator. The execute is tracked under its OWN IndexedDB key
 *  (`<local_db_id>_execute`), and the re-attach after a reload lives HERE (not
 *  in the widgets): a stored execute is re-attached first and holds the form
 *  again until its job ends; otherwise a stored preview is re-attached.
 *
 * Backend-free gate: client/dedalo/test/client/js/test_move_transform.js.
 */

import { request_failed } from '../../common/js/api_error.js';
import { update_process_status } from '../../common/js/common.js';
import { data_manager } from '../../common/js/data_manager.js';
import { outcome_unknown } from '../../common/js/error_dispatch.js';
// imports
import { error_lines } from '../../common/js/render_api_error.js';
import { ui } from '../../common/js/ui.js';

/**
 * MOVE_TRANSFORM_REQUEST_BODY
 * The widget_request body of one run. `dry_run` is ALWAYS sent explicitly:
 * true = preview, false = execute (the server mutates only on exactly false).
 * @param {string} model - widget id, e.g. 'move_tld' (also the action name)
 * @param {Array<string>} files_selected - definition file names
 * @param {boolean} dry_run
 * @returns {Object} body
 */
export const move_transform_request_body = function (model, files_selected, dry_run) {
	return {
		dd_api: 'dd_area_maintenance_api',
		action: 'widget_request',
		prevent_lock: true,
		source: {
			type: 'widget',
			model: model,
			action: model,
		},
		options: {
			background_running: true, // the server answers {pid, pfile}: both runs are jobs
			files_selected: [...files_selected],
			dry_run: dry_run === false ? false : true,
		},
	};
}; //end move_transform_request_body

/**
 * EXEC_MOVE_TRANSFORM
 * Fire one run. Resolves to the API response ({pid, pfile, dry_run} on success).
 * @param {string} model
 * @param {Array<string>} files_selected
 * @param {boolean} dry_run
 * @returns {Promise<Object>} api_response
 */
export const exec_move_transform = async function (model, files_selected, dry_run) {
	return data_manager.request({
		body: move_transform_request_body(model, files_selected, dry_run),
		retries: 1, // one try only: a run may already be submitted
		timeout: 60 * 1000, // the door only submits the job
	});
}; //end exec_move_transform

/**
 * DRY_RUN_CLEARED
 * Whether a job's FINAL frame is a preview that ended clean: not running, no
 * coded `error` (a failed run ends with one — ERRORS_SPEC §5.3), the report
 * `ok`, and a dry run.
 * @param {Object|null} frame - the last get_process_status frame
 * @returns {boolean}
 */
export const dry_run_cleared = function (frame) {
	if (!frame || frame.is_running !== false || frame.error) {
		return false;
	}
	const data = frame.data || {};

	return data.ok === true && data.dry_run === true;
}; //end dry_run_cleared

/**
 * SAME_SELECTION
 * Order-insensitive equality of two file-name lists.
 * @param {Array<string>} a
 * @param {Array<string>} b
 * @returns {boolean}
 */
const same_selection = function (a, b) {
	if (a.length !== b.length) {
		return false;
	}
	const sorted_b = [...b].sort();

	return [...a].sort().every((name, i) => name === sorted_b[i]);
}; //end same_selection

/**
 * RENDER_REFUSAL
 * The panel's statement of a refused run: the label in the operator's language
 * first (error_text), then the server's own sentence when it says more, then
 * the request_id (the join key with the server log). Text nodes only — server
 * text never reaches an HTML sink.
 * @param {Object} api_error - the envelope's `error` (an ApiError)
 * @returns {HTMLElement}
 */
const render_refusal = function (api_error) {
	return render_error_lines('api_response error move_transform_refused', [], api_error);
}; //end render_refusal

/**
 * RENDER_OUTCOME_UNKNOWN
 * The panel's statement of a run whose SUBMISSION outcome is unknown: the
 * request may have reached the server (the engine runs an aborted request to
 * completion), so the job may be running. Says so first — before the cause —
 * because the dangerous reading is "refused, run it again": a second execute
 * of a transform that cannot be undone. No job is tracked (there is no pid);
 * the operator checks the running jobs before acting.
 * @param {Object} api_error - the envelope's `error` (an ApiError)
 * @returns {HTMLElement}
 */
const render_outcome_unknown = function (api_error) {
	return render_error_lines(
		'api_response error move_transform_outcome_unknown',
		[
			'The server did not confirm this run: it may have started and may still be running. ' +
				'Check the running jobs (or the data) before running it again.',
		],
		api_error,
	);
}; //end render_outcome_unknown

/**
 * RENDER_ERROR_LINES
 * One panel node: the given lead lines, then the error label-first plus the
 * server's own sentence when it says more (error_lines), and the request_id (the join key
 * with the server log). Text nodes only — server text never reaches an HTML sink.
 * @param {string} class_name
 * @param {Array<string>} lead_lines
 * @param {Object} api_error
 * @returns {HTMLElement}
 */
const render_error_lines = function (class_name, lead_lines, api_error) {
	const node = ui.create_dom_element({
		element_type: 'div',
		class_name: class_name,
	});
	const lines = [...lead_lines, ...error_lines(api_error)];
	if (typeof api_error?.request_id === 'string' && api_error.request_id.length) {
		lines.push(`request_id: ${api_error.request_id}`);
	}
	lines.forEach((line, i) => {
		if (i > 0) node.appendChild(document.createElement('br'));
		node.appendChild(document.createTextNode(line));
	});

	return node;
}; //end render_error_lines

/**
 * INIT_MOVE_TRANSFORM_FORM
 * Wire the preview form + the execute control into a move_* widget body.
 * @param {Object} self - the widget instance (self.caller.init_form)
 * @param {Object} options
 *	model			{string} widget id
 *	submit_label	{string} what the run does, e.g. 'Move TLD terms'
 *	files_selected	{Array<string>} the LIVE checked-files array (mutated by the checkboxes)
 *	content_data	{HTMLElement} form container (body_info)
 *	body_response	{HTMLElement} job stream container
 *	local_db_id		{string} IndexedDB key of the running job, e.g. 'process_move_tld'
 * @param {Object} [deps] - injectable effects (the backend-free gate):
 *	exec			{Function} (model, files, dry_run) => Promise<api_response>
 *	track			{Function} (local_db_id, pid, pfile, container, on_done(frame))
 *	confirm			{Function} (text) => boolean
 *	alert			{Function} (text) => void
 *	read_local		{Function} (id) => Promise<{value:{pid,pfile}}|null> — the stored job of a key
 * @returns {Object} {execute_button} - the execute control node
 */
export const init_move_transform_form = function (self, options, deps = {}) {
	// options
	const model = options.model;
	const submit_label = options.submit_label;
	const files_selected = options.files_selected;
	const content_data = options.content_data;
	const body_response = options.body_response;
	const local_db_id = options.local_db_id;

	// deps
	const exec = deps.exec || exec_move_transform;
	const track =
		deps.track ||
		((id, pid, pfile, container, on_done) => {
			update_process_status(id, pid, pfile, container, 1000, on_done);
		});
	const ask = deps.confirm || ((text) => window.confirm(text));
	const notify = deps.alert || ((text) => window.alert(text));
	const read_local = deps.read_local || ((id) => data_manager.get_local_db_data(id, 'status'));

	// execute_db_id: the execute's OWN re-attach key — a preview never writes or
	// deletes it (render_stream keys the stored {pid, pfile} by the tracked id)
	const execute_db_id = `${local_db_id}_execute`;
	// execute_hold: why no run may start now — null (free), 'running' (an
	// execute job streams in body_response) or 'unknown' (an execute's
	// submission outcome is unknown: the job may be running, and the panel's
	// warning must stay; a reload frees the form)
	let execute_hold = null;
	const release_execute = () => {
		execute_hold = null;
	};

	// previewed: the snapshot of the files the last CLEAN preview ran on
	let previewed = null;
	// preview_generation: stamps each preview. The form does not lock while a
	// job streams, so two previews can be in flight; only the LATEST one may
	// reveal Execute — a superseded preview's late clean end is ignored (else a
	// stale clean run would arm Execute after the operator's newer one failed).
	let preview_generation = 0;

	// run: fire one run and stream its job; on_done gets the final frame.
	// Resolves to what became of the submission: 'tracked' | 'refused' |
	// 'unknown' | 'no_job'.
	const run = (files, dry_run, on_done) => {
		return exec(model, files, dry_run).then(function (api_response) {
			// A REFUSED run (no job exists) is stated IN the panel, label-first.
			// Not handle_api_error: its policy for most codes is a toast, and the
			// maintenance area shows no toast surface — the refusal reached the
			// console only. The page-wide policy (relogin on auth.*) already ran:
			// the transport publishes every failed request's ApiError
			// (data_manager → page.js).
			// An UNKNOWN outcome is not a refusal: the job may be running.
			if (request_failed(api_response)) {
				const unknown = outcome_unknown(api_response.error);
				body_response.replaceChildren(
					unknown ? render_outcome_unknown(api_response.error) : render_refusal(api_response.error),
				);
				return unknown ? 'unknown' : 'refused';
			}
			if (!api_response || api_response.pid === undefined || !api_response.pfile) {
				notify('Error: the server did not start the job');
				return 'no_job';
			}
			track(
				dry_run ? local_db_id : execute_db_id,
				api_response.pid,
				api_response.pfile,
				body_response,
				on_done,
			);
			return 'tracked';
		});
	};

	// hold_refusal: the operator's notice when a run is asked for while held
	const hold_refusal = () => {
		notify(
			execute_hold === 'unknown'
				? 'The last execute was not confirmed and may still be running. ' +
						'Check the running jobs (or the data), then reload the page before starting another run.'
				: 'An execute is still running: its outcome is shown in the panel. ' +
						'Wait for it to end before starting another run.',
		);
	};

	// reattached: the re-attach after a reload (or a widget re-open). A stored
	// EXECUTE comes first and holds the form until its job ends; otherwise a
	// stored preview is re-attached (it never reveals Execute: the snapshot it
	// ran on is gone). A run asked for meanwhile waits for this read.
	const stored_job = (entry) =>
		entry?.value && entry.value.pid !== undefined && typeof entry.value.pfile === 'string'
			? entry.value
			: null;
	const reattached = (async () => {
		const stored_execute = stored_job(await read_local(execute_db_id));
		if (stored_execute) {
			execute_hold = 'running';
			track(
				execute_db_id,
				stored_execute.pid,
				stored_execute.pfile,
				body_response,
				release_execute,
			);
			return;
		}
		const stored_preview = stored_job(await read_local(local_db_id));
		if (stored_preview) {
			track(local_db_id, stored_preview.pid, stored_preview.pfile, body_response, null);
		}
	})().catch((error) => {
		console.error('move_transform: re-attach failed', error);
	});

	// execute_button. Hidden until a preview ends clean.
	const execute_button = ui.create_dom_element({
		element_type: 'button',
		class_name: 'warning button_execute_move hide',
		text_content: `Execute: ${submit_label}`,
	});
	execute_button.type = 'button';
	execute_button.addEventListener('click', function (e) {
		e.stopPropagation();
		if (previewed === null) {
			return;
		}
		if (execute_hold !== null) {
			hold_refusal();
			return;
		}
		if (!same_selection(previewed, files_selected)) {
			notify('The selected files changed since the preview. Run the preview again.');
			return;
		}
		const text =
			`Execute ${model} on ${previewed.join(', ')}?\n` +
			'This rewrites stored data. A locator move cannot be undone.';
		if (!ask(text)) {
			return;
		}
		const files = previewed;
		previewed = null;
		execute_button.classList.add('hide');
		// the execute holds the form from its dispatch: released by its job's
		// end, or at once when no job exists (refused / not started); an UNKNOWN
		// outcome keeps it held — the job may be running
		execute_hold = 'running';
		run(files, false, release_execute).then(
			(outcome) => {
				if (outcome === 'unknown') {
					execute_hold = 'unknown';
				} else if (outcome !== 'tracked') {
					release_execute();
				}
			},
			(error) => {
				release_execute();
				console.error('move_transform: execute dispatch failed', error);
			},
		);
	});

	// form: the submit is the PREVIEW
	if (self.caller?.init_form) {
		self.caller.init_form({
			submit_label: `Preview: ${submit_label} (dry run)`,
			confirm_text: 'Run the preview (dry run)? It writes nothing.',
			body_info: content_data,
			body_response: body_response,
			on_submit: async () => {
				await reattached;
				if (execute_hold !== null) {
					hold_refusal();
					return;
				}
				if (!files_selected.length) {
					notify('Error: no files are selected');
					return;
				}
				const snapshot = [...files_selected];
				const generation = ++preview_generation;
				previewed = null;
				execute_button.classList.add('hide');
				return run(snapshot, true, (frame) => {
					if (generation !== preview_generation || !dry_run_cleared(frame)) {
						return;
					}
					previewed = snapshot;
					execute_button.classList.remove('hide');
				});
			},
		});
	}
	content_data.appendChild(execute_button);

	return {
		execute_button,
	};
}; //end init_move_transform_form

// @license-end
