/**
 * BOOT CONFIRMATION of a code update (2026-08-23) — the second half of the
 * sentinel contract that deploy/dedalo-code-rollback.sh reads.
 *
 * code_update.ts writes `<backupRoot>/last_code_update.json` with
 * `status:"pending"` BEFORE restarting. The systemd rollback path
 * (dedalo-ts.service OnFailure / the watchdog) acts on a sentinel that STAYS
 * pending — so the freshly booted tree must flip it to `"confirmed"` once it
 * is demonstrably alive (listener up + first DB ping green). server.ts calls
 * this at exactly that point.
 *
 * A pending sentinel the running tree does NOT match means either a rollback
 * already happened (we are the OLD tree booting again) or a half-applied swap
 * — both log LOUDLY and leave the sentinel untouched (the rollback script owns
 * it in that state). Never throws: confirmation is a post-boot courtesy, and a
 * broken sentinel must not take the server down.
 *
 * WHAT "MATCHES" MEANS (2026-08-24, dev channel): the INSTALLED ARCHIVE DIGEST,
 * not the version. A dev-channel install swaps a tree whose version is
 * unchanged, so a version comparison confirms the rolled-back OLD tree just as
 * happily as the new one — silently disarming the supervisor-side rollback for
 * exactly the class of build (unreleased branch code) most likely to need it.
 * The digest is per-BYTES, so it separates them. Sentinels written before this
 * (no `installDigest`) still fall back to the version compare: an old pending
 * sentinel must not become unconfirmable across the upgrade that introduces
 * the field.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from '../../config/config.ts';
import { RUNTIME_PATH_CENSUS } from '../install/runtime_paths.ts';
import { INSTALLED_DIGEST } from './install_stamp.ts';
import { pruneRestorePoints } from './restore_points.ts';
import { DEDALO_DATA_VERSION, formatVersion } from './version.ts';

/** The one sentinel shape (flat, machine-written; the rollback script greps it). */
export interface CodeUpdateSentinel {
	version: string;
	previousVersion: string;
	updateMode: string;
	stamp: string;
	backupDir: string;
	/** sha256 of the installed archive — the tree's identity (absent: pre-2026-08-24). */
	installDigest?: string;
	status: 'pending' | 'confirmed' | 'rolled_back';
	rollback_attempted: boolean;
	/**
	 * TRUE when this tree was swapped WITHOUT a verified restore point
	 * (`waive_backup`) — P2-16 / LIFE-06.
	 *
	 * The waiver was already well gated (superuser + maintenance mode, and the
	 * shipped client exposes no control for it). What it had was no MEMORY: the
	 * only record was one `console.warn`, so once journald rotated there was no
	 * durable evidence that an update had proceeded with no backup behind it.
	 * That is the first question an incident asks. Absent on sentinels written
	 * before 2026-08-31, which is why it is optional.
	 */
	backup_waived?: boolean;
}

/**
 * Same resolution as the updater's backupRoot — read THROUGH the census
 * `backup_path` entry (install/runtime_paths.ts), the one authoritative
 * resolver, so this module never constructs its own tree-anchored path.
 */
export function codeUpdateSentinelPath(): string | null {
	const entry = RUNTIME_PATH_CENSUS.find((candidate) => candidate.id === 'backup_path');
	const backupRoot = entry?.resolve() ?? null;
	return backupRoot === null ? null : join(backupRoot, 'last_code_update.json');
}

/**
 * Does the booted tree match what the pending sentinel installed? Digest when
 * the sentinel carries one, version otherwise (legacy sentinels).
 */
function bootedTreeMatches(
	sentinel: CodeUpdateSentinel,
	runningVersion: string,
	runningDigest: string | null,
): boolean {
	return sentinel.installDigest === undefined
		? sentinel.version === runningVersion
		: sentinel.installDigest === runningDigest;
}

/**
 * Confirm (or loudly report) a pending code update. `sentinelPath` /
 * `runningVersion` / `runningDigest` are test seams; production passes nothing.
 *
 * `afterConfirmed` (publication host phase 4, L5) runs ONLY after THIS tree flipped
 * the sentinel — never on a mismatch, an absent or a non-pending sentinel — and a
 * throw from it is logged, never propagated: server.ts passes the detached
 * Publication API push. A restore writes the same pending sentinel, so a restored
 * tree's confirmation fires it too (lockstep both ways).
 */
export async function confirmBootedCodeUpdate(
	sentinelPath: string | null = codeUpdateSentinelPath(),
	runningVersion: string = formatVersion(DEDALO_DATA_VERSION),
	runningDigest: string | null = INSTALLED_DIGEST,
	afterConfirmed: (() => void) | null = null,
): Promise<void> {
	try {
		if (sentinelPath === null || !existsSync(sentinelPath)) return;
		const sentinel = JSON.parse(readFileSync(sentinelPath, 'utf8')) as CodeUpdateSentinel;
		if (sentinel.status !== 'pending') return;
		if (!bootedTreeMatches(sentinel, runningVersion, runningDigest)) {
			reportBootMismatch(sentinel, sentinelPath, runningVersion, runningDigest);
			return;
		}
		await Bun.write(sentinelPath, JSON.stringify({ ...sentinel, status: 'confirmed' }, null, '\t'));
		reportBootConfirmed(runningVersion, runningDigest);
		runAfterConfirmed(afterConfirmed);
		// RETENTION RUNS HERE AND NOWHERE ELSE. Not when the swap happens — until
		// this flip the new tree is unproven and the points behind it are the way
		// back; pruning them at swap time would delete the rollbacks for an update
		// that has not yet shown it can boot. One confirmed boot later, the tree
		// has proven itself and the older copies are just disk.
		// THE SENTINEL'S OWN DIRECTORY IS THE BACKUP ROOT, and passing it is what
		// makes the seam honest. `sentinelPath` is a test seam; retention used to
		// resolve the root itself through resolveCodeBackupRoot(), so a suite
		// pointing this function at a scratch sentinel still pruned the REAL
		// installation's restore points — `bun test` deleting disaster-recovery
		// trees on a developer box (review 2026-08-28, S1). Deriving the root
		// from the path we were handed removes the class of bug rather than
		// asking every caller to remember a second seam: the two can no longer
		// name different disks. codeUpdateSentinelPath() builds it as
		// <backupRoot>/last_code_update.json, so dirname IS the root.
		await pruneConfirmedRestorePoints(sentinel, dirname(sentinelPath));
	} catch (error) {
		console.error('[code update] boot confirmation failed (sentinel unreadable?):', error);
	}
}

/** The booted tree IS what the sentinel installed. */
function reportBootConfirmed(runningVersion: string, runningDigest: string | null): void {
	console.log(
		`[code update] boot CONFIRMED: running ${runningVersion} (installed digest ${runningDigest ?? 'none'}) matches the pending update (sentinel flipped to confirmed)`,
	);
}

/** The post-confirm hook: never throws into the boot path, never undoes the flip. */
function runAfterConfirmed(afterConfirmed: (() => void) | null): void {
	if (afterConfirmed === null) return;
	try {
		afterConfirmed();
	} catch (error) {
		console.error('[code update] post-confirm hook failed (the confirmation stands):', error);
	}
}

/**
 * It is NOT. The sentinel is left untouched on purpose: it is the only evidence
 * that a swap was in flight, and a rollback must not erase it.
 */
function reportBootMismatch(
	sentinel: CodeUpdateSentinel,
	sentinelPath: string,
	runningVersion: string,
	runningDigest: string | null,
): void {
	console.error(
		`[code update] LOUD: a PENDING code-update sentinel names version ${sentinel.version} / digest ${sentinel.installDigest ?? 'none'} but this process runs ${runningVersion} / digest ${runningDigest ?? 'none'} — a rollback happened, or the swap half-applied. The sentinel at ${sentinelPath} is left untouched; inspect it and the backup at ${sentinel.backupDir}.`,
	);
}

/**
 * Prune the restore points behind a CONFIRMED update to `restorePointsKeep`.
 *
 * Best-effort and loud: this runs on the boot path, and a disk that will not
 * give a directory back is not a reason to fail a boot that is otherwise
 * healthy. The sentinel's own `backupDir` is protected on top of the
 * live-rollback rule — it is the tree this very update replaced, and the
 * evidence of the swap.
 *
 * `backupRoot` is PASSED, never resolved here — see the call site: it is the
 * directory the sentinel we just confirmed lives in, so a caller that redirects
 * the sentinel redirects the pruning with it.
 */
async function pruneConfirmedRestorePoints(
	sentinel: CodeUpdateSentinel,
	backupRoot: string,
): Promise<void> {
	try {
		// CONVENTIONS §2 rationale 1, CYCLE-BREAKING, and only for this one:
		// status.ts imports THIS module (codeUpdateSentinelPath), so a static
		// edge back would make the two one import component. `config` and
		// `restore_points` are static above — neither closes a cycle, and a
		// dynamic import that is not doing work is an edge the SCC tripwire
		// cannot see (review finding 2026-08-28).
		const { readRestorePoints } = await import('./status.ts');
		const points = readRestorePoints(backupRoot);
		const keep = config.update.restorePointsKeep;
		if (points.length <= keep) return;
		const protectName = sentinel.backupDir.split('/').filter(Boolean).pop() ?? null;
		const report = pruneRestorePoints({ points, backupRoot, keep, protect: protectName });
		if (report.deleted.length > 0) {
			console.log(
				`[code update] retention: kept the ${report.kept} newest restore points, deleted ${report.deleted.length} (${report.deleted.join(', ')}). Set DEDALO_CODE_RESTORE_POINTS_KEEP to change this.`,
			);
		}
	} catch (error) {
		console.error('[code update] restore-point retention failed (nothing was deleted):', error);
	}
}
