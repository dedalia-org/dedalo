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
 *
 * THE VERSION COMPARED IS THE RELEASE IDENTITY (2026-10-30, U-07), both sides:
 * the sentinel's `version` is the identity the installed/restored tree calls
 * itself and the default `runningVersion` is this tree's DEDALO_ENGINE_VERSION.
 * It was the data triple, which every beta of one triple shares — so a
 * rolled-back beta.5 confirmed a pending update to beta.7. A sentinel written
 * before this names a data triple, which a tagged-stable identity equals and
 * a prerelease/dev identity does not: such a legacy pending sentinel reports a
 * mismatch (loud, untouched) instead of a false confirmation.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { BootSchemaVerdict } from '../../../install/db/migrate.ts';
import { config } from '../../config/config.ts';
import { writeTextFileDurablyAsync } from '../files/durable_async.ts';
import { RUNTIME_PATH_CENSUS } from '../install/runtime_paths.ts';
import { DEDALO_ENGINE_VERSION } from './build_stamp.ts';
import { INSTALLED_DIGEST } from './install_stamp.ts';
import { pruneRestorePoints } from './restore_points.ts';

/** The one sentinel shape (flat, machine-written; the rollback script greps it). */
export interface CodeUpdateSentinel {
	/** The RELEASE IDENTITY the installed tree calls itself (data triple before 2026-10-30). */
	version: string;
	/** The RELEASE IDENTITY of the tree it replaced (data triple before 2026-10-30). */
	previousVersion: string;
	updateMode: string;
	stamp: string;
	backupDir: string;
	/** sha256 of the installed archive — the tree's identity (absent: pre-2026-08-24). */
	installDigest?: string;
	/**
	 * `needs_restore` (2026-10-29, owner rule D-2): the new tree booted, its schema
	 * migration FAILED after changing the schema. The old tree cannot simply take
	 * over a database moved under it, so no automatic rollback acts on this status
	 * (the rollback script and the watchdog act only on `pending`): a human
	 * restores a compatible backup or fixes forward.
	 */
	status: 'pending' | 'confirmed' | 'rolled_back' | 'needs_restore';
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
 * the sentinel carries one, release identity otherwise (an unstamped restore
 * point, a legacy sentinel).
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
 * `schema` (2026-10-29, U-01): this boot's migration verdict. A tree whose
 * migrations FAILED is not "demonstrably alive" — confirming it used to disarm
 * every rollback while the panel showed green. On a failed verdict the sentinel
 * is NOT confirmed and nothing is pruned:
 *  - schema untouched (`schemaMoved` false) → it stays `pending`; the red
 *    /health makes the watchdog start the rollback (the old tree fits the
 *    unchanged schema);
 *  - schema moved (`schemaMoved` true) OR UNKNOWN (null: the census after the
 *    failure could not be read) → `needs_restore`: an automatic rollback might
 *    put old code on a changed schema (D-2), so it waits for a human. Unknown
 *    is treated as moved — the conservative reading of a fact we cannot see.
 * The boot writes that verdict BEFORE it listens (markFailedBootSchema, below),
 * so the watchdog never sees a red /health beside a still-pending sentinel of a
 * moved schema; this post-listen call repeats it idempotently.
 * A sentinel already at `needs_restore` is confirmed by a later boot of the SAME
 * tree whose verdict is `ok` (a human repaired the database forward).
 * `null` = no migration run happened (smoke boot / legacy caller): confirm as before.
 *
 * `afterConfirmed` (publication host phase 4, L5) runs ONLY after THIS tree flipped
 * the sentinel — never on a mismatch, an absent or a non-pending sentinel — and a
 * throw from it is logged, never propagated: server.ts passes the detached
 * Publication API push. A restore writes the same pending sentinel, so a restored
 * tree's confirmation fires it too (lockstep both ways).
 */
export async function confirmBootedCodeUpdate(
	sentinelPath: string | null = codeUpdateSentinelPath(),
	runningVersion: string = DEDALO_ENGINE_VERSION,
	runningDigest: string | null = INSTALLED_DIGEST,
	afterConfirmed: (() => void) | null = null,
	schema: BootSchemaVerdict | null = null,
): Promise<void> {
	try {
		const pending = await readUnconfirmedSentinel(sentinelPath, schema?.state === 'ok');
		if (pending === null) return;
		const { sentinel, path } = pending;
		if (!bootedTreeMatches(sentinel, runningVersion, runningDigest)) {
			reportBootMismatch(sentinel, path, runningVersion, runningDigest);
			return;
		}
		if (schema?.state === 'failed') {
			await refuseConfirmation(sentinel, path, schema);
			return;
		}
		await writeTextFileDurablyAsync(
			path,
			JSON.stringify({ ...sentinel, status: 'confirmed' }, null, '\t'),
		);
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
		await pruneConfirmedRestorePoints(sentinel, dirname(path));
	} catch (error) {
		console.error('[code update] boot confirmation failed (sentinel unreadable?):', error);
	}
}

/**
 * The sentinel at `path` when it is pending — or at needs_restore, when
 * `orNeedsRestore` (a boot whose schema verdict is ok may confirm it); null
 * otherwise. Throws on an unparsable file (logged by the caller).
 */
async function readUnconfirmedSentinel(
	path: string | null,
	orNeedsRestore: boolean,
): Promise<{ sentinel: CodeUpdateSentinel; path: string } | null> {
	if (path === null) return null;
	const text = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
		if (error.code === 'ENOENT') return null;
		throw error;
	});
	if (text === null) return null;
	const sentinel = JSON.parse(text) as CodeUpdateSentinel;
	const open =
		sentinel.status === 'pending' || (orNeedsRestore && sentinel.status === 'needs_restore');
	return open ? { sentinel, path } : null;
}

/**
 * PRE-LISTEN (server.ts, right after the boot migration run): when this boot's
 * migrations FAILED and the booted tree is the pending update's, record the
 * verdict in the sentinel NOW — before /health can answer red and the watchdog
 * read a still-pending sentinel as "roll back". A file write, never gated on a
 * database ping. Never throws into the boot path.
 */
export async function markFailedBootSchema(
	schema: BootSchemaVerdict,
	sentinelPath: string | null = codeUpdateSentinelPath(),
	runningVersion: string = DEDALO_ENGINE_VERSION,
	runningDigest: string | null = INSTALLED_DIGEST,
): Promise<void> {
	if (schema.state !== 'failed') return;
	try {
		const pending = await readUnconfirmedSentinel(sentinelPath, false);
		if (pending === null) return;
		if (!bootedTreeMatches(pending.sentinel, runningVersion, runningDigest)) return;
		await refuseConfirmation(pending.sentinel, pending.path, schema);
	} catch (error) {
		console.error(
			'[code update] could not record the failed boot migration in the sentinel:',
			error,
		);
	}
}

/** The booted tree IS what the sentinel installed. */
function reportBootConfirmed(runningVersion: string, runningDigest: string | null): void {
	console.log(
		`[code update] boot CONFIRMED: running ${runningVersion} (installed digest ${runningDigest ?? 'none'}) matches the pending update (sentinel flipped to confirmed)`,
	);
}

/**
 * The booted tree matches the update but its migrations failed: never confirm.
 * A moved schema flips the sentinel to `needs_restore` (no automatic rollback);
 * otherwise it stays `pending` for the watchdog's rollback.
 */
async function refuseConfirmation(
	sentinel: CodeUpdateSentinel,
	sentinelPath: string,
	schema: BootSchemaVerdict,
): Promise<void> {
	if (schema.schemaMoved !== false) {
		await writeTextFileDurablyAsync(
			sentinelPath,
			JSON.stringify({ ...sentinel, status: 'needs_restore' }, null, '\t'),
		);
		const what =
			schema.schemaMoved === true
				? `applied ${schema.applied.join(', ')} and then a migration failed`
				: 'failed a migration, and whether the schema moved could not be read (treated as moved)';
		console.error(
			`[code update] NOT CONFIRMED — NEEDS A HUMAN: the update to ${sentinel.version} ${what} (${schema.error ?? 'unknown error'}). No automatic rollback will act (sentinel status needs_restore). Restore a compatible database backup together with the previous code at ${sentinel.backupDir}, or fix the failing migration forward.`,
		);
		return;
	}
	console.error(
		`[code update] NOT CONFIRMED: the update to ${sentinel.version} booted but its schema migration failed (${schema.error ?? 'unknown error'}) without changing the schema. The sentinel stays pending and /health is red, so the supervisor-side rollback restores ${sentinel.backupDir}.`,
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
		const points = await readRestorePoints(backupRoot);
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
