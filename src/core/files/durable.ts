/**
 * THE DURABILITY KERNEL: what a writer must do before it may tell a
 * WAL-durable record (a run ledger, a checkpoint, a "completed" job row) that
 * a file effect happened.
 *
 * A rename makes a write ATOMIC, not DURABLE. After a power cut (or a kernel
 * crash, never a process kill: the page cache outlives the process) a file
 * keeps only what was forced to disk:
 *
 *   - its BYTES are durable once the file is fsynced after its last write;
 *   - a DIRECTORY ENTRY (a creation, a rename, an unlink, a mkdir) is durable
 *     once its directory is fsynced after the change.
 *
 * So the durable publication of a file is: write a temp sibling, fsync it,
 * rename it over the final path, fsync the directory. Directory fsyncs batch:
 * a writer landing N files in one directory fsyncs each file but the directory
 * ONCE, through a DirectoryBarrier it flushes before it reports the batch.
 *
 * Synchronous node:fs calls on numeric descriptors, by design: every byte a
 * call returned for is in the OS, nothing rides a FileHandle a dying process
 * could leave to the garbage collector, and one I/O shape is what the
 * durability gate's power-cut model observes (test/helpers/power_loss_model.ts).
 *
 * A neutral kernel (no subsystem's vocabulary): the diffusion writers
 * (src/diffusion/writers/files.ts) and the core files-unlink door
 * (src/core/diffusion_bridge/diffusion_delete.ts) import it, and so do the
 * atomic JSON state-file kernel (src/core/files/atomic_json.ts) and the backup
 * module (src/core/area_maintenance/backup.ts: its promotions' directory
 * fsyncs and its `.verified` proof sidecars — it kept private copies of these
 * helpers until 2026-10-21, one of which never fsynced the directory), the
 * installer's `.env` writer, its `--abort` restore and removals
 * (src/core/install/config_persist.ts, steps.ts, executor.ts), and — through
 * directoryFsyncUnsupported only, its own I/O being async — the boot's client
 * publisher (src/core/install/client_publish.ts).
 *
 * THE ONE DOOR. On a module the server reaches, a descriptor write or flush
 * (`writeSync`/`fsyncSync`/…) is in the sync-I/O gate's forbidden class
 * (test/unit/sync_io_on_request_path_tripwire.test.ts): this kernel is where
 * such calls belong, and every other module that still makes one is a ledgered,
 * reasoned exception there. Its own exported sync doors are in that class too
 * (derived from this file's exports): a caller pays the device time it asks
 * for, so a reachable caller is ledgered there with its own reason.
 */

import {
	closeSync,
	fsyncSync,
	mkdirSync,
	openSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { tempPathFor } from './temp_path.ts';

/**
 * The error codes of a filesystem that does not implement a directory fsync
 * (some network and FUSE filesystems). There the guarantee is not available —
 * said loudly, never a failed write: the data is as durable as that
 * filesystem can make it.
 */
const DIRECTORY_FSYNC_UNSUPPORTED: ReadonlySet<string> = new Set([
	'EINVAL',
	'ENOTSUP',
	'EOPNOTSUPP',
]);

/**
 * True when `error` is a filesystem refusing a DIRECTORY fsync (it has no such
 * guarantee to give). Logs the loud line; the caller swallows it. Exported for
 * the one async writer (core/install/client_publish.ts, whose boot step must
 * not block the event loop) so the two doors share ONE definition of "unsupported".
 */
export function directoryFsyncUnsupported(dir: string, error: unknown): boolean {
	const code = (error as { code?: unknown } | null)?.code;
	if (typeof code !== 'string' || !DIRECTORY_FSYNC_UNSUPPORTED.has(code)) return false;
	console.warn(
		`[durable] the filesystem of '${dir}' refuses a directory fsync (${code}) — renames and unlinks in it are not power-cut durable`,
	);
	return true;
}

/** fsync a DIRECTORY: the entries created, renamed or unlinked in it survive a power cut. */
export function fsyncDirectory(dir: string): void {
	const fd = openSync(dir, 'r');
	try {
		fsyncSync(fd);
	} catch (error) {
		if (!directoryFsyncUnsupported(dir, error)) throw error;
	} finally {
		closeSync(fd);
	}
}

/** fsync a FILE by path (its bytes, however they were written, reach the disk). */
export function fsyncFile(path: string): void {
	const fd = openSync(path, 'r');
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

/**
 * Durably and atomically replace `target` with `bytes`: a sibling temp file
 * (tempPathFor, created 'wx' at `mode`, never following or truncating anything
 * already there) → every byte → fsync → rename over `target` → the directory
 * fsync (now, or at `barrier`'s flush). A reader sees the old bytes or the new,
 * never a torn mix; after it returns (or after the barrier flushed) the new
 * bytes and their NAME survive a power cut. A failure removes the temp and
 * propagates.
 */
export function writeFileDurably(
	target: string,
	bytes: Uint8Array | string,
	options: { mode?: number; barrier?: DirectoryBarrier } = {},
): void {
	const payload = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
	const temp = tempPathFor(target);
	// 'wx' refuses a name that exists: what it refuses is not ours to remove.
	const fd = openSync(temp, 'wx', options.mode ?? 0o600);
	try {
		try {
			writeAllSync(fd, payload);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(temp, target);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
	if (options.barrier !== undefined) options.barrier.add(dirname(target));
	else fsyncDirectory(dirname(target));
}

/** Write every byte of `bytes` to `fd` (a short write is continued, never dropped). */
export function writeAllSync(fd: number, bytes: Uint8Array): void {
	let offset = 0;
	while (offset < bytes.byteLength) {
		offset += writeSync(fd, bytes, offset, bytes.byteLength - offset);
	}
}

/**
 * Directories whose entries changed and are not durable yet. A writer adds
 * the directory of every file it renamed in or unlinked, and flushes ONCE
 * before it reports the batch — one directory fsync per batch, not per file.
 */
export class DirectoryBarrier {
	private readonly dirs = new Set<string>();

	add(dir: string): void {
		this.dirs.add(dir);
	}

	/** fsync every pending directory; the barrier is empty after. */
	flush(): void {
		for (const dir of [...this.dirs]) {
			fsyncDirectory(dir);
			this.dirs.delete(dir);
		}
	}
}

/**
 * Unlink `path` so its ABSENCE survives a power cut: the unlink, then its directory
 * fsynced — now, or at `barrier`'s flush. An absent path is not an error (nothing to
 * remove, nothing to sync); any other failure propagates. Answers whether it removed
 * a file. A file whose secrets an undo takes back (`--abort`'s `.env`, its backups and
 * staged copies) or a run record whose removal reports an outcome uses this door —
 * after a cut, an unlink no fsync covered can bring the file back.
 */
export function removeFileDurably(path: string, barrier?: DirectoryBarrier): boolean {
	try {
		unlinkSync(path);
	} catch (error) {
		if ((error as { code?: unknown } | null)?.code === 'ENOENT') return false;
		throw error;
	}
	if (barrier !== undefined) barrier.add(dirname(path));
	else fsyncDirectory(dirname(path));
	return true;
}

/**
 * mkdir -p whose NEW levels survive a power cut: each created level's entry
 * lives in its parent, so every parent of a created level is fsynced — now, or
 * at `barrier`'s flush. Nothing created ⇒ nothing to sync.
 */
export function mkdirDurably(dir: string, barrier?: DirectoryBarrier): void {
	syncCreatedLevels(dir, mkdirSync(dir, { recursive: true }), barrier);
}

/**
 * The durability half of mkdirDurably, for a caller that makes its OWN
 * `mkdirSync(dir, { recursive: true, … })` (a deliberate mode it states where
 * the directory-mode census reads it — core/install/config_persist.ts's 0700
 * private dir): `first` is what that call returned, the first level it
 * created (undefined: nothing was created, nothing to sync).
 */
export function syncCreatedLevels(
	dir: string,
	first: string | undefined,
	barrier?: DirectoryBarrier,
): void {
	if (first === undefined) return;
	const stop = dirname(resolve(first));
	for (
		let level = resolve(dir);
		level !== stop && level !== dirname(level);
		level = dirname(level)
	) {
		const parent = dirname(level);
		if (barrier !== undefined) barrier.add(parent);
		else fsyncDirectory(parent);
	}
}
