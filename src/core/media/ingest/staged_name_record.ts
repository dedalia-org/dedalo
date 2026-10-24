/**
 * THE SERVER'S RECORD OF WHAT A STAGED FILE WAS CALLED.
 *
 * A staged upload has TWO names and they are not interchangeable:
 *
 *   • the STAGED name — `stagedTmpName` + `claimStagedName`: sanitized down to
 *     `[A-Za-z0-9_.-]` and collision-suffixed, because it becomes a filesystem
 *     segment. Lossy and not injective by construction.
 *   • the DISPLAY name — `displayFileName`: 'María Piñón.jpg', defanged but never
 *     transliterated, because it is PROVENANCE. It is the only surviving record
 *     of what the curator delivered, since the file itself is renamed to a
 *     deterministic identifier the moment it is ingested.
 *
 * The receiver knows both. The INGEST, which runs in a later request (the client
 * posts the bytes, then calls `tool_upload::process_uploaded_file` /
 * `tool_import_files` / the MCP media tool), used to be handed only the staged
 * one — so the display name existed for exactly as long as the upload response,
 * and the archive recorded `Mar_a_Pi_n.jpg` (audit 2026-08 §5.2).
 *
 * Relaying it back through the client does not fix that: it makes the recorded
 * provenance re-decidable by a later request, and it only works for callers that
 * cooperate — as of 2026-08-09 none of the three ingest callers did, which is why
 * the first restoration attempt was wired at the transport and dead in
 * production. So the name is PERSISTED BESIDE THE STAGED FILE by the receiver
 * and read back by the ingest, exactly as `meta.json` already carries a chunked
 * transfer's name across its own request boundary — the law stated in
 * `WC-2026-08-03-chunked-upload-identity`: the name on disk must not be
 * re-decidable by a later request.
 *
 * SHAPE. One file per staged name under `<staging dir>/.names/<staged name>`,
 * containing the display name as UTF-8 and nothing else. A directory (not a
 * shared index) so two concurrent uploads into one key_dir never write the same
 * file; dot-prefixed so `listStagedFiles` skips it and `resolveStagedPath`
 * cannot address it (it accepts `<key_dir>[/thumbnail]/<name>` and nothing else).
 *
 * LIFECYCLE. Written at the moment the staged name is claimed (both doors:
 * single-shot and the chunked join), consumed by the ingest when the file leaves
 * staging, dropped with the file by `deleteStagedFile`, and swept by
 * `staging_gc.ts` when its file is gone and it is older than the retention
 * window. It never outlives the file it describes.
 */

import {
	closeSync,
	constants,
	existsSync,
	fstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { resolve, sep } from 'node:path';
import { DedaloError } from '../../errors/dedalo_error.ts';
import { MEDIA_DIR_MODE } from '../../install/media_tree.ts';
import { writeAtomicallySync } from '../atomic.ts';
import { sanitizeSegment } from './add_file.ts';

/** Subdirectory (inside a key_dir) holding the display-name records. */
export const STAGED_NAME_DIR = '.names';

/**
 * Ceiling on a record's size. `displayFileName` caps at 255 characters and UTF-8
 * costs at most 4 bytes each, so 1 KiB is well past any legitimate value: a
 * bigger file is not a name and is refused rather than parsed.
 */
const MAX_RECORD_BYTES = 1024;

/**
 * Absolute path of one staged file's display-name record, confined to the
 * key_dir. `stagingDirPath` is passed in (rather than rebuilt from userId +
 * keyDir) so this module has no opinion about addressing: every caller already
 * holds the confined staging dir, and taking it here keeps the ONE staging-path
 * chokepoint in add_file.ts.
 */
function recordPath(stagingDirPath: string, stagedName: string): string {
	// The staged name is server-allocated, but it reaches the ingest through a
	// client-relayed `file_data.tmp_name`, so it is validated here too (fail-closed
	// on '', '.', '..', NUL, '/' and anything outside [A-Za-z0-9_.-]).
	const safe = sanitizeSegment(stagedName);
	const dir = resolve(stagingDirPath, STAGED_NAME_DIR);
	const full = resolve(dir, safe);
	if (!full.startsWith(dir + sep)) {
		throw new DedaloError('media.invalid_path', {
			message: 'staged name record escapes the staging dir',
			coordinates: { path: full },
		});
	}
	return full;
}

/**
 * Record the DISPLAY name of a staged file. Called by the receiver at the moment
 * the staged name is claimed, on BOTH completion paths.
 *
 * BEST EFFORT BY CONTRACT, and that is a deliberate choice rather than a
 * swallowed error: by the time this runs the bytes are verified and claimed under
 * their final staged name, so throwing would report a failure for an upload that
 * fully succeeded and would strand the file. A failure here degrades the ingest
 * to the previous (lossy) behaviour — the staged name — and says so in the log.
 */
export function recordStagedDisplayName(
	stagingDirPath: string,
	stagedName: string,
	displayName: string,
): void {
	try {
		const path = recordPath(stagingDirPath, stagedName);
		// Created here rather than left to the atomic writer's `ensureDir` (0o775):
		// this sits inside a per-user staging dir and takes the same mode as every
		// other directory under the media root. MEDIA_DIR_MODE, never a literal —
		// the mode census (test/unit/media_tree_provision_native.test.ts) is what
		// keeps the tree from drifting back to mixed 0775/0750 permissions.
		const dir = resolve(stagingDirPath, STAGED_NAME_DIR);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: MEDIA_DIR_MODE });
		// Through the ONE atomic writer (media/atomic.ts): the ingest may read this
		// while a re-upload rewrites it, and a half-written provenance value must be
		// unobservable. Its `finally` is also what guarantees a failed write leaves
		// no scratch behind in the staging dir the user's queue lists.
		writeAtomicallySync(path, (temporary) => {
			writeFileSync(temporary, displayName, { mode: 0o640 });
		});
	} catch (error) {
		console.warn(
			`[staged_name_record] could not record the display name of '${stagedName}': ${
				(error as Error).message
			} — the ingest will fall back to the staged name`,
		);
	}
}

/**
 * The display name the server recorded for a staged file, or null when it has no
 * record of one (a file placed in the staging area out of band, a transfer staged
 * by a server older than 2026-08-09, or a record this process refused to trust).
 *
 * Returns null rather than throwing for every one of those: "no record" is an
 * ordinary state with a defined fallback (the staged name), not a caller bug.
 */
export function readStagedDisplayName(stagingDirPath: string, stagedName: string): string | null {
	let path: string;
	try {
		path = recordPath(stagingDirPath, stagedName);
	} catch {
		return null;
	}
	// ONE open (CodeQL #8089): the size bound and the read apply to the SAME
	// inode. A path-based stat then a path-based read could size one file and read
	// another a concurrent re-upload renamed in between — and the read itself is
	// bounded to MAX_RECORD_BYTES whatever the file grew to after the fstat.
	let fd: number;
	try {
		// O_NONBLOCK: a FIFO planted at the record path must not hang the open (the
		// fstat below then refuses it as not-a-file), as the old stat-first order did.
		fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
	} catch {
		return null; // absent (the ordinary "no record" case) or unreadable
	}
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size === 0) return null;
		if (stat.size > MAX_RECORD_BYTES) {
			console.warn(
				`[staged_name_record] record for '${stagedName}' is ${stat.size} bytes — refused`,
			);
			return null;
		}
		const buffer = Buffer.alloc(stat.size);
		let filled = 0;
		while (filled < buffer.length) {
			const read = readSync(fd, buffer, filled, buffer.length - filled, filled);
			if (read === 0) break;
			filled += read;
		}
		const value = buffer.subarray(0, filled).toString('utf8').trim();
		return value === '' ? null : value;
	} catch {
		return null;
	} finally {
		closeSync(fd);
	}
}

/**
 * Drop the record of a staged file. Called when the file leaves staging — either
 * consumed by the ingest or deleted by the user — so a record never outlives what
 * it describes. Best effort, for the same reason as the write.
 */
export function forgetStagedDisplayName(stagingDirPath: string, stagedName: string): void {
	try {
		rmSync(recordPath(stagingDirPath, stagedName), { force: true });
	} catch {
		// A malformed name has no record to drop; a removal failure is collected by
		// pruneOrphanStagedNames below.
	}
}

/**
 * Collect records whose staged file is GONE and that have been untouched for
 * `ttlMs` — the backstop for a file removed by something that did not go through
 * `deleteStagedFile` (an operator with a shell, an interrupted ingest).
 *
 * The age condition is what makes it safe: a record is written a moment BEFORE
 * the file it describes exists in one ordering of the receiver, so pruning
 * purely on "no such file" could delete a live record in that window. Returns how
 * many were removed.
 */
export function pruneOrphanStagedNames(stagingDirPath: string, now: number, ttlMs: number): number {
	const dir = resolve(stagingDirPath, STAGED_NAME_DIR);
	if (!existsSync(dir)) return 0;
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return 0;
	}
	let removed = 0;
	for (const entry of entries) {
		const full = resolve(dir, entry);
		if (!full.startsWith(dir + sep)) continue;
		// A leftover `.tmp` from an interrupted write is collectable on age alone.
		const isTemporary = entry.endsWith('.tmp');
		if (!isTemporary && existsSync(resolve(stagingDirPath, entry))) continue;
		let age: number;
		try {
			age = now - statSync(full).mtimeMs;
		} catch {
			continue; // unreadable → never collected (the sweeper never guesses)
		}
		if (age <= ttlMs) continue;
		try {
			rmSync(full, { force: true });
			removed++;
		} catch (error) {
			console.warn('[staged_name_record] could not prune', entry, (error as Error).message);
		}
	}
	return removed;
}
