/**
 * update_code STATUS — what an operator needs to KNOW before pressing a button
 * that replaces the code tree (and what a code master needs to know before
 * publishing a release others will install).
 *
 * WHY THIS EXISTS. Until 2026-08-24 the panel showed four facts (running
 * version, build stamp, the CODE_SERVERS probe, `is_a_code_server`), while
 * `code_update.ts` could refuse for nine distinct reasons and `code_build_plan.ts`
 * for four more — every one of them discoverable ONLY by pressing the button
 * and reading the failure. A containerized install, for instance, cannot tree-
 * swap at all (channel.ts), and learned so at the very end of a long job.
 *
 * THE LAW OF THIS MODULE: it never re-implements a refusal. Every readiness
 * line asks the SAME function the pipeline refuses on — `isSupervised`,
 * `detectDeploymentChannel`, `runtimePathsInsideTree`, `backupRootIsInsideTree`,
 * `backupFreshnessWithin`, `planCodeBuild`, `buildCodeUpdateInfo`. A second copy
 * of a rule would drift, and a readiness panel that disagrees with the pipeline
 * is worse than no panel: it would earn trust it cannot keep. Where a check is
 * NOT decidable before the download (the release's own root whitelist and its
 * `.bun-version` pin need the archive's contents), this module says so with
 * `state:'unknown'` and reports the INPUTS instead — never a guessed verdict.
 *
 * IT NEVER THROWS. A panel is a diagnostic surface: every probe is wrapped, and
 * a probe that cannot answer degrades to `unknown` with its reason. A broken
 * git checkout must still render the other twelve lines.
 *
 * WIRE: the server answers machine ids and FACTS (paths, versions, counts,
 * byte sizes) — never operator sentences. The wording is the client's, from the
 * label catalog (WC-033), keyed by check id.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { config } from '../../config/config.ts';
import { projectRoot } from '../../config/env.ts';
import type { BackupVerdict } from '../area_maintenance/backup.ts';
import { runtimePathsInsideTree } from '../install/runtime_paths.ts';
import { getServerState } from '../resolve/server_state.ts';
import { type Principal, SUPERUSER_ID } from '../security/permissions.ts';
import { isLoopbackHost } from '../security/ssrf_guard.ts';
import { type CodeUpdateSentinel, codeUpdateSentinelPath } from './boot_confirm.ts';
import {
	DEDALO_BUILD,
	DEDALO_BUILD_SHA,
	DEDALO_ENGINE_VERSION,
	RELEASE_IDENTITY,
} from './build_stamp.ts';
import { UPDATE_CATALOG } from './catalog.ts';
import { type DeploymentChannel, detectDeploymentChannel } from './channel.ts';
import {
	BUILD_INFO_TREE_PATH,
	DEV_REF,
	newestPublishableTag,
	parseDeclaredReleaseTriple,
	placeholderNamesItsTag,
	planCodeBuild,
	prereleaseTagAbove,
	qualifiedReleaseTag,
	releaseTagVersion,
	VERSION_TS_PATH,
} from './code_build_plan.ts';
import {
	buildCodeUpdateInfo,
	type CodeReleaseItem,
	codeReleaseUrl,
	releaseArchiveNameOf,
} from './code_manifest.ts';
import {
	bunPinOf,
	declaredVersionOf,
	type RestoreBlockReason,
	restorabilityOf,
	restorePointIsBootable,
} from './code_restore.ts';
import {
	backupRootIsInsideTree,
	codeStagingDir,
	IGNORED_ROOT_ENTRIES,
	installedDigestOf,
	PRESERVE_ROOT_ENTRIES,
	releaseExcludedRootEntriesOf,
	resolveCodeBackupRoot,
	STAGING_KEEP_MARKER,
	stagingHoldsParkedTree,
} from './code_update.ts';
import { checkUpdateSpaceWithin, type SpaceSeams } from './disk_space.ts';
import {
	type ImageChannelBlock,
	type ImageChannelSeams,
	imageChannelBlock,
} from './image_channel.ts';
import {
	INSTALLED_CHANNEL,
	INSTALLED_DIGEST,
	INSTALLED_SOURCE_URL,
	type InstallChannel,
	installedRootEntriesOf,
} from './install_stamp.ts';
import { type BackupVerifyOptions, backupFreshnessWithin, PANEL_WAIT_MS } from './preconditions.ts';
import type { ReleaseKind } from './release_identity.ts';
import { type DeleteBlockReason, deletabilityOf, RESTORE_POINT_PREFIX } from './restore_points.ts';
import { isSupervised } from './supervision.ts';
import { releaseIdentityOfTree } from './tree_identity.ts';
import { DEDALO_DATA_VERSION, formatVersion } from './version.ts';

// ---------------------------------------------------------------------------
// The check vocabulary
// ---------------------------------------------------------------------------

/**
 * One readiness line.
 *  - `ok`       the pipeline will not refuse on this account;
 *  - `blocked`  this WILL refuse the update as things stand (a hard gate);
 *  - `warn`     allowed, but the operator should know (a waivable condition);
 *  - `unknown`  not decidable here — the reason rides in `detail`.
 * `detail` is a FACT (a path, a version, a count), never a sentence: the panel
 * owns the wording.
 */
export interface StatusCheck {
	id: string;
	state: 'ok' | 'blocked' | 'warn' | 'unknown';
	detail?: string;
	/**
	 * WHAT the check was evaluated against, when that is not obvious — a git
	 * ref, a path. Load-bearing on a code server: the publish checks look at
	 * the RELEASE TAG (`vX.Y.Z`) and `master`, not at the branch the operator has checked
	 * out, so a fix committed on a working branch leaves them red and the
	 * readout has to say why (2026-08-24: `archive_installable` blocked on
	 * `.claude, CLAUDE.md` while HEAD had already excluded them — the panel was
	 * right, but only the ref made that legible).
	 */
	scope?: string;
}

function check(
	id: string,
	state: StatusCheck['state'],
	detail?: string,
	scope?: string,
): StatusCheck {
	const entry: StatusCheck = { id, state };
	if (detail !== undefined) entry.detail = detail;
	if (scope !== undefined) entry.scope = scope;
	return entry;
}

/** Run a probe that must never take the panel down; any throw becomes `unknown`. */
function probe(id: string, run: () => StatusCheck): StatusCheck {
	try {
		return run();
	} catch (error) {
		return check(id, 'unknown', error instanceof Error ? error.message : String(error));
	}
}

/** `probe` for an asynchronous check: a rejection becomes `unknown` too. */
async function probeAsync(id: string, run: () => Promise<StatusCheck>): Promise<StatusCheck> {
	try {
		return await run();
	} catch (error) {
		return check(id, 'unknown', error instanceof Error ? error.message : String(error));
	}
}

/** `git` in a directory, trimmed — null when git or the directory refuses. */
function git(dir: string, args: string[]): string | null {
	try {
		return execFileSync('git', ['-C', dir, ...args], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
			timeout: 5000,
		}).trim();
	} catch {
		return null;
	}
}

/** Is an executable on PATH? (`unzip`/`zipinfo` — the pipeline shells out.) */
function onPath(binary: string): boolean {
	try {
		execFileSync('command', ['-v', binary], { stdio: 'ignore', shell: true, timeout: 3000 });
		return true;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// CONSUMER role — "can this installation take an update?"
// ---------------------------------------------------------------------------

export interface RestorePoint {
	name: string;
	stamp: number;
	/** Carries package.json + node_modules — the rollback-BOOTABILITY contract. */
	bootable: boolean;
	/** The RELEASE IDENTITY the held tree calls itself (`7.0.0-beta.5`;
	 * tree_identity.ts), null when its version.ts is unreadable. Since 2026-10-30
	 * (U-07) — it was the data triple, which every beta of one triple shares. */
	version: string | null;
	/** The DATA triple the held tree's version.ts declares, null when unreadable. */
	data_version: string | null;
	/** The Bun the held tree PINS (its own `.bun-version`), null when it pins
	 * none. A pin other than the running runtime is a HARD blocker: the swap
	 * hands the tree to the running bun (code_update.ts prepareQuarantine says
	 * the same about a release), so the panel states the pin it would need. */
	bun_pin: string | null;
	/** sha256 of the archive it was installed from (its install_stamp), null on an
	 * unstamped tree — what the restore's sentinel carries so the restored tree
	 * confirms itself instead of screaming a mismatch. */
	digest: string | null;
	/** Would the restore pipeline accept this point? Computed by the pipeline's
	 * OWN predicate (code_restore.ts restorabilityOf) — see the module header:
	 * the panel may never reach a verdict the pipeline reaches differently. */
	restorable: boolean;
	/** The machine reason id when it would not (the wire carries ids, not sentences). */
	restorable_reason: RestoreBlockReason | null;
	/** May this point be REMOVED (restore_points.ts deletabilityOf)? */
	deletable: boolean;
	/** Why not — machine id, the panel owns the sentence. */
	deletable_reason: DeleteBlockReason | null;
}

export interface ConsumerStatus {
	engine: {
		/** The DATA triple (`7.0.0`). */
		version: string;
		/** The RELEASE IDENTITY (`7.0.0`, `7.0.0-beta.6`, `7.0.0-dev`). */
		engine_version: string;
		/**
		 * Which kind the identity is — from the tag, never inferred from the
		 * string. Independent of `posture` (the CHANNEL a tree came from): a
		 * dev-channel archive of an exact tag is `prerelease`/`stable` here and
		 * still `dev` there (design rule 5).
		 */
		release_kind: ReleaseKind;
		build: string | null;
		/** ISO date of the running code: the build stamp, else a checkout's HEAD commit date. */
		date: string | null;
		sha: string | null;
		posture: 'release' | 'dev';
		/** Which channel this tree was installed from — null on a dev checkout. */
		install_channel: InstallChannel | null;
		/** sha256 of the archive it was installed from — null on a dev checkout. */
		install_digest: string | null;
		/** The release URL the archive was downloaded from — null on a dev checkout. */
		install_source: string | null;
		bun: string;
		bun_pin: string | null;
	};
	checks: StatusCheck[];
	/** False when ANY check is `blocked` — the panel's headline verdict. */
	ready: boolean;
	last_update: CodeUpdateSentinel | null;
	restore_points: RestorePoint[];
	tree: {
		root: string;
		backup_root: string;
		staging_leftover: boolean;
		/** Root entries the release must ship, or the swap refuses them (the
		 * INPUT to `refuseUnaccountedLiveEntries`, not its verdict). On a tree
		 * whose stamp records its release's root, the entries that release
		 * shipped are subtracted: what remains is operator-added. */
		unaccounted_root_entries: string[];
	};
	/**
	 * Where this installation's IMAGE comes from and how it is updated — present
	 * ONLY on the `image` deployment channel (the `channel` check's own
	 * predicate), absent otherwise, so the tree-swap wire is byte-unchanged
	 * (WC-2026-10-09-update-code-image-channel; core/update/image_channel.ts).
	 */
	image?: ImageChannelBlock;
}

/** The supervisor gate (code_update.ts assertSwapPreconditions, first refusal). */
function supervisorCheck(): StatusCheck {
	return probe('supervisor', () =>
		isSupervised()
			? check('supervisor', 'ok')
			: check('supervisor', 'blocked', 'DEDALO_SUPERVISED'),
	);
}

/** The deployment channel (channel.ts), or the test seam's. ONE predicate for the check and the block. */
function deploymentChannelOf(seams: ConsumerStatusSeams): DeploymentChannel {
	return seams.channel ?? detectDeploymentChannel(projectRoot);
}

/** The deployment channel (channel.ts): `image` cannot tree-swap at all. */
function channelCheck(seams: ConsumerStatusSeams): StatusCheck {
	return probe('channel', () => {
		const channel = deploymentChannelOf(seams);
		return check('channel', channel === 'image' ? 'blocked' : 'ok', channel);
	});
}

/**
 * `consumer.image` — only on the image channel. The block never throws by
 * design; the guard is the panel's own law (a probe never takes it down).
 */
async function imageBlockFor(seams: ConsumerStatusSeams): Promise<{ image?: ImageChannelBlock }> {
	try {
		return deploymentChannelOf(seams) === 'image'
			? { image: await imageChannelBlock(seams.image) }
			: {};
	} catch {
		return {};
	}
}

/** Maintenance mode + superuser (preconditions.ts, both hard). */
function operatorChecks(principal: Principal): StatusCheck[] {
	return [
		probe('maintenance_mode', () =>
			getServerState().maintenance_mode === true
				? check('maintenance_mode', 'ok')
				: check('maintenance_mode', 'blocked'),
		),
		check('superuser', principal.userId === SUPERUSER_ID ? 'ok' : 'blocked'),
	];
}

/**
 * The recent-backup gate. Since 2026-08-23 this REFUSES a code update
 * (`requireFreshBackup`) — but it is the ONE gate the request can waive, and
 * since 2026-08-25 the panel offers that waiver (the update_code modal's
 * `waive_backup` checkbox). So the state is `warn`, the vocabulary's own word
 * for "allowed, but the operator should know (a waivable condition)": a stale
 * backup no longer forces `ready:false`, which would have headlined "Update
 * blocked" over a run the pipeline accepts — the panel/pipeline disagreement
 * this module's header forbids. The age fact rides in `detail` unchanged, and
 * an UNWAIVED request still refuses exactly as before.
 *
 * P0-13 (2026-08-30) / OPS-1 (2026-09-30): the age it reports is that of the
 * newest artifact a FULL `pg_restore` read PROVED — freshness is not usability,
 * and a pg_dump killed at 60% used to make this line read `ok`. `none` can mean
 * "dumps exist but none of them verified"; WHICH artifact was counted (or
 * refused, and why) rides in `scope`.
 *
 * THE PANEL NEVER WAITS FOR A READ (OPS-1): it races the pipeline's own shared
 * scan against a bounded wait (`backupFreshnessWithin`). When the wait loses the
 * line is `warn` / `verifying` with the artifact being read in `scope` — never
 * `ok`, because nothing has been established yet — and the scan carries on, so
 * the next refresh answers from its settled verdict. The verdict itself is still
 * the pipeline's own, computed exactly once.
 */
export function backupFreshnessCheck(
	principal: Principal,
	seams: ConsumerStatusSeams = {},
): Promise<StatusCheck> {
	// ONLY THE SUPERUSER'S PANEL ASKS (OPS-1 review). Every ask may start full
	// archive reads, and the panel is open to any global admin — who cannot run an
	// update (`superuser: blocked` above) and so has no use for the verdict. Their
	// line is `unknown` / `superuser_required`, and nothing is read on their behalf.
	if (principal.userId !== SUPERUSER_ID) {
		return Promise.resolve(check('backup_fresh', 'unknown', 'superuser_required'));
	}
	return probeAsync('backup_fresh', async () => {
		const answer = await backupFreshnessWithin(
			seams.waitMs ?? PANEL_WAIT_MS,
			seams.backupDir,
			seams.backupVerify,
		);
		if ('pending' in answer) {
			return check(
				'backup_fresh',
				'warn',
				'verifying',
				answer.candidate === null ? undefined : `${basename(answer.candidate)} (verifying)`,
			);
		}
		const { hours, stale, verdict, rejected } = answer;
		const scope = backupScope(verdict, rejected);
		if (hours === null) return check('backup_fresh', 'warn', 'none', scope);
		return check('backup_fresh', stale ? 'warn' : 'ok', String(Math.round(hours)), scope);
	});
}

/**
 * The artifact behind the line: the one that COUNTED, else the newest one that
 * was refused and why. FACTS only (a file name and a machine reason) — the
 * wording stays the client's (WC-033), like every other check's scope.
 */
function backupScope(verdict: BackupVerdict | null, rejected: BackupVerdict[]): string | undefined {
	const counted = verdict ?? rejected[0];
	if (counted === undefined) return undefined;
	const name = basename(counted.filePath);
	return counted.usable && counted.verified ? name : `${name} (${counted.reason})`;
}

/** The runtime-path census gate: no runtime data may live inside the tree. */
function runtimeDataCheck(): StatusCheck {
	return probe('runtime_data_outside_tree', () => {
		const inside = runtimePathsInsideTree(projectRoot);
		return inside.length === 0
			? check('runtime_data_outside_tree', 'ok')
			: check(
					'runtime_data_outside_tree',
					'blocked',
					// the env key is the fact the operator's fix needs (the panel's
					// "How to fix it" steps name "the setting in brackets")
					inside
						.map((entry) => `${entry.id}${entry.envKey ? ` (${entry.envKey})` : ''}: ${entry.path}`)
						.join('; '),
				);
	});
}

/** The backup root must resolve OUTSIDE the tree its own swap would rename. */
function backupLocationCheck(backupRoot: string): StatusCheck {
	return probe('backup_root_outside_tree', () =>
		backupRootIsInsideTree(backupRoot, projectRoot)
			? check('backup_root_outside_tree', 'blocked', backupRoot)
			: check('backup_root_outside_tree', 'ok', backupRoot),
	);
}

/** The archive tools the pipeline shells out to (unzip + zipinfo). */
function toolchainCheck(): StatusCheck {
	return probe('archive_toolchain', () => {
		const missing = ['unzip', 'zipinfo'].filter((binary) => !onPath(binary));
		return missing.length === 0
			? check('archive_toolchain', 'ok')
			: check('archive_toolchain', 'blocked', missing.join(', '));
	});
}

/**
 * The release's OWN `.bun-version` pin is a hard gate (prepareQuarantine) but
 * is only readable once the archive is extracted. Honest answer: report the
 * RUNNING bun and this tree's pin, and say the verdict needs the release.
 */
function bunPinCheck(livePin: string | null): StatusCheck {
	if (livePin === null || livePin === '') return check('bun_pin', 'unknown', Bun.version);
	return livePin === Bun.version
		? check('bun_pin', 'ok', Bun.version)
		: check('bun_pin', 'warn', `${Bun.version} != ${livePin}`);
}

/** Leftover `.code_staging` from an interrupted run (the pipeline sweeps it,
 * but its presence tells the operator a previous attempt died mid-flight). */
function stagingCheck(backupRoot: string): StatusCheck {
	return probe('staging_clean', () => {
		// A PARKED LIVE TREE is not a leftover — `prepareStagingDirOrRefuse`
		// hard-refuses on its marker, so the panel must say `blocked`. Reported
		// as a bare `warn`, it left `ready` true and the headline reading
		// "Ready to update" over an install the pipeline refuses immediately.
		if (stagingHoldsParkedTree(backupRoot)) {
			return check('staging_clean', 'blocked', STAGING_KEEP_MARKER);
		}
		return existsSync(codeStagingDir(backupRoot))
			? check('staging_clean', 'warn')
			: check('staging_clean', 'ok');
	});
}

/**
 * FREE DISK SPACE where the update stages — the PIPELINE'S verdict, read early.
 *
 * The rule is `checkUpdateSpace` (disk_space.ts, the one the pipeline refuses
 * on): the staged tree × margin against the bytes available where staging
 * lives. The staged tree needs a `du` (~10^5 inodes), so the panel asks the
 * shared background measurement (`checkUpdateSpaceWithin`) with a bounded wait:
 *  - `ok` / `blocked`  — detail `<available>/<required>` (bytes);
 *  - `unknown`         — `measuring` (the wait lost; the walk carries on and
 *    the next look answers), `unmeasurable` (statfs/du cannot run here — the
 *    pipeline then proceeds unchecked too), or `superuser_required` (only the
 *    superuser's panel pays for a walk, like `backup_fresh`).
 * The pipeline still measures FRESH when it spends disk; this line never
 * stands in for that.
 */
function diskSpaceCheck(
	principal: Principal,
	backupRoot: string,
	seams: ConsumerStatusSeams,
): Promise<StatusCheck> {
	if (principal.userId !== SUPERUSER_ID) {
		return Promise.resolve(check('disk_space', 'unknown', 'superuser_required', backupRoot));
	}
	return probeAsync('disk_space', async () => {
		const answer = await checkUpdateSpaceWithin(
			seams.waitMs ?? PANEL_WAIT_MS,
			seams.treeRoot ?? projectRoot,
			backupRoot,
			PRESERVE_ROOT_ENTRIES,
			seams.space,
		);
		return diskSpaceVerdict(answer, backupRoot);
	});
}

function diskSpaceVerdict(
	answer: Awaited<ReturnType<typeof checkUpdateSpaceWithin>>,
	backupRoot: string,
): StatusCheck {
	if ('pending' in answer) return check('disk_space', 'unknown', 'measuring', backupRoot);
	if (answer.available === null || answer.required === null) {
		return check('disk_space', 'unknown', 'unmeasurable', backupRoot);
	}
	return check(
		'disk_space',
		answer.sufficient ? 'ok' : 'blocked',
		`${answer.available}/${answer.required}`,
		backupRoot,
	);
}

/** A root entry the repo tracks but no release ships: only the SYMLINK a
 * checkout carries — a real dir/file of that name is operator content. */
function isRepoOnlyRootAlias(
	treeRoot: string,
	name: string,
	repoOnly: ReadonlySet<string>,
): boolean {
	return repoOnly.has(name) && lstatSync(join(treeRoot, name)).isSymbolicLink();
}

/**
 * The root-whitelist INPUT: live root entries that a release would have to
 * ship, or `refuseUnaccountedLiveEntries` moves them into the backup and
 * refuses. Derived from the pipeline's own PRESERVE_ROOT_ENTRIES + the census,
 * never a second copy of the rule.
 *
 * The tree's record of its release's root (install_stamp.ts
 * `installedRootEntriesOf`: the install stamp, else the release-root manifest
 * every tree ships — so a checkout or a hand copy knows it too) is subtracted —
 * the swap treats those as release-owned, retired or not — and so are the
 * tree's own `export-ignore` roots (code_update.ts
 * releaseExcludedRootEntriesOf). The remainder is operator-added and the swap
 * REFUSES it (no release ships an entry nobody committed), so: `ok` when
 * empty, `blocked` with the names otherwise. Only a tree with no record at all
 * (older than both) stays `unknown`. `treeRoot` is a seam for the unit gate;
 * the panel reads the live tree.
 */
export function rootEntriesCheck(treeRoot: string = projectRoot): {
	entries: string[];
	check: StatusCheck;
} {
	try {
		const censusInside = new Set(
			runtimePathsInsideTree(treeRoot).map((entry) => entry.path.split('/').pop() ?? ''),
		);
		const releaseShipped = installedRootEntriesOf(treeRoot);
		const repoOnly = releaseExcludedRootEntriesOf(treeRoot);
		const entries = readdirSync(treeRoot).filter(
			(name) =>
				!PRESERVE_ROOT_ENTRIES.has(name) &&
				!IGNORED_ROOT_ENTRIES.has(name) &&
				name !== 'node_modules' &&
				!censusInside.has(name) &&
				!isRepoOnlyRootAlias(treeRoot, name, repoOnly) &&
				releaseShipped?.has(name) !== true,
		);
		if (releaseShipped === null) {
			// A release ships most of these; only the operator knows which are theirs.
			return { entries, check: check('root_entries', 'unknown', String(entries.length)) };
		}
		return {
			entries,
			check: check(
				'root_entries',
				entries.length === 0 ? 'ok' : 'blocked',
				entries.length === 0 ? undefined : entries.join(', '),
			),
		};
	} catch (error) {
		return {
			entries: [],
			check: check(
				'root_entries',
				'unknown',
				error instanceof Error ? error.message : 'unreadable',
			),
		};
	}
}

/** The sentinel of the LAST code update — from/to, when, and its status. */
function readSentinel(): CodeUpdateSentinel | null {
	try {
		const path = codeUpdateSentinelPath();
		if (path === null || !existsSync(path)) return null;
		return JSON.parse(readFileSync(path, 'utf8')) as CodeUpdateSentinel;
	} catch {
		return null;
	}
}

/**
 * One restore point's facts, read from its own tree. `version` is the RELEASE
 * IDENTITY the held tree calls itself (tree_identity.ts — what /health answers
 * once it is restored, U-07), `data_version` the data triple its version.ts
 * declares. NO `bytes`: it used to report `statSync(dir).size` — the DIRECTORY
 * INODE's size (measured 672 B–1.6 KB for multi-GB trees), rendered beside a
 * green "bootable" pill; walking the tree is not the fix either (node_modules is
 * ~10^5 inodes on a panel path).
 */
async function readRestorePoint(
	backupRoot: string,
	name: string,
): Promise<Omit<RestorePoint, 'deletable' | 'deletable_reason'>> {
	const dir = join(backupRoot, name);
	const facts = {
		bootable: restorePointIsBootable(dir),
		version: await releaseIdentityOfTree(dir),
		bun_pin: bunPinOf(dir),
	};
	const verdict = restorabilityOf(facts);
	return {
		name,
		stamp: statSync(dir).mtimeMs,
		...facts,
		data_version: declaredVersionOf(dir),
		digest: installedDigestOf(dir),
		restorable: verdict.restorable,
		restorable_reason: verdict.reason,
	};
}

/**
 * The rollback candidates on disk, newest first, with their bootability and the
 * restore pipeline's own verdict. EXPORTED because code_restore.ts resolves the
 * requested point BY NAME against this very listing — a client never names a
 * path, and the two must be looking at the same set.
 */
export async function readRestorePoints(backupRoot: string): Promise<RestorePoint[]> {
	try {
		const names = readdirSync(backupRoot).filter((name) => name.startsWith(RESTORE_POINT_PREFIX));
		const points = (
			await Promise.all(names.map((name) => readRestorePoint(backupRoot, name)))
		).sort((a, b) => b.stamp - a.stamp);
		// DELETABILITY IS A PROPERTY OF THE SET, not of one directory: the point
		// that must survive is the newest BOOTABLE one, which cannot be known
		// while mapping a single entry. Same shape as `restorable` — the panel
		// disables the button with the predicate the delete path refuses with.
		return points.map((point) => ({
			...point,
			...(({ deletable, reason }) => ({ deletable, deletable_reason: reason }))(
				deletabilityOf(point, points),
			),
		}));
	} catch {
		return [];
	}
}

function readLiveBunPin(): string | null {
	try {
		return readFileSync(join(projectRoot, '.bun-version'), 'utf8').trim();
	} catch {
		return null;
	}
}

/** Test seams of `consumerStatus` — production passes none (the configured backup dir). */
export interface ConsumerStatusSeams {
	/** The DATABASE backup dir the `backup_fresh` line judges. */
	backupDir?: string;
	/** How its artifacts are verified (a recording pg_restore, a budget). */
	backupVerify?: BackupVerifyOptions;
	/** The bounded wait before `backup_fresh` answers `verifying` (default PANEL_WAIT_MS). */
	waitMs?: number;
	/** The deployment channel, instead of probing this filesystem (channel.ts). */
	channel?: DeploymentChannel;
	/** The image block's own seams (image_channel.ts). */
	image?: ImageChannelSeams;
	/** The `disk_space` line's measurement seams (disk_space.ts). */
	space?: SpaceSeams;
	/** The tree `disk_space` measures (default: the live tree). */
	treeRoot?: string;
}

/** The consumer half of the panel: readiness + provenance + rollback state. */
export async function consumerStatus(
	principal: Principal,
	seams: ConsumerStatusSeams = {},
): Promise<ConsumerStatus> {
	const backupRoot = probeBackupRoot();
	const livePin = readLiveBunPin();
	const rootEntries = rootEntriesCheck();
	// the two bounded waits run TOGETHER: the panel pays the longer, not the sum
	const [backupFresh, diskSpace] = await Promise.all([
		backupFreshnessCheck(principal, seams),
		diskSpaceCheck(principal, backupRoot, seams),
	]);
	const checks: StatusCheck[] = [
		supervisorCheck(),
		channelCheck(seams),
		...operatorChecks(principal),
		backupFresh,
		backupLocationCheck(backupRoot),
		runtimeDataCheck(),
		toolchainCheck(),
		bunPinCheck(livePin),
		stagingCheck(backupRoot),
		diskSpace,
		rootEntries.check,
	];
	return {
		engine: {
			version: formatVersion(DEDALO_DATA_VERSION),
			engine_version: DEDALO_ENGINE_VERSION,
			release_kind: RELEASE_IDENTITY.kind,
			build: DEDALO_BUILD,
			date:
				DEDALO_BUILD ?? (git(seams.treeRoot ?? projectRoot, ['log', '-1', '--format=%cI']) || null),
			sha: DEDALO_BUILD_SHA,
			posture: enginePosture(DEDALO_BUILD, INSTALLED_CHANNEL),
			// WHICH ARCHIVE is live, and from which channel (install_stamp.ts).
			// The digest is what an operator compares against the release they
			// meant to install when the version cannot tell them apart.
			install_channel: INSTALLED_CHANNEL,
			install_digest: INSTALLED_DIGEST,
			install_source: INSTALLED_SOURCE_URL,
			bun: Bun.version,
			bun_pin: livePin,
		},
		checks,
		ready: !checks.some((entry) => entry.state === 'blocked'),
		last_update: readSentinel(),
		restore_points: await readRestorePoints(backupRoot),
		tree: {
			root: projectRoot,
			backup_root: backupRoot,
			staging_leftover: existsSync(join(backupRoot, '.code_staging')),
			unaccounted_root_entries: rootEntries.entries,
		},
		...(await imageBlockFor(seams)),
	};
}

function probeBackupRoot(): string {
	try {
		return resolveCodeBackupRoot();
	} catch {
		return '';
	}
}

// ---------------------------------------------------------------------------
// CODE-SERVER role — "can this instance publish a release others can install?"
// ---------------------------------------------------------------------------

/**
 * The refs the two channels are built from (code_build_plan.ts, policy
 * 2026-09-29): a PUBLISHED release from the newest `vX.Y.Z` tag — only a tag
 * build gets the advertised `<v>.zip` name — and a developer build from the tip
 * of {@link DEV_REF}. The publish checks below ask THOSE refs, whatever the
 * operator happens to have checked out, and say which ref they asked.
 */

export interface PublishedRelease {
	/** The DATA triple — the `<X>/<X.Y>/` dir and the URL's version segment. */
	version: string;
	/**
	 * `master` = the stable `<v>.zip`; `prerelease` = `<X.Y.Z-beta.N>.zip`
	 * (RELEASE_IDENTITY_DESIGN §2.8); `dev` = `<v>-dev.zip`, offered only on
	 * request.
	 */
	channel: 'master' | 'prerelease' | 'dev';
	/** The release identity the archive is named after (`7.0.1`, `7.0.1-beta.2`, `7.0.1-dev`). */
	identity: string;
	file: string;
	bytes: number;
	stamp: number;
	sidecar: boolean;
	url: string;
}

export interface CodeServerStatus {
	is_a_code_server: boolean;
	/**
	 * This master OFFERS developer builds to consumers that ask for them
	 * (DEDALO_CODE_SERVER_DEV_CHANNEL). Without it on the panel, an operator
	 * cannot tell "the consumer never asked" from "I refused to answer".
	 */
	dev_channel: boolean;
	/**
	 * This master OFFERS prereleases to consumers that ask for the prerelease
	 * or dev channel (DEDALO_CODE_SERVER_PRERELEASE_CHANNEL) — a separate switch
	 * from {@link dev_channel}.
	 */
	prerelease_channel: boolean;
	checks: StatusCheck[];
	ready: boolean;
	source: {
		git_dir: string | null;
		head_sha: string | null;
		head_date: string | null;
		branch: string | null;
		dirty: boolean | null;
		/** Does the developer ref (`master`) exist in the build checkout. */
		has_master_ref: boolean | null;
		bun_pin: string | null;
		/**
		 * The release channel's ref: the NEWEST stable `vX.Y.Z` tag (short name),
		 * or null when the checkout has none — then nothing can be published.
		 */
		release_ref: string | null;
		release_sha: string | null;
		release_date: string | null;
		/**
		 * The version the release tag's own `version.ts` DECLARES — the name a
		 * publish will actually produce. Not the running engine's version: the
		 * panel's confirm text used to promise "a release of the current
		 * version (X)" from `page_globals.dedalo_version`, which is only true
		 * while the process and the ref happen to agree.
		 */
		release_version: string | null;
		/**
		 * The PRERELEASE channel's ref: the newest `vX.Y.Z-(alpha|beta|rc).N`
		 * tag of this engine that sorts ABOVE `release_ref` (short name), or
		 * null — then *Build prerelease* has nothing to build
		 * (code_build_plan.ts prereleaseTagAbove).
		 */
		prerelease_ref: string | null;
		prerelease_sha: string | null;
		prerelease_date: string | null;
		/** The DATA triple the prerelease tag's own `version.ts` declares (the build refuses a mismatch). */
		prerelease_version: string | null;
		/** The developer channel's ref — always {@link DEV_REF} (`master`). */
		dev_ref: string;
		dev_sha: string | null;
		dev_date: string | null;
		/** The version `master`'s own `version.ts` declares — a dev build's name. */
		dev_version: string | null;
		/**
		 * How far the release tag is from `master`:
		 * `behind` = commits on `master` the release does NOT have (integrated,
		 * not yet released — what a developer build would add), `ahead` = the
		 * reverse (a tag cut off `master`). Null when the two cannot be compared
		 * (no release tag, no `master`).
		 */
		divergence: { ahead: number; behind: number } | null;
	};
	files_dir: string | null;
	releases: PublishedRelease[];
	/** Release dirs the walk could not read — never folded into an empty list. */
	releases_unreadable: string[];
	/**
	 * What consumers would actually be offered. `for_version`/`files` keep the
	 * master's-own-version answer (wire-frozen); `rungs` is the useful one — a
	 * row per distinct catalog `updateFrom`, i.e. per real museum position.
	 */
	advertises: {
		for_version: string;
		files: CodeReleaseItem[];
		rungs: { for_version: string; files: CodeReleaseItem[] }[];
	};
}

/**
 * The build gate, asked through `planCodeBuild` itself — the same refusal
 * order the Build button hits (code server → dirs → version → ref → path), so
 * the panel can never promise a build the planner would refuse.
 */
function buildPlanCheck(source: CodeServerStatus['source']): StatusCheck {
	return probe('build_plan', () => {
		if (source.release_ref === null) return check('build_plan', 'unknown', 'no release tag');
		// the tag's own version is the name; unreadable, there is nothing to plan
		// (release_version_matches_ref says why) — never the running version
		if (source.release_version === null) {
			return check('build_plan', 'unknown', VERSION_TS_PATH, source.release_ref);
		}
		const tagRef = qualifiedReleaseTag(releaseTagVersion(source.release_ref) as string);
		const plan = planCodeBuild(
			{ version: source.release_version, ref: tagRef },
			{
				isCodeServer: config.update.isCodeServer,
				codeServerGitDir: config.update.codeServerGitDir,
				codeFilesDir: config.update.codeFilesDir,
			},
		);
		return plan.ok
			? check('build_plan', 'ok', plan.filePath, source.release_ref)
			: check('build_plan', 'blocked', plan.error, source.release_ref);
	});
}

/** A configured directory that must exist and be writable to publish. */
function directoryCheck(id: string, dir: string | null | undefined): StatusCheck {
	return probe(id, () => {
		if (dir === undefined || dir === null || dir === '') return check(id, 'blocked', 'unset');
		if (!existsSync(dir)) return check(id, 'blocked', dir);
		// EXISTS is not ENOUGH. A regular file at the configured path passes
		// existsSync, so the panel used to read `ok` while nothing could be built
		// or served from it (code_manifest's own existsSync guard then returned an
		// empty release list, and the boot provisioner blamed permissions).
		if (!statSync(dir).isDirectory()) return check(id, 'blocked', `${dir} (not a directory)`);
		return check(id, 'ok', dir);
	});
}

/**
 * Does an archive of the build ref carry SYMLINK entries? The consumer's
 * zipinfo pre-validation refuses the WHOLE archive on the first one
 * (code_update.ts), so a checkout in this state publishes releases nobody can
 * install — the 2026-08-23 agent-alias bug, surfaced where it is created
 * instead of where it lands. Gate for this repo: release_archive_tripwire.
 */
function archiveShapeCheck(gitDir: string | null, ref: string, scope: string = ref): StatusCheck {
	return probe('archive_installable', () => {
		if (gitDir === null) return check('archive_installable', 'unknown', 'no git dir', scope);
		// `set -o pipefail` is LOAD-BEARING: without it a failing `git archive`
		// (missing ref, unreadable dir) still exits 0 because `tar` happily
		// consumes the empty stream — and an empty listing has no symlink lines,
		// so the check would answer a confident, false `ok`. Found 2026-08-24
		// against a code-server dir that did not exist.
		const listing = execFileSync(
			'bash',
			['-c', `set -o pipefail; git -C '${gitDir}' archive --format=tar '${ref}' | tar -tvf -`],
			{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60_000, maxBuffer: 64e6 },
		);
		const symlinks = archiveSymlinkNames(listing);
		return symlinks.length === 0
			? check('archive_installable', 'ok', undefined, scope)
			: check('archive_installable', 'blocked', symlinks.join(', '), scope);
	});
}

/**
 * The LINK NAMES in a `tar -tv` listing — the entries the installer refuses.
 *
 * The naive `line.split(' ').pop()` returns `.agents` for
 * `… .claude -> .agents`: the link's TARGET, not the offending entry. That
 * points the operator at the wrong file, which on a panel whose whole job is
 * naming the blocker is a defect, not a cosmetic slip (found 2026-08-24 by the
 * panel reporting `.agents, AGENTS.md` for symlinks actually named `.claude`
 * and `CLAUDE.md`). So: cut the ` -> target` half off first, then take
 * everything after the timestamp column, which keeps names containing spaces
 * intact.
 */
export function archiveSymlinkNames(listing: string): string[] {
	const names: string[] = [];
	for (const line of listing.split('\n')) {
		if (!/^l[rwxsStT-]{9}\s/.test(line)) continue;
		const name = symlinkNameOf(line);
		if (name !== '') names.push(name);
	}
	return names;
}

/** The NAME column of one `tar -tv` link line ('' when the line yields none). */
function symlinkNameOf(line: string): string {
	const linkHalf = (line.split(' -> ')[0] ?? '').trimEnd();
	// `<mode> <size> <owner> <group> <size> <month> <day> <HH:MM|year> <name>`
	const named = /\s(?:\d{2}:\d{2}|\d{4})\s+(.+)$/.exec(linkHalf);
	return named?.[1] ?? linkHalf.split(/\s+/).pop() ?? '';
}

/** The `.bun-version` pin of a source checkout — absent is an ANSWER, not an error. */
function readBunPin(gitDir: string): string | null {
	try {
		return readFileSync(join(gitDir, '.bun-version'), 'utf8').trim();
	} catch {
		return null;
	}
}

/**
 * The newest PUBLISHABLE release tag of the build checkout (short name), or
 * null: stable `vX.Y.Z` AND a tree of this engine (code_build_plan.ts
 * newestPublishableTag — the PHP-era `v6.x` tags share the repository).
 */
function readReleaseTags(gitDir: string): { release: string | null; prerelease: string | null } {
	const listing = git(gitDir, ['tag', '--list', 'v*']);
	if (listing === null) return { release: null, prerelease: null };
	const tags = listing.split('\n');
	const isEngineTree = (tag: string) =>
		git(gitDir, ['cat-file', '-e', `refs/tags/${tag}:${VERSION_TS_PATH}`]) !== null;
	const release = newestPublishableTag(tags, isEngineTree);
	// The prerelease the *Build prerelease* button would build — the SAME rule
	// code_build.ts applies (newest engine prerelease whose tree stamps its own
	// tag, above the newest release). A pre-stamp beta is never offered: its
	// build could only be refused (code_build_plan.ts placeholderNamesItsTag).
	const namesItsTag = (tag: string) =>
		placeholderNamesItsTag(git(gitDir, ['show', `refs/tags/${tag}:${BUILD_INFO_TREE_PATH}`]) ?? '');
	const prerelease = prereleaseTagAbove(
		newestPublishableTag(tags, (tag) => isEngineTree(tag) && namesItsTag(tag), 'prerelease'),
		release,
	);
	return { release, prerelease };
}

/** A ref's commit, date and declared version — all null when the ref is absent. */
function refFacts(
	gitDir: string,
	ref: string | null,
): { sha: string | null; date: string | null; version: string | null } {
	if (ref === null) return { sha: null, date: null, version: null };
	return {
		sha: git(gitDir, ['rev-parse', '--short', `${ref}^{commit}`]),
		date: git(gitDir, ['log', '-1', '--format=%cI', ref]),
		version: declaredVersionAtRef(gitDir, ref),
	};
}

/** The two channels' refs in `source`: the release tag and the `master` tip. */
function readChannelRefs(
	gitDir: string,
): Pick<
	CodeServerStatus['source'],
	| 'has_master_ref'
	| 'release_ref'
	| 'release_sha'
	| 'release_date'
	| 'release_version'
	| 'prerelease_ref'
	| 'prerelease_sha'
	| 'prerelease_date'
	| 'prerelease_version'
	| 'dev_ref'
	| 'dev_sha'
	| 'dev_date'
	| 'dev_version'
	| 'divergence'
> {
	const tags = readReleaseTags(gitDir);
	const tag = tags.release;
	const tagRef = tag === null ? null : `refs/tags/${tag}`;
	const hasDev = git(gitDir, ['rev-parse', '--verify', '--quiet', DEV_REF]) !== null;
	const release = refFacts(gitDir, tagRef);
	const prerelease = refFacts(
		gitDir,
		tags.prerelease === null ? null : `refs/tags/${tags.prerelease}`,
	);
	const dev = refFacts(gitDir, hasDev ? DEV_REF : null);
	return {
		has_master_ref: hasDev,
		release_ref: tag,
		release_sha: release.sha,
		release_date: release.date,
		release_version: release.version,
		prerelease_ref: tags.prerelease,
		prerelease_sha: prerelease.sha,
		prerelease_date: prerelease.date,
		prerelease_version: prerelease.version,
		dev_ref: DEV_REF,
		dev_sha: dev.sha,
		dev_date: dev.date,
		dev_version: dev.version,
		divergence: tagRef !== null && hasDev ? readDivergence(gitDir, tagRef) : null,
	};
}

/** Everything git knows about the tree the releases are built FROM. */
function readSource(gitDir: string | null): CodeServerStatus['source'] {
	if (gitDir === null || !existsSync(gitDir)) {
		return {
			git_dir: gitDir,
			head_sha: null,
			head_date: null,
			branch: null,
			dirty: null,
			has_master_ref: null,
			bun_pin: null,
			release_ref: null,
			release_sha: null,
			release_date: null,
			release_version: null,
			prerelease_ref: null,
			prerelease_sha: null,
			prerelease_date: null,
			prerelease_version: null,
			dev_ref: DEV_REF,
			dev_sha: null,
			dev_date: null,
			dev_version: null,
			divergence: null,
		};
	}
	const dirty = git(gitDir, ['status', '--porcelain']);
	return {
		git_dir: gitDir,
		head_sha: git(gitDir, ['rev-parse', '--short', 'HEAD']),
		head_date: git(gitDir, ['log', '-1', '--format=%cI']),
		branch: git(gitDir, ['rev-parse', '--abbrev-ref', 'HEAD']),
		dirty: dirty === null ? null : dirty !== '',
		bun_pin: readBunPin(gitDir),
		...readChannelRefs(gitDir),
	};
}

/**
 * `<ahead> <behind>` between the release tag and `master`, via git's own
 * rev-list --count --left-right. `behind` counts commits `master` has that the
 * release does not — integrated work a developer build carries and no release
 * does yet.
 */
function readDivergence(gitDir: string, tagRef: string): { ahead: number; behind: number } | null {
	const counted = git(gitDir, ['rev-list', '--left-right', '--count', `${tagRef}...${DEV_REF}`]);
	if (counted === null) return null;
	const [ahead, behind] = counted.split(/\s+/).map(Number);
	if (!Number.isInteger(ahead) || !Number.isInteger(behind)) return null;
	return { ahead: ahead as number, behind: behind as number };
}

/** An UNSET/absent directory is an answer ('nothing published'), never an error. */
function isReadableDir(dir: string | null | undefined): dir is string {
	return dir !== undefined && dir !== null && dir !== '' && existsSync(dir);
}

/**
 * The immediate SUBDIRECTORY names of `dir`, or null when the directory itself
 * could not be read.
 *
 * `withFileTypes` + an `isDirectory()` filter is load-bearing, not tidiness:
 * the release layout is `<filesDir>/<major>/<major.minor>/`, and a single
 * NON-directory entry at either level (a `.DS_Store` — which macOS plants in
 * every browsed dir, a README, a stray sidecar) used to make the next
 * `readdirSync` throw ENOTDIR and abort the WHOLE walk. The panel then reported
 * "Published releases: None" over a dir full of served archives, and the gate
 * that compares `advertises` against `releases` fired its
 * offering-a-release-that-is-not-on-disk alarm for a directory-walk bug
 * (measured 2026-08-24: `code/.DS_Store` AND `code/7/.DS_Store` both present).
 */
function releaseSubdirs(dir: string): string[] | null {
	try {
		return readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	} catch {
		return null;
	}
}

/**
 * Every archive already published under the code-files dir, newest first, and
 * whether the walk was COMPLETE. A level that could not be read is reported
 * (`unreadable`), never silently folded into a short list: "no releases" and
 * "I could not look" are different facts and the panel must not conflate them.
 */
function readReleases(
	filesDir: string | undefined,
	publicBaseUrl: string,
): { releases: PublishedRelease[]; unreadable: string[] } {
	if (!isReadableDir(filesDir)) return { releases: [], unreadable: [] };
	const found: PublishedRelease[] = [];
	const unreadable: string[] = [];
	const majors = releaseSubdirs(filesDir);
	if (majors === null) return { releases: [], unreadable: [filesDir] };
	for (const major of majors) {
		collectMajorDir(join(filesDir, major), publicBaseUrl, found, unreadable);
	}
	return { releases: found.sort((a, b) => b.stamp - a.stamp), unreadable };
}

/** One `<filesDir>/<major>/` level: its `<major.minor>/` dirs and their archives. */
function collectMajorDir(
	majorDir: string,
	publicBaseUrl: string,
	found: PublishedRelease[],
	unreadable: string[],
): void {
	const minors = releaseSubdirs(majorDir);
	if (minors === null) {
		unreadable.push(majorDir);
		return;
	}
	for (const minor of minors) {
		const minorDir = join(majorDir, minor);
		if (!collectReleaseDir(minorDir, publicBaseUrl, found)) unreadable.push(minorDir);
	}
}

/** One release dir's archives; false when the dir itself could not be read. */
function collectReleaseDir(dir: string, publicBaseUrl: string, into: PublishedRelease[]): boolean {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return false;
	}
	for (const file of entries) {
		// THE archive grammar (code_manifest.ts) — the one the server serves
		// through — so the panel lists exactly what a consumer could fetch.
		const named = releaseArchiveNameOf(file);
		if (named === null) continue;
		const version = named.triple;
		let stat: ReturnType<typeof statSync>;
		try {
			stat = statSync(join(dir, file));
		} catch {
			continue; // vanished between readdir and stat (a rotation racing us)
		}
		into.push({
			version,
			channel: named.kind === 'stable' ? 'master' : named.kind,
			identity: named.identity,
			file,
			bytes: stat.size,
			stamp: stat.mtimeMs,
			sidecar: existsSync(join(dir, `${file}.sha256`)),
			// ONE builder for both this and the manifest (code_manifest.ts
			// releaseItemFor): `publicBaseUrl` ALREADY ends in
			// /dedalo/install/code — appending it again here produced
			// `…/dedalo/install/code/dedalo/install/code/<v>/<v>.zip`, a path
			// `resolveCodeReleaseFile` refuses, for an archive that serves fine
			// at the single-prefix URL.
			url: codeReleaseUrl(publicBaseUrl, version, file),
		});
	}
	return true;
}

/**
 * `master_ref`: does the DEVELOPER ref exist (unknown when git could not
 * answer). A warning, not a blocker: without it no developer build can be made,
 * but a release tag still publishes.
 */
function masterRefCheck(source: CodeServerStatus['source']): StatusCheck {
	return probe('master_ref', () =>
		source.has_master_ref === null
			? check('master_ref', 'unknown', undefined, DEV_REF)
			: check('master_ref', source.has_master_ref ? 'ok' : 'warn', undefined, DEV_REF),
	);
}

/**
 * `release_tag`: is there a publishable `vX.Y.Z` tag? Blocked when not — a
 * published release is a tagged version of THIS engine, never a branch tip nor
 * a pre-release — with the sentence saying so. The normal state while a major
 * is in beta: its code then reaches installations only as developer builds.
 */
function releaseTagCheck(source: CodeServerStatus['source']): StatusCheck {
	return probe('release_tag', () => {
		if (source.git_dir === null || source.head_sha === null) return check('release_tag', 'unknown');
		return source.release_ref === null
			? check('release_tag', 'blocked', 'no vX.Y.Z tag of this engine')
			: check('release_tag', 'ok', source.release_ref);
	});
}

/**
 * `worktree_clean`. A dirty worktree does not refuse the build — `git archive`
 * silently packages HEAD, so the uncommitted work is simply ABSENT from the
 * release. That is a warning the operator must see before publishing.
 */
function worktreeCleanCheck(source: CodeServerStatus['source']): StatusCheck {
	return probe('worktree_clean', () =>
		source.dirty === null
			? check('worktree_clean', 'unknown')
			: check('worktree_clean', source.dirty ? 'warn' : 'ok'),
	);
}

/** The code-server half of the panel: role, build source, artifacts, manifest. */
/**
 * 'dev' | 'release' — what this tree IS, not merely how it was produced.
 *
 * Build provenance alone answers the wrong question: `git archive` expands the
 * build stamp for EVERY ref, so a `v7` branch build looks exactly as
 * "released" as a `master` one. A tree installed from the developer channel is
 * therefore 'dev' however well-stamped it is; a tree with no install stamp
 * (any release predating them) is judged on provenance, as before.
 */
export function enginePosture(
	build: string | null,
	installChannel: InstallChannel | null,
): 'dev' | 'release' {
	if (build === null) return 'dev';
	// A PRERELEASE install is a release posture: its archive is an immutable,
	// sha-verified tag build (RELEASE_IDENTITY_DESIGN §2.8) — only a branch
	// build is unreleased code.
	return installChannel === 'dev' ? 'dev' : 'release';
}

/**
 * Every readiness line of the code-server half, in the order an operator reads
 * them. Split out of `codeServerStatus` so the assembly of the payload and the
 * list of things it asks are two separate, separately-readable jobs.
 */
function codeServerChecks(
	gitDir: string | null,
	filesDir: string | null,
	source: CodeServerStatus['source'],
	published: { releases: PublishedRelease[]; unreadable: string[] },
	publicBaseUrl: string,
): StatusCheck[] {
	return [
		check('is_a_code_server', config.update.isCodeServer ? 'ok' : 'blocked'),
		directoryCheck('git_dir', gitDir ?? undefined),
		directoryCheck('files_dir', filesDir ?? undefined),
		releaseTagCheck(source),
		buildPlanCheck(source),
		masterRefCheck(source),
		worktreeCleanCheck(source),
		archiveShapeCheck(gitDir, releaseTagRefOf(source) ?? DEV_REF, source.release_ref ?? DEV_REF),
		// WHAT VERSION WOULD A PUBLISH ACTUALLY PRODUCE? The release is named
		// after the version its REF declares, so that question has an answer
		// before the button is pressed — and it has a wrong answer worth
		// blocking on: a ref declaring the version this master ALREADY runs
		// yields an archive assertLinearUpgrade refuses as a same-version
		// install. Measured 2026-08-24: a 7.0.0 master published a 7.0.0.zip
		// nobody could install, and nothing said so until a consumer tried.
		releaseVersionCheck(gitDir, source.release_ref),
		// "No releases" and "I could not look" are DIFFERENT facts. Folding an
		// unreadable level into an empty list is what let a stray `.DS_Store`
		// present itself as an empty release dir.
		releasesReadableCheck(published.unreadable),
		// The origin this master will BAKE INTO every advertised URL. A
		// localhost origin is not a cosmetic slip: `get_code_update_info` hands
		// every museum a `file.url` nothing outside this machine can fetch, and
		// the consumer only discovers it at download time — after maintenance
		// mode is already on.
		advertisedOriginCheck(publicBaseUrl),
	];
}

/** `releases_readable`: which release dirs, if any, the walk could not read. */
function releasesReadableCheck(unreadable: string[]): StatusCheck {
	return unreadable.length === 0
		? check('releases_readable', 'ok')
		: check('releases_readable', 'warn', unreadable.join(', '));
}

/** How long a self-probe may take before it is reported as unknown, not as red. */
const REACHABILITY_TIMEOUT_MS = 4000;

/**
 * WHAT to ask for. A sidecar release is probed through its `.sha256` companion —
 * a few bytes that prove the same routing without pulling a release archive;
 * anything else is asked for its first byte only (`Range`). Split out so the
 * probe reads as one decision rather than two parallel ternaries.
 */
function probeRequest(target: PublishedRelease): { url: string; headers: Record<string, string> } {
	if (target.sidecar) return { url: `${target.url}.sha256`, headers: {} };
	return { url: target.url, headers: { Range: 'bytes=0-0' } };
}

/**
 * The first 2 KiB of a refusal body, or '' when it cannot be read. A body we
 * failed to read must not become a failure of its own: the status alone still
 * names a layer.
 */
async function bodySnippet(response: Response): Promise<string> {
	try {
		return (await response.text()).slice(0, 2048);
	} catch {
		return '';
	}
}

/**
 * `advertised_url_reachable`: does the master's OWN advertised release URL
 * actually answer? Depends on NOTHING but its arguments — the caller decides
 * whether a code server is being looked at, and `fetch` is injectable, so the
 * gate is hermetic and identical on every machine.
 *
 * Three layers must agree for a museum to be able to update — the engine serves
 * `/dedalo/install/code/` (core/update/code_serving.ts), the install is
 * configured as a code server, and the REVERSE PROXY routes that path to the
 * socket — and until now nothing checked their composition. Each layer was
 * verified alone: `advertised_origin` proves the origin is not localhost,
 * `releases_readable` proves the files are on disk. Neither notices that the
 * vhost never forwards the path, because no client subtree serves it either:
 * the `/dedalo/` static alias answers 404 and the request never reaches the
 * engine. The consumer discovers it at download time, as
 * `bad server response code: 404`, after maintenance mode is already on.
 *
 * So this check FETCHES. It asks for the `.sha256` sidecar of the newest
 * advertised release — tens of bytes, but the same URL space, the same handler
 * and the same confinement gate as the archive itself, so a 200 proves the
 * whole chain end to end. Without a sidecar it asks for the archive's first
 * byte (`Range`), never its body: a release is hundreds of megabytes and a
 * status panel must not download one.
 *
 * WHAT THE FOUR OUTCOMES MEAN — the point of the check. A bare 404 cannot tell
 * an operator which layer is broken, so the body decides: the engine answers
 * every refusal with the error envelope (`ok:false` + `error.code`), while a
 * proxy that never reached the engine answers with its own HTML. One status
 * code becomes four actionable states.
 *
 * HONEST LIMIT: this fetches the master's own public origin FROM INSIDE its own
 * network. Split-horizon DNS, or a firewall that treats loopback differently,
 * can make this pass while a real museum still fails. It proves "my vhost
 * routes this", not "the internet can reach me" — and it must not be read as
 * the stronger claim, which is the overreach that produced this gap
 * (`update_code_check_advertised_origin` has always been LABELLED "reachable"
 * while only ever parsing a hostname).
 */
export async function advertisedUrlReachableCheck(
	releases: PublishedRelease[],
	fetchImpl: typeof fetch = fetch,
): Promise<StatusCheck> {
	const id = 'advertised_url_reachable';
	// No `isCodeServer` guard here ON PURPOSE. The caller composes this check
	// only for a code server, and reading ambient config inside would make the
	// gate below pass or fail with whatever the developer's own ../private/.env
	// happens to say — measured 2026-08-28: every case went green on a machine
	// with IS_A_CODE_SERVER=true and would have gone `unknown` anywhere else.
	// The function's only inputs are its arguments.

	// Only an ADVERTISED release is worth probing: the dev channel is servable
	// but never named in a manifest, so its reachability answers no question a
	// consumer will ask.
	const target = releases.find((release) => release.channel === 'master');
	if (target === undefined) return check(id, 'unknown', 'nothing published yet');

	const { url, headers } = probeRequest(target);

	let response: Response;
	try {
		response = await fetchImpl(url, {
			headers,
			redirect: 'error',
			signal: AbortSignal.timeout(REACHABILITY_TIMEOUT_MS),
		});
	} catch (error) {
		// Never reached an HTTP server at all: DNS, TLS, refused, timed out. This
		// is the case `advertised_origin` half-guesses from the hostname alone.
		const reason = error instanceof Error ? error.message : String(error);
		return check(id, 'blocked', `the advertised origin did not answer: ${reason}`, url);
	}

	if (response.ok || response.status === 206) return check(id, 'ok', undefined, url);

	// The body says WHICH layer answered.
	return check(
		id,
		'blocked',
		reachabilityDetail(response.status, await bodySnippet(response)),
		url,
	);
}

/** Turn one non-200 into the sentence that names the layer at fault. */
function reachabilityDetail(status: number, body: string): string {
	if (isEngineEnvelope(body)) {
		// The request DID reach the engine, so the proxy is fine and the refusal
		// is the engine's own: not a code server, or the file is not where the
		// files dir says. Its own checks above cover those.
		return `the engine answered ${status} — the proxy routes the path, so this is a code-server configuration fault, not a routing one`;
	}
	return `${status}, and the answer did not come from the engine — the reverse proxy is not routing /dedalo/install/code/ to the socket. Add the rule from docs/install/reverse_proxy.md and reload`;
}

/** Did the ENGINE write this body? Its refusals are always the error envelope. */
function isEngineEnvelope(body: string): boolean {
	try {
		return isErrorEnvelope(JSON.parse(body));
	} catch {
		return false;
	}
}

/** Envelope v2's refusal shape: `{ ok: false, error: { code: <string> } }`. */
function isErrorEnvelope(parsed: unknown): boolean {
	if (typeof parsed !== 'object' || parsed === null) return false;
	const { ok, error } = parsed as { ok?: unknown; error?: unknown };
	return ok === false && hasErrorCode(error);
}

/** The `error` member carries a code — what tells an envelope from any JSON. */
function hasErrorCode(error: unknown): boolean {
	if (typeof error !== 'object' || error === null) return false;
	return typeof (error as Record<string, unknown>).code === 'string';
}

export function codeServerStatus(publicBaseUrl: string): CodeServerStatus {
	const gitDir = config.update.codeServerGitDir ?? null;
	const filesDir = config.update.codeFilesDir ?? undefined;
	const source = readSource(gitDir);
	const published = readReleases(filesDir, publicBaseUrl);
	const checks = codeServerChecks(gitDir, filesDir ?? null, source, published, publicBaseUrl);
	return {
		is_a_code_server: config.update.isCodeServer,
		checks,
		ready: !checks.some((entry) => entry.state === 'blocked'),
		source,
		dev_channel: config.update.devChannelEnabled,
		prerelease_channel: config.update.prereleaseChannelEnabled,
		files_dir: filesDir ?? null,
		releases: published.releases,
		releases_unreadable: published.unreadable,
		advertises: advertisedRungs(filesDir, publicBaseUrl),
	};
}

/**
 * The manifest each REACHABLE consumer version would be offered — one row per
 * distinct `updateFrom` triple in UPDATE_CATALOG.
 *
 * It used to ask exactly ONE question: "what would a consumer at the master's
 * OWN version get?" (`clientVersion: DEDALO_DATA_VERSION`). That is the one
 * version whose answer is least useful: the master publishes releases AT its
 * own version, so a correctly-operating master that had just published
 * `<v>.zip` rendered "No release is offered" — the panel reporting a fault in
 * the exact steady state it was built to confirm. Meanwhile a real museum, one
 * or more rungs behind, got an answer nobody could see.
 */
function advertisedRungs(
	filesDir: string | undefined,
	publicBaseUrl: string,
): CodeServerStatus['advertises'] {
	const seen = new Set<string>();
	const rows: CodeServerStatus['advertises']['rungs'] = [];
	for (const descriptor of Object.values(UPDATE_CATALOG)) {
		const from = [
			descriptor.updateFromMajor,
			descriptor.updateFromMedium,
			descriptor.updateFromMinor,
		];
		const key = from.join('.');
		if (seen.has(key)) continue;
		seen.add(key);
		rows.push({
			for_version: key,
			files: buildCodeUpdateInfo({
				clientVersion: from,
				serverVersion: DEDALO_DATA_VERSION,
				codeFilesDir: filesDir,
				publicBaseUrl,
				info: { date: '', entity_id: null, entity: null, host: null },
			}).files,
		});
	}
	return {
		for_version: formatVersion(DEDALO_DATA_VERSION),
		files: rows.find((row) => row.for_version === formatVersion(DEDALO_DATA_VERSION))?.files ?? [],
		rungs: rows,
	};
}

/** The version a ref's own version.ts declares, read from the object store. */
function declaredVersionAtRef(gitDir: string, ref: string): string | null {
	const source = git(gitDir, ['show', `${ref}:${VERSION_TS_PATH}`]);
	return source === null ? null : parseDeclaredReleaseTriple(source);
}

/** The qualified ref of `source`'s release tag, or null when there is none. */
function releaseTagRefOf(source: CodeServerStatus['source']): string | null {
	const version = source.release_ref === null ? null : releaseTagVersion(source.release_ref);
	return version === null ? null : qualifiedReleaseTag(version);
}

/**
 * The version the release TAG's bytes declare, whether it agrees with the tag's
 * own name (the build refuses a disagreement — code_build_plan.ts), and whether
 * publishing it is useful.
 */
function releaseVersionCheck(gitDir: string | null, tag: string | null): StatusCheck {
	return probe('release_version_matches_ref', () => {
		if (gitDir === null || tag === null) {
			return check('release_version_matches_ref', 'unknown', undefined, tag ?? undefined);
		}
		const declared = declaredVersionAtRef(gitDir, `refs/tags/${tag}`);
		const [state, detail] = tagVersionVerdict(tag, declared);
		return check('release_version_matches_ref', state, detail, tag);
	});
}

/** The verdict on what a release tag's own version.ts declares. */
function tagVersionVerdict(tag: string, declared: string | null): [StatusCheck['state'], string] {
	// Nothing can be named, so nothing can be built.
	if (declared === null) return ['blocked', VERSION_TS_PATH];
	if (declared !== releaseTagVersion(tag)) {
		return ['blocked', `${tag} declares ${declared} in ${VERSION_TS_PATH}`];
	}
	if (declared === formatVersion(DEDALO_DATA_VERSION)) {
		return ['warn', `${declared} = the running engine — a same-version release is not installable`];
	}
	return ['ok', declared];
}

/** Localhost/empty origins make every advertised release URL unfetchable. */
function advertisedOriginCheck(publicBaseUrl: string): StatusCheck {
	let host = '';
	try {
		host = new URL(publicBaseUrl).hostname;
	} catch {
		return check('advertised_origin', 'blocked', publicBaseUrl);
	}
	// Loopback, NOT isPrivateIp: a LAN origin is private but perfectly fetchable,
	// and the docker museum install advertises exactly such an address.
	const local = isLoopbackHost(host);
	return local
		? check('advertised_origin', 'blocked', host)
		: check('advertised_origin', 'ok', host);
}
