/**
 * THE PUBLICATION-HOST AGENT CLIENT (PUBLICATION_HOST_SPEC §2; phase-3 E6/E7).
 *
 * Every command the engine sends a paired publication agent is built here, and every byte
 * leaves through transport.ts (E5, the one door) — this file never dials and never spells
 * the agent's base path: paths are AGENT_PATHS entries, relative to it. The shape mirrors
 * tools/tool_sitebuilder/server/daemon_client.ts.
 *
 * ── THE PAIRING ORDER ─────────────────────────────────────────────────────────────────
 *  1. LOCAL: the host's token file must imply the registry fingerprint
 *     (publicationHostFingerprint(instance, token)) — refused before anything is dialled.
 *  2. LIVE: the unauthenticated GET /health must publish that fingerprint
 *     (publicationHostFingerprintMatches, constant time). Only then is the bearer sent.
 *  3. MUTATIONS (rules.apply, rules.map, release.install, release.rollback, and copy mode's media.put,
 *     media.delete, media.mark) prove LIVE on EVERY call:
 *     a re-provisioned agent receives the anonymous /health and nothing else — no bearer,
 *     no actor, no body (Review Focus 1).
 *  4. READS (status, media.probe, media.manifest) may ride a cached proof (E6). The cache key is host name
 *     → registry fingerprint + registry address, so a re-pair from ANOTHER process (the pair
 *     CLI) changes the key and the next read re-proves; a removed host is `unconfigured`.
 *     ONLY SUCCESS is cached; it is dropped on any transport failure, on a 401 (followed by
 *     exactly one anonymous re-probe: mismatch → pairing_mismatch, match → auth), and on a
 *     status body naming another fingerprint. NAMED RESIDUAL: one read under a cached proof
 *     may carry the old bearer to an agent re-provisioned since the proof, before the 401
 *     re-probe catches it.
 *
 * WHAT THE FINGERPRINT PROVES — and what it does not. It is published on an
 * unauthenticated route, so anyone who reaches the real agent learns it. Its check detects
 * DRIFT and MISROUTING (a re-provisioned agent, another instance, a wrong address); it does
 * not keep an impostor out. Impostor resistance is the CHANNEL's: mTLS with the pinned CA
 * (a TCP host), the socket's filesystem permissions (a unix host — the door refuses a
 * socket that is a symlink or sits in a group/other-writable directory).
 *
 * THE REFUSAL IS ONE REFUSAL: wrong instance and wrong token are indistinguishable to the
 * caller. Log lines name the HOST only — never the token, a key, a fingerprint or the
 * address. The agent's problem `detail` is log-only (wire.ts, the only minter of
 * rejected/failed): an input this engine will not send is `engineRefusal(input_invalid)`
 * (`rejected`), a 2xx it cannot read is `engineFailure(unreadable_body)` (`failed`). A
 * token file the secrets store refuses (mode, owner, shape) is `unconfigured`.
 *
 * The install body stream is the CALLER's: a refusal before the bearer request (input,
 * registry, secrets, the live proof) leaves it unread.
 */

import type { DedaloError } from '../errors/index.ts';
import type { PublicationHostServer } from '../media/publication_host_rules.ts';
import { publicationHostFingerprint, publicationHostFingerprintMatches } from './pairing.ts';
import {
	getHost,
	HOST_NAME,
	type PublicationHostRecord,
	RESERVED_HOST_PREFIX,
	RegistryError,
} from './registry.ts';
import { readHostToken, SecretError } from './secrets.ts';
import {
	AGENT_QUERY_GRAMMAR,
	type AgentRequest,
	type AgentResponse,
	agentRequest,
	MAX_PUT_TIMEOUT_MS,
	mediaPutDeadlineMs,
} from './transport.ts';
import {
	agentResponseError,
	engineFailure,
	engineRefusal,
	hostError,
	LOCAL_STAGE,
	registryError,
} from './wire.ts';

/** The /health field the pairing travels in (the agent's health route). */
export const AGENT_PAIRING_FIELD = 'instance_fingerprint';
/** The agent's actor convention on mutations. */
export const AGENT_ACTOR_HEADER = 'x-dedalo-actor';

export const AGENT_TIMEOUTS_MS = Object.freeze({
	health: 5_000,
	read: 10_000,
	rules: 60_000,
	rollback: 120_000,
	install: 900_000,
	media: 60_000,
});

/**
 * A put streams one public derivative (an AV file may be gigabytes): its deadline is sized
 * to the file (transport.ts mediaPutDeadlineMs — 30 min of slack plus the file at the
 * slowest sized link), up to the door's PUT ceiling. A put that still times out is
 * deferred by the copy round (media_copy_apply.ts), never the end of it.
 */
export const MEDIA_PUT_TIMEOUT_MS = MAX_PUT_TIMEOUT_MS;
/** Paths per media.delete request (the agent takes at most 1000). */
export const MEDIA_DELETE_BATCH = 500;
const HEALTH_MAX_BYTES = 4_096;

export type AgentApi = 'v1' | 'v2';

/** The agent's MediaProbe (GET /v1/media/probe, and `media` in status). */
export interface MediaProbe {
	mode: 'shared' | 'copy' | 'none';
	root: string | null;
	present: boolean;
	read_only: boolean | null;
	pub_readable: boolean | null;
	/**
	 * Every directory from the media root down to `.publication/pub` grants o+x, so the web
	 * server's own user can stat a marker (Rule B) and traverse to a file. `false`: a dir is
	 * dark to the web server and EVERY published file 404s (the agent adds a problems[] line
	 * naming it); `null`: not measured (mode `none`, root absent). Required: no compat with an
	 * agent that predates it (PUBLICATION_HOST_SPEC §6, the `served_apis` precedent).
	 */
	web_traversable: boolean | null;
	pub_markers: number | null;
	problems: string[];
}

/**
 * The agent's `rules.map` status (PUBLICATION_HOST_SPEC §9.7 / provision init §13.4): the
 * host-wide nginx http{} map. `null` on an Apache host; `{managed: false}` when the operator
 * places the map by hand; otherwise this instance's contribution as root's renderer loaded it.
 */
export type AgentRulesMap =
	| null
	| { managed: false }
	| {
			managed: true;
			/** This instance's contribution hash when it is part of the LOADED host file, else null. */
			hash: string | null;
			/** The `# config-hash:` of the loaded host file (shared by every instance), or null. */
			host_hash: string | null;
			contributions: number;
			invalid: number;
			/** The agent reason root's last render recorded for this instance, or null. */
			refused: string | null;
	  };

/** The agent's AgentStatus (GET /v1/status). */
export interface AgentStatus {
	agent_version: string;
	bun_version: string;
	platform: string;
	instance_fingerprint: string;
	apis: Record<AgentApi, { current: string | null; previous: string | null }>;
	/**
	 * The APIs this host SERVES, in report order: `['v1', 'v2']`, or `['v2']` on a v2-only site
	 * (the declaration has no `v1` block, so the host runs no Publication API v1 at all). An
	 * unserved api's `apis` slot is `{current: null, previous: null}`; the agent refuses its
	 * releases (`api_not_served`). Required: no compat with an agent that predates it
	 * (WC-2026-10-09-publication-host-v2-only-site).
	 */
	served_apis: readonly AgentApi[];
	/**
	 * `map` is ABSENT on an agent that predates the host-wide nginx map (the shape check
	 * accepts that; apply_rules refuses on nginx until the agent is updated).
	 */
	rules: { server: string; hash: string | null; map?: AgentRulesMap };
	media: MediaProbe;
	disk: { state_root_free_bytes: number };
}

/** The agent's InstallResult (POST /v1/releases/<api>). */
export interface InstallResult {
	api: AgentApi;
	from: string | null;
	to: string;
	reused: boolean;
	health: 'ok';
}

export interface RulesApplyInput {
	server: PublicationHostServer;
	text: string;
	hash: string;
}

/** POST /v1/rules/map: buildNginxMap() and nginxMapConfigHash() (rules.ts expectedNginxMap). */
export interface RulesMapInput {
	text: string;
	hash: string;
}

/** The agent's answer to rules.map: this contribution is in the host file nginx has loaded. */
export interface RulesMapApplied {
	hash: string;
	host_hash: string;
	contributions: number;
	reloaded: true;
}

/** A release id `<version>_<digest7>` (spec §3); host_status shapes agent-reported ids by it. */
export const AGENT_RELEASE_ID = /^\d+(\.\d+){1,3}_[0-9a-f]{7}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
/**
 * The agent's actor rule (1-200, no control characters) narrowed to what an HTTP header
 * value can carry as-is: printable Latin-1. A wider name would make fetch throw an untyped
 * TypeError at the door; it is refused here, typed, before anything is dialled.
 */
const ACTOR = /^[\x20-\x7e\xa0-\xff]{1,200}$/;
const APIS: ReadonlySet<string> = new Set(['v1', 'v2']);
const SERVERS: ReadonlySet<string> = new Set(['apache', 'nginx']);
const MEDIA_MODES: ReadonlySet<string> = new Set(['shared', 'copy', 'none']);

/**
 * READ PROOFS: host name → proofKey (registry fingerprint + address) its /health proved.
 * Process state about a fixed registry entry — no user, session or language. Success only;
 * deleted on transport failure, 401, status-fingerprint mismatch, any failed proof, and
 * forgetPairing. Mutations never consult it.
 */
const provenPairings = new Map<string, string>();

function proofKey(host: PublicationHostRecord): string {
	return JSON.stringify([host.fingerprint, host.address]);
}

interface Command {
	name: string;
	request: AgentRequest;
}

interface Answer {
	status: number;
	body: unknown;
}

function command(
	name: string,
	method: AgentRequest['method'],
	path: string,
	extra: Partial<AgentRequest> = {},
): Command {
	return { name, request: { method, path, timeoutMs: AGENT_TIMEOUTS_MS.read, ...extra } };
}

// ── input refusals (engine-authored, before any dial) ────────────────────────────────

/**
 * wire.ts's engine refusal (`rejected`, reason input_invalid): the WHY is log-only. The
 * name is shown only once it matches HOST_NAME (the input checks may run before
 * requireHost), and the refusal is LOCAL_STAGE: minted before any dial, it is never an
 * agent answer (host_status must not read it as reachable ok).
 */
function refuse(name: string, commandName: string, why: string): DedaloError {
	const shown = vettedName(name);
	return engineRefusal(shown, 'input_invalid', {
		message: `publication host '${shown}': ${commandName} refused before dialling: ${why}`,
		coordinates: { command: commandName, stage: LOCAL_STAGE },
	});
}

function assertActor(name: string, commandName: string, actor: string): void {
	if (!ACTOR.test(actor)) {
		throw refuse(name, commandName, 'the actor must be 1-200 printable Latin-1 characters');
	}
}

function assertApi(name: string, commandName: string, api: string): void {
	if (!APIS.has(api)) throw refuse(name, commandName, 'the api must be v1 or v2');
}

function assertRulesRequest(name: string, req: RulesApplyInput, actor: string): void {
	assertActor(name, 'rules.apply', actor);
	if (!SERVERS.has(req.server))
		throw refuse(name, 'rules.apply', 'the server must be apache or nginx');
	if (!SHA256_HEX.test(req.hash))
		throw refuse(name, 'rules.apply', 'the hash must be 64 lowercase hex');
	if (req.text.length === 0) throw refuse(name, 'rules.apply', 'the include text is empty');
}

function assertMapRequest(name: string, req: RulesMapInput, actor: string): void {
	assertActor(name, 'rules.map', actor);
	if (!SHA256_HEX.test(req.hash))
		throw refuse(name, 'rules.map', 'the hash must be 64 lowercase hex');
	if (req.text.length === 0) throw refuse(name, 'rules.map', 'the map text is empty');
}

function assertInstallRequest(
	name: string,
	api: string,
	releaseId: string,
	sha256: string,
	actor: string,
): void {
	assertApi(name, 'release.install', api);
	assertActor(name, 'release.install', actor);
	if (!AGENT_RELEASE_ID.test(releaseId)) {
		throw refuse(name, 'release.install', 'the release id must be <version>_<digest7>');
	}
	if (!SHA256_HEX.test(sha256))
		throw refuse(name, 'release.install', 'the bundle sha256 must be 64 lowercase hex');
}

// ── host + secrets ───────────────────────────────────────────────────────────────────

/** A registry that cannot be read is registry_invalid (Review Focus 2), never "no host". */
function loadHost(name: string): PublicationHostRecord | null {
	try {
		return getHost(name);
	} catch (error) {
		if (error instanceof RegistryError) throw registryError(error.reason);
		throw error;
	}
}

/** What a caller-supplied name that fails HOST_NAME is logged and coordinated as: never the raw text. */
const UNVETTED_NAME = '<invalid host name>';

function vettedName(name: string): string {
	return HOST_NAME.test(name) ? name : UNVETTED_NAME;
}

/**
 * The host the registry vouches for. A caller-supplied name is checked against the
 * registry's own grammar FIRST: one outside it is refused input_invalid and never echoed
 * (a CR/LF in it would forge `[publication_host]` log lines operators act on).
 */
function requireHost(name: string): PublicationHostRecord {
	if (!HOST_NAME.test(name)) {
		console.error(`[publication_host] refused a host name outside the registry grammar`);
		throw engineRefusal(UNVETTED_NAME, 'input_invalid', {
			message: `publication host name refused before any lookup: it must match ${HOST_NAME.source}`,
			coordinates: { stage: LOCAL_STAGE },
		});
	}
	const host = loadHost(name);
	if (host === null) {
		console.error(`[publication_host] no publication host named '${name}' in the registry`);
		throw hostError('publication_host.unconfigured', name, {
			message: `no publication host named '${name}'`,
		});
	}
	return host;
}

/** The token, or `unconfigured` — a token file the secrets store refuses is typed, never raw. */
function readToken(host: PublicationHostRecord): string | null {
	try {
		return readHostToken(host.name);
	} catch (error) {
		if (!(error instanceof SecretError)) throw error;
		console.error(
			`[publication_host] host '${host.name}': its token file is refused (${error.reason})`,
		);
		throw hostError('publication_host.unconfigured', host.name, {
			message: `publication host '${host.name}': token refused (${error.reason})`,
			coordinates: { reason: 'token', secret_reason: error.reason },
		});
	}
}

/** The operator's pair command, as documented (docs/install/publication_host.md): run as the
 * owner of <private>, never root — the CLI refuses any other uid. */
const REPAIR_COMMAND = 'sudo -u <engine user> bun run dedalo:pair-publication-host';

function requireToken(host: PublicationHostRecord): string {
	const token = readToken(host);
	if (token === null) {
		console.error(
			`[publication_host] host '${host.name}' has no token file; re-pair it, as the user that runs Dédalo (never root): ${REPAIR_COMMAND} replace ${host.name} …`,
		);
		throw hostError('publication_host.unconfigured', host.name, {
			message: `publication host '${host.name}' has no token`,
		});
	}
	return token;
}

// ── the pairing ──────────────────────────────────────────────────────────────────────

/** `local`: refused before anything was dialled (stage coordinate LOCAL_STAGE). */
function pairingRefused(host: PublicationHostRecord, why: string, local = false): DedaloError {
	provenPairings.delete(host.name);
	// A pairing's own live proof runs under a throwaway staging name (pair_flow.ts): there is no
	// registered host to `replace`, so the line says what to do with the artifacts instead.
	const repair = host.name.startsWith(RESERVED_HOST_PREFIX)
		? "This was the proof of a NEW pairing (nothing was registered): carry the agent's current artifacts (or a new sealed package) and pair again."
		: `Re-pair the host from the agent artifacts, as the user that runs Dédalo (never root): ${REPAIR_COMMAND} replace ${host.name} …`;
	console.error(
		`[publication_host] PAIRING REFUSED for host '${host.name}': ${why}. Nothing carrying the bearer was sent on this proof. ${repair}`,
	);
	return hostError('publication_host.pairing_mismatch', host.name, {
		message: `publication host '${host.name}' did not prove the pairing: ${why}`,
		...(local ? { coordinates: { stage: LOCAL_STAGE } } : {}),
	});
}

function assertLocalPairing(host: PublicationHostRecord, token: string): void {
	const implied = publicationHostFingerprint(host.instance, token);
	if (!publicationHostFingerprintMatches(host.fingerprint, implied)) {
		throw pairingRefused(host, 'its token file does not imply the registry fingerprint', true);
	}
}

/** A probe parse: `undefined` IS the answer for a non-JSON body (callers refuse it). */
function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function publishedFingerprint(host: PublicationHostRecord): Promise<unknown> {
	const res = await agentRequest(
		host,
		{
			method: 'GET',
			path: '/health',
			timeoutMs: AGENT_TIMEOUTS_MS.health,
			maxResponseBytes: HEALTH_MAX_BYTES,
		},
		null,
	);
	if (res.status !== 200) {
		console.error(
			`[publication_host] host '${host.name}': the pairing probe got HTTP ${res.status} from /health`,
		);
		throw hostError('publication_host.unreachable', host.name, {
			message: `publication host '${host.name}' answered its health route with HTTP ${res.status}`,
		});
	}
	const body = parseJson(res.text);
	return isRecord(body) ? body[AGENT_PAIRING_FIELD] : undefined;
}

/** A LIVE proof; returns the token it proved. Records success, forgets on any failure. */
async function provePairing(host: PublicationHostRecord): Promise<string> {
	provenPairings.delete(host.name);
	const token = requireToken(host);
	assertLocalPairing(host, token);
	const published = await publishedFingerprint(host);
	if (!publicationHostFingerprintMatches(host.fingerprint, published)) {
		throw pairingRefused(
			host,
			'the agent at its address published another fingerprint (another instance, another token, or no proof)',
		);
	}
	provenPairings.set(host.name, proofKey(host));
	return token;
}

/** THE EXPLICIT PROOF (the panel's, the pair CLI's): always live. */
export async function proveHostPairing(host: PublicationHostRecord): Promise<void> {
	await provePairing(host);
}

/** Whether THIS process holds a read proof for the host's CURRENT fingerprint + address. */
export function pairingProved(host: PublicationHostRecord): boolean {
	return provenPairings.get(host.name) === proofKey(host);
}

/** Make the next read of `name` re-prove (correctness never depends on calling it). */
export function forgetPairing(name: string): void {
	provenPairings.delete(name);
}

/** Reads: the cached proof when its key still matches the registry entry, else a live one. */
async function tokenForRead(host: PublicationHostRecord): Promise<string> {
	if (!pairingProved(host)) return provePairing(host);
	const token = requireToken(host);
	assertLocalPairing(host, token); // a token file replaced since the proof
	return token;
}

// ── the bearer call ──────────────────────────────────────────────────────────────────

async function sendWithBearer(
	host: PublicationHostRecord,
	cmd: Command,
	token: string,
): Promise<AgentResponse> {
	try {
		return await agentRequest(host, cmd.request, token);
	} catch (error) {
		// A transport failure says nothing about who answers next time: re-prove first.
		provenPairings.delete(host.name);
		throw error;
	}
}

async function bearerRefused(host: PublicationHostRecord): Promise<never> {
	await provePairing(host); // throws pairing_mismatch / unreachable — the bearer is not re-sent
	provenPairings.delete(host.name);
	console.error(
		`[publication_host] host '${host.name}' proved the pairing but rejected the engine bearer (HTTP 401)`,
	);
	throw hostError('publication_host.auth', host.name, {
		message: `publication host '${host.name}' rejected the engine bearer`,
	});
}

/** A 2xx body this engine cannot read → `failed` (unreadable_body), minted by wire.ts. */
function unreadable(host: PublicationHostRecord, commandName: string, status: number): DedaloError {
	console.error(
		`[publication_host] host '${host.name}' answered ${commandName} (HTTP ${status}) with a body this engine cannot read`,
	);
	return engineFailure(host.name, 'unreadable_body', {
		message: `publication host '${host.name}': ${commandName} answered ${status} with a body this engine cannot read`,
		coordinates: { command: commandName, agent_status: status },
	});
}

async function bearerCall(
	host: PublicationHostRecord,
	cmd: Command,
	token: string,
): Promise<Answer> {
	const res = await sendWithBearer(host, cmd, token);
	if (res.status === 401) return await bearerRefused(host);
	if (res.status < 200 || res.status > 299)
		throw agentResponseError(host.name, res.status, res.text);
	return { status: res.status, body: parseJson(res.text) };
}

async function readCall(host: PublicationHostRecord, cmd: Command): Promise<Answer> {
	return bearerCall(host, cmd, await tokenForRead(host));
}

/** Mutations: a live proof on every call, whatever the cache says (Review Focus 1). */
async function mutateCall(host: PublicationHostRecord, cmd: Command): Promise<Answer> {
	return bearerCall(host, cmd, await provePairing(host));
}

function expectShape<T>(
	host: PublicationHostRecord,
	commandName: string,
	answer: Answer,
	guard: (value: unknown) => value is T,
): T {
	if (!guard(answer.body)) throw unreadable(host, commandName, answer.status);
	return answer.body;
}

// ── shape guards (the agent is another deployable: its answers are checked, not trusted) ─

function isNullableString(value: unknown): value is string | null {
	return value === null || typeof value === 'string';
}

function isNullableBoolean(value: unknown): value is boolean | null {
	return value === null || typeof value === 'boolean';
}

function isNullableCount(value: unknown): value is number | null {
	return value === null || Number.isSafeInteger(value);
}

function isStringList(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isProbeHead(value: Record<string, unknown>): boolean {
	return (
		MEDIA_MODES.has(String(value.mode)) &&
		isNullableString(value.root) &&
		typeof value.present === 'boolean' &&
		isStringList(value.problems)
	);
}

function isProbeTail(value: Record<string, unknown>): boolean {
	return (
		isNullableBoolean(value.read_only) &&
		isNullableBoolean(value.pub_readable) &&
		isNullableBoolean(value.web_traversable) &&
		isNullableCount(value.pub_markers)
	);
}

export function isMediaProbe(value: unknown): value is MediaProbe {
	return isRecord(value) && isProbeHead(value) && isProbeTail(value);
}

function isApiSlot(value: unknown): boolean {
	return isRecord(value) && isNullableString(value.current) && isNullableString(value.previous);
}

function isApis(value: unknown): boolean {
	return isRecord(value) && isApiSlot(value.v1) && isApiSlot(value.v2);
}

/** The two shapes a host can serve, in report order (AgentStatus.served_apis). */
const SERVED_API_SHAPES: readonly (readonly AgentApi[])[] = Object.freeze([
	Object.freeze(['v1', 'v2'] as const),
	Object.freeze(['v2'] as const),
]);

/** `served_apis`: exactly `['v1','v2']` or `['v2']` — v2 is always served, order fixed. */
export function isServedApis(value: unknown): value is readonly AgentApi[] {
	return (
		Array.isArray(value) &&
		SERVED_API_SHAPES.some(
			(shape) => shape.length === value.length && shape.every((api, i) => value[i] === api),
		)
	);
}

function isManagedMap(value: Record<string, unknown>): boolean {
	return (
		isNullableString(value.hash) &&
		isNullableString(value.host_hash) &&
		Number.isSafeInteger(value.contributions) &&
		Number.isSafeInteger(value.invalid) &&
		isNullableString(value.refused)
	);
}

/** `rules.map`: absent (an older agent), null (apache), {managed:false}, or the managed shape. */
export function isRulesMap(value: unknown): value is AgentRulesMap | undefined {
	if (value === undefined || value === null) return true;
	if (!isRecord(value)) return false;
	if (value.managed === false) return true;
	return value.managed === true && isManagedMap(value);
}

function isRules(value: unknown): boolean {
	return (
		isRecord(value) &&
		typeof value.server === 'string' &&
		isNullableString(value.hash) &&
		isRulesMap(value.map)
	);
}

function isDisk(value: unknown): boolean {
	return isRecord(value) && Number.isSafeInteger(value.state_root_free_bytes);
}

function isStatusIdentity(value: Record<string, unknown>): boolean {
	return (
		typeof value.agent_version === 'string' &&
		typeof value.bun_version === 'string' &&
		typeof value.platform === 'string' &&
		typeof value.instance_fingerprint === 'string'
	);
}

function isStatusState(value: Record<string, unknown>): boolean {
	return (
		isApis(value.apis) &&
		isServedApis(value.served_apis) &&
		isRules(value.rules) &&
		isMediaProbe(value.media) &&
		isDisk(value.disk)
	);
}

export function isAgentStatus(value: unknown): value is AgentStatus {
	return isRecord(value) && isStatusIdentity(value) && isStatusState(value);
}

function isInstallResult(value: unknown): value is InstallResult {
	return (
		isRecord(value) &&
		APIS.has(String(value.api)) &&
		isNullableString(value.from) &&
		typeof value.to === 'string' &&
		typeof value.reused === 'boolean' &&
		value.health === 'ok'
	);
}

function isRulesApplied(value: unknown): value is { hash: string; reloaded: true } {
	return isRecord(value) && typeof value.hash === 'string' && value.reloaded === true;
}

function isMapApplied(value: unknown): value is RulesMapApplied {
	return (
		isRecord(value) &&
		typeof value.hash === 'string' &&
		isSha256Hex(value.host_hash) &&
		isPositiveCount(value.contributions) &&
		value.reloaded === true
	);
}

function isSha256Hex(value: unknown): value is string {
	return typeof value === 'string' && SHA256_HEX.test(value);
}

function isPositiveCount(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 1;
}

function isSwap(value: unknown): value is { from: string; to: string } {
	return isRecord(value) && typeof value.from === 'string' && typeof value.to === 'string';
}

// ── the §6 commands ──────────────────────────────────────────────────────────────────

export async function hostStatus(name: string): Promise<AgentStatus> {
	const host = requireHost(name);
	const answer = await readCall(host, command('status', 'GET', '/v1/status'));
	const status = expectShape(host, 'status', answer, isAgentStatus);
	if (!publicationHostFingerprintMatches(host.fingerprint, status.instance_fingerprint)) {
		throw pairingRefused(
			host,
			'its status body names another fingerprint than the one its /health proved',
		);
	}
	return status;
}

export async function hostMediaProbe(name: string): Promise<MediaProbe> {
	const host = requireHost(name);
	const answer = await readCall(host, command('media.probe', 'GET', '/v1/media/probe'));
	return expectShape(host, 'media.probe', answer, isMediaProbe);
}

export async function hostApplyRules(
	name: string,
	req: RulesApplyInput,
	actor: string,
): Promise<{ hash: string; reloaded: true }> {
	assertRulesRequest(name, req, actor);
	const host = requireHost(name);
	const answer = await mutateCall(
		host,
		command('rules.apply', 'POST', '/v1/rules/apply', {
			headers: { 'content-type': 'application/json', [AGENT_ACTOR_HEADER]: actor },
			body: JSON.stringify({ server: req.server, text: req.text, hash: req.hash }),
			timeoutMs: AGENT_TIMEOUTS_MS.rules,
		}),
	);
	const applied = expectShape(host, 'rules.apply', answer, isRulesApplied);
	if (applied.hash !== req.hash) throw unreadable(host, 'rules.apply', answer.status);
	return { hash: applied.hash, reloaded: true };
}

/**
 * rules.map: THIS instance's contribution to the host-wide nginx http{} map (the agent writes
 * its contribution; root's renderer merges, configtests and reloads). The answer must name the
 * hash that was sent, or it is unreadable — never an OK.
 */
export async function hostApplyRulesMap(
	name: string,
	req: RulesMapInput,
	actor: string,
): Promise<RulesMapApplied> {
	assertMapRequest(name, req, actor);
	const host = requireHost(name);
	const answer = await mutateCall(
		host,
		command('rules.map', 'POST', '/v1/rules/map', {
			headers: { 'content-type': 'application/json', [AGENT_ACTOR_HEADER]: actor },
			body: JSON.stringify({ text: req.text, hash: req.hash }),
			timeoutMs: AGENT_TIMEOUTS_MS.rules,
		}),
	);
	const applied = expectShape(host, 'rules.map', answer, isMapApplied);
	if (applied.hash !== req.hash) throw unreadable(host, 'rules.map', answer.status);
	return {
		hash: applied.hash,
		host_hash: applied.host_hash,
		contributions: applied.contributions,
		reloaded: true,
	};
}

export async function hostInstallRelease(
	name: string,
	api: AgentApi,
	releaseId: string,
	sha256: string,
	body: ReadableStream<Uint8Array>,
	actor: string,
): Promise<InstallResult> {
	assertInstallRequest(name, api, releaseId, sha256, actor);
	const host = requireHost(name);
	const answer = await mutateCall(
		host,
		command('release.install', 'POST', `/v1/releases/${api}`, {
			headers: {
				'content-type': 'application/gzip',
				'x-release-id': releaseId,
				'x-bundle-sha256': sha256,
				[AGENT_ACTOR_HEADER]: actor,
			},
			body,
			timeoutMs: AGENT_TIMEOUTS_MS.install,
		}),
	);
	const result = expectShape(host, 'release.install', answer, isInstallResult);
	if (result.api !== api || result.to !== releaseId)
		throw unreadable(host, 'release.install', answer.status);
	return result;
}

export async function hostRollbackRelease(
	name: string,
	api: AgentApi,
	actor: string,
): Promise<{ from: string; to: string }> {
	assertApi(name, 'release.rollback', api);
	assertActor(name, 'release.rollback', actor);
	const host = requireHost(name);
	const answer = await mutateCall(
		host,
		command('release.rollback', 'POST', `/v1/releases/${api}/rollback`, {
			headers: { [AGENT_ACTOR_HEADER]: actor },
			timeoutMs: AGENT_TIMEOUTS_MS.rollback,
		}),
	);
	const swap = expectShape(host, 'release.rollback', answer, isSwap);
	return { from: swap.from, to: swap.to };
}

// ── copy-mode media mutations (spec §6, phase 5): put / delete / mark ─────────────────
// The agent re-checks everything (copy mode, its path grammar + realpath confinement, the
// sha256 and size of the bytes it received, and that `pub/<key>` exists before a put
// lands). These checks only keep a request this engine could not mean off the wire.

export interface MediaPutFile {
	/** Media-root relative ('/'-separated) — the agent's path. */
	path: string;
	sha256: string;
	size: number;
	body: ReadableStream<Uint8Array>;
}

const MEDIA_FILE_PATH = '/v1/media/file';
const MEDIA_PATH_SHAPE = AGENT_QUERY_GRAMMAR[MEDIA_FILE_PATH]?.path;
/** The agent's MARKER_KEY (its grammar.ts): what media.mark takes. */
const MEDIA_MARKER_KEY = /^[a-z0-9]+_[0-9]+$/;

/** A key the agent can hold a `pub/<key>` marker for (media.mark refuses any other). */
export function isAgentMarkerKey(key: string): boolean {
	return MEDIA_MARKER_KEY.test(key);
}

function isMediaPath(path: unknown): path is string {
	return typeof path === 'string' && MEDIA_PATH_SHAPE?.test(path) === true;
}

function assertPutRequest(name: string, file: MediaPutFile, actor: string): void {
	assertActor(name, 'media.put', actor);
	if (!isMediaPath(file.path))
		throw refuse(name, 'media.put', 'the path is not a safe relative media path');
	if (!SHA256_HEX.test(file.sha256))
		throw refuse(name, 'media.put', 'the sha256 must be 64 lowercase hex');
	if (!Number.isSafeInteger(file.size) || file.size < 0)
		throw refuse(name, 'media.put', 'the size must be a non-negative integer');
}

/** The put refused before the bearer request: the caller's stream is cancelled, never left open. */
async function cancelled<T>(body: ReadableStream<Uint8Array>, check: () => T): Promise<T> {
	try {
		return check();
	} catch (error) {
		await body.cancel().catch(() => undefined);
		throw error;
	}
}

function isPutResult(value: unknown): value is { path: string; sha256: string } {
	return isRecord(value) && typeof value.path === 'string' && typeof value.sha256 === 'string';
}

/** One path the agent could not delete (its copy.ts noteDeleteFailure): an errno code or `escapes_root`. */
export interface MediaDeleteFailure {
	path: string;
	error: string;
}

/** What every media.delete batch answered, merged: per-path failures are DATA, never a throw. */
export interface MediaDeleteResult {
	deleted: string[];
	absent: string[];
	failed: MediaDeleteFailure[];
}

function isDeleteFailure(value: unknown): value is MediaDeleteFailure {
	return isRecord(value) && typeof value.path === 'string' && typeof value.error === 'string';
}

function isDeleteResult(value: unknown): value is MediaDeleteResult {
	return (
		isRecord(value) &&
		isStringList(value.deleted) &&
		isStringList(value.absent) &&
		Array.isArray(value.failed) &&
		value.failed.every(isDeleteFailure)
	);
}

function isMarkResult(value: unknown): value is { key: string; published: boolean } {
	return isRecord(value) && typeof value.key === 'string' && typeof value.published === 'boolean';
}

/** media.put: the file lands on the agent only while its `pub/<key>` marker exists there. */
export async function hostMediaPut(name: string, file: MediaPutFile, actor: string): Promise<void> {
	const host = await cancelled(file.body, () => {
		assertPutRequest(name, file, actor);
		return requireHost(name);
	});
	// A call that fails before (or while) sending — the live /health proof of an unreachable
	// agent above all — must not leave the caller's stream (an open file) to the GC.
	const answer = await mutateCall(
		host,
		command('media.put', 'PUT', MEDIA_FILE_PATH, {
			query: { path: file.path },
			headers: {
				'content-type': 'application/octet-stream',
				'x-sha256': file.sha256,
				'x-size': String(file.size),
				[AGENT_ACTOR_HEADER]: actor,
			},
			body: file.body,
			timeoutMs: mediaPutDeadlineMs(file.size),
		}),
	).catch(async (error: unknown) => {
		await file.body.cancel().catch(() => undefined);
		throw error;
	});
	const landed = expectShape(host, 'media.put', answer, isPutResult);
	if (landed.path !== file.path || landed.sha256 !== file.sha256)
		throw unreadable(host, 'media.put', answer.status);
}

function mediaPost(commandName: string, path: string, body: unknown, actor: string): Command {
	return command(commandName, 'POST', path, {
		headers: { 'content-type': 'application/json', [AGENT_ACTOR_HEADER]: actor },
		body: JSON.stringify(body),
		timeoutMs: AGENT_TIMEOUTS_MS.media,
	});
}

/**
 * media.delete, MEDIA_DELETE_BATCH paths per request. Absent paths are not an error
 * (idempotent). A path the agent could not delete (EACCES, a read-only subtree, an
 * escapes_root refusal) is DATA in `failed`, never a throw: every later batch is still
 * sent, and the caller keeps those paths pending (verified deletion never trusts this).
 */
export async function hostMediaDelete(
	name: string,
	paths: readonly string[],
	actor: string,
): Promise<MediaDeleteResult> {
	assertActor(name, 'media.delete', actor);
	if (!paths.every(isMediaPath))
		throw refuse(name, 'media.delete', 'a path is not a safe relative media path');
	const merged: MediaDeleteResult = { deleted: [], absent: [], failed: [] };
	if (paths.length === 0) return merged;
	const host = requireHost(name);
	for (let start = 0; start < paths.length; start += MEDIA_DELETE_BATCH) {
		const batch = paths.slice(start, start + MEDIA_DELETE_BATCH);
		const answer = await mutateCall(
			host,
			mediaPost('media.delete', '/v1/media/delete', { paths: batch }, actor),
		);
		const result = expectShape(host, 'media.delete', answer, isDeleteResult);
		merged.deleted.push(...result.deleted);
		merged.absent.push(...result.absent);
		merged.failed.push(...result.failed);
	}
	return merged;
}

/** media.mark: writes (true) or removes (false) the agent's `pub/<key>` marker. */
export async function hostMediaMark(
	name: string,
	key: string,
	published: boolean,
	actor: string,
): Promise<void> {
	assertActor(name, 'media.mark', actor);
	if (!MEDIA_MARKER_KEY.test(key)) throw refuse(name, 'media.mark', 'the key is not a marker key');
	if (typeof published !== 'boolean')
		throw refuse(name, 'media.mark', 'published must be a boolean');
	const host = requireHost(name);
	const answer = await mutateCall(
		host,
		mediaPost('media.mark', '/v1/media/mark', { key, published }, actor),
	);
	const marked = expectShape(host, 'media.mark', answer, isMarkResult);
	if (marked.key !== key || marked.published !== published)
		throw unreadable(host, 'media.mark', answer.status);
}

// ── media.manifest (copy mode): GET /v1/media/manifest?cursor=<c>&limit=<n> ─────────────
// → {entries:{path,size,sha256}[], irregular:string[] (every page), markers:string[] (first
// page only), next}. SHAPE validation here; the semantic checks (safe relpaths, sha256 hex,
// marker grammar, irregular disjoint from entries) live in media_copy.ts toManifestView,
// beside the grammar. `irregular` is REQUIRED on every page: a parser that dropped it would
// hide a planted link or dotfile from reconcile and from deletion verification.

export interface MediaManifestEntry {
	path: string;
	size: number;
	sha256: string;
}
export interface MediaManifestPage {
	entries: MediaManifestEntry[];
	irregular: string[];
	markers: string[];
	next: string | null;
}
export interface MediaManifest {
	entries: MediaManifestEntry[];
	irregular: string[];
	markers: string[];
}

export const MEDIA_MANIFEST_PAGE_LIMIT = 1000;
/** A first page also carries every marker (one short line per published record). */
const MEDIA_MANIFEST_MAX_BYTES = 16 * 1024 * 1024;
const MANIFEST_PATH = '/v1/media/manifest';
const MANIFEST_CURSOR = AGENT_QUERY_GRAMMAR[MANIFEST_PATH]?.cursor;
/** What a pure parse (no host in hand: a test, the collector) names in the log coordinates. */
const UNNAMED_HOST = '<media.manifest>';

function manifestFailure(hostName: string, detail: string): DedaloError {
	return engineFailure(hostName, 'unreadable_body', {
		message: `publication host '${hostName}': media.manifest: ${detail}`,
		coordinates: { command: 'media.manifest' },
	});
}

function isManifestEntry(value: unknown): value is MediaManifestEntry {
	return (
		isRecord(value) &&
		typeof value.path === 'string' &&
		typeof value.size === 'number' &&
		typeof value.sha256 === 'string'
	);
}

/** null = the last page; undefined = not a cursor this door can send back (a missing key included). */
function manifestNext(next: unknown): string | null | undefined {
	if (next === null) return null;
	return typeof next === 'string' && MANIFEST_CURSOR?.test(next) === true ? next : undefined;
}

function manifestShapeOk(page: Record<string, unknown>): boolean {
	return (
		Array.isArray(page.entries) &&
		page.entries.every(isManifestEntry) &&
		isStringList(page.irregular) &&
		isStringList(page.markers)
	);
}

/** One wire page → typed page. Markers are read from the FIRST page only. */
export function parseMediaManifestPage(
	body: unknown,
	first: boolean,
	hostName: string = UNNAMED_HOST,
): MediaManifestPage {
	const page = isRecord(body) && manifestShapeOk(body) ? body : null;
	const next = manifestNext(page?.next);
	if (page === null || next === undefined) {
		throw manifestFailure(hostName, 'the page is not {entries, irregular, markers, next}');
	}
	return {
		entries: page.entries as MediaManifestEntry[],
		irregular: page.irregular as string[],
		markers: first ? (page.markers as string[]) : [],
		next,
	};
}

/** Follows `next` to the end. A repeated cursor is refused: a looping agent never hangs a reconcile. */
export async function collectMediaManifest(
	fetchPage: (cursor: string | null) => Promise<MediaManifestPage>,
	hostName: string = UNNAMED_HOST,
): Promise<MediaManifest> {
	const first = await fetchPage(null);
	const entries = [...first.entries];
	const irregular = [...first.irregular];
	const seen = new Set<string>();
	let next = first.next;
	while (next !== null) {
		if (seen.has(next)) throw manifestFailure(hostName, `cursor ${JSON.stringify(next)} repeated`);
		seen.add(next);
		const page = await fetchPage(next);
		entries.push(...page.entries);
		irregular.push(...page.irregular);
		next = page.next;
	}
	return { entries, irregular, markers: first.markers };
}

function manifestCommand(cursor: string | null, limit = MEDIA_MANIFEST_PAGE_LIMIT): Command {
	const query: Record<string, string> = { limit: String(limit) };
	if (cursor !== null) query.cursor = cursor;
	return command('media.manifest', 'GET', MANIFEST_PATH, {
		query,
		maxResponseBytes: MEDIA_MANIFEST_MAX_BYTES,
	});
}

/**
 * The agent's full media manifest (copy mode only — the agent refuses otherwise). A READ:
 * it rides the cached pairing proof like status (E6), every page through the one door.
 */
/**
 * The agent's mirrored `pub/` markers ONLY: one first manifest page of ONE entry (the first
 * page carries every marker), never the whole file list. A READ, like hostMediaManifest.
 */
export async function hostMediaMarkers(name: string): Promise<string[]> {
	const host = requireHost(name);
	const answer = await readCall(host, manifestCommand(null, 1));
	return parseMediaManifestPage(answer.body, true, host.name).markers;
}

export async function hostMediaManifest(name: string): Promise<MediaManifest> {
	const host = requireHost(name);
	return collectMediaManifest(async (cursor) => {
		const answer = await readCall(host, manifestCommand(cursor));
		return parseMediaManifestPage(answer.body, cursor === null, host.name);
	}, host.name);
}
