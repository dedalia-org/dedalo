/**
 * update_status_native — the update_code STATUS payload (core/update/status.ts).
 *
 * WHAT THIS GATE IS FOR. The panel's whole value is that it tells the operator
 * what the PIPELINE would do. A readiness line that disagrees with the refusal
 * it claims to predict is worse than no line at all — it earns trust it cannot
 * keep. So the assertions here are about AGREEMENT and HONESTY, not cosmetics:
 *
 *   1. every check the panel can emit is in the closed vocabulary, and every
 *      one of them carries a label (an unlabelled check would render as a bare
 *      id to an operator);
 *   2. `ready` is exactly "no check is blocked" — the headline cannot drift
 *      from the lines beneath it;
 *   3. the checks that mirror a refusal agree with that refusal's own
 *      predicate, asked directly (supervisor / channel / backup-root-inside-tree);
 *   4. NOTHING throws: a panel is a diagnostic surface, so an unreadable git
 *      dir, a missing backup root and a broken sentinel each degrade to a
 *      reported state rather than taking the panel down;
 *   5. the code-server half answers only for a code server, and its build gate
 *      is `planCodeBuild`'s own verdict rather than a second opinion.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { projectRoot } from '../../src/config/env.ts';
import { SUPERUSER_ID } from '../../src/core/security/permissions.ts';
import { RELEASE_IDENTITY } from '../../src/core/update/build_stamp.ts';
import { detectDeploymentChannel } from '../../src/core/update/channel.ts';
import { planCodeBuild } from '../../src/core/update/code_build_plan.ts';
import { backupRootIsInsideTree } from '../../src/core/update/code_update.ts';
import {
	type ImageRegistryList,
	loadImageRegistries,
	provisionedRegistries,
} from '../../src/core/update/image_registries.ts';
import {
	INSTALL_STAMP_PATH,
	installedRootEntriesOf,
	RELEASE_ROOT_MANIFEST_PATH,
} from '../../src/core/update/install_stamp.ts';
import { backupFreshness } from '../../src/core/update/preconditions.ts';
import {
	advertisedUrlReachableCheck,
	archiveSymlinkNames,
	codeServerStatus,
	consumerStatus,
	enginePosture,
	rootEntriesCheck,
	type StatusCheck,
} from '../../src/core/update/status.ts';
import { isSupervised } from '../../src/core/update/supervision.ts';

const STATES = new Set(['ok', 'warn', 'blocked', 'unknown']);

/** The superuser principal the panel is opened by. */
const superuser = { userId: SUPERUSER_ID } as never;
/** Anyone else — the update refuses for them (preconditions.ts). */
const mortal = { userId: 42 } as never;

const labels = JSON.parse(
	readFileSync(join(projectRoot, 'src/core/labels/master.json'), 'utf8'),
) as Record<string, string>;

/**
 * The DATABASE backup dir the panel's `backup_fresh` line judges — a scratch dir
 * holding one stub, never the installation's ../private/backups/db: asking the
 * real dir would deep-read its newest archive and write a verification sidecar
 * beside it (OPS-1 made every ask the full read).
 */
const PANEL_BACKUP_DIR = mkdtempSync(join(tmpdir(), 'dedalo_status_db_backups_'));
{
	// Not a custom-format archive: counted on every host (foreign-format
	// degradation), aged past the in-progress window, and fresh. Named `db.backup`
	// — under our own `.custom.backup` suffix the missing archive magic makes it
	// `not_an_archive` (OPS-2 review).
	const stubPath = join(PANEL_BACKUP_DIR, 'db.backup');
	writeFileSync(stubPath, 'x');
	const at = (Date.now() - 30 * 60_000) / 1000;
	utimesSync(stubPath, at, at);
}
afterAll(() => {
	rmSync(PANEL_BACKUP_DIR, { recursive: true, force: true });
});

/** The consumer panel, pinned to the scratch backup dir. */
function panel(principal: never) {
	// a FAKE tree measurement: a real `du` of this checkout is GBs of walking
	return consumerStatus(principal, {
		backupDir: PANEL_BACKUP_DIR,
		waitMs: 60_000,
		space: { measure: async () => 1024, available: () => 10 ** 12, exists: () => false },
	});
}

function byId(checks: StatusCheck[], id: string): StatusCheck {
	const found = checks.find((entry) => entry.id === id);
	if (found === undefined)
		throw new Error(`no check '${id}' in: ${checks.map((c) => c.id).join(', ')}`);
	return found;
}

describe('consumer status', () => {
	test('answers without throwing and states a verdict', async () => {
		const status = await panel(superuser);
		expect(typeof status.ready).toBe('boolean');
		expect(status.checks.length).toBeGreaterThan(0);
		expect(status.engine.version).toMatch(/^\d+\.\d+\.\d+$/);
		// POSTURE is not "was this git-archived" — every `git archive` expands the
		// build stamp, branch builds included. A tree installed from the developer
		// channel is 'dev' however well-stamped it is (2026-08-24).
		expect(status.engine.posture).toBe(enginePosture(status.engine.build as string | null, null));
		expect(enginePosture('2026-08-24T10:00:00Z', 'dev')).toBe('dev');
		expect(enginePosture('2026-08-24T10:00:00Z', 'master')).toBe('release');
		expect(enginePosture(null, null)).toBe('dev');
		// the tree also SAYS which channel it came from, so the panel can name it
		expect(status.engine).toHaveProperty('install_channel');
		expect(status.engine).toHaveProperty('install_digest');
		// the RELEASE IDENTITY and its kind travel together, read from the tag —
		// never inferred from the string (WC-2026-10-15-release-identity-from-tag)
		expect(status.engine.engine_version).toBe(RELEASE_IDENTITY.version);
		expect(status.engine.release_kind).toBe(RELEASE_IDENTITY.kind);
		expect(['stable', 'prerelease', 'dev']).toContain(status.engine.release_kind);
	});

	test('every check uses the closed state vocabulary', async () => {
		for (const check of (await panel(superuser)).checks) {
			expect(STATES.has(check.state)).toBe(true);
			// A fact, never a sentence — the panel owns the wording.
			expect(check.detail === undefined || typeof check.detail === 'string').toBe(true);
		}
	});

	test('every check id carries a label (never renders as a bare id)', async () => {
		const missing = (await panel(superuser)).checks
			.map((check) => `update_code_check_${check.id}`)
			.filter((key) => labels[key] === undefined);
		expect(missing, 'add these to src/core/labels/master.json').toEqual([]);
	});

	test('`ready` is exactly "no check is blocked"', async () => {
		const status = await panel(superuser);
		expect(status.ready).toBe(!status.checks.some((check) => check.state === 'blocked'));
	});

	test('the supervisor line agrees with the refusal it predicts', async () => {
		const check = byId((await panel(superuser)).checks, 'supervisor');
		expect(check.state).toBe(isSupervised() ? 'ok' : 'blocked');
	});

	test('the channel line agrees with detectDeploymentChannel', async () => {
		const check = byId((await panel(superuser)).checks, 'channel');
		const channel = detectDeploymentChannel(projectRoot);
		expect(check.detail).toBe(channel);
		expect(check.state).toBe(channel === 'image' ? 'blocked' : 'ok');
	});

	test('the backup-freshness line is WAIVABLE, never a hard block', async () => {
		// A code update refuses without a recent DATABASE backup — but that is the
		// ONE gate the request can waive, and since 2026-08-25 the update_code
		// modal offers the waiver. `blocked` here would headline "Update blocked"
		// over a run the pipeline accepts: the panel/pipeline disagreement
		// status.ts forbids. So it is `warn`, and it never forces `ready:false`.
		const status = await panel(superuser);
		const check = byId(status.checks, 'backup_fresh');
		expect(check.state).not.toBe('blocked');
		// SETTLED: the panel's bounded wait (60 s here) outlasts a scratch-dir scan,
		// so it answers the pipeline's own verdict, not `verifying`.
		const { hours, stale } = await backupFreshness(PANEL_BACKUP_DIR);
		expect(check.state).toBe(hours !== null && !stale ? 'ok' : 'warn');
		// the age FACT survives — the panel words it, the server measures it
		expect(check.detail).toBe(hours === null ? 'none' : String(Math.round(hours)));
	});

	test('the backup-root line agrees with backupRootIsInsideTree', async () => {
		const status = await panel(superuser);
		const check = byId(status.checks, 'backup_root_outside_tree');
		const inside = backupRootIsInsideTree(status.tree.backup_root, projectRoot);
		expect(check.state).toBe(inside ? 'blocked' : 'ok');
	});

	test('a non-superuser is blocked on identity, exactly as preconditions refuses', async () => {
		expect(byId((await panel(mortal)).checks, 'superuser').state).toBe('blocked');
		expect((await panel(mortal)).ready).toBe(false);
		// …and the superuser is not blocked for that reason.
		expect(byId((await panel(superuser)).checks, 'superuser').state).toBe('ok');
	});

	test("a non-superuser's panel starts NO archive read (the backup line is not theirs to ask)", async () => {
		// OPS-1 review: every panel ask may start full pg_restore reads, and the
		// panel is open to any global admin — who cannot run the update. Nothing is
		// read on their behalf; the SUPERUSER's panel is the positive control.
		const dir = mkdtempSync(join(tmpdir(), 'dedalo_status_mortal_'));
		try {
			const archive = join(dir, '2026-01-01_000000.zz.postgresql_-1_forced_dbv7.custom.backup');
			writeFileSync(archive, 'PGDMP a header-shaped stub');
			const at = (Date.now() - 30 * 60_000) / 1000;
			utimesSync(archive, at, at);
			const log = join(dir, 'pg_restore.argv');
			const recorder = join(dir, 'pg_restore.sh');
			writeFileSync(recorder, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexit 0\n`);
			chmodSync(recorder, 0o755);
			const reads = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []);
			const seams = { backupDir: dir, backupVerify: { pgRestoreBin: recorder }, waitMs: 60_000 };

			const mortalLine = byId((await consumerStatus(mortal, seams)).checks, 'backup_fresh');
			expect(mortalLine).toEqual({
				id: 'backup_fresh',
				state: 'unknown',
				detail: 'superuser_required',
			});
			expect(reads()).toEqual([]);

			const superLine = byId((await consumerStatus(superuser, seams)).checks, 'backup_fresh');
			expect(superLine.state).toBe('ok');
			expect(reads().length).toBeGreaterThan(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('a tree with NO record of its release root stays unknown — never a guessed verdict', () => {
		const tree = mkdtempSync(join(tmpdir(), 'dedalo_status_root_unrecorded_'));
		try {
			writeFileSync(join(tree, 'README.md'), '');
			writeFileSync(join(tree, 'my_notes.txt'), '');
			expect(rootEntriesCheck(tree)).toEqual({
				entries: ['README.md', 'my_notes.txt'],
				check: { id: 'root_entries', state: 'unknown', detail: '2' },
			});
		} finally {
			rmSync(tree, { recursive: true, force: true });
		}
	});

	test('an UNSTAMPED tree (a checkout, a hand copy) decides from its own release-root manifest', () => {
		const tree = mkdtempSync(join(tmpdir(), 'dedalo_status_root_manifest_'));
		try {
			writeFileSync(join(tree, 'README.md'), '');
			const manifest = join(tree, RELEASE_ROOT_MANIFEST_PATH);
			mkdirSync(dirname(manifest), { recursive: true });
			writeFileSync(
				manifest,
				JSON.stringify({ root_entries: ['README.md', 'engineering', 'src'] }),
			);
			expect(rootEntriesCheck(tree).check).toEqual({ id: 'root_entries', state: 'ok' });
			writeFileSync(join(tree, 'my_notes.txt'), '');
			expect(rootEntriesCheck(tree).check).toEqual({
				id: 'root_entries',
				state: 'blocked',
				detail: 'my_notes.txt',
			});
		} finally {
			rmSync(tree, { recursive: true, force: true });
		}
	});

	test('the live panel reports the root-entries line with its inputs', async () => {
		const status = await panel(superuser);
		expect(STATES.has(byId(status.checks, 'root_entries').state)).toBe(true);
		expect(Array.isArray(status.tree.unaccounted_root_entries)).toBe(true);
	});

	test('the running code carries a date (build stamp, or this checkout HEAD)', async () => {
		const { date } = (await panel(superuser)).engine;
		expect(date).not.toBeNull();
		expect(Number.isNaN(Date.parse(date as string))).toBe(false);
	});

	describe('disk space: the pipeline rule, measured in the background', () => {
		const spaceOf = async (seams: Record<string, unknown>, who: never = superuser) => {
			const tree = mkdtempSync(join(tmpdir(), 'dedalo_status_space_'));
			try {
				return byId(
					(
						await consumerStatus(who, {
							backupDir: PANEL_BACKUP_DIR,
							waitMs: 2_000,
							treeRoot: tree,
							...seams,
						})
					).checks,
					'disk_space',
				);
			} finally {
				rmSync(tree, { recursive: true, force: true });
			}
		};
		const GB = 1024 ** 3;

		test('enough room is ok, with both figures', async () => {
			const line = await spaceOf({
				space: { measure: async () => GB, available: () => 10 * GB, exists: () => false },
			});
			expect(line.state).toBe('ok');
			// required = staged × SPACE_MARGIN (1.15), the pipeline's own formula
			expect(line.detail).toBe(`${10 * GB}/${Math.round(GB * 1.15)}`);
		});

		test('a measured shortfall is BLOCKED — the refusal the pipeline would answer', async () => {
			const line = await spaceOf({
				space: { measure: async () => 2 * GB, available: () => GB, exists: () => false },
			});
			expect(line.state).toBe('blocked');
			expect(line.detail).toBe(`${GB}/${Math.round(2 * GB * 1.15)}`);
		});

		test('a measurement that outlives the wait says measuring, never ok', async () => {
			const line = await spaceOf({
				waitMs: 20,
				space: {
					measure: () => new Promise<number>((r) => setTimeout(() => r(GB), 300)),
					available: () => 10 * GB,
					exists: () => false,
				},
			});
			expect(line).toMatchObject({ state: 'unknown', detail: 'measuring' });
		});

		test('an unmeasurable side is unknown (the pipeline proceeds unchecked too)', async () => {
			const line = await spaceOf({
				space: { measure: async () => null, available: () => 10 * GB, exists: () => false },
			});
			expect(line).toMatchObject({ state: 'unknown', detail: 'unmeasurable' });
		});

		test('only the superuser panel pays for a walk', async () => {
			let walked = 0;
			const line = await spaceOf(
				{
					space: {
						measure: async () => {
							walked++;
							return GB;
						},
						available: () => 10 * GB,
						exists: () => false,
					},
				},
				mortal,
			);
			expect(line).toMatchObject({ state: 'unknown', detail: 'superuser_required' });
			expect(walked).toBe(0);
		});
	});

	test('the reader trusts the stamp first, the release-root list second; a malformed list proves nothing', () => {
		const tree = mkdtempSync(join(tmpdir(), 'dedalo_release_root_'));
		try {
			expect(installedRootEntriesOf(tree)).toBeNull();
			const list = join(tree, RELEASE_ROOT_MANIFEST_PATH);
			mkdirSync(dirname(list), { recursive: true });
			writeFileSync(list, JSON.stringify({ root_entries: ['a', 'b'] }));
			expect([...(installedRootEntriesOf(tree) ?? [])]).toEqual(['a', 'b']);
			writeFileSync(list, JSON.stringify({ root_entries: ['a', '../x'] }));
			expect(installedRootEntriesOf(tree)).toBeNull();
			const stamp = join(tree, INSTALL_STAMP_PATH);
			mkdirSync(dirname(stamp), { recursive: true });
			writeFileSync(
				stamp,
				JSON.stringify({ digest: 'e'.repeat(64), channel: 'master', root_entries: ['c'] }),
			);
			expect([...(installedRootEntriesOf(tree) ?? [])]).toEqual(['c']);
		} finally {
			rmSync(tree, { recursive: true, force: true });
		}
	});

	test('a tree whose stamp records its release root reports a VERDICT — the same one the swap reaches', () => {
		// The stamp is the swap's retired-entry evidence (refuseUnaccountedLiveEntries);
		// the panel subtracting the same list is what keeps report and verdict agreeing.
		const tree = mkdtempSync(join(tmpdir(), 'dedalo_status_root_entries_'));
		try {
			writeFileSync(join(tree, 'README.md'), '');
			mkdirSync(join(tree, '.vscode'));
			const stampPath = join(tree, INSTALL_STAMP_PATH);
			mkdirSync(dirname(stampPath), { recursive: true });
			writeFileSync(
				stampPath,
				JSON.stringify({
					digest: 'e'.repeat(64),
					channel: 'master',
					root_entries: ['.vscode', 'README.md', 'src'],
				}),
			);
			expect(rootEntriesCheck(tree)).toEqual({
				entries: [],
				check: { id: 'root_entries', state: 'ok' },
			});

			writeFileSync(join(tree, 'my_notes.txt'), '');
			expect(rootEntriesCheck(tree)).toEqual({
				entries: ['my_notes.txt'],
				check: { id: 'root_entries', state: 'blocked', detail: 'my_notes.txt' },
			});
		} finally {
			rmSync(tree, { recursive: true, force: true });
		}
	});

	test('restore points report the rollback-bootability contract', async () => {
		for (const point of (await panel(superuser)).restore_points) {
			expect(typeof point.bootable).toBe('boolean');
			// NO `bytes`: it used to be statSync(dir).size — the directory
			// INODE's size (measured 672 B–1.6 KB for multi-GB trees) — rendered
			// through format_bytes beside a green "bootable" pill.
			expect('bytes' in point).toBe(false);
			expect(point.name.startsWith('dedalo_')).toBe(true);
		}
	});
});

describe('code server status', () => {
	const status = codeServerStatus('https://example.test/dedalo/install/code');

	test('answers without throwing and states a verdict', () => {
		expect(typeof status.ready).toBe('boolean');
		expect(status.ready).toBe(!status.checks.some((check) => check.state === 'blocked'));
	});

	test('states whether this master PUBLISHES developer builds', () => {
		// The only way an operator can tell "the consumer asked and I said no"
		// from "the consumer never asked" (DEDALO_CODE_SERVER_DEV_CHANNEL).
		const { config } =
			require('../../src/config/config.ts') as typeof import('../../src/config/config.ts');
		expect(status.dev_channel).toBe(config.update.devChannelEnabled);
	});

	test('states whether this master PUBLISHES prereleases — its own switch, not the dev one', () => {
		const { config } =
			require('../../src/config/config.ts') as typeof import('../../src/config/config.ts');
		expect(typeof status.prerelease_channel).toBe('boolean');
		expect(status.prerelease_channel).toBe(config.update.prereleaseChannelEnabled);
	});

	test('every check id carries a label', () => {
		const missing = status.checks
			.map((check) => `update_code_check_${check.id}`)
			.filter((key) => labels[key] === undefined);
		expect(missing, 'add these to src/core/labels/master.json').toEqual([]);
	});

	test('the build gate is planCodeBuild’s own verdict, not a second opinion', () => {
		const { config } =
			require('../../src/config/config.ts') as typeof import('../../src/config/config.ts');
		const tag = status.source.release_ref;
		if (tag === null) {
			// no release tag: nothing to plan, and the panel says so
			expect(byId(status.checks, 'build_plan').state).toBe('unknown');
			expect(byId(status.checks, 'release_tag').state).not.toBe('ok');
			return;
		}
		const plan = planCodeBuild(
			{
				version: status.source.release_version ?? status.advertises.for_version,
				ref: `refs/tags/${tag}`,
			},
			{
				isCodeServer: config.update.isCodeServer,
				codeServerGitDir: config.update.codeServerGitDir,
				codeFilesDir: config.update.codeFilesDir,
			},
		);
		expect(byId(status.checks, 'build_plan').state).toBe(plan.ok ? 'ok' : 'blocked');
	});

	test('a published release is distinguished from a developer one', () => {
		for (const release of status.releases) {
			// The file name IS the channel: `<v>.zip` published, `<v>-beta.N.zip`
			// prerelease (RELEASE_IDENTITY_DESIGN §2.8), `<v>-dev.zip` developer.
			expect(release.channel).toBe(
				release.file.endsWith('-dev.zip')
					? 'dev'
					: /-(alpha|beta|rc)\.\d+\.zip$/.test(release.file)
						? 'prerelease'
						: 'master',
			);
			// Every channel's identity is its archive stem — a dev build's too
			// (`<X.Y.Z>-dev`, release_identity.ts DEV_VERSION_RE, since d803117865).
			expect(release.identity).toBe(release.file.replace(/\.zip$/, ''));
			// EXACT, not endsWith: the panel used to append the
			// /dedalo/install/code prefix to a base that already carried it,
			// emitting a doubled path that resolveCodeReleaseFile refuses —
			// and `endsWith(file)` was true of that broken URL too.
			expect(release.url).toBe(
				`https://example.test/dedalo/install/code/${release.version}/${release.file}`,
			);
		}
	});

	test('the advertised manifest is the real one — a zip on disk is not a promise', () => {
		// The gap this panel exists to show: UPDATE_CATALOG decides what is
		// OFFERED, so `advertises` may legitimately be empty while `releases`
		// is not. What must never happen is the reverse — offering a release
		// that is not on disk.
		for (const rung of status.advertises.rungs) {
			for (const offered of rung.files) {
				expect(status.releases.some((release) => release.version === offered.version)).toBe(true);
			}
		}
		// …and the listing must not be silently empty because the WALK died.
		// A single stray non-directory entry (a `.DS_Store`, which macOS plants
		// in every browsed dir) used to abort the whole two-level walk, so the
		// panel reported "Published releases: None" over a dir full of served
		// archives — and fired THIS security-shaped alarm for a directory bug.
		expect(status.releases_unreadable).toEqual([]);
	});

	test('every publish check names the ref it was evaluated against', () => {
		// The 2026-08-24 confusion: `archive_installable` was blocked on paths
		// HEAD had already excluded, because it reads the release ref. A check
		// whose scope is invisible reads as a false alarm.
		expect(byId(status.checks, 'master_ref').scope).toBe('master');
		const tag = status.source.release_ref;
		expect(byId(status.checks, 'archive_installable').scope).toBe(tag ?? 'master');
		if (tag !== null) {
			for (const id of ['build_plan', 'release_version_matches_ref']) {
				expect(byId(status.checks, id).scope, `${id} must name its ref`).toBe(tag);
			}
		}
	});

	test('the channel refs are reported separately from the checked-out branch', () => {
		// Policy 2026-09-29: release = newest vX.Y.Z tag, developer = master.
		// Neither is the checked-out branch, and every publish check reads one
		// of them — so the panel must never conflate them.
		expect(status.source.dev_ref).toBe('master');
		const tag = status.source.release_ref;
		if (tag !== null) expect(tag).toMatch(/^v\d+\.\d+\.\d+$/);
		expect(byId(status.checks, 'release_tag').state).toBe(
			status.source.head_sha === null ? 'unknown' : tag === null ? 'blocked' : 'ok',
		);
		if (status.source.divergence !== null) {
			expect(Number.isInteger(status.source.divergence.behind)).toBe(true);
			expect(Number.isInteger(status.source.divergence.ahead)).toBe(true);
		}
		// the retired check: master running ahead of the release is the normal
		// state under the tag policy, not something to warn about
		expect(status.checks.some((check) => check.id === 'release_ref_current')).toBe(false);
	});

	test('a broken archive probe degrades to unknown, never a false ok', () => {
		// The `set -o pipefail` contract: a failing `git archive` must not read
		// as "no symlink entries found" (found 2026-08-24 against a code-server
		// dir that did not exist).
		const check = byId(status.checks, 'archive_installable');
		expect(STATES.has(check.state)).toBe(true);
		if (check.state === 'unknown') expect(typeof check.detail).toBe('string');
	});
});

/**
 * THE ADVERTISED URL SELF-PROBE. A master must not offer a release it cannot
 * deliver: the engine serves /dedalo/install/code/, the config marks the
 * install a code server, and the REVERSE PROXY routes the path — and until this
 * check nothing verified the three together. The proxy layer is the one that
 * fails silently, because the path has no client subtree: the /dedalo/ static
 * alias answers 404 and the request never reaches the engine, so every
 * filesystem check stays green while every museum gets a 404 at download time.
 *
 * The gate is the DISCRIMINATION. A bare status code cannot say which layer
 * broke, so the check reads the body: the engine answers refusals with the
 * error envelope, a proxy that never reached it answers with its own HTML.
 * Injecting fetch keeps this hermetic — nothing here touches the network.
 */
describe('the advertised release URL is probed, and the failure NAMES the layer', () => {
	const RELEASES = [
		{
			version: '7.0.1',
			channel: 'master' as const,
			identity: '7.0.1',
			file: '7.0.1.zip',
			bytes: 10,
			stamp: 2,
			sidecar: true,
			url: 'https://example.test/dedalo/install/code/7.0.1/7.0.1.zip',
		},
		{
			version: '7.0.2',
			channel: 'dev' as const,
			identity: '7.0.2-dev',
			file: '7.0.2-dev.zip',
			bytes: 10,
			stamp: 9,
			sidecar: true,
			url: 'https://example.test/dedalo/install/code/7.0.2/7.0.2-dev.zip',
		},
	];

	/** A fetch that records what it was asked for and answers as told. */
	function fakeFetch(answer: Response | Error): { calls: string[]; impl: typeof fetch } {
		const calls: string[] = [];
		const impl = (async (input: string | URL | Request) => {
			calls.push(String(input));
			if (answer instanceof Error) throw answer;
			return answer.clone();
		}) as unknown as typeof fetch;
		return { calls, impl };
	}

	const engine404 = () =>
		new Response(
			JSON.stringify({
				ok: false,
				request_id: 'x',
				error: { code: 'resource.not_found', category: 'not_found' },
			}),
			{ status: 404, headers: { 'Content-Type': 'application/json' } },
		);
	const proxy404 = () =>
		new Response('<html><head><title>404 Not Found</title></head></html>', {
			status: 404,
			headers: { 'Content-Type': 'text/html' },
		});

	test('a served sidecar is ok — and the SIDECAR is what gets asked for', async () => {
		const { calls, impl } = fakeFetch(new Response('abc123', { status: 200 }));
		const check = await advertisedUrlReachableCheck(RELEASES, impl);
		expect(check.state).toBe('ok');
		// Never the archive itself: a release is hundreds of megabytes and a
		// status panel must not download one to prove a route works.
		expect(calls).toEqual(['https://example.test/dedalo/install/code/7.0.1/7.0.1.zip.sha256']);
	});

	test('only an ADVERTISED release is probed, never the dev channel', async () => {
		// 7.0.2-dev is newer, but no manifest ever names it, so its reachability
		// answers no question a consumer will ask.
		const { calls, impl } = fakeFetch(new Response('abc123', { status: 200 }));
		await advertisedUrlReachableCheck(RELEASES, impl);
		expect(calls[0]).toContain('7.0.1');
		expect(calls[0]).not.toContain('-dev');
	});

	test('a NON-ENGINE 404 blames the reverse proxy, and says which rule is missing', async () => {
		const { impl } = fakeFetch(proxy404());
		const check = await advertisedUrlReachableCheck(RELEASES, impl);
		expect(check.state).toBe('blocked');
		expect(check.detail).toContain('/dedalo/install/code/');
		expect(check.detail).toContain('proxy');
		// The operator gets the URL that failed, not just a verdict.
		expect(check.scope).toContain('7.0.1.zip.sha256');
	});

	test('an ENGINE 404 does NOT blame the proxy — the request got through', async () => {
		const { impl } = fakeFetch(engine404());
		const check = await advertisedUrlReachableCheck(RELEASES, impl);
		expect(check.state).toBe('blocked');
		// This is the whole point of reading the body: same status code, opposite
		// diagnosis. Blaming the proxy here would send an operator to edit a
		// vhost that is already correct.
		expect(check.detail).toContain('the engine answered');
		expect(check.detail).not.toContain('not routing');
	});

	test('no answer at all blames the origin, and reports why', async () => {
		const { impl } = fakeFetch(new Error('getaddrinfo ENOTFOUND example.test'));
		const check = await advertisedUrlReachableCheck(RELEASES, impl);
		expect(check.state).toBe('blocked');
		expect(check.detail).toContain('did not answer');
		expect(check.detail).toContain('ENOTFOUND');
	});

	test('nothing published is UNKNOWN, never a false green', async () => {
		const { calls, impl } = fakeFetch(new Response('', { status: 200 }));
		const check = await advertisedUrlReachableCheck([], impl);
		expect(check.state).toBe('unknown');
		expect(calls).toEqual([]);
	});

	test('the probe carries a label like every other check', () => {
		expect(labels.update_code_check_advertised_url_reachable).toBeDefined();
	});

	test('the OLD origin check no longer claims to prove reachability', () => {
		// It parses a hostname; it has never fetched anything. While its label
		// said "reachable" it promised exactly the property that was broken, and
		// the promise is why nobody went looking for this gap.
		expect(labels.update_code_check_advertised_origin).not.toContain('reachable');
	});
});

describe('archive symlink names', () => {
	test('names the LINK, never its target', () => {
		// Real `tar -tv` bytes. The naive last-token parse answered `.agents` /
		// `AGENTS.md` here — the targets — so the panel pointed the operator at
		// files that were not the problem (found 2026-08-24 against this repo's
		// own master ref).
		const listing = [
			'lrwxrwxrwx  0 root   root        0 Jul 30 12:04 .claude -> .agents',
			'lrwxrwxrwx  0 root   root        0 Jul 30 12:04 CLAUDE.md -> AGENTS.md',
			'-rw-r--r--  0 root   root     1234 Jul 30 12:04 package.json',
			'drwxr-xr-x  0 root   root        0 Jul 30 12:04 src/',
		].join('\n');
		expect(archiveSymlinkNames(listing)).toEqual(['.claude', 'CLAUDE.md']);
	});

	test('keeps a name containing spaces intact, and reads a year-column listing', () => {
		// tar prints a YEAR instead of HH:MM once an entry is over six months old.
		const listing = [
			'lrwxrwxrwx  0 root   root        0 Jul 30  2024 docs/my notes.md -> ../notes.md',
		].join('\n');
		expect(archiveSymlinkNames(listing)).toEqual(['docs/my notes.md']);
	});

	test('an empty or symlink-free listing yields nothing', () => {
		expect(archiveSymlinkNames('')).toEqual([]);
		expect(archiveSymlinkNames('-rw-r--r--  0 root root 1 Jul 30 12:04 a.txt')).toEqual([]);
	});

	test('agrees with git on this repo (the check is not parsing fiction)', () => {
		const listing = Bun.spawnSync(
			[
				'bash',
				'-c',
				`set -o pipefail; git -C '${projectRoot}' archive --format=tar HEAD | tar -tvf -`,
			],
			{ stdout: 'pipe', stderr: 'ignore' },
		);
		expect(listing.exitCode).toBe(0);
		const names = archiveSymlinkNames(listing.stdout.toString());
		// HONEST LIMIT: on a branch whose .gitattributes already excludes every
		// symlink (release_archive_tripwire keeps HEAD in that state) this loop
		// is empty and asserts nothing — the fixture tests above carry the
		// parsing proof. It bites on any branch that still ships one.
		// Whatever git reports, every name must be a real tracked path — never a
		// link target, which is what the old parser produced.
		for (const name of names) {
			const tracked = Bun.spawnSync(
				['git', '-C', projectRoot, 'ls-files', '--error-unmatch', name],
				{
					stdout: 'ignore',
					stderr: 'ignore',
				},
			);
			expect(tracked.exitCode, `${name} is not a tracked path`).toBe(0);
		}
	});
});

// ---------------------------------------------------------------------------
// consumer.image — the image-channel block (installer unification D3,
// 2026-10-09; WC-2026-10-09-update-code-image-channel)
// ---------------------------------------------------------------------------

describe('consumer.image: present ONLY on the image channel, and it never throws', () => {
	const NOW = new Date('2026-10-09T12:00:00.000Z');
	const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000).toISOString();
	const channelDirs: string[] = [];
	afterAll(() => {
		for (const dir of channelDirs) rmSync(dir, { recursive: true, force: true });
	});

	/** A scratch channel dir holding the given files (raw strings are written verbatim). */
	function channelDir(files: Record<string, unknown> = {}): string {
		const dir = mkdtempSync(join(tmpdir(), 'dedalo_status_image_channel_'));
		channelDirs.push(dir);
		for (const [name, body] of Object.entries(files)) {
			writeFileSync(join(dir, name), typeof body === 'string' ? body : JSON.stringify(body));
		}
		return dir;
	}

	const getter =
		(image: string | undefined, mode: string | undefined) =>
		(key: 'DEDALO_CONTAINER_IMAGE' | 'DEDALO_CONTAINER_IMAGE_MODE') =>
			key === 'DEDALO_CONTAINER_IMAGE' ? image : mode;

	const beat = (secondsAgo: number, interval = 60) => ({
		schema: 1,
		interval_seconds: interval,
		mode: 'pull',
		image: 'ghcr.io/dedalia-org/dedalo',
		pinned: '7.0.0',
		verify: 'cosign',
		running_digest: null,
		seen_at: ago(secondsAgo),
	});

	const REQUEST = {
		schema: 1,
		id: '0b9f1c2e-6d4a-4c1b-9a8e-3f2d1c0b9a8e',
		tag: '7.0.1',
		version: '7.0.1',
		channel: 'master',
		from_version: '7.0.0',
		requested_at: ago(30),
		requested_by: -1,
	};

	const OUTCOME = {
		schema: 1,
		request_id: REQUEST.id,
		from: '7.0.0',
		to: '7.0.1',
		mode: 'pull',
		image: 'ghcr.io/dedalia-org/dedalo',
		status: 'rolled_back',
		detail: 'health_timeout',
		backup: '/backups/db/x.custom.backup',
		digest: null,
		started_at: '2026-10-09T11:00:00Z',
		finished_at: '2026-10-09T11:20:00Z',
		recorded_at: '2026-10-09T11:20:01.000Z',
	};

	function imagePanel(dir: string, image = 'ghcr.io/dedalia-org/dedalo', mode = 'pull') {
		return consumerStatus(superuser, {
			backupDir: PANEL_BACKUP_DIR,
			waitMs: 60_000,
			channel: 'image',
			image: { sourceGetter: getter(image, mode), dir, now: NOW },
		});
	}

	test('tree_swap (the seam, and this real checkout): no `image` key at all', async () => {
		const seamed = await consumerStatus(superuser, {
			backupDir: PANEL_BACKUP_DIR,
			waitMs: 60_000,
			channel: 'tree_swap',
			image: { dir: channelDir({ 'host_updater.json': beat(5) }), now: NOW },
		});
		expect('image' in seamed).toBe(false);
		// the real filesystem of a dev checkout is tree_swap too (positive control
		// that the default path asks channel.ts, not the seam)
		expect(detectDeploymentChannel(projectRoot)).toBe('tree_swap');
		expect('image' in (await panel(superuser))).toBe(false);
	});

	test('image: the block is present, and `checks` / `ready` are the tree-swap truth unchanged', async () => {
		const status = await imagePanel(channelDir());
		expect(status.image).toBeDefined();
		const channel = byId(status.checks, 'channel');
		expect(channel).toEqual({ id: 'channel', state: 'blocked', detail: 'image' });
		expect(status.ready).toBe(false);
		expect(status.image?.update_command).toEqual({
			program: 'deploy/dedalo-image-update.sh',
			version_flag: '--version',
		});
		// the command names a program that exists in this tree
		expect(existsSync(join(projectRoot, status.image?.update_command.program ?? ''))).toBe(true);
	});

	test('source: every provisioned official entry of the REAL list is named as itself', async () => {
		const provisioned = provisionedRegistries(loadImageRegistries());
		// anti-vacuity: the list publishes somewhere (GHCR is provisioned from day one)
		expect(provisioned.length).toBeGreaterThan(0);
		const dir = channelDir();
		for (const entry of provisioned) {
			const source = (await imagePanel(dir, entry.repository as string)).image?.source;
			expect(source).toEqual({
				mode: 'pull',
				repository: entry.repository,
				official: { id: entry.id, label: entry.label, role: entry.role },
			});
		}
	});

	test('source: primary vs mirror vs custom, a build, and an invalid declaration', async () => {
		const dir = channelDir();
		const list = (): ImageRegistryList => ({
			schema: 1,
			signing: { issuer: 'https://issuer.example', identity_regexp: '^x$' },
			ci: { staging_repository: 'ghcr.io/test/dedalo-build' },
			registries: [
				{
					id: 'ours',
					label: 'Ours',
					role: 'primary',
					repository: 'registry.test.example/dedalo/dedalo',
					provisioned: true,
					reason: null,
					auth: { kind: 'github_token' },
				},
				{
					id: 'mirror',
					label: 'Mirror',
					role: 'mirror',
					repository: 'ghcr.io/test/dedalo',
					provisioned: true,
					reason: null,
					auth: { kind: 'github_token' },
				},
				{
					id: 'later',
					label: 'Later',
					role: 'mirror',
					repository: null,
					provisioned: false,
					reason: 'not yet',
					auth: { kind: 'github_token' },
				},
			],
		});
		const seamed = async (image: string) =>
			(
				await consumerStatus(superuser, {
					backupDir: PANEL_BACKUP_DIR,
					waitMs: 60_000,
					channel: 'image',
					image: { sourceGetter: getter(image, 'pull'), registries: list, dir, now: NOW },
				})
			).image?.source.official;
		expect(await seamed('registry.test.example/dedalo/dedalo')).toEqual({
			id: 'ours',
			label: 'Ours',
			role: 'primary',
		});
		expect(await seamed('GHCR.IO/test/dedalo')).toBeNull(); // not a valid (lowercase) reference
		expect(await seamed('ghcr.io/test/dedalo')).toEqual({
			id: 'mirror',
			label: 'Mirror',
			role: 'mirror',
		});
		expect(await seamed('ghcr.io/test/other')).toBeNull();
		const custom = (await imagePanel(dir, 'registry.example.org/museum/dedalo')).image?.source;
		expect(custom?.official).toBeNull();
		expect(custom?.repository).toBe('registry.example.org/museum/dedalo');
		const build = (await imagePanel(dir, 'localhost/dedalo', 'build')).image?.source;
		expect(build).toEqual({ mode: 'build', repository: 'localhost/dedalo', official: null });
		const invalid = (await imagePanel(dir, 'ghcr.io/dedalia-org/dedalo:7.0.1', 'sideload')).image
			?.source;
		expect(invalid).toEqual({ mode: null, repository: null, official: null });
	});

	test('an unreadable registry list degrades `official` to null, never a throw', async () => {
		const status = await consumerStatus(superuser, {
			backupDir: PANEL_BACKUP_DIR,
			waitMs: 60_000,
			channel: 'image',
			image: {
				sourceGetter: getter('ghcr.io/dedalia-org/dedalo', 'pull'),
				registries: () => {
					throw new Error('broken list');
				},
				dir: channelDir(),
				now: NOW,
			},
		});
		expect(status.image?.source.official).toBeNull();
		expect(status.image?.source.repository).toBe('ghcr.io/dedalia-org/dedalo');
	});

	test('host updater: absent, alive and stale at the max(3 × interval, 180 s) threshold', async () => {
		const state = async (files: Record<string, unknown>) =>
			(await imagePanel(channelDir(files))).image?.host_updater.state;
		expect(await state({})).toBe('absent');
		// interval 60 → the 180 s floor rules
		expect(await state({ 'host_updater.json': beat(180) })).toBe('alive');
		expect(await state({ 'host_updater.json': beat(181) })).toBe('stale');
		// interval 120 → 3 × 120 = 360 s
		expect(await state({ 'host_updater.json': beat(360, 120) })).toBe('alive');
		expect(await state({ 'host_updater.json': beat(361, 120) })).toBe('stale');
		const alive = (await imagePanel(channelDir({ 'host_updater.json': beat(10) }))).image
			?.host_updater;
		expect(alive).toEqual({
			state: 'alive',
			seen_at: ago(10),
			interval_seconds: 60,
			mode: 'pull',
			image: 'ghcr.io/dedalia-org/dedalo',
			pinned: '7.0.0',
			verify: 'cosign',
			running_digest: null,
		});
	});

	test('request, inflight and outcome are reflected (the claimed one wins)', async () => {
		const requested = (await imagePanel(channelDir({ 'request.json': REQUEST }))).image;
		const { schema: _schema, ...wire } = REQUEST;
		expect(requested?.request as unknown).toEqual({
			...wire,
			state: 'requested',
			claimed_at: null,
		});

		const claimedAt = ago(5);
		const claimed = (
			await imagePanel(channelDir({ 'inflight.json': { ...REQUEST, claimed_at: claimedAt } }))
		).image;
		expect(claimed?.request as unknown).toEqual({
			...wire,
			state: 'claimed',
			claimed_at: claimedAt,
		});

		const done = (await imagePanel(channelDir({ 'last_outcome.json': OUTCOME }))).image;
		expect(done?.request).toBeNull();
		expect(done?.last_outcome as unknown).toEqual(OUTCOME);
	});

	test('malformed channel files never throw: each reads as absent', async () => {
		for (const garbage of ['{', '[]', '"x"', JSON.stringify({ ...REQUEST, tag: '9.9.9' })]) {
			const status = await imagePanel(
				channelDir({
					'host_updater.json': garbage,
					'request.json': garbage,
					'inflight.json': garbage,
					'last_outcome.json': garbage,
				}),
			);
			expect(status.image?.host_updater.state).toBe('absent');
			expect(status.image?.request).toBeNull();
			expect(status.image?.last_outcome).toBeNull();
		}
		// an extra key is a malformed file too (closed shapes)
		const extra = await imagePanel(
			channelDir({
				'last_outcome.json': { ...OUTCOME, note: 'x' },
				'host_updater.json': { ...beat(1), x: 1 },
			}),
		);
		expect(extra.image?.last_outcome).toBeNull();
		expect(extra.image?.host_updater.state).toBe('absent');
	});

	test('every machine id the block can send has its label (the client words them)', () => {
		const ids = [
			...['alive', 'stale', 'absent'].map((state) => `update_code_host_updater_${state}`),
			...['requested', 'claimed'].map((state) => `update_code_image_request_${state}`),
			...['green', 'rolled_back', 'rollback_failed', 'refused', 'failed'].map(
				(status) => `update_code_image_outcome_${status}`,
			),
			...['pull', 'build'].map((mode) => `update_code_image_mode_${mode}`),
			...['primary', 'mirror'].map((role) => `update_code_image_official_${role}`),
		];
		expect(ids.filter((key) => labels[key] === undefined)).toEqual([]);
	});
});
