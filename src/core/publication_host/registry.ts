/**
 * THE PUBLICATION-HOST REGISTRY — the work engine's list of its publication hosts
 * (engineering/PUBLICATION_HOST_SPEC.md §1.1 + §2; phase-3 decisions E1, E2).
 *
 * ONE FILE, `<private>/publication_hosts.json`, mode 0600, `{"version":1,"hosts":[…]}`,
 * holding NON-SECRET descriptors only. The bearer and the mTLS material live per host in
 * `secrets.ts`, never here. Not `ts_state.json`: `setServerState` is a non-atomic writer and
 * a corrupt state file silently resets to defaults; a host list the operator relies on
 * cannot inherit that.
 *
 * LAWS
 *  - The registry is the trust anchor for WHERE the engine dials: it is read only when it
 *    is a regular file (no symlink, no FIFO), mode exactly 0600, owned by the engine user;
 *    anything else is `unreadable` (shown as registry_invalid). The lock file is opened
 *    without following a symlink.
 *  - An ABSENT file is the empty registry. Any other file that cannot be read, parsed or
 *    validated THROWS a `RegistryError` naming its reason: never an empty list, never a
 *    partial one (Review Focus 2 — the panel shows `registry_invalid`).
 *  - The shape is STRICT: a missing key, an unknown key, a wrong type or a repeated name
 *    is invalid. A hand edit that adds a field is refused, not ignored.
 *  - Reads, writes and the lock go ONLY through the atomic JSON state-file kernel
 *    (`core/files/atomic_json.ts`, shared with runtime.ts — one implementation of these laws).
 *  - Writes are ATOMIC and DURABLE (temp 0600 → fsync → rename → fsync of the directory,
 *    `core/files/durable.ts`) and SERIALIZED across processes (the engine and the root
 *    pairing CLI) by `flock(2)` on `<private>/publication_hosts.json.lock`. The kernel
 *    releases that lock when its holder dies, so there is no stale lock to judge and
 *    nothing is ever deleted: the pid-file shape is racy by construction (two waiters
 *    reading one dead pid each delete — the second deletes the first's fresh lock; review
 *    2026-09-30, test/helpers/suite_mariadb_lock.ts). The lock is not re-entrant: a
 *    nested write in the same process is refused as `locked`. flock comes from libc via
 *    bun:ffi — libSystem on macOS, glibc `libc.so.6` on Linux (this project's targets);
 *    a libc without that name fails the first WRITE loudly, reads are unaffected.
 *  - Every path goes through `publicationHostsBase()` — `privateDir`, or the test seam,
 *    which accepts only a temp directory that DECLARES itself one (marker file).
 */

import { existsSync } from 'node:fs';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { comparableHost } from '../../../publication/host_agent/src/provision/layout.ts';
import { privateDir } from '../../config/env.ts';
import { isTestProcess } from '../../config/suite_database.ts';
import {
	JsonFileError,
	readPrivateJsonTextSync,
	withJsonFileLock,
	writeJsonFileAtomic,
} from '../files/atomic_json.ts';
import { PUBLICATION_HOSTS_TEST_MARKER } from './test_marker.ts';

/** Registry key of a host. */
export const HOST_NAME = /^[a-z][a-z0-9_]{1,31}$/;
/**
 * Reserved for the pairing CLI's live-proof staging dirs (scripts/publication_host_pair.ts).
 * No registered host may carry it, so the CLI's stale-staging sweep can never delete a
 * registered host's secrets.
 */
export const RESERVED_HOST_PREFIX = 'pairing_' as const;
/** The agent's INSTANCE (publication/host_agent/src/config.ts INSTANCE_PATTERN). */
const INSTANCE_NAME = /^[a-z][a-z0-9_]{1,31}$/;
/** sha256 lowercase hex — what the agent publishes as `instance_fingerprint`. */
const FINGERPRINT = /^[0-9a-f]{64}$/;
/** RFC 1123 host name (IP literals are accepted through `isIP`). */
const DNS_NAME =
	/^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
/** An absolute unix socket path, no shell- or URL-significant characters. */
const SOCKET_PATH = /^\/[A-Za-z0-9._/-]+$/;
/** sun_path is 104 bytes on macOS (NUL included), 108 on Linux: the stricter target wins. */
const MAX_SOCKET_PATH_BYTES = 103;
/**
 * A public media quality, in the engine's own grammar: `/`-separated folders under the media
 * dir (`image/1.5MB`, `av/404`), each segment starting with `[A-Za-z0-9_]`, no `..` anywhere.
 * The rules builder filters it further (filterPublicQualities: no master tier, >= 2 segments).
 * A bare-folder grammar here refused every real public quality (Task 7 review, 2026-10-04).
 */
const QUALITY = /^[A-Za-z0-9_][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_][A-Za-z0-9._-]*)*$/;
const MAX_QUALITY_LENGTH = 128;
/** A media path relative to `/dedalo/<mediaDir>/` (phase-6 probe records). */
const PROBE_PATH = /^[A-Za-z0-9_][A-Za-z0-9._/-]{0,511}$/;

export const REGISTRY_VERSION = 1;
export const REGISTRY_FILE = 'publication_hosts.json';
/**
 * The most bytes a registry read takes. The read is synchronous (it also runs under the
 * flock, see updateRegistry), so it is CAPPED rather than sized by the file: ~1 KiB per
 * host leaves room for a thousand, and a file past it is `unreadable`, never parsed.
 */
export const REGISTRY_MAX_BYTES = 1024 * 1024;
export { PUBLICATION_HOSTS_TEST_MARKER };

const HOST_KEYS = [
	'name',
	'instance',
	'fingerprint',
	'address',
	'public_url',
	'qualities',
	'probe',
	'paired_at',
] as const;

export type PublicationHostAddress =
	| { kind: 'tls'; host: string; port: number }
	| { kind: 'unix'; socket: string };

export interface PublicationHostRecord {
	name: string;
	instance: string;
	fingerprint: string;
	address: PublicationHostAddress;
	public_url: string | null;
	qualities: string[] | null;
	probe: { published: string | null; unpublished: string | null };
	paired_at: string;
}

export interface RegistryFile {
	version: 1;
	hosts: PublicationHostRecord[];
}

export type RegistryErrorReason =
	| 'unreadable'
	| 'invalid_json'
	| 'invalid_shape'
	| 'duplicate_name'
	| 'locked';

/** Every failure of this store. The message names a path and a field, never file contents. */
export class RegistryError extends Error {
	readonly reason: RegistryErrorReason;

	constructor(reason: RegistryErrorReason, detail: string) {
		super(`publication host registry (${reason}): ${detail}`);
		this.name = 'RegistryError';
		this.reason = reason;
	}
}

// ---------------------------------------------------------------------------
// Paths + the test seam
// ---------------------------------------------------------------------------

/**
 * Test seam: a temp directory that carries PUBLICATION_HOSTS_TEST_MARKER replaces
 * `privateDir` for this store and secrets.ts. Anything else is refused, so no test can
 * point these writers at a real private dir. null restores production resolution.
 */
let baseOverrideForTests: string | null = null;

export function overridePublicationHostsBaseForTests(base: string | null): void {
	if (base !== null && !isDeclaredScratch(base)) {
		throw new RangeError(
			`overridePublicationHostsBaseForTests accepts only a temp directory carrying ${PUBLICATION_HOSTS_TEST_MARKER}`,
		);
	}
	baseOverrideForTests = base;
}

function isDeclaredScratch(base: string): boolean {
	const path = resolve(base);
	return (
		path.startsWith(resolve(tmpdir()) + sep) &&
		existsSync(join(path, PUBLICATION_HOSTS_TEST_MARKER))
	);
}

/** `<private>` in production; the declared scratch dir under the test seam. */
export function publicationHostsBase(): string {
	return baseOverrideForTests ?? privateDir;
}

/**
 * Why the agent door (transport.ts `agentRequest`) may NOT dial from this process, or null
 * (2026-10-05, phase-4 review). In a TEST process the stores must resolve to a DECLARED
 * scratch dir — under the OS temp dir AND carrying PUBLICATION_HOSTS_TEST_MARKER: the
 * in-process seam above, or a child whose `DEDALO_PRIVATE_DIR` was declared with
 * `declareScratchPublicationHostsDir` (scripts/lib/publication_host_scratch.ts: the
 * pair-CLI gate, the drills) — so no test, however it reaches the door (a whole reconcile plan, a whole catalog), sends
 * the installation's bearer to a real paired agent. The marker, not the location, is the
 * guarantee: an installation whose private dir sits under the temp dir (a CI job that runs
 * the checkout from /tmp, so `<private>` = /tmp/private) is still an installation.
 * Outside a test process it is always null: the guard can never stop an installation.
 * `base` is a parameter so the gate builds both situations itself, wherever it runs.
 * Gate: publication_host_door_tripwire rule 7.
 */
export function publicationHostsTestRefusal(
	isTest: boolean = isTestProcess(),
	base: string = publicationHostsBase(),
): string | null {
	if (!isTest) return null;
	if (isDeclaredScratch(base)) return null;
	return (
		'a test process may dial a publication agent only through a scratch publication-hosts ' +
		'store (useScratchPublicationHostsBase, or a child DEDALO_PRIVATE_DIR under the OS temp ' +
		`dir carrying ${PUBLICATION_HOSTS_TEST_MARKER}) — this one is not a declared scratch dir`
	);
}

/** `<private>/publication_hosts.json`. */
export function registryPath(): string {
	return join(publicationHostsBase(), REGISTRY_FILE);
}

// ---------------------------------------------------------------------------
// Validation (pure)
// ---------------------------------------------------------------------------

function shapeError(where: string, what: string): RegistryError {
	return new RegistryError('invalid_shape', `${where} ${what}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(
	value: unknown,
	keys: readonly string[],
	where: string,
): Record<string, unknown> {
	if (!isPlainObject(value)) throw shapeError(where, 'must be an object');
	const found = Object.keys(value).sort().join(', ');
	const expected = [...keys].sort().join(', ');
	if (found !== expected) {
		throw shapeError(where, `must have exactly the keys [${expected}], found [${found}]`);
	}
	return value;
}

function matching(value: unknown, pattern: RegExp, where: string): string {
	if (typeof value !== 'string' || !pattern.test(value)) {
		throw shapeError(where, `must be a string matching ${pattern.source}`);
	}
	return value;
}

function cleanSegments(path: string, where: string): string {
	const bad = path.split('/').some((segment) => ['', '.', '..'].includes(segment));
	if (bad) throw shapeError(where, 'must not contain empty, "." or ".." segments');
	return path;
}

function validTlsHost(host: unknown): host is string {
	return typeof host === 'string' && (isIP(host) !== 0 || DNS_NAME.test(host));
}

/**
 * A TLS address. The host is a DNS name or a bare IP literal — never an IPv6 zone id
 * (`fe80::1%eth0`): no https URL authority can carry one (WHATWG URL refuses it), so the
 * transport could never dial it, and no writer produces one (the pairing takes the host from a
 * parsed URL). An IPv6 literal is held in its RFC 5952 form (layout.ts comparableHost), so a
 * hand-written `FD00:0::1` and the pairing's `fd00::1` are one host to every comparison.
 */
function validateTlsAddress(value: unknown, where: string): PublicationHostAddress {
	const address = exactKeys(value, ['kind', 'host', 'port'], where);
	const host = validatedTlsHost(address.host, `${where}.host`);
	const port = address.port;
	if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
		throw shapeError(`${where}.port`, 'must be an integer 1-65535');
	}
	return { kind: 'tls', host, port };
}

/** The host of a TLS address (see validateTlsAddress), in the one spelling comparisons read. */
function validatedTlsHost(host: unknown, where: string): string {
	if (!validTlsHost(host)) throw shapeError(where, 'must be a DNS name or an IP address');
	if (host.includes('%')) {
		throw shapeError(
			where,
			'must not carry an IPv6 zone id (no https URL can dial one): use a unique local address',
		);
	}
	return comparableHost(host);
}

function validateUnixAddress(value: unknown, where: string): PublicationHostAddress {
	const address = exactKeys(value, ['kind', 'socket'], where);
	const socket = matching(address.socket, SOCKET_PATH, `${where}.socket`);
	if (Buffer.byteLength(socket) > MAX_SOCKET_PATH_BYTES) {
		throw shapeError(`${where}.socket`, `must be at most ${MAX_SOCKET_PATH_BYTES} bytes`);
	}
	cleanSegments(socket.slice(1), `${where}.socket`);
	return { kind: 'unix', socket };
}

function validateAddress(value: unknown, where: string): PublicationHostAddress {
	const kind = isPlainObject(value) ? value.kind : undefined;
	if (kind === 'tls') return validateTlsAddress(value, where);
	if (kind === 'unix') return validateUnixAddress(value, where);
	throw shapeError(`${where}.kind`, "must be 'tls' or 'unix'");
}

/**
 * `public_url` is an http(s) ORIGIN exactly as `url.origin` spells it: no credentials,
 * path, query, fragment or trailing slash. https is the default the panel proposes, but
 * http is NOT refused — some intranets serve http only (§7: the probe follows one
 * http → https upgrade and tells the operator to store the https URL when the site has
 * one). Exported so the panel's writer judges by this same grammar (one grammar, no
 * drift where the writer accepts what saveRegistry then refuses as a corrupt file).
 */
export function isPublicUrlOrigin(value: string): boolean {
	try {
		const url = new URL(value);
		return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === value;
	} catch {
		return false;
	}
}

function validatePublicUrl(value: unknown, where: string): string | null {
	if (value === null) return null;
	if (typeof value !== 'string' || !isPublicUrlOrigin(value)) {
		throw shapeError(
			where,
			'must be null or an http(s) origin (https://host[:port] or http://host[:port], no path)',
		);
	}
	return value;
}

function qualityName(value: unknown, where: string): string {
	const quality = matching(value, QUALITY, where);
	if (quality.length > MAX_QUALITY_LENGTH || quality.includes('..')) {
		throw shapeError(where, `must be at most ${MAX_QUALITY_LENGTH} characters, without '..'`);
	}
	return quality;
}

/**
 * The registry's own `qualities` check, exported so a writer (the publication_hosts widget)
 * judges a field by the SAME grammar saveRegistry will apply: one grammar, no drift where
 * the writer accepts what the registry then refuses as a corrupt file.
 */
export function validateQualities(value: unknown, where = 'qualities'): string[] | null {
	if (value === null) return null;
	if (!Array.isArray(value) || value.length === 0) {
		throw shapeError(
			where,
			'must be null or a non-empty array (a host that may serve nothing is a misconfiguration)',
		);
	}
	const names = value.map((quality, index) => qualityName(quality, `${where}[${index}]`));
	if (new Set(names).size !== names.length) throw shapeError(where, 'must not repeat a quality');
	return names;
}

/** The registry's own probe-path check, exported for the same reason as validateQualities. */
export function validateProbePath(value: unknown, where = 'probe'): string | null {
	if (value === null) return null;
	return cleanSegments(matching(value, PROBE_PATH, where), where);
}

function validateProbe(value: unknown, where: string): PublicationHostRecord['probe'] {
	const probe = exactKeys(value, ['published', 'unpublished'], where);
	return {
		published: validateProbePath(probe.published, `${where}.published`),
		unpublished: validateProbePath(probe.unpublished, `${where}.unpublished`),
	};
}

function isCanonicalIso(value: string): boolean {
	const time = Date.parse(value);
	return !Number.isNaN(time) && new Date(time).toISOString() === value;
}

function validatePairedAt(value: unknown, where: string): string {
	if (typeof value !== 'string' || !isCanonicalIso(value)) {
		throw shapeError(where, 'must be an ISO-8601 UTC timestamp (Date.toISOString())');
	}
	return value;
}

function hostNameField(value: unknown, where: string): string {
	const name = matching(value, HOST_NAME, where);
	if (name.startsWith(RESERVED_HOST_PREFIX)) {
		throw shapeError(
			where,
			`must not start with '${RESERVED_HOST_PREFIX}' (reserved for pairing staging)`,
		);
	}
	return name;
}

function validateHost(value: unknown, index: number): PublicationHostRecord {
	const where = `hosts[${index}]`;
	const host = exactKeys(value, HOST_KEYS, where);
	return {
		name: hostNameField(host.name, `${where}.name`),
		instance: matching(host.instance, INSTANCE_NAME, `${where}.instance`),
		fingerprint: matching(host.fingerprint, FINGERPRINT, `${where}.fingerprint`),
		address: validateAddress(host.address, `${where}.address`),
		public_url: validatePublicUrl(host.public_url, `${where}.public_url`),
		qualities: validateQualities(host.qualities, `${where}.qualities`),
		probe: validateProbe(host.probe, `${where}.probe`),
		paired_at: validatePairedAt(host.paired_at, `${where}.paired_at`),
	};
}

function assertUniqueNames(hosts: readonly PublicationHostRecord[]): void {
	const seen = new Set<string>();
	for (const host of hosts) {
		if (seen.has(host.name)) {
			throw new RegistryError('duplicate_name', `host '${host.name}' is listed more than once`);
		}
		seen.add(host.name);
	}
}

/** The whole-file validator. Returns a fresh, fully-typed copy; throws RegistryError. */
export function validateRegistry(value: unknown): RegistryFile {
	const file = exactKeys(value, ['version', 'hosts'], 'registry');
	if (file.version !== REGISTRY_VERSION) {
		throw shapeError('registry.version', `must be ${REGISTRY_VERSION}`);
	}
	if (!Array.isArray(file.hosts)) throw shapeError('registry.hosts', 'must be an array');
	const hosts = file.hosts.map((host: unknown, index: number) => validateHost(host, index));
	assertUniqueNames(hosts);
	return { version: REGISTRY_VERSION, hosts };
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/** The kernel's refusals in this store's vocabulary (`too_large` reads as `tooLargeAs`). */
function asRegistryError(error: unknown, tooLargeAs: RegistryErrorReason): unknown {
	if (!(error instanceof JsonFileError)) return error;
	const reason = error.reason === 'too_large' ? tooLargeAs : error.reason;
	return new RegistryError(reason, error.message);
}

/**
 * The registry is the trust anchor for WHERE the engine dials, so it is read the way a
 * secret is (secrets.ts readSecretFile) — the kernel's private-file read: no symlink, never
 * blocking on a FIFO, only a regular file of mode exactly 0600 owned by the engine user, at
 * most REGISTRY_MAX_BYTES. Anything else is `unreadable` — the panel shows registry_invalid,
 * nothing is dialled. Synchronous (bounded) because the interface is: the read also runs
 * under the sync flock (updateRegistry).
 */
function readRegistryText(path: string): string | null {
	try {
		return readPrivateJsonTextSync(path, { maxBytes: REGISTRY_MAX_BYTES });
	} catch (error) {
		throw asRegistryError(error, 'unreadable');
	}
}

function parseRegistryJson(text: string, path: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		throw new RegistryError('invalid_json', `${path} is not valid JSON`);
	}
}

/** Absent file → `{version:1,hosts:[]}`; anything else invalid → throws RegistryError. */
export function loadRegistry(): RegistryFile {
	const path = registryPath();
	const text = readRegistryText(path);
	if (text === null) return { version: REGISTRY_VERSION, hosts: [] };
	return validateRegistry(parseRegistryJson(text, path));
}

/** One host by name, or null. Throws RegistryError like loadRegistry. */
export function getHost(name: string): PublicationHostRecord | null {
	return loadRegistry().hosts.find((host) => host.name === name) ?? null;
}

// ---------------------------------------------------------------------------
// Write (atomic, durable, locked — the kernel)
// ---------------------------------------------------------------------------

function writeRegistryFile(next: RegistryFile): RegistryFile {
	// Round-trip through JSON first: what is validated is exactly what is written.
	const valid = validateRegistry(JSON.parse(JSON.stringify(next)));
	// The write is bounded like the read: a file every later read refuses would lock the
	// registry out of its own repair (updateRegistry loads before it writes).
	writeJsonFileAtomic(registryPath(), valid, { maxBytes: REGISTRY_MAX_BYTES });
	return valid;
}

/** The kernel's sync flock: the registry's interface is synchronous (pairing CLI, rare edits). */
function withRegistryLock<T>(body: () => T): T {
	try {
		return withJsonFileLock(registryPath(), body);
	} catch (error) {
		throw asRegistryError(error, 'invalid_shape');
	}
}

/** Validate → temp (0600) → fsync → rename → fsync dir, under the lock. */
export function saveRegistry(next: RegistryFile): void {
	withRegistryLock(() => writeRegistryFile(next));
}

/**
 * Load + `fn` + save under ONE lock hold: no other writer can interleave between the
 * read and the write. A throw from `fn`, from the load or from validation writes nothing.
 */
export function updateRegistry(fn: (current: RegistryFile) => RegistryFile): RegistryFile {
	return withRegistryLock(() => writeRegistryFile(fn(loadRegistry())));
}
