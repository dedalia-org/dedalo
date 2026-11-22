/**
 * THE CROSS-PROCESS COMPONENT LOCK — one av build per component across every
 * server instance that shares the media processes dir (A1-01, owner ruling 5).
 *
 * The in-memory arbiter (MediaJobManager.liveByTarget) answers for ONE process.
 * Two instances behind one proxy, sharing the media tree, each have their own
 * registry: without this file an upload on instance B replaced the master
 * under a transcode running on instance A. v6 held one lock FILE per component
 * (component_av::get_build_lock_path, flock on media/av/tmp); this is its
 * equivalent for a fleet: a file per component in the SHARED processes dir
 * (the directory the job pfiles already live in, DEDALO_MEDIA_PROCESSES_DIR).
 * The filesystem is the arbiter, no DB table.
 *
 * TWO FILES PER HOLD, so no one ever rewrites a file another may own:
 *  - `<key>.lock` — the IDENTITY of the hold (key, host, boot/namespace id,
 *    pid, instance, token, started_at). Written ONCE, complete, then published
 *    with `link()` — which fails with EEXIST atomically, so exactly one creator
 *    wins and no reader ever sees a half-written lock. Never rewritten.
 *  - `<key>.lock.<token>.hb` — the HEARTBEAT (a beat counter + the current
 *    holder id), written only by the owner of `<token>`. A refresh writes its
 *    own heartbeat file and nothing else: even a refresh that races a reclaim
 *    cannot touch the new owner's lock or heartbeat (they carry another token).
 *
 * EVERY MUTATION OF ANOTHER'S POSSIBLE LOCK IS COMPARE-AND-SWAP. A release or a
 * reclaim never unlinks by path: it RENAMES the lock to a unique aside name
 * (atomic — it takes exactly whatever stood there), verifies the aside's token
 * is the one it meant to remove, and only then unlinks the aside; a lock that
 * turns out to be someone else's is put back with `link()` (which refuses to
 * overwrite a lock created meanwhile).
 *
 * STALENESS IS OBSERVED, NEVER COMPUTED ACROSS CLOCKS. A lock may be reclaimed
 * (and the reclaim is logged) when
 *  - its holder is on THIS machine (same hostname AND same boot/pid-namespace
 *    id) and either its pid is dead (ESRCH — EPERM means alive), or the pid is
 *    THIS process and no manager here holds its token (a leak inside this
 *    process — the in-memory check always runs first, so a live holder here
 *    never reaches this question);
 *  - otherwise, when the reader has SEEN its heartbeat (or, for an unreadable
 *    lock, its inode + mtime) stay unchanged for `staleAfterMs` of the READER's
 *    own clock across two of its own observations. No wall-clock value written
 *    by another host is ever compared with this host's clock, so skewed clocks
 *    cannot make a live lock stale. The first sighting of a lock is never
 *    stale (a dead holder on another host costs one bound of waiting, never a
 *    wrong reclaim).
 * A reclaim is serialized by a second O_EXCL file (`<lock>.reclaim`): whoever
 * creates it re-judges the lock and replaces it only through the CAS above. A
 * mutex left by a crash is cleared the same way (observed unchanged for the
 * bound, then rename-aside + re-verify inode/mtime before unlinking).
 *
 * HOST IDENTITY (`HOST_ID`): hostname + `/proc/sys/kernel/random/boot_id` +
 * the `/proc/self/ns/pid` inode on Linux, so a pid is only ever judged in the
 * boot and pid namespace it belongs to (two containers sharing a hostname and
 * the processes dir never kill each other's locks by "dead" pid). LIMIT,
 * stated: where /proc is absent (macOS, a development platform) the identity
 * is the hostname alone — macOS has no pid namespaces, and a pid surviving a
 * reboot only delays the reclaim to the heartbeat rule.
 *
 * REQUIREMENT (engineering/PRODUCTION.md §8.1): every instance serving one
 * media tree must share ONE processes dir on a filesystem with atomic O_EXCL
 * create, link and rename (local disk, or NFSv3+). The calls are SYNCHRONOUS by
 * design (MediaJobManager.claimTarget/submit/isOccupied are synchronous: the
 * check and the in-memory index happen in one tick) — so a hung hard NFS mount
 * freezes the event loop; see §8.1 for the mount options.
 */

import {
	closeSync,
	existsSync,
	linkSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { DedaloError } from '../errors/dedalo_error.ts';
import { writeAtomicallySync } from './atomic.ts';

/** Who holds a component lock — the lock file's whole (immutable) content. */
export interface ComponentLockOwner {
	/** The component key (section|id|component|lang). */
	key: string;
	/** Machine identity: hostname + boot/pid-namespace id (see HOST_ID). */
	host: string;
	pid: number;
	/** The MediaJobManager instance (random per manager — two in one process differ). */
	instance: string;
	/** Proof of THIS acquisition: release and refresh act only while it matches. */
	token: string;
	/** Informational (this host's wall clock) — never compared by another host. */
	started_at: number;
}

/** The heartbeat file's content: written by the token's owner only. */
export interface ComponentLockBeat {
	beat: number;
	/** The claim or job id that holds it now (a job adopting a claim re-labels it). */
	holder: string;
}

/** A held lock: where it is and the token that proves it is ours. */
export interface ComponentLockHandle {
	readonly path: string;
	readonly key: string;
	readonly token: string;
	readonly holder: string;
}

/** One reader-side sighting of a lock's changing part, on the READER's clock. */
interface Observation {
	signature: string;
	since: number;
}

/** What the lock door needs from its manager. */
export interface ComponentLockContext {
	/** The `component_locks` directory (under the shared processes dir). */
	dir: string;
	instance: string;
	staleAfterMs: number;
	/** The reader's own sightings, by path (owned by the manager — never module state). */
	observations: Map<string, Observation>;
	/** The READER's clock (monotonic by default; tests inject one). */
	now?: () => number;
}

/** Test seams: called at the race point of a CAS, to interleave another holder. */
export interface ComponentLockRaceHooks {
	/** After the lock was taken aside (release) / after the token check (refresh). */
	between?: () => void;
}

const LOCK_SUFFIX = '.lock';
const RECLAIM_SUFFIX = '.reclaim';
const HEARTBEAT_SUFFIX = '.hb';

/** Read a /proc identity part; '' where /proc is absent (see the header LIMIT). */
function procPart(read: () => string): string {
	try {
		return read();
	} catch {
		return '';
	}
}

/**
 * This machine's identity for pid judgments: hostname + boot id + pid-namespace
 * inode (Linux). Computed once at load — none of it changes while the process lives.
 */
export const HOST_ID: string = [
	hostname(),
	procPart(() => readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()),
	procPart(() => String(statSync('/proc/self/ns/pid').ino)),
].join('#');

/**
 * Tokens held by ANY manager in this process — added on acquire, deleted on
 * release (every path, in a finally). The one fact a lock file cannot tell a
 * reader in the same process: whether its own pid still means it.
 */
const PROCESS_HELD_TOKENS = new Set<string>();

/** The monotonic default reader clock (ms). */
function monotonicNow(): number {
	return Math.round(globalThis.performance.now());
}

/** The context's clock. */
function clockOf(context: ComponentLockContext): number {
	return (context.now ?? monotonicNow)();
}

/**
 * The lock file name for a component key: every byte outside [A-Za-z0-9-]
 * escaped as `~xx`, so distinct keys can never share a file and the name stays
 * readable to an operator listing the directory.
 */
export function componentLockFileName(key: string): string {
	const escaped = key.replace(
		/[^A-Za-z0-9-]/g,
		(char) => `~${char.charCodeAt(0).toString(16).padStart(2, '0')}`,
	);
	return `${escaped}${LOCK_SUFFIX}`;
}

/** The heartbeat file of `token`'s hold on the lock at `path`. */
export function heartbeatPath(path: string, token: string): string {
	return `${path}.${token}${HEARTBEAT_SUFFIX}`;
}

/** A unique aside name next to `path` (CAS staging). */
function asideOf(path: string, verb: string): string {
	return `${path}.${verb}.${process.pid}.${crypto.randomUUID()}`;
}

/** True when a pid answers signal 0 on this machine (EPERM = exists, owned by another user). */
function pidIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM';
	}
}

/** The errno of a node fs error, or undefined. */
function errnoOf(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException | null)?.code;
}

/** Unlink, tolerating a file already gone (ENOENT). */
function unlinkQuiet(path: string): void {
	try {
		unlinkSync(path);
	} catch (error) {
		if (errnoOf(error) !== 'ENOENT') throw error;
	}
}

/** The lock's owner, or null when the file is missing, empty or malformed. */
function readOwner(path: string): ComponentLockOwner | null {
	try {
		const parsed = JSON.parse(readFileSync(path, 'utf8')) as ComponentLockOwner;
		return typeof parsed?.token === 'string' ? parsed : null;
	} catch {
		return null;
	}
}

/** A token's heartbeat, or null when it has none (yet / any more). */
function readBeat(path: string, token: string): ComponentLockBeat | null {
	try {
		const parsed = JSON.parse(
			readFileSync(heartbeatPath(path, token), 'utf8'),
		) as ComponentLockBeat;
		return typeof parsed?.beat === 'number' ? parsed : null;
	} catch {
		return null;
	}
}

/** inode:mtime of a file, or null when it is gone — the identity of an unreadable file. */
function fileSignature(path: string): string | null {
	try {
		const stat = statSync(path);
		return `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
	} catch {
		return null;
	}
}

/**
 * Record a sighting of `signature` at `key` and answer how long (on the reader's
 * clock) it has been seen UNCHANGED. A changed signature restarts the count.
 */
function unchangedForMs(context: ComponentLockContext, key: string, signature: string): number {
	const now = clockOf(context);
	const previous = context.observations.get(key);
	if (previous?.signature === signature) return now - previous.since;
	context.observations.set(key, { signature, since: now });
	return 0;
}

/**
 * A same-machine holder's verdict. `undefined` = not decided here (a live pid
 * of another process: its heartbeat decides).
 */
function localStaleReason(owner: ComponentLockOwner): string | null | undefined {
	if (owner.pid === process.pid) {
		return PROCESS_HELD_TOKENS.has(owner.token)
			? null
			: `held by this process (${owner.instance}) but by no manager in it`;
	}
	return pidIsAlive(owner.pid) ? undefined : `pid ${owner.pid} is dead`;
}

/**
 * Why a present lock may be reclaimed, or null when it is live. Read with the
 * owner already parsed (null = unreadable). Records the reader's sighting.
 */
export function staleReason(
	owner: ComponentLockOwner | null,
	path: string,
	context: ComponentLockContext,
): string | null {
	if (owner === null) return unreadableStaleReason(path, context);
	const local = owner.host === HOST_ID ? localStaleReason(owner) : undefined;
	return local !== undefined ? local : heartbeatStaleReason(owner, path, context);
}

/** An unreadable lock (a crash mid-create): stale once SEEN unchanged for the bound. */
function unreadableStaleReason(path: string, context: ComponentLockContext): string | null {
	const signature = fileSignature(path);
	if (signature === null) return 'gone';
	const age = unchangedForMs(context, path, `unreadable:${signature}`);
	return age > context.staleAfterMs ? `unreadable and unchanged for ${age} ms` : null;
}

/** Any other holder: stale once its heartbeat is SEEN unchanged for the bound. */
function heartbeatStaleReason(
	owner: ComponentLockOwner,
	path: string,
	context: ComponentLockContext,
): string | null {
	const beat = readBeat(path, owner.token);
	const age = unchangedForMs(context, path, `${owner.token}:${beat?.beat ?? 'none'}`);
	return age > context.staleAfterMs ? `heartbeat unchanged for ${age} ms` : null;
}

/** Write `token`'s heartbeat (owner only; atomic — a reader never sees half a beat). */
function writeBeat(path: string, token: string, beat: ComponentLockBeat): void {
	writeAtomicallySync(heartbeatPath(path, token), (temp) => {
		writeFileSync(temp, JSON.stringify(beat), { mode: 0o640 });
	});
}

/** Write a complete file that must not exist yet (O_EXCL). False on EEXIST. */
function writeExclusive(path: string, body: string): boolean {
	let fd: number;
	try {
		fd = openSync(path, 'wx', 0o640);
	} catch (error) {
		if (errnoOf(error) === 'EEXIST') return false;
		throw error;
	}
	try {
		writeSync(fd, body);
	} finally {
		closeSync(fd);
	}
	return true;
}

/**
 * Publish a COMPLETE lock with `link()`: the heartbeat first (a reader never
 * sees a lock without one), then the identity written to a private name, then
 * linked to the lock path — EEXIST means another holder won. True when ours.
 */
function createLock(path: string, owner: ComponentLockOwner, holder: string): boolean {
	writeBeat(path, owner.token, { beat: 0, holder });
	const staged = `${path}.${owner.token}.new`;
	writeExclusive(staged, JSON.stringify(owner));
	try {
		linkSync(staged, path);
		return true;
	} catch (error) {
		unlinkQuiet(heartbeatPath(path, owner.token));
		if (errnoOf(error) === 'EEXIST') return false;
		throw error;
	} finally {
		unlinkQuiet(staged);
	}
}

/**
 * Put a lock taken aside back where it was — unless a new lock was created
 * there meanwhile (link refuses to overwrite). Logged either way it fails.
 */
function restoreAside(aside: string, path: string, why: string): void {
	try {
		linkSync(aside, path);
	} catch (error) {
		if (errnoOf(error) !== 'EEXIST') throw error;
		console.error(
			`[media lock] ${why}: a new lock was created meanwhile at ${path} — the moved one is dropped`,
		);
	} finally {
		unlinkQuiet(aside);
	}
}

/** What a CAS take-aside found at the path. */
type AsideOutcome =
	| { readonly status: 'taken'; readonly owner: ComponentLockOwner | null }
	| { readonly status: 'absent' }
	| { readonly status: 'restored' };

/**
 * Take whatever stands at `path` aside and drop it only when `isExpected` says
 * it is the file the caller meant; otherwise restore it (CAS).
 */
function takeAsideIf(
	path: string,
	verb: string,
	isExpected: (owner: ComponentLockOwner | null, aside: string) => boolean,
	hooks?: ComponentLockRaceHooks,
): AsideOutcome {
	const aside = asideOf(path, verb);
	try {
		renameSync(path, aside);
	} catch (error) {
		if (errnoOf(error) === 'ENOENT') return { status: 'absent' };
		throw error;
	}
	hooks?.between?.();
	const owner = readOwner(aside);
	if (!isExpected(owner, aside)) {
		restoreAside(aside, path, `${verb} of ${path}`);
		return { status: 'restored' };
	}
	unlinkQuiet(aside);
	return { status: 'taken', owner };
}

/** Who held a lock, for the reclaim log line. */
function describeOwner(owner: ComponentLockOwner | null, path: string): string {
	if (owner === null) return 'unreadable';
	const holder = readBeat(path, owner.token)?.holder ?? '?';
	return `${owner.host}:${owner.pid}/${owner.instance} ${holder}`;
}

/**
 * Under the reclaim mutex: RE-JUDGE the lock (it may have come alive since the
 * first look), then replace it by CAS — rename aside, verify it is the very
 * lock judged stale (same token, or for an unreadable lock the same
 * inode/mtime), drop it and its heartbeat, create ours. True when the lock is
 * now OURS.
 */
function replaceStaleLock(
	path: string,
	owner: ComponentLockOwner,
	context: ComponentLockContext,
	holder: string,
): boolean {
	const judged = readOwner(path);
	const judgedSignature = judged === null ? fileSignature(path) : null;
	const reason = existsSync(path) ? staleReason(judged, path, context) : 'gone';
	if (reason === null) return false;
	const taken = takeAsideIf(path, 'reclaim', (current, aside) =>
		isJudgedLock(judged, judgedSignature, current, aside),
	);
	if (taken.status === 'restored') return false;
	if (taken.status === 'taken') dropReclaimed(taken.owner, path, `${owner.key} (${reason})`);
	context.observations.delete(path);
	return createLock(path, owner, holder);
}

/** Is the lock taken aside the very one judged stale? (Token, or inode/mtime when unreadable.) */
function isJudgedLock(
	judged: ComponentLockOwner | null,
	judgedSignature: string | null,
	current: ComponentLockOwner | null,
	aside: string,
): boolean {
	if (judged !== null) return current?.token === judged.token;
	return current === null && fileSignature(aside) === judgedSignature;
}

/** Log a reclaimed lock and drop its heartbeat (the aside itself is already gone). */
function dropReclaimed(previous: ComponentLockOwner | null, path: string, what: string): void {
	console.error(
		`[media lock] reclaimed component lock ${what}; was ${describeOwner(previous, path)}`,
	);
	if (previous !== null) unlinkQuiet(heartbeatPath(path, previous.token));
}

/**
 * A reclaim mutex left by a crash: cleared once the reader has seen it
 * unchanged for the bound — by CAS (rename aside, re-verify inode/mtime, then
 * unlink; a mutex re-created meanwhile is put back).
 */
function clearStaleMutex(mutex: string, context: ComponentLockContext): void {
	const signature = fileSignature(mutex);
	if (signature === null) return;
	if (unchangedForMs(context, mutex, `mutex:${signature}`) <= context.staleAfterMs) return;
	takeAsideIf(mutex, 'unmutex', (_owner, aside) => fileSignature(aside) === signature);
	context.observations.delete(mutex);
}

/**
 * Replace a stale lock under the reclaim mutex (`<lock>.reclaim`, O_EXCL). A
 * mutex left by a crash is cleared so the NEXT attempt can proceed; this
 * attempt answers busy.
 */
function reclaim(
	path: string,
	owner: ComponentLockOwner,
	context: ComponentLockContext,
	holder: string,
): boolean {
	const mutex = `${path}${RECLAIM_SUFFIX}`;
	if (!writeExclusive(mutex, owner.token)) {
		clearStaleMutex(mutex, context);
		return false;
	}
	try {
		return replaceStaleLock(path, owner, context, holder);
	} finally {
		unlinkQuiet(mutex);
	}
}

/** A raw filesystem failure, typed: never an `internal.unexpected` on the wire. */
function lockFailure(action: string, key: string, error: unknown): DedaloError {
	return new DedaloError('media.operation_failed', {
		message: `component lock ${action} ${key} failed: ${(error as Error).message}`,
		coordinates: { key },
		cause: error,
	});
}

/** Run a lock door, typing any raw filesystem error (a DedaloError passes through). */
function typed<T>(action: string, key: string, fn: () => T): T {
	try {
		return fn();
	} catch (error) {
		if (error instanceof DedaloError) throw error;
		throw lockFailure(action, key, error);
	}
}

/**
 * TAKE the component lock for `holder`, or null when another live holder has
 * it. Reclaims a stale lock first (see the module header).
 */
export function acquireComponentLock(
	key: string,
	holder: string,
	context: ComponentLockContext,
): ComponentLockHandle | null {
	return typed('acquire', key, () => {
		mkdirSync(context.dir, { recursive: true, mode: 0o750 });
		const path = join(context.dir, componentLockFileName(key));
		const owner: ComponentLockOwner = {
			key,
			host: HOST_ID,
			pid: process.pid,
			instance: context.instance,
			token: crypto.randomUUID(),
			started_at: Date.now(),
		};
		const ours =
			createLock(path, owner, holder) ||
			(staleReason(readOwner(path), path, context) !== null &&
				reclaim(path, owner, context, holder));
		if (!ours) return null;
		PROCESS_HELD_TOKENS.add(owner.token);
		return { path, key, token: owner.token, holder };
	});
}

/** Is the component held by a LIVE holder (any instance)? A question (it records a sighting). */
export function componentLockBusy(key: string, context: ComponentLockContext): boolean {
	return typed('probe', key, () => {
		const path = join(context.dir, componentLockFileName(key));
		if (!existsSync(path)) return false;
		return staleReason(readOwner(path), path, context) === null;
	});
}

/** Is `handle`'s lock still the one on disk? (The holder's pre-publication check.) */
export function componentLockIsOurs(handle: ComponentLockHandle): boolean {
	return readOwner(handle.path)?.token === handle.token;
}

/**
 * Give the lock back — by CAS: the lock is taken aside, and only a lock with
 * OUR token is dropped; anyone else's (it was reclaimed from us) is put back
 * and the fact logged. Our heartbeat file goes either way.
 */
export function releaseComponentLock(
	handle: ComponentLockHandle,
	hooks?: ComponentLockRaceHooks,
): void {
	try {
		typed('release', handle.key, () => {
			const taken = takeAsideIf(
				handle.path,
				'release',
				(owner) => owner?.token === handle.token,
				hooks,
			);
			if (taken.status !== 'taken') {
				console.error(
					`[media lock] component lock ${handle.key} was no longer ours at release (holder ${handle.holder}) — left to its current owner`,
				);
			}
			unlinkQuiet(heartbeatPath(handle.path, handle.token));
		});
	} finally {
		PROCESS_HELD_TOKENS.delete(handle.token);
	}
}

/**
 * Forget a LOST hold (the lock was reclaimed from us): drop OUR heartbeat file
 * — keyed by our token, read by nobody any more — and never touch the lock,
 * which is someone else's now.
 */
export function abandonComponentLock(handle: ComponentLockHandle): void {
	try {
		typed('abandon', handle.key, () => unlinkQuiet(heartbeatPath(handle.path, handle.token)));
	} finally {
		PROCESS_HELD_TOKENS.delete(handle.token);
	}
}

/**
 * Beat the heartbeat of a held lock: only while the lock on disk carries OUR
 * token, and only into OUR heartbeat file — a refresh racing a reclaim writes
 * a file nobody reads any more, never the new owner's. False when the lock is
 * no longer ours (the caller treats the hold as LOST).
 */
export function refreshComponentLock(
	handle: ComponentLockHandle,
	hooks?: ComponentLockRaceHooks,
): boolean {
	return typed('refresh', handle.key, () => {
		if (!componentLockIsOurs(handle)) return false;
		hooks?.between?.();
		const previous = readBeat(handle.path, handle.token);
		writeBeat(handle.path, handle.token, {
			beat: (previous?.beat ?? 0) + 1,
			holder: handle.holder,
		});
		return true;
	});
}

/**
 * Re-label a held lock (a job ADOPTING a claim): the heartbeat names the new
 * holder, so an operator listing the directory sees the job, not a dead claim.
 * Returns the re-labelled handle (same lock, same token).
 */
export function relabelComponentLock(
	handle: ComponentLockHandle,
	holder: string,
): ComponentLockHandle {
	const relabelled = { ...handle, holder };
	typed('relabel', handle.key, () => {
		if (!componentLockIsOurs(handle)) return;
		const previous = readBeat(handle.path, handle.token);
		writeBeat(handle.path, handle.token, { beat: (previous?.beat ?? 0) + 1, holder });
	});
	return relabelled;
}

/** The current holder named by a lock's heartbeat (operators, gates). */
export function componentLockHolder(path: string): string | null {
	const owner = readOwner(path);
	return owner === null ? null : (readBeat(path, owner.token)?.holder ?? null);
}
