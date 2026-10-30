/**
 * Shared operator preconditions for update/migration EXECUTEs (UPDATE_PROCESS
 * Phase 0) — the PHP update_data_version gate pair (superuser identity +
 * maintenance mode), plus the database-backup verdict: a REFUSAL for a code
 * update (`requireFreshBackup`, waivable), a WARNING for a data migration
 * (`backupWarningsWithin`). PHP does not auto-chain backups before updates and
 * neither do we.
 *
 * A REQUIRED check REFUSES BY THROWING (engineering/ERRORS_SPEC.md §4) — the
 * PHP refusal sentences became the registry messages of `perm.superuser_required`
 * and `maintenance.mode_required`, so this module builds no body and the caller
 * has nothing to forward.
 *
 * ORDER: identity and maintenance mode are SYNCHRONOUS and always asked first
 * (`checkUpdatePreconditions`) on the update EXECUTE paths (the code update and
 * the owned data migration); their backup questions are asked only after, so a
 * non-superuser's update request never starts an archive read. The update
 * PANEL (core/update/status.ts `backup_fresh`) keeps the same rule: it starts no
 * read for a principal who is not the superuser. Gates:
 * test/unit/update_status_native.test.ts and test/unit/code_update.test.ts
 * ("a non-superuser … starts no archive read"). OUT OF SCOPE, by design: the
 * make_backup widget (a global-admin maintenance action whose job IS to dump and
 * read back) and the orphan adoption it starts.
 */

import { basename } from 'node:path';
import { config } from '../../config/config.ts';
import {
	type BackupVerdict,
	type NewestUsableBackup,
	newestUsableBackup,
	newestUsableBackupWithin,
	PANEL_WAIT_MS,
	readInstalledDataVersionStrict,
	type VerifyOptions,
} from '../area_maintenance/backup.ts';
import { DedaloError } from '../errors/index.ts';
import { getServerState } from '../resolve/server_state.ts';
import { type Principal, SUPERUSER_ID } from '../security/permissions.ts';
import { classifyDataVersion } from './boot_state.ts';
import { DEDALO_DATA_VERSION } from './version.ts';

/** How long an HTTP surface waits on the backup verdict before saying `verifying`. */
export { PANEL_WAIT_MS };

/** The verification knobs a caller may pass (test seams; production passes none). */
export type BackupVerifyOptions = Pick<VerifyOptions, 'pgRestoreBin' | 'budgetMs'>;

export interface Freshness {
	newest: number;
	hours: number | null;
	stale: boolean;
	/** Was the counted artifact PROVEN restorable (vs a usable degradation)? */
	verified: boolean;
	/** The artifact that COUNTED, or null when nothing in the directory did. */
	verdict: BackupVerdict | null;
	/** Verdicts of the NEWER artifacts that were refused — the operator's clue. */
	rejected: BackupVerdict[];
}

/** A bounded wait that ran out while `candidate` (a path) was still being read. */
export interface PendingFreshness {
	pending: true;
	candidate: string | null;
}

/**
 * THE ONE BACKUP-FRESHNESS VERDICT, shared by the code-update refusal, the
 * update_code panel's `backup_fresh` check (core/update/status.ts) and
 * update_data_version's warnings.
 *
 * It exists because the panel and the refusal had drifted by a ROUNDING STEP
 * (`Math.round(hours) > range` vs the raw fraction) — a deterministic half-hour
 * window, once per backup cycle, in which the panel said "Ready to update" while
 * the pipeline refused. A panel whose whole job is to predict the pipeline's
 * refusals must never compute a refusal a second time.
 *
 * FRESHNESS IS NOT USABILITY (audit P0-13, 2026-08-30), AND THE QUESTION IS THE
 * DEEP ONE (OPS-1, 2026-09-30). The age comes from the newest artifact that a
 * FULL `pg_restore` read proved (`newestUsableBackup`). Until 2026-09-30 this
 * path asked the cheap `--list` pass instead, "so the panel would not hang" —
 * and `--list` accepts an archive cut to 60%, so a dump that died part way was a
 * fresh restore point and the unwaived code update swapped the tree over it.
 *
 * THE COST MODEL that makes the deep question affordable (backup.ts, the
 * verification header): the read is ASYNC (the server never freezes),
 * SINGLE-FLIGHT per file and per directory, SERIALIZED (one full read at a time),
 * paid ONCE per artifact (the `.verified` sidecar; our own dumps get theirs at
 * promotion), CAPPED at 3 candidates, and size-BUDGETED. The require path awaits
 * the settled verdict — it runs inside the code update's background job. The
 * HTTP surfaces never await it: they race the SAME shared scan against
 * PANEL_WAIT_MS (`backupFreshnessWithin`) and report `verifying`, never `ok`.
 * Degradations this host cannot do better than (no pg_restore, a foreign
 * format) still count; a read that ran out of time does NOT.
 */
export async function backupFreshness(
	backupDir?: string,
	verify: BackupVerifyOptions = {},
): Promise<Freshness> {
	return freshnessOf(await newestUsableBackup(backupDir, verify));
}

/**
 * The same verdict, waited on for at most `maxWaitMs`: the HTTP surfaces' door.
 * A lost wait returns `{ pending, candidate }` and computes NOTHING of its own —
 * the scan it raced keeps running and its answer is the next asker's.
 */
export async function backupFreshnessWithin(
	maxWaitMs: number,
	backupDir?: string,
	verify: BackupVerifyOptions = {},
): Promise<Freshness | PendingFreshness> {
	const scan = await newestUsableBackupWithin(maxWaitMs, backupDir, verify);
	return 'pending' in scan ? scan : freshnessOf(scan);
}

function freshnessOf({ mtimeMs, verdict, rejected }: NewestUsableBackup): Freshness {
	if (mtimeMs === 0) {
		return { newest: 0, hours: null, stale: true, verified: false, verdict: null, rejected };
	}
	const hours = (Date.now() - mtimeMs) / 3600000;
	return {
		newest: mtimeMs,
		hours,
		stale: hours > config.ops.backupTimeRangeHours,
		verified: verdict?.verified === true,
		verdict,
		rejected,
	};
}

/**
 * The settled scan's finding, or null when fresh enough.
 *
 * The two original sentences are BYTE-FROZEN (update_data_version's response is
 * pinned). The third (P0-13) fires only when a dump exists, is recent, and
 * reading it back did not prove it — naming the artifact and the reason is the
 * difference between an operator who makes a new backup and one who hunts a
 * phantom.
 */
function staleBackupFinding({ hours, stale, rejected }: Freshness): string | null {
	if (hours === null) {
		const refused = rejected[0];
		if (refused !== undefined) {
			return `No usable database backup found — the newest dump ('${basename(refused.filePath)}') did not verify (${refused.reason}); make a backup before updating`;
		}
		return 'No database backup found — make a backup before updating';
	}
	if (stale) {
		return `Newest database backup is about ${Math.round(hours)} hours old — make a fresh backup before updating`;
	}
	return null;
}

/**
 * THE CODE-UPDATE REFUSAL: a stale, absent or unproven database backup is
 * `update.refused` (2026-08-23 — a code swap's rollback contract leans on a
 * restorable state), waived ONLY by an explicit `waive_backup: true`, which the
 * CALLER logs. Takes only the SETTLED verdict: there is no "still verifying"
 * branch to pass through, by construction.
 *
 * A verification that ran out of its budget adds ONE remedy clause naming the
 * key that grants a longer read — an operator on slow storage must learn that
 * the fix is configuration, not a waiver forever.
 */
export async function requireFreshBackup(
	backupDir?: string,
	verify: BackupVerifyOptions = {},
): Promise<void> {
	const freshness = await backupFreshness(backupDir, verify);
	const finding = staleBackupFinding(freshness);
	if (finding === null) return;
	const remedy =
		freshness.rejected[0]?.reason === 'unverifiable_timeout'
			? '; its verification ran out of time — on slow backup storage raise DEDALO_BACKUP_VERIFY_SECONDS_PER_GB'
			: '';
	const sentence = `Error. ${finding} (or pass waive_backup to proceed without one)${remedy}`;
	throw new DedaloError('update.refused', { message: sentence, publicMessage: sentence });
}

/**
 * update_data_version's WARNINGS (it never refuses on a backup): the three
 * byte-frozen sentences once the verdict is settled, or — when the bounded wait
 * ran out — a fourth, saying the newest backup is still being verified. Never an
 * "all clear" that nobody established. A check that FAILS (the scan rejects: a
 * pg_restore that cannot be spawned, an unreadable directory) is a fifth
 * warning, never a throw — a throw here would refuse the migration on a backup,
 * which this door promises never to do; the cause goes to the server log.
 */
export async function backupWarningsWithin(
	maxWaitMs: number,
	backupDir?: string,
	verify: BackupVerifyOptions = {},
): Promise<string[]> {
	let answer: Freshness | PendingFreshness;
	try {
		answer = await backupFreshnessWithin(maxWaitMs, backupDir, verify);
	} catch (error) {
		console.error('[update] the database backup check failed:', error);
		return [
			'Warning. The database backup could not be checked (see the server log) — make sure a restorable backup exists before updating',
		];
	}
	if ('pending' in answer) {
		const name = answer.candidate === null ? '' : ` ('${basename(answer.candidate)}')`;
		return [`Warning. The newest database backup${name} is still being verified — retry shortly`];
	}
	const finding = staleBackupFinding(answer);
	return finding === null ? [] : [`Warning. ${finding}`];
}

/**
 * The required operator checks, in PHP order (superuser first, then
 * maintenance mode). A check that fails THROWS (engineering/ERRORS_SPEC.md §4):
 * `perm.superuser_required` for a non-superuser (403; operator-disclosure, the
 * sentence stays in the log by design), `maintenance.mode_required` for a
 * server that is not in maintenance mode (409, operator — the registry sentence
 * names the switch to flip).
 *
 * SYNCHRONOUS AND BACKUP-FREE by design: the backup verdict is a full archive
 * read, asked by the callers that need it (`requireFreshBackup` for a code
 * update, `backupWarningsWithin` for a data migration) and only after this has
 * passed.
 *
 * `maintenance: false` (restore-point DELETE, 2026-08-28) skips the maintenance
 * gate — and ONLY that caller may: removing a backup directory never touches the
 * live tree and serves no request differently, so demanding an install be closed
 * to the public before it may reclaim its own disk would make the affordance
 * useless on exactly the installation that ran out of space. The superuser check
 * is NOT optional and has no flag.
 */
export function checkUpdatePreconditions(
	principal: Principal,
	options: { maintenance?: boolean } = {},
): void {
	if (principal.userId !== SUPERUSER_ID) {
		throw new DedaloError('perm.superuser_required', { coordinates: { user: principal.userId } });
	}
	if (options.maintenance !== false && getServerState().maintenance_mode !== true) {
		throw new DedaloError('maintenance.mode_required');
	}
}

/**
 * THE DATA-VERSION GATE of a code update (update audit 2026-10-29, U-04;
 * VERSIONING_SPEC S7). The installed data version (matrix_updates) must equal
 * the data version the RUNNING code declares before another code release may
 * be installed:
 *  - `pending` (database behind): the "Update data" this code needs has not run
 *    — walking further would carry the install across a data-changing release
 *    whose migration never ran, and a later engine would then execute it;
 *  - `ahead` (database newer): older code over a newer database — a human
 *    restores or installs the matching code first;
 *  - unreadable / no version row: the state cannot be proven, so it refuses.
 * `read` / `code` are the test seams; production passes neither.
 */
export async function requireDataVersionCurrent(
	read: () => Promise<number[]> = readInstalledDataVersionStrict,
	code: readonly number[] = DEDALO_DATA_VERSION,
): Promise<void> {
	let installed: number[] | null;
	try {
		installed = await read();
	} catch {
		installed = null;
	}
	const verdict = classifyDataVersion(installed, code);
	if (verdict.state === 'ok') return;
	const detail =
		verdict.state === 'pending'
			? `the database is on data version ${verdict.installed} but this code declares ${verdict.code} — run "Update data" first, then update the code`
			: verdict.state === 'ahead'
				? `the database is on data version ${verdict.installed}, NEWER than this code (${verdict.code}) — restore a compatible backup or install the matching code first`
				: `the installed data version could not be read — fix the database (matrix_updates) before updating the code`;
	throw new DedaloError('update.refused', {
		message: `code update refused: data version ${verdict.state} — ${detail}`,
		publicMessage: `Error. Code update refused: ${detail}`,
		coordinates: { rule: `data_version_${verdict.state}` },
	});
}
