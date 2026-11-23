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
 * EVERY MUTATION OF ANOTHER'S POSSIBLE LOCK IS COMPARE-AND-SWAP, AND THE CHECK
 * NEVER VACATES THE PATH. A release, a reclaim or a stale-mutex clear first
 * HARD-LINKS whatever stands at the path to a private peek name and reads the
 * peek: a lock that is not the one it meant to remove is left exactly where it
 * is (the peek is dropped). Only an expected lock is then renamed aside, and the
 * aside's inode is compared with the peek's — equal: the very file checked is
 * gone, both names are unlinked; different (the path was replaced between the
 * peek and the rename): the moved file is put back with `link()`, which refuses
 * to overwrite a lock created in that instant (logged). So a third party can
 * never slip a lock into a path the check emptied.
 *
 * THE ACCEPTED RESIDUAL (review N4): when the path WAS replaced between the
 * peek and the rename, the replacement is out of place for the microseconds
 * between that rename and the put-back `link()`. A fourth party creating a
 * lock in exactly that instant wins the path; the put-back then refuses
 * (EEXIST, logged) and the replaced holder's lock is gone. That holder is not
 * silently doubled: its own-lock check (componentLockIsOurs — every heartbeat
 * and every publication step) reads another token and treats the hold as
 * LOST, so it publishes nothing more. The window needs three CAS actors on one
 * component inside one rename; it is stated, not closed.
 *
 * STALENESS IS OBSERVED, NEVER COMPUTED ACROSS CLOCKS. A lock may be reclaimed
 * (and the reclaim is logged) when
 *  - its holder is on THIS machine (same hostname AND same boot/pid-namespace
 *    id) and either its pid is dead (ESRCH — EPERM means alive), or the pid is
 *    THIS process and no manager here holds its token (a leak inside this
 *    process — the in-memory check always runs first, so a live holder here
 *    never reaches this question);
 *  - otherwise, when the reader has SEEN its heartbeat (or, for a lock whose
 *    content is EMPTY or MALFORMED, its inode + mtime + size) stay unchanged for
 *    `staleAfterMs` of the READER's own clock across two of its own
 *    observations. No wall-clock value written by another host is ever
 *    compared with this host's clock, so skewed clocks cannot make a live lock
 *    stale. The first sighting of a lock is never stale: a dead holder on
 *    another host costs one bound of waiting.
 *
 * WHAT CANNOT BE JUDGED IS BUSY. Only ENOENT (absent) and an empty or
 * malformed parse count as "no owner"; any other read error (EACCES, EIO,
 * EMFILE, ESTALE…) is LOUD: the acquire answers busy and logs, a busy probe
 * answers busy, a heartbeat logs and beats again next tick, the holder's
 * own-lock check retries before it ever concludes the hold is lost. An
 * unreadable live lock is never reclaimed — a lock whose file this instance
 * cannot read (a foreign uid, a sick mount) waits for an operator, said in the
 * log on every attempt. The residual risk, stated: a holder on another host
 * is judged by its heartbeat alone, so a holder that is HUNG (alive, heartbeat
 * frozen) for longer than the bound is reclaimed — the bound (120 s) is that
 * tolerance.
 *
 * A reclaim is serialized by a second O_EXCL file (`<lock>.reclaim`): whoever
 * creates it re-judges the lock and replaces it only through the CAS above. A
 * mutex left by a crash is cleared the same way (observed unchanged for the
 * bound, then the peek-verified CAS on its inode/mtime/size).
 *
 * ORPHANS ARE SWEPT. A crash can leave siblings of a lock (`<lock>.<token>.hb`,
 * `<lock>.<token>.new`, a heartbeat's temp file, a peek or aside name, a
 * `.reclaim` mutex whose lock is gone). Every successful acquire lists the
 * lock's siblings and removes those it has SEEN unchanged for the bound (the
 * same observation rule; the new owner's own files carry a fresh token, so they
 * are always a first sighting) — so the directory converges on one lock + one
 * heartbeat per held component, and the reader forgets what it no longer sees.
 *
 * SHARED COMPONENTS: PER-LANG HOLDERS vs THE WHOLE-COMPONENT HOLDER (review
 * N1). Builds of DIFFERENT langs of one component run side by side (their
 * locks `s|id|c|<lang>` differ); a record delete / wipe / undelete takes the
 * whole component (`s|id|c|*`) and must exclude every lang. The two sides do
 * not know each other's names (the whole holder cannot know which langs are
 * held), so each PUBLISHES, then LOOKS — and both looks are answered by the
 * SERVER, as the result of a mutation, never by a lookup or a listing (an NFS
 * client with `lookupcache=all` trusts a cached negative dentry or directory
 * listing for seconds — two looks that both miss would let both proceed):
 *  - a PER-LANG holder publishes its lock, REGISTERS (a hard link of its lock
 *    in the component's share dir `<s|id|c>.langs/`, named lock + token), then
 *    PROBES the whole-component name with `link(own lock, s|id|c|*)`. The
 *    server answers EEXIST when a whole holder stands there → the registration
 *    is withdrawn, refused. Linked → no whole holder existed at the server; the
 *    probe is withdrawn by CAS. (A whole holder that arrives during the probe
 *    meets EEXIST on its own publish and judges the probe — a live holder's
 *    lock — busy.)
 *  - the WHOLE holder publishes its lock, then `rmdir`s the share dir: removed,
 *    or absent → no per-lang holder is registered AT THE SERVER, and none can
 *    register afterwards without its probe meeting the published whole lock;
 *    ENOTEMPTY → registrations exist: they are judged (a listing is used to
 *    JUDGE them, never to decide vacancy), dead ones dropped and the server
 *    asked again; a live one refuses.
 * Crossed, X registers and Y publishes before either looks: Y's rmdir meets
 * X's entry (ENOTEMPTY), X's link meets Y's lock (EEXIST) — both refuse, never
 * both proceed. Every deciding answer is EEXIST / ENOTEMPTY / ENOENT from link,
 * rmdir and mkdir, which NFS executes at the server whatever the mount options
 * (a create or a removal cannot be answered from a client cache: a stale
 * cached dir handle answers ESTALE, which retries or refuses). What still
 * reads through the cache is the STALENESS judgement (identity + heartbeat
 * content and attributes), and that is why the mount is VERIFIED: on Linux an
 * NFS processes dir must be `lookupcache=none`, `actimeo=0` (or `noac`) and not
 * `nocto`, or the boot and every lock call refuse (processes_mount.ts). The
 * advisory pre-flight (componentLockBusy — `isOccupied`) still reads; the
 * answer that holds is always the claim's.
 *
 * HOST IDENTITY (`HOST_ID`): hostname + `/proc/sys/kernel/random/boot_id` +
 * the `/proc/self/ns/pid` inode on Linux, so a pid is only ever judged in the
 * boot and pid namespace it belongs to (two containers sharing a hostname and
 * the processes dir never kill each other's locks by "dead" pid). On macOS (a
 * development platform, no /proc and no pid namespaces) the boot part is
 * `kern.bootsessionuuid`, read once at load with `/usr/sbin/sysctl -n` (an
 * absolute path: a launchd PATH has no /usr/sbin; an empty answer is logged
 * once) — new on every
 * boot, so a pid recycled after a reboot is never judged against a lock of the
 * previous boot. Where neither source answers, the identity is the hostname
 * alone, and a lock of a previous boot waits for the heartbeat rule.
 *
 * REQUIREMENT (engineering/PRODUCTION.md §8.1): every instance serving one
 * media tree must share ONE processes dir on a filesystem with atomic O_EXCL
 * create, link, rename and rmdir (local disk, or NFSv3+ mounted
 * `lookupcache=none,actimeo=0` — verified on Linux). The calls are SYNCHRONOUS by
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
	readdirSync,
	readFileSync,
	renameSync,
	rmdirSync,
	statSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { basename, join } from 'node:path';
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

/** A per-lang holder's registration in its component's share dir (see the header). */
export interface ComponentShare {
	/** The component's share dir: `<section|id|component>.langs`. */
	readonly dir: string;
	/** This hold's entry in it: a hard link of the lock, named by lock + token. */
	readonly entry: string;
}

/** A held lock: where it is and the token that proves it is ours. */
export interface ComponentLockHandle {
	readonly path: string;
	readonly key: string;
	readonly token: string;
	readonly holder: string;
	/** Set for a PER-LANG holder that joined its component's share. */
	readonly share?: ComponentShare;
}

/** Test seam of the share protocol: called between PUBLISH and LOOK, on both sides. */
export interface ComponentShareHooks {
	afterPublish?: (side: 'lang' | 'whole', key: string) => void;
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
	/** The crossed-interleaving seam (gates only). */
	shareHooks?: ComponentShareHooks;
}

/** Test seams: called at the race points of a CAS, to interleave another holder. */
export interface ComponentLockRaceHooks {
	/** After the peek link, before it is read (release) / after the token check (refresh). */
	between?: () => void;
	/** After the peek was judged the expected lock, before the path is renamed aside. */
	beforeRename?: () => void;
}

const LOCK_SUFFIX = '.lock';
const RECLAIM_SUFFIX = '.reclaim';
const HEARTBEAT_SUFFIX = '.hb';
const SHARE_SUFFIX = '.langs';

/** Read a /proc identity part; '' where /proc is absent (see the header LIMIT). */
function procPart(read: () => string): string {
	try {
		return read();
	} catch {
		return '';
	}
}

/**
 * The ABSOLUTE sysctl: never resolved through PATH — a launchd service runs
 * with PATH=/usr/bin:/bin, where a bare `sysctl` (it lives in /usr/sbin) is
 * ENOENT and the identity silently fell back to the hostname alone.
 */
const DARWIN_SYSCTL = '/usr/sbin/sysctl';

/** macOS's per-boot id (`kern.bootsessionuuid`); '' elsewhere — and on darwin, '' is said once. */
function darwinBootSession(): string {
	if (process.platform !== 'darwin') return '';
	const session = procPart(() => {
		const run = Bun.spawnSync([DARWIN_SYSCTL, '-n', 'kern.bootsessionuuid'], {
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'ignore',
		});
		return run.success ? run.stdout.toString().trim() : '';
	});
	if (session === '') {
		console.error(
			`[media lock] ${DARWIN_SYSCTL} -n kern.bootsessionuuid did not answer — the host identity is the hostname alone: a lock of a previous boot waits for the heartbeat rule`,
		);
	}
	return session;
}

/**
 * This machine's identity for pid judgments: hostname + boot id + pid-namespace
 * inode (Linux). Computed once at load — none of it changes while the process lives.
 */
export const HOST_ID: string = [
	hostname(),
	procPart(() => readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()) ||
		darwinBootSession(),
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
	return `${escapeLockKey(key)}${LOCK_SUFFIX}`;
}

/** The file-name form of a key (or key prefix) — see componentLockFileName. */
function escapeLockKey(key: string): string {
	return key.replace(
		/[^A-Za-z0-9-]/g,
		(char) => `~${char.charCodeAt(0).toString(16).padStart(2, '0')}`,
	);
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

/**
 * A small JSON file's parsed content, `null` when it is ABSENT (ENOENT) or its
 * content is empty / not JSON. ANY OTHER read error (EACCES, EIO, EMFILE,
 * ESTALE…) THROWS: "cannot read" is never "nobody holds it" (see the header).
 */
function readJsonOrNull(path: string): unknown {
	let text: string;
	try {
		text = readFileSync(path, 'utf8');
	} catch (error) {
		if (errnoOf(error) === 'ENOENT') return null;
		throw error;
	}
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return null;
	}
}

/** The lock's owner, or null when the file is absent, empty or malformed (other errors throw). */
function readOwner(path: string): ComponentLockOwner | null {
	const parsed = readJsonOrNull(path) as ComponentLockOwner | null;
	return typeof parsed?.token === 'string' ? parsed : null;
}

/** A token's heartbeat, or null when it has none (yet / any more) or it is malformed (other errors throw). */
function readBeat(path: string, token: string): ComponentLockBeat | null {
	const parsed = readJsonOrNull(heartbeatPath(path, token)) as ComponentLockBeat | null;
	return typeof parsed?.beat === 'number' ? parsed : null;
}

/** The OWNER's read of its own heartbeat: a read error is logged and counts as none. */
function ownBeatOrNull(handle: ComponentLockHandle): ComponentLockBeat | null {
	try {
		return readBeat(handle.path, handle.token);
	} catch (error) {
		console.error(
			`[media lock] reading own heartbeat of ${handle.key} failed: ${errorText(error)}`,
		);
		return null;
	}
}

/** inode:mtime:size of a file, or null when it is gone (other stat errors throw). */
function fileSignature(path: string): string | null {
	try {
		const stat = statSync(path);
		return `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
	} catch (error) {
		if (errnoOf(error) === 'ENOENT') return null;
		throw error;
	}
}

/** The inode of a file (the CAS compares the peek with the aside by it). */
function inodeOf(path: string): number {
	return statSync(path).ino;
}

/** An error's errno, or its message — for the log lines. */
function errorText(error: unknown): string {
	return errnoOf(error) ?? (error as Error).message;
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
	observeAs: string = path,
): string | null {
	if (owner === null) return unreadableStaleReason(path, context);
	const local = owner.host === HOST_ID ? localStaleReason(owner) : undefined;
	return local !== undefined ? local : heartbeatStaleReason(owner, path, context, observeAs);
}

/** An empty / malformed lock: stale once SEEN unchanged for the bound. */
function unreadableStaleReason(path: string, context: ComponentLockContext): string | null {
	const signature = fileSignature(path);
	if (signature === null) return 'gone';
	const age = unchangedForMs(context, path, `unreadable:${signature}`);
	return age > context.staleAfterMs ? `unreadable and unchanged for ${age} ms` : null;
}

/**
 * Any other holder: stale once its heartbeat is SEEN unchanged for the bound.
 * `observeAs` keys the sighting (a share registration is observed under its own
 * name, so judging it never resets the count of the lock now at `path`).
 */
function heartbeatStaleReason(
	owner: ComponentLockOwner,
	path: string,
	context: ComponentLockContext,
	observeAs: string,
): string | null {
	const beat = readBeat(path, owner.token);
	const age = unchangedForMs(context, observeAs, `${owner.token}:${beat?.beat ?? 'none'}`);
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

/** What a CAS removal found at the path. */
type AsideOutcome =
	| { readonly status: 'taken'; readonly owner: ComponentLockOwner | null }
	| { readonly status: 'absent' }
	| { readonly status: 'kept' };

/**
 * Remove whatever stands at `path` only when `isExpected` says it is the file
 * the caller meant (CAS) — WITHOUT ever vacating the path for the check: the
 * file is hard-linked to a peek name and the PEEK is judged; a file that is not
 * the expected one is never moved ('kept'). An expected one is renamed aside
 * and dropped only when the aside is the very inode the peek checked; a path
 * replaced in between is put back (see the header).
 */
function takeAsideIf(
	path: string,
	verb: string,
	isExpected: (owner: ComponentLockOwner | null, peek: string) => boolean,
	hooks?: ComponentLockRaceHooks,
): AsideOutcome {
	const peek = asideOf(path, `${verb}-peek`);
	try {
		linkSync(path, peek);
	} catch (error) {
		if (errnoOf(error) === 'ENOENT') return { status: 'absent' };
		throw error;
	}
	try {
		hooks?.between?.();
		const owner = readOwner(peek);
		if (!isExpected(owner, peek)) return { status: 'kept' };
		hooks?.beforeRename?.();
		return removeIfSameInode(path, peek, verb, owner);
	} finally {
		unlinkQuiet(peek);
	}
}

/** The second half of the CAS: rename aside, keep it only if it is the peek's inode. */
function removeIfSameInode(
	path: string,
	peek: string,
	verb: string,
	owner: ComponentLockOwner | null,
): AsideOutcome {
	const aside = asideOf(path, verb);
	try {
		renameSync(path, aside);
	} catch (error) {
		if (errnoOf(error) === 'ENOENT') return { status: 'absent' };
		throw error;
	}
	if (inodeOf(aside) === inodeOf(peek)) {
		unlinkQuiet(aside);
		return { status: 'taken', owner };
	}
	restoreAside(aside, path, `${verb} of ${path}`);
	return { status: 'kept' };
}

/** Who held a lock, for the reclaim log line. */
function describeOwner(owner: ComponentLockOwner | null, path: string): string {
	if (owner === null) return 'unreadable';
	let holder = '?';
	try {
		holder = readBeat(path, owner.token)?.holder ?? '?';
	} catch {
		// the log line only — an unreadable heartbeat names no holder
	}
	return `${owner.host}:${owner.pid}/${owner.instance} ${holder}`;
}

/**
 * Under the reclaim mutex: RE-JUDGE the lock (it may have come alive since the
 * first look), then remove it by CAS — verified to be the very lock judged
 * stale (same token, or for an unreadable lock the same inode/mtime) — and drop
 * its heartbeat. True when the path is now VACANT (the caller then creates its
 * own lock, or — a per-lang holder clearing a dead whole-component lock — asks
 * again).
 */
function vacateIfStale(path: string, key: string, context: ComponentLockContext): boolean {
	const judged = readOwner(path);
	const judgedSignature = judged === null ? fileSignature(path) : null;
	const reason = existsSync(path) ? staleReason(judged, path, context) : 'gone';
	if (reason === null) return false;
	const taken = takeAsideIf(path, 'reclaim', (current, peek) =>
		isJudgedLock(judged, judgedSignature, current, peek),
	);
	if (taken.status === 'kept') return false;
	if (taken.status === 'taken') dropReclaimed(taken.owner, path, `${key} (${reason})`);
	context.observations.delete(path);
	return true;
}

/** Is the peeked lock the very one judged stale? (Token, or inode/mtime/size when malformed.) */
function isJudgedLock(
	judged: ComponentLockOwner | null,
	judgedSignature: string | null,
	current: ComponentLockOwner | null,
	peek: string,
): boolean {
	if (judged !== null) return current?.token === judged.token;
	return current === null && fileSignature(peek) === judgedSignature;
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
 * unchanged for the bound — by the peek-verified CAS on its inode/mtime/size
 * (a mutex re-created meanwhile is never touched).
 */
function clearStaleMutex(mutex: string, context: ComponentLockContext): void {
	const signature = fileSignature(mutex);
	if (signature === null) return;
	if (unchangedForMs(context, mutex, `mutex:${signature}`) <= context.staleAfterMs) return;
	takeAsideIf(mutex, 'unmutex', (_owner, peek) => fileSignature(peek) === signature);
	context.observations.delete(mutex);
}

/**
 * Run `fn` under the reclaim mutex of `path` (`<lock>.reclaim`, O_EXCL — one
 * reclaimer at a time). A mutex left by a crash is cleared so the NEXT attempt
 * can proceed; this attempt answers false (busy).
 */
function underReclaimMutex(
	path: string,
	mark: string,
	context: ComponentLockContext,
	fn: () => boolean,
): boolean {
	const mutex = `${path}${RECLAIM_SUFFIX}`;
	if (!writeExclusive(mutex, mark)) {
		clearStaleMutex(mutex, context);
		return false;
	}
	try {
		return fn();
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
 * Reclaim the lock at `path` when it is stale: vacate it (under the mutex, by
 * CAS) and run `then` — create our own lock, or ask again. A lock this instance
 * CANNOT READ (any errno but ENOENT) is never judged stale: it answers BUSY and
 * says why — reclaiming what cannot be read is how two holders happen (see the
 * header).
 */
function reclaimIfStale(
	path: string,
	key: string,
	mark: string,
	context: ComponentLockContext,
	then: () => boolean,
): boolean {
	try {
		return (
			staleReason(readOwner(path), path, context) !== null &&
			underReclaimMutex(path, mark, context, () => vacateIfStale(path, key, context) && then())
		);
	} catch (error) {
		if (error instanceof DedaloError) throw error;
		console.error(
			`[media lock] ${key}: the lock at ${path} cannot be read (${errorText(error)}) — treated as BUSY, never reclaimed`,
		);
		return false;
	}
}

/**
 * Remove a held lock's ORPHANED siblings: every `<lock>.*` file this reader has
 * SEEN unchanged for the bound (a crashed holder's heartbeat, temp, staged,
 * peek or aside file, a mutex whose lock is gone). The new holder's own files
 * are never at risk: their names carry a fresh token, so this is their first
 * sighting. Never throws — a sweep that fails is logged, the hold stands.
 */
function sweepOrphans(path: string, context: ComponentLockContext): void {
	const prefix = `${path}.`;
	let siblings: string[];
	try {
		siblings = readdirSync(context.dir)
			.map((name) => join(context.dir, name))
			.filter((sibling) => sibling.startsWith(prefix));
		for (const sibling of siblings) sweepIfUnchanged(sibling, context);
	} catch (error) {
		console.error(`[media lock] sweeping orphans of ${path} failed: ${errorText(error)}`);
		return;
	}
	forgetUnseen(
		context,
		`orphan:${prefix}`,
		new Set(siblings.map((sibling) => `orphan:${sibling}`)),
	);
}

/** Drop the reader's sightings under `keyPrefix` that are no longer present (a bounded map). */
function forgetUnseen(
	context: ComponentLockContext,
	keyPrefix: string,
	present: Set<string>,
): void {
	for (const key of [...context.observations.keys()]) {
		if (key.startsWith(keyPrefix) && !present.has(key)) context.observations.delete(key);
	}
}

/** Unlink one sibling once SEEN unchanged for the bound (re-stat right before: a changed one stays). */
function sweepIfUnchanged(sibling: string, context: ComponentLockContext): void {
	const signature = fileSignature(sibling);
	if (signature === null) return;
	const key = `orphan:${sibling}`;
	if (unchangedForMs(context, key, signature) <= context.staleAfterMs) return;
	if (fileSignature(sibling) !== signature) return;
	unlinkQuiet(sibling);
	context.observations.delete(key);
	console.error(`[media lock] swept orphan ${sibling} (unchanged for the bound)`);
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
		makeLockDir(context.dir, true);
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
			reclaimIfStale(path, key, owner.token, context, () => createLock(path, owner, holder));
		if (!ours) return null;
		PROCESS_HELD_TOKENS.add(owner.token);
		sweepOrphans(path, context);
		return { path, key, token: owner.token, holder };
	});
}

/** Is the component held by a LIVE holder (any instance)? A question (it records a sighting). */
export function componentLockBusy(key: string, context: ComponentLockContext): boolean {
	return typed('probe', key, () => {
		const path = join(context.dir, componentLockFileName(key));
		if (!existsSync(path)) return false;
		try {
			return staleReason(readOwner(path), path, context) === null;
		} catch (error) {
			console.error(
				`[media lock] ${key}: the lock at ${path} cannot be read (${errorText(error)}) — answered BUSY`,
			);
			return true;
		}
	});
}

/** Attempts of each share step before it answers busy (a step only repeats on a server-side change). */
const SHARE_ATTEMPTS = 3;
/** The pause before a per-lang holder asks again when ANOTHER per-lang holder's probe stands at the path. */
const PROBE_RETRY_MS = 2;

/** The share dir of a component (`<section>|<id>|<component>`): its per-lang holders' registrations. */
export function componentShareDir(dir: string, componentKey: string): string {
	return join(dir, `${escapeLockKey(componentKey)}${SHARE_SUFFIX}`);
}

/**
 * A PER-LANG holder (its own lock already published) joins its component's
 * share: REGISTER (a hard link of its lock in the share dir), then — the seam
 * between publish and look — PROBE the whole-component lock by `link()`ing its
 * own lock onto that exact name. The server answers EEXIST when a
 * whole-component holder stands there: the registration is withdrawn and the
 * answer is null (refused). Linked, nobody did: the probe is withdrawn by CAS
 * and the handle comes back with its share. Every deciding answer is the
 * server's own (see the header: SHARED COMPONENTS).
 */
export function joinComponentShare(
	handle: ComponentLockHandle,
	componentKey: string,
	wholeKey: string,
	context: ComponentLockContext,
): ComponentLockHandle | null {
	return typed('share', handle.key, () => {
		const share = registerInShare(handle, componentShareDir(context.dir, componentKey));
		if (share === null) return null;
		let joined = false;
		try {
			context.shareHooks?.afterPublish?.('lang', handle.key);
			joined = probeWholeAbsent(handle, wholeKey, context);
		} finally {
			if (!joined) leaveShare(share);
		}
		return joined ? { ...handle, share } : null;
	});
}

/**
 * Register `handle` in the share dir: `link(lock, <dir>/<lock name>.<token>)`.
 * ENOENT (or ESTALE) — the dir is gone (a whole-component holder removed it,
 * or none was ever made): make it and ask again. Null after the attempts (the
 * dir kept vanishing — logged, busy).
 */
function registerInShare(handle: ComponentLockHandle, dir: string): ComponentShare | null {
	const share = { dir, entry: join(dir, `${basename(handle.path)}.${handle.token}`) };
	for (let attempt = 0; attempt < SHARE_ATTEMPTS; attempt++) {
		if (linkUnlessDirGone(handle.path, share.entry)) return share;
		makeLockDir(dir, false);
	}
	console.error(
		`[media lock] ${handle.key}: could not register in ${dir} (it kept vanishing) — answered BUSY`,
	);
	return null;
}

/** link(from, to); false when the target dir (or the source) is gone, any other failure throws. */
function linkUnlessDirGone(from: string, to: string): boolean {
	try {
		linkSync(from, to);
		return true;
	} catch (error) {
		const code = errnoOf(error);
		if (code === 'ENOENT' || code === 'ESTALE') return false;
		throw error;
	}
}

/**
 * mkdir the locks dir (`recursive`) or a share dir — the ONE place a lock dir
 * gets its mode (owner + group: several instances' users share the group) —
 * tolerating one that already exists.
 */
function makeLockDir(dir: string, recursive: boolean): void {
	try {
		mkdirSync(dir, { recursive, mode: 0o750 });
	} catch (error) {
		if (errnoOf(error) !== 'EEXIST') throw error;
	}
}

/**
 * Is the whole-component lock ABSENT at the server? Asked by `link()`ing our
 * own lock onto its name — never by a lookup. EEXIST: a dead whole-component
 * holder is reclaimed and the question asked again; another per-lang holder's
 * in-flight probe is waited out briefly; a live whole-component holder (or a
 * lock that cannot be read) answers false.
 */
function probeWholeAbsent(
	handle: ComponentLockHandle,
	wholeKey: string,
	context: ComponentLockContext,
): boolean {
	const wholePath = join(context.dir, componentLockFileName(wholeKey));
	for (let attempt = 0; attempt < SHARE_ATTEMPTS; attempt++) {
		if (linkProbe(handle.path, wholePath)) {
			withdrawProbe(handle, wholePath);
			return true;
		}
		if (reclaimIfStale(wholePath, wholeKey, handle.token, context, () => true)) continue;
		if (!isProbeOfAnother(wholePath, wholeKey)) return false;
		Bun.sleepSync(PROBE_RETRY_MS);
	}
	return false;
}

/**
 * link(our lock, the whole-component name): true when linked (the name was
 * free AT THE SERVER), false on EEXIST. Anything else throws — our own lock
 * gone included (reclaimed: we hold nothing to probe with).
 */
function linkProbe(ours: string, wholePath: string): boolean {
	try {
		linkSync(ours, wholePath);
		return true;
	} catch (error) {
		if (errnoOf(error) === 'EEXIST') return false;
		throw error;
	}
}

/** Take our probe back off the whole-component name — by CAS: only a link of OUR lock is removed. */
function withdrawProbe(handle: ComponentLockHandle, wholePath: string): void {
	const taken = takeAsideIf(wholePath, 'probe', (owner) => owner?.token === handle.token);
	if (taken.status !== 'taken') {
		console.error(
			`[media lock] ${handle.key}: the probe at ${wholePath} was not ours to withdraw (${taken.status})`,
		);
	}
}

/** Does the whole-component name hold ANOTHER per-lang holder's probe (a lock of another key)? */
function isProbeOfAnother(wholePath: string, wholeKey: string): boolean {
	try {
		const owner = readOwner(wholePath);
		return owner !== null && owner.key !== wholeKey;
	} catch {
		return false;
	}
}

/**
 * Leave the share: drop our registration, and the dir when it is now empty.
 * NEVER throws — it runs first in a release, and a release must still give the
 * lock back; a registration left behind (logged) is judged dead by the usual
 * rules once its holder's token is gone.
 */
function leaveShare(share: ComponentShare): void {
	try {
		unlinkQuiet(share.entry);
		removeShareDirIfEmpty(share.dir);
	} catch (error) {
		console.error(`[media lock] leaving ${share.entry} failed: ${errorText(error)}`);
	}
}

/**
 * rmdir the share dir: TRUE when the server removed it (empty) or it was never
 * there — no per-lang holder is registered; false when it is not empty. The
 * answer is the server's (ENOTEMPTY), never a listing's.
 */
function removeShareDirIfEmpty(dir: string): boolean {
	try {
		rmdirSync(dir);
		return true;
	} catch (error) {
		const code = errnoOf(error);
		if (code === 'ENOENT') return true;
		if (code === 'ENOTEMPTY' || code === 'EEXIST') return false;
		throw error;
	}
}

/**
 * The WHOLE-component holder's look (its own lock already published — the seam
 * runs first): is the component's share EMPTY at the server? `rmdir` of the
 * share dir answers it — removed (or absent): no per-lang holder is registered,
 * and none can register without meeting the published whole-component lock.
 * ENOTEMPTY: the registrations are judged (the listing is only used to JUDGE,
 * never to decide vacancy) — dead ones dropped and the server asked again; a
 * live or unreadable one answers false.
 */
export function componentShareVacant(componentKey: string, context: ComponentLockContext): boolean {
	return typed('share', componentKey, () => {
		context.shareHooks?.afterPublish?.('whole', componentKey);
		const dir = componentShareDir(context.dir, componentKey);
		for (let attempt = 0; attempt < SHARE_ATTEMPTS; attempt++) {
			if (removeShareDirIfEmpty(dir)) return true;
			if (!dropDeadRegistrations(dir, context)) return false;
		}
		return false;
	});
}

/** Judge every listed registration: false at the first live (or unreadable) one; dead ones are dropped. */
function dropDeadRegistrations(dir: string, context: ComponentLockContext): boolean {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch (error) {
		if (errnoOf(error) === 'ENOENT') return true;
		throw error;
	}
	return names.every((name) => dropIfDead(join(dir, name), context));
}

/**
 * One registration: a hard link of a per-lang holder's lock, so its content is
 * that holder's identity, judged like its lock (same pid / heartbeat rules,
 * observed under the registration's own name). Dead: unlinked (logged), true.
 */
function dropIfDead(entry: string, context: ComponentLockContext): boolean {
	let reason: string | null;
	try {
		const owner = readOwner(entry);
		const lockPath = owner === null ? entry : join(context.dir, componentLockFileName(owner.key));
		reason = staleReason(owner, lockPath, context, entry);
	} catch (error) {
		console.error(
			`[media lock] registration ${entry} cannot be read (${errorText(error)}) — answered BUSY`,
		);
		return false;
	}
	if (reason === null) return false;
	unlinkQuiet(entry);
	context.observations.delete(entry);
	if (reason !== 'gone')
		console.error(`[media lock] dropped dead registration ${entry} (${reason})`);
	return true;
}

/** How many times the holder re-reads its own lock before a read error is final. */
const OWN_READ_ATTEMPTS = 3;

/**
 * Is `handle`'s lock still the one on disk? (The holder's pre-publication and
 * heartbeat check.) Only a lock that is READ and carries another token — or is
 * absent — answers false (LOST). A read error is retried; one that persists
 * THROWS (typed `media.operation_failed`): the caller refuses to publish, but
 * never concludes the hold was lost because a read failed.
 */
export function componentLockIsOurs(handle: ComponentLockHandle): boolean {
	let lastError: unknown;
	for (let attempt = 0; attempt < OWN_READ_ATTEMPTS; attempt++) {
		try {
			return readOwner(handle.path)?.token === handle.token;
		} catch (error) {
			lastError = error;
		}
	}
	throw lockFailure('own-check', handle.key, lastError);
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
			if (handle.share !== undefined) leaveShare(handle.share);
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
		typed('abandon', handle.key, () => {
			if (handle.share !== undefined) leaveShare(handle.share);
			unlinkQuiet(heartbeatPath(handle.path, handle.token));
		});
	} finally {
		PROCESS_HELD_TOKENS.delete(handle.token);
	}
}

/**
 * The heartbeat's own-lock question: false only when the lock is READ and is
 * not ours (LOST). A lock that cannot be read even after the retries is logged
 * and treated as still ours for this tick — the beat goes into OUR heartbeat
 * file (which nobody else reads if the lock was taken), and the next tick asks
 * again.
 */
function ownLockOrUnknown(handle: ComponentLockHandle): boolean {
	try {
		return componentLockIsOurs(handle);
	} catch (error) {
		console.error(
			`[media lock] heartbeat of ${handle.key}: own lock unreadable (${errorText((error as DedaloError).cause ?? error)}) — beating, re-checked next tick`,
		);
		return true;
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
		if (!ownLockOrUnknown(handle)) return false;
		hooks?.between?.();
		const previous = ownBeatOrNull(handle);
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
		if (!ownLockOrUnknown(handle)) return;
		const previous = ownBeatOrNull(handle);
		writeBeat(handle.path, handle.token, { beat: (previous?.beat ?? 0) + 1, holder });
	});
	return relabelled;
}

/** The current holder named by a lock's heartbeat (operators, gates). */
export function componentLockHolder(path: string): string | null {
	const owner = readOwner(path);
	return owner === null ? null : (readBeat(path, owner.token)?.holder ?? null);
}
