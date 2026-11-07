/**
 * dd_tools_api.tool_request dispatch (PHP dd_tools_api::tool_request).
 *
 * PHP loads the tool class file and reflects a static method behind ten ordered
 * gates. The TS engine keeps the same ORDER and semantics, but the reflection
 * gates (class-file resolve, public+static, signature) are structural: a tool's
 * server module is discovered by an allowlisted scan (loader.ts) and its actions
 * are typed functions, so "the method exists and is callable" is a Map lookup,
 * not runtime reflection.
 *
 * Gate order:
 *  1. options must be an object;
 *  2. the tool name must match ^tool_[a-z0-9_]+$ (reject before any lookup);
 *  3+4. the tool must be ACTIVE in dd1324 AND authorized for the calling user
 *       (admins get every active tool; non-admins the profile-granted dd1067 set
 *       plus always_active tools — PHP get_user_tools);
 *  5. the tool must have a loaded server module (PHP: class file resolves +
 *     realpath-confined require);
 *  6. the method must be in the module's apiActions (PHP API_ACTIONS allowlist);
 *  7. the action's declarative permission gate must pass — BEFORE any background
 *     fork (PHP invariant);
 *  8. execute: direct, or (background_running) via the background executor,
 *     which additionally enforces the BACKGROUND_RUNNABLE allowlist. An action
 *     that declares `readOnly` runs its handler inside the read-only request
 *     scope (security/read_only_scope.ts).
 *
 * The tool response REPLACES the API envelope wholesale — so it IS the API
 * envelope (envelope v2, engineering/ERRORS_SPEC.md §4): every gate here
 * REFUSES BY THROWING a registered `tool.*` / `perm.*` / `request.*` code
 * (converted by the dispatch chokepoint), and a tool action returns
 * `ok(data, {requestId, extend?})` — a body without `ok` is a bug the
 * dispatcher refuses (the P1-era legacy_body_adapter is DELETED).
 */

import { DedaloError } from '../errors/dedalo_error.ts';
import { LEGACY_TOKEN_MAP } from '../errors/registry.ts';
import { type Principal, SUPERUSER_ID } from '../security/permissions.ts';
import { runReadOnly } from '../security/read_only_scope.ts';
import { runAdmission, scheduleBackground } from './background.ts';
import {
	BACKGROUND_JOB_STATUS_ACTION,
	BACKGROUND_JOBS_ACTION,
	backgroundJobStatusResponse,
	backgroundJobsResponse,
} from './job_status.ts';
import { getLoadedTool } from './loader.ts';
import type { ToolActionContext, ToolActionSpec, ToolResponse } from './module.ts';
import { assertActionPermission, isToolGranted, resolveAction } from './security.ts';

const TOOL_NAME_PATTERN = /^tool_[a-z0-9_]+$/;

/**
 * Gates 3+4: the SUPERUSER holds every active tool, so for it an unknown name IS
 * an invalid name; anyone else — a global admin included — is refused
 * authorization (no existence leak). Keyed on the identity, never the admin
 * flag (the flag stopped widening the tool list on 2026-08-09; this branch kept
 * it until req 8, answering a non-superuser admin `tool.invalid_name` for a
 * real tool its profile does not grant).
 */
function unknownTool(userId: number, toolName: string): DedaloError {
	return new DedaloError(userId === SUPERUSER_ID ? 'tool.invalid_name' : 'tool.not_authorized', {
		coordinates: { tool: toolName },
	});
}

/**
 * Gate 7: security.ts still answers with a legacy token (`unauthorized` →
 * perm.denied / `invalid_request` → request.invalid); mapped here until its
 * own sweep makes it throw.
 */
function permissionRefusal(
	permission: { msg: string; errors: string[] },
	toolName: string,
	toolMethod: string,
): DedaloError {
	const token = permission.errors[0];
	return new DedaloError(LEGACY_TOKEN_MAP[token ?? ''] ?? 'perm.denied', {
		publicMessage: permission.msg,
		coordinates: { tool: toolName, method: toolMethod },
	});
}

/**
 * THE ONE PREDICATE for "this request runs read-only", asked twice by design:
 * by Gate 4 of the API dispatcher BEFORE the handler (to skip the idempotency
 * ledger, {@link isReadOnlyToolRequest}) and by the executor below (to open the
 * read-only request scope). One function means the two cannot disagree: a MODULE
 * action the ledger waved through is always one the scope then polices. The one
 * exception is not a module action: the two reserved framework job actions
 * (`isJobFrameworkAction`, status / list) classify read-only without a module and
 * are answered before `runForeground`, so they never run under `runReadOnly` —
 * harmless, because their code (job_status.ts) only reads the job registry.
 *
 * A background request is never read-only — scheduling a job is a write, and
 * the loader refuses a readOnly action that is also backgroundRunnable, so
 * `scheduleBackground` refuses it anyway.
 */
function runsReadOnly(spec: ToolActionSpec, options: Record<string, unknown>): boolean {
	return spec.readOnly === true && options.background_running !== true;
}

/**
 * Is this tool_request RQO a READ-ONLY action, resolved from the LOADED module's
 * own declaration — the answer the API idempotency gate (Gate 4, api/dispatch.ts)
 * needs BEFORE the tool grant, action lookup and permission gates below have run.
 *
 * Classification only ever REMOVES a request from the ledger, so the direction of
 * every doubt is `false` (mutating, ledgered): an options value that is not an
 * object, a name outside the tool grammar, an unloaded tool, an unknown action,
 * a background request, a lookup that throws — and a caller the tool is not
 * granted to. It never consults the client's own claim — the answer is the
 * module's `readOnly` flag for exactly this (tool, action) pair, never the
 * action NAME alone (the same name exists in many tools).
 *
 * THE GRANT IS ASKED FIRST (the same decision as Gates 3+4, isToolGranted),
 * because classification runs before those gates and its answer is observable:
 * a read-only request is not ledgered, so a caller who sends the same keyed
 * request twice sees a different second answer for a read-only pair
 * (`tool.not_authorized` again) than for any other (`idempotency.outcome_unknown`).
 * Answered for a caller who is not granted the tool, that difference would tell
 * them which tools and actions exist and which declare readOnly — the existence
 * leak `unknownTool` exists to prevent. With the grant asked first, an ungranted
 * caller gets ONE sequence whatever they name.
 *
 * The two reserved framework job actions (status / list) read the job registry
 * and nothing else, so they classify read-only without a module (still behind
 * the grant).
 */
export async function isReadOnlyToolRequest(
	userId: number,
	source: { model?: unknown; action?: unknown } | undefined,
	options: unknown,
): Promise<boolean> {
	try {
		const candidate = readOnlyCandidate(source, options);
		if (candidate === null) return false;
		if (!(await isToolGranted(userId, candidate.tool))) return false;
		return await candidateDeclaresReadOnly(candidate);
	} catch {
		return false;
	}
}

/**
 * Past the grant: a reserved framework job action, or a module action whose own
 * spec declares `readOnly` (an unloaded tool or an unknown action answers false).
 */
async function candidateDeclaresReadOnly(candidate: {
	tool: string;
	method: string;
	options: Record<string, unknown>;
}): Promise<boolean> {
	if (isJobFrameworkAction(candidate.method)) return true;
	const loaded = await getLoadedTool(candidate.tool);
	const spec = loaded === undefined ? null : resolveAction(loaded.module, candidate.method);
	return spec !== null && runsReadOnly(spec, candidate.options);
}

/**
 * Gates 1-2 of the dispatch chain, and the background exclusion, as a pure step
 * of the classifier: the (tool, method, options) a request names, or null when
 * it cannot be a read-only request (options not an object, a name outside the
 * tool grammar, a background request).
 */
function readOnlyCandidate(
	source: { model?: unknown; action?: unknown } | undefined,
	options: unknown,
): { tool: string; method: string; options: Record<string, unknown> } | null {
	const optionRecord = optionsRecordOf(options);
	if (optionRecord === null) return null;
	const tool = stringOr(source?.model);
	if (!TOOL_NAME_PATTERN.test(tool) || optionRecord.background_running === true) return null;
	return { tool, method: stringOr(source?.action), options: optionRecord };
}

/** The request's options as a record: absent → {}, anything but an object → null. */
function optionsRecordOf(options: unknown): Record<string, unknown> | null {
	if (options === undefined) return {};
	if (typeof options !== 'object' || options === null) return null;
	return options as Record<string, unknown>;
}

/** A value when it is a string, else ''. */
function stringOr(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

/** The two reserved framework actions (job status / list): they read the job registry only. */
function isJobFrameworkAction(method: string): boolean {
	return method === BACKGROUND_JOB_STATUS_ACTION || method === BACKGROUND_JOBS_ACTION;
}

/**
 * Dispatch one tool_request RQO through all gates. `source.model` names the
 * tool, `source.action` the method, `options` are the method arguments.
 */
export async function dispatchToolRequest(
	principal: Principal,
	userId: number,
	source: { model?: unknown; action?: unknown },
	options: unknown,
	clientIp?: string,
): Promise<ToolResponse> {
	// Gate 1: options must be an object (PHP rejects non-object overrides).
	if (options !== undefined && (typeof options !== 'object' || options === null)) {
		throw new DedaloError('request.invalid_options', { publicMessage: 'Invalid options type' });
	}
	const toolName = typeof source.model === 'string' ? source.model : '';
	const toolMethod = typeof source.action === 'string' ? source.action : '';

	// Gate 2: strict tool-name shape before ANY lookup (path/injection guard).
	if (!TOOL_NAME_PATTERN.test(toolName)) {
		throw new DedaloError('tool.invalid_name', { coordinates: { tool: toolName } });
	}

	// Gates 3 + 4: ACTIVE in dd1324 AND authorized for the calling user — the one
	// grant decision (security.ts isToolGranted).
	if (!(await isToolGranted(userId, toolName))) throw unknownTool(userId, toolName);

	// Framework status action (S2-16/DEC-22a): poll a background job started on
	// this tool. Served here — after the active+authorized gates, before the
	// module lookup — so every backgroundRunnable tool gets the wire without
	// per-module registration. The name is RESERVED (see job_status.ts).
	if (toolMethod === BACKGROUND_JOB_STATUS_ACTION) {
		return backgroundJobStatusResponse(
			toolName,
			principal,
			userId,
			(options ?? {}) as Record<string, unknown>,
		);
	}

	// The companion framework action: LIST the caller's jobs for this tool. It is
	// what lets a reloading client re-attach to a running job WITHOUT having
	// persisted its id (see job_status.ts BACKGROUND_JOBS_ACTION). Same reserved
	// name + same gates as the status action above.
	if (toolMethod === BACKGROUND_JOBS_ACTION) {
		return backgroundJobsResponse(
			toolName,
			principal,
			userId,
			(options ?? {}) as Record<string, unknown>,
		);
	}

	// Gate 5: the tool must have a loaded server module (PHP class-file resolve).
	const loaded = await getLoadedTool(toolName);
	if (loaded === undefined) {
		throw new DedaloError('tool.no_server_module', { coordinates: { tool: toolName } });
	}

	// Gate 6: explicit action registry (the TS API_ACTIONS allowlist).
	const spec = resolveAction(loaded.module, toolMethod);
	if (spec === null) {
		throw new DedaloError('tool.method_not_allowed', {
			details: { method: toolMethod },
			coordinates: { tool: toolName },
		});
	}

	// Gate 7: declarative permission gate BEFORE the handler / background fork.
	const optionRecord = (options ?? {}) as Record<string, unknown>;
	const permission = await assertActionPermission(spec, optionRecord, principal);
	if (!permission.ok) {
		throw permissionRefusal(permission, toolName, toolMethod);
	}

	// Gates 7b + 8: the action's own admission policy (ToolActionSpec.admit),
	// then execute. A background request runs through the executor, which
	// enforces the BACKGROUND_RUNNABLE allowlist and runs the admission INSIDE
	// the synchronous step that registers the job — admitting here, before an
	// `await`, would let a concurrent submission count the same registry and
	// pass a per-user cap twice. A foreground request is admitted, then runs.
	if (optionRecord.background_running === true) {
		return scheduleBackground(loaded, toolMethod, spec, optionRecord, principal, userId, clientIp);
	}
	runAdmission(spec, principal, userId, optionRecord, { tool: toolName, method: toolMethod });
	return runForeground(spec, {
		principal,
		userId,
		options: optionRecord,
		background: false,
		clientIp,
	});
}

/**
 * Foreground execution of a gated, admitted action. A read-only action's handler
 * runs inside the read-only request scope: every record / history / activity /
 * job write door refuses there (security/read_only_scope.ts), so a wrong
 * `readOnly` declaration fails loudly instead of skipping the ledger for a
 * writer (the activity row's emitter swallows its refusal: dropped and logged,
 * and caught by the static walk instead). runsReadOnly is the predicate Gate 4
 * classified the request with.
 */
function runForeground(spec: ToolActionSpec, context: ToolActionContext): Promise<ToolResponse> {
	if (runsReadOnly(spec, context.options)) return runReadOnly(() => spec.handler(context));
	return spec.handler(context);
}
