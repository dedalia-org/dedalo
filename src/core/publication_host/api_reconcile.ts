/**
 * PUBLICATION API LOCKSTEP (PUBLICATION_HOST_SPEC §3 "Lockstep", phase 4) — the ONE
 * reconciler that makes every paired publication host serve the Publication API
 * release of the engine tree that is running.
 *
 * GROUND TRUTH is the installed tree, never a download: the release id is
 * `<DEDALO_VERSION>_<INSTALLED_DIGEST[0:7]>` (L2), and the tree must still equal the
 * per-file manifest the updater wrote at extract time (L1,
 * update/publication_manifest.ts, whose verify is ASYNC and AWAITED here). No digest
 * (a dev checkout), a missing manifest, a digest mismatch or ONE drifted file REFUSES
 * the whole round before any agent is dialled: a release id names a whole tree, and a
 * tree edited after the update is not the release it claims to be. A round with no
 * selected host hashes nothing.
 *
 * THREE CALLERS, one function (L5):
 *  1. the confirmed-boot hook (`triggerPublicationApiPush`, passed by server.ts to
 *     boot_confirm.ts) — detached, never throws, skipped in a smoke boot or install
 *     mode. A RESTORE confirms through the same sentinel, so a restored tree pushes
 *     its own (older) release: lockstep both ways;
 *  2. the root-only `publication_hosts.push_apis` widget action;
 *  3. `PUBLICATION_APIS_RECONCILE`, an interval DRY check in the reconcile registry.
 *     Its APPLY is refused there: code reaches a public host only from root or from a
 *     confirmed boot — never from a timer, and never from a global admin's Apply.
 *
 * PER HOST: v2 first, then v1, each on its own (L6) — one API's failure is recorded
 * (runtime.ts `apis[api]`) and shown red; it never hides the other's result. A host
 * already holding the target as its `previous` release gets `promote_existing`: the
 * agent re-points `current` without reading a body (phase-2 D9). An API the host does not
 * SERVE (its status `served_apis`: a v2-only site has no Publication API v1) is
 * `not_served`: no bundle is built for it, nothing is sent or recorded, it is never drift,
 * and the panel shows it neutral (WC-2026-10-09-publication-host-v2-only-site).
 *
 * Failures are recorded by CODE, never agent prose: a DedaloError's code;
 * `bundle_refused:<reason>` (api_bundles.ts ApiBundleError, its paths named in the
 * report's `detail`); `bundle_write:<reason>` (bundle_writer.ts); `runtime_invalid`
 * (runtime.ts); else `internal.unexpected` with the text logged. A runtime write that
 * fails never stops a push: it is logged and reported as `runtime_error`.
 *
 * THE PANEL NEVER HASHES. Every round remembers its verdict (`lastVerifiedTarget`);
 * `buildApiLockstepPanel` shows that verdict and its time — hashing two API trees
 * (tens of thousands of files) on every panel load would be unbounded work on the
 * request path. Before any round since boot the panel says "not verified yet".
 *
 * The deps object is the test seam: production passes nothing and gets
 * `defaultApiReconcileDeps()`.
 */

import { projectRoot } from '../../config/env.ts';
import { DedaloError } from '../errors/dedalo_error.ts';
import type {
	ReconcileDefinition,
	ReconcileReport,
	ReconcileRunOptions,
} from '../reconcile/registry.ts';
import { INSTALLED_DIGEST } from '../update/install_stamp.ts';
import {
	type PublicationTreeVerdict,
	verifyPublicationTree,
} from '../update/publication_manifest.ts';
import { DEDALO_DATA_VERSION, formatVersion } from '../update/version.ts';
import { hostInstallRelease, hostStatus } from './agent_client.ts';
import {
	type ApiBundle,
	ApiBundleError,
	buildApiBundle,
	publicationReleaseId,
} from './api_bundles.ts';
import { BundleWriteError } from './bundle_writer.ts';
import type { HostPanelRow } from './host_status.ts';
import { loadRegistry, RegistryError } from './registry.ts';
import { type HostRuntime, RuntimeStateError, updateHostRuntime } from './runtime.ts';
import { registryError } from './wire.ts';

export type { ApiBundle };

export type ApiName = 'v1' | 'v2';

/** L6: v2 first, then v1 — each pushed and recorded on its own. */
export const API_PUSH_ORDER: readonly ApiName[] = Object.freeze(['v2', 'v1'] as const);

/** The scheduled DRY check's period (L5): one /v1/status per host per hour. */
export const PUBLICATION_APIS_CHECK_EVERY_MS = 60 * 60 * 1000;

/** The audit actor the agent records for a push started by a confirmed boot. */
export const CONFIRM_HOOK_ACTOR = 'system:code_update_confirm';

/** The actor of the registry's dry check (it never installs; carried for the shape). */
export const RECONCILE_ACTOR = 'system:reconcile';

/** How many paths a refusal or a detail names before it summarises the rest. */
const MAX_NAMED_PATHS = 10;

/**
 * `not_served`: the host is a v2-only site (its status `served_apis` lacks the api) — nothing
 * is built, sent or recorded for it, and it is never drift.
 */
export type ApiAction = {
	action: 'none' | 'install' | 'promote_existing';
	result: 'ok' | 'failed' | 'dry_run' | 'skipped' | 'not_served';
	error?: string;
	/** The paths a bundle refusal named (engine-generated, never agent prose). */
	detail?: string;
};

export interface ApiReconcileReport {
	release: string | null;
	refused: string | null;
	hosts: { name: string; v1: ApiAction; v2: ApiAction }[];
	/** A runtime write failed during the round (the push itself still ran). */
	runtime_error?: string;
}

/** What the installed tree may push: a verified release id, or why not. */
export type TargetRelease =
	| { releaseId: string; refused: null }
	| { releaseId: null; refused: string };

/** The verdict of the last round in this process, and when it was reached. */
export interface VerifiedTarget {
	target: TargetRelease;
	at: string;
}

/** One API as the agent holds it (phase-2 GET /v1/status `apis[api]`). */
export interface HeldRelease {
	current: string | null;
	previous: string | null;
}
export type AgentApiReleases = Record<ApiName, HeldRelease>;

/** What a round reads from one agent's status: the releases it holds and the APIs it serves. */
export interface AgentApiView {
	apis: AgentApiReleases;
	/** GET /v1/status `served_apis`: ['v1','v2'], or ['v2'] on a v2-only site. */
	served: readonly ApiName[];
}

export type ApiRuntimeEntry = HostRuntime['apis'][ApiName];

type PushMode = 'install' | 'promote_existing';

/** Every effect of a round — injected by tests, `defaultApiReconcileDeps()` in production. */
export interface ApiReconcileDeps {
	target(): Promise<TargetRelease>;
	hostNames(): string[];
	agentApis(name: string): Promise<AgentApiView>;
	bundle(api: ApiName): Promise<ApiBundle>;
	install(
		name: string,
		api: ApiName,
		bundle: ApiBundle,
		mode: PushMode,
		actor: string,
	): Promise<void>;
	/** ASYNC: runtime.ts takes the file's async lock (a write never blocks the event loop). */
	record(name: string, api: ApiName, entry: ApiRuntimeEntry): Promise<void>;
	now(): string;
}

export interface ReconcileApisOptions {
	apply: boolean;
	hosts?: string[];
	actor: string;
}

export type ReconcileApisFn = (opts: ReconcileApisOptions) => Promise<ApiReconcileReport>;

type TreeRefusal = Extract<PublicationTreeVerdict, { ok: false }>;

/** `a, b, … (+N more)` — bounded. */
function namedList(paths: readonly string[]): string {
	const rest = paths.length - MAX_NAMED_PATHS;
	return `${paths.slice(0, MAX_NAMED_PATHS).join(', ')}${rest > 0 ? ` (+${rest} more)` : ''}`;
}

/**
 * The release this tree may push (L1 + L2). The id comes from THE one L2 rule
 * (api_bundles.publicationReleaseId: a 64-hex digest, `<version>_<digest7>`), checked
 * BEFORE anything is hashed. Each verdict is AWAITED (Task 2's verify hashes
 * asynchronously); v2 is verified first (the push order) and the first refusal wins, so
 * a refused round names exactly one cause.
 */
export async function resolveTargetRelease(input: {
	version: string;
	digest: string | null;
	verify: (api: ApiName) => Promise<PublicationTreeVerdict>;
}): Promise<TargetRelease> {
	const releaseId = releaseIdOrNull(input.version, input.digest);
	if (releaseId === null) return { releaseId: null, refused: 'no_verified_release' };
	for (const api of API_PUSH_ORDER) {
		const verdict = await input.verify(api);
		if (!verdict.ok) return { releaseId: null, refused: refusalText(api, verdict) };
	}
	return { releaseId, refused: null };
}

function releaseIdOrNull(version: string, digest: string | null): string | null {
	try {
		return publicationReleaseId(version, digest);
	} catch (error) {
		if (error instanceof ApiBundleError) return null;
		throw error;
	}
}

/** `v1: drift: a, b, … (+N more)` — names the files (Review Focus 1), bounded. */
function refusalText(api: ApiName, verdict: TreeRefusal): string {
	if (verdict.reason !== 'drift') return `${api}: ${verdict.reason}`;
	return `${api}: drift: ${namedList(verdict.drift)}`;
}

/** The production effects: the running tree, the phase-3 registry/client, the runtime file. */
export function defaultApiReconcileDeps(): ApiReconcileDeps {
	return {
		target: () =>
			resolveTargetRelease({
				version: formatVersion(DEDALO_DATA_VERSION),
				digest: INSTALLED_DIGEST,
				// expectedDigest = the RUNNING digest (plan Interfaces): a manifest written for
				// another archive is digest_mismatch, never a pass.
				verify: (api) => verifyPublicationTree(projectRoot, api, INSTALLED_DIGEST ?? undefined),
			}),
		hostNames: registeredHostNames,
		agentApis: async (name) => {
			const status = await hostStatus(name);
			return { apis: status.apis, served: status.served_apis };
		},
		bundle: (api) => buildApiBundle(api),
		install: async (name, api, bundle, mode, actor) => {
			await hostInstallRelease(
				name,
				api,
				bundle.releaseId,
				bundle.sha256,
				bundleBody(bundle, mode),
				actor,
			);
		},
		record: async (name, api, entry) => {
			await updateHostRuntime(name, (current) => ({
				...current,
				apis: { ...current.apis, [api]: entry },
			}));
		},
		now: () => new Date().toISOString(),
	};
}

/** The registry's host names; a corrupt/locked registry is the family's typed error. */
function registeredHostNames(): string[] {
	try {
		return loadRegistry().hosts.map((host) => host.name);
	} catch (error) {
		throw error instanceof RegistryError ? registryError(error.reason) : error;
	}
}

/**
 * D9: an agent that already holds the release promotes it WITHOUT reading the body
 * (its recorded sha must equal the one sent), so a promote streams nothing.
 */
function bundleBody(bundle: ApiBundle, mode: PushMode): ReadableStream<Uint8Array> {
	return mode === 'install' ? Bun.file(bundle.file).stream() : new Blob([]).stream();
}

// Process-lifetime single-flight latch for APPLY rounds (module_state_tripwire
// allowlisted): set synchronously before the first await, cleared in `finally`. It
// holds no request identity — only "a push is running in this process" — so the
// confirm hook, the widget and a second click cannot interleave installs.
let applyRunning = false;

// The verdict of the last round that hashed the tree (module_state_tripwire
// allowlisted): the panel shows it instead of hashing on every load. Install-static
// facts only (the running tree's release or refusal + a time), never request identity.
let lastVerdict: VerifiedTarget | null = null;

/** The last round's verdict in this process, or null when none has run since boot. */
export function lastVerifiedTarget(): VerifiedTarget | null {
	return lastVerdict;
}

/**
 * THE reconciler. Dry (`apply:false`) reports what a push would do and writes nothing;
 * apply pushes, records every host×API in the runtime file, and never throws for a
 * per-host failure (it is in the report). It throws only for a refused CALL: an
 * unknown host filter (`resource.not_found`), or a concurrent apply (`resource.conflict`).
 */
export async function reconcilePublicationApis(
	opts: ReconcileApisOptions,
	deps: ApiReconcileDeps = defaultApiReconcileDeps(),
): Promise<ApiReconcileReport> {
	if (!opts.apply) return runRound(opts, deps);
	if (applyRunning) {
		throw new DedaloError('resource.conflict', {
			message: 'a Publication API push is already running in this process',
		});
	}
	applyRunning = true;
	try {
		return await runRound(opts, deps);
	} finally {
		applyRunning = false;
	}
}

interface RoundContext {
	apply: boolean;
	actor: string;
	target: TargetRelease;
	deps: ApiReconcileDeps;
	bundles: Map<ApiName, Promise<ApiBundle>>;
	runtimeError: string | null;
}

async function runRound(
	opts: ReconcileApisOptions,
	deps: ApiReconcileDeps,
): Promise<ApiReconcileReport> {
	const names = selectHosts(deps.hostNames(), opts.hosts);
	if (names.length === 0) return { release: null, refused: null, hosts: [] };
	const target = await deps.target();
	lastVerdict = { target, at: deps.now() };
	const ctx: RoundContext = {
		apply: opts.apply,
		actor: opts.actor,
		target,
		deps,
		bundles: new Map(),
		runtimeError: null,
	};
	const hosts: ApiReconcileReport['hosts'] = [];
	for (const name of names) hosts.push(await reconcileHost(name, ctx));
	const report: ApiReconcileReport = { release: target.releaseId, refused: target.refused, hosts };
	return ctx.runtimeError === null ? report : { ...report, runtime_error: ctx.runtimeError };
}

function selectHosts(all: string[], wanted: string[] | undefined): string[] {
	if (wanted === undefined) return all;
	const unknown = wanted.filter((name) => !all.includes(name));
	if (unknown.length > 0) {
		throw new DedaloError('resource.not_found', {
			message: `publication host(s) not in the registry: ${unknown.join(', ')}`,
			coordinates: { publication_host: unknown.join(',') },
		});
	}
	return all.filter((name) => wanted.includes(name));
}

async function reconcileHost(
	name: string,
	ctx: RoundContext,
): Promise<ApiReconcileReport['hosts'][number]> {
	const target = ctx.target;
	if (target.releaseId === null) {
		const refused: ApiAction = { action: 'none', result: 'skipped', error: target.refused };
		return await uniformRow(name, ctx, refused, 'pending');
	}
	let view: AgentApiView;
	try {
		view = await ctx.deps.agentApis(name);
	} catch (error) {
		return await uniformRow(name, ctx, failedAction('none', error), 'unknown');
	}
	const row: Record<ApiName, ApiAction> = { v1: NOT_SERVED_ACTION, v2: NOT_SERVED_ACTION };
	for (const api of API_PUSH_ORDER) {
		// A v2-only site serves no v1: no bundle is built for it, nothing sent, nothing recorded.
		row[api] = view.served.includes(api)
			? await reconcileApi(name, api, target.releaseId, view.apis[api], ctx)
			: { ...NOT_SERVED_ACTION };
	}
	return { name, v1: row.v1, v2: row.v2 };
}

const NOT_SERVED_ACTION: ApiAction = Object.freeze({ action: 'none', result: 'not_served' });

/** The same verdict for both APIs (a refused round, an unreachable host). */
async function uniformRow(
	name: string,
	ctx: RoundContext,
	action: ApiAction,
	state: ApiRuntimeEntry['state'],
): Promise<ApiReconcileReport['hosts'][number]> {
	for (const api of API_PUSH_ORDER) await settle(ctx, name, api, action, state);
	return { name, v1: { ...action }, v2: { ...action } };
}

async function reconcileApi(
	name: string,
	api: ApiName,
	release: string,
	held: HeldRelease,
	ctx: RoundContext,
): Promise<ApiAction> {
	const action = actionFor(release, held);
	if (action === 'none') return await settle(ctx, name, api, { action, result: 'ok' }, 'ok');
	if (!ctx.apply) return { action, result: 'dry_run' };
	try {
		const bundle = await bundleFor(ctx, api, release);
		await ctx.deps.install(name, api, bundle, action, ctx.actor);
	} catch (error) {
		return await settle(ctx, name, api, failedAction(action, error), 'failed');
	}
	return await settle(ctx, name, api, { action, result: 'ok' }, 'ok');
}

function actionFor(release: string, held: HeldRelease): ApiAction['action'] {
	if (held.current === release) return 'none';
	return held.previous === release ? 'promote_existing' : 'install';
}

/** One build per API per round, shared by every host (a failure fails them all once). */
function bundleFor(ctx: RoundContext, api: ApiName, release: string): Promise<ApiBundle> {
	let pending = ctx.bundles.get(api);
	if (pending === undefined) {
		pending = buildChecked(ctx, api, release);
		ctx.bundles.set(api, pending);
	}
	return pending;
}

async function buildChecked(ctx: RoundContext, api: ApiName, release: string): Promise<ApiBundle> {
	const bundle = await ctx.deps.bundle(api);
	if (bundle.releaseId !== release) {
		throw new DedaloError('internal.invariant', {
			message: `the ${api} bundle was built as ${bundle.releaseId} but the verified tree is ${release}`,
		});
	}
	return bundle;
}

/**
 * Record the outcome in the runtime file — APPLY rounds only (a dry run writes
 * nothing). A failed write is logged and reported once per round; it never stops the push.
 */
async function settle(
	ctx: RoundContext,
	name: string,
	api: ApiName,
	action: ApiAction,
	state: ApiRuntimeEntry['state'],
): Promise<ApiAction> {
	if (!ctx.apply) return action;
	const entry: ApiRuntimeEntry = {
		state,
		release: ctx.target.releaseId,
		error: action.error ?? null,
		at: ctx.deps.now(),
	};
	try {
		await ctx.deps.record(name, api, entry);
	} catch (error) {
		console.error(`[publication_apis] could not record ${name}/${api} in the runtime file:`, error);
		ctx.runtimeError ??= errorCode(error);
	}
	return action;
}

function failedAction(action: ApiAction['action'], error: unknown): ApiAction {
	const detail = errorDetail(error);
	return {
		action,
		result: 'failed',
		error: errorCode(error),
		...(detail === null ? {} : { detail }),
	};
}

function errorCode(error: unknown): string {
	if (error instanceof DedaloError) return error.code;
	if (error instanceof ApiBundleError) return `bundle_refused:${error.reason}`;
	if (error instanceof BundleWriteError) return `bundle_write:${error.reason}`;
	if (error instanceof RuntimeStateError) return 'runtime_invalid';
	console.error('[publication_apis] unexpected failure:', error);
	return 'internal.unexpected';
}

/** The paths a bundle refusal named — engine-generated tree keys, never agent text. */
function errorDetail(error: unknown): string | null {
	if (!(error instanceof ApiBundleError) || error.paths.length === 0) return null;
	return namedList(error.paths);
}

/** Registry shape: drift = host×API not proven in step; applied = pushes that landed. */
export function apiReportToReconcile(report: ApiReconcileReport): ReconcileReport {
	const actions = report.hosts
		.flatMap((host) => [host.v2, host.v1])
		.filter((a) => a.result !== 'not_served');
	return {
		drift: actions.filter((a) => !(a.action === 'none' && a.result === 'ok')).length,
		applied: actions.filter((a) => a.action !== 'none' && a.result === 'ok').length,
		detail: { release: report.release, refused: report.refused, hosts: report.hosts },
	};
}

/** Why the registry never applies publication_apis (its `applyRefused` facet). */
const PUBLICATION_APIS_APPLY_REFUSED =
	'pushing Publication API code to a public machine is root-only — the publication_hosts widget (Push API releases) — or done by a confirmed update/restore boot';

/**
 * The registry's run: DRY only — code reaches a public host from root or a confirmed boot.
 * The registry refuses an apply before calling this (`applyRefused`); the check here is the
 * same refusal for a caller that reaches the function directly — never a permission code: no
 * principal may apply through this door, so it is the request, not the user, that is refused.
 */
export async function runPublicationApisDefinition(
	{ apply, scope }: ReconcileRunOptions,
	deps: ApiReconcileDeps = defaultApiReconcileDeps(),
): Promise<ReconcileReport> {
	if (apply) {
		throw new DedaloError('request.invalid', {
			message: `publication_apis apply is refused through the reconcile registry: ${PUBLICATION_APIS_APPLY_REFUSED}`,
			publicMessage: `The 'publication_apis' reconcile cannot be applied here: ${PUBLICATION_APIS_APPLY_REFUSED}`,
		});
	}
	const hosts = scope === undefined ? {} : { hosts: [...scope] };
	return apiReportToReconcile(
		await reconcilePublicationApis({ apply: false, actor: RECONCILE_ACTOR, ...hosts }, deps),
	);
}

export const PUBLICATION_APIS_RECONCILE: ReconcileDefinition = {
	name: 'publication_apis',
	stores: [
		'installed engine tree (publication/server_api + its extract-time manifest)',
		"publication hosts (each agent's current v1/v2 release)",
	],
	description:
		'Report every publication host whose current Publication API release (v1, v2) is not the verified release of the installed engine tree; a tree with no verified release or drifted from its extract-time manifest counts every host×API as drift. With no publication host the tree is not hashed. Apply is refused here: pushing code is root-only (publication_hosts widget, Push API releases) or done by a confirmed update/restore boot.',
	scopeLabel: 'publication host name',
	schedule: { everyMs: PUBLICATION_APIS_CHECK_EVERY_MS },
	applyRefused: { reason: PUBLICATION_APIS_APPLY_REFUSED },
	sources: ['src/core/publication_host/api_reconcile.ts'],
	run: (options) => runPublicationApisDefinition(options),
};

/** What the confirmed boot knows about itself (server.ts passes it). */
export interface BootFacts {
	smokeBoot: boolean;
}

export type PushTriggerOutcome = 'started' | 'skipped_smoke_boot';

/**
 * The confirmed-boot trigger (L5 caller 1). Synchronous and DETACHED: the push runs
 * in the background and the result is logged; nothing here can throw into the boot.
 * A smoke boot rehearses an update, so it never pushes — checked HERE as well as by
 * server.ts's enclosing guard. (A box that is not installed never boots at all:
 * src/config/install_state.ts.)
 */
export function triggerPublicationApiPush(
	facts: BootFacts,
	reconcile: ReconcileApisFn = reconcilePublicationApis,
): PushTriggerOutcome {
	if (facts.smokeBoot) return 'skipped_smoke_boot';
	void pushDetached(reconcile);
	return 'started';
}

async function pushDetached(reconcile: ReconcileApisFn): Promise<void> {
	try {
		logPushReport(await reconcile({ apply: true, actor: CONFIRM_HOOK_ACTOR }));
	} catch (error) {
		console.error(
			'[publication_apis] post-confirm push failed (the scheduled check reports the lag):',
			error,
		);
	}
}

function logPushReport(report: ApiReconcileReport): void {
	const { drift, applied } = apiReportToReconcile(report);
	const refused = report.refused === null ? '' : ` REFUSED (${report.refused})`;
	const runtime =
		report.runtime_error === undefined ? '' : `, runtime NOT recorded (${report.runtime_error})`;
	const line = `[publication_apis] post-confirm push: release ${report.release ?? 'none'}${refused}, ${report.hosts.length} host(s), drift ${drift}, applied ${applied}${runtime}`;
	if (drift > applied || report.runtime_error !== undefined) console.warn(line);
	else console.log(line);
}

/** One host as the lockstep panel needs it (from a phase-3 HostPanelRow). */
export interface LockstepHostInput {
	name: string;
	reachable: boolean;
	apis: Record<ApiName, { current: string | null }>;
	/** The proved status's `served_apis`; null when the host was not reached (unknown). */
	served: readonly ApiName[] | null;
}

/** `not_served`: a v2-only site's v1 — neutral, never drift or failure. */
export type LockstepState = 'ok' | 'mismatch' | 'failed' | 'unknown' | 'not_served';

export interface ApiLockstepRow {
	host: string;
	api: ApiName;
	engine: string | null;
	host_current: string | null;
	last_push: ApiRuntimeEntry | null;
	state: LockstepState;
}

export interface ApiLockstepPanel {
	engine_release: string | null;
	refused: string | null;
	/** When the shown verdict was reached; null = no round since boot (not verified yet). */
	checked_at: string | null;
	rows: ApiLockstepRow[];
}

/** The panel rows: a remembered verdict vs each host's v2/v1, with the last push (pure). */
export function apiLockstepPanel(
	verdict: VerifiedTarget | null,
	hosts: readonly LockstepHostInput[],
	runtime: Readonly<Record<string, HostRuntime>>,
): ApiLockstepPanel {
	const release = verdict?.target.releaseId ?? null;
	return {
		engine_release: release,
		refused: verdict?.target.refused ?? null,
		checked_at: verdict?.at ?? null,
		rows: hosts.flatMap((host) =>
			API_PUSH_ORDER.map((api) => lockstepRow(release, host, api, runtime[host.name] ?? null)),
		),
	};
}

function lockstepRow(
	release: string | null,
	host: LockstepHostInput,
	api: ApiName,
	runtime: HostRuntime | null,
): ApiLockstepRow {
	const lastPush = runtime === null ? null : runtime.apis[api];
	if (servesNot(host, api)) {
		return {
			host: host.name,
			api,
			engine: release,
			host_current: null,
			last_push: lastPush,
			state: 'not_served',
		};
	}
	const current = host.reachable ? host.apis[api].current : undefined;
	return {
		host: host.name,
		api,
		engine: release,
		host_current: current ?? null,
		last_push: lastPush,
		state: lockstepState(release, current, lastPush?.state === 'failed'),
	};
}

/** A reached host whose declaration does not serve `api` (unknown `served` = serves all). */
function servesNot(host: LockstepHostInput, api: ApiName): boolean {
	return host.reachable && host.served !== null && !host.served.includes(api);
}

/** `current` undefined = the agent was not reached (its release is unknown, not absent). */
function lockstepState(
	release: string | null,
	current: string | null | undefined,
	lastPushFailed: boolean,
): LockstepState {
	if (release !== null && current === release) return 'ok';
	if (lastPushFailed) return 'failed';
	return release === null || current === undefined ? 'unknown' : 'mismatch';
}

/**
 * The widget's `api_lockstep` from the rows and the ONE runtime map its get_value
 * already read (panel_runtime.ts). Hashes nothing: it shows the last round's verdict.
 */
export function buildApiLockstepPanel(
	rows: readonly Pick<HostPanelRow, 'name' | 'pairing_proved' | 'apis' | 'served_apis'>[],
	runtime: Readonly<Record<string, HostRuntime>>,
): ApiLockstepPanel {
	return apiLockstepPanel(
		lastVerdict,
		rows.map((row) => ({
			name: row.name,
			reachable: row.pairing_proved,
			apis: row.apis,
			served: row.served_apis,
		})),
		runtime,
	);
}
