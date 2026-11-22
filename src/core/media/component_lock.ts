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
 * (the directory the job pfiles already live in, DEDALO_MEDIA_PROCESSES_DIR),
 * created with O_EXCL (`open 'wx'`) — the filesystem is the arbiter, no DB
 * table.
 *
 * The holder records host, pid, instance, start time and a HEARTBEAT that its
 * manager refreshes while held. A lock is STALE — reclaimed, then logged — when
 *  - its holder is on THIS host and its pid is dead (a crashed process), or
 *  - its holder is THIS instance yet this instance holds no lock with that
 *    token in memory (a leak inside this process — the in-memory check always
 *    runs first, so a live holder of ours never reaches this question), or
 *  - its heartbeat is older than `staleAfterMs` (a dead or hung host — the only
 *    signal available across hosts), or
 *  - it is unreadable and its mtime is older than `staleAfterMs` (a crash
 *    between create and first write).
 * A reclaim is serialized by a second O_EXCL file (`<lock>.reclaim`): whoever
 * creates it re-reads the lock, re-judges it, and only then replaces it — two
 * instances judging the same stale lock can never both win, and neither can
 * remove a lock that came alive in between.
 *
 * REQUIREMENT (engineering/PRODUCTION.md): every instance serving one media
 * tree must share ONE processes dir on a filesystem with atomic O_EXCL create
 * and rename (local disk, or NFSv3+ — which every supported OS provides), and
 * the hosts' clocks must agree within a fraction of `staleAfterMs`.
 */

import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	statSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { writeAtomicallySync } from './atomic.ts';

/** Who holds a component lock — the file's whole content. */
export interface ComponentLockOwner {
	/** The component key (section|id|component|lang). */
	key: string;
	host: string;
	pid: number;
	/** The MediaJobManager instance (random per manager — two in one process differ). */
	instance: string;
	/** The claim or job id that TOOK it (a job adopting a claim keeps the claim's file). */
	holder: string;
	/** Proof of THIS acquisition: release and refresh touch the file only while it matches. */
	token: string;
	started_at: number;
	heartbeat_at: number;
}

/** A held lock: where it is and the token that proves it is ours. */
export interface ComponentLockHandle {
	readonly path: string;
	readonly key: string;
	readonly token: string;
	readonly holder: string;
}

/** What the lock door needs from its manager. */
export interface ComponentLockContext {
	/** The `component_locks` directory (under the shared processes dir). */
	dir: string;
	instance: string;
	staleAfterMs: number;
	/** Whether THIS instance still holds the lock with `token` in memory (its own-leak test). */
	holdsInMemory: (token: string) => boolean;
	now?: () => number;
}

const LOCK_SUFFIX = '.lock';
const RECLAIM_SUFFIX = '.reclaim';
const HOST = hostname();

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

/** True when a pid answers signal 0 on this host. */
function pidIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
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

/** Age of the file by mtime (Infinity when it is gone). */
function fileAgeMs(path: string, now: number): number {
	try {
		return now - statSync(path).mtimeMs;
	} catch {
		return Number.POSITIVE_INFINITY;
	}
}

/** The context's clock (tests inject one). */
function clockOf(context: ComponentLockContext): number {
	return (context.now ?? Date.now)();
}

/**
 * A same-host holder's verdict: this instance decides by its own memory; any
 * other instance is stale when its pid is dead. `undefined` = not decided here
 * (a live pid of another instance: its heartbeat decides).
 */
function localStaleReason(
	owner: ComponentLockOwner,
	context: ComponentLockContext,
): string | null | undefined {
	if (owner.instance === context.instance) {
		return context.holdsInMemory(owner.token) ? null : 'held by this instance but not in memory';
	}
	return pidIsAlive(owner.pid) ? undefined : `pid ${owner.pid} is dead`;
}

/** The cross-host verdict: a heartbeat older than the bound. */
function heartbeatStaleReason(
	owner: ComponentLockOwner,
	now: number,
	boundMs: number,
): string | null {
	const age = now - owner.heartbeat_at;
	return age > boundMs ? `heartbeat ${age} ms old` : null;
}

/**
 * Why a present lock may be reclaimed, or null when it is live. Read with the
 * owner already parsed (null = unreadable).
 */
export function staleReason(
	owner: ComponentLockOwner | null,
	path: string,
	context: ComponentLockContext,
): string | null {
	const now = clockOf(context);
	if (owner === null) {
		return fileAgeMs(path, now) > context.staleAfterMs ? 'unreadable and old' : null;
	}
	const local = owner.host === HOST ? localStaleReason(owner, context) : undefined;
	return local !== undefined ? local : heartbeatStaleReason(owner, now, context.staleAfterMs);
}

/** Create the lock file with O_EXCL; null when it already exists. */
function createExclusive(path: string, owner: ComponentLockOwner): boolean {
	let fd: number;
	try {
		fd = openSync(path, 'wx', 0o640);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
		throw error;
	}
	try {
		writeSync(fd, JSON.stringify(owner));
	} finally {
		closeSync(fd);
	}
	return true;
}

/** Who held a lock, for the reclaim log line. */
function describeOwner(owner: ComponentLockOwner | null): string {
	return owner === null
		? 'unreadable'
		: `${owner.host}:${owner.pid}/${owner.instance} ${owner.holder}`;
}

/**
 * Under the reclaim mutex: RE-JUDGE the lock (it may have come alive since the
 * first look — another instance reclaimed it first), and only a still-stale
 * lock is removed and replaced by ours. True when the lock is now OURS.
 */
function replaceStaleLock(
	path: string,
	owner: ComponentLockOwner,
	context: ComponentLockContext,
): boolean {
	const current = readOwner(path);
	const present = existsSync(path);
	const reason = present ? staleReason(current, path, context) : 'gone';
	if (reason === null) return false;
	if (present) unlinkSync(path);
	console.error(
		`[media lock] reclaimed component lock ${owner.key} (${reason}; was ${describeOwner(current)})`,
	);
	return createExclusive(path, owner);
}

/**
 * Replace a stale lock under the reclaim mutex (`<lock>.reclaim`, O_EXCL).
 * A mutex left by a crash (older than the bound) is removed so the NEXT
 * attempt can proceed; this attempt answers busy.
 */
function reclaim(path: string, owner: ComponentLockOwner, context: ComponentLockContext): boolean {
	const mutex = `${path}${RECLAIM_SUFFIX}`;
	if (!createExclusive(mutex, owner)) {
		if (fileAgeMs(mutex, clockOf(context)) > context.staleAfterMs) unlinkSync(mutex);
		return false;
	}
	try {
		return replaceStaleLock(path, owner, context);
	} finally {
		unlinkSync(mutex);
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
	mkdirSync(context.dir, { recursive: true, mode: 0o750 });
	const path = join(context.dir, componentLockFileName(key));
	const now = clockOf(context);
	const owner: ComponentLockOwner = {
		key,
		host: HOST,
		pid: process.pid,
		instance: context.instance,
		holder,
		token: crypto.randomUUID(),
		started_at: now,
		heartbeat_at: now,
	};
	if (createExclusive(path, owner)) return { path, key, token: owner.token, holder };
	if (staleReason(readOwner(path), path, context) === null) return null;
	return reclaim(path, owner, context) ? { path, key, token: owner.token, holder } : null;
}

/** Is the component held by a LIVE holder (any instance)? A question, no write. */
export function componentLockBusy(key: string, context: ComponentLockContext): boolean {
	const path = join(context.dir, componentLockFileName(key));
	if (!existsSync(path)) return false;
	return staleReason(readOwner(path), path, context) === null;
}

/**
 * Give the lock back — only while the file is still OURS (same token). A lock
 * reclaimed from us (our heartbeat stalled past the bound) is someone else's
 * now: it is left alone and the fact is logged.
 */
export function releaseComponentLock(handle: ComponentLockHandle): void {
	const owner = readOwner(handle.path);
	if (owner?.token !== handle.token) {
		console.error(
			`[media lock] component lock ${handle.key} was no longer ours at release (holder ${handle.holder}) — left to its current owner`,
		);
		return;
	}
	unlinkSync(handle.path);
}

/**
 * Refresh the heartbeat of a held lock (through the atomic writer: a reader
 * never sees a half-written file). False when the lock is no longer ours.
 */
export function refreshComponentLock(
	handle: ComponentLockHandle,
	now: number = Date.now(),
): boolean {
	const owner = readOwner(handle.path);
	if (owner?.token !== handle.token) return false;
	writeAtomicallySync(handle.path, (temp) => {
		writeFileSync(temp, JSON.stringify({ ...owner, heartbeat_at: now }), { mode: 0o640 });
	});
	return true;
}
