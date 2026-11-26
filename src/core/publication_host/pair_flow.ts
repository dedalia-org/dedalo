/**
 * THE PAIRING — the ONE implementation of "a publication-host agent enters the registry"
 * (engineering/PUBLICATION_HOST_SPEC.md §2, §9.12). Two callers feed it, never two paths:
 *
 *   - the CLI `dedalo:pair-publication-host` (scripts/publication_host_pair.ts), run AS THE
 *     ENGINE USER from the checkout: loose files (fragment + bundle + token) or a sealed
 *     package (`--package`);
 *   - the maintenance panel's `pair_package` action (ROOT ONLY), inside the engine process —
 *     which IS the engine user, so the secrets it writes are the engine's own (secrets.ts
 *     refuses any other owner). The panel adds ONE check of its own before anything is dialled:
 *     the package must complete a draft the panel itself created (`assertBinding`), so a
 *     typed address can never send a credential anywhere.
 *
 * THE ORDER IS THE CONTRACT (pairWith):
 *   1. The fragment was read with the ENGINE's env parser (parseFragment): unknown keys, a
 *      pending fingerprint, both or neither of URL/SOCKET are refused before any connection.
 *   2. The address is a plain https URL ending in the agent base path, or an absolute socket.
 *      An IPv6 host (bracketed in the URL) is held to the agent's own listen-host grammar
 *      (layout.ts listenHostProblem: a unique local address or ::1, never a link-local that needs
 *      a zone id) and kept in its RFC 5952 form — the one spelling every comparison reads.
 *   3. The caller's binding check (the panel: instance + address equal the draft's).
 *   4. The token (never argv, never echoed) and the instance must hash to the fragment's
 *      fingerprint: a mis-pasted token names itself before any connection.
 *   5. The registry slot: add needs a free name, replace an existing one, one agent never sits
 *      under two names. A corrupt registry is a refusal, never "empty".
 *   6. LIVE PROOF over the very channel the engine will use (agent_client.ts proveHostPairing:
 *      mTLS with this bundle, or the socket), from a throwaway `pairing_<hex>` staging copy of
 *      the secrets (a prefix the registry refuses for a real host). No bearer is sent. The
 *      staging is removed whatever happens; a crash leaves it 0600 and the next run sweeps it
 *      after an hour (sweepStaleStaging).
 *   7. Only then, ALL under the registry lock (commit): the slot re-checked, the secrets under
 *      the real name, the registry entry. A refused re-check writes nothing; an add whose
 *      registry write fails removes only the secrets it just wrote.
 *
 * Every refusal is a PairRefusal with a closed machine `reason` (the panel's `details.reason`)
 * and a sentence (the CLI's line). No message carries the token, a key, a PEM or a fingerprint.
 *
 * ASYNC where it walks a directory (the stale-staging sweep): the panel reaches this module from
 * the API dispatch (sync_io_on_request_path_tripwire). The registry and secrets stores are the
 * existing bounded, fd-based writers.
 */

import { randomBytes } from 'node:crypto';
import { lstat, readdir, rmdir } from 'node:fs/promises';
import { isIPv6 } from 'node:net';
import { join } from 'node:path';
import {
	comparableHost,
	listenHostProblem,
	sameListenHost,
} from '../../../publication/host_agent/src/provision/layout.ts';
import { parseEnvFile } from '../../config/env.ts';
import { DedaloError } from '../errors/dedalo_error.ts';
import { proveHostPairing } from './agent_client.ts';
import { publicationHostFingerprint, publicationHostFingerprintMatches } from './pairing.ts';
import {
	HOST_NAME,
	loadRegistry,
	type PublicationHostRecord,
	RESERVED_HOST_PREFIX,
	type RegistryFile,
	updateRegistry,
} from './registry.ts';
// BY NAME, never a namespace: publication_host_door_tripwire allows only the door to load the
// TLS material (readHostTls); a namespace import would count as one.
import {
	removeHostSecrets,
	secretsRoot,
	secretsRootPresent,
	TOKEN_SHAPE,
	writeHostSecrets,
} from './secrets.ts';
import { AGENT_BASE_PATH } from './transport.ts';
import { type HostErrorCode, hostError } from './wire.ts';

/** The live proof's own failures, re-named under the host being paired (proveStaged). */
const PROOF_CODES: ReadonlySet<string> = new Set([
	'publication_host.pairing_mismatch',
	'publication_host.unreachable',
	'publication_host.timeout',
	'publication_host.unconfigured',
]);

export { AGENT_BASE_PATH };

/** The CLI's exit codes (PairRefusal carries one). */
export const EXIT = Object.freeze({ ok: 0, usage: 2, refused: 3, failed: 4 } as const);

/** The agent renderer's ENGINE_KEYS, value for value (held equal by the CLI gate). */
export const FRAGMENT_KEYS = Object.freeze({
	instance: 'DEDALO_PUBLICATION_HOST_INSTANCE',
	url: 'DEDALO_PUBLICATION_HOST_URL',
	socket: 'DEDALO_PUBLICATION_HOST_SOCKET',
	tlsBundle: 'DEDALO_PUBLICATION_HOST_TLS_BUNDLE',
	token: 'DEDALO_PUBLICATION_HOST_TOKEN',
	fingerprint: 'DEDALO_PUBLICATION_HOST_FINGERPRINT',
});
export const TOKEN_PLACEHOLDER = 'PASTE_THE_SERVICE_TOKEN_VALUE_HERE';
export const BUNDLE_PLACEHOLDER = 'PASTE_THE_ENGINE_BUNDLE_PATH_ON_THE_WORK_HOST_HERE';
export const FINGERPRINT_PENDING = 'PENDING_SERVICE_TOKEN_NOT_MINTED_RERUN_PROVISION_APPLY';
/** The live-proof staging prefix: the registry's reserved prefix (one spelling). */
export const STAGING_PREFIX = RESERVED_HOST_PREFIX;

const AGENT_INSTANCE = /^[a-z][a-z0-9_]{1,31}$/;
const FINGERPRINT_SHAPE = /^[0-9a-f]{64}$/;
const MIN_TOKEN_LENGTH = 32;
/** A crashed run's staging copy is swept after an hour (the docs gate reads this line). */
const STAGING_STALE_MS = 60 * 60 * 1000;
const KNOWN_KEYS: ReadonlySet<string> = new Set(Object.values(FRAGMENT_KEYS));

/**
 * Why a pairing was refused — the closed list the panel puts in `details.reason`
 * (publication_host.pairing_refused). `input` is the CLI's own (files, owner, prompt).
 */
export const PAIR_REFUSAL_REASONS = Object.freeze([
	'input',
	'fragment_invalid',
	'fragment_pending',
	'address_invalid',
	'token_invalid',
	'bundle_invalid',
	'fingerprint_mismatch',
	'name_taken',
	'name_unknown',
	'agent_registered',
	'partial_write',
	'draft_unknown',
	'draft_paired',
	'draft_mismatch',
	'address_mismatch',
	'socket_package',
] as const);
export type PairRefusalReason = (typeof PAIR_REFUSAL_REASONS)[number];

export class PairRefusal extends Error {
	readonly reason: PairRefusalReason;
	readonly exit: number;
	/** True when something WAS written before the failure (the message then says what). */
	readonly wrote: boolean;
	constructor(
		message: string,
		exit: number = EXIT.refused,
		wrote = false,
		reason: PairRefusalReason = 'input',
	) {
		super(message);
		this.name = 'PairRefusal';
		this.exit = exit;
		this.wrote = wrote;
		this.reason = reason;
	}
}

/** A refusal with its reason (the common case: exit refused, nothing written). */
function refuse(reason: PairRefusalReason, message: string): never {
	throw new PairRefusal(message, EXIT.refused, false, reason);
}

export interface FragmentFields {
	instance: string;
	fingerprint: string;
	url: string | null;
	socket: string | null;
	/** null = absent or the placeholder. */
	tlsBundle: string | null;
	/** null = absent or the placeholder. */
	token: string | null;
}

export type Address = PublicationHostRecord['address'];

// ------------------------------------------------------------------------------ pure parts

function unlessPlaceholder(value: string | undefined, placeholder: string): string | null {
	return value === undefined || value === placeholder ? null : value;
}

export function parseFragment(text: string): FragmentFields {
	const declared = parseEnvFile(text);
	assertFragmentVocabulary(declared);
	const instance = fragmentInstance(declared);
	const fingerprint = fragmentFingerprint(declared);
	const { url, socket } = fragmentAddress(declared);
	return {
		instance,
		fingerprint,
		url,
		socket,
		tlsBundle: unlessPlaceholder(declared[FRAGMENT_KEYS.tlsBundle], BUNDLE_PLACEHOLDER),
		token: unlessPlaceholder(declared[FRAGMENT_KEYS.token], TOKEN_PLACEHOLDER),
	};
}

type Declared = ReturnType<typeof parseEnvFile>;

/** Some KEY=value lines, every key pairing vocabulary. */
function assertFragmentVocabulary(declared: Declared): void {
	const keys = Object.keys(declared);
	if (keys.length === 0) {
		refuse(
			'fragment_invalid',
			"the fragment declares no KEY=value lines. Is it the agent's engine.env.fragment?",
		);
	}
	const unknown = keys.filter((key) => !KNOWN_KEYS.has(key));
	if (unknown.length > 0) {
		refuse(
			'fragment_invalid',
			`the fragment declares ${unknown.join(', ')}, which is not publication-host pairing vocabulary. ` +
				'A fragment from an agent newer than this engine? Update the engine first.',
		);
	}
}

function fragmentInstance(declared: Declared): string {
	const instance = declared[FRAGMENT_KEYS.instance] ?? '';
	if (!AGENT_INSTANCE.test(instance)) {
		refuse(
			'fragment_invalid',
			`${FRAGMENT_KEYS.instance} is missing or does not match ${AGENT_INSTANCE}.`,
		);
	}
	return instance;
}

function fragmentFingerprint(declared: Declared): string {
	const fingerprint = declared[FRAGMENT_KEYS.fingerprint] ?? '';
	if (fingerprint === FINGERPRINT_PENDING) {
		refuse(
			'fragment_pending',
			`${FRAGMENT_KEYS.fingerprint} is still pending: the agent's service token was not minted when the ` +
				'fragment was rendered. Run `provision apply` on the publication host and carry the new fragment.',
		);
	}
	if (!FINGERPRINT_SHAPE.test(fingerprint)) {
		refuse('fragment_invalid', `${FRAGMENT_KEYS.fingerprint} is missing or not 64 lowercase hex.`);
	}
	return fingerprint;
}

/** Exactly one of the mTLS URL and the socket path. */
function fragmentAddress(declared: Declared): { url: string | null; socket: string | null } {
	const url = declared[FRAGMENT_KEYS.url] ?? null;
	const socket = declared[FRAGMENT_KEYS.socket] ?? null;
	if ((url === null) === (socket === null)) {
		refuse(
			'fragment_invalid',
			`the fragment must set exactly one of ${FRAGMENT_KEYS.url} (mTLS) and ${FRAGMENT_KEYS.socket} (same machine).`,
		);
	}
	return { url, socket };
}

export function parseAgentAddress(fields: Pick<FragmentFields, 'url' | 'socket'>): Address {
	if (fields.socket !== null) return socketAddress(fields.socket);
	return tlsAddress(agentUrl(fields.url));
}

function socketAddress(socket: string): Address {
	if (!socket.startsWith('/')) {
		refuse('address_invalid', `${FRAGMENT_KEYS.socket} must be an absolute socket path.`);
	}
	return { kind: 'unix', socket };
}

function agentUrl(value: string | null): URL {
	try {
		return new URL(value ?? '');
	} catch {
		refuse('address_invalid', `${FRAGMENT_KEYS.url} is not a URL.`);
	}
}

/** https, and nothing besides the origin and the path: no credentials, query or fragment. */
function isPlainHttps(url: URL): boolean {
	return (
		url.protocol === 'https:' &&
		url.username === '' &&
		url.password === '' &&
		url.search === '' &&
		url.hash === ''
	);
}

function tlsAddress(url: URL): Address {
	if (!isPlainHttps(url)) {
		refuse(
			'address_invalid',
			`${FRAGMENT_KEYS.url} must be a plain https:// URL (no credentials, query or fragment): the agent listens on mTLS only.`,
		);
	}
	if (url.pathname.replace(/\/$/, '') !== AGENT_BASE_PATH) {
		refuse(
			'address_invalid',
			`${FRAGMENT_KEYS.url} must end in the agent base path ${AGENT_BASE_PATH}.`,
		);
	}
	return { kind: 'tls', host: fragmentHost(url), port: url.port === '' ? 443 : Number(url.port) };
}

/**
 * The fragment URL's host, unbracketed. WHATWG URL already serializes an IPv6 literal in its
 * RFC 5952 form (comparableHost re-asserts it), and an IPv6 is judged by the AGENT's listen-host
 * grammar: the agent can only ever have declared a unique local address or ::1, so anything
 * else (a link-local, a global, a mapped IPv4) is a hand-made URL that names some other
 * interface — refused before anything is dialled. An IPv4 or name is kept as the URL gives it.
 */
function fragmentHost(url: URL): string {
	const host = comparableHost(url.hostname);
	if (!isIPv6(host)) return host;
	const problem = listenHostProblem(host);
	if (problem !== null) {
		refuse('address_invalid', `${FRAGMENT_KEYS.url}: the IPv6 host '${host}' ${problem}.`);
	}
	return host;
}

export function resolveToken(fragmentToken: string | null, supplied: string | null): string {
	assertOneToken(fragmentToken, supplied);
	return assertTokenShape(supplied ?? fragmentToken ?? '');
}

/** A token from somewhere, and never two different ones. */
function assertOneToken(fragmentToken: string | null, supplied: string | null): void {
	if (fragmentToken === null && supplied === null) {
		refuse(
			'token_invalid',
			`${FRAGMENT_KEYS.token} in the fragment is the placeholder, not a token. Supply the agent's SERVICE_TOKEN ` +
				'with --token-file <a 0600 copy> or --token-stdin (`sudo cat <credential> | …`); it is never taken from argv.',
		);
	}
	if (fragmentToken !== null && supplied !== null && fragmentToken !== supplied) {
		refuse(
			'token_invalid',
			'the fragment carries a token and a different one was supplied. One pairing, one token.',
		);
	}
}

function assertTokenShape(token: string): string {
	if (token.length < MIN_TOKEN_LENGTH) {
		refuse(
			'token_invalid',
			`the token is shorter than ${MIN_TOKEN_LENGTH} characters; the agent refuses to boot with such a token, so it is not this agent's.`,
		);
	}
	if (!TOKEN_SHAPE.test(token)) {
		refuse(
			'token_invalid',
			'the token is not one run of printable ASCII without spaces (the engine secrets store refuses any other shape). Copy it unedited.',
		);
	}
	return token;
}

export function resolveBundlePath(
	kind: 'tls' | 'unix',
	fragmentBundle: string | null,
	flagBundle: string | null,
): string | null {
	if (kind === 'unix') {
		if (fragmentBundle !== null || flagBundle !== null) {
			refuse(
				'bundle_invalid',
				'a socket pairing carries no TLS bundle (spec §1.1: the socket group is the access decision). Drop --bundle.',
			);
		}
		return null;
	}
	return tlsBundlePath(fragmentBundle, flagBundle);
}

/** An mTLS pairing's bundle: the flag's or the fragment's (never two different ones). */
function tlsBundlePath(fragmentBundle: string | null, flagBundle: string | null): string {
	if (fragmentBundle !== null && flagBundle !== null && fragmentBundle !== flagBundle) {
		refuse(
			'bundle_invalid',
			`${FRAGMENT_KEYS.tlsBundle} in the fragment and --bundle name different files.`,
		);
	}
	const path = flagBundle ?? fragmentBundle;
	if (path === null) {
		refuse(
			'bundle_invalid',
			'an mTLS pairing needs the engine bundle: pass --bundle <engine_bundle.pem> (client certificate, client key, CA — carried from the publication host).',
		);
	}
	return path;
}

/**
 * The bundle rule for a SEALED PACKAGE: the same two refusals as resolveBundlePath (a socket
 * pairing carries none; an mTLS one needs it), and a fragment naming a bundle FILE besides the
 * package's own is refused rather than guessed between.
 */
export function resolvePackageBundle(
	kind: 'tls' | 'unix',
	fragmentBundle: string | null,
	packagePem: string,
): string | null {
	if (kind === 'unix') {
		refuse(
			'socket_package',
			'a socket pairing carries no TLS bundle (spec §1.1: the socket group is the access decision), and this package does. ' +
				'Pair a socket agent with --fragment and --token-stdin.',
		);
	}
	if (fragmentBundle !== null) {
		refuse(
			'bundle_invalid',
			`${FRAGMENT_KEYS.tlsBundle} in the package's fragment names a file, and the package carries the bundle itself. Write a new package with provision init.`,
		);
	}
	if (packagePem.trim() === '') {
		refuse(
			'bundle_invalid',
			'an mTLS pairing needs the engine bundle, and the package holds none.',
		);
	}
	return packagePem;
}

/** Returns the fingerprint the registry stores. Wrong token and wrong instance: one sentence. */
export function assertFragmentFingerprint(
	fields: Pick<FragmentFields, 'instance' | 'fingerprint'>,
	token: string,
): string {
	const computed = publicationHostFingerprint(fields.instance, token);
	if (!publicationHostFingerprintMatches(fields.fingerprint, computed)) {
		refuse(
			'fingerprint_mismatch',
			`the instance and the token do not hash to the fragment's ${FRAGMENT_KEYS.fingerprint}: the token is not ` +
				"this agent's, or the fragment is another instance's.",
		);
	}
	return computed;
}

export function addressLabel(address: Address): string {
	if (address.kind === 'unix') return `unix:${address.socket}`;
	const host = address.host.includes(':') ? `[${address.host}]` : address.host;
	return `https://${host}:${address.port}`;
}

/** One agent address? A TLS host compares canonically (an IPv6 has one RFC 5952 spelling). */
export function sameAddress(a: Address, b: Address): boolean {
	if (a.kind === 'unix') return b.kind === 'unix' && a.socket === b.socket;
	return b.kind === 'tls' && sameListenHost(a.host, b.host) && a.port === b.port;
}

// ---------------------------------------------------------------------------- registry slot

export function assertSlot(
	registry: RegistryFile,
	command: 'add' | 'replace',
	name: string,
	address: Address,
	fingerprint: string,
): PublicationHostRecord | null {
	const existing = registry.hosts.find((host) => host.name === name) ?? null;
	assertCommandFits(command, name, existing);
	const twin = registry.hosts.find(
		(host) =>
			host.name !== name &&
			(sameAddress(host.address, address) || host.fingerprint === fingerprint),
	);
	if (twin !== undefined) {
		refuse(
			'agent_registered',
			`this agent is already registered as '${twin.name}'. One agent, one registry entry.`,
		);
	}
	return existing;
}

/** `add` needs a free name, `replace` a registered one. */
function assertCommandFits(
	command: 'add' | 'replace',
	name: string,
	existing: PublicationHostRecord | null,
): void {
	if (command === 'add' && existing !== null) {
		refuse(
			'name_taken',
			`a publication host named '${name}' is already registered. Use \`replace\` to re-pair it.`,
		);
	}
	if (command === 'replace' && existing === null) {
		refuse('name_unknown', `no publication host named '${name}' is registered. Use \`add\`.`);
	}
}

function buildRecord(
	name: string,
	instance: string,
	address: Address,
	fingerprint: string,
	existing: PublicationHostRecord | null,
): PublicationHostRecord {
	return {
		name,
		instance,
		fingerprint,
		address,
		public_url: existing?.public_url ?? null,
		qualities: existing?.qualities ?? null,
		probe: existing?.probe ?? { published: null, unpublished: null },
		paired_at: new Date().toISOString(),
	};
}

// ------------------------------------------------------------------------------ live proof

/**
 * A crashed earlier run may have left a 0600 staging dir; anything older than an hour goes.
 * An entry that only LOOKS like staging (fails HOST_NAME, so this module never wrote it) is
 * named and left alone: it must never abort the run (remove included).
 */
export async function sweepStaleStaging(now: number, notes: string[], tag: string): Promise<void> {
	const root = secretsRoot();
	// the root itself is judged like the read path judges it (lstat: real dir, 0700, engine
	// uid) BEFORE readdir/rm: a symlinked root is refused, never walked or deleted through
	if (!secretsRootPresent()) return;
	const skip = (entry: string): void => {
		notes.push(
			`${tag} skipped '${entry}' under ${root}: not a staging dir this command writes. Remove it by hand.`,
		);
	};
	const stale: string[] = [];
	for (const entry of await readdir(root)) {
		const verdict = await stagingVerdict(root, entry, now);
		if (verdict === 'foreign') skip(entry);
		else if (verdict === 'stale') stale.push(entry);
	}
	for (const entry of stale) removeHostSecrets(entry);
}

/**
 * One secrets-root entry: not staging at all (`other`), something only shaped like staging
 * (`foreign`: fails HOST_NAME, or is not a real directory), or a staging dir — `stale` past
 * STAGING_STALE_MS, `fresh` before.
 */
async function stagingVerdict(
	root: string,
	entry: string,
	now: number,
): Promise<'other' | 'foreign' | 'stale' | 'fresh'> {
	if (!entry.startsWith(STAGING_PREFIX)) return 'other';
	if (!HOST_NAME.test(entry)) return 'foreign';
	// lstat, never stat: a (dangling) symlink is not a staging dir and is never followed
	const st = await lstat(join(root, entry)).catch(() => null);
	if (st === null || !st.isDirectory()) return 'foreign';
	return now - st.mtimeMs > STAGING_STALE_MS ? 'stale' : 'fresh';
}

/** Exists WITHOUT following a symlink (a dangling link to the root is not "absent"). */
async function lexists(path: string): Promise<boolean> {
	return (await lstat(path).catch(() => null)) !== null;
}

/**
 * The live proof over the very channel the engine will use. The door takes TLS material
 * only from the secrets store (transport.ts agentRequest — the one-door law), so the proof
 * needs a transient 0600 staging copy; it is removed whatever happens. `dryRun` also
 * removes the secrets root when this proof created it: a dry run leaves no trace.
 */
async function proveStaged(
	record: PublicationHostRecord,
	token: string,
	bundlePem: string | null,
	dryRun: boolean,
	notes: string[],
	tag: string,
): Promise<void> {
	const staging = `${STAGING_PREFIX}${randomBytes(4).toString('hex')}`;
	const createdRoot = !(await lexists(secretsRoot()));
	try {
		// writeHostSecrets validates BEFORE it writes: a bundle that is not the three coherent PEM
		// blocks (client certificate, its PKCS#8 key, the CA that signed it) is a SecretError here.
		writeHostSecrets(staging, token, bundlePem);
		await proveHostPairing({ ...record, name: staging });
	} catch (error) {
		// the proof's failure names the throwaway staging dir; the operator's host is record.name
		if (error instanceof DedaloError && PROOF_CODES.has(error.code)) {
			throw hostError(error.code as HostErrorCode, record.name, {
				message: `the live proof of '${record.name}' failed (${error.code})`,
				cause: error,
			});
		}
		throw error;
	} finally {
		removeHostSecrets(staging);
		if (dryRun && createdRoot) await removeOwnEmptyRoot(notes, tag);
	}
}

/**
 * The dry run's own root, removed only while it is still EMPTY. A root a concurrent pair run
 * wrote into is no longer only the dry run's, so it stays (ENOTEMPTY/ENOENT ignored), and
 * no cleanup error ever replaces the proof's own verdict: anything else is a note.
 */
async function removeOwnEmptyRoot(notes: string[], tag: string): Promise<void> {
	try {
		await rmdir(secretsRoot());
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === 'ENOTEMPTY' || code === 'EEXIST' || code === 'ENOENT') return;
		notes.push(
			`${tag} note: could not remove the dry run's empty secrets root (${code ?? 'error'}).`,
		);
	}
}

// ------------------------------------------------------------------------------- the commit

/**
 * The real write, ALL under the registry lock: the slot is re-checked first, and only a slot
 * that passes gets the secrets — so a refused slot (a concurrent `add` won the name, root
 * removed the host being replaced) writes nothing, never touches another host's credentials,
 * and never leaves a credential no panel lists. Exported for the in-process race gate.
 */
export function commit(
	command: 'add' | 'replace',
	proved: PublicationHostRecord,
	token: string,
	bundlePem: string | null,
): void {
	let wroteSecrets = false;
	try {
		updateRegistry((current) => {
			const existing = assertSlot(
				current,
				command,
				proved.name,
				proved.address,
				proved.fingerprint,
			);
			const record = buildRecord(
				proved.name,
				proved.instance,
				proved.address,
				proved.fingerprint,
				existing,
			);
			wroteSecrets = true;
			writeHostSecrets(proved.name, token, bundlePem);
			return {
				version: 1,
				hosts: [...current.hosts.filter((host) => host.name !== proved.name), record],
			};
		});
	} catch (error) {
		if (!wroteSecrets) throw error;
		// The locked check found the slot as this run needs it, so on add the name was free:
		// the secrets under it are this run's own and may go.
		if (command === 'add') {
			removeHostSecrets(proved.name);
			throw error;
		}
		throw new PairRefusal(
			`the secrets of '${proved.name}' were replaced but the registry was not (${(error as Error).name}). ` +
				'The panel shows pairing_mismatch for it (no bearer is sent) until `replace` is re-run.',
			EXIT.failed,
			true,
			'partial_write',
		);
	}
}

// ------------------------------------------------------------------------------- the path

/** What a pairing is made of, from loose files or from a sealed package: ONE shape, ONE path. */
export interface PairInputs {
	fields: FragmentFields;
	/** The token supplied besides the fragment (file, stdin, or the package). */
	supplied: string | null;
	/** Resolves the engine bundle once the address kind is known (null: none, a socket pairing). */
	bundle: (kind: Address['kind']) => string | null;
}

export interface PairRequest {
	command: 'add' | 'replace';
	/** The registry name (HOST_NAME, not the staging prefix — the callers check it first). */
	name: string;
	dryRun: boolean;
	/** The caller's log-line tag (`[publication_host_pair]`, `[publication_hosts]`). */
	tag: string;
	/**
	 * The caller's own check of what the inputs ARE, before the token is even looked at and
	 * before anything is dialled (the panel: instance and address equal its draft's). Throws a
	 * PairRefusal to refuse.
	 */
	assertBinding?: (fields: FragmentFields, address: Address) => void;
	/**
	 * Where the notes go, in order, as they happen (the CLI passes its output, so a note survives
	 * a failed proof). Default: a fresh array, returned in the outcome.
	 */
	notes?: string[];
	/** Called once the live proof passed, before the commit (the CLI prints its line there). */
	onProved?: (record: PublicationHostRecord) => void;
}

export interface PairOutcome {
	/** The record as proved (and, unless a dry run, committed). Never carries a secret. */
	record: PublicationHostRecord;
	/** An engine bundle was part of the pairing (an mTLS host). */
	withBundle: boolean;
	/** Notes for the operator (sweep skips, a dry run's cleanup). */
	notes: string[];
}

/** THE pairing: the same checks, proof and commit whichever way the inputs arrived. */
export async function pairWith(request: PairRequest, inputs: PairInputs): Promise<PairOutcome> {
	const notes = request.notes ?? [];
	const { fields } = inputs;
	const address = parseAgentAddress(fields);
	request.assertBinding?.(fields, address);
	const token = resolveToken(fields.token, inputs.supplied);
	const bundlePem = inputs.bundle(address.kind);
	const fingerprint = assertFragmentFingerprint(fields, token);
	const existing = assertSlot(loadRegistry(), request.command, request.name, address, fingerprint);
	const record = buildRecord(request.name, fields.instance, address, fingerprint, existing);
	await proveStaged(record, token, bundlePem, request.dryRun, notes, request.tag);
	request.onProved?.(record);
	if (!request.dryRun) commit(request.command, record, token, bundlePem);
	return { record, withBundle: bundlePem !== null, notes };
}
