/**
 * publication_hosts widget — the work engine's view of its publication hosts, and the
 * things the panel may do to one (engineering/PUBLICATION_HOST_SPEC.md §2, §5, §6).
 *
 * WHAT IT READS. The registry (`core/publication_host/registry.ts`) lists the hosts; for
 * each one the panel asks the agent for its `status` through `agent_client.ts`, which
 * proves the pairing on the unauthenticated `/health` BEFORE it sends the bearer. The row
 * itself is built by `host_status.ts` (buildHostPanelRow), never here: that is where a
 * status body whose fingerprint is not the registry's is refused as evidence, so an
 * unproved agent contributes no version, no hash and no expectation to its row.
 *
 * WHAT IT NEVER CARRIES. The token, the client key, the bundle PEM. A row says only
 * `token_present` / `bundle_present` / `pairing_proved`. A failed agent call contributes
 * its registered error CODE (statusOutcomeFromError), never its message, details or cause:
 * those may hold agent prose, and agent prose is log-only (phase-3 decision E7).
 *
 * WHO SEES WHAT. Any global admin may read the panel (E10). Root's rows add the agent
 * address and the edit-form fields (`qualities`, `probe`) and the payload names the
 * registry path; another admin's rows carry none of that topology. A non-root read still
 * asks each agent for its read-only `status` (no actor, no mutation): the panel's checks
 * are the point of the panel (WC-2026-10-03-publication-hosts-widget records it).
 *
 * ONE HOST NEVER BLANKS THE PANEL. Secrets are read with `secretPresenceOutcome`, which
 * never throws a SecretError: a refused secret (a widened mode, a foreign owner, a
 * malformed bundle) arrives as `refused` and is passed to buildHostPanelRow UNCHANGED —
 * Task 6 blocks that host's `secrets` check with the reason; the widget patches no check.
 * A host with a refused or missing required secret is not dialled. An engine error while
 * computing one host's expectation reads as "not computed". The others render.
 *
 * A REGISTRY FAULT IN AN ACTION is the family's typed error (wire.ts `registryError`:
 * `publication_host.busy` for a held lock, `publication_host.registry_invalid` otherwise);
 * the widget never hand-builds a publication_host.* error.
 *
 * A REGISTRY THAT CANNOT BE READ IS LOUD. A corrupt or hand-edited registry file answers
 * `registry.state: 'registry_invalid'` with `hosts: null` — never an empty list, which
 * would tell the operator that no publication host exists while one is serving.
 *
 * EVERY ACTION IS ROOT-ONLY (decision E10, the media_control precedent). The maintenance
 * dispatch only checks `isGlobalAdmin`; a profile admin must not be able to rewrite a
 * public host's media gate or roll back a public API. The root check runs FIRST, before
 * any module is loaded or any agent is dialled.
 *
 * PUBLICATION API LOCKSTEP (phase 4). `push_apis` (root) runs THE reconciler
 * (core/publication_host/api_reconcile.ts) as an apply round; `get_value` adds
 * `api_lockstep` — the LAST round's verdict, never a hash of the tree on a panel load —
 * and `runtime_invalid`: the runtime results file is read ONCE per get_value
 * (panel_runtime.ts), and a corrupt one degrades to that reason, never a 500. Phases 5/6
 * decorate the rows from the SAME runtime map, in the fixed order
 * rows → withMediaCopyCheck → attachProbe, then api_lockstep from the final rows.
 *
 * MEDIA COPY (phase 5). `get_value` appends each row's `media_copy` check from the SAME
 * runtime map (media_copy_status.ts withMediaCopyCheck: blocked for a deletion unverified
 * past one period or a failed round, n/a hosts holding nothing carry none);
 * `reconcile_media_copy` (root) applies the registered `media_copy` reconcile to one host.
 *
 * PUBLIC-URL PROBE (phase 6). `get_value` attaches each row's last `probe` and ONE
 * `public_gate` check (host_status.ts attachProbe) from the SAME runtime map;
 * `probe_public` (root) probes one host now; `apply_rules` probes right after a
 * successful apply and answers the verdict as the extension key `probe`.
 *
 * THE HOST-WIDE NGINX MAP (provision init §13.4). `apply_rules` on an nginx host pushes the
 * engine's http{} map (`rules.map`) BEFORE the media include — the include uses the map's
 * variables, so a map failure stops the apply before the include is sent. An agent whose status
 * has no `rules.map` predates the host map and is refused (update the agent); `managed: false`
 * (the operator places the map by hand) skips the map. Each row carries `nginx_map`
 * (rules.ts nginxMapPanel: expected, applied, host hash, contribution count, managed, drift)
 * and, when it is non-null, the `nginx_map` CHECK (host_status.ts withNginxMapCheck).
 *
 * Hosts are ADDED by the pairing path (core/publication_host/pair_flow.ts): the CLI
 * `scripts/publication_host_pair.ts` on the work host, or — two machines — the panel's
 * `pair_package` (publication_host_setup.ts: root only, a sealed package that must complete a
 * draft this panel created, its address taken from inside the package and proved live). The
 * panel otherwise edits `public_url` / `qualities` / `probe` and removes a host; it never
 * takes a typed address or a loose credential. `get_value` adds root's drafts
 * (`drafts_state`, `drafts`).
 *
 * TESTABILITY: the widget is built by `createPublicationHostsWidget(loadDeps)`. Production
 * passes `loadDefaultDeps` (the real modules, dynamically imported like media_control's);
 * test/unit/publication_host_widget_native.test.ts passes recording fakes for every I/O
 * dependency and the real pure Task 6 functions.
 */

import { DedaloError } from '../../errors/dedalo_error.ts';
import {
	AGENT_RELEASE_ID,
	type AgentStatus,
	type MediaProbe,
	type RulesMapApplied,
	type RulesMapInput,
} from '../../publication_host/agent_client.ts';
import type {
	ApiLockstepPanel,
	ApiReconcileReport,
	ReconcileApisFn,
} from '../../publication_host/api_reconcile.ts';
import {
	attachProbe,
	type HostPanelRow,
	type HostStatusInput,
	registryInvalidCheck,
	type StatusOutcome,
	withNginxMapCheck,
} from '../../publication_host/host_status.ts';
import { withMediaCopyCheck } from '../../publication_host/media_copy_status.ts';
import type { PanelRuntime } from '../../publication_host/panel_runtime.ts';
import {
	type GateProbe,
	NEVER_PROBED,
	PROBE_MAX_AGE_MS,
	probeAfterRulesApplied,
	probePublicGate,
} from '../../publication_host/probe.ts';
import {
	HOST_NAME,
	loadRegistry,
	type PublicationHostRecord,
	RegistryError,
	type RegistryFile,
	registryPath,
	updateRegistry,
	validateProbePath,
	validateQualities,
} from '../../publication_host/registry.ts';
import type {
	ExpectedNginxMap,
	ExpectedRules,
	ExpectedRulesOutcome,
	NginxMapPanel,
} from '../../publication_host/rules.ts';
import type { HostRuntime } from '../../publication_host/runtime.ts';
// BY NAME, never a namespace: publication_host_door_tripwire allows only the door to load
// the TLS material (readHostTls); a namespace / whole-module import() would count as one.
import {
	removeHostSecrets,
	type SecretPresenceOutcome,
	secretPresenceOutcome,
} from '../../publication_host/secrets.ts';
import { registryError } from '../../publication_host/wire.ts';
import type { ReconcileReport } from '../../reconcile/registry.ts';
import { type Principal, SUPERUSER_ID } from '../../security/permissions.ts';
import {
	createSetupActions,
	draftRows,
	loadDefaultSetupDeps,
	type SetupDepsLoader,
} from './publication_host_setup.ts';
import { failAction, refuseAction, type WidgetModule, type WidgetResponse } from './support.ts';

type ApiName = 'v1' | 'v2';
type RulesServer = ExpectedRules['server'];
type ProbePaths = PublicationHostRecord['probe'];
type HostFieldPatch = Partial<Pick<PublicationHostRecord, 'public_url' | 'qualities' | 'probe'>>;

/** A served row: Task 6's row, plus the edit-form fields for root, minus the address otherwise. */
export type ServedHostRow = Omit<HostPanelRow, 'address_label'> & {
	address_label?: string;
	/**
	 * The host-wide nginx map's state (null: none applies, or no status was obtained). A caller
	 * who is not root gets it WITHOUT the host-wide facts (`host_hash`, `contributions`,
	 * `invalid`: what the other instances on that host contribute) — no topology below root.
	 */
	nginx_map: NginxMapPanel | ReducedNginxMapPanel | null;
	qualities?: string[] | null;
	probe?: ProbePaths;
};

/** The non-root view of the map: this instance's own state only. */
export type ReducedNginxMapPanel = Omit<NginxMapPanel, 'host_hash' | 'contributions' | 'invalid'>;

/** Everything the widget touches outside itself. One object, so a test can replace all of it. */
export interface PublicationHostsDeps {
	registryPath(): string;
	loadRegistry(): RegistryFile;
	updateRegistry(fn: (current: RegistryFile) => RegistryFile): RegistryFile;
	/** Never throws a SecretError: a refused secret is reported as `refused` (Task 1). */
	secretPresenceOutcome(name: string): SecretPresenceOutcome;
	/** Called INSIDE the registry lock by remove_host (never before taking it). */
	removeHostSecrets(name: string): void;
	forgetPairing(name: string): void;
	hostStatus(name: string): Promise<AgentStatus>;
	hostMediaProbe(name: string): Promise<MediaProbe>;
	hostApplyRules(
		name: string,
		req: { server: RulesServer; text: string; hash: string },
		actor: string,
	): Promise<{ hash: string; reloaded: true }>;
	hostRollbackRelease(
		name: string,
		api: ApiName,
		actor: string,
	): Promise<{ from: string; to: string }>;
	/** rules.map: this instance's contribution to the host-wide nginx http{} map. */
	hostApplyRulesMap(name: string, req: RulesMapInput, actor: string): Promise<RulesMapApplied>;
	expectedRulesForHost(record: PublicationHostRecord, status: AgentStatus): ExpectedRules;
	/** The map apply_rules pushes, or null (apache, no media, unmanaged, an outdated agent). */
	expectedNginxMap(status: AgentStatus): ExpectedNginxMap | null;
	/** The row's map state (rules.ts), from a status this call obtained. */
	nginxMapPanel(status: AgentStatus): NginxMapPanel | null;
	expectedRulesOutcome(record: PublicationHostRecord, status: AgentStatus): ExpectedRulesOutcome;
	statusOutcomeFromError(error: unknown): StatusOutcome;
	buildHostPanelRow(input: HostStatusInput): HostPanelRow;
	engineQualities(): string[];
	filterPublicQualities(configured: readonly string[]): string[];
	engineVersion(): string;
	/** The work system's pinned Bun (code_restore.ts bunPinOf(projectRoot)); null when unpinned. */
	bunPin(): string | null;
	/** THE one runtime read of a get_value (phase 4): a corrupt file → runtime_invalid. */
	loadPanelRuntime(): Promise<PanelRuntime>;
	/** The last round's lockstep verdict vs each row — never hashes the tree. */
	buildApiLockstepPanel(
		rows: readonly Pick<HostPanelRow, 'name' | 'pairing_proved' | 'apis' | 'served_apis'>[],
		runtime: Readonly<Record<string, HostRuntime>>,
	): ApiLockstepPanel;
	/** THE Publication API reconciler (push_apis runs it as an apply round). */
	reconcilePublicationApis: ReconcileApisFn;
	/**
	 * How long push_apis / reconcile_media_copy wait for their round before answering
	 * `running` (the round goes on, detached). Below the server's idle timeout, so the
	 * answer always reaches the client.
	 */
	pushAnswerWithinMs(): number;
	/**
	 * THE registered `media_copy` reconcile, APPLY, scoped to ONE host, through the registry
	 * door (runReconcile: the run is recorded in the gauge). Phase 5.
	 */
	mediaCopyRound(name: string): Promise<ReconcileReport>;
	/** The panel clock (epoch ms) the media_copy check ages pending deletions against. */
	now(): number;
	/** Phase 6: probe ONE host's gate through its PUBLIC URL now and record runtime.probe. */
	probePublicGate(name: string): Promise<GateProbe>;
	/** Phase 6: the same, after apply_rules — never throws (an `unknown` verdict instead). */
	probeAfterRulesApplied(name: string): Promise<GateProbe>;
}

export type DepsLoader = () => Promise<PublicationHostsDeps>;

type BoundAction = (
	options: Record<string, unknown>,
	principal: Principal,
	loadDeps: DepsLoader,
) => Promise<WidgetResponse>;

/** The production dependencies: the real modules, imported on first use. */
export async function loadDefaultDeps(): Promise<PublicationHostsDeps> {
	const client = await import('../../publication_host/agent_client.ts');
	const rules = await import('../../publication_host/rules.ts');
	const status = await import('../../publication_host/host_status.ts');
	const protection = await import('../../media/protection.ts');
	// The data version's string, not DEDALO_ENGINE_VERSION: release ids are `<data version>_<digest7>`
	// (Task 6 lockstep); the prerelease tag would put every API check at warn.
	const { DEDALO_DATA_VERSION, formatVersion } = await import('../../update/version.ts');
	const lockstep = await import('../../publication_host/api_reconcile.ts');
	const { loadPanelRuntime } = await import('../../publication_host/panel_runtime.ts');
	const { config } = await import('../../../config/config.ts');
	// This widget reads the pin through code_restore.ts `bunPinOf` (the update panel's
	// restore-point reader), never its own parse. Other `.bun-version` readers exist
	// (server.ts boot warning, update/status.ts readLiveBunPin) — no single-reader claim.
	const { bunPinOf } = await import('../../update/code_restore.ts');
	const { projectRoot } = await import('../../../config/env.ts');
	return {
		registryPath,
		loadRegistry,
		updateRegistry,
		secretPresenceOutcome,
		removeHostSecrets,
		forgetPairing: client.forgetPairing,
		hostStatus: client.hostStatus,
		hostMediaProbe: client.hostMediaProbe,
		hostApplyRules: client.hostApplyRules,
		hostRollbackRelease: client.hostRollbackRelease,
		hostApplyRulesMap: client.hostApplyRulesMap,
		expectedRulesForHost: rules.expectedRulesForHost,
		expectedNginxMap: rules.expectedNginxMap,
		nginxMapPanel: rules.nginxMapPanel,
		expectedRulesOutcome: rules.expectedRulesOutcome,
		statusOutcomeFromError: status.statusOutcomeFromError,
		buildHostPanelRow: status.buildHostPanelRow,
		engineQualities: protection.getPublicQualities,
		filterPublicQualities: protection.filterPublicQualities,
		engineVersion: () => formatVersion(DEDALO_DATA_VERSION),
		bunPin: () => bunPinOf(projectRoot),
		loadPanelRuntime: () => loadPanelRuntime(),
		buildApiLockstepPanel: lockstep.buildApiLockstepPanel,
		reconcilePublicationApis: (opts) => lockstep.reconcilePublicationApis(opts),
		pushAnswerWithinMs: () => pushAnswerWithinMs(config.ops.idleTimeoutSeconds),
		mediaCopyRound: runMediaCopyReconcileFor,
		now: () => Date.now(),
		probePublicGate: (name) => probePublicGate(name),
		probeAfterRulesApplied: (name) => probeAfterRulesApplied(name),
	};
}

/**
 * The media_copy reconcile for one host, APPLY, through the registry door. The catalog is
 * imported lazily (it reaches the diffusion facade by its own dynamic import — core never
 * imports src/diffusion statically).
 */
async function runMediaCopyReconcileFor(name: string): Promise<ReconcileReport> {
	const { registerAllReconciles } = await import('../../reconcile/catalog.ts');
	const { runReconcile } = await import('../../reconcile/registry.ts');
	await registerAllReconciles();
	return (await runReconcile('media_copy', { apply: true, scope: [name] })).report;
}

/** Never wait longer than this for a push round, even under a generous idle timeout. */
export const PUSH_ANSWER_CAP_MS = 60_000;

/**
 * push_apis's bounded wait: half the server's idle timeout (SERVER_IDLE_TIMEOUT_S, at most
 * 255 s — Bun cuts a silent connection there), never above PUSH_ANSWER_CAP_MS. A first push
 * of a release can build the v2 deps (up to 10 min) and stream to every host (up to 15 min
 * per install): that round outlives any request, so it is answered `running` and finishes
 * detached — its outcome lands in the runtime file each row's last push reads.
 */
export function pushAnswerWithinMs(idleTimeoutSeconds: number): number {
	return Math.min(PUSH_ANSWER_CAP_MS, idleTimeoutSeconds * 500);
}

// ── guards ──────────────────────────────────────────────────────────────────

/** Root, not merely global admin (E10). Runs before anything is loaded or dialled. */
function requireRoot(principal: Principal, action: string): void {
	if (principal.userId !== SUPERUSER_ID) {
		throw new DedaloError('perm.denied', {
			message: `only the root user can run publication_hosts.${action}`,
		});
	}
}

function hostName(options: Record<string, unknown>): string {
	const name = options.name;
	if (typeof name !== 'string' || !HOST_NAME.test(name)) {
		refuseAction('Error. Invalid publication host name.');
	}
	return name;
}

function apiName(options: Record<string, unknown>): ApiName {
	const api = options.api;
	if (api !== 'v1' && api !== 'v2') refuseAction('Error. Invalid api. Allowed: v1 | v2');
	return api;
}

function refuseUnknownHost(name: string): never {
	refuseAction(
		`Error. No publication host named '${name}' is registered. Hosts are added on the work host with sudo -u <engine user> bun run dedalo:pair-publication-host (run as the user that runs Dédalo, never root).`,
		{ host: name },
	);
}

/** A RegistryError becomes the family's typed error (Task 2); anything else passes through. */
function registryFailure(error: unknown): unknown {
	return error instanceof RegistryError ? registryError(error.reason) : error;
}

function readRegistryOrFail(deps: PublicationHostsDeps): RegistryFile {
	try {
		return deps.loadRegistry();
	} catch (error) {
		throw registryFailure(error);
	}
}

/** Load + fn + save under the registry lock. A refusal thrown by `fn` writes nothing. */
function writeRegistry(
	deps: PublicationHostsDeps,
	fn: (current: RegistryFile) => RegistryFile,
): RegistryFile {
	try {
		return deps.updateRegistry(fn);
	} catch (error) {
		throw registryFailure(error);
	}
}

function requireHost(deps: PublicationHostsDeps, name: string): PublicationHostRecord {
	const record = readRegistryOrFail(deps).hosts.find((host) => host.name === name);
	if (record === undefined) refuseUnknownHost(name);
	return record;
}

/** The `X-Dedalo-Actor` value the agent audits. Every action is root-only, so this names root. */
function actorFor(principal: Principal): string {
	return `dedalo_user:${principal.userId}`;
}

/** One log line per mutation. Never a token, a key or a request body. */
function logMutation(action: string, name: string, principal: Principal, detail: string): void {
	console.info(`[publication_hosts] ${action} host=${name} user=${principal.userId} ${detail}`);
}

// ── panel (get_value) ───────────────────────────────────────────────────────

type RegistryRead =
	| { ok: true; file: RegistryFile }
	| { ok: false; reason: RegistryError['reason'] };

function readRegistry(deps: PublicationHostsDeps): RegistryRead {
	try {
		return { ok: true, file: deps.loadRegistry() };
	} catch (error) {
		if (!(error instanceof RegistryError)) throw error;
		// loadRegistry takes no lock, so a read never meets a held one; were it to, the file
		// is busy, not broken: the action family's `publication_host.busy`, never a "repair".
		if (error.reason === 'locked') throw registryFailure(error);
		console.error(`[publication_hosts] registry unusable: ${error.reason}`, error);
		return { ok: false, reason: error.reason };
	}
}

export function addressLabel(address: PublicationHostRecord['address']): string {
	return address.kind === 'tls' ? `${address.host}:${address.port}` : `unix:${address.socket}`;
}

/** Dial only a host whose required secrets are present AND accepted (bundle: TLS hosts only). */
function dialable(record: PublicationHostRecord, secrets: SecretPresenceOutcome): boolean {
	if (secrets.refused !== null) {
		console.warn(
			`[publication_hosts] secret refused host=${record.name} reason=${secrets.refused}`,
		);
		return false;
	}
	return secrets.token_present && (record.address.kind !== 'tls' || secrets.bundle_present);
}

function notDialled(): StatusOutcome {
	return { ok: false, code: 'publication_host.unconfigured' };
}

/** The agent's status, or the registered CODE of why there is none (Task 6). Never the message. */
async function readStatus(name: string, deps: PublicationHostsDeps): Promise<StatusOutcome> {
	try {
		return { ok: true, status: await deps.hostStatus(name) };
	} catch (error) {
		const outcome = deps.statusOutcomeFromError(error);
		console.warn(
			`[publication_hosts] status failed host=${name} code=${outcome.ok ? 'none' : outcome.code}`,
		);
		// an untyped failure is an engine bug: it keeps its stack in the log
		if (!(error instanceof DedaloError)) console.error(error);
		return outcome;
	}
}

/** Task 6's expectation, only from a status this call obtained. An engine bug reads "not computed". */
function readExpected(
	record: PublicationHostRecord,
	status: StatusOutcome,
	deps: PublicationHostsDeps,
): ExpectedRulesOutcome | null {
	if (!status.ok) return null;
	try {
		return deps.expectedRulesOutcome(record, status.status);
	} catch (error) {
		console.error(`[publication_hosts] expected rules failed host=${record.name}`, error);
		return null;
	}
}

/** The row's map state, only from a status this call obtained. An engine bug reads "not computed". */
function readMapPanel(
	record: PublicationHostRecord,
	status: StatusOutcome,
	deps: PublicationHostsDeps,
): NginxMapPanel | null {
	if (!status.ok) return null;
	try {
		return deps.nginxMapPanel(status.status);
	} catch (error) {
		console.error(`[publication_hosts] nginx map state failed host=${record.name}`, error);
		return null;
	}
}

function servedRow(
	row: HostPanelRow,
	record: PublicationHostRecord,
	isRoot: boolean,
	nginxMap: NginxMapPanel | null,
): ServedHostRow {
	if (isRoot)
		return { ...row, nginx_map: nginxMap, qualities: record.qualities, probe: record.probe };
	const { address_label: _topology, ...reduced } = row;
	return { ...reduced, nginx_map: reducedMap(nginxMap) };
}

/** Drops the host-wide facts (other instances on that host) from a non-root row's map. */
function reducedMap(map: NginxMapPanel | null): ReducedNginxMapPanel | null {
	if (map === null) return null;
	const { host_hash: _host, contributions: _count, invalid: _invalid, ...own } = map;
	return own;
}

async function hostRow(
	record: PublicationHostRecord,
	deps: PublicationHostsDeps,
	isRoot: boolean,
): Promise<ServedHostRow> {
	const secrets = deps.secretPresenceOutcome(record.name);
	const status = dialable(record, secrets) ? await readStatus(record.name, deps) : notDialled();
	const row = deps.buildHostPanelRow({
		record,
		secrets,
		status,
		expected: readExpected(record, status, deps),
		engineVersion: deps.engineVersion(),
		bunPin: deps.bunPin(),
	});
	// The row builder is host_status.ts's (never patched here); a pairing it did not prove
	// contributes no map state either. The map's state is a CHECK (host_status.ts
	// withNginxMapCheck), so a map not loaded is counted like every other red line.
	const nginxMap = row.pairing_proved ? readMapPanel(record, status, deps) : null;
	return servedRow(withNginxMapCheck(row, nginxMap), record, isRoot, nginxMap);
}

/** The host's last public-URL probe from the panel's ONE runtime read, or never probed. */
function rowProbe(panelRuntime: PanelRuntime, name: string): GateProbe {
	return panelRuntime.runtime[name]?.probe ?? { ...NEVER_PROBED };
}

/** The root-only `drafts_state` + `drafts` keys of the payload ({} for anyone else). */
async function draftsPartOf(
	isRoot: boolean,
	loadSetup: SetupDepsLoader | undefined,
	registry: RegistryFile | null,
): Promise<{ drafts_state?: string; drafts?: unknown }> {
	if (!isRoot || loadSetup === undefined) return {};
	const setup = await draftRows(await loadSetup(), registry);
	return { drafts_state: setup.state, drafts: setup.drafts };
}

export async function publicationHostsValue(
	deps: PublicationHostsDeps,
	principal: Principal,
	loadSetup?: SetupDepsLoader,
): Promise<WidgetResponse> {
	const isRoot = principal.userId === SUPERUSER_ID;
	const read = readRegistry(deps);
	// ROOT ONLY: the drafts of "New publication host" (publication_host_setup.ts). Another admin's
	// payload carries no `drafts` key at all (a draft names a future host's address and accounts).
	const draftsPart = await draftsPartOf(isRoot, loadSetup, read.ok ? read.file : null);
	// ONE runtime read for the whole panel (panel_runtime.ts): a corrupt file is a red
	// `runtime_invalid`, never a 500. Fixed decorator order for phases 5/6:
	// rows → withMediaCopyCheck → attachProbe, each taking panelRuntime.runtime; then
	// api_lockstep from the final rows (the last round's verdict — never a tree hash).
	const panelRuntime = await deps.loadPanelRuntime();
	const common = {
		registry_path: isRoot ? deps.registryPath() : null,
		engine_qualities: deps.engineQualities(),
		is_root: isRoot,
		runtime_invalid: panelRuntime.runtime_invalid,
		...draftsPart,
	};
	if (!read.ok) {
		return {
			data: {
				...common,
				registry: {
					state: 'registry_invalid',
					reason: read.reason,
					check: registryInvalidCheck(read.reason),
				},
				hosts: null,
				api_lockstep: deps.buildApiLockstepPanel([], panelRuntime.runtime),
			},
		};
	}
	const now = deps.now();
	const hosts = (await Promise.all(read.file.hosts.map((record) => hostRow(record, deps, isRoot))))
		.map((row) => withMediaCopyCheck(row, panelRuntime.runtime, now))
		.map((row) => attachProbe(row, rowProbe(panelRuntime, row.name), now, PROBE_MAX_AGE_MS));
	return {
		data: {
			...common,
			registry: { state: 'ok', reason: null, check: null },
			hosts,
			api_lockstep: deps.buildApiLockstepPanel(hosts, panelRuntime.runtime),
		},
	};
}

// ── field validation (set_host_fields) ──────────────────────────────────────

function parseUrl(value: string): URL | null {
	try {
		return new URL(value);
	} catch {
		return null;
	}
}

/**
 * An https ORIGIN and nothing else: no credentials, path, query or fragment. Stored as
 * `url.origin`. Syntax only — the phase-6 probe dials it through the SSRF guard, which
 * is where an address is judged (at fetch time, not at save time).
 */
export function normalizePublicUrl(value: unknown): string | null {
	if (value === null) return null;
	const url = typeof value === 'string' ? parseUrl(value) : null;
	if (url === null || url.href !== `https://${url.host}/`) {
		refuseAction('Error. public_url must be an https origin (https://host[:port]), or null.');
	}
	return url.origin;
}

function assertQualityList(value: unknown): asserts value is string[] {
	if (!Array.isArray(value) || value.length === 0 || !value.every((q) => typeof q === 'string')) {
		refuseAction('Error. qualities must be a non-empty list of quality folders, or null.');
	}
}

/**
 * The host's public qualities. `null` = follow the engine's. A list must survive the
 * engine's own public filter WHOLE (a master tier or a malformed folder is refused, by
 * name — never silently dropped), and hold no duplicate.
 */
export function normalizeQualities(
	value: unknown,
	filter: (configured: readonly string[]) => string[],
): string[] | null {
	if (value === null) return null;
	assertQualityList(value);
	const kept = filter(value);
	const refused = value.filter((quality) => !kept.includes(quality.replace(/^\/+|\/+$/g, '')));
	if (refused.length > 0) {
		refuseAction(`Error. Not a public quality: ${refused.join(', ')}.`);
	}
	if (new Set(kept).size !== kept.length) refuseAction('Error. qualities holds a duplicate.');
	return registryField(() => validateQualities(kept), 'Error. qualities: ');
}

/**
 * The registry's OWN field check (registry.ts), run before the locked write: a value the
 * registry would refuse is the operator's input error, never a "corrupt registry"
 * (saveRegistry's invalid_shape would map to publication_host.registry_invalid).
 */
function registryField<T>(validate: () => T, prefix: string): T {
	try {
		return validate();
	} catch (error) {
		if (error instanceof RegistryError) refuseAction(`${prefix}${error.message}.`);
		throw error;
	}
}

function probePath(value: unknown, which: string): string | null {
	if (value === null || value === undefined) return null;
	return registryField(
		() => validateProbePath(value, `probe.${which}`),
		'Error. A probe path must be a media path relative to the media folder, or null: ',
	);
}

/** The two phase-6 probe files, as paths relative to /dedalo/<mediaDir>/. */
export function normalizeProbe(value: unknown): ProbePaths {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		refuseAction('Error. probe must be an object {published, unpublished}.');
	}
	const paths = value as Record<string, unknown>;
	return {
		published: probePath(paths.published, 'published'),
		unpublished: probePath(paths.unpublished, 'unpublished'),
	};
}

export function hostFieldPatch(
	options: Record<string, unknown>,
	filter: (configured: readonly string[]) => string[],
): HostFieldPatch {
	const patch: HostFieldPatch = {};
	if (Object.hasOwn(options, 'public_url'))
		patch.public_url = normalizePublicUrl(options.public_url);
	if (Object.hasOwn(options, 'qualities'))
		patch.qualities = normalizeQualities(options.qualities, filter);
	if (Object.hasOwn(options, 'probe')) patch.probe = normalizeProbe(options.probe);
	if (Object.keys(patch).length === 0) {
		refuseAction('Error. Nothing to change: send public_url, qualities and/or probe.');
	}
	return patch;
}

export function replaceHost(
	current: RegistryFile,
	name: string,
	patch: HostFieldPatch,
): RegistryFile {
	if (!current.hosts.some((host) => host.name === name)) refuseUnknownHost(name);
	return {
		...current,
		hosts: current.hosts.map((host) => (host.name === name ? { ...host, ...patch } : host)),
	};
}

export function withoutHost(current: RegistryFile, name: string): RegistryFile {
	if (!current.hosts.some((host) => host.name === name)) refuseUnknownHost(name);
	return { ...current, hosts: current.hosts.filter((host) => host.name !== name) };
}

/** withoutHost, only while the entry is still the pairing `seen` (never a newer re-pairing). */
export function withoutPairing(current: RegistryFile, seen: PublicationHostRecord): RegistryFile {
	const now = current.hosts.find((host) => host.name === seen.name);
	if (now === undefined) refuseUnknownHost(seen.name);
	if (now.fingerprint !== seen.fingerprint || now.paired_at !== seen.paired_at) {
		refuseAction(
			`Error. Host '${seen.name}' was re-paired while it was being removed; nothing was removed. Reload the panel and retry.`,
			{ host: seen.name },
		);
	}
	return withoutHost(current, seen.name);
}

// ── actions ─────────────────────────────────────────────────────────────────

function renderRules(
	deps: PublicationHostsDeps,
	record: PublicationHostRecord,
	status: AgentStatus,
): ExpectedRules {
	try {
		return deps.expectedRulesForHost(record, status);
	} catch (error) {
		console.warn(`[publication_hosts] rules not renderable host=${record.name}`, error);
		refuseAction(
			`Error. The media rules for '${record.name}' cannot be rendered from its reported root and qualities. See the server log.`,
			{ host: record.name },
		);
	}
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** An agent-reported hash, named only when it has the shape of one. */
function reportedHash(hash: unknown): string {
	return typeof hash === 'string' && SHA256_HEX.test(hash)
		? `rule hash ${hash}`
		: 'a malformed rule hash';
}

/** An agent-reported release id, only when it has the shape of one (E7); otherwise 'malformed'. */
export function releaseIdOrMalformed(value: unknown): string {
	return typeof value === 'string' && AGENT_RELEASE_ID.test(value) ? value : 'malformed';
}

function rulesAppliedMsg(
	name: string,
	server: RulesServer,
	hash: string,
	dropped: string[],
	map: MapStep,
): string {
	const note = dropped.length === 0 ? '' : ` Not public, left out: ${dropped.join(', ')}.`;
	const mapNote =
		map.state === 'pushed'
			? ` Host media map ${map.host_hash.slice(0, 12)} (${map.contributions} instance${map.contributions === 1 ? '' : 's'}).`
			: map.state === 'current'
				? ' Host media map already current.'
				: '';
	return `OK. Media rules applied on '${name}' (${server}, ${hash.slice(0, 12)}).${mapNote}${note}`;
}

/** What the map step did: pushed, already current, or not applicable (apache, unmanaged). */
type MapStep =
	| { state: 'pushed'; hash: string; host_hash: string; contributions: number }
	| { state: 'current'; hash: string }
	| { state: 'not_applicable' };

/**
 * The host-wide nginx map BEFORE the include (provision init §13.4). An nginx agent without
 * `rules.map` predates the host map: refused, nothing sent. `managed: false` skips. A map the
 * agent already reports loaded is not re-pushed. A failed push throws, so the include (which
 * needs the map's variables) is never sent after it.
 */
async function applyMapStep(
	deps: PublicationHostsDeps,
	name: string,
	status: AgentStatus,
	actor: string,
): Promise<MapStep> {
	if (status.rules.server !== 'nginx') return { state: 'not_applicable' };
	if (status.rules.map === undefined) {
		refuseAction(
			`Error. The agent on '${name}' predates the host-wide nginx media map, so its media rules cannot be applied safely. Update the agent on that host, then apply again.`,
			{ host: name },
		);
	}
	const expected = deps.expectedNginxMap(status);
	if (expected === null) return { state: 'not_applicable' };
	if (reportedMapHash(status) === expected.hash) return { state: 'current', hash: expected.hash };
	return pushMap(deps, name, expected, actor);
}

/** The map hash the agent reports loaded, or null when it manages none. */
function reportedMapHash(status: AgentStatus): string | null {
	return status.rules.map?.managed === true ? status.rules.map.hash : null;
}

/** Push the expected map; a host that reports another hash than the one sent fails the action. */
async function pushMap(
	deps: PublicationHostsDeps,
	name: string,
	expected: ExpectedNginxMap,
	actor: string,
): Promise<MapStep> {
	const applied = await deps.hostApplyRulesMap(
		name,
		{ text: expected.text, hash: expected.hash },
		actor,
	);
	if (applied.hash !== expected.hash) {
		console.warn(`[publication_hosts] map hash mismatch host=${name} reported=${applied.hash}`);
		failAction(
			`Error. Host '${name}' reports ${reportedHash(applied.hash)} for the media map, but ${expected.hash} was sent. Check the agent audit log.`,
			{ coordinates: { host: name } },
		);
	}
	return {
		state: 'pushed',
		hash: applied.hash,
		host_hash: applied.host_hash,
		contributions: applied.contributions,
	};
}

/**
 * apply_rules: status (pairing proved first) → expected rules from THAT status → on nginx the
 * host-wide map (applyMapStep, which may refuse or stop the apply) → rules.apply.
 * A `none` host (no media) is refused before anything is sent; `shared` and `copy` get the
 * same profile over their media root (rules.ts rulesRootFor). A reported hash other
 * than the one sent is a failure, never an OK.
 */
const applyRulesAction: BoundAction = async (options, principal, loadDeps) => {
	requireRoot(principal, 'apply_rules');
	const name = hostName(options);
	const deps = await loadDeps();
	const record = requireHost(deps, name);
	const status = await deps.hostStatus(name);
	if (status.media.mode === 'none') {
		refuseAction(
			`Error. Host '${name}' reports media mode 'none': it serves no media, so there are no media rules to apply.`,
			{ host: name },
		);
	}
	const rules = renderRules(deps, record, status);
	const map = await applyMapStep(deps, name, status, actorFor(principal));
	if (map.state === 'pushed') logMutation('apply_rules_map', name, principal, `hash=${map.hash}`);
	const request = { server: rules.server, text: rules.text, hash: rules.hash };
	const applied = await deps.hostApplyRules(name, request, actorFor(principal));
	if (applied.hash !== rules.hash) {
		// agent prose is log-only (E7): the raw value goes to the log, never into the sentence
		console.warn(`[publication_hosts] rule hash mismatch host=${name} reported=${applied.hash}`);
		failAction(
			`Error. Host '${name}' reports ${reportedHash(applied.hash)}, but ${rules.hash} was sent. Check the agent audit log.`,
			{ coordinates: { host: name } },
		);
	}
	logMutation('apply_rules', name, principal, `hash=${rules.hash}`);
	// Phase 6 (P3): a rule change is proven through the public URL at once. Never fails
	// the apply (the rules ARE applied): a probe that cannot run reads `unknown`.
	const probe = await deps.probeAfterRulesApplied(name);
	return {
		data: { host: name, server: rules.server, hash: rules.hash, dropped: rules.dropped, map },
		msg: rulesAppliedMsg(name, rules.server, rules.hash, rules.dropped, map),
		extend: { probe },
	};
};

function probeSentence(name: string, probe: GateProbe): string {
	if (probe.state === 'ok') {
		return `OK. '${name}': the public gate serves published media and refuses unpublished media.`;
	}
	const level = probe.state === 'failed' ? 'Error' : 'Warning';
	return `${level}. '${name}': ${probe.detail ?? probe.state}`;
}

/**
 * probe_public (phase 6, P3 on demand): prove the host's media gate through its PUBLIC
 * URL now — the published probe file must answer 2xx, the unpublished one 404 — and
 * record the verdict in runtime.probe. ROOT ONLY (E10: one rule for every action). It
 * dials no agent: two bounded GETs through the public door (probe.ts).
 */
const probePublicAction: BoundAction = async (options, principal, loadDeps) => {
	requireRoot(principal, 'probe_public');
	const name = hostName(options);
	const deps = await loadDeps();
	requireHost(deps, name);
	const probe = await deps.probePublicGate(name);
	logMutation('probe_public', name, principal, `state=${probe.state}`);
	return { data: probe, msg: probeSentence(name, probe) };
};

/** The most agent problem lines one probe answer carries to the wire (then '… N more'). */
export const PROBE_PROBLEMS_MAX = 16;
/** The longest agent string (a problem line, the media root) one probe answer carries. */
export const PROBE_TEXT_MAX = 300;
/** An absolute path of printable ASCII: the only media-root shape passed through (E7). */
const PROBE_ROOT = /^\/[\x20-\x7e]*$/;

/** Agent prose, made display-safe: control/format characters out, length capped. */
function probeText(text: string): string {
	const flat = text.replace(/[\p{Cc}\p{Cf}]+/gu, ' ').trim();
	return flat.length > PROBE_TEXT_MAX ? `${flat.slice(0, PROBE_TEXT_MAX - 1)}…` : flat;
}

/**
 * The agent's MediaProbe as the wire carries it (E7: an agent string is checked, never
 * trusted). Only the known fields are copied — an extra key the shape guard let through
 * never reaches data.probe; `root` passes only as a printable absolute path within the cap
 * (else 'malformed'); `problems` is capped in count and length, control and format
 * characters (CR/LF, bidi overrides) removed. The client renders it as text (textContent).
 */
export function boundMediaProbe(probe: MediaProbe): MediaProbe {
	const lines = probe.problems.slice(0, PROBE_PROBLEMS_MAX).map(probeText);
	const extra = probe.problems.length - lines.length;
	const root =
		probe.root === null
			? null
			: PROBE_ROOT.test(probe.root) && probe.root.length <= PROBE_TEXT_MAX
				? probe.root
				: 'malformed';
	return {
		mode: probe.mode,
		root,
		present: probe.present,
		read_only: probe.read_only,
		pub_readable: probe.pub_readable,
		pub_markers: probe.pub_markers,
		problems: extra > 0 ? [...lines, `… ${extra} more`] : lines,
	};
}

/** probe: the agent's media.probe, read-only, but still root-only (E10: one rule for every action). */
const probeAction: BoundAction = async (options, principal, loadDeps) => {
	requireRoot(principal, 'probe');
	const name = hostName(options);
	const deps = await loadDeps();
	requireHost(deps, name);
	const raw = await deps.hostMediaProbe(name);
	const count = raw.problems.length;
	const probe = boundMediaProbe(raw);
	return {
		data: { host: name, probe },
		msg:
			count === 0
				? `OK. Media probe on '${name}' found no problem.`
				: `Media probe on '${name}' found ${count} problem(s).`,
	};
};

/** rollback_api: swap the API's `current` back on the agent. */
const rollbackApiAction: BoundAction = async (options, principal, loadDeps) => {
	requireRoot(principal, 'rollback_api');
	const name = hostName(options);
	const api = apiName(options);
	const deps = await loadDeps();
	requireHost(deps, name);
	const swap = await deps.hostRollbackRelease(name, api, actorFor(principal));
	const from = releaseIdOrMalformed(swap.from);
	const to = releaseIdOrMalformed(swap.to);
	logMutation('rollback_api', name, principal, `api=${api} ${from} -> ${to}`);
	if (from === 'malformed' || to === 'malformed') {
		console.warn(
			`[publication_hosts] rollback_api host=${name} malformed release id from=${JSON.stringify(swap.from)} to=${JSON.stringify(swap.to)}`,
		);
	}
	return {
		data: { host: name, api, from, to },
		msg: `OK. API ${api} on '${name}' rolled back: ${from} → ${to}.`,
	};
};

/**
 * set_host_fields: the three operator-editable fields, validated whole before the locked
 * write. No pairing proof is touched: none of the three is the address, the instance or a
 * credential.
 */
const setHostFieldsAction: BoundAction = async (options, principal, loadDeps) => {
	requireRoot(principal, 'set_host_fields');
	const name = hostName(options);
	const deps = await loadDeps();
	const patch = hostFieldPatch(options, deps.filterPublicQualities);
	writeRegistry(deps, (current) => replaceHost(current, name, patch));
	const fields = Object.keys(patch);
	logMutation('set_host_fields', name, principal, `fields=${fields.join(',')}`);
	return {
		data: { host: name, fields },
		msg: `OK. Host '${name}' updated: ${fields.join(', ')}.`,
	};
};

/**
 * remove_host: ONE registry lock hold — re-check that the entry is still the pairing the
 * operator saw (fingerprint + paired_at; a pair `replace` in between refuses, retry), delete
 * the SECRETS, then drop the entry — then this process's pairing proof (Task 4
 * forgetPairing). Secrets before the entry: a failure between them leaves a VISIBLE entry
 * whose `secrets` check is red and which the operator can remove again; the other order
 * would leave an invisible credential on disk that no panel lists. A secrets failure throws
 * inside the lock, so the registry is not written.
 */
const removeHostAction: BoundAction = async (options, principal, loadDeps) => {
	requireRoot(principal, 'remove_host');
	const name = hostName(options);
	const deps = await loadDeps();
	const seen = requireHost(deps, name);
	writeRegistry(deps, (current) => {
		const next = withoutPairing(current, seen);
		try {
			deps.removeHostSecrets(name);
		} catch (error) {
			failAction(
				`Error. The credentials of host '${name}' could not be deleted, so the host stays registered. See the server log.`,
				{ cause: error, coordinates: { host: name } },
			);
		}
		return next;
	});
	deps.forgetPairing(name);
	logMutation('remove_host', name, principal, 'removed');
	return {
		data: { host: name, removed: true },
		msg: `OK. Host '${name}' removed from this engine (registry entry and credentials). The agent on the publication host is untouched.`,
	};
};

/**
 * push_apis: push the installed tree's verified Publication API releases to every paired
 * host (or `options.hosts`), v2 then v1 (phase 4, L5/L6). ROOT ONLY (E10): this installs
 * code on a public machine — the guard runs before anything is loaded. `data` is true
 * only when nothing was refused and nothing failed; `msg` names the refusal, or each
 * failed host×API with its code and named paths. A concurrent push is resource.conflict,
 * an unregistered name resource.not_found (both from the reconciler). BOUNDED ANSWER: a
 * round still going after `pushAnswerWithinMs` (below the server idle timeout) answers
 * `data: null, running: true` and finishes detached — never a connection cut mid-push.
 */
const pushApisAction: BoundAction = async (options, principal, loadDeps) => {
	requireRoot(principal, 'push_apis');
	const hosts = pushHosts(options.hosts);
	const deps = await loadDeps();
	const round = deps.reconcilePublicationApis({
		apply: true,
		actor: actorFor(principal),
		...(hosts === null ? {} : { hosts }),
	});
	const waitMs = deps.pushAnswerWithinMs();
	const report = await settledWithin(round, waitMs);
	if (report === STILL_RUNNING) {
		// Detached: the reconciler records every host×API in the runtime file; a refusal or
		// a throw after the answer is logged here (the single-flight latch clears either way).
		void round
			.then((late) => logPush(principal, late))
			.catch((error) =>
				console.error(`[publication_hosts] push_apis user=${principal.userId} failed:`, error),
			);
		console.info(
			`[publication_hosts] push_apis user=${principal.userId} still running after ${waitMs} ms: answered running`,
		);
		return {
			data: null,
			msg: `Push started and still running after ${Math.round(waitMs / 1000)} s (a new release builds its dependencies and streams to every host). Its outcome is recorded per host and API: reload this panel to see each row's last push. A second push is refused until this one ends.`,
			extend: { report: null, running: true },
		};
	}
	const failed = logPush(principal, report);
	return {
		data: report.refused === null && failed.length === 0,
		msg: pushMessage(report, failed) + runtimeNote(report),
		extend: { report, running: false },
	};
};

/** The per-host slice of the media_copy report this door reads (no diffusion type import). */
type MediaCopyHostSummary = { takes_copy: boolean | null; error: string | null };

function mediaCopySummary(report: ReconcileReport, name: string): MediaCopyHostSummary | null {
	const hosts = report.detail.hosts as Record<string, MediaCopyHostSummary> | undefined;
	return hosts?.[name] ?? null;
}

function mediaCopyMessage(name: string, report: ReconcileReport): string {
	if (mediaCopySummary(report, name)?.takes_copy !== true) {
		return `OK. '${name}' does not take a media copy (its agent reports another media mode): nothing to copy.`;
	}
	return report.drift === 0
		? `OK. '${name}': the media copy matches the published set.`
		: `'${name}': drift ${report.drift}, applied ${report.applied}. The panel shows what is still pending.`;
}

/**
 * reconcile_media_copy: the registered `media_copy` reconcile, APPLY, for ONE host — the
 * same pure derivation the scheduler applies every period, through the copy worker's
 * per-host lane (the dry form is reconcile_status.run_reconcile). ROOT ONLY (E10): it puts
 * and deletes files on a public machine. A host whose round failed (an unreachable agent,
 * a deletion not verified, a host withdrawn from copy mode while holding bytes) FAILS
 * VISIBLY (maintenance.action_failed, its code named) — never an OK; its pending deletions
 * stay pending. BOUNDED ANSWER like push_apis: a first copy of AV media outlives any
 * request, so a round still going after `pushAnswerWithinMs` answers `running` and
 * finishes detached in the lane; its outcome lands in the runtime file the panel reads.
 */
const reconcileMediaCopyAction: BoundAction = async (options, principal, loadDeps) => {
	requireRoot(principal, 'reconcile_media_copy');
	const name = hostName(options);
	const deps = await loadDeps();
	requireHost(deps, name);
	const round = deps.mediaCopyRound(name);
	const waitMs = deps.pushAnswerWithinMs();
	const report = await settledWithin(round, waitMs);
	if (report === STILL_RUNNING) {
		void round.catch((error) =>
			console.error(`[publication_hosts] reconcile_media_copy host=${name} failed:`, error),
		);
		logMutation('reconcile_media_copy', name, principal, 'running');
		return {
			data: null,
			msg: `Media copy of '${name}' started and still running after ${Math.round(waitMs / 1000)} s (a first copy of large media takes long). Its outcome is recorded: reload this panel to see the Media copy row.`,
			extend: { report: null, running: true },
		};
	}
	const failed = mediaCopySummary(report, name)?.error ?? null;
	logMutation(
		'reconcile_media_copy',
		name,
		principal,
		`drift=${report.drift} applied=${report.applied} error=${failed ?? 'none'}`,
	);
	if (failed !== null) {
		failAction(
			`Error. Media copy of '${name}' failed (${failed}). Pending deletions stay pending; the next reconcile retries them.`,
			{ coordinates: { host: name } },
		);
	}
	return {
		data: true,
		msg: mediaCopyMessage(name, report),
		extend: { report, running: false },
	};
};

const STILL_RUNNING = Symbol('still_running');

/** The round's report if it settles within `ms` (a rejection propagates), else STILL_RUNNING. */
async function settledWithin<T>(round: Promise<T>, ms: number): Promise<T | typeof STILL_RUNNING> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<typeof STILL_RUNNING>((done) => {
		timer = setTimeout(() => done(STILL_RUNNING), ms);
	});
	try {
		return await Promise.race([round, deadline]);
	} finally {
		clearTimeout(timer);
	}
}

/** One log line per finished push (answered or detached); returns the failed host×APIs. */
function logPush(principal: Principal, report: ApiReconcileReport): string[] {
	const failed = failedPushes(report);
	console.info(
		`[publication_hosts] push_apis user=${principal.userId} release=${report.release ?? 'none'} hosts=${report.hosts.length} failed=${failed.length}${report.refused === null ? '' : ' REFUSED'}`,
	);
	return failed;
}

/** `options.hosts`: absent = every host; else an array of host names (validated whole). */
export function pushHosts(value: unknown): string[] | null {
	if (value === undefined || value === null) return null;
	if (Array.isArray(value) && value.every((n) => typeof n === 'string' && HOST_NAME.test(n))) {
		return value as string[];
	}
	refuseAction('Error. push_apis: hosts must be a list of registered publication host names.');
}

/** `www v2 (bundle_refused:drift: a, b)` per failed host×API, v2 first. */
function failedPushes(report: ApiReconcileReport): string[] {
	return report.hosts.flatMap((host) =>
		(['v2', 'v1'] as const)
			.filter((api) => host[api].result === 'failed')
			.map((api) => {
				const { error, detail } = host[api];
				return `${host.name} ${api} (${error ?? 'failed'}${detail === undefined ? '' : `: ${detail}`})`;
			}),
	);
}

function pushMessage(report: ApiReconcileReport, failed: string[]): string {
	if (report.refused !== null) {
		return `Error. Nothing was pushed: this engine tree has no verified Publication API release (${report.refused}).`;
	}
	if (failed.length > 0) {
		return `Error. Release ${report.release}: the push failed on ${failed.join('; ')}. Each host and API is shown below.`;
	}
	return `OK. Release ${report.release ?? 'none'} is current on ${report.hosts.length} publication host(s).`;
}

function runtimeNote(report: ApiReconcileReport): string {
	if (report.runtime_error === undefined) return '';
	return ` The result could not be recorded (${report.runtime_error}): the panel cannot show it until the runtime file is fixed or deleted (deleting it is safe).`;
}

export function createPublicationHostsWidget(
	loadDeps: DepsLoader,
	loadSetupDeps: SetupDepsLoader = loadDefaultSetupDeps,
): WidgetModule {
	const bind =
		(action: BoundAction) =>
		(options: Record<string, unknown>, principal: Principal): Promise<WidgetResponse> =>
			action(options, principal, loadDeps);
	return {
		spec: {
			id: 'publication_hosts',
			category: 'publication',
			label: { kind: 'label', key: 'publication_hosts' },
		},
		apiActions: {
			apply_rules: bind(applyRulesAction),
			probe: bind(probeAction),
			rollback_api: bind(rollbackApiAction),
			set_host_fields: bind(setHostFieldsAction),
			remove_host: bind(removeHostAction),
			push_apis: bind(pushApisAction),
			reconcile_media_copy: bind(reconcileMediaCopyAction),
			probe_public: bind(probePublicAction),
			// "New publication host" (root only): drafts, the kit, the sealed-package pairing
			...createSetupActions(loadSetupDeps),
		},
		getValue: async (_options, principal) =>
			publicationHostsValue(await loadDeps(), principal, loadSetupDeps),
	};
}

export const widget: WidgetModule = createPublicationHostsWidget(loadDefaultDeps);
