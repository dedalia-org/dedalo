/**
 * API dispatch — RQO → handler, behind the §7.1 allowlists and the auth/CSRF
 * gates (spec §7.1-7.3).
 *
 * Design (stronger than the PHP reflection fallback): handlers are EXPLICITLY
 * registered in the ACTION_REGISTRY map — there is no dynamic method lookup,
 * so an unregistered (api class, action) pair simply does not exist. The
 * registry is the single source of truth for what the API can do.
 *
 * Gate order per request (mirrors PHP dd_manager::manage_request):
 *   1. api class + action must be registered (allowlist);
 *   2. auth: session required unless the action is in NO_LOGIN_ACTIONS;
 *   3. CSRF: required for authenticated non-exempt actions (constant-time);
 *   4. idempotency: a stamped request executes ONCE, its twins replay its
 *      answer (CLI-01 / P0-10, WC-2026-08-28-idempotency-key — the gate block
 *      below carries the whole design, its residual window included);
 *   5. handler runs with an explicit RequestContext (no globals).
 *
 * WS-C S2-25: this file is REGISTRY ASSEMBLY + GATES + ENVELOPE only. The
 * per-class handler bodies live in api/handlers/<class>.ts (statically
 * imported below); the read sub-action routing lives in the section facade
 * (src/core/section/read_facade.ts).
 *
 * ENVELOPE v2 (engineering/ERRORS_SPEC.md §4 — the converter chokepoint):
 * every gate REFUSES BY THROWING a DedaloError; a handler succeeds by
 * returning `ok(data, …)` and fails by throwing. The ONE catch below turns
 * any throw into `{status, body}` via toErrorEnvelope (registry status,
 * ok:false ⇒ non-2xx, Retry-After threaded on the ApiResult) and reports it
 * through logError. A handler body that is NOT an envelope (no `ok` key —
 * the PHP `{result,msg,errors}` fossil) is a BUG, refused loudly as
 * `internal.unexpected` naming the action (the P1-era legacy_body_adapter
 * that used to translate it is DELETED; error_taxonomy_tripwire guards).
 */

import { ragApiActions } from '../../ai/rag/api.ts';
import { config } from '../../config/config.ts';
import type { Rqo } from '../concepts/rqo.ts';
import {
	ERROR_REPORT_ACTION_KEYS,
	receiverEnabled,
	reporterIpAllowed,
} from '../error_report/gate.ts';
import { toErrorEnvelope } from '../errors/convert.ts';
import { DedaloError } from '../errors/dedalo_error.ts';
import { logError } from '../errors/log.ts';
import { resolvePrincipal } from '../security/permissions.ts';
import { refusedUnderMaintenance } from '../security/session_gate.ts';
import { verifyCsrf } from '../security/session_store.ts';
import { logApiAccess } from './access_log.ts';
import type { ActionHandler, ApiRequestContext } from './handler_context.ts';
import { areaMaintenanceApiActions } from './handlers/dd_area_maintenance_api.ts';
import { component3dApiActions } from './handlers/dd_component_3d_api.ts';
import { componentAvApiActions } from './handlers/dd_component_av_api.ts';
import { componentInfoApiActions } from './handlers/dd_component_info.ts';
import { componentPortalApiActions } from './handlers/dd_component_portal_api.ts';
import { componentTextAreaApiActions } from './handlers/dd_component_text_area_api.ts';
import { coreApiActions } from './handlers/dd_core_api.ts';
import { diffusionApiActions } from './handlers/dd_diffusion_api.ts';
import { errorReportApiActions } from './handlers/dd_error_report_api.ts';
import { externalApiActions } from './handlers/dd_external_api.ts';
import { identifyApiActions } from './handlers/dd_identify_api.ts';
import { mcpApiActions } from './handlers/dd_mcp_api.ts';
import { toolsApiActions } from './handlers/dd_tools_api.ts';
import { tsApiActions } from './handlers/dd_ts_api.ts';
import { utilsApiActions } from './handlers/dd_utils_api.ts';
import type { ApiResult } from './response.ts';

export type { ApiRequestContext } from './handler_context.ts';
export type { ApiResult } from './response.ts';

/**
 * Actions callable without a session (PHP dd_manager no-login list, trimmed to
 * implemented). Keyed on the `${dd_api}:${action}` PAIR (L8) — a future handler
 * with a colliding action name in another class must NOT inherit the exemption.
 */
export const NO_LOGIN_ACTIONS: ReadonlySet<string> = new Set([
	'dd_utils_api:login',
	'dd_core_api:get_environment',
	'dd_core_api:start',
	'dd_utils_api:get_login_context',
	// The LOGIN PANEL's language selector posts change_lang before any session
	// exists. Pre-auth by necessity: without it the choice could not be stored at
	// all and the form snapped back to the install default on every reload. The
	// handler persists to the session row when there is one, and to the anonymous
	// language cookie when there is not; the value is allowlist-validated either way.
	'dd_utils_api:change_lang',
	// Forgot-password recovery (PHP dd_manager pre-auth whitelist): the user is
	// locked out by definition. Anti-enumeration/throttling live in
	// security/password_reset.ts.
	'dd_utils_api:request_password_reset',
	'dd_utils_api:confirm_password_reset',
	// Machine-to-machine intake from remote installations' servers (WC-017);
	// Gate 1c (flag + IP) runs first, the handler owns throttle/token/schema.
	'dd_error_report_api:receive_report',
	// Ontology-master surface (UPDATE_PROCESS Phase 2, PHP parity): remote
	// installations probe reachability + fetch the update manifest without a
	// session. Both handlers fail closed unless IS_AN_ONTOLOGY_SERVER is set;
	// the manifest additionally requires a configured access code.
	'dd_utils_api:get_server_ready_status',
	'dd_utils_api:get_ontology_update_info',
	// Code-master surface (UPDATE_PROCESS Phase 4, PHP parity): the release
	// manifest, fail-closed on IS_A_CODE_SERVER + a configured CODE_SERVERS code.
	'dd_utils_api:get_code_update_info',
]);

/**
 * Actions exempt from CSRF (PHP CSRF_EXEMPT_ACTIONS, trimmed to implemented).
 * `start` is exempt (the very first call has no token yet). PHP does NOT
 * exempt read/count — the client echoes the token on every call; we match that
 * (spec §3: never weaker than PHP). Keyed on the `${dd_api}:${action}` pair (L8).
 */
export const CSRF_EXEMPT_ACTIONS: ReadonlySet<string> = new Set([
	'dd_utils_api:login',
	'dd_core_api:get_environment',
	'dd_core_api:start',
	'dd_utils_api:get_login_context',
	// Forgot-password recovery (PHP CSRF_EXEMPT_ACTIONS parity): pre-auth by
	// design — the login page holds no token; there is no session authority for
	// a cross-site request to ride.
	'dd_utils_api:request_password_reset',
	'dd_utils_api:confirm_password_reset',
	// PHP CSRF_EXEMPT_ACTIONS: the service worker fires it from its own
	// context, outside the page that holds the token. Read-only; still
	// AUTHENTICATED (deliberately NOT in NO_LOGIN_ACTIONS, matching PHP).
	'dd_utils_api:get_dedalo_files',
	// Error-report intake (WC-017): anonymous machine-to-machine POST — there
	// is no session authority for a cross-site request to ride (the login
	// posture); exempting also covers an authenticated master admin posting.
	'dd_error_report_api:receive_report',
	// Ontology + code master surfaces: anonymous machine-to-machine POSTs
	// (same no-session-authority posture as receive_report).
	'dd_utils_api:get_server_ready_status',
	'dd_utils_api:get_ontology_update_info',
	'dd_utils_api:get_code_update_info',
]);

/**
 * The explicit action registry: dd_api → action → handler. Each class's
 * handlers are defined in api/handlers/<class>.ts and assembled here — the
 * registry stays the single allowlist source of truth (WS-C S2-25).
 *
 * dd_rag_api — greenfield RAG retrieval (spec §8; src/ai/rag). Results are
 * ACL-gated inside the handlers (schema ACL + per-record projects filter — the
 * DoD chokepoint); the class+action allowlist is this registry block itself.
 */
const ACTION_REGISTRY: Record<string, Record<string, ActionHandler>> = {
	dd_core_api: coreApiActions,
	dd_tools_api: toolsApiActions,
	dd_area_maintenance_api: areaMaintenanceApiActions,
	dd_diffusion_api: diffusionApiActions,
	dd_component_portal_api: componentPortalApiActions,
	// Transcription tags (WC-077): get_tags_info (read the resolved tag payload)
	// + delete_tag (remove one tag's marks from every lang of the text).
	dd_component_text_area_api: componentTextAreaApiActions,
	dd_component_av_api: componentAvApiActions,
	dd_component_info: componentInfoApiActions,
	dd_component_3d_api: component3dApiActions,
	dd_ts_api: tsApiActions,
	dd_utils_api: utilsApiActions,
	dd_rag_api: ragApiActions,
	// Object identification (src/core/identify): find the records that share a
	// seed's identifying features. Authenticated + CSRF-gated like every other
	// class here; the RESULTS are ACL-gated inside the engine (the principal runs
	// through both the pool query and the per-candidate record read).
	dd_identify_api: identifyApiActions,
	// External record services (src/external): search a third-party catalogue
	// THROUGH the engine, so the request goes through the one outbound door and
	// all of its controls. Deliberately absent from NO_LOGIN_ACTIONS and from
	// CSRF_EXEMPT_ACTIONS: the action makes the SERVER open an outbound socket on
	// the caller's behalf, so an anonymous visitor must never be able to drive it.
	dd_external_api: externalApiActions,
	// Error-report intake (WC-017, TS-only): ONE pre-auth action, reachable
	// only where DEDALO_ERROR_REPORT_RECEIVER is on (Gate 1c below).
	dd_error_report_api: errorReportApiActions,
	// The in-process MCP/agent bridge for tool_assistant (fail-closed: every
	// action refuses unless DEDALO_AGENT_HTTP_ENABLED=true — see the handler).
	dd_mcp_api: mcpApiActions,
};

/**
 * TEST SEAM (error_taxonomy_tripwire's runtime leg): every registered
 * (class, action) pair, so the gate can force a throw through each and prove
 * the wire is converter-made — the registry itself stays private.
 */
export function listRegisteredActions(): readonly { apiClass: string; action: string }[] {
	return Object.entries(ACTION_REGISTRY).flatMap(([apiClass, table]) =>
		Object.keys(table).map((action) => ({ apiClass, action })),
	);
}

/** TEST SEAM (same gate): the live handler table of a class, to swap a probe handler in and out. */
export function actionTableFor(apiClass: string): Record<string, ActionHandler> | undefined {
	return classTableFor(apiClass);
}

/**
 * Dispatch one RQO through all gates, then emit the structured access-log
 * line/counters for EVERY outcome — including gate denials (audit S2-37).
 * The wrapper owns only timing + logging; all gates live in executeRqo.
 */
export async function dispatchRqo(rqo: Rqo, context: ApiRequestContext): Promise<ApiResult> {
	const startedAt = context.startedAt ?? performance.now();
	const result = await executeRqo(rqo, context);
	logApiAccess({
		requestId: context.requestId,
		userId: context.session?.userId ?? null,
		apiClass: String(rqo.dd_api ?? 'dd_core_api'),
		action: typeof rqo.action === 'string' ? rqo.action : String(rqo.action ?? ''),
		status: result.status,
		ms: performance.now() - startedAt,
		detail: summarizeRqo(rqo),
		...errorIdentity(result.body),
	});
	return result;
}

/** `{error_code, error_category}` of an ok:false envelope for the access log; nothing on success. */
function errorIdentity(body: ApiResult['body']): { error_code?: string; error_category?: string } {
	if (body.ok !== false) return {};
	const error = body.error as { code: string; category: string };
	return { error_code: error.code, error_category: error.category };
}

/**
 * Compact request-shape summary for the slow-request warn line (cheap field
 * reads, never a full stringify). Without this, a "took 24s" line is
 * undiagnosable after the fact — the 2026-07-20 relation-list hunt burned an
 * hour reconstructing what one log line should have said.
 */
function summarizeRqo(rqo: Rqo): string {
	try {
		const source = (rqo.source ?? {}) as Record<string, unknown>;
		const sqo = (rqo.sqo ?? {}) as Record<string, unknown>;
		const sections = Array.isArray(sqo.section_tipo)
			? (sqo.section_tipo as unknown[])
					.map((s) => (typeof s === 'string' ? s : ((s as { tipo?: string })?.tipo ?? '?')))
					.slice(0, 6)
					.join(',')
			: '';
		const parts = [
			`src=${String(source.model ?? '')}:${String(source.tipo ?? '')}`,
			source.action ? `srcAction=${String(source.action)}` : '',
			source.mode ? `mode=${String(source.mode)}` : '',
			source.section_id !== undefined && source.section_id !== null
				? `id=${String(source.section_id)}`
				: '',
			sections !== '' ? `sqo=[${sections}]` : '',
			sqo.limit !== undefined ? `limit=${String(sqo.limit)}` : '',
			// offset matters for deep-page diagnosis: a big-log list slow ONLY at a
			// far offset is the late-lookup/flip regime (WC-046), not a shape bug.
			sqo.offset !== undefined && sqo.offset !== null && Number(sqo.offset) > 0
				? `offset=${String(sqo.offset)}`
				: '',
			sqo.filter !== undefined && sqo.filter !== null ? 'filter=yes' : '',
			Array.isArray(sqo.filter_by_locators) ? `locators=${sqo.filter_by_locators.length}` : '',
		];
		return parts.filter((part) => part !== '').join(' ');
	} catch {
		return '';
	}
}

// ---------------------------------------------------------------------------
// GATE 4 — IDEMPOTENCY (CLI-01 / P0-10, WC-2026-08-28-idempotency-key)
//
// THE DEFECT. The browser transport re-sends a POST when its OWN AbortController
// fires at the 5 s per-attempt deadline. That abort is client-side only: this
// process has no `request.signal` handling anywhere, so the aborted attempt's
// handler runs to completion and COMMITS. The resend was therefore not a
// replacement but a SECOND operation — one click on "New record" on a throttled
// link minted up to five blank records in the catalogue, one click on
// "Duplicate" up to five clones of a heritage record.
//
// THE FIX, in one sentence: a stamped request executes ONCE; its twins are
// served the answer the first one gave, or told that the outcome is unknown.
//
//   - WHERE the record lives: an in-process ledger, bounded four ways (age,
//     per-principal entries/bytes, and a process-wide entry/byte backstop). NOT a
//     table — and that is a real limitation, stated in full below rather than
//     glossed. The durable version writes the key row inside the WRITE's own
//     transaction, which is the only design with no residual window at all; it
//     cannot be built at this chokepoint, because the transaction is opened
//     downstream inside the handler — when it is opened at all.
//   - WHEN it is written: the reservation is made BEFORE the handler runs, and
//     completed with the answer after. Recording only AFTER the commit would
//     leave open exactly the window the defect already exploits (a retry landing
//     between commit and record).
//   - CONCURRENCY, which is what a retry storm actually produces: the reservation
//     is inserted SYNCHRONOUSLY between the `get` and the first `await`, so a
//     twin arriving while the leader is still running cannot also become a
//     leader. It awaits the leader's own promise and answers with the leader's
//     answer — never a half-built one, never a second execution.
//   - WHAT A REPLAY RETURNS: the ORIGINAL response, verbatim (plus an
//     `idempotent_replay` marker and this request's own fresh csrf_token). When
//     the answer was too large to store, the replay is REFUSED with
//     `idempotency.replay_unavailable` — re-executing a non-idempotent write is
//     the defect, so a typed conflict is the correct second best.
//
// THE AMBIGUOUS-OUTCOME RULE, which is the whole reason this gate is not a
// cache. A HANDLER THAT THREW MAY ALREADY HAVE COMMITTED. That is not a
// hypothetical here, it is the measured shape of the two doors the finding
// names:
//
//   - `section/record/duplicate_record.ts` opens NO transaction at all. The
//     clone COMMITS at insertMatrixRecordWithCounter, and media copies, the two
//     Time Machine rows per component, the observer cascade and fireSaveEvent
//     all run after it, uncovered. A throw in any of them follows a committed
//     duplicate.
//   - `dd_core_api:create` commits its row and THEN awaits fireSaveEvent and
//     logActivity outside any transaction.
//
// So "it threw, therefore nothing happened" is FALSE, and freeing the key on a
// throw would hand the next retry a second clone of a heritage record — CLI-01
// itself, reached through the error path. The rule is therefore:
//
//     ON AN AMBIGUOUS OUTCOME, DO NOT RE-EXECUTE.
//
// A leader that throws KEEPS its reservation, marked `ambiguous` with the
// original failure's code and request_id. The leader itself still receives its
// own real error — that is the truth about its own attempt. Every later request
// under the same key is refused with `idempotency.outcome_unknown` (409), which
// names the action, the original request_id and the original error code, and
// tells the operator to reload before acting. A duplicate heritage record
// created silently is worse than an error a curator can act on.
//
// THIS LOCKS OUT NOTHING LAWFUL. The key names ONE LOGICAL OPERATION and is
// minted per call by the transport, so the operator's own deliberate re-click
// mints a NEW key and executes normally. What is refused is only the AUTOMATIC
// resend of the very attempt whose outcome nobody knows — and the reservation
// expires with the TTL below in any case.
//
// A TWIN NEVER WAITS FOREVER. `await entry.pending` on a leader stuck on a
// Postgres row lock would pin one socket per twin for as long as the lock holds,
// and this engine now takes owner row locks from read to COMMIT on the delete
// path. The wait is bounded by IDEMPOTENCY_TWIN_WAIT_MS; past it the twin is
// refused with `idempotency.in_progress` (409) — again NOT re-executed, because
// a leader that is still running is the most ambiguous outcome there is. The
// leader keeps running and keeps the reservation, so the next retry gets either
// its answer or its `outcome_unknown`.
//
// THE RESIDUAL WINDOW, stated because it exists: (a) a process restart between
// the commit and the retry empties the ledger, so that retry re-executes;
// (b) so does eviction — see the eviction note below; (c) a multi-process
// deployment would hold one ledger per process (this engine is single-process
// today — one Bun process on one socket). None of the three is the measured
// defect: the retry storm is one client, on one process, within seconds, and it
// is closed completely.
//
// EVICTION, stated CORRECTLY (this claim was wrong in the first draft and is
// worth the extra sentence). The bounds are per-principal FIRST — one operator's
// writes can only ever evict that same operator's entries — and the process-wide
// entry/byte caps are a memory backstop behind them. The backstop is NOT
// per-principal: with IDEMPOTENCY_MAX_ENTRIES / IDEMPOTENCY_MAX_TOTAL_BYTES
// divided by the per-principal caps below, it takes tens of simultaneously
// active operators to reach it at all, and when it is reached the eviction is
// oldest-first across principals. So the honest statement is: an operator cannot
// evict another operator's entries by their OWN volume; a crowd of operators
// together can, and that is the accepted residual (b) above.
//
// WHAT IS NOT LEDGERED, deliberately and enumerated: an UNAUTHENTICATED request
// (there is no principal to scope a bound to, so an anonymous caller would be
// bookkeeping the process-wide backstop for free — the pre-auth actions are
// login/change_lang/the two password-reset doors, none of which touches the
// catalogue), and every action classified `idempotent` below (reads are the
// volume and the large answers; retrying one is lawful and must stay lawful —
// CLI-01 is about stopping DUPLICATE EXECUTION, not retrying).
//
// NOT REACHED BY THIS GATE, enumerated so it is not mistaken for coverage: the
// MULTIPART upload branch in `src/server.ts` answers before dispatchRqo and
// therefore never passes here — and it is the receiver of the one client
// transport that already retries by itself (upload_transport.js, max_retry 3 per
// chunk). What bounds it there is its own per-transfer identity: `transfer_id`
// is minted ONCE per transfer and every retried chunk carries the same one, so a
// resent chunk lands in the same staging artifact instead of a second one. The
// step that turns staged chunks into a record — `join_chunked_files_uploaded` —
// comes back through the JSON door and IS gated here.

/** How an action behaves when it is executed twice. */
export type ActionIdempotency = 'idempotent' | 'mutating';

/**
 * THE ACTION → IDEMPOTENCY MAP — TOTAL over ACTION_REGISTRY, keyed on the
 * `${dd_api}:${action}` pair, and gated as total by
 * `test/unit/client_idempotency_tripwire.test.ts` (a newly registered action
 * fails that gate until it is classified here).
 *
 * `idempotent` is a CLAIM about executing the action twice: the second run
 * leaves the same end state and answers the same thing. It is the narrow
 * classification on purpose — the fail-safe direction is `mutating`, which only
 * ever costs a ledger entry, while a wrong `idempotent` costs a duplicate
 * record. So POLYMORPHIC doors (`tool_request`, `widget_request`,
 * `get_widget_value`, `mcp_proxy`) are `mutating` whatever today's nested action
 * happens to do, and so is anything whose handler was not read.
 *
 * It is NOT keyed on `source.action` or on `changed_data[].action`, and it does
 * not need to be: `save` is polymorphic (its `insert` on a LITERAL column
 * appends without dedup, while the same word on a `relation` column is dropped
 * by validateRelationInsert), so it is classified `mutating` WHOLE. Classifying
 * at the coarsest safe granularity is what makes the polymorphism harmless.
 */
export const ACTION_IDEMPOTENCY: ReadonlyMap<string, ActionIdempotency> = new Map([
	// ── dd_core_api ────────────────────────────────────────────────────────
	// The record-lifecycle three are the finding's own headline sites.
	['dd_core_api:create', 'mutating'],
	['dd_core_api:duplicate', 'mutating'],
	// A repeat delete refuses rather than destroying a second record, but the
	// operator then sees a spurious failure for work that succeeded — replaying
	// the original answer is strictly better than either.
	['dd_core_api:delete', 'mutating'],
	// THE save door the whole component family shares (component_common.js).
	['dd_core_api:save', 'mutating'],
	// A read MAY write: the portal's "update external data" refresh
	// (source.build_options.get_data_external → section/record/external_refresh.ts)
	// recomputes the requested external mirror before serving it. Still
	// idempotent BY THE CLAIM ABOVE: the mirror is a pure function of committed
	// data, and a second run finds no drift and writes nothing (no TM row, no
	// hop), so it leaves the same end state and answers the same thing.
	['dd_core_api:read', 'idempotent'],
	['dd_core_api:read_raw', 'idempotent'],
	// A grouped COUNT over the sources' stored relation column + per-target counts; writes nothing.
	['dd_core_api:relation_targets', 'idempotent'],
	['dd_core_api:count', 'idempotent'],
	['dd_core_api:start', 'idempotent'],
	['dd_core_api:get_element_context', 'idempotent'],
	['dd_core_api:get_section_elements_context', 'idempotent'],
	['dd_core_api:get_section_terms', 'idempotent'],
	['dd_core_api:get_indexation_grid', 'idempotent'],
	['dd_core_api:get_activity_metric', 'idempotent'],
	['dd_core_api:get_ip_country', 'idempotent'],
	['dd_core_api:get_environment', 'idempotent'],
	// ── dd_tools_api ───────────────────────────────────────────────────────
	// The generic tool door: it carries whatever action the tool named, and the
	// client passes it no retries of its own, so ~30 tools reach the server
	// through it at the transport default. Polymorphic ⇒ mutating.
	['dd_tools_api:tool_request', 'mutating'],
	['dd_tools_api:user_tools', 'idempotent'],
	// ── dd_area_maintenance_api ────────────────────────────────────────────
	// Polymorphic on the nested widget action, several of which are destructive
	// (move_locator, move_tld, restore_code, update_data_version).
	['dd_area_maintenance_api:widget_request', 'mutating'],
	['dd_area_maintenance_api:get_widget_value', 'mutating'],
	['dd_area_maintenance_api:lock_components_actions', 'mutating'],
	// ── dd_diffusion_api ───────────────────────────────────────────────────
	['dd_diffusion_api:diffuse', 'mutating'],
	['dd_diffusion_api:cancel_process', 'mutating'],
	['dd_diffusion_api:rebuild_media_index', 'mutating'],
	['dd_diffusion_api:retry_pending_deletions', 'mutating'],
	['dd_diffusion_api:count_pending_deletions', 'idempotent'],
	['dd_diffusion_api:sweep_published_langs', 'mutating'],
	['dd_diffusion_api:follow_queue', 'idempotent'],
	['dd_diffusion_api:get_process_status', 'idempotent'],
	['dd_diffusion_api:get_diffusion_info', 'idempotent'],
	['dd_diffusion_api:get_engine_advisory', 'idempotent'],
	['dd_diffusion_api:list_processes', 'idempotent'],
	['dd_diffusion_api:validate', 'idempotent'],
	// ── component families ─────────────────────────────────────────────────
	['dd_component_portal_api:delete_locator', 'mutating'],
	['dd_component_text_area_api:delete_tag', 'mutating'],
	['dd_component_text_area_api:get_tags_info', 'idempotent'],
	['dd_component_av_api:create_posterframe', 'mutating'],
	['dd_component_av_api:delete_posterframe', 'mutating'],
	['dd_component_av_api:download_fragment', 'mutating'],
	['dd_component_av_api:get_media_streams', 'idempotent'],
	['dd_component_info:get_widget_data', 'idempotent'],
	['dd_component_3d_api:delete_posterframe', 'mutating'],
	['dd_component_3d_api:move_file_to_dir', 'mutating'],
	// ── dd_ts_api (thesaurus tree) ─────────────────────────────────────────
	// add_child mints a NEW term per call, and it takes the parent node lock
	// inside its transaction — so retries QUEUE, which makes the deadline fire
	// more reliably, not less.
	['dd_ts_api:add_child', 'mutating'],
	['dd_ts_api:save_order', 'mutating'],
	['dd_ts_api:update_parent_data', 'mutating'],
	['dd_ts_api:get_node_data', 'idempotent'],
	['dd_ts_api:get_children_data', 'idempotent'],
	// ── dd_utils_api ───────────────────────────────────────────────────────
	['dd_utils_api:login', 'mutating'],
	['dd_utils_api:quit', 'mutating'],
	['dd_utils_api:change_lang', 'mutating'],
	['dd_utils_api:request_password_reset', 'mutating'],
	['dd_utils_api:confirm_password_reset', 'mutating'],
	// A retry after a successful join finds no staged parts and reports a hard
	// failure on an upload that actually landed.
	['dd_utils_api:join_chunked_files_uploaded', 'mutating'],
	['dd_utils_api:delete_uploaded_file', 'mutating'],
	['dd_utils_api:stop_process', 'mutating'],
	// VERIFIED idempotent at core/section/locks.ts: acquisition is ONE atomic
	// upsert on the (section_tipo, section_id, component_tipo) key, so re-sending
	// `focus` refreshes the same holder's timestamp. It is also the highest-rate
	// non-read action there is (focus/blur on every component) — ledgering it
	// would fill the bounds above with lock chatter.
	['dd_utils_api:update_lock_components_state', 'idempotent'],
	['dd_utils_api:get_lock_status', 'idempotent'],
	['dd_utils_api:get_activity', 'idempotent'],
	['dd_utils_api:get_record_jobs', 'idempotent'],
	['dd_utils_api:get_record_info', 'idempotent'],
	['dd_utils_api:get_job_events', 'idempotent'],
	['dd_utils_api:get_process_status', 'idempotent'],
	['dd_utils_api:get_system_info', 'idempotent'],
	['dd_utils_api:get_login_context', 'idempotent'],
	['dd_utils_api:get_dedalo_files', 'idempotent'],
	['dd_utils_api:list_uploaded_files', 'idempotent'],
	['dd_utils_api:convert_search_object_to_sql_query', 'idempotent'],
	['dd_utils_api:get_server_ready_status', 'idempotent'],
	['dd_utils_api:get_ontology_update_info', 'idempotent'],
	['dd_utils_api:get_code_update_info', 'idempotent'],
	// ── dd_rag_api ─────────────────────────────────────────────────────────
	// The two generative doors are `mutating` not because they corrupt the
	// catalogue but because each attempt is a separate model run: replaying the
	// first answer is both cheaper and more truthful than a second one.
	['dd_rag_api:ask', 'mutating'],
	['dd_rag_api:characterize_object', 'mutating'],
	['dd_rag_api:retrieve', 'idempotent'],
	['dd_rag_api:semantic_search', 'idempotent'],
	['dd_rag_api:search_by_text_image', 'idempotent'],
	['dd_rag_api:similar_objects', 'idempotent'],
	['dd_rag_api:similar_to', 'idempotent'],
	['dd_rag_api:embed_groups', 'idempotent'],
	['dd_rag_api:get_agent_context', 'idempotent'],
	// ── dd_identify_api ────────────────────────────────────────────────────
	['dd_identify_api:identify_by_image', 'mutating'],
	['dd_identify_api:find_matches', 'idempotent'],
	['dd_identify_api:get_proposals', 'idempotent'],
	['dd_identify_api:resolve_type_link', 'idempotent'],
	// ── dd_external_api ────────────────────────────────────────────────────
	['dd_external_api:search', 'idempotent'],
	// ── dd_error_report_api ────────────────────────────────────────────────
	['dd_error_report_api:receive_report', 'mutating'],
	// ── dd_mcp_api ─────────────────────────────────────────────────────────
	// agent_apply's `plan_hash` is an INTEGRITY hash of the plan's own canonical
	// JSON, not a one-shot nonce: the same plan resent passes it every time, and
	// a plan may carry dedalo_create_record ops.
	['dd_mcp_api:agent_apply', 'mutating'],
	['dd_mcp_api:agent_chat', 'mutating'],
	['dd_mcp_api:agent_chat_stream', 'mutating'],
	['dd_mcp_api:mcp_proxy', 'mutating'],
	['dd_mcp_api:agent_models', 'idempotent'],
]);

/**
 * How long a completed answer (or an ambiguous outcome) stays on the ledger. It
 * must comfortably exceed the WHOLE client retry span, which was MEASURED
 * against the real transport with the shipped defaults: 5 attempts over 47.5 s,
 * and 78 s when the mid-attempt health probe kept extending the deadline.
 * Fifteen minutes also covers a frustrated operator's manual re-click after a
 * stalled save. ENFORCED ON THE READ PATH (withIdempotency sweeps and re-checks
 * before it replays), not only by the writer — a TTL only the writer honours is
 * not the window production has.
 */
const IDEMPOTENCY_TTL_MS = 15 * 60 * 1000;

/**
 * How long a TWIN waits for the leader it joined before giving up. Unbounded
 * waiting is not an option: a leader stuck on a Postgres row lock (this engine
 * holds owner row locks from read to COMMIT on the delete path) would pin one
 * socket per twin for the whole lock. Well past the transport's own 5 s
 * per-attempt deadline, so the ordinary slow-but-finishing leader is still
 * awaited and still de-duplicated; past it the twin is REFUSED
 * (`idempotency.in_progress`), never re-executed.
 */
const IDEMPOTENCY_TWIN_WAIT_MS = 10 * 1000;

/**
 * PER-PRINCIPAL bounds — the ones that carry the "one operator cannot evict
 * another's entries" property. A ledger entry belongs to the principal in its
 * key, and these two caps are applied to that principal's own entries alone.
 */
const IDEMPOTENCY_MAX_ENTRIES_PER_PRINCIPAL = 100;
const IDEMPOTENCY_MAX_BYTES_PER_PRINCIPAL = 1024 * 1024;

/**
 * PROCESS-WIDE backstop — a long-lived process may never grow an unbounded
 * cache, whatever the per-principal accounting says. NOT per-principal, and the
 * gate header says so plainly: reaching it takes tens of simultaneously active
 * operators (these caps divided by the per-principal ones), and eviction there
 * is oldest-first ACROSS principals. That is residual (b), stated, not hidden.
 */
const IDEMPOTENCY_MAX_ENTRIES = 5000;
const IDEMPOTENCY_MAX_TOTAL_BYTES = 32 * 1024 * 1024;

/**
 * Per-answer cap. Over it the answer is NOT stored and a later replay is refused
 * (`idempotency.replay_unavailable`) — the entry stays, because forgetting it
 * would re-admit the duplicate execution this whole gate exists to stop.
 */
const IDEMPOTENCY_MAX_BODY_BYTES = 512 * 1024;

/** Everything an ApiResult carries besides the body and the (unreplayable) stream. */
type ReplayableRest = Omit<ApiResult, 'body' | 'stream'>;

/**
 * What the leader left behind: a replayable answer, an answer too large to have
 * been stored, or an AMBIGUOUS OUTCOME — the handler threw, and since the write
 * doors here commit outside any transaction (duplicate_record opens none;
 * create commits then fires its save event), nobody knows whether it committed.
 * The third case is the one that must never become "run it again".
 */
type StoredResult =
	| { readonly rest: ReplayableRest; readonly body: string }
	| { readonly unavailable: true }
	| { readonly ambiguous: { readonly code: string; readonly requestId: string } };

interface LedgerEntry {
	/** sha256 of the request MINUS its key and csrf token — see requestFingerprint. */
	readonly fingerprint: string;
	/** The principal half of the ledger key — the scope its bounds are applied in. */
	readonly principalKey: string;
	readonly createdAt: number;
	/** The leader's promise while it runs; null once the outcome is stored. */
	pending: Promise<StoredResult> | null;
	stored: StoredResult | null;
	bytes: number;
}

/**
 * THE LEDGER. Module-level by necessity (it must outlive the request it
 * de-duplicates) and bounded by the constants above; entries are dropped by age
 * and by capacity in sweepIdempotencyLedger / sweepPrincipalEntries, which run
 * on EVERY ledgered request's read path and on every leader completion —
 * success and failure alike. A thrown handler does NOT drop its entry (see the
 * ambiguous-outcome rule in the gate header). It carries no cross-request
 * identity leak: the key embeds the authenticated principal, so one user's entry
 * can never answer another's request. Cleared wholesale only by the test seam.
 */
const idempotencyLedger = new Map<string, LedgerEntry>();

/** Running total of stored answer sizes — the second half of the memory bound. */
let idempotencyLedgerBytes = 0;

/** TEST SEAM (client_idempotency_tripwire): start from an empty, known ledger. */
export function resetIdempotencyLedgerForTests(): void {
	idempotencyLedger.clear();
	idempotencyLedgerBytes = 0;
}

/** TEST SEAM (same gate): the bounds are real numbers a gate can drive against. */
export function idempotencyLedgerStats(): {
	entries: number;
	bytes: number;
	maxEntries: number;
	maxTotalBytes: number;
	maxBodyBytes: number;
	maxEntriesPerPrincipal: number;
	maxBytesPerPrincipal: number;
	ttlMs: number;
	twinWaitMs: number;
} {
	return {
		entries: idempotencyLedger.size,
		bytes: idempotencyLedgerBytes,
		maxEntries: IDEMPOTENCY_MAX_ENTRIES,
		maxTotalBytes: IDEMPOTENCY_MAX_TOTAL_BYTES,
		maxBodyBytes: IDEMPOTENCY_MAX_BODY_BYTES,
		maxEntriesPerPrincipal: IDEMPOTENCY_MAX_ENTRIES_PER_PRINCIPAL,
		maxBytesPerPrincipal: IDEMPOTENCY_MAX_BYTES_PER_PRINCIPAL,
		ttlMs: IDEMPOTENCY_TTL_MS,
		twinWaitMs: IDEMPOTENCY_TWIN_WAIT_MS,
	};
}

/**
 * TEST SEAM (same gate): run the eviction pass at an ARBITRARY instant, so the
 * TTL branch can be driven without waiting fifteen minutes for it.
 */
export function sweepIdempotencyLedgerForTests(now: number): void {
	sweepIdempotencyLedger(now);
}

/**
 * TEST SEAM (same gate): fill the ledger with synthetic COMPLETED entries, so the
 * CAPACITY branches of the eviction can be tripped without issuing thousands of
 * real requests. Synthetic entries carry an unreachable fingerprint and a body
 * that is valid JSON, so nothing here can be mistaken for a real answer.
 *
 * `principal` decides WHICH bound the seed drives: one shared principal fills a
 * single principal's own cap, and the default (a distinct principal per entry)
 * fills the process-wide backstop without ever tripping the per-principal one.
 */
export function seedIdempotencyLedgerForTests(
	count: number,
	bytesEach: number,
	principal?: string,
): void {
	const body = `"${'x'.repeat(Math.max(0, bytesEach - 2))}"`;
	for (let index = 0; index < count; index++) {
		const principalKey = principal ?? `seed-principal-${index}`;
		idempotencyLedger.set(`${principalKey}\u0000seed\u0000${index}`, {
			fingerprint: `seed-${index}`,
			principalKey,
			createdAt: Date.now(),
			pending: null,
			stored: { rest: { status: 200 }, body },
			bytes: body.length,
		});
		idempotencyLedgerBytes += body.length;
	}
}

/** Both halves of the process-wide memory bound, as one question. */
function ledgerOverCapacity(): boolean {
	return (
		idempotencyLedger.size > IDEMPOTENCY_MAX_ENTRIES ||
		idempotencyLedgerBytes > IDEMPOTENCY_MAX_TOTAL_BYTES
	);
}

/**
 * A COMPLETED entry past the TTL. An IN-FLIGHT entry is never expired: its
 * leader still owes an answer to whoever is awaiting it.
 */
function isExpiredEntry(entry: LedgerEntry, now: number): boolean {
	return entry.pending === null && now - entry.createdAt > IDEMPOTENCY_TTL_MS;
}

/** Drop one entry and give its bytes back to the running total. */
function dropLedgerEntry(key: string, entry: LedgerEntry): void {
	idempotencyLedger.delete(key);
	idempotencyLedgerBytes -= entry.bytes;
}

/**
 * THE PER-PRINCIPAL BOUND — the one that makes "an operator cannot evict another
 * operator's entries" true. Walks this principal's own entries oldest-first (Map
 * iteration is insertion order) and drops the oldest COMPLETED ones until the
 * principal is back under both of its caps. Nothing outside `principalKey` is
 * ever touched here.
 */
function sweepPrincipalEntries(principalKey: string): void {
	const scope = principalLedgerEntries(principalKey);
	let entries = scope.entries;
	let bytes = scope.bytes;
	for (const [key, entry] of scope.mine) {
		if (
			entries <= IDEMPOTENCY_MAX_ENTRIES_PER_PRINCIPAL &&
			bytes <= IDEMPOTENCY_MAX_BYTES_PER_PRINCIPAL
		) {
			return;
		}
		if (entry.pending !== null) continue; // in flight — its twin still has to be answered
		dropLedgerEntry(key, entry);
		entries--;
		bytes -= entry.bytes;
	}
}

/**
 * ONE principal's entries, oldest-first (a Map iterates in insertion order and
 * entries are inserted on arrival), with their totals. Split out of the sweep
 * above so neither half carries the whole scan AND the whole eviction rule —
 * the complexity ratchet over src/core/ is what caught the merged version.
 */
function principalLedgerEntries(principalKey: string): {
	mine: Array<[string, LedgerEntry]>;
	entries: number;
	bytes: number;
} {
	const mine: Array<[string, LedgerEntry]> = [];
	let bytes = 0;
	for (const pair of idempotencyLedger) {
		if (pair[1].principalKey !== principalKey) continue;
		mine.push(pair);
		bytes += pair[1].bytes;
	}
	return { mine, entries: mine.length, bytes };
}

/**
 * Drop expired and over-capacity entries PROCESS-WIDE. A Map iterates in
 * INSERTION order and entries are inserted on arrival, so the oldest are at the
 * front: the walk stops at the first entry that is neither expired nor pushed
 * out by capacity, which makes the common case O(1). An IN-FLIGHT entry is never
 * evicted — its leader still has to publish an answer to whoever is awaiting it.
 */
function sweepIdempotencyLedger(now: number): void {
	for (const [key, entry] of idempotencyLedger) {
		const expired = isExpiredEntry(entry, now);
		if (!expired && !ledgerOverCapacity()) return;
		if (entry.pending !== null) continue;
		dropLedgerEntry(key, entry);
	}
}

/**
 * The request's identity, so a key accidentally reused for a DIFFERENT operation
 * is refused instead of silently swallowing that operation and handing back the
 * first one's answer (which would be data loss wearing a success).
 *
 * Two keys are excluded and must be: `idempotency_key` IS the ledger address, and
 * `csrf_token` rotates — including either would make a lawful retry look like a
 * different request. Null (⇒ no ledgering, today's behaviour) if the body cannot
 * be serialized: a lawful request is never failed by this gate's own bookkeeping.
 */
function requestFingerprint(rqo: Rqo): string | null {
	const { idempotency_key: _key, csrf_token: _token, ...rest } = rqo;
	try {
		return new Bun.CryptoHasher('sha256').update(JSON.stringify(rest)).digest('hex');
	} catch {
		return null;
	}
}

/** The principal half of a ledger key: the scope the per-principal bounds apply in. */
function idempotencyPrincipalKey(context: ApiRequestContext): string | null {
	return context.session === null ? null : String(context.session.userId);
}

/**
 * The ledger address for this request, or null when the request is not ledgered:
 * it carries no key, it is UNAUTHENTICATED (see the enumerated exclusion in the
 * gate header), or its action is classified `idempotent`. An action absent from
 * the map falls through as `mutating` — the fail-safe direction; the gate fails
 * on the absence separately, so it cannot stay unclassified.
 *
 * EXPORTED as a TEST SEAM (client_idempotency_tripwire drives the three
 * exclusions directly — an unauthenticated request in particular has no other
 * observable), never called from outside this file.
 */
export function idempotencyLedgerKey(
	rqo: Rqo,
	context: ApiRequestContext,
	actionKey: string,
): string | null {
	const key = rqo.idempotency_key;
	if (typeof key !== 'string') return null;
	const principalKey = idempotencyPrincipalKey(context);
	if (principalKey === null) return null;
	if (ACTION_IDEMPOTENCY.get(actionKey) === 'idempotent') return null;
	// `\u0000` separates the three parts: it cannot occur in a user id, an action
	// key or the key's own grammar, so no two distinct triples can collide the way
	// PHP's separator-less matrix_temp_manager uid did.
	return `${principalKey}\u0000${actionKey}\u0000${key}`;
}

/** An answer we could not store is one we must never invent a substitute for. */
function serializeForLedger(result: ApiResult): StoredResult {
	if (result.stream !== undefined) return { unavailable: true };
	const { body, stream: _stream, ...rest } = result;
	try {
		const serialized = JSON.stringify(body);
		if (serialized === undefined) return { unavailable: true };
		if (serialized.length > IDEMPOTENCY_MAX_BODY_BYTES) return { unavailable: true };
		return { rest, body: serialized };
	} catch {
		return { unavailable: true };
	}
}

/**
 * Rebuild the ORIGINAL answer for a twin, marked as the replay it is — or refuse,
 * typed, when there is no answer to give.
 *
 * THE AMBIGUOUS BRANCH IS THE POINT (see the gate header): the leader threw, and
 * the write doors under this gate commit outside any transaction, so re-running
 * would risk a second heritage record. The refusal names the original request_id
 * and error code so the operator can find the attempt in the log and check the
 * record before doing anything else.
 */
function replayStoredResult(stored: StoredResult, actionKey: string): ApiResult {
	if ('ambiguous' in stored) {
		throw new DedaloError('idempotency.outcome_unknown', {
			message:
				`The first attempt at '${actionKey}' failed with '${stored.ambiguous.code}' AFTER it may already have written. ` +
				`Original request_id ${stored.ambiguous.requestId}. This retry was refused rather than executed a second time.`,
			coordinates: { action: actionKey, request_id: stored.ambiguous.requestId },
			details: {
				action: actionKey,
				original_request_id: stored.ambiguous.requestId,
				original_error_code: stored.ambiguous.code,
			},
		});
	}
	if (!('body' in stored)) throw new DedaloError('idempotency.replay_unavailable');
	const body = JSON.parse(stored.body) as ApiResult['body'];
	// An extension key (ERRORS_SPEC §3.0), for operators and gates — the client
	// reads ok/data/error and is unaffected. executeRqo stamps THIS request's
	// csrf_token over the stored one on the way out.
	(body as unknown as Record<string, unknown>).idempotent_replay = true;
	return { ...stored.rest, body };
}

/**
 * Wait for the leader, BOUNDED. Past the bound the twin is refused
 * (`idempotency.in_progress`) — it must not execute, because a leader that is
 * still running is the most ambiguous outcome of all. The leader keeps running
 * and keeps its reservation, so the next retry gets its answer or its
 * `outcome_unknown`.
 *
 * EXPORTED as a TEST SEAM: the gate drives the deadline directly with a promise
 * that never settles, which is the only way to prove the bound trips without
 * standing a stuck leader up for the full ten seconds.
 */
export async function awaitLeaderBounded(
	pending: Promise<StoredResult>,
	actionKey: string,
	timeoutMs: number = IDEMPOTENCY_TWIN_WAIT_MS,
): Promise<StoredResult> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<'twin-wait-expired'>((resolve) => {
		timer = setTimeout(() => resolve('twin-wait-expired'), timeoutMs);
	});
	try {
		const outcome = await Promise.race([pending, deadline]);
		if (outcome === 'twin-wait-expired') {
			throw new DedaloError('idempotency.in_progress', {
				message: `The first attempt at '${actionKey}' under this key is still running after ${timeoutMs} ms; this retry was refused rather than executed a second time.`,
				coordinates: { action: actionKey },
				details: { action: actionKey },
			});
		}
		return outcome;
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/**
 * A twin of a request already under way (or already answered). It does NOT
 * execute: it waits for the leader (bounded) and returns the leader's answer,
 * which is what makes two identical requests in flight at once produce exactly
 * one execution and never a half-built response.
 */
async function replayIdempotentTwin(
	entry: LedgerEntry,
	fingerprint: string,
	actionKey: string,
): Promise<ApiResult> {
	if (entry.fingerprint !== fingerprint) {
		throw new DedaloError('idempotency.key_reused');
	}
	const stored =
		entry.pending !== null ? await awaitLeaderBounded(entry.pending, actionKey) : entry.stored;
	if (stored === null) throw new DedaloError('idempotency.replay_unavailable');
	return replayStoredResult(stored, actionKey);
}

/**
 * The first request under a key. It RESERVES the address synchronously — there is
 * no `await` between the `get` in withIdempotency and the `set` here, which is
 * what makes the reservation atomic in a single-threaded runtime — then runs, then
 * publishes its outcome to any twin that joined meanwhile.
 */
async function runIdempotentLeader(
	ledgerKey: string,
	principalKey: string,
	fingerprint: string,
	requestId: string,
	run: () => Promise<ApiResult>,
): Promise<ApiResult> {
	let publish!: (value: StoredResult) => void;
	// The promise is RESOLVED in both branches, never rejected: a twin is owed a
	// typed outcome, not the leader's raw exception, and a rejected promise with
	// no twin awaiting it would take the process down as an unhandled rejection.
	const pending = new Promise<StoredResult>((resolve) => {
		publish = resolve;
	});
	const entry: LedgerEntry = {
		fingerprint,
		principalKey,
		createdAt: Date.now(),
		pending,
		stored: null,
		bytes: 0,
	};
	idempotencyLedger.set(ledgerKey, entry);
	const complete = (stored: StoredResult): void => {
		entry.pending = null;
		entry.stored = stored;
		entry.bytes = 'body' in stored ? stored.body.length : 0;
		idempotencyLedgerBytes += entry.bytes;
		sweepPrincipalEntries(principalKey);
		sweepIdempotencyLedger(Date.now());
		publish(stored);
	};
	try {
		const result = await run();
		complete(serializeForLedger(result));
		return result;
	} catch (error) {
		// THE AMBIGUOUS-OUTCOME RULE (gate header). The reservation is KEPT, marked
		// ambiguous: this handler may already have committed — duplicate_record
		// opens no transaction at all, and create commits before it fires its save
		// event — so freeing the key here would hand the next automatic retry a
		// second clone of a heritage record. The leader still gets its own real
		// error; every later twin gets `idempotency.outcome_unknown`.
		complete({
			ambiguous: {
				code: error instanceof DedaloError ? error.code : 'internal.unexpected',
				requestId,
			},
		});
		throw error;
	}
}

/** Gate 4 itself: run once under this key, or answer with what the once produced. */
async function withIdempotency(
	rqo: Rqo,
	context: ApiRequestContext,
	actionKey: string,
	run: () => Promise<ApiResult>,
): Promise<ApiResult> {
	const ledgerKey = idempotencyLedgerKey(rqo, context, actionKey);
	if (ledgerKey === null) return run();
	const principalKey = idempotencyPrincipalKey(context);
	if (principalKey === null) return run();
	const fingerprint = requestFingerprint(rqo);
	if (fingerprint === null) return run();
	// THE TTL IS ENFORCED HERE, on the path requests actually take. Sweeping only
	// from the leader's success path (the first draft) made the documented window
	// unlike the window production had: a ledger that stopped receiving successful
	// writes kept replaying answers for as long as the process lived.
	const now = Date.now();
	sweepIdempotencyLedger(now);
	const existing = idempotencyLedger.get(ledgerKey);
	if (existing !== undefined) {
		// Belt AND braces: the sweep stops at the first live entry, so an expired
		// entry sitting behind a long-running in-flight one can survive it. An
		// expired entry is not replayable — drop it and lead.
		if (!isExpiredEntry(existing, now)) {
			return replayIdempotentTwin(existing, fingerprint, actionKey);
		}
		dropLedgerEntry(ledgerKey, existing);
	}
	return runIdempotentLeader(ledgerKey, principalKey, fingerprint, context.requestId, run);
}

/**
 * The gate chain + handler execution (see dispatchRqo) — and THE CATCH: the
 * one place a throw becomes a wire body. Every refusal below is a throw of a
 * registered code; the catch converts (registry status), logs, and threads
 * Retry-After. `csrf_token` is appended to every response for client
 * transparency (PHP parity), success or failure — and beside it ALWAYS
 * `session_user_id`, the user that token belongs to
 * (WC-2026-10-11-session-user-beside-csrf-token). A token is an identity: the
 * client adopts it only for its own page user (error_dispatch
 * settle_session_identity), so a page whose session was replaced by a login
 * elsewhere never moves onto it — not through the CSRF resend, not through an
 * exempt action's success. A handler that minted the session itself (login)
 * owns both keys; they are not overwritten with the request's previous session.
 */
async function executeRqo(rqo: Rqo, context: ApiRequestContext): Promise<ApiResult> {
	const apiClass = String(rqo.dd_api ?? 'dd_core_api');
	const action = String(rqo.action ?? '');
	let result: ApiResult;
	try {
		result = await runGatesAndHandler(rqo, context);
	} catch (error) {
		result = failureResult(error, context, `${apiClass}::${action}`);
	}
	if (context.session !== null && result.body.csrf_token === undefined) {
		result.body.csrf_token = context.session.csrfToken;
		result.body.session_user_id = context.session.userId;
	}
	return result;
}

/**
 * The converter door for the API surface. Poison-latch classification (a
 * TDZ ReferenceError anywhere in the cause chain flips /health to 503 so the
 * watchdog recycles the process) lives INSIDE toDedaloError, not here. The
 * raw exception text never reaches the wire (SQL fragments, paths): the
 * envelope carries the registry message + request_id; the exception is
 * echoed ONLY under DEDALO_DEBUG_API_ERRORS=true (convert.ts debug block).
 */
function failureResult(error: unknown, context: ApiRequestContext, subsystem: string): ApiResult {
	const converted = toErrorEnvelope(error, { requestId: context.requestId });
	logError(converted.error, { subsystem, requestId: context.requestId });
	return converted.retryAfterMs === undefined
		? { status: converted.status, body: converted.body }
		: { status: converted.status, body: converted.body, retryAfterMs: converted.retryAfterMs };
}

/**
 * Gate 1 — allowlist: the (class, action) pair must be EXPLICITLY registered.
 * Resolve with Object.hasOwn, NOT a bare index. `ACTION_REGISTRY[apiClass]?.[action]`
 * over plain object literals returns inherited Object.prototype builtins —
 * `constructor` (the Object function), `toString`/`valueOf`/`hasOwnProperty` —
 * instead of undefined, so a crafted `action:'constructor'` slipped past a
 * `=== undefined` check and violated the "an unregistered pair does not exist"
 * invariant (API-01). hasOwn on both keys + a typeof-function guard makes any
 * inherited key resolve to no handler ⇒ the documented `request.unknown_action`.
 */
function resolveHandler(apiClass: unknown, action: unknown): ActionHandler {
	const classTable = classTableFor(apiClass);
	const handler =
		classTable !== undefined && typeof action === 'string' && Object.hasOwn(classTable, action)
			? classTable[action]
			: undefined;
	if (typeof handler !== 'function') throw unknownAction(action);
	return handler;
}

function classTableFor(apiClass: unknown): Record<string, ActionHandler> | undefined {
	return typeof apiClass === 'string' && Object.hasOwn(ACTION_REGISTRY, apiClass)
		? ACTION_REGISTRY[apiClass]
		: undefined;
}

/**
 * The Gate-1 refusal — ALSO what a disabled Gate-1c surface answers, so the
 * two bodies are byte-identical (minus request_id) and a probe cannot learn
 * the endpoint exists on this host.
 */
function unknownAction(action: unknown): DedaloError {
	return new DedaloError('request.unknown_action', {
		details: { action: typeof action === 'string' ? action : String(action) },
	});
}

/**
 * Gate 1c — the pre-auth error-report intake window (WC-017). Disabled ⇒ the
 * EXACT Gate-1 unregistered-action refusal (unknownAction), so a probe cannot
 * learn the endpoint exists on this host; the optional IP allowlist reads the
 * one entry grammar (security/ip_allowlist.ts). Throttle/token/schema live in
 * the handler. (Gate 1b — the install window — was removed with the browser
 * installer: WC-2026-10-12-install-surface-removed. No install action exists.)
 */
function runPreAuthGates(actionKey: string, action: unknown, clientIp: string): void {
	if (ERROR_REPORT_ACTION_KEYS.has(actionKey)) runErrorReportGate(action, clientIp);
}

function runErrorReportGate(action: unknown, clientIp: string): void {
	if (!receiverEnabled()) throw unknownAction(action);
	if (!reporterIpAllowed(clientIp)) {
		throw new DedaloError('perm.denied', {
			publicMessage: 'Error report not permitted from this address',
		});
	}
}

/**
 * Gates 2 + 2b + 3 — authentication, maintenance, CSRF.
 *
 * 2 — the exemption is keyed on the (class, action) pair (NO_LOGIN_ACTIONS,
 * and nothing else). WC-051:
 * `auth.not_logged` is the code the client's re-login recovery dispatches on
 * — this is the path an EXPIRED session takes, so it is the one that must
 * reach render_relogin() rather than dying as a thrown fetch error.
 *
 * 2b — maintenance mode (AUTH-05). PHP verify_login() re-checks maintenance
 * on EVERY request and demotes any non-root session to unauthenticated while
 * the flag is set. The login gate (auth.ts login()) blocks only NEW logins, so
 * a session minted BEFORE maintenance was enabled stayed free to keep writing
 * into the matrix tables during a data-version migration under maintenance —
 * the exact corruption window this closes. Re-checked per request; refuses
 * every non-superuser session with `auth.maintenance` (401 — the
 * unauthenticated status, so the client's relogin policy keys on BOTH codes)
 * so only root — who enables and lifts maintenance — traverses.
 * `session.userId` is the user's section_id (-1 === SUPERUSER_ID for root),
 * the same identity the login gate keys on; getServerState() reads
 * ts_state.json uncached, so the flag is live the instant root sets it.
 *
 * 3 — CSRF for authenticated, non-exempt actions. `auth.csrf_failed` (403) is
 * the code the client's transparent single retry keys on (SEC-008,
 * data_manager); the envelope MUST carry the session's current token
 * (`csrf_token`, appended by executeRqo to every response) so that retry can
 * succeed — without the fresh token the client would loop on the stale one.
 * `action` rides as an extension key for the same reason it always did.
 */
async function runAuthGates(
	actionKey: string,
	action: unknown,
	context: ApiRequestContext,
): Promise<void> {
	if (context.session === null) {
		if (!NO_LOGIN_ACTIONS.has(actionKey)) throw new DedaloError('auth.not_logged');
		return;
	}
	await refuseUnderMaintenance(context.session.userId);
	if (!CSRF_EXEMPT_ACTIONS.has(actionKey) && !verifyCsrf(context.session, context.csrfCandidate)) {
		// ONE diagnostic line, in the LOG only (the wire body is unchanged — envelope
		// keys are contract). `auth.csrf_failed` alone cannot be acted on: a token that
		// was NEVER SENT is a client that has not obtained one yet (the bootstrap race
		// the client's single transparent retry exists for), while a token that was sent
		// and did not match is a STALE one — a page whose session was replaced by a
		// login elsewhere, or the beforeunload lock beacon carrying the previous
		// session's value. The channel separates them: 'header' is an XHR that will
		// retry, 'body' is sendBeacon, which cannot. NEVER the token bytes.
		console.warn(
			`[csrf] refused ${actionKey}: token ${context.csrfCandidate === null || context.csrfCandidate.length === 0 ? 'ABSENT' : 'MISMATCHED'} (channel: ${context.csrfSource ?? 'none'}, user: ${context.session.username})`,
		);
		throw new DedaloError('auth.csrf_failed', { extend: { action } });
	}
}

/** Gate 2b (see runAuthGates): every non-superuser session is refused while maintenance is on. */
async function refuseUnderMaintenance(userId: number): Promise<void> {
	// The ONE rule, shared with the non-dispatch routes (session_gate.ts).
	if (refusedUnderMaintenance(userId)) throw new DedaloError('auth.maintenance');
}

/** Gates 1 → 4, then the handler inside the request-scoped identity + language contexts. */
async function runGatesAndHandler(rqo: Rqo, context: ApiRequestContext): Promise<ApiResult> {
	const apiClass = rqo.dd_api ?? 'dd_core_api';
	const action = rqo.action;
	const handler = resolveHandler(apiClass, action);
	const actionKey = `${apiClass}:${action}`;
	runPreAuthGates(actionKey, action, context.clientIp);
	await runAuthGates(actionKey, action, context);

	// Resolve the authorization identity ONCE per request, now that the auth gate
	// has passed, and seed it on the context. Previously ~27 handlers each
	// re-resolved it from the DB via a dead `context.principal ?? …` fast-path;
	// they now read the seeded value through requirePrincipal(context).
	if (context.session !== null) {
		context.principal = await resolvePrincipal(context.session.userId);
	}

	// Gate 4 — IDEMPOTENCY. It wraps the handler (not the gates): a refusal above
	// executed nothing, so it must stay freely retryable. See the gate block above.
	const result = await withIdempotency(rqo, context, actionKey, () =>
		runHandlerScoped(rqo, context, handler),
	);
	assertEnvelopeBody(result, String(apiClass), String(action));
	return result;
}

/**
 * The handler, inside the request-scoped IDENTITY and LANGUAGE contexts (spec §4,
 * request-isolation invariant). Both are seeded from the session and read by
 * every resolver the handler reaches, so a long-lived process never bleeds one
 * caller's identity or language into another's request:
 *  - the identity scope (core/security/request_context.ts) carries the seeded
 *    principal + session as a BACKSTOP for leaf/future code with no parameter
 *    to reach for (the dominant path still threads `principal` explicitly);
 *  - the language scope (core/resolve/request_lang.ts) carries the effective
 *    interface/data languages (PHP per-request DEDALO_*_LANG constants), so a
 *    user's menu choice takes effect on the next request without threading a
 *    lang parameter through every call. Both fall back to install defaults
 *    when the session carries no override.
 */
async function runHandlerScoped(
	rqo: Rqo,
	context: ApiRequestContext,
	handler: ActionHandler,
): Promise<ApiResult> {
	const { runWithRequestContext } = await import('../security/request_context.ts');
	const { allowlistedPreauthLang, runWithRequestLangs } = await import(
		'../resolve/request_lang.ts'
	);
	return runWithRequestContext(
		{
			principal: context.principal,
			session: context.session,
			requestId: context.requestId,
			clientIp: context.clientIp,
		},
		() =>
			runWithRequestLangs(
				{
					// Session first, then the ANONYMOUS pre-auth language cookie (login
					// panel), then the install default. allowlistedPreauthLang is the ONE
					// door the cookie enters by (core/resolve/request_lang.ts).
					applicationLang:
						context.session?.applicationLang ??
						allowlistedPreauthLang(context.preauthLang) ??
						config.menu.applicationLang,
					dataLang: context.session?.dataLang ?? config.menu.dataLang,
				},
				() => handler(rqo, context),
			),
	);
}

/**
 * The one-producer law (ERRORS_SPEC §4): a handler returns `ok(...)` or
 * throws. A body without `ok` (a streamed result carries no serialized body
 * and is exempt) is a handler BUG — refused as `internal.unexpected` through
 * the executeRqo catch, coordinates naming the action, so it can never reach
 * the wire half-shaped and silently "work".
 */
function assertEnvelopeBody(result: ApiResult, apiClass: string, action: string): void {
	if (result.stream !== undefined) return;
	const body: unknown = result.body;
	if (typeof body === 'object' && body !== null && Object.hasOwn(body, 'ok')) return;
	throw new DedaloError('internal.unexpected', {
		message: `handler ${apiClass}::${action} returned a non-envelope body (no \`ok\` key)`,
		coordinates: { api_class: apiClass, action },
	});
}
