/**
 * dd_diffusion_api — client-facing diffusion actions (DIFFUSION_SPEC §4.2).
 *
 * Served from the MAIN API dispatcher (control plane): the byte-identical
 * tool_diffusion client reaches these through its DEDALO_DIFFUSION_API_URL
 * fallback with ZERO edits. Wire shapes are pinned verbatim against the old
 * engine (test/parity/fixtures/diffusion/pinned.ts):
 *
 * - diffuse .............. enqueue durable job → SSE stream over its progress
 * - get_process_status ... SSE poll stream by client process_id (reconnect)
 * - list_processes ....... ok({ processes: progress_data[] })
 * - cancel_process ....... ok({ cancelled, message })
 * - sweep_published_langs  ok(report) — the published-lang coherence audit
 *   and, only when explicitly confirmed, the removal of the target rows whose
 *   lang the publication policy no longer names (targets/mariadb/lang_sweep.ts).
 *
 * AUTHORIZATION (stronger than the old engine): every action runs behind the
 * dispatch gates (session, CSRF, allowlist); diffuse additionally requires
 * read permission on the source section (PHP SEC-13); status/cancel/list are
 * OWNER-SCOPED (global admins see all) — id knowledge alone grants nothing
 * (the old engine accepted any authenticated cookie for any process id).
 *
 * Progress transport is POLL-based over the durable job row (500ms/update_rate
 * cadence — the same cadence the old engine's status stream used). The
 * pg_notify emitted by the queue is forward-compatibility for a LISTEN-based
 * push upgrade; nothing depends on it yet (ledgered in STATUS.md).
 */

import { config } from '../../config/config.ts';
import { incrementCounter } from '../../core/api/counters.ts';
import { type ApiResult, streamResult } from '../../core/api/response.ts';
import type { Rqo } from '../../core/concepts/rqo.ts';
import { sanitizeClientSqo } from '../../core/concepts/sqo.ts';
import { DedaloError, type ErrorCode, ok } from '../../core/errors/index.ts';
import type { Principal } from '../../core/security/permissions.ts';
import { getPermissions } from '../../core/security/permissions.ts';
import { currentRequestContext } from '../../core/security/request_context.ts';
import type { DiffusionJobRow } from '../jobs/queue.ts';
import {
	enqueueDiffusionJob,
	getJobByClientProcessId,
	getOwnedJobById,
	listActiveJobs,
	listJobsForCaller,
	requestCancel,
} from '../jobs/queue.ts';
import {
	getMaxRunners,
	isSchedulerDraining,
	isSchedulerPaused,
	STALE_AFTER_SECONDS,
	schedulerTick,
} from '../jobs/scheduler.ts';
import type { QueueFrame } from '../jobs/sse.ts';
import {
	encodeQueueSseChunk,
	encodeSseChunk,
	encodeSseCommentHeartbeat,
	notFoundProgressData,
	progressDataFromJob,
	queueJobView,
	sseResponseHeaders,
} from '../jobs/sse.ts';
import { diffusionResolveLevels } from '../plan/compile.ts';
import {
	auditPublishedLangs,
	type LangCoherenceReport,
	OPERATOR_AUDIT_BUDGET,
	sweepPhantomLangs,
} from '../targets/mariadb/lang_sweep.ts';

/**
 * THE JOB-ROW RETENTION DOOR, on the facade for the same reason the audit above
 * is: the core RETENTION REGISTRY (src/core/retention/) states a rule for every
 * append-only store the engine writes, and the diffusion jobs table is one of
 * them — but core may reach diffusion only through here, never into
 * jobs/queue.ts. The window itself (terminal rows at 7 days) stays owned by the
 * diffusion scheduler; this exports the ABILITY TO RUN it on demand.
 */
export { purgeTerminalJobs } from '../jobs/queue.ts';
/**
 * The job elapsed-time formatter, re-exported through the FACADE — ONE
 * definition, in jobs/sse.ts. The diffusion_server_control widget prints a
 * finished job's total time with it, so the queue table and tool_diffusion's
 * progress line show the same figure.
 */
export { formatElapsed } from '../jobs/sse.ts';
/**
 * The published-lang coherence audit, re-exported through the FACADE — ONE
 * definition, in targets/mariadb/lang_sweep.ts. src/core/ may read it (the
 * check_config maintenance widget's coherence row does) and
 * boundary_seam_tripwire allows a core→diffusion pair only when it targets
 * src/diffusion/api/, so this door is what keeps that widget off the internals.
 */
export {
	auditPublishedLangs,
	type LangCoherenceReport,
	OPERATOR_AUDIT_BUDGET,
	WIDGET_AUDIT_BUDGET,
} from '../targets/mariadb/lang_sweep.ts';

/** Old-engine cadences (pinned): 2s state re-send on diffuse; 15s ":\n" on status. */
const DIFFUSE_HEARTBEAT_MS = 2000;
const STATUS_COMMENT_HEARTBEAT_MS = 15000;
const STATUS_DEFAULT_UPDATE_RATE_MS = 1000;
/** Poll cadence for change detection on the diffuse stream. */
const DIFFUSE_POLL_MS = 500;

/**
 * REFUSE BY THROWING (engineering/ERRORS_SPEC.md §4): the dispatch chokepoint
 * converts, with the status the registry gives the code. `publicMessage` is
 * honoured only for public-disclosure codes; for the rest the sentence is the
 * LOG line and the wire carries the registry's.
 */
function refuse(code: ErrorCode, message: string): never {
	throw new DedaloError(code, { message, publicMessage: message });
}

/**
 * The request id these actions' envelopes carry. They are dispatch handlers, so
 * they always run inside dispatchRqo's request-identity scope; '' is the
 * defensive floor for a direct (test) call outside one.
 */
function requestId(): string {
	return currentRequestContext()?.requestId ?? '';
}

/** Client label grammar: 'process_diffusion_{user}_{element}_{section}' and kin. */
const CLIENT_PROCESS_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;

/** Admins observe every run; everyone else only their own (null = unscoped). */
function ownerScope(principal: Principal): number | null {
	return principal.isGlobalAdmin ? null : principal.userId;
}

/**
 * Build an SSE stream that follows ONE job until it leaves the running states.
 * `resolveJob` re-reads the row each poll (the stream survives runner
 * restarts — it observes the durable row, not a process). Emits on every
 * observable change, re-sends current state as the heartbeat (old diffuse
 * behavior), closes after the terminal chunk. A poll DB error is caught in
 * place: terminal error chunk + close (never a floating rejection — Bun kills
 * the whole process on the first one — and never a hung client stream).
 * Exported for the crash-survival gate (test/unit/diffusion_sse_resilience).
 */
export function buildJobFollowStream(
	resolveJob: () => Promise<DiffusionJobRow | null>,
	processIdForNotFound: string,
	pollMs: number,
	options: { commentHeartbeat: boolean },
): ReadableStream<Uint8Array> {
	let pollTimer: ReturnType<typeof setInterval> | undefined;
	let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
	let lastSerialized = '';
	let closed = false;

	const cleanup = () => {
		closed = true;
		if (pollTimer !== undefined) clearInterval(pollTimer);
		if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
	};

	return new ReadableStream<Uint8Array>({
		start(controller) {
			const push = (chunk: Uint8Array) => {
				if (closed) return;
				try {
					controller.enqueue(chunk);
				} catch {
					cleanup();
				}
			};
			const finish = () => {
				cleanup();
				try {
					controller.close();
				} catch {
					/* already closed by the client */
				}
			};

			const poll = async () => {
				if (closed) return;
				try {
					const job = await resolveJob();
					if (job === null) {
						// Old engine parity: unknown id → terminal not-found chunk.
						push(encodeSseChunk(notFoundProgressData(processIdForNotFound)));
						finish();
						return;
					}
					const snapshot = progressDataFromJob(job);
					// total_time ticks every second while running — strip it from the
					// change signature so we emit on REAL changes plus heartbeats,
					// not every poll.
					const { total_time: _ignored, ...changeSignature } = snapshot;
					const serialized = JSON.stringify(changeSignature);
					if (serialized !== lastSerialized) {
						lastSerialized = serialized;
						push(encodeSseChunk(snapshot));
					}
					if (!snapshot.is_running) {
						finish();
					}
				} catch (error) {
					// DB error mid-stream: loud log + terminal error chunk + close.
					// Swallowing without finish() would leave the client hanging on
					// a dead poll loop.
					console.error('[diffusion sse] job poll failed:', error);
					push(
						encodeSseChunk({
							process_id: processIdForNotFound,
							is_running: false,
							started_at: Date.now(),
							data: { msg: 'Error: process status read failed', counter: 0, total: 0 },
							total_time: '0 sec',
							errors: ['process status read failed'],
						}),
					);
					finish();
				}
			};

			// Initial state immediately (old engine sends it before any update).
			void poll();
			pollTimer = setInterval(() => void poll(), pollMs);
			heartbeatTimer = setInterval(
				() => {
					if (options.commentHeartbeat) {
						// get_process_status heartbeat: SSE comment line.
						push(encodeSseCommentHeartbeat());
						return;
					}
					// diffuse heartbeat: re-send current state (keeps proxies warm).
					// Caught: a heartbeat read failure is non-fatal (the poll loop
					// owns the terminal error path) but must never float (S1-15).
					void resolveJob()
						.then((job) => {
							if (job !== null) push(encodeSseChunk(progressDataFromJob(job)));
						})
						.catch((error) => console.error('[diffusion sse] heartbeat poll failed:', error));
				},
				options.commentHeartbeat ? STATUS_COMMENT_HEARTBEAT_MS : DIFFUSE_HEARTBEAT_MS,
			);
		},
		cancel() {
			cleanup();
		},
	});
}

/** ApiResult carrying an SSE stream (server.ts turns it into the raw Response). */
function sseResult(stream: ReadableStream<Uint8Array>): ApiResult {
	return streamResult(stream, sseResponseHeaders());
}

/* ── follow_queue: the admin queue stream (WC-067) ────────────────────────── */

/**
 * 1000ms, deliberately NOT the 500ms diffuse cadence. The underlying value
 * moves once per DEDALO_DIFFUSION_BATCH_RECORDS batch (default 500 records) in
 * the runner loop, so polling faster only burns CPU to observe the same number.
 */
const QUEUE_POLL_MS = 1000;
/** Same 15s comment cadence as get_process_status — but unconditional here. */
const QUEUE_HEARTBEAT_MS = STATUS_COMMENT_HEARTBEAT_MS;
/** Hard lifetime cap; see the deadline note in buildQueueFollowStream. */
const QUEUE_STREAM_MAX_MS = 900000;

/** What a queue tick reads: the active set plus the scheduler's own state. */
export interface QueueSnapshot {
	scheduler: QueueFrame['scheduler'];
	jobs: QueueFrame['jobs'];
}

/**
 * Build the admin queue SSE stream. Same skeleton as buildJobFollowStream, with
 * four deliberate differences — each one load-bearing:
 *
 * 1. NO TERMINAL CONDITION. A queue is never "done"; the stream lives until the
 *    client goes away or the deadline fires.
 *
 * 2. The heartbeat is an UNCONDITIONAL SSE comment. This is the single most
 *    important line here: on an idle queue nothing changes, so nothing is
 *    enqueued, so the enqueue-throws backstop in push() — the only in-process
 *    signal that the peer is gone — would never fire, and a closed browser tab
 *    would leave this poll loop running until the process restarted. The
 *    comment guarantees a write attempt every 15s whatever the queue is doing.
 *
 * 3. A MAX LIFETIME. Bun's cancel() on a dropped socket is not something this
 *    codebase has a test for, so the stream does not rely on it: the deadline
 *    bounds any leak regardless. It also bounds the stale-authorization window
 *    — admin is checked once, at open, so an open socket must not outlive a
 *    revoked session indefinitely. The final frame says reconnect:true so the
 *    client knows this is routine, not a failure.
 *
 * 4. The change signature strips `at` (the twin of the total_time strip in
 *    buildJobFollowStream) so a quiet queue produces no frames at all.
 *
 * All state is closure-local — nothing module-scoped, so per-request isolation
 * is structural rather than a rule someone has to remember.
 */
export function buildQueueFollowStream(
	resolveSnapshot: () => Promise<QueueSnapshot>,
	options: { pollMs: number; maxMs: number; heartbeatMs?: number },
): ReadableStream<Uint8Array> {
	const heartbeatMs = options.heartbeatMs ?? QUEUE_HEARTBEAT_MS;
	let pollTimer: ReturnType<typeof setInterval> | undefined;
	let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
	let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
	let lastSerialized = '';
	let lastMembership = '';
	let closed = false;

	/**
	 * Opened/closed are the RUNTIME leak alarm this design needs precisely
	 * because no test in this codebase can assert that a dropped socket fires
	 * cancel(). A persistent gap between these two on /api/v1/counters means
	 * poll loops are outliving their clients; they should converge within
	 * QUEUE_STREAM_MAX_MS of the last tab closing. cleanup() is idempotent
	 * (deadline-then-cancel is a normal sequence), so the close counter is
	 * gated on the transition, not the call.
	 */
	incrementCounter('diffusion_queue_streams_opened');
	const cleanup = () => {
		if (!closed) incrementCounter('diffusion_queue_streams_closed');
		closed = true;
		if (pollTimer !== undefined) clearInterval(pollTimer);
		if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
		if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
	};

	return new ReadableStream<Uint8Array>({
		start(controller) {
			const push = (chunk: Uint8Array) => {
				if (closed) return;
				try {
					controller.enqueue(chunk);
				} catch {
					// the peer is gone — this is the backstop the heartbeat exists to reach
					cleanup();
				}
			};
			const finish = () => {
				cleanup();
				try {
					controller.close();
				} catch {
					/* already closed by the client */
				}
			};

			const poll = async () => {
				if (closed) return;
				try {
					const snapshot = await resolveSnapshot();
					const membership = snapshot.jobs
						.map((job) => job.job_id)
						.sort()
						.join(',');
					const frame: QueueFrame = {
						kind: 'diffusion_queue',
						at: Date.now(),
						scheduler: snapshot.scheduler,
						jobs: snapshot.jobs,
						membership,
						refresh: lastMembership !== '' && membership !== lastMembership,
						errors: [],
					};
					lastMembership = membership;
					const { at: _volatile, ...changeSignature } = frame;
					const serialized = JSON.stringify(changeSignature);
					if (serialized !== lastSerialized) {
						lastSerialized = serialized;
						push(encodeQueueSseChunk(frame));
					}
				} catch (error) {
					// Parity with the per-job stream: a read failure mid-stream is a
					// terminal error frame plus close, never a silent dead poll loop
					// and never a floating rejection (Bun kills the process on the
					// first one).
					console.error('[diffusion sse] queue poll failed:', error);
					push(
						encodeQueueSseChunk({
							kind: 'diffusion_queue',
							at: Date.now(),
							scheduler: {
								running: 0,
								queued: 0,
								max_runners: 0,
								paused: false,
								draining: false,
								stale_after_seconds: 0,
							},
							jobs: [],
							membership: '',
							refresh: false,
							errors: ['queue status read failed'],
						}),
					);
					finish();
				}
			};

			void poll();
			pollTimer = setInterval(() => void poll(), options.pollMs);
			heartbeatTimer = setInterval(() => push(encodeSseCommentHeartbeat()), heartbeatMs);
			deadlineTimer = setTimeout(() => {
				if (closed) return;
				push(
					encodeQueueSseChunk({
						kind: 'diffusion_queue',
						at: Date.now(),
						scheduler: {
							running: 0,
							queued: 0,
							max_runners: 0,
							paused: false,
							draining: false,
							stale_after_seconds: 0,
						},
						jobs: [],
						membership: lastMembership,
						refresh: false,
						reconnect: true,
						errors: [],
					}),
				);
				finish();
			}, options.maxMs);
		},
		cancel() {
			cleanup();
		},
	});
}

/**
 * The refusal for a non-admin caller — an SSE frame, NOT the JSON envelope its
 * sibling actions return.
 *
 * (!) This looks inconsistent and is not. The caller is
 * data_manager.request_stream, which resolves response.body and DISCARDS the
 * Response object: the client is structurally incapable of seeing a status
 * code or a content-type. Hand it a JSON body and read_stream finds no
 * "data:\n…\n\n" framing, never fires on_read, and the caller waits forever.
 * A framed terminal frame is the only refusal a stream client can actually
 * receive. Same precedent as getProcessStatusAction's missing-id refusal.
 */
export function queueRefusalStream(msg: string): ApiResult {
	return sseResult(
		new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					encodeQueueSseChunk({
						kind: 'diffusion_queue',
						at: Date.now(),
						scheduler: {
							running: 0,
							queued: 0,
							max_runners: 0,
							paused: false,
							draining: false,
							stale_after_seconds: 0,
						},
						jobs: [],
						membership: '',
						refresh: false,
						errors: [msg],
					}),
				);
				controller.close();
			},
		}),
	);
}

/**
 * `follow_queue` — the maintenance widget's live feed: the whole ACTIVE queue
 * plus scheduler state, for a global admin.
 *
 * (!) The principal is captured BY VALUE into the poll closure and never read
 * from the request ALS. dispatchRqo closes its ALS scopes the moment this
 * handler returns, so currentPrincipal()/currentApplicationLang() inside a
 * later tick would be undefined. Nothing in the frame is language-dependent —
 * every field is an id, a number or a state token — so there is nothing to
 * resolve per tick anyway; that is a property of the frame design, not luck.
 */
export async function followQueueAction(_rqo: Rqo, _principal: Principal): Promise<ApiResult> {
	return sseResult(
		buildQueueFollowStream(
			async () => {
				const rows = await listActiveJobs();
				return {
					scheduler: {
						// exact over the whole active set: window aggregates survive
						// the LIMIT (see listActiveJobs)
						running: rows[0]?.n_running ?? 0,
						queued: rows[0]?.n_queued ?? 0,
						max_runners: getMaxRunners(),
						paused: isSchedulerPaused(),
						draining: isSchedulerDraining(),
						stale_after_seconds: STALE_AFTER_SECONDS,
					},
					jobs: rows.map(queueJobView),
				};
			},
			{ pollMs: QUEUE_POLL_MS, maxMs: QUEUE_STREAM_MAX_MS },
		),
	);
}

/**
 * `diffuse` — gate → sanitize → enqueue (or attach to the active run for the
 * same element+section) → follow stream.
 */
export async function diffuseAction(rqo: Rqo, principal: Principal): Promise<ApiResult> {
	const options = (rqo.options ?? {}) as Record<string, unknown>;
	const rawSqo = (rqo.sqo ?? null) as { section_tipo?: unknown } | null;
	const elementTipo =
		typeof options.diffusion_element_tipo === 'string'
			? options.diffusion_element_tipo
			: typeof options.diffusion_tipo === 'string'
				? options.diffusion_tipo
				: null;

	// The section being published is carried by the record-selection SQO (client
	// export(): section_tipo = self.caller.section_tipo), NOT by rqo.source.
	// create_source sets source.section_tipo to `self.section_tipo || self.tipo`,
	// which for a TOOL instance is the tool's OWN ontology tipo (e.g. dd1324
	// "tool directory"), never the open record's section — using it made the
	// resolver look for a SectionPlan that isn't in the element's plan. The PHP
	// oracle derives the same value via get_related_section_tipo(diffusion_tipo);
	// the SQO's section_tipo is the equivalent and ALSO scopes the record search,
	// keeping the resolver's primary SectionPlan and the searched rows consistent.
	const sqoSectionTipo = Array.isArray(rawSqo?.section_tipo)
		? (rawSqo.section_tipo.find((tipo): tipo is string => typeof tipo === 'string') ?? null)
		: typeof rawSqo?.section_tipo === 'string'
			? rawSqo.section_tipo
			: null;
	const sectionTipo = sqoSectionTipo;
	if (sectionTipo === null || elementTipo === null) {
		refuse(
			'request.invalid_options',
			'diffuse requires sqo.section_tipo and options.diffusion_element_tipo',
		);
	}

	// SEC-13: read permission on the source section, server-enforced.
	const level = await getPermissions(principal, sectionTipo, sectionTipo);
	if (level < 1) {
		refuse('perm.denied', 'Insufficient permissions to diffuse this section');
	}

	// Staged-cutover routing (DIFFUSION_PLAN P5 step 2): when the deployment
	// pins DEDALO_DIFFUSION_NATIVE_ELEMENTS (a list of element tipos, or the
	// single value 'all'), elements outside the list refuse LOUDLY — they still
	// publish through the old engine (never both engines on one
	// element+section). Unset = permissive (dev posture; the copied client only
	// reaches this action once DEDALO_DIFFUSION_NATIVE flips the environment key
	// anyway). Parsed ONCE at boot into config.diffusion.nativeElements — the
	// hand `.split(',')` this replaced could not read the key's own JSON-array
	// form and silently routed nothing.
	//
	// 'all' is a SENTINEL, and only when it is the WHOLE value: a list that
	// happens to contain it (['dd1190','all']) names two tipos, one of which
	// does not exist, and must stay RESTRICTIVE. Testing the single-entry case
	// — not `includes('all')` — is what keeps a typo from opening the gate.
	const routedElements = config.diffusion.nativeElements;
	const routesEverything = routedElements.length === 1 && routedElements[0] === 'all';
	if (routedElements.length > 0 && !routesEverything) {
		if (!routedElements.includes(elementTipo)) {
			refuse(
				'engine.uncovered_scope',
				`Element ${elementTipo} is not routed to the native engine yet (DEDALO_DIFFUSION_NATIVE_ELEMENTS)`,
			);
		}
	}

	// The record selection: sanitized at the boundary (server-only SQO keys
	// stripped, limits clamped) — the job spec NEVER stores a raw client SQO.
	const sqo = sanitizeClientSqo(
		(rqo.sqo ?? { section_tipo: [sectionTipo] }) as Record<string, unknown>,
	);

	const requestedProcessId = options.process_id;
	const clientProcessId =
		typeof requestedProcessId === 'string' && CLIENT_PROCESS_ID_PATTERN.test(requestedProcessId)
			? requestedProcessId
			: `process_diffusion_${principal.userId}_${elementTipo}_${sectionTipo}`;

	const estimatedTotal = Number(options.total ?? 0) || 0;
	const { process_id: _clientLabel, ...rawRunnerOptions } = options;

	// DIFF-B (2026-07-28 audit): the job spec is server-authoritative for the
	// publication SCOPE, not only the SQO. A read-level caller must not be able to
	// (a) switch OFF the fail-closed per-record publication gate, nor (b) expand a
	// one-record run into a transitive-closure publication of the relation graph.
	const runnerOptions: Record<string, unknown> = { ...rawRunnerOptions };
	// (a) skip_publication_state_check is a GLOBAL-ADMIN operation — strip it for
	// everyone else (a non-admin can never publish embargoed/draft records).
	if (!principal.isGlobalAdmin) {
		// biome-ignore lint/performance/noDelete: the key must VANISH — a present-but-undefined option still reads as "explicitly set" downstream
		delete runnerOptions.skip_publication_state_check;
	}
	// (b) clamp the recursion budget to the configured server ceiling; a non-
	// positive / absent value falls back to the plan default at run time.
	const requestedLevels = Number(runnerOptions.levels);
	if (Number.isFinite(requestedLevels) && requestedLevels > 0) {
		runnerOptions.levels = Math.min(requestedLevels, diffusionResolveLevels());
	} else {
		// biome-ignore lint/performance/noDelete: same — absence is the signal the runner's default detection reads
		delete runnerOptions.levels;
	}

	const { job } = await enqueueDiffusionJob({
		ownerUserId: principal.userId,
		clientProcessId,
		spec: {
			diffusion_element_tipo: elementTipo,
			section_tipo: sectionTipo,
			type: typeof options.type === 'string' ? options.type : 'sql',
			sqo: sqo as unknown as Record<string, unknown>,
			estimated_total: estimatedTotal,
			options: runnerOptions,
		},
	});

	// Immediate spawn attempt — no 2s scheduler-tick latency on the first chunk.
	void schedulerTick();

	// DIFF-3: the stream follows the caller's OWN run (enqueue only attaches a
	// caller to their own identical request, and the getter is owner-scoped
	// too — a view never resolves to a run the caller does not own).
	return sseResult(
		buildJobFollowStream(
			() => getOwnedJobById(job.job_id, principal.userId),
			clientProcessId,
			DIFFUSE_POLL_MS,
			{ commentHeartbeat: false },
		),
	);
}

/** `get_process_status` — reconnect stream by client process_id (owner-scoped). */
export async function getProcessStatusAction(rqo: Rqo, principal: Principal): Promise<ApiResult> {
	const body = rqo as unknown as { process_id?: unknown; update_rate?: unknown };
	const processId = typeof body.process_id === 'string' ? body.process_id : null;
	if (processId === null || !CLIENT_PROCESS_ID_PATTERN.test(processId)) {
		// Old engine parity: missing id → single terminal SSE chunk, not a JSON error.
		const chunk = encodeSseChunk({
			process_id: '',
			is_running: false,
			started_at: Date.now(),
			data: { msg: 'Error: process_id is required', counter: 0, total: 0 },
			total_time: '0 sec',
			errors: ['process_id is required'],
		});
		return sseResult(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(chunk);
					controller.close();
				},
			}),
		);
	}
	const updateRate = Math.min(
		10000,
		Math.max(
			250,
			Number(body.update_rate ?? STATUS_DEFAULT_UPDATE_RATE_MS) || STATUS_DEFAULT_UPDATE_RATE_MS,
		),
	);
	const scope = ownerScope(principal);
	return sseResult(
		buildJobFollowStream(() => getJobByClientProcessId(processId, scope), processId, updateRate, {
			commentHeartbeat: true,
		}),
	);
}

/** `list_processes` — { result:true, processes:[progress_data…] } (24h window). */
export async function listProcessesAction(_rqo: Rqo, principal: Principal): Promise<ApiResult> {
	const jobs = await listJobsForCaller(ownerScope(principal));
	return {
		status: 200,
		body: ok(
			{ processes: jobs.map((job) => progressDataFromJob(job)) },
			{ requestId: requestId() },
		),
	};
}

/** `cancel_process` — pinned { result, msg } contract, owner-scoped. */
export async function cancelProcessAction(rqo: Rqo, principal: Principal): Promise<ApiResult> {
	const body = rqo as unknown as { process_id?: unknown };
	const processId = typeof body.process_id === 'string' ? body.process_id : null;
	if (processId === null || !CLIENT_PROCESS_ID_PATTERN.test(processId)) {
		throw new DedaloError('diffusion.invalid_process_id', {
			coordinates: { process_id: String(body.process_id ?? '') },
		});
	}
	// A cancel that finds nothing is NOT a failed request: the caller asked for
	// the process to stop and it is stopped. `cancelled` says whether this call
	// is what stopped it (a double-cancel answers false), which is exactly what
	// the panel renders.
	const { cancelled } = await requestCancel(processId, ownerScope(principal));
	return {
		status: 200,
		body: ok(
			{
				cancelled,
				message: cancelled
					? `Process ${processId} cancelled`
					: `Process ${processId} not found or not running`,
			},
			{ requestId: requestId() },
		),
	};
}

/** `get_diffusion_info` — panel descriptors (PHP :355 contract; SEC read gate). */
export async function getDiffusionInfoAction(rqo: Rqo, principal: Principal): Promise<ApiResult> {
	const options = (rqo.options ?? {}) as { section_tipo?: unknown };
	const sectionTipo = typeof options.section_tipo === 'string' ? options.section_tipo : null;
	if (sectionTipo === null) {
		refuse('request.invalid_options', 'options.section_tipo is required');
	}
	const level = await getPermissions(principal, sectionTipo, sectionTipo);
	if (level < 1) {
		throw new DedaloError('perm.denied', {
			coordinates: { section_tipo: sectionTipo, action: 'get_diffusion_info' },
		});
	}
	const { buildDiffusionInfo } = await import('./info.ts');
	return {
		status: 200,
		body: ok(await buildDiffusionInfo(sectionTipo), { requestId: requestId() }),
	};
}

/** `get_engine_advisory` — client reads the body TOP-LEVEL (state/title/checks). */
export async function getEngineAdvisoryAction(_rqo: Rqo, principal: Principal): Promise<ApiResult> {
	const { buildEngineAdvisory } = await import('./info.ts');
	// (!) CLIENT SWEEP PENDING: the advisory is PAYLOAD, so it lives in `data`
	// now; tool_diffusion.js:476-487 still reads it off the body top level.
	return {
		status: 200,
		body: ok(buildEngineAdvisory(principal.isGlobalAdmin), { requestId: requestId() }),
	};
}

/**
 * THE PATIENT RETRY DRAIN — the one door of every EXPLICIT pending-unpublish
 * drain: the `retry_pending_deletions` action and the maintenance widget's
 * retry (core reaches it through this facade). The drain runs inside
 * `withPatientDeleteWait`: a target an exclusive writer holds (a run's unit,
 * the lang sweep, the media rebuild) is waited for on ONE bounded budget for the
 * whole drain, never given up at once (WC-2026-09-30-diffusion-target-fence R3;
 * gate: diffusion_target_fence_native D2).
 */
export async function retryPendingDeletionsPatiently(
	limit?: number,
): Promise<{ total: number; retried: number; remaining: number }> {
	const { retryPendingDiffusion } = await import('../../core/diffusion_bridge/diffusion_delete.ts');
	const { withPatientDeleteWait } = await import('../../core/diffusion_bridge/target_lock.ts');
	return withPatientDeleteWait(() => retryPendingDiffusion(limit));
}

/**
 * `retry_pending_deletions` — native dd1758 pending-unpublish retry. `count_only`
 * (PHP parity) only COUNTS: tool_diffusion asks it on every render for its badge,
 * and ignoring it ran the whole drain each time the tool opened.
 */
export async function retryPendingDeletionsAction(
	rqo: Rqo,
	_principal: Principal,
): Promise<ApiResult> {
	if ((rqo.options as { count_only?: unknown } | undefined)?.count_only === true) {
		const { countPendingDiffusion } = await import(
			'../../core/diffusion_bridge/diffusion_delete.ts'
		);
		const pending = await countPendingDiffusion();
		return {
			status: 200,
			body: ok(
				{
					summary: `${pending} pending deletions`,
					total: pending,
					retried: 0,
					remaining: pending,
				},
				{ requestId: requestId() },
			),
		};
	}
	const summary = await retryPendingDeletionsPatiently();
	return {
		status: 200,
		body: ok(
			{
				summary: `Retried ${summary.retried} of ${summary.total} pending deletions (${summary.remaining} remaining)`,
				...summary,
			},
			{ requestId: requestId() },
		),
	};
}

/**
 * `sweep_published_langs` — FIND and REPAIR the publication targets of an
 * install damaged by the DEDALO_DIFFUSION_LANGS migration defect
 * (targets/mariadb/lang_sweep.ts carries the full account of the defect).
 *
 * TWO MODES, and the destructive one is never the default:
 *  - `mode:'report'` (default): the audit — the policy, every published lang,
 *    and the phantom ones with their row counts. Read-only.
 *  - `mode:'sweep'`: removes the rows carrying `options.langs`. Requires
 *    `confirm:true` AND an explicit lang list, so the operator can only ever
 *    remove values a report already showed them. The result carries the audit
 *    taken AFTER the sweep, so the caller sees what is left rather than
 *    trusting the delete counts.
 *
 * NEITHER MODE EVER TOUCHES A TABLE IT CANNOT POSITIVELY IDENTIFY as
 * diffusion-created (composite PK (section_id, lang) AND a name the diffusion
 * map declares) — a publication schema is shared ground, see the lang_sweep.ts
 * header. Gate: test/unit/diffusion_lang_sweep_native.test.ts.
 *
 * ADMIN-ONLY, enforced HERE as well as at the dispatch handler: this is a
 * cross-section destructive operation on the publication server, exactly like
 * its siblings validate / rebuild_media_index / retry_pending_deletions. The
 * gate is duplicated deliberately — the handler wiring is one edit away from
 * being written without it, and a missing permission check must not be
 * something a wiring mistake can cause.
 */
export async function sweepPublishedLangsAction(
	rqo: Rqo,
	principal: Principal,
): Promise<ApiResult> {
	if (!principal.isGlobalAdmin) {
		throw new DedaloError('perm.denied', {
			coordinates: { action: 'sweep_published_langs', required: 'global_admin' },
		});
	}
	const options = (rqo.options ?? {}) as {
		mode?: unknown;
		langs?: unknown;
		databases?: unknown;
		confirm?: unknown;
	};
	const mode = options.mode === 'sweep' ? 'sweep' : 'report';
	/**
	 * A list of strings, or a LOUD refusal — never a filtered survivor list.
	 * Silently dropping a non-string would make the sweep act on a list the
	 * caller never sent (and, for `databases`, would silently widen the scope
	 * from "these two" to "every target").
	 */
	const stringList = (value: unknown, name: string): string[] | undefined => {
		if (value === undefined || value === null) return undefined;
		if (!Array.isArray(value)) {
			refuse('request.invalid_options', `${name} must be an array of strings`);
		}
		for (const item of value) {
			if (typeof item !== 'string' || item.trim() === '') {
				refuse('request.invalid_options', `${name} must contain non-empty strings only`);
			}
		}
		return value as string[];
	};

	if (mode === 'report') {
		return {
			status: 200,
			body: ok(
				{ mode, ...(await auditPublishedLangs(OPERATOR_AUDIT_BUDGET)) },
				{ requestId: requestId() },
			),
		};
	}

	const langs = stringList(options.langs, 'options.langs') ?? [];
	if (langs.length === 0) {
		refuse(
			'request.invalid_options',
			'sweep mode requires options.langs — run mode:"report" first and name the languages to remove',
		);
	}
	if (options.confirm !== true) {
		// Report-before-remove is a CONTRACT, not a UI convention: the caller has
		// to have seen the counts, and `confirm` is the only evidence of that a
		// server-side action can ask for.
		refuse(
			'request.invalid_options',
			'sweep mode requires options.confirm:true (run mode:"report" and review the row counts first)',
		);
	}
	// An EXPLICIT empty database list is a caller bug, not "sweep nothing":
	// answering ok({swept:[]}) to it would tell an operator their targets are
	// clean when nothing was even looked at. Omit the key to sweep every target.
	const databases = stringList(options.databases, 'options.databases');
	if (databases !== undefined && databases.length === 0) {
		refuse(
			'request.invalid_options',
			'options.databases must name at least one target database (omit it to sweep every target)',
		);
	}
	const sweep = await sweepPhantomLangs({
		langs,
		...(databases === undefined ? {} : { databases }),
	});
	const after: LangCoherenceReport = await auditPublishedLangs(OPERATOR_AUDIT_BUDGET);
	return {
		status: 200,
		body: ok(
			{
				mode,
				summary: `Removed ${sweep.total_rows} row(s) carrying ${sweep.requested_langs.join(', ')}`,
				...sweep,
				after,
			},
			{ requestId: requestId() },
		),
	};
}
