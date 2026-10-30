/**
 * update_code widget (UPDATE_PROCESS Phase 4) — the CONSUMER side: panel + the
 * code-update EXECUTE. The PUBLISH side (release build + code-server readout)
 * is serve_code.ts since 2026-09-28.
 * Panel (PHP update_code::get_value): the configured CODE_SERVERS probed for
 * reachability, the consumer readiness readout, and whether this instance is
 * itself a code server (a self-report only; the build panel is serve_code).
 * update_code EXECUTE: ownership-gated. Closed keeps the frozen engine_denied;
 * open downloads the selected release, verifies + extracts + swaps the TS
 * tree, and restarts (core/update/code_update.ts, WC-024).
 * restore_code EXECUTE: ownership-gated; open puts a RESTORE POINT back on the
 * tree — the same swap, run in reverse (core/update/code_restore.ts).
 * request_image_update / cancel_image_update_request (2026-10-09): on a
 * container installation, record (or withdraw) a request the opt-in HOST
 * updater claims — the engine never touches docker
 * (core/update/image_update_request.ts, WC-2026-10-09-update-code-image-channel).
 */

import { config } from '../../../config/config.ts';
import type { Principal } from '../../security/permissions.ts';
import {
	engineDenied,
	fromEnvelope,
	gated,
	refuseAction,
	type WidgetModule,
	type WidgetResponse,
} from './support.ts';

/**
 * The operator sentence of each request refusal. The CLIENT words them from
 * labels keyed by `coordinates.reason` (update_code_image_refused_<reason>);
 * this sentence is the error envelope's own public message, for the log and
 * any surface that does not know the id.
 */
const IMAGE_REQUEST_REFUSALS: Readonly<Record<string, string>> = Object.freeze({
	not_image_channel:
		'Error. This installation does not run from a container image; update it with the code update.',
	host_updater_not_alive:
		'Error. The host updater is not running on the Docker host; run the update command there instead.',
	request_pending: 'Error. An image update is already requested or running.',
	malformed_version: 'Error. Invalid release version.',
	version_refused: 'Error. That release is not on the upgrade path from the running version.',
	request_claimed:
		'Error. The host updater has already started this update; it can no longer be cancelled.',
	no_request: 'Error. There is no pending image update request.',
});

/** Refuse with the reason id in the coordinates (and the walk verdict, when there is one). */
function refuseImageRequest(reason: string, walk?: string, message?: string): never {
	// The refusal's own sentence (a nightly names itself: nightlyImageMessage) wins over the
	// generic line for its id.
	refuseAction(
		message !== undefined
			? `Error. ${message}`
			: (IMAGE_REQUEST_REFUSALS[reason] ?? `Error. ${reason}`),
		{
			reason,
			...(walk === undefined ? {} : { walk }),
		},
	);
}

/**
 * update_code panel.
 *
 * The CONSUMER role only (since 2026-09-28 the publish half is its own widget,
 * serve_code.ts — WC-2026-09-28-maintenance-serve-code-widget):
 *  - `consumer` — the readiness readout (core/update/status.ts): every gate the
 *    update pipeline would refuse on, asked through the SAME predicates, plus
 *    the running build's provenance, the last update's sentinel and the
 *    restore points on disk. Before 2026-08-24 every one of those refusals was
 *    discoverable only by pressing the button and reading the failure.
 *
 * COVERAGE-EXEMPT (coverage plan §5.1; reason registered in
 * engineering/crap_coverage_exempt.json): a NETWORK probe loop over
 * `config.update.codeServers`, which is EMPTY on every default install (so the
 * loop body is unreachable there), spreading `checkRemoteServer`'s own response
 * fields. A gate would either assert an empty loop or make an outbound request.
 * The status halves it now spreads are gated in update_status_native.test.ts.
 */
async function updateCodeGetValue(
	_options: Record<string, unknown>,
	principal: Principal,
): Promise<WidgetResponse> {
	const { checkRemoteServer } = await import('../../ontology/data_io_import.ts');
	const servers: Record<string, unknown>[] = [];
	for (const server of config.update.codeServers) {
		// Reuse the ontology transport probe (same get_server_ready_status POST),
		// asking for the CODE role: a code-only master refuses the ontology check.
		const probe = await checkRemoteServer({ ...server }, 'code_server');
		servers.push({
			...server,
			msg: probe.msg,
			errors: probe.errors,
			response_code: probe.code,
			// The REMOTE's own decoded body; `result` is the panel key the client
			// reads (the probe's own outcome field is `data` since the P1 sweep).
			result: probe.data,
		});
	}
	const { consumerStatus } = await import('../../update/status.ts');
	return {
		data: {
			servers,
			// dedalo_source_version_local_dir dropped (2026-08-23): the engine
			// ignores DEDALO_SOURCE_VERSION_LOCAL_DIR entirely — staging is
			// <DEDALO_BACKUP_PATH>/.code_staging — and the client no longer
			// displays it. The config-catalog key is a retirement candidate.
			is_a_code_server: config.update.isCodeServer,
			consumer: await consumerStatus(principal),
		},
	};
}

/**
 * The OPEN (owned) code-update: a BACKGROUND mediaJobs job running the full
 * pipeline (download + verify + extract + deps + preflight + swap + restart);
 * the immediate answer is the {pid, pfile} poll handle the maintenance client
 * feeds to dd_utils_api:get_process_status, and the pipeline's phase frames
 * (core/update/code_update.ts UpdatePhaseFrame) ride the job's `data`.
 *
 * KNOWN LIMIT, BY DESIGN: the restart phase kills THIS process, which orphans
 * the in-process job — core/api/process_status.ts's dead-owner reconcile then
 * emits a terminal `interrupted` frame. That is the designed HANDOFF: the
 * client saw `phase:'restart'` with `expected_version` first, so it switches
 * to polling GET /health (which now carries `version`) instead of treating the
 * interruption as a failure. Do not "fix" the interruption away.
 *
 * COVERAGE-EXEMPT (coverage plan §5.2; reason registered in
 * engineering/crap_coverage_exempt.json): a thin job-submission wrapper over
 * `core/update/code_update.ts`, gated in its own suite. EXECUTING it replaces
 * the code tree on disk and restarts the process.
 */
async function updateCodeOwned(
	options: Record<string, unknown>,
	principal: Principal,
): Promise<WidgetResponse> {
	const { codeRunAnswer, startCodeUpdateRun } = await import('../../update/run/start.ts');
	const { mediaJobs } = await import('../../media/jobs.ts');
	const record = mediaJobs.submit(
		'update_code',
		async ({ onData, signal }) => {
			// THE UPDATE RUN (update audit 2026-10-29, Phase 2.6): the swap is one
			// phase of a journaled run — ontology preconditions before it, schema /
			// data / ancillary after the restart, confirm only on VERIFIED
			// (core/update/run/). core/update/** REFUSES BY THROWING (update.refused /
			// update.failed); the swap's phase frames stream through the job's data
			// channel. The job's signal lets a STOP end the run before the swap.
			const outcome = await startCodeUpdateRun(options, principal, {
				onPhase: (frame) => onData(frame),
				signal,
			});
			// The swap's own envelope (the panel hands over to the /health poll on
			// its version), the run's id and state beside it.
			return codeRunAnswer(outcome.journal);
		},
		// THE lane starvation this class exists to end: an operator's code update
		// must never queue behind a transcode backlog (PERF-11).
		{ lane: 'maintenance', userId: principal.userId },
	);
	return {
		data: true,
		msg: `OK. Running publication ${process.pid}`,
		// In-process job: the server process runs it (same shape as
		// update_data_version's background branch — the client polls
		// dd_utils_api:get_process_status with {pid, pfile}).
		extend: { pid: process.pid, pfile: `${record.id}.json` },
	};
}

/**
 * The OPEN (owned) restore-point DELETE — synchronous, unlike its two
 * neighbours, and deliberately.
 *
 * `update_code` and `restore_code` submit background jobs because they end in a
 * server restart that kills the caller. A delete ends in a directory being gone
 * (or not), and that answer IS the product: `deleteRestorePoint` re-checks the
 * path after removing it and refuses when anything survives, so the operator
 * gets a verdict instead of a submission receipt. Measured 2026-08-28 on a
 * Docker Desktop bind mount: an `rm` that reports success and leaves the
 * directory behind is exactly the case a job handle would have hidden.
 */
async function deleteRestorePointOwned(
	options: Record<string, unknown>,
	principal: Principal,
): Promise<WidgetResponse> {
	const { deleteRestorePoint } = await import('../../update/code_restore.ts');
	return fromEnvelope(await deleteRestorePoint(options, principal));
}

/**
 * The OPEN (owned) code RESTORE: a BACKGROUND mediaJobs job putting a restore
 * point back on the tree (pre-flight smoke boot + swap + restart), answering
 * the same {pid, pfile} poll handle and streaming the same
 * `UpdatePhaseFrame`s — `download`/`verify`/`extract`/`deps` arrive `skipped`,
 * so the client's phase reducer needs no restore-specific branch.
 *
 * The SAME known limit as the update, by design: the restart kills this
 * process and orphans the job, and the client switches to /health polling on
 * the `restart` frame's `expected_version`. Do not "fix" the interruption away.
 *
 * COVERAGE-EXEMPT (coverage plan §5.2; reason registered in
 * engineering/crap_coverage_exempt.json): a thin job-submission wrapper over
 * `core/update/code_restore.ts`, gated in its own suite. EXECUTING it replaces
 * the code tree on disk and restarts the process.
 */
async function restoreCodeOwned(
	options: Record<string, unknown>,
	principal: Principal,
): Promise<WidgetResponse> {
	const { restoreCode } = await import('../../update/code_restore.ts');
	const { holdUpdateRunLock } = await import('../../update/door_class.ts');
	const { mediaJobs } = await import('../../media/jobs.ts');
	const record = mediaJobs.submit(
		'restore_code',
		async ({ onData }) =>
			// core/update/** REFUSES BY THROWING (update.refused / update.failed);
			// phase frames stream through the job's data channel as it advances.
			// A destructive door's job holds the UPDATE_RUN lock for its life
			// (core/update/door_class.ts) — the restart ends it with the session.
			holdUpdateRunLock('restore_code', () =>
				restoreCode(options, principal, { onPhase: (frame) => onData(frame) }),
			),
		// Same lane as the update it rolls back (PERF-11).
		{ lane: 'maintenance', userId: principal.userId },
	);
	return {
		data: true,
		msg: `OK. Running publication ${process.pid}`,
		extend: { pid: process.pid, pfile: `${record.id}.json` },
	};
}

/**
 * The OPEN image-update REQUEST: records a request the host updater claims
 * (core/update/image_update_request.ts — the gates and why each one). The
 * preconditions' own typed errors propagate; every other refusal carries its
 * id in `coordinates.reason`.
 */
async function requestImageUpdateOwned(
	options: Record<string, unknown>,
	principal: Principal,
): Promise<WidgetResponse> {
	const { requestImageUpdate } = await import('../../update/image_update_request.ts');
	const result = await requestImageUpdate(options, principal);
	if (!result.ok) refuseImageRequest(result.reason, result.walk, result.message);
	return { data: { request: result.request } };
}

/** The OPEN withdrawal of an UNCLAIMED image-update request (superuser only). */
async function cancelImageUpdateRequestOwned(
	_options: Record<string, unknown>,
	principal: Principal,
): Promise<WidgetResponse> {
	const { cancelImageUpdateRequest } = await import('../../update/image_update_request.ts');
	const result = cancelImageUpdateRequest(principal);
	if (!result.ok) refuseImageRequest(result.reason);
	return { data: { cancelled: true } };
}

export const widget: WidgetModule = {
	spec: {
		id: 'update_code',
		category: 'config',
		label: { kind: 'label_concat', keys: ['update', 'code'] },
	},
	apiActions: {
		// Ownership-gated (UPDATE_PROCESS Phase 4): closed = frozen engine_denied.
		update_code: gated(
			'update_code.update_code',
			engineDenied('update_code.update_code', 'it downloads and REPLACES the PHP code tree'),
			updateCodeOwned,
		),
		restore_code: gated(
			'update_code.restore_code',
			engineDenied('update_code.restore_code', 'it REPLACES the live code tree with a backup copy'),
			restoreCodeOwned,
		),
		delete_restore_point: gated(
			'update_code.delete_restore_point',
			engineDenied('update_code.delete_restore_point', 'it DELETES a code backup copy'),
			deleteRestorePointOwned,
		),
		request_image_update: gated(
			'update_code.request_image_update',
			engineDenied(
				'update_code.request_image_update',
				'it asks the Docker host to REPLACE the image',
			),
			requestImageUpdateOwned,
		),
		cancel_image_update_request: gated(
			'update_code.cancel_image_update_request',
			engineDenied(
				'update_code.cancel_image_update_request',
				'it withdraws a pending image update request',
			),
			cancelImageUpdateRequestOwned,
		),
	},
	getValue: updateCodeGetValue,
};
