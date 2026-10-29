/**
 * Code RESTORE — put a restore point back on the tree (the update, run in
 * reverse). Sibling of code_update.ts, deliberately built out of ITS pieces.
 *
 * WHY IT EXISTS. Every update renames the live tree aside into a restore point
 * (`backupDirName`, kept WITH its `node_modules` so a bare `mv` boots with no
 * network). Until now the only human path back was the supervisor's
 * `deploy/dedalo-code-rollback.sh`, which systemd fires by itself and only for
 * a still-PENDING sentinel: an operator whose update SUCCEEDED and who then
 * wants the previous code back had no path but a manual `mv` over ssh. This is
 * that path, from the maintenance panel.
 *
 * MOVE, NEVER COPY. The restore point is CONSUMED by the same atomic rename
 * swap the update uses, and the outgoing tree becomes a NEW restore point —
 * so a restore is itself undoable, and no doubling of a multi-GB tree happens
 * on a disk the update already measured as tight.
 *
 * NOTHING IS RE-IMPLEMENTED. Every gate is the update's own function
 * (`assertSwapPreconditions`, `acquireRunLockOrRefuse` — the SAME lock, so a
 * restore and an update can never interleave —, `prepareStagingDirOrRefuse`,
 * `refuseUntrackedSecrets`, `sentinelGuardedSwap`, `backupDirName`,
 * `installedDigestOf`, `createPhaseTracker`). The one genuinely NEW step is the
 * pre-flight SMOKE BOOT of the restore point (smoke_boot.ts): a backup dir is a
 * tree nobody has executed since the day it was moved aside, and it must be
 * proven to start BEFORE the live tree moves. That is what makes this more than
 * `mv`.
 *
 * THE UPDATE'S SWAP GATES ARE ABOUT THE SWAP, so they belong here too
 * (2026-08-25 review). They lived inside `prepareQuarantine`, which a restore
 * never calls, and the first cut of this module inherited none of them:
 *  - the SECRET WALK (`refuseUntrackedSecrets`). The first rename carries the
 *    WHOLE live tree into the backup dir, so an operator's `certs/`,
 *    `.dedalo.env` or `deploy/*.pem` — absent from a restore point cut before
 *    they existed — would land in the backup and the restored tree would come
 *    up without them. The update refuses exactly this; silence here would have
 *    been the same loss with no message.
 *    NOT the update's ROOT WHITELIST, which the first fix wrongly took with it
 *    (2026-08-26 review). That half reads `shipped` from the tree about to land
 *    and is sound only while that tree is NEWER; here it is OLDER, so every
 *    root entry a later release added read as "unaccounted" and the restore
 *    refused — telling the operator to delete SHIPPED files, on the one path
 *    meant to recover a broken install. The secret walk starts at the root
 *    anyway, so nothing about secrets was lost with it. See its header.
 *  - the HARD BUN PIN. The swap hands the tree to the RUNNING bun, and the
 *    smoke boot spawns `process.execPath`, so a point pinning another Bun can
 *    pass pre-flight and then be started by the supervisor on a runtime its
 *    `node_modules` was never built for. It is a fact of the POINT, so it is
 *    part of `restorabilityOf` rather than a late refusal: the panel disables
 *    that point's button and says why, instead of offering a run that refuses.
 *
 * A RESTORE POINT MAY PREDATE THE SMOKE-BOOT CONTRACT, and then it is NOT
 * booted (2026-08-25 review). `DEDALO_SMOKE_BOOT` landed 2026-08-23; a tree cut
 * before that date ignores the flag and would run its FULL boot — migrations
 * against the shared production database, schedulers, diffusion runners,
 * watchers, media provisioning — as a second live instance, concurrently with
 * the process still serving. The env neutralisation in smoke_boot.ts covers
 * private state, never the shared database. So the pre-flight is CONDITIONAL on
 * the held tree honouring the flag: when it does not, the phase is reported
 * `skipped` (never a false `done`) and the reason is logged. Refusing instead
 * would make the feature useless on precisely the installations that need it —
 * every restore point in existence predates the flag.
 *
 * THE SENTINEL CARRIES THE RESTORE POINT'S OWN DIGEST, read from its
 * `install_stamp.json` — never this process's. After the restart the restored
 * tree confirms the sentinel (boot_confirm.ts); a sentinel naming the digest of
 * the tree we are moving AWAY would make every restore look like a half-applied
 * swap and scream in the log forever. A point with no stamp omits the field, so
 * boot_confirm falls back to its version compare — and when THAT compare cannot
 * separate the two trees either (an unstamped point declaring the running
 * version) the run says so out loud: see `warnOnIndistinguishableSentinel`.
 *
 * THE DATABASE IS NOT RESTORED, and cannot be: migrations already applied stay
 * applied. That hazard is not silently allowed — a restore point declaring a
 * version other than the running one refuses unless the request carries an
 * explicit `confirm_downgrade`, and the waiver is logged loudly (the
 * `waive_backup` idiom).
 *
 * ONE RESTORABILITY PREDICATE. `restorabilityOf` is exported and imported by
 * status.ts: the panel must never compute a verdict the pipeline computes
 * differently (status.ts's header states that law). It answers a MACHINE reason
 * id — the wire carries ids and facts, the sentences live here and in the label
 * catalog.
 *
 * Seam-driven exactly like the update (`targetRoot`/`backupRoot`/`restart`/
 * `smokeBoot`/`supervised`/`channel`/the three renames), so a gate drives the
 * whole pipeline against a TEMP tree.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectRoot } from '../../config/env.ts';
import { ok } from '../errors/index.ts';
import type { ApiEnvelope } from '../errors/schema.ts';
import type { Principal } from '../security/permissions.ts';
import { currentRequestContext } from '../security/request_context.ts';
import { parseDeclaredTriple, VERSION_TS_PATH } from './code_build_plan.ts';
import {
	acquireRunLockOrRefuse,
	backupDirName,
	type CodeUpdateSeams,
	cleanStagingDir,
	codeStagingDir,
	createPhaseTracker,
	errorText,
	installedDigestOf,
	type PhaseTracker,
	prepareStagingDirOrRefuse,
	refuseUntrackedSecrets,
	resolveBackupRootOrRefuse,
	sentinelGuardedSwap,
	swapPreconditionsWithFrame,
	type UpdateSentinel,
} from './code_update.ts';
import { engineOwnsInstall } from './ownership.ts';
import { checkUpdatePreconditions } from './preconditions.ts';
import { refuseUpdate, rethrowOrRefuseUpdate } from './refuse.ts';
import { removeRestorePointDir, resolveRestorePointOrRefuse } from './restore_points.ts';
import { smokeBootQuarantine } from './smoke_boot.ts';
import { DEDALO_DATA_VERSION } from './version.ts';

/**
 * The restore seams are a SUBSET of the update's, not a parallel type: every
 * helper below is the update's own and takes `CodeUpdateSeams`. A second seam
 * shape would drift from the machinery it drives.
 */
export type CodeRestoreSeams = Pick<
	CodeUpdateSeams,
	// `backupRoot` joined 2026-08-28 with deleteRestorePoint: its gate is the
	// only one that ends in an irreversible rm, so it has to be exercisable
	// against a scratch root. resolveBackupRootOrRefuse already reads it.
	| 'backupRoot'
	| 'targetRoot'
	| 'backupRoot'
	| 'restart'
	| 'supervised'
	| 'channel'
	| 'smokeBoot'
	| 'renameToBackup'
	| 'renameIntoPlace'
	| 'renameRestore'
	| 'onPhase'
>;

/** The pipeline's answer IS the wire body (envelope v2), as in code_update.ts. */
export type CodeRestoreResponse = ApiEnvelope;

/** Why a restore point cannot be restored — a MACHINE id (the wire never carries sentences). */
export type RestoreBlockReason = 'not_bootable' | 'unknown_version' | 'bun_pin_mismatch';

/** What the verdict is computed from — everything readable from the point's own tree. */
export interface RestorePointFacts {
	/** Carries package.json + node_modules (the rollback-BOOTABILITY contract). */
	bootable: boolean;
	/** The version the tree DECLARES (its own version.ts), null when unreadable. */
	version: string | null;
	/** The Bun the tree PINS (its own `.bun-version`), null when it pins none. */
	bun_pin: string | null;
}

/**
 * THE restorability predicate — the panel's button state and the pipeline's
 * refusal are the same three lines of code, by construction.
 *
 * A version MISMATCH is deliberately NOT unrestorable: it is the waivable
 * hazard the confirmation modal exists for. A BUN PIN mismatch is, and is not
 * waivable — the update refuses it outright ('the swap hands the tree to the
 * RUNNING bun', code_update.ts prepareQuarantine), the smoke boot cannot catch
 * it (it spawns `process.execPath`, i.e. the current bun), and the way through
 * is to install the pinned Bun, not to tick a box. `Bun.version` is read here
 * rather than passed in so the panel and the pipeline cannot answer from two
 * different runtimes.
 */
export function restorabilityOf(facts: RestorePointFacts): {
	restorable: boolean;
	reason: RestoreBlockReason | null;
} {
	if (!facts.bootable) return { restorable: false, reason: 'not_bootable' };
	if (facts.version === null) return { restorable: false, reason: 'unknown_version' };
	if (facts.bun_pin !== null && facts.bun_pin !== Bun.version) {
		return { restorable: false, reason: 'bun_pin_mismatch' };
	}
	return { restorable: true, reason: null };
}

/** The version a tree DECLARES, from its own version.ts. Null when unreadable. */
export function declaredVersionOf(treeRoot: string): string | null {
	try {
		return parseDeclaredTriple(readFileSync(join(treeRoot, VERSION_TS_PATH), 'utf8'));
	} catch {
		return null;
	}
}

/** The bootability half of the contract: a tree the rollback could `mv` and start. */
export function restorePointIsBootable(dir: string): boolean {
	return existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'node_modules'));
}

/** The Bun a tree PINS (its own `.bun-version`). Null when it pins none — an
 * empty or unreadable file is "no pin", never a pin that can never match. */
export function bunPinOf(treeRoot: string): string | null {
	try {
		const pin = readFileSync(join(treeRoot, '.bun-version'), 'utf8').trim();
		return pin === '' ? null : pin;
	} catch {
		return null;
	}
}

/**
 * Does the held tree HONOUR `DEDALO_SMOKE_BOOT`? Asked of the tree's OWN
 * `src/server.ts`, because that is the file that would have to obey it: the
 * flag is read there (2026-08-23) and a tree cut before that date ignores it
 * and boots FULLY — see the module header. An unreadable server.ts answers
 * false: this may only ever say yes about a tree that provably honours it.
 */
export function honoursSmokeBoot(treeRoot: string): boolean {
	try {
		return readFileSync(join(treeRoot, 'src', 'server.ts'), 'utf8').includes('DEDALO_SMOKE_BOOT');
	} catch {
		return false;
	}
}

interface RestoreRequest {
	name: string;
	confirmDowngrade: boolean;
}

/** Substrings a restore point name may NEVER contain: a path separator either
 * way round, a traversal segment, or a NUL that could truncate the path. */
const NAME_FORBIDDEN = ['/', '\\', '\0', '..'];

/**
 * NAME GRAMMAR — the client never names a PATH, only a restore point. A name
 * carrying a separator, a traversal segment or a NUL is refused before it is
 * ever joined; the `dedalo_` prefix is the same filter `readRestorePoints`
 * lists by, so a request can never reach for a sibling of the backup root (and
 * it is what refuses a bare `.` or `..` too). The membership check (against
 * the actual listing) is the second gate.
 */
function restorePointNameIsMalformed(name: string): boolean {
	if (name === '' || !name.startsWith('dedalo_')) return true;
	return NAME_FORBIDDEN.some((token) => name.includes(token));
}

function parseRestoreRequest(rawOptions: unknown): RestoreRequest {
	const options = (rawOptions ?? {}) as { name?: unknown; confirm_downgrade?: unknown };
	const name = typeof options.name === 'string' ? options.name : '';
	if (restorePointNameIsMalformed(name)) {
		refuseUpdate(
			'request.invalid_options',
			'Error. Malformed restore point name (a restore point on this installation is required)',
		);
	}
	return { name, confirmDowngrade: options.confirm_downgrade === true };
}

/** The selected point, resolved BY NAME against the listing — never from the request. */
interface SelectedRestorePoint {
	name: string;
	dir: string;
	version: string;
	digest: string | null;
}

/**
 * The operator sentence for each machine reason. One writer, so the refusal an
 * operator reads and the reason the panel's disabled button carries are the
 * same verdict said twice, never two opinions.
 */
function restoreBlockSentence(listed: {
	restorable_reason: RestoreBlockReason | null;
	bun_pin: string | null;
}): string {
	switch (listed.restorable_reason) {
		case 'unknown_version':
			return 'Error. That restore point does not declare a Dédalo version — refusing to restore a tree whose provenance cannot be read.';
		case 'bun_pin_mismatch':
			return `Error. That restore point pins Bun ${listed.bun_pin ?? 'another version'} but this server runs Bun ${Bun.version} — install the pinned Bun first, then retry the restore.`;
		default:
			return 'Error. That restore point is not bootable (it has no package.json or no node_modules) — restoring it would leave this installation unable to start.';
	}
}

/**
 * Membership + restorability, in that order. `readRestorePoints` is status.ts's
 * listing (the same one the panel rendered), so a name that is not in it is
 * simply not a restore point — including one that exists on disk but was
 * created after the panel loaded and has since gone.
 *
 * The import is DYNAMIC for rationale 1 of engineering/CONVENTIONS.md §2 —
 * CYCLE-BREAKING: status.ts imports this module's restorability predicate
 * statically (that is the whole point of there being one predicate), so the
 * edge back must not be a static one.
 */
async function selectRestorePointOrRefuse(
	name: string,
	backupRoot: string,
): Promise<SelectedRestorePoint> {
	const { readRestorePoints } = await import('./status.ts');
	const listed = readRestorePoints(backupRoot).find((point) => point.name === name);
	if (listed === undefined) {
		refuseUpdate(
			'update.refused',
			'Error. Unknown restore point — no restore point of that name exists on this installation.',
		);
	}
	if (!listed.restorable) {
		refuseUpdate('update.refused', restoreBlockSentence(listed));
	}
	// `restorable` is true, so restorabilityOf proved the version non-null.
	return {
		name,
		dir: join(backupRoot, name),
		version: listed.version as string,
		digest: listed.digest,
	};
}

/**
 * THE DATABASE HAZARD, made explicit. Restoring code does NOT revert applied
 * migrations, so a point declaring another version than the running engine is
 * refused unless the operator waives it — and the waiver is logged as loudly as
 * `waive_backup`, because it is the line an incident report will look for.
 */
function assertVersionChangeConfirmed(
	point: SelectedRestorePoint,
	runningVersion: string,
	confirmDowngrade: boolean,
	principal: Principal,
): void {
	if (point.version === runningVersion) return;
	if (!confirmDowngrade) {
		refuseUpdate(
			'update.refused',
			`Error. That restore point holds Dédalo ${point.version} but this installation runs ${runningVersion}, and restoring code does NOT revert database migrations already applied — tick the confirmation (confirm_downgrade) to proceed anyway.`,
		);
	}
	console.warn(
		`[code restore] VERSION CHANGE CONFIRMED by request (confirm_downgrade: true, user ${principal.userId}) — restoring ${point.name} moves this installation from ${runningVersion} to ${point.version} WITHOUT reverting applied database migrations`,
	);
}

/**
 * THE ONE CASE THE SENTINEL CANNOT DECIDE, said out loud (2026-08-25 review).
 *
 * `boot_confirm.ts` tells the restored tree from the outgoing one by DIGEST,
 * falling back to the version compare when the sentinel carries none. A point
 * with no `install_stamp` (a dev-channel checkout renamed aside by the first
 * update) declaring the version already running leaves both doors identical:
 * whichever tree boots next flips the sentinel to `confirmed` and disarms the
 * supervisor-side rollback — the dev-channel hole boot_confirm.ts:18-27
 * documents. It cannot be fixed by inventing a digest, and refusing would
 * forbid the developer-channel restore outright, so it is LOGGED: an incident
 * report needs to be able to find the line that says the confirmation was not
 * decidable on this run.
 */
function warnOnIndistinguishableSentinel(
	point: SelectedRestorePoint,
	runningVersion: string,
): void {
	if (point.digest !== null || point.version !== runningVersion) return;
	console.warn(
		`[code restore] SENTINEL CANNOT IDENTIFY THE RESTORED TREE: ${point.name} carries no install stamp and declares the running version (${runningVersion}), so boot_confirm.ts falls back to the version compare and the OUTGOING tree would confirm this restore just as happily as the restored one. If this swap half-applies, do not trust a 'confirmed' sentinel — compare the trees.`,
	);
}

/**
 * The pre-flight, and the ONE case where there is none. Booting a tree that
 * ignores `DEDALO_SMOKE_BOOT` would run its whole boot — migrations,
 * schedulers, diffusion, watchers — against the live database beside the
 * serving process (module header), so such a point is restored WITHOUT the
 * check and the phase is reported `skipped`, never a false `done`.
 */
async function preflightRestorePoint(
	point: SelectedRestorePoint,
	stagingDir: string,
	seams: CodeRestoreSeams,
	phases: PhaseTracker,
): Promise<void> {
	if (!honoursSmokeBoot(point.dir)) {
		phases.skip('preflight');
		console.warn(
			`[code restore] PRE-FLIGHT BOOT SKIPPED for ${point.name}: its src/server.ts does not honour DEDALO_SMOKE_BOOT (a tree cut before 2026-08-23), so booting it would run its FULL boot — migrations, schedulers, diffusion and watchers — against the live database while this process is still serving. The tree is restored WITHOUT the pre-swap boot check.`,
		);
		return;
	}
	phases.start('preflight');
	await (seams.smokeBoot ?? smokeBootQuarantine)(point.dir, stagingDir);
}

/**
 * The rollback sentinel a restore writes. `installDigest` is the RESTORE
 * POINT's own, and is OMITTED (never empty) when the point carries no install
 * stamp, so boot_confirm.ts falls back to its version compare instead of
 * comparing a digest that can never match.
 */
function restoreSentinel(
	point: SelectedRestorePoint,
	runningVersion: string,
	stamp: string,
	backupDir: string,
): UpdateSentinel {
	return {
		version: point.version,
		previousVersion: runningVersion,
		updateMode: 'clean',
		stamp,
		backupDir,
		...(point.digest === null ? {} : { installDigest: point.digest }),
		status: 'pending',
		rollback_attempted: false,
	};
}

/** The current RQO's id (the widget dispatcher opens the scope), or '' outside a request. */
function currentRequestId(): string {
	return currentRequestContext()?.requestId ?? '';
}

/**
 * The full restore pipeline. Seam-driven; production passes no seams.
 *
 * PHASE TRACK: the update's frames verbatim — `download`/`verify`/`extract`/
 * `deps` are emitted `skipped` (there is nothing to fetch or install: the point
 * carries its own node_modules), so the client's reducer and phase track need
 * no restore-specific branch at all.
 *
 * ORDER NOTE: the backup root is resolved TWICE, and on purpose. The phase
 * frames carry the version being installed, which lives inside the restore
 * point — so the point must be read before the tracker exists, while the full
 * precondition battery (whose refusals must reach the track) runs after it.
 * Both resolutions call the SAME pure `resolveBackupRootOrRefuse`.
 */
export async function restoreCode(
	rawOptions: unknown,
	principal: Principal,
	seams: CodeRestoreSeams = {},
): Promise<CodeRestoreResponse> {
	if (!engineOwnsInstall()) {
		refuseUpdate('update.refused', 'Error. Code restore is not runnable on this engine');
	}
	const request = parseRestoreRequest(rawOptions);
	// Superuser + maintenance mode, but NOT the recent-backup gate: that one is
	// about updates, and a restore has its own explicit confirmation.
	checkUpdatePreconditions(principal);

	const targetRoot = seams.targetRoot ?? projectRoot;
	const runningVersion = DEDALO_DATA_VERSION.join('.');
	const point = await selectRestorePointOrRefuse(
		request.name,
		resolveBackupRootOrRefuse(targetRoot, seams),
	);
	assertVersionChangeConfirmed(point, runningVersion, request.confirmDowngrade, principal);

	const phases = createPhaseTracker(point.version, seams.onPhase);
	phases.skip('download');
	phases.skip('verify');
	phases.skip('extract');
	phases.skip('deps');
	const backupRoot = swapPreconditionsWithFrame(targetRoot, seams, phases);
	const stagingDir = codeStagingDir(backupRoot);
	const restart = seams.restart ?? scheduleServerRestartReal;

	// SINGLE-FLIGHT, on the UPDATE's lock: a restore and an update racing over
	// one tree is the same disaster as two updates racing (code_update.ts).
	const releaseRunLock = acquireRunLockOrRefuse(backupRoot, point.version);
	try {
		prepareStagingDirOrRefuse(stagingDir);

		// THE SWAP'S OWN GATE, the DIRECTION-FREE half: the first rename carries
		// the whole live tree into the backup, so an operator's secret-shaped
		// entry the incoming tree does not ship must refuse HERE, not vanish
		// silently. NOT the update's root whitelist — see its header: reading
		// `shipped` from an OLDER tree makes every root entry a newer release
		// added ('SECURITY.md', 'cliff.toml', 'install.sh'…) read as unaccounted,
		// which refused the restore across any such release and told the operator
		// to delete shipped files (measured 2026-08-26).
		refuseUntrackedSecrets(point.dir, targetRoot);

		await preflightRestorePoint(point, stagingDir, seams, phases);

		phases.start('swap');
		warnOnIndistinguishableSentinel(point, runningVersion);
		const stamp = new Date().toISOString().slice(0, 19).replaceAll(':', '-');
		const backupDir = join(
			backupRoot,
			backupDirName(runningVersion, installedDigestOf(targetRoot), stamp),
		);
		mkdirSync(backupRoot, { recursive: true });
		await sentinelGuardedSwap(
			point.dir,
			targetRoot,
			backupRoot,
			backupDir,
			stagingDir,
			restoreSentinel(point, runningVersion, stamp, backupDir),
			seams,
		);

		const msg = `OK. Restored Dédalo ${point.version} from ${point.name}. Restarting to load the restored code.`;
		phases.start('restart', { expected_version: point.version });
		restart(`code restore to ${point.version} from ${point.name}`);
		return ok({ version: point.version }, { requestId: currentRequestId(), extend: { msg } });
	} catch (error) {
		phases.fail(errorText(error));
		rethrowOrRefuseUpdate(error, 'update.failed', 'Error. Code restore failed');
	} finally {
		cleanStagingDir(stagingDir);
		// Released AFTER the staging sweep. On the success path this process dies
		// in the restart moments later; the lock it leaves names a pid that is
		// gone, which the dead-owner rule reclaims on the next attempt.
		releaseRunLock();
	}
}

function scheduleServerRestartReal(reason: string): void {
	void import('./restart.ts').then(({ scheduleServerRestart }) => {
		scheduleServerRestart(`code restore: ${reason}`);
	});
}

/**
 * DELETE one restore point.
 *
 * A sibling of `restoreCode` and deliberately far smaller: nothing is swapped,
 * nothing restarts, no lock is taken. It is still a DESTRUCTIVE action on
 * disaster-recovery material, so it wears the same gates the restore does — the
 * ownership check and the superuser identity — and refuses through the same
 * predicate the panel disables its button with.
 *
 * NOT the maintenance-mode gate. Deleting a backup directory does not touch the
 * live tree, no request is served differently while it runs, and requiring an
 * install to be closed to the public before it may reclaim disk would make the
 * affordance useless on exactly the installation that ran out of it.
 *
 * NOT a background job either. The removal is synchronous because its ANSWER is
 * the point: an operator who is told "deleted" must be looking at a directory
 * that is gone (see removeRestorePointDir — it verifies), and a fire-and-forget
 * job would hand back a claim nobody checked.
 */
export async function deleteRestorePoint(
	rawOptions: unknown,
	principal: Principal,
	seams: CodeRestoreSeams = {},
): Promise<CodeRestoreResponse> {
	if (!engineOwnsInstall()) {
		refuseUpdate('update.refused', 'Error. Code restore is not runnable on this engine');
	}
	const request = parseRestoreRequest(rawOptions);
	checkUpdatePreconditions(principal, { maintenance: false });

	const targetRoot = seams.targetRoot ?? projectRoot;
	const backupRoot = resolveBackupRootOrRefuse(targetRoot, seams);
	// BY NAME, against the SAME listing the panel rendered (status.ts) — a
	// client never names a path, and the two must be looking at one set.
	const { readRestorePoints } = await import('./status.ts');
	const points = readRestorePoints(backupRoot);
	const listed = points.find((point) => point.name === request.name);
	if (listed === undefined) {
		refuseUpdate(
			'update.refused',
			'Error. Unknown restore point — no restore point of that name exists on this installation.',
		);
	}
	if (listed.deletable !== true) {
		refuseUpdate(
			'update.refused',
			'Error. That restore point is the rollback for the code running now — it is the newest copy this server could boot back into. Delete an older one, or update first so a newer rollback exists.',
		);
	}
	// …and only THEN the path, through the confinement guard: the listing proves
	// the name is one of ours, `resolveRestorePointOrRefuse` proves the path is.
	const dir = resolveRestorePointOrRefuse(backupRoot, request.name);
	const removed = removeRestorePointDir(dir, request.name);
	// LOUD, with the actor: this is irreversible and the operator log is the
	// only place the fact survives once the directory is gone.
	console.warn(
		`[code update] restore point DELETED: ${removed} (by user ${principal.userId}, backup root ${backupRoot})`,
	);
	const sentence = `OK. Restore point ${removed} deleted.`;
	return ok(
		{ deleted: removed },
		{
			requestId: currentRequestContext()?.requestId ?? '',
			extend: { msg: sentence, deleted: removed },
		},
	);
}
