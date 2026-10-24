/**
 * Code update (UPDATE_PROCESS Phase 4, WC-024) — the strict linear guard, the
 * archive hardening (magic sniff, zipinfo pre-validation rejecting zip-slip +
 * symlink entries), the manifest linear-path builder, and the full CLEAN-ONLY
 * download→verify→extract→deps→preflight→swap chain exercised against a
 * SYNTHETIC release in a TEMP tree (never projectRoot — the live swap is an
 * operator drill). Needs the `zip`/`unzip` CLIs; the CANARY test below FAILS
 * when they are absent, so the swap chain can never go vacuously green on a
 * zip-less machine (the per-test `if (!zipAvailable) return;` early-outs are
 * covered by that one loud failure).
 *
 * Since 2026-08-23 `updateCode` takes the acting Principal and runs the FULL
 * precondition gate (superuser + maintenance mode + required backup), so every
 * pipeline test drives a SUPERUSER with maintenance mode ON (scratch state
 * file — the S1-18 guard below) and an explicit backup waiver, with
 * installDeps/smokeBoot seam no-ops. The preconditions themselves are gated in
 * test/unit/update_preconditions.test.ts.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	chmodSync,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as realConfigModule from '../../src/config/config.ts';
import { readEnv } from '../../src/config/env.ts';
import { resolvePgRestore } from '../../src/core/area_maintenance/backup.ts';
import { setServerState } from '../../src/core/resolve/server_state.ts';
import type { Principal } from '../../src/core/security/permissions.ts';
import { confirmBootedCodeUpdate } from '../../src/core/update/boot_confirm.ts';
import { UPDATE_CATALOG } from '../../src/core/update/catalog.ts';
import { buildCodeUpdateInfo, linearUpgradeTargets } from '../../src/core/update/code_manifest.ts';
import { restoreCode } from '../../src/core/update/code_restore.ts';
import {
	acquireRunLockOrRefuse,
	assertLinearUpgrade,
	type CodeUpdateSeams,
	codeRunLockPath,
	extractArchive,
	preValidateArchive,
	refuseUnaccountedLiveEntries,
	releaseExcludedRootEntriesOf,
	type UpdatePhaseFrame,
	unwritableSwapDirs,
	updateCode,
} from '../../src/core/update/code_update.ts';
import { INSTALL_STAMP_PATH, type InstallChannel } from '../../src/core/update/install_stamp.ts';
import * as realOwnershipModule from '../../src/core/update/ownership.ts';
import {
	PUBLICATION_MANIFEST_PATH,
	verifyPublicationTree,
} from '../../src/core/update/publication_manifest.ts';
import { compareVersionArrays, DEDALO_VERSION_TRIPLE } from '../../src/core/update/version.ts';
import { ageMinutes, buildRealArchive, truncatedCopy } from '../helpers/real_backup_archive.ts';
import { refusalOf, refusalOfSync } from '../helpers/refusal.ts';
import { scratchDir } from '../helpers/scratch_dir.ts';

// Capture the REAL modules ONCE at top level; mock.restore() does NOT revert
// mock.module, so afterAll re-installs them — a per-test `await import()` would
// leak the mocked ownership into other suites (the closed-mode assertions).
const REAL_OWNERSHIP = { ...realOwnershipModule };
const REAL_CONFIG = { ...realConfigModule };

const STATE_PATH = readEnv('DEDALO_TS_STATE_PATH');
if (STATE_PATH === undefined) {
	// Scratch state file required (S1-18): these tests flip maintenance_mode.
	throw new Error(
		'code_update.test.ts: DEDALO_TS_STATE_PATH is not set — refusing to run against the live server state file (S1-18)',
	);
}

const SUPERUSER: Principal = { userId: -1, isGlobalAdmin: true, isDeveloper: true } as Principal;

const ROOT = scratchDir('code_update');
let zipAvailable = false;

beforeAll(async () => {
	mkdirSync(ROOT, { recursive: true });
	const probe = Bun.spawn(['zip', '--version'], { stdout: 'ignore', stderr: 'ignore' });
	zipAvailable = (await probe.exited) === 0;
	setServerState({ maintenance_mode: true });
});
afterAll(() => {
	setServerState({ maintenance_mode: false });
	mock.module('../../src/core/update/ownership.ts', () => REAL_OWNERSHIP);
	mock.module('../../src/config/config.ts', () => REAL_CONFIG);
	mock.restore();
	rmSync(ROOT, { recursive: true, force: true });
});

/**
 * Build a `dedalo_code/`-rooted release zip carrying the tree markers.
 * `.bun-version` pins the RUNNING Bun.version so the pin gate in the pipeline
 * stays LIVE (a hardcoded pin would make every pipeline test exercise the
 * refusal instead of the path under test).
 */
/**
 * A synthetic release archive. It carries the build stamp `git archive` writes
 * into every real one (build_info.txt with its exact tag), naming `identity` —
 * the swap refuses a quarantine that calls itself anything but the release the
 * request names (refuseForeignQuarantine).
 */
async function buildReleaseZip(
	dir: string,
	extra?: (codeDir: string) => void,
	identity = '7.0.1',
): Promise<string> {
	const stage = join(dir, 'stage');
	const codeDir = join(stage, 'dedalo_code');
	mkdirSync(join(codeDir, 'src', 'core', 'update'), { recursive: true });
	writeFileSync(
		join(codeDir, 'src', 'core', 'update', 'build_info.txt'),
		`${'a'.repeat(40)} 2026-10-18T00:00:00Z v${identity}\n`,
	);
	writeFileSync(join(codeDir, 'package.json'), '{"name":"dedalo"}');
	writeFileSync(join(codeDir, 'src', 'server.ts'), '// server');
	writeFileSync(join(codeDir, '.bun-version'), Bun.version);
	writeFileSync(join(codeDir, 'src', 'new_file.ts'), '// new in this release');
	extra?.(codeDir);
	const zipPath = join(dir, 'release.zip');
	const child = Bun.spawn(['zip', '-r', '-q', zipPath, 'dedalo_code'], {
		cwd: stage,
		stdout: 'ignore',
		stderr: 'pipe',
	});
	if ((await child.exited) !== 0) throw new Error('zip build failed');
	return zipPath;
}

/** A minimal LIVE tree whose root entries are all shipped by buildReleaseZip. */
function buildLiveTree(targetRoot: string): void {
	mkdirSync(join(targetRoot, 'src'), { recursive: true });
	writeFileSync(join(targetRoot, 'package.json'), '{"name":"old"}');
	writeFileSync(join(targetRoot, 'src', 'stale.ts'), '// removed in the new release');
	writeFileSync(join(targetRoot, '.bun-version'), Bun.version);
}

/** Recursive content digest of a tree — the "byte-identical" assertion. */
function treeDigest(dir: string): string {
	const hash = createHash('sha256');
	const walk = (d: string): void => {
		for (const name of readdirSync(d).sort()) {
			const full = join(d, name);
			const stat = lstatSync(full);
			hash.update(name);
			if (stat.isDirectory()) walk(full);
			else hash.update(readFileSync(full));
		}
	};
	walk(dir);
	return hash.digest('hex');
}

/**
 * An EMPTY scratch database-backup dir. Every run here waives the backup, and
 * the waiver's audit line still LOOKS at the backup dir (a bounded verification
 * scan) — without this seam that look would read, and write verification
 * sidecars into, the installation's ../private/backups/db.
 */
const SCRATCH_DB_BACKUP_DIR = mkdtempSync(join(tmpdir(), 'dedalo_code_update_db_backups_'));
afterAll(() => {
	rmSync(SCRATCH_DB_BACKUP_DIR, { recursive: true, force: true });
});

/** Default no-op pipeline seams + backup waiver options for a swap test. */
function pipelineSeams(overrides: Partial<CodeUpdateSeams> = {}): CodeUpdateSeams {
	return {
		// The walk starts from the STABLE release of the data version unless a case
		// says otherwise: the checkout's own identity is `.dev` on a branch and the
		// tag on a release commit, and no verdict here may move with that.
		runningRelease: DEDALO_VERSION_TRIPLE.join('.'),
		// …and from an UNSTAMPED tree: the checkout's own install stamp (if any)
		// must not grant a case the dev standing (code_update.ts walkChannelOf)
		runningChannel: null,
		restart: () => {},
		supervised: true,
		installDeps: async () => {},
		smokeBoot: async () => {},
		channel: 'tree_swap',
		databaseBackupDir: SCRATCH_DB_BACKUP_DIR,
		...overrides,
	};
}

function mockUpdateEnv(origin: string): void {
	mock.module('../../src/core/update/ownership.ts', () => ({
		...REAL_OWNERSHIP,
		engineOwnsInstall: () => true,
	}));
	mock.module('../../src/config/config.ts', () => ({
		...REAL_CONFIG,
		config: {
			...REAL_CONFIG.config,
			update: {
				...REAL_CONFIG.config.update,
				codeServers: [{ name: 'm', url: `${origin}/`, code: 'c' }],
			},
		},
	}));
}

function unmockUpdateEnv(): void {
	mock.module('../../src/core/update/ownership.ts', () => REAL_OWNERSHIP);
	mock.module('../../src/config/config.ts', () => REAL_CONFIG);
	mock.restore();
}

describe('assertLinearUpgrade (strict path backstop)', () => {
	test('downgrade / same-version refused, legal rungs allowed, skips refused', () => {
		expect(assertLinearUpgrade([7, 0, 0], [6, 9, 9])).toContain('downgrade');
		expect(assertLinearUpgrade([7, 0, 0], [7, 0, 0])).toContain('downgrade');
		expect(assertLinearUpgrade([7, 0, 0], [7, 0, 1])).toBeNull(); // next patch
		expect(assertLinearUpgrade([7, 0, 5], [7, 1, 0])).toBeNull(); // next minor .0
		expect(assertLinearUpgrade([7, 3, 0], [8, 0, 0])).toBeNull(); // next major .0.0
		expect(assertLinearUpgrade([7, 0, 0], [9, 0, 0])).toContain('major version skip');
		expect(assertLinearUpgrade([7, 0, 0], [7, 2, 0])).toContain('minor version skip');
		expect(assertLinearUpgrade([7, 0, 0], [7, 1, 3])).toContain('must land on .0');
	});

	// The PATCH AXIS. `versionSkipReason` did not destructure `cPatch` at all,
	// so an arbitrary patch jump passed the swap path's only version gate — and
	// the client-supplied sha matches the skipped-to release's real published
	// sidecar, so nothing downstream caught it either.
	test('a patch skip is refused (the axis the guard never read)', () => {
		expect(assertLinearUpgrade([7, 0, 0], [7, 0, 2])).toContain('patch version skip');
		expect(assertLinearUpgrade([7, 0, 0], [7, 0, 3])).toContain('patch version skip');
		expect(assertLinearUpgrade([7, 0, 0], [7, 0, 99999])).toContain('patch version skip');
		expect(assertLinearUpgrade([7, 0, 1], [7, 0, 3])).toContain('patch version skip');
		// …and the legal rung from each of those is still legal.
		expect(assertLinearUpgrade([7, 0, 1], [7, 0, 2])).toBeNull();
		expect(assertLinearUpgrade([7, 0, 2], [7, 0, 3])).toBeNull();
	});

	// The two notions of "next rung" — the manifest's (what a master OFFERS)
	// and the swap guard's (what a consumer ACCEPTS) — are written separately
	// and must never disagree: anything advertised has to be installable.
	test('every rung the manifest advertises passes the swap guard', () => {
		for (const current of [
			[7, 0, 0],
			[7, 0, 1],
			[7, 0, 2],
			[7, 0, 3],
			[7, 1, 4],
			[8, 2, 0],
		]) {
			for (const target of linearUpgradeTargets(current)) {
				expect(assertLinearUpgrade(current, target)).toBeNull();
			}
		}
	});
});

describe('linearUpgradeTargets + buildCodeUpdateInfo (the LIVE catalog)', () => {
	// BRANCH COVERAGE FOR BOTH FUNCTIONS LIVES IN test/unit/code_manifest.test.ts,
	// driven through the injectable `catalog` parameter. What is pinned here is
	// the stock-master FACT for the CURRENT catalog: the ONE real rung, 7.0.0 →
	// 7.0.1. The probe-only '702'/'703' that used to sit beside it are gone —
	// see the "may not run ahead of the engine" tripwire below for why.
	// A client is offered exactly its next patch rung; the manifest advertises
	// no file while no archive exists on disk for that rung.
	test('the stock catalog offers exactly the real 7.0.0 → 7.0.1 rung', () => {
		expect(Object.keys(UPDATE_CATALOG).sort()).toEqual(['701']);
		expect(linearUpgradeTargets([7, 0, 0])).toEqual([[7, 0, 1]]);
		// …and nothing beyond it: a museum already on 7.0.1 is offered nothing,
		// which is the HONEST answer until a 7.0.2 is really cut.
		expect(linearUpgradeTargets([7, 0, 1])).toEqual([]);
		expect(linearUpgradeTargets([7, 0, 2])).toEqual([]);
		const info = buildCodeUpdateInfo({
			clientVersion: [7, 0, 0],
			serverVersion: [7, 0, 0],
			codeFilesDir: undefined,
			publicBaseUrl: 'http://m/x',
			info: { date: 'now', entity_id: 1, entity: 'e', host: '' },
		});
		expect(info.files).toEqual([]);
		expect(info.info.version).toBe('7.0.0');
	});
});

describe('zip CLI canary (no vacuous green)', () => {
	// Every swap-chain test early-outs when the `zip` CLI is missing; this
	// canary turns that silent skip into ONE loud red, so a zip-less machine
	// can never report the whole chain green without exercising it.
	test('the zip CLI is available — the swap-chain gates above/below are LIVE', () => {
		expect(zipAvailable).toBe(true);
	});
});

describe('archive hardening', () => {
	test('preValidateArchive rejects a zip-slip entry name', async () => {
		if (!zipAvailable) return;
		const dir = join(ROOT, 'slip');
		mkdirSync(join(dir, 'stage'), { recursive: true });
		// craft an archive whose entry escapes dedalo_code/
		writeFileSync(join(dir, 'stage', 'evil'), 'x');
		const zipPath = join(dir, 'slip.zip');
		// zip stores the literal name 'evil' (no dedalo_code/ prefix)
		const child = Bun.spawn(['zip', '-q', zipPath, 'evil'], {
			cwd: join(dir, 'stage'),
			stdout: 'ignore',
			stderr: 'ignore',
		});
		await child.exited;
		expect(await preValidateArchive(zipPath)).toContain('unsafe archive entry');
	});

	test('preValidateArchive rejects a symlink entry', async () => {
		if (!zipAvailable) return;
		const dir = join(ROOT, 'symlink');
		const codeDir = join(dir, 'stage', 'dedalo_code');
		mkdirSync(codeDir, { recursive: true });
		writeFileSync(join(codeDir, 'real.txt'), 'real');
		try {
			symlinkSync('/etc/passwd', join(codeDir, 'link'));
		} catch {
			// LOUD skip — the symlink-entry gate is NOT exercised in this sandbox.
			console.warn(
				'[code_update.test] SKIP: symlink creation unsupported in this sandbox — the symlink-entry rejection gate was not exercised',
			);
			return;
		}
		const zipPath = join(dir, 'symlink.zip');
		// -y preserves the symlink as a symlink entry
		const child = Bun.spawn(['zip', '-r', '-y', '-q', zipPath, 'dedalo_code'], {
			cwd: join(dir, 'stage'),
			stdout: 'ignore',
			stderr: 'ignore',
		});
		await child.exited;
		expect(await preValidateArchive(zipPath)).toContain('symlink');
	});

	test('preValidateArchive accepts a clean dedalo_code archive', async () => {
		if (!zipAvailable) return;
		const zipPath = await buildReleaseZip(join(ROOT, 'clean'));
		expect(await preValidateArchive(zipPath)).toBeNull();
	});

	test('extractArchive yields the dedalo_code root with the markers', async () => {
		if (!zipAvailable) return;
		const zipPath = await buildReleaseZip(join(ROOT, 'extract'));
		const codeRoot = await extractArchive(zipPath, join(ROOT, 'extract', 'q'));
		expect(existsSync(join(codeRoot, 'package.json'))).toBe(true);
		expect(existsSync(join(codeRoot, 'src', 'server.ts'))).toBe(true);
	});

	test('extractArchive rejects a tree without the markers', async () => {
		if (!zipAvailable) return;
		const dir = join(ROOT, 'nomark', 'stage', 'dedalo_code');
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, 'random.txt'), 'x');
		const zipPath = join(ROOT, 'nomark', 'r.zip');
		const child = Bun.spawn(['zip', '-r', '-q', zipPath, 'dedalo_code'], {
			cwd: join(ROOT, 'nomark', 'stage'),
			stdout: 'ignore',
			stderr: 'ignore',
		});
		await child.exited;
		// A registered refusal (`update.refused`); the marker sentence is both the
		// log message and the operator-facing publicMessage.
		const refusal = await refusalOf(extractArchive(zipPath, join(ROOT, 'nomark', 'q')));
		expect(refusal.code).toBe('update.refused');
		expect(refusal.message).toMatch(/not a Dédalo tree/);
	});
});

// ('updateCode refusals — engine does not own the install' retired at the
// 2026-07-11 cutover: engineOwnsInstall() is collapsed to true, so the
// ownership refusal is unreachable at runtime. The version/marker/hash
// refusals below are the surviving guards.)

describe('full swap chain against a synthetic release (mocked gate, temp tree)', () => {
	test('clean swap installs the new tree, backs the old one up (node_modules INCLUDED), and writes the pending sentinel', async () => {
		if (!zipAvailable) return;
		const base = join(ROOT, 'swap');
		const zipPath = await buildReleaseZip(base);
		const sha = createHash('sha256').update(readFileSync(zipPath)).digest('hex');

		// serve the release over a local origin the config "code server" matches
		const server = Bun.serve({ port: 0, fetch: () => new Response(readFileSync(zipPath)) });
		const origin = `http://localhost:${server.port}`;

		// the live tree we will swap (a temp dir, NOT projectRoot)
		const targetRoot = join(base, 'live');
		buildLiveTree(targetRoot);
		// the old tree's node_modules: NOT carried into the new tree; it must
		// land IN THE BACKUP — that is what makes the supervisor-side rollback
		// bootable offline (deploy/dedalo-code-rollback.sh's load-bearing note).
		mkdirSync(join(targetRoot, 'node_modules', 'dep'), { recursive: true });
		writeFileSync(join(targetRoot, 'node_modules', 'dep', 'index.js'), '// old dep');
		// .git IS preserved into the new tree
		mkdirSync(join(targetRoot, '.git'), { recursive: true });
		writeFileSync(join(targetRoot, '.git', 'HEAD'), 'ref: refs/heads/v7');
		const backupRoot = join(base, 'backups');

		try {
			mockUpdateEnv(origin);
			let restarted = '';
			const frames: UpdatePhaseFrame[] = [];
			const out = await updateCode(
				{
					file: { version: '7.0.1', url: `${origin}/7.0.1.zip`, sha256: sha },
					waive_backup: true,
				},
				SUPERUSER,
				pipelineSeams({
					targetRoot,
					backupRoot,
					restart: (r) => {
						restarted = r;
					},
					onPhase: (frame) => frames.push(frame),
				}),
			);

			// Envelope v2: `data` names the installed release; `msg` is an extension
			// key. `update_mode` LEFT the wire (WC-2026-08-23-update-mode-clean-only).
			expect(out.ok).toBe(true);
			expect(out.data).toEqual({ version: '7.0.1' });
			expect(out.msg).toContain('Installed Dédalo 7.0.1');
			expect(restarted).toContain('7.0.1');
			// the new tree landed (marker + new file), the stale file is gone
			expect(existsSync(join(targetRoot, 'src', 'new_file.ts'))).toBe(true);
			expect(existsSync(join(targetRoot, 'src', 'stale.ts'))).toBe(false);
			// .git preserved into the new tree; node_modules NOT carried forward
			expect(existsSync(join(targetRoot, '.git', 'HEAD'))).toBe(true);
			expect(existsSync(join(targetRoot, 'node_modules', 'dep', 'index.js'))).toBe(false);
			// the old tree was backed up WITH its node_modules (rollback bootability)
			const backups = readdirSync(backupRoot).filter((n) => n.startsWith('dedalo_'));
			expect(backups.length).toBe(1);
			const backupDir = join(backupRoot, backups[0] as string);
			expect(readFileSync(join(backupDir, 'package.json'), 'utf8')).toBe('{"name":"old"}');
			expect(existsSync(join(backupDir, 'node_modules', 'dep', 'index.js'))).toBe(true);
			// THE SENTINEL (deploy/dedalo-code-rollback.sh contract): pending,
			// flat, exact keys, backupDir names an existing dir.
			const sentinel = JSON.parse(
				readFileSync(join(backupRoot, 'last_code_update.json'), 'utf8'),
			) as Record<string, unknown>;
			// `installDigest` JOINED the sentinel on 2026-08-24 (dev channel): it is
			// what boot_confirm.ts compares, because a same-version install leaves
			// `version` unable to tell the new tree from the rolled-back old one.
			expect(sentinel).toEqual({
				version: '7.0.1',
				previousVersion: '7.0.0',
				updateMode: 'clean',
				stamp: sentinel.stamp,
				backupDir,
				installDigest: sha,
				status: 'pending',
				rollback_attempted: false,
				// This fixture drives the swap with `waive_backup: true`, so the
				// sentinel must SAY the tree was installed with no verified restore
				// point behind it (P2-16 / LIFE-06). Before 2026-08-31 the waiver's
				// only record was a console.warn that journald eventually rotated
				// away — and this test, which waives on every run, could not tell.
				backup_waived: true,
			});
			// A release install stamps the tree too, on the master channel — so a
			// published tree keeps its release posture and its plain version string.
			const installStamp = JSON.parse(
				readFileSync(join(targetRoot, 'src', 'core', 'update', 'install_stamp.json'), 'utf8'),
			) as Record<string, unknown>;
			expect(installStamp).toMatchObject({ digest: sha, channel: 'master' });
			// …and records the ARCHIVE's root (the next update's retired-entry
			// evidence): what landed, minus what the swap added (deps) or carried.
			expect(installStamp.root_entries).toEqual(
				readdirSync(targetRoot)
					.filter((name) => name !== 'node_modules' && name !== '.git')
					.sort(),
			);
			expect(existsSync(sentinel.backupDir as string)).toBe(true);
			// phase frames: the last one before the restart carries expected_version
			const last = frames.at(-1) as UpdatePhaseFrame;
			expect(last.phase).toBe('restart');
			expect(last.expected_version).toBe('7.0.1');
			expect(frames.map((f) => f.phase)).toEqual([
				'download',
				'verify',
				'extract',
				'deps',
				'preflight',
				'swap',
				'restart',
			]);
		} finally {
			server.stop(true);
			unmockUpdateEnv();
		}
	}, 60000);

	test('a job STOPPED before the swap never swaps: live tree, sentinel and code backups untouched', async () => {
		if (!zipAvailable) return;
		// The stop lands while the run is past its last await before the swap (the
		// smoke boot): the pre-swap re-check is the only thing between a stopped
		// job and a replaced live tree plus a restart.
		const base = join(ROOT, 'stopped_before_swap');
		const zipPath = await buildReleaseZip(base);
		const sha = createHash('sha256').update(readFileSync(zipPath)).digest('hex');
		const server = Bun.serve({ port: 0, fetch: () => new Response(readFileSync(zipPath)) });
		const origin = `http://localhost:${server.port}`;
		const targetRoot = join(base, 'live');
		buildLiveTree(targetRoot);
		const before = treeDigest(targetRoot);
		const backupRoot = join(base, 'backups');
		const job = new AbortController();
		let restarted = false;
		try {
			mockUpdateEnv(origin);
			const refusal = await refusalOf(
				updateCode(
					{
						file: { version: '7.0.1', url: `${origin}/7.0.1.zip`, sha256: sha },
						waive_backup: true,
					},
					SUPERUSER,
					pipelineSeams({
						targetRoot,
						backupRoot,
						signal: job.signal,
						smokeBoot: async () => {
							job.abort();
						},
						restart: () => {
							restarted = true;
						},
					}),
				),
			);
			expect(refusal.code).toBe('update.refused');
			expect(refusal.message).toContain('stopped before the swap');
			expect(restarted).toBe(false);
			expect(treeDigest(targetRoot)).toBe(before);
			expect(existsSync(join(backupRoot, 'last_code_update.json'))).toBe(false);
			const codeBackups = existsSync(backupRoot)
				? readdirSync(backupRoot).filter((name) => name.startsWith('dedalo_'))
				: [];
			expect(codeBackups).toEqual([]);
		} finally {
			server.stop(true);
			unmockUpdateEnv();
		}
	}, 60000);

	test('a checksum mismatch refuses before any tree touch', async () => {
		if (!zipAvailable) return;
		const base = join(ROOT, 'badsha');
		const zipPath = await buildReleaseZip(base);
		const server = Bun.serve({ port: 0, fetch: () => new Response(readFileSync(zipPath)) });
		const origin = `http://localhost:${server.port}`;
		const targetRoot = join(base, 'live');
		buildLiveTree(targetRoot);
		try {
			mockUpdateEnv(origin);
			// P1 sweep: a gate REFUSES BY THROWING, and the refusal keeps its own
			// code — the catch-all must not launder it into a generic update.failed.
			const refusal = await refusalOf(
				updateCode(
					{
						file: { version: '7.0.1', url: `${origin}/7.0.1.zip`, sha256: 'a'.repeat(64) },
						waive_backup: true,
					},
					SUPERUSER,
					pipelineSeams({ targetRoot, backupRoot: join(base, 'b') }),
				),
			);
			expect(refusal.code).toBe('update.refused');
			expect(refusal.message).toContain('checksum mismatch');
			// the live tree is untouched
			expect(readFileSync(join(targetRoot, 'package.json'), 'utf8')).toBe('{"name":"old"}');
		} finally {
			server.stop(true);
			unmockUpdateEnv();
		}
	}, 60000);

	test('a FULL DISK refuses before anything is fetched (the space gate precedes the download)', async () => {
		// 2026-08-25: a remote install downloaded, verified and extracted a
		// release and only then died inside `bun install` with a wall of
		// NoSpaceLeft. The gate must spend nothing to say no — so: no request
		// reaches the server, and the live tree is untouched.
		let fetched = 0;
		const server = Bun.serve({
			port: 0,
			fetch: () => {
				fetched += 1;
				return new Response('should never be requested');
			},
		});
		const origin = `http://localhost:${server.port}`;
		const base = join(ROOT, 'nospace');
		const targetRoot = join(base, 'live');
		buildLiveTree(targetRoot);
		try {
			mockUpdateEnv(origin);
			const refusal = await refusalOf(
				updateCode(
					{
						file: { version: '7.0.1', url: `${origin}/7.0.1.zip`, sha256: 'a'.repeat(64) },
						waive_backup: true,
					},
					SUPERUSER,
					pipelineSeams({
						targetRoot,
						backupRoot: join(base, 'b'),
						// a filesystem with one byte left, and a tree that needs more
						space: {
							available: () => 1,
							measure: async (dir) => (dir.endsWith('live') ? 500_000_000 : 0),
						},
					}),
				),
			);
			expect(refusal.code).toBe('update.refused');
			expect(refusal.message).toContain('disk space');
			expect(fetched).toBe(0);
			expect(readFileSync(join(targetRoot, 'package.json'), 'utf8')).toBe('{"name":"old"}');
		} finally {
			server.stop(true);
			unmockUpdateEnv();
		}
	}, 60000);

	test('a release with NO declared checksum is refused before anything is fetched (preconditions precede the download too)', async () => {
		// VERIFY-OR-REFUSE (2026-08-15). The check used to be `declaredSha !== '' &&
		// …`, so a request carrying no hash skipped verification entirely — and the
		// manifest never carried one, which made the whole integrity guarantee inert.
		// An unsigned release must now be un-installable, and the refusal must land
		// BEFORE the download: no request is made, no staging dir is written.
		let fetched = 0;
		const server = Bun.serve({
			port: 0,
			fetch: () => {
				fetched += 1;
				return new Response('should never be requested');
			},
		});
		const origin = `http://localhost:${server.port}`;
		const base = join(ROOT, 'nosha');
		const targetRoot = join(base, 'live');
		buildLiveTree(targetRoot);
		try {
			mockUpdateEnv(origin);
			for (const sha of [undefined, '', 'not-hex', 'a'.repeat(63), `${'A'.repeat(64)}`]) {
				const refusal = await refusalOf(
					updateCode(
						{
							file: {
								version: '7.0.1',
								url: `${origin}/7.0.1.zip`,
								...(sha === undefined ? {} : { sha256: sha }),
							},
							waive_backup: true,
						},
						SUPERUSER,
						pipelineSeams({ targetRoot, backupRoot: join(base, 'b') }),
					),
				);
				// typed refusal (P1 sweep): a missing/malformed digest is a caller fault
				expect(refusal.code).toBe('request.invalid_options');
				expect(refusal.message).toContain('checksum');
				expect(refusal.message).toContain('sha256 must be 64 hex chars');
			}
			// nothing was downloaded and the live tree never moved
			expect(fetched).toBe(0);
			expect(readFileSync(join(targetRoot, 'package.json'), 'utf8')).toBe('{"name":"old"}');
		} finally {
			server.stop(true);
			unmockUpdateEnv();
		}
	});

	test('the runtime-path CENSUS refuses before the download when runtime data lives inside the tree', async () => {
		// runtime_paths.ts geoip_dir is env-driven and readEnv sees runtime env
		// mutations — plant it INSIDE the temp targetRoot and the census must
		// name it (env key on the wire) before a single byte is fetched.
		let fetched = 0;
		const server = Bun.serve({
			port: 0,
			fetch: () => {
				fetched += 1;
				return new Response('never');
			},
		});
		const origin = `http://localhost:${server.port}`;
		const base = join(ROOT, 'census');
		const targetRoot = join(base, 'live');
		buildLiveTree(targetRoot);
		const previousGeoip = process.env.DEDALO_GEOIP_DIR;
		try {
			mockUpdateEnv(origin);
			process.env.DEDALO_GEOIP_DIR = join(targetRoot, 'geoip');
			const refusal = await refusalOf(
				updateCode(
					{
						file: { version: '7.0.1', url: `${origin}/7.0.1.zip`, sha256: 'a'.repeat(64) },
						waive_backup: true,
					},
					SUPERUSER,
					pipelineSeams({ targetRoot, backupRoot: join(base, 'b') }),
				),
			);
			expect(refusal.code).toBe('update.refused');
			expect(refusal.publicMessage).toContain('Runtime data lives inside the code tree');
			expect(refusal.publicMessage).toContain('DEDALO_GEOIP_DIR');
			expect(fetched).toBe(0);
		} finally {
			if (previousGeoip === undefined) delete process.env.DEDALO_GEOIP_DIR;
			else process.env.DEDALO_GEOIP_DIR = previousGeoip;
			server.stop(true);
			unmockUpdateEnv();
		}
	});

	test('a backupRoot INSIDE the target tree is refused (its own swap would move it)', async () => {
		const base = join(ROOT, 'backup_inside');
		const targetRoot = join(base, 'live');
		buildLiveTree(targetRoot);
		const server = Bun.serve({ port: 0, fetch: () => new Response('never') });
		const origin = `http://localhost:${server.port}`;
		try {
			mockUpdateEnv(origin);
			const refusal = await refusalOf(
				updateCode(
					{
						file: { version: '7.0.1', url: `${origin}/7.0.1.zip`, sha256: 'a'.repeat(64) },
						waive_backup: true,
					},
					SUPERUSER,
					pipelineSeams({ targetRoot, backupRoot: join(targetRoot, 'backups') }),
				),
			);
			expect(refusal.code).toBe('update.refused');
			expect(refusal.message).toContain('INSIDE the code tree');
		} finally {
			server.stop(true);
			unmockUpdateEnv();
		}
	});

	test('the image deployment channel refuses the swap and names the remedy', async () => {
		const base = join(ROOT, 'image_channel');
		const targetRoot = join(base, 'live');
		buildLiveTree(targetRoot);
		const server = Bun.serve({ port: 0, fetch: () => new Response('never') });
		const origin = `http://localhost:${server.port}`;
		const frames: { phase: string; phases: { id: string; status: string }[]; message?: string }[] =
			[];
		try {
			mockUpdateEnv(origin);
			const refusal = await refusalOf(
				updateCode(
					{
						file: { version: '7.0.1', url: `${origin}/7.0.1.zip`, sha256: 'a'.repeat(64) },
						waive_backup: true,
					},
					SUPERUSER,
					pipelineSeams({
						targetRoot,
						backupRoot: join(base, 'b'),
						channel: 'image',
						onPhase: (frame) => frames.push(frame),
					}),
				),
			);
			expect(refusal.code).toBe('update.refused');
			expect(refusal.publicMessage).toContain('container');
			expect(refusal.publicMessage).toContain('dedalo-image-update.sh');
			// A refusal BEFORE any phase started must still REACH the phase track:
			// it emitted nothing at all until 2026-08-23, so the likeliest first-run
			// outcome left the operator staring at an all-pending track.
			expect(frames.length).toBeGreaterThan(0);
			const last = frames[frames.length - 1] as (typeof frames)[number];
			expect(last.phases.some((p) => p.status === 'failed')).toBe(true);
			expect(String(last.message)).toContain('container');
		} finally {
			server.stop(true);
			unmockUpdateEnv();
		}
	});

	test('an UNKNOWN root entry (deploy certs, stray logs…) refuses the swap and names it', async () => {
		if (!zipAvailable) return;
		const base = join(ROOT, 'unknown_root');
		const zipPath = await buildReleaseZip(base);
		const sha = createHash('sha256').update(readFileSync(zipPath)).digest('hex');
		const server = Bun.serve({ port: 0, fetch: () => new Response(readFileSync(zipPath)) });
		const origin = `http://localhost:${server.port}`;
		const targetRoot = join(base, 'live');
		buildLiveTree(targetRoot);
		writeFileSync(join(targetRoot, 'server_key.pem'), 'SECRET'); // not shipped, not preserved
		try {
			mockUpdateEnv(origin);
			const refusal = await refusalOf(
				updateCode(
					{
						file: { version: '7.0.1', url: `${origin}/7.0.1.zip`, sha256: sha },
						waive_backup: true,
					},
					SUPERUSER,
					pipelineSeams({ targetRoot, backupRoot: join(base, 'b') }),
				),
			);
			expect(refusal.code).toBe('update.refused');
			expect(refusal.message).toContain('server_key.pem');
			// nothing swapped
			expect(readFileSync(join(targetRoot, 'package.json'), 'utf8')).toBe('{"name":"old"}');
		} finally {
			server.stop(true);
			unmockUpdateEnv();
		}
	}, 60000);

	test('a failing installDeps / smokeBoot leaves the target tree byte-identical', async () => {
		if (!zipAvailable) return;
		const base = join(ROOT, 'quarantine_fail');
		const zipPath = await buildReleaseZip(base);
		const sha = createHash('sha256').update(readFileSync(zipPath)).digest('hex');
		const server = Bun.serve({ port: 0, fetch: () => new Response(readFileSync(zipPath)) });
		const origin = `http://localhost:${server.port}`;
		const targetRoot = join(base, 'live');
		buildLiveTree(targetRoot);
		const before = treeDigest(targetRoot);
		try {
			mockUpdateEnv(origin);
			for (const failing of [
				{
					installDeps: async () => {
						throw new Error('registry unreachable');
					},
				},
				{
					smokeBoot: async () => {
						throw new Error('quarantine died');
					},
				},
			] as Partial<CodeUpdateSeams>[]) {
				const refusal = await refusalOf(
					updateCode(
						{
							file: { version: '7.0.1', url: `${origin}/7.0.1.zip`, sha256: sha },
							waive_backup: true,
						},
						SUPERUSER,
						pipelineSeams({ targetRoot, backupRoot: join(base, 'b'), ...failing }),
					),
				);
				expect(refusal.code).toBe('update.failed');
				expect(treeDigest(targetRoot)).toBe(before);
			}
		} finally {
			server.stop(true);
			unmockUpdateEnv();
		}
	}, 60000);

	test('a release pinning a DIFFERENT Bun is refused before any deps install', async () => {
		if (!zipAvailable) return;
		const base = join(ROOT, 'pin_mismatch');
		const zipPath = await buildReleaseZip(base, (codeDir) => {
			writeFileSync(join(codeDir, '.bun-version'), '0.0.1-not-this-bun');
		});
		const sha = createHash('sha256').update(readFileSync(zipPath)).digest('hex');
		const server = Bun.serve({ port: 0, fetch: () => new Response(readFileSync(zipPath)) });
		const origin = `http://localhost:${server.port}`;
		const targetRoot = join(base, 'live');
		buildLiveTree(targetRoot);
		try {
			mockUpdateEnv(origin);
			let depsRan = false;
			const refusal = await refusalOf(
				updateCode(
					{
						file: { version: '7.0.1', url: `${origin}/7.0.1.zip`, sha256: sha },
						waive_backup: true,
					},
					SUPERUSER,
					pipelineSeams({
						targetRoot,
						backupRoot: join(base, 'b'),
						installDeps: async () => {
							depsRan = true;
						},
					}),
				),
			);
			expect(refusal.code).toBe('update.refused');
			expect(refusal.publicMessage).toContain('pins Bun 0.0.1-not-this-bun');
			expect(depsRan).toBe(false);
		} finally {
			server.stop(true);
			unmockUpdateEnv();
		}
	}, 60000);

	test('a failed SECOND swap rename restores the backup in place (the pair is not atomic)', async () => {
		if (!zipAvailable) return;
		const base = join(ROOT, 'swap_restore');
		const zipPath = await buildReleaseZip(base);
		const sha = createHash('sha256').update(readFileSync(zipPath)).digest('hex');
		const server = Bun.serve({ port: 0, fetch: () => new Response(readFileSync(zipPath)) });
		const origin = `http://localhost:${server.port}`;
		const targetRoot = join(base, 'live');
		buildLiveTree(targetRoot);
		mkdirSync(join(targetRoot, '.git'), { recursive: true });
		writeFileSync(join(targetRoot, '.git', 'HEAD'), 'ref: refs/heads/v7');
		const before = treeDigest(targetRoot);
		const backupRoot = join(base, 'b');
		try {
			mockUpdateEnv(origin);
			const refusal = await refusalOf(
				updateCode(
					{
						file: { version: '7.0.1', url: `${origin}/7.0.1.zip`, sha256: sha },
						waive_backup: true,
					},
					SUPERUSER,
					pipelineSeams({
						targetRoot,
						backupRoot,
						renameIntoPlace: () => {
							throw new Error('injected rename failure');
						},
					}),
				),
			);
			expect(refusal.code).toBe('update.failed');
			expect(refusal.message).toContain('previous tree was restored');
			// the old tree is back IN PLACE, byte-identical, .git included
			expect(treeDigest(targetRoot)).toBe(before);
			// the pre-swap pending sentinel was RETRACTED (fully restored, no
			// backup dir left — nothing for the rollback script to do)
			expect(existsSync(join(backupRoot, 'last_code_update.json'))).toBe(false);
		} finally {
			server.stop(true);
			unmockUpdateEnv();
		}
	}, 60000);

	test('a failed FIRST swap rename (EBUSY mount point) leaves the live tree — .git included — untouched', async () => {
		if (!zipAvailable) return;
		const base = join(ROOT, 'first_rename_fail');
		const zipPath = await buildReleaseZip(base);
		const sha = createHash('sha256').update(readFileSync(zipPath)).digest('hex');
		const server = Bun.serve({ port: 0, fetch: () => new Response(readFileSync(zipPath)) });
		const origin = `http://localhost:${server.port}`;
		const targetRoot = join(base, 'live');
		buildLiveTree(targetRoot);
		mkdirSync(join(targetRoot, '.git'), { recursive: true });
		writeFileSync(join(targetRoot, '.git', 'HEAD'), 'ref: refs/heads/v7');
		const before = treeDigest(targetRoot);
		const backupRoot = join(base, 'b');
		try {
			mockUpdateEnv(origin);
			const refusal = await refusalOf(
				updateCode(
					{
						file: { version: '7.0.1', url: `${origin}/7.0.1.zip`, sha256: sha },
						waive_backup: true,
					},
					SUPERUSER,
					pipelineSeams({
						targetRoot,
						backupRoot,
						renameToBackup: () => {
							throw new Error('EBUSY: resource busy or locked (bind-mounted checkout)');
						},
					}),
				),
			);
			expect(refusal.code).toBe('update.failed');
			expect(refusal.message).toContain('first rename');
			// NOTHING moved: .git and every other entry still in the live tree
			expect(existsSync(join(targetRoot, '.git', 'HEAD'))).toBe(true);
			expect(treeDigest(targetRoot)).toBe(before);
			// staging swept (no stranded quarantine), pending sentinel retracted
			expect(existsSync(join(backupRoot, '.code_staging'))).toBe(false);
			expect(existsSync(join(backupRoot, 'last_code_update.json'))).toBe(false);
		} finally {
			server.stop(true);
			unmockUpdateEnv();
		}
	}, 60000);

	test('the pending sentinel is ON DISK, naming the intended backupDir, BEFORE the first swap rename', async () => {
		if (!zipAvailable) return;
		const base = join(ROOT, 'sentinel_order');
		const zipPath = await buildReleaseZip(base);
		const sha = createHash('sha256').update(readFileSync(zipPath)).digest('hex');
		const server = Bun.serve({ port: 0, fetch: () => new Response(readFileSync(zipPath)) });
		const origin = `http://localhost:${server.port}`;
		const targetRoot = join(base, 'live');
		buildLiveTree(targetRoot);
		const backupRoot = join(base, 'b');
		// The FIRST-rename seam observes the disk AT THE MOMENT the tree is
		// about to move — an end-state assertion could not prove the ordering.
		let observed: { status: unknown; backupDir: unknown; targetIntact: boolean } | null = null;
		try {
			mockUpdateEnv(origin);
			const out = await updateCode(
				{
					file: { version: '7.0.1', url: `${origin}/7.0.1.zip`, sha256: sha },
					waive_backup: true,
				},
				SUPERUSER,
				pipelineSeams({
					targetRoot,
					backupRoot,
					renameToBackup: (from, to) => {
						const sentinel = JSON.parse(
							readFileSync(join(backupRoot, 'last_code_update.json'), 'utf8'),
						) as Record<string, unknown>;
						observed = {
							status: sentinel.status,
							backupDir: sentinel.backupDir,
							targetIntact: existsSync(join(from, 'package.json')),
						};
						renameSync(from, to);
					},
				}),
			);
			expect(out.ok).toBe(true);
			expect(observed).not.toBeNull();
			const seen = observed as unknown as {
				status: unknown;
				backupDir: unknown;
				targetIntact: boolean;
			};
			expect(seen.status).toBe('pending');
			expect(seen.targetIntact).toBe(true); // the live tree had not moved yet
			// the sentinel named the backupDir the swap then actually created
			const backups = readdirSync(backupRoot).filter((n) => n.startsWith('dedalo_'));
			expect(backups.length).toBe(1);
			expect(seen.backupDir).toBe(join(backupRoot, backups[0] as string));
		} finally {
			server.stop(true);
			unmockUpdateEnv();
		}
	}, 60000);

	test('a failed sentinel WRITE refuses BEFORE the tree is touched (byte-identical, no backup dir)', async () => {
		if (!zipAvailable) return;
		const base = join(ROOT, 'sentinel_fail');
		const zipPath = await buildReleaseZip(base);
		const sha = createHash('sha256').update(readFileSync(zipPath)).digest('hex');
		const server = Bun.serve({ port: 0, fetch: () => new Response(readFileSync(zipPath)) });
		const origin = `http://localhost:${server.port}`;
		const targetRoot = join(base, 'live');
		buildLiveTree(targetRoot);
		const before = treeDigest(targetRoot);
		const backupRoot = join(base, 'b');
		// Make the sentinel path unwritable: a DIRECTORY where the file goes.
		mkdirSync(join(backupRoot, 'last_code_update.json'), { recursive: true });
		try {
			mockUpdateEnv(origin);
			const refusal = await refusalOf(
				updateCode(
					{
						file: { version: '7.0.1', url: `${origin}/7.0.1.zip`, sha256: sha },
						waive_backup: true,
					},
					SUPERUSER,
					pipelineSeams({ targetRoot, backupRoot }),
				),
			);
			expect(refusal.code).toBe('update.failed');
			expect(refusal.message).toContain('sentinel');
			// the live tree never moved, byte-identical; no backup dir was created
			expect(treeDigest(targetRoot)).toBe(before);
			expect(readdirSync(backupRoot).filter((n) => n.startsWith('dedalo_'))).toEqual([]);
		} finally {
			server.stop(true);
			unmockUpdateEnv();
		}
	}, 60000);

	test('a DOUBLE swap failure parks the new tree in staging, cleanup refuses to delete it, next run refuses', async () => {
		if (!zipAvailable) return;
		const base = join(ROOT, 'double_fail');
		const zipPath = await buildReleaseZip(base);
		const sha = createHash('sha256').update(readFileSync(zipPath)).digest('hex');
		const server = Bun.serve({ port: 0, fetch: () => new Response(readFileSync(zipPath)) });
		const origin = `http://localhost:${server.port}`;
		const targetRoot = join(base, 'live');
		buildLiveTree(targetRoot);
		mkdirSync(join(targetRoot, '.git'), { recursive: true });
		writeFileSync(join(targetRoot, '.git', 'HEAD'), 'ref: refs/heads/v7');
		const backupRoot = join(base, 'b');
		const stagingDir = join(backupRoot, '.code_staging');
		try {
			mockUpdateEnv(origin);
			const refusal = await refusalOf(
				updateCode(
					{
						file: { version: '7.0.1', url: `${origin}/7.0.1.zip`, sha256: sha },
						waive_backup: true,
					},
					SUPERUSER,
					pipelineSeams({
						targetRoot,
						backupRoot,
						renameIntoPlace: () => {
							throw new Error('injected second-rename failure');
						},
						renameRestore: () => {
							throw new Error('injected restore failure');
						},
					}),
				),
			);
			expect(refusal.code).toBe('update.failed');
			expect(refusal.publicMessage).toContain('parked in staging (NOT deleted)');
			// THE INVARIANT: the new tree survives in staging and the cleanup did
			// NOT delete it (the only copy of a tree never lives where rm-rf runs)
			const parkedCodeRoot = join(stagingDir, 'extract', 'dedalo_code');
			expect(existsSync(join(parkedCodeRoot, 'package.json'))).toBe(true);
			expect(existsSync(join(parkedCodeRoot, 'src', 'new_file.ts'))).toBe(true);
			// the OLD tree survives in the backup dir, .git moved back into it
			const backups = readdirSync(backupRoot).filter((n) => n.startsWith('dedalo_'));
			expect(backups.length).toBe(1);
			const backupDir = join(backupRoot, backups[0] as string);
			expect(readFileSync(join(backupDir, 'package.json'), 'utf8')).toBe('{"name":"old"}');
			expect(existsSync(join(backupDir, '.git', 'HEAD'))).toBe(true);
			// the pending sentinel STAYS (the supervisor rollback restores the backup)
			const sentinel = JSON.parse(
				readFileSync(join(backupRoot, 'last_code_update.json'), 'utf8'),
			) as Record<string, unknown>;
			expect(sentinel.status).toBe('pending');
			expect(sentinel.backupDir).toBe(backupDir);
			// a NEXT run refuses to sweep the marked staging dir (the refusal fires
			// before anything else touches the disk)
			const targetRoot2 = join(base, 'live2');
			buildLiveTree(targetRoot2);
			const next = await refusalOf(
				updateCode(
					{
						file: { version: '7.0.1', url: `${origin}/7.0.1.zip`, sha256: sha },
						waive_backup: true,
					},
					SUPERUSER,
					pipelineSeams({ targetRoot: targetRoot2, backupRoot }),
				),
			);
			expect(next.code).toBe('update.refused');
			expect(next.message).toContain('parked tree');
			expect(existsSync(join(parkedCodeRoot, 'package.json'))).toBe(true);
		} finally {
			server.stop(true);
			unmockUpdateEnv();
		}
	}, 60000);

	test('a nested untracked secret under a SHIPPED dir (deploy/certs/key.pem) refuses the swap', async () => {
		if (!zipAvailable) return;
		const base = join(ROOT, 'nested_secret');
		const zipPath = await buildReleaseZip(base, (codeDir) => {
			// the release SHIPS deploy/ — the top-level whitelist passes it
			mkdirSync(join(codeDir, 'deploy'), { recursive: true });
			writeFileSync(join(codeDir, 'deploy', 'README.md'), '# deploy');
		});
		const sha = createHash('sha256').update(readFileSync(zipPath)).digest('hex');
		const server = Bun.serve({ port: 0, fetch: () => new Response(readFileSync(zipPath)) });
		const origin = `http://localhost:${server.port}`;
		const targetRoot = join(base, 'live');
		buildLiveTree(targetRoot);
		mkdirSync(join(targetRoot, 'deploy', 'certs'), { recursive: true });
		writeFileSync(join(targetRoot, 'deploy', 'certs', 'key.pem'), 'TLS PRIVATE KEY');
		try {
			mockUpdateEnv(origin);
			const refusal = await refusalOf(
				updateCode(
					{
						file: { version: '7.0.1', url: `${origin}/7.0.1.zip`, sha256: sha },
						waive_backup: true,
					},
					SUPERUSER,
					pipelineSeams({ targetRoot, backupRoot: join(base, 'b') }),
				),
			);
			expect(refusal.code).toBe('update.refused');
			expect(refusal.message).toContain('deploy/certs');
			// nothing swapped, the key never moved
			expect(readFileSync(join(targetRoot, 'deploy', 'certs', 'key.pem'), 'utf8')).toBe(
				'TLS PRIVATE KEY',
			);
			expect(readFileSync(join(targetRoot, 'package.json'), 'utf8')).toBe('{"name":"old"}');
		} finally {
			server.stop(true);
			unmockUpdateEnv();
		}
	}, 60000);
});

describe('boot_confirm (the sentinel second half)', () => {
	test('a pending sentinel for the RUNNING version flips to confirmed; a mismatch is left untouched', async () => {
		const dir = join(ROOT, 'confirm');
		mkdirSync(dir, { recursive: true });
		const sentinelPath = join(dir, 'last_code_update.json');
		const base = {
			version: '7.0.1',
			previousVersion: '7.0.0',
			updateMode: 'clean',
			stamp: '2026-08-23T10-00-00',
			backupDir: dir,
			status: 'pending',
			rollback_attempted: false,
		};
		writeFileSync(sentinelPath, JSON.stringify(base));
		await confirmBootedCodeUpdate(sentinelPath, '7.0.1');
		const confirmed = JSON.parse(readFileSync(sentinelPath, 'utf8')) as Record<string, unknown>;
		expect(confirmed.status).toBe('confirmed');
		expect(confirmed.backupDir).toBe(dir);

		// a DIFFERENT running version (rollback happened / half-applied swap):
		// logged loudly, sentinel untouched — the rollback script owns it.
		writeFileSync(sentinelPath, JSON.stringify(base));
		await confirmBootedCodeUpdate(sentinelPath, '7.0.0');
		const untouched = JSON.parse(readFileSync(sentinelPath, 'utf8')) as Record<string, unknown>;
		expect(untouched.status).toBe('pending');

		// an already-confirmed sentinel is a no-op
		await confirmBootedCodeUpdate(sentinelPath, '7.0.1');
	});
});

// ---------------------------------------------------------------------------
// The EXCLUSIVE RUN LOCK — the pipeline's single-flight invariant.
// Before it, two concurrent updates shared one `<backupRoot>/.code_staging`
// and the second swept the first's already-smoke-booted quarantine.
// ---------------------------------------------------------------------------
describe('code-update run lock (single-flight)', () => {
	// Every scratch base is removed after the block (C3-65: one leaked per test).
	const bases: string[] = [];
	afterAll(() => {
		for (const base of bases) rmSync(base, { recursive: true, force: true });
	});
	function scratchRoot(name: string): string {
		const base = mkdtempSync(join(tmpdir(), 'dedalo_run_lock_'));
		bases.push(base);
		const dir = join(base, name);
		mkdirSync(dir, { recursive: true });
		return dir;
	}

	test('a second run REFUSES while the first holds the lock', () => {
		const backupRoot = scratchRoot('held');
		const release = acquireRunLockOrRefuse(backupRoot, '7.0.1');
		expect(existsSync(codeRunLockPath(backupRoot))).toBe(true);

		// The live owner is THIS process, so the dead-owner rule cannot apply.
		const refusal = refusalOfSync(() => acquireRunLockOrRefuse(backupRoot, '7.0.1'));
		expect(refusal.code).toBe('update.refused');
		expect(refusal.publicMessage).toContain('already running');
		expect(refusal.publicMessage).toContain('7.0.1');

		release();
		expect(existsSync(codeRunLockPath(backupRoot))).toBe(false);
		// Released — the next run may proceed.
		acquireRunLockOrRefuse(backupRoot, '7.0.2')();
	});

	test('a STALE lock from a dead owner is reclaimed, not a permanent wedge', () => {
		const backupRoot = scratchRoot('stale');
		// The success path ALWAYS leaves one of these: the process dies in the
		// planned restart moments after releasing. A pid that cannot exist must
		// never block the next update.
		writeFileSync(
			codeRunLockPath(backupRoot),
			JSON.stringify({ pid: 2147483646, version: '7.0.1', startedAt: '2026-01-01T00:00:00Z' }),
		);
		const release = acquireRunLockOrRefuse(backupRoot, '7.0.2');
		expect(JSON.parse(readFileSync(codeRunLockPath(backupRoot), 'utf8')).pid).toBe(process.pid);
		release();
	});

	test('a lock whose owner is unreadable is treated as dead (never a wedge)', () => {
		const backupRoot = scratchRoot('garbage');
		writeFileSync(codeRunLockPath(backupRoot), 'not json at all');
		acquireRunLockOrRefuse(backupRoot, '7.0.1')();
	});
});

// ---------------------------------------------------------------------------
// THE CATALOG MAY NOT RUN AHEAD OF THE ENGINE.
//
// UPDATE_CATALOG once shipped '702' and '703' — rungs for releases nobody had
// cut, added so the museum-cycle probe could walk several hops. They were not
// inert: `scripts/update_drill.ts` picks the NEWEST descriptor, so
// `bun run test:update` rehearsed 7.0.2 → 7.0.3, a hop that will never be cut,
// instead of the rung a release manager actually ships. Meanwhile the shipped
// manifest advertised upgrade paths to archives that do not exist.
//
// The rule: every catalog target is at most ONE rung past the running engine.
// A probe that needs to repeat resets the museum to the rung's FROM end.
// ---------------------------------------------------------------------------
describe('UPDATE_CATALOG may not run ahead of the engine', () => {
	test('every target is at most one rung past DEDALO_VERSION_TRIPLE', () => {
		const engine = [...DEDALO_VERSION_TRIPLE];
		const ahead = Object.entries(UPDATE_CATALOG).filter(([, descriptor]) => {
			const target = [descriptor.versionMajor, descriptor.versionMedium, descriptor.versionMinor];
			// Legal: the engine's own version, or exactly one legal rung past it.
			if (assertLinearUpgrade(engine, target) === null) return false;
			return compareVersionArrays(target, engine) === 1;
		});
		expect(
			ahead.map(([key]) => key),
			'a catalog rung beyond the next one advertises a release nobody can cut, and makes update_drill.ts rehearse a fiction — reset the probe museum instead',
		).toEqual([]);
	});

	test('every catalog rung chains from a version the engine can reach', () => {
		// No orphan islands: each descriptor's `updateFrom` is either the
		// engine's version or another descriptor's target.
		const targets = new Set(
			Object.values(UPDATE_CATALOG).map(
				(d) => `${d.versionMajor}.${d.versionMedium}.${d.versionMinor}`,
			),
		);
		targets.add(DEDALO_VERSION_TRIPLE.join('.'));
		for (const [key, d] of Object.entries(UPDATE_CATALOG)) {
			const from = `${d.updateFromMajor}.${d.updateFromMedium}.${d.updateFromMinor}`;
			expect(
				targets.has(from),
				`catalog rung '${key}' upgrades from ${from}, which nothing reaches`,
			).toBe(true);
		}
	});
});

// ---------------------------------------------------------------------------
// THE SAME-VERSION IDENTITY GATE (dev channel, 2026-08-24).
// A dev install swaps a tree whose VERSION IS UNCHANGED, so the version can no
// longer answer "did the new tree boot?": after a rollback the OLD tree matches
// the pending sentinel exactly, boot confirmation flips it to `confirmed`, and
// the supervisor-side rollback (deploy/dedalo-code-rollback.sh) is silently
// disarmed for the class of build most likely to fail. The installed ARCHIVE
// DIGEST is the identity token instead.
// ---------------------------------------------------------------------------
describe('boot_confirm under a same-version (dev channel) install', () => {
	const DIGEST_NEW = 'a'.repeat(64);
	const DIGEST_OLD = 'b'.repeat(64);

	function pendingSentinel(dir: string): Record<string, unknown> {
		return {
			version: '7.0.1',
			previousVersion: '7.0.1', // SAME version — the dev-channel case
			updateMode: 'clean',
			stamp: '2026-08-24T10-00-00',
			backupDir: dir,
			installDigest: DIGEST_NEW,
			status: 'pending',
			rollback_attempted: false,
		};
	}

	test('the rolled-back OLD tree does NOT confirm: same version, different installed digest', async () => {
		const dir = join(ROOT, 'confirm_same_version_rollback');
		mkdirSync(dir, { recursive: true });
		const sentinelPath = join(dir, 'last_code_update.json');
		writeFileSync(sentinelPath, JSON.stringify(pendingSentinel(dir)));

		// The tree that actually booted carries the PREVIOUS archive's digest.
		await confirmBootedCodeUpdate(sentinelPath, '7.0.1', DIGEST_OLD);

		const after = JSON.parse(readFileSync(sentinelPath, 'utf8')) as Record<string, unknown>;
		expect(after.status).toBe('pending');
	});

	test('the NEW tree confirms: same version, matching installed digest', async () => {
		const dir = join(ROOT, 'confirm_same_version_ok');
		mkdirSync(dir, { recursive: true });
		const sentinelPath = join(dir, 'last_code_update.json');
		writeFileSync(sentinelPath, JSON.stringify(pendingSentinel(dir)));

		await confirmBootedCodeUpdate(sentinelPath, '7.0.1', DIGEST_NEW);

		const after = JSON.parse(readFileSync(sentinelPath, 'utf8')) as Record<string, unknown>;
		expect(after.status).toBe('confirmed');
	});

	test('a legacy sentinel with no installDigest still confirms on the version alone', async () => {
		const dir = join(ROOT, 'confirm_legacy');
		mkdirSync(dir, { recursive: true });
		const sentinelPath = join(dir, 'last_code_update.json');
		const { installDigest: _dropped, ...legacy } = pendingSentinel(dir);
		writeFileSync(sentinelPath, JSON.stringify(legacy));

		await confirmBootedCodeUpdate(sentinelPath, '7.0.1', null);

		const after = JSON.parse(readFileSync(sentinelPath, 'utf8')) as Record<string, unknown>;
		expect(after.status).toBe('confirmed');
	});
});

// ---------------------------------------------------------------------------
// The DEV CHANNEL relaxes an ORDERING guard, never an authenticity one: the
// same version becomes installable (that IS the feature — a `v7` branch build
// carries no version bump), while downgrades and rung skips stay refused.
// ---------------------------------------------------------------------------
describe('assertLinearUpgrade on the dev channel', () => {
	test('the SAME version is allowed on dev and still refused on the release channel', () => {
		expect(assertLinearUpgrade([7, 0, 1], [7, 0, 1], 'dev')).toBeNull();
		expect(assertLinearUpgrade([7, 0, 1], [7, 0, 1], 'master')).toBe(
			'refusing a downgrade or same-version install',
		);
		// the default is the release channel — an omitted channel never relaxes
		expect(assertLinearUpgrade([7, 0, 1], [7, 0, 1])).toBe(
			'refusing a downgrade or same-version install',
		);
	});

	test('dev still refuses a downgrade', () => {
		expect(assertLinearUpgrade([7, 0, 1], [7, 0, 0], 'dev')).toBe(
			'refusing a downgrade or same-version install',
		);
	});

	test('dev still refuses a rung skip', () => {
		expect(assertLinearUpgrade([7, 0, 0], [7, 0, 3], 'dev')).toBe(
			'patch version skip is not allowed',
		);
		expect(assertLinearUpgrade([7, 0, 0], [9, 0, 0], 'dev')).toBe(
			'major version skip is not allowed',
		);
	});

	test('dev allows the next rung, exactly like the release channel', () => {
		expect(assertLinearUpgrade([7, 0, 0], [7, 0, 1], 'dev')).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// THE DEV-CHANNEL SWAP end to end: same version, and the tree that lands must
// be IDENTIFIABLE afterwards — the version no longer distinguishes it from the
// tree it replaced, so the install stamp and the sentinel's digest are the only
// things standing between a landed swap and a rollback that looks identical.
// ---------------------------------------------------------------------------
describe('full swap chain on the DEV CHANNEL (same version)', () => {
	test('a same-version dev release installs, stamps the tree, and records its digest in the sentinel', async () => {
		if (!zipAvailable) return;
		const base = join(ROOT, 'dev_swap');
		const zipPath = await buildReleaseZip(base);
		const sha = createHash('sha256').update(readFileSync(zipPath)).digest('hex');
		const previousDigest = 'd'.repeat(64);

		const server = Bun.serve({ port: 0, fetch: () => new Response(readFileSync(zipPath)) });
		const origin = `http://localhost:${server.port}`;

		const targetRoot = join(base, 'live');
		buildLiveTree(targetRoot);
		// the live tree was itself installed by an earlier dev iteration
		mkdirSync(join(targetRoot, 'src', 'core', 'update'), { recursive: true });
		writeFileSync(
			join(targetRoot, 'src', 'core', 'update', 'install_stamp.json'),
			JSON.stringify({ digest: previousDigest, channel: 'dev' }),
		);
		const backupRoot = join(base, 'backups');
		const version = DEDALO_VERSION_TRIPLE.join('.'); // the SAME version we run

		try {
			mockUpdateEnv(origin);
			const out = await updateCode(
				{
					file: {
						version,
						url: `${origin}/${version}-dev.zip`,
						sha256: sha,
						channel: 'dev',
					},
					waive_backup: true,
				},
				SUPERUSER,
				pipelineSeams({ targetRoot, backupRoot, restart: () => {} }),
			);
			expect(out.ok).toBe(true);
			expect(out.data).toEqual({ version });

			// THE INSTALL STAMP: the new tree names the archive it came from and
			// the channel that built it (which is what restores its `.dev` tag).
			const stamp = JSON.parse(
				readFileSync(join(targetRoot, 'src', 'core', 'update', 'install_stamp.json'), 'utf8'),
			) as Record<string, unknown>;
			expect(stamp.digest).toBe(sha);
			expect(stamp.channel).toBe('dev');
			expect(stamp.source_url).toBe(`${origin}/${version}-dev.zip`);

			// THE SENTINEL carries the same digest: boot_confirm compares THAT,
			// not the (unchanged) version, so a rollback stays loud.
			const sentinel = JSON.parse(
				readFileSync(join(backupRoot, 'last_code_update.json'), 'utf8'),
			) as Record<string, unknown>;
			expect(sentinel.installDigest).toBe(sha);
			expect(sentinel.version).toBe(version);
			expect(sentinel.previousVersion).toBe(version);

			// THE RESTORE POINT is identifiable: same version every iteration, so
			// the name carries the digest of the tree it holds.
			const backups = readdirSync(backupRoot).filter((n) => n.startsWith('dedalo_'));
			expect(backups.length).toBe(1);
			expect(backups[0]).toContain(`_${previousDigest.slice(0, 7)}_`);
		} finally {
			server.stop(true);
			unmockUpdateEnv();
		}
	}, 60000);

	test('the same-version release is REFUSED without the dev channel', async () => {
		const version = DEDALO_VERSION_TRIPLE.join('.');
		const refusal = await refusalOf(
			updateCode(
				{
					file: { version, url: `http://localhost:1/${version}.zip`, sha256: 'e'.repeat(64) },
					waive_backup: true,
				},
				SUPERUSER,
				pipelineSeams({ targetRoot: join(ROOT, 'never_touched') }),
			),
		);
		expect(refusal.message).toContain('same-version install');
	});

	// The `prerelease` token (RELEASE_IDENTITY_DESIGN §2.8 item 2) is carried to
	// the stamp, and alone it relaxes NO guard: what moves within a triple is a
	// NEWER IDENTITY (the identity walk, below) — the stable release of the
	// running triple is no newer than itself on any channel but `dev`, and a
	// near-miss token is the release channel.
	test.each(['prerelease', 'Prerelease', 'DEV'])(
		'the same-version release is REFUSED on channel %p',
		async (channel) => {
			const version = DEDALO_VERSION_TRIPLE.join('.');
			const refusal = await refusalOf(
				updateCode(
					{
						file: {
							version,
							url: `http://localhost:1/${version}.zip`,
							sha256: 'e'.repeat(64),
							channel,
						},
						waive_backup: true,
					},
					SUPERUSER,
					pipelineSeams({ targetRoot: join(ROOT, 'never_touched') }),
				),
			);
			expect(refusal.message).toContain('same-version install');
		},
	);
});

describe('the root whitelist', () => {
	// Every scratch base is removed after the block (C3-65: one leaked per test).
	const bases: string[] = [];
	afterAll(() => {
		for (const base of bases) rmSync(base, { recursive: true, force: true });
	});
	/** A live tree + the release about to land, as two dirs of empty files. */
	function trees(live: string[], shipped: string[]): [string, string] {
		const base = mkdtempSync(join(tmpdir(), 'dedalo_root_whitelist_'));
		bases.push(base);
		const codeRoot = join(base, 'code');
		const targetRoot = join(base, 'live');
		for (const [dir, names] of [
			[codeRoot, shipped],
			[targetRoot, live],
		] as const) {
			mkdirSync(dir, { recursive: true });
			for (const name of names) writeFileSync(join(dir, name), '');
		}
		return [codeRoot, targetRoot];
	}

	test('an operator drop-in at the root REFUSES the swap', () => {
		const [codeRoot, targetRoot] = trees(['README.md', 'my_notes.txt'], ['README.md']);
		const refusal = refusalOfSync(() => refuseUnaccountedLiveEntries(codeRoot, targetRoot));
		expect(refusal.message).toContain('my_notes.txt');
	});

	test('OS metadata does NOT — macOS plants .DS_Store in every browsed dir', () => {
		// A bind-mounted install tree on a Mac host grows one by itself; refusing
		// it blocked real updates for a file with no content (2026-08-28).
		const [codeRoot, targetRoot] = trees(['README.md', '.DS_Store'], ['README.md']);
		expect(() => refuseUnaccountedLiveEntries(codeRoot, targetRoot)).not.toThrow();
	});

	/** Stamp the LIVE tree as installed from a release whose root was `rootEntries`. */
	function stampLive(targetRoot: string, rootEntries: string[]): void {
		const path = join(targetRoot, INSTALL_STAMP_PATH);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(
			path,
			JSON.stringify({ digest: 'd'.repeat(64), channel: 'master', root_entries: rootEntries }),
		);
	}

	test('a RETIRED entry — shipped by the installed release, dropped by this one — does NOT refuse', () => {
		// `.vscode` shipped until 0ebc82b616; every later release refused on it,
		// and an install without shell access could not clear it (2026-10-07).
		const [codeRoot, targetRoot] = trees(['README.md', '.vscode'], ['README.md']);
		stampLive(targetRoot, ['.vscode', 'README.md', 'src']);
		expect(() => refuseUnaccountedLiveEntries(codeRoot, targetRoot)).not.toThrow();
	});

	test('a drop-in the installed release did NOT ship still refuses, with the unchanged sentence', () => {
		const [codeRoot, targetRoot] = trees(['README.md', '.vscode', 'my_notes.txt'], ['README.md']);
		stampLive(targetRoot, ['.vscode', 'README.md', 'src']);
		const refusal = refusalOfSync(() => refuseUnaccountedLiveEntries(codeRoot, targetRoot));
		expect(refusal.message).toBe(
			'Error. Unknown entries at the code-tree root would be moved into the backup by the swap: my_notes.txt — move them out of the tree (or delete them) before updating.',
		);
	});

	test('an UNSTAMPED live tree proves no retirement — the entry refuses as before', () => {
		const [codeRoot, targetRoot] = trees(['README.md', '.vscode'], ['README.md']);
		const refusal = refusalOfSync(() => refuseUnaccountedLiveEntries(codeRoot, targetRoot));
		expect(refusal.message).toContain('.vscode');
	});

	test('a stamp WITHOUT a root list (pre-2026-10-07) proves no retirement either', () => {
		const [codeRoot, targetRoot] = trees(['README.md', '.vscode'], ['README.md']);
		const path = join(targetRoot, INSTALL_STAMP_PATH);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify({ digest: 'd'.repeat(64), channel: 'master' }));
		const refusal = refusalOfSync(() => refuseUnaccountedLiveEntries(codeRoot, targetRoot));
		expect(refusal.message).toContain('.vscode');
	});

	test('a CHECKOUT install: roots the incoming .gitattributes export-ignores do NOT refuse', () => {
		// A git-clone install carries the agent-alias symlinks; no release ships
		// them, so every in-app update of a checkout refused (2026-10-21).
		const [codeRoot, targetRoot] = trees(
			['README.md', '.gitattributes', 'AGENTS.md'],
			['README.md', '.gitattributes', 'AGENTS.md'],
		);
		mkdirSync(join(targetRoot, '.agents'));
		symlinkSync('.agents', join(targetRoot, '.claude'));
		symlinkSync('AGENTS.md', join(targetRoot, 'CLAUDE.md'));
		writeFileSync(
			join(codeRoot, '.gitattributes'),
			'# aliases\n/.claude export-ignore\n/CLAUDE.md   export-ignore\n*.gz binary\n',
		);
		expect(() => refuseUnaccountedLiveEntries(codeRoot, targetRoot)).toThrow(/: \.agents —/);
		mkdirSync(join(codeRoot, '.agents'));
		expect(() => refuseUnaccountedLiveEntries(codeRoot, targetRoot)).not.toThrow();
		expect([...releaseExcludedRootEntriesOf(codeRoot)].sort()).toEqual(['.claude', 'CLAUDE.md']);
	});

	test('an export-ignored name that is NOT a symlink is operator content — it still refuses', () => {
		// A real `.claude/` dir (an agent run on a release install) or a
		// hand-written CLAUDE.md is not the checkout alias.
		const [codeRoot, targetRoot] = trees(
			['README.md', '.gitattributes', 'CLAUDE.md'],
			['README.md', '.gitattributes'],
		);
		mkdirSync(join(targetRoot, '.claude'));
		writeFileSync(
			join(codeRoot, '.gitattributes'),
			'/.claude export-ignore\n/CLAUDE.md export-ignore\n',
		);
		const refusal = refusalOfSync(() => refuseUnaccountedLiveEntries(codeRoot, targetRoot));
		expect(refusal.message).toContain(': .claude, CLAUDE.md —');
	});

	test('export-ignore excuses only the roots it NAMES — a drop-in beside them still refuses', () => {
		const [codeRoot, targetRoot] = trees(
			['README.md', '.gitattributes', 'my_notes.txt'],
			['README.md', '.gitattributes'],
		);
		symlinkSync('README.md', join(targetRoot, 'CLAUDE.md'));
		writeFileSync(
			join(codeRoot, '.gitattributes'),
			'/CLAUDE.md export-ignore\n/docs/x export-ignore\n/*.txt export-ignore\n',
		);
		const refusal = refusalOfSync(() => refuseUnaccountedLiveEntries(codeRoot, targetRoot));
		expect(refusal.message).toContain(': my_notes.txt —');
		expect(refusal.message).not.toContain('CLAUDE.md');
	});

	test('a secret inside a RETIRED dir still refuses — retirement waives the root check, never the secret walk', () => {
		const [codeRoot, targetRoot] = trees(['README.md'], ['README.md']);
		mkdirSync(join(targetRoot, '.vscode'));
		writeFileSync(join(targetRoot, '.vscode', 'server.key'), '');
		stampLive(targetRoot, ['.vscode', 'README.md', 'src']);
		const refusal = refusalOfSync(() => refuseUnaccountedLiveEntries(codeRoot, targetRoot));
		expect(refusal.message).toContain('.vscode/server.key');
	});
});

/* ------------------------------------------------------------------------- *
 * OPS-1 IN-PROCESS: the UNWAIVED update over the backup it would lean on. Every
 * swap test above waives the backup, so deleting the precondition — or making it
 * fire-and-forget (`void requireFreshBackup(...)`) — left this file green; the
 * only gate was the opt-in drill, which runs committed code. REAL archive bytes
 * (a READ of the suite database), a scratch backup dir, no swap.
 * ------------------------------------------------------------------------- */

const OPS1_SCRATCH = mkdtempSync(join(tmpdir(), 'dedalo_code_update_ops1_'));
afterAll(() => {
	rmSync(OPS1_SCRATCH, { recursive: true, force: true });
});
const OPS1_ARCHIVE = buildRealArchive(OPS1_SCRATCH);
const OPS1_PG_RESTORE = resolvePgRestore();
const OPS1_READY = OPS1_ARCHIVE.path !== null && OPS1_PG_RESTORE !== null;
if (!OPS1_READY) {
	console.warn(`[code_update] OPS-1 real-archive legs SKIPPED (not passed): ${OPS1_ARCHIVE.note}`);
}

describe.if(OPS1_READY)('the UNWAIVED code update and the database backup (OPS-1)', () => {
	/** A scratch backup dir holding one real archive, cut to `fraction`, 5 minutes old. */
	function backupDirWith(name: string, fraction: number): string {
		const dir = join(OPS1_SCRATCH, name);
		mkdirSync(dir, { recursive: true });
		const path = join(dir, `2026-01-01_000000.zz.postgresql_-1_forced_dbv7.custom.backup`);
		if (fraction >= 1) copyFileSync(OPS1_ARCHIVE.path as string, path);
		else truncatedCopy(OPS1_ARCHIVE.path as string, path, fraction);
		ageMinutes(path, 5);
		return dir;
	}

	test('a 60% cut REFUSES the update before anything is fetched', async () => {
		const databaseBackupDir = backupDirWith('truncated', 0.6);
		let hits = 0;
		const server = Bun.serve({
			port: 0,
			fetch: () => {
				hits += 1;
				return new Response('not a release', { status: 404 });
			},
		});
		const origin = `http://localhost:${server.port}`;
		try {
			mockUpdateEnv(origin);
			const refusal = await refusalOf(
				updateCode(
					{ file: { version: '7.0.1', url: `${origin}/7.0.1.zip`, sha256: 'a'.repeat(64) } },
					SUPERUSER,
					pipelineSeams({ targetRoot: join(OPS1_SCRATCH, 'never_touched'), databaseBackupDir }),
				),
			);
			expect(refusal.code).toBe('update.refused');
			expect(refusal.message).toContain('(truncated)');
			expect(hits).toBe(0);
		} finally {
			unmockUpdateEnv();
			server.stop(true);
		}
	});

	test('CONTROL: a complete archive gets PAST the backup precondition', async () => {
		// The next gate in the order is the request shape: a malformed version is
		// refused there, which proves the backup precondition passed — with no
		// network and no swap.
		const databaseBackupDir = backupDirWith('complete', 1);
		const refusal = await refusalOf(
			updateCode(
				{
					file: {
						version: 'not-a-version',
						url: 'http://localhost:1/x.zip',
						sha256: 'a'.repeat(64),
					},
				},
				SUPERUSER,
				pipelineSeams({ targetRoot: join(OPS1_SCRATCH, 'never_touched'), databaseBackupDir }),
			),
		);
		expect(refusal.code).toBe('request.invalid_options');
		expect(refusal.message).toContain('Malformed release version');
	});

	test('maintenance mode switched OFF during the verification refuses the update', async () => {
		// The verdict is a settled full read — minutes on a large archive. An
		// operator who reopens the install meanwhile must not get a swap on a live,
		// public server: the gate is asked again after the wait.
		const databaseBackupDir = backupDirWith('maintenance_flip', 1);
		const gate = join(OPS1_SCRATCH, 'flip.release');
		const slow = join(OPS1_SCRATCH, 'slow_pg_restore.sh');
		writeFileSync(
			slow,
			`#!/bin/sh\nif [ "$1" = "-f" ]; then i=0; while [ ! -f '${gate}' ] && [ $i -lt 200 ]; do sleep 0.05; i=$((i+1)); done; fi\nexec '${OPS1_PG_RESTORE}' "$@"\n`,
		);
		chmodSync(slow, 0o755);
		const pending = refusalOf(
			updateCode(
				{
					file: {
						version: 'not-a-version',
						url: 'http://localhost:1/x.zip',
						sha256: 'a'.repeat(64),
					},
				},
				SUPERUSER,
				pipelineSeams({
					targetRoot: join(OPS1_SCRATCH, 'never_touched'),
					databaseBackupDir,
					databaseBackupVerify: { pgRestoreBin: slow },
				}),
			),
		);
		try {
			await Bun.sleep(300);
			setServerState({ maintenance_mode: false });
			writeFileSync(gate, '');
			const refusal = await pending;
			expect(refusal.code).toBe('maintenance.mode_required');
		} finally {
			writeFileSync(gate, '');
			setServerState({ maintenance_mode: true });
		}
	});

	test('a job STOPPED during the verification ends there: nothing fetched, nothing swapped', async () => {
		// The job manager marks a stopped job terminal but cannot stop an awaiting
		// worker. Without the re-check the run carried on after the (minutes-long)
		// verification: download, swap, restart — under a job the panel already
		// showed as stopped. A VALID request, so only the stop can refuse it.
		const databaseBackupDir = backupDirWith('stopped_during_verify', 1);
		const gate = join(OPS1_SCRATCH, 'stop.release');
		const slow = join(OPS1_SCRATCH, 'stop_pg_restore.sh');
		writeFileSync(
			slow,
			`#!/bin/sh\nif [ "$1" = "-f" ]; then i=0; while [ ! -f '${gate}' ] && [ $i -lt 200 ]; do sleep 0.05; i=$((i+1)); done; fi\nexec '${OPS1_PG_RESTORE}' "$@"\n`,
		);
		chmodSync(slow, 0o755);
		let hits = 0;
		const server = Bun.serve({
			port: 0,
			fetch: () => {
				hits += 1;
				return new Response('not a release', { status: 404 });
			},
		});
		const origin = `http://localhost:${server.port}`;
		const targetRoot = join(OPS1_SCRATCH, 'stop_live');
		const backupRoot = join(OPS1_SCRATCH, 'stop_backups');
		buildLiveTree(targetRoot);
		const before = treeDigest(targetRoot);
		const job = new AbortController();
		try {
			mockUpdateEnv(origin);
			const pending = refusalOf(
				updateCode(
					{ file: { version: '7.0.1', url: `${origin}/7.0.1.zip`, sha256: 'a'.repeat(64) } },
					SUPERUSER,
					pipelineSeams({
						targetRoot,
						backupRoot,
						databaseBackupDir,
						databaseBackupVerify: { pgRestoreBin: slow },
						signal: job.signal,
					}),
				),
			);
			await Bun.sleep(300);
			job.abort();
			writeFileSync(gate, '');
			const refusal = await pending;
			expect(refusal.code).toBe('update.refused');
			expect(refusal.message).toContain('stopped while the database backup was being verified');
			expect(hits).toBe(0);
			expect(treeDigest(targetRoot)).toBe(before);
			expect(existsSync(join(backupRoot, 'last_code_update.json'))).toBe(false);
		} finally {
			writeFileSync(gate, '');
			unmockUpdateEnv();
			server.stop(true);
		}
	});
});

describe('a non-superuser code update starts NO archive read (identity before the backup)', () => {
	test('unwaived: perm.superuser_required, and pg_restore is never spawned', async () => {
		// preconditions.ts states the ORDER: identity and maintenance mode first,
		// every backup question after. Moving requireFreshBackup ahead of
		// checkUpdatePreconditions still refuses a global admin — only AFTER reading
		// the archive on their behalf. The spawn count is what tells the two apart.
		const dir = mkdtempSync(join(tmpdir(), 'dedalo_code_update_mortal_'));
		try {
			const archive = join(dir, '2026-01-01_000000.zz.postgresql_-1_forced_dbv7.custom.backup');
			writeFileSync(archive, 'PGDMP a header-shaped stub');
			ageMinutes(archive, 5);
			const log = join(dir, 'pg_restore.argv');
			const recorder = join(dir, 'pg_restore.sh');
			writeFileSync(recorder, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexit 0\n`);
			chmodSync(recorder, 0o755);
			// PAY THE FIRST-EXEC COST NOW. macOS scans a freshly written executable on
			// its first exec (~300 ms measured) — as long as the grace window below, so
			// a wrongly ordered detached look recorded nothing in time and the waived
			// half stayed green under that mutation. Warmed, the recorder writes in ms.
			Bun.spawnSync([recorder, '--warm-up']);
			rmSync(log, { force: true });
			const globalAdmin = { userId: 42, isGlobalAdmin: true, isDeveloper: false } as Principal;
			const request = (waive: boolean) => ({
				file: { version: '7.0.1', url: 'http://localhost:1/7.0.1.zip', sha256: 'a'.repeat(64) },
				...(waive ? { waive_backup: true } : {}),
			});
			for (const waive of [false, true]) {
				const refusal = await refusalOf(
					updateCode(
						request(waive),
						globalAdmin,
						pipelineSeams({
							targetRoot: join(dir, 'never_touched'),
							databaseBackupDir: dir,
							databaseBackupVerify: { pgRestoreBin: recorder },
						}),
					),
				);
				expect(refusal.code).toBe('perm.superuser_required');
			}
			// The waiver's audit look is detached: give a wrongly ordered one time to spawn
			// (the recorder is warm, so this is an order of magnitude past its latency).
			await Bun.sleep(1000);
			expect(existsSync(log)).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("waived (superuser): the audit look reads through the refusal's OWN seam", async () => {
		// POSITIVE control of the leg above, and the gate of "warnBackupWaiver uses
		// the same verification seam as the refusal": dropping the verify options
		// on the waiver's look reads with the host's pg_restore, and the recorder
		// never runs. The malformed version refuses right after the waiver fires.
		const dir = mkdtempSync(join(tmpdir(), 'dedalo_code_update_waived_'));
		try {
			const archive = join(dir, '2026-01-01_000000.zz.postgresql_-1_forced_dbv7.custom.backup');
			writeFileSync(archive, 'PGDMP a header-shaped stub');
			ageMinutes(archive, 5);
			const log = join(dir, 'pg_restore.argv');
			const recorder = join(dir, 'pg_restore.sh');
			writeFileSync(recorder, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexit 0\n`);
			chmodSync(recorder, 0o755);
			const refusal = await refusalOf(
				updateCode(
					{
						waive_backup: true,
						file: {
							version: 'not-a-version',
							url: 'http://localhost:1/x.zip',
							sha256: 'a'.repeat(64),
						},
					},
					SUPERUSER,
					pipelineSeams({
						targetRoot: join(dir, 'never_touched'),
						databaseBackupDir: dir,
						databaseBackupVerify: { pgRestoreBin: recorder },
					}),
				),
			);
			expect(refusal.code).toBe('request.invalid_options');
			const deadline = Date.now() + 10_000;
			while (!existsSync(log) && Date.now() < deadline) await Bun.sleep(50);
			expect(readFileSync(log, 'utf8')).toContain(archive);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// THE PUBLICATION MANIFEST (publication host L1): written into the quarantine at
// extract, BEFORE the smoke boot, so the validated tree is the tree that lands;
// the outgoing tree's own manifest rides into its restore point (a restore
// pushes the release the restored tree verified, never this one's).
// ---------------------------------------------------------------------------
describe('the publication manifest is written at extract (publication host L1)', () => {
	test('the landed tree carries a manifest of its Publication API files, written before the smoke boot', async () => {
		expect(zipAvailable).toBe(true); // no silent early return (gate_vacuity_tripwire): no zip CLI = red here too
		const base = join(ROOT, 'pub_manifest');
		const v1Index = '<?php // v1 json entry';
		const v2Server = '// v2 server';
		const zipPath = await buildReleaseZip(base, (codeDir) => {
			mkdirSync(join(codeDir, 'publication', 'server_api', 'v1', 'json'), { recursive: true });
			writeFileSync(join(codeDir, 'publication', 'server_api', 'v1', 'json', 'index.php'), v1Index);
			mkdirSync(join(codeDir, 'publication', 'server_api', 'v2', 'src'), { recursive: true });
			writeFileSync(join(codeDir, 'publication', 'server_api', 'v2', 'src', 'server.ts'), v2Server);
		});
		const sha = createHash('sha256').update(readFileSync(zipPath)).digest('hex');
		const server = Bun.serve({ port: 0, fetch: () => new Response(readFileSync(zipPath)) });
		const origin = `http://localhost:${server.port}`;

		const targetRoot = join(base, 'live');
		buildLiveTree(targetRoot);
		// The outgoing tree was installed by an earlier release and holds ITS manifest.
		const oldManifest = JSON.stringify({ version: 1, digest: 'c'.repeat(64), files: {} });
		mkdirSync(join(targetRoot, 'src', 'core', 'update'), { recursive: true });
		writeFileSync(join(targetRoot, PUBLICATION_MANIFEST_PATH), oldManifest);
		const backupRoot = join(base, 'backups');
		let manifestAtPreflight = false;

		try {
			mockUpdateEnv(origin);
			const out = await updateCode(
				{
					file: { version: '7.0.1', url: `${origin}/7.0.1.zip`, sha256: sha },
					waive_backup: true,
				},
				SUPERUSER,
				pipelineSeams({
					targetRoot,
					backupRoot,
					smokeBoot: async (codeRoot) => {
						manifestAtPreflight = existsSync(join(codeRoot, PUBLICATION_MANIFEST_PATH));
					},
				}),
			);
			expect(out.ok).toBe(true);
			// written BEFORE the smoke boot: the validated tree is the landed tree
			expect(manifestAtPreflight).toBe(true);
			const manifest = JSON.parse(
				readFileSync(join(targetRoot, PUBLICATION_MANIFEST_PATH), 'utf8'),
			) as Record<string, unknown>;
			expect(manifest).toEqual({
				version: 1,
				digest: sha,
				files: {
					// the kit census (publication_manifest.ts KIT_PIN_FILES): the landed pin file
					'.bun-version': createHash('sha256')
						.update(readFileSync(join(targetRoot, '.bun-version')))
						.digest('hex'),
					'publication/server_api/v1/json/index.php': createHash('sha256')
						.update(v1Index)
						.digest('hex'),
					'publication/server_api/v2/src/server.ts': createHash('sha256')
						.update(v2Server)
						.digest('hex'),
				},
			});
			// manifest digest == the landed tree's install stamp == the release the restarted
			// process will name → both APIs verify with the caller's digest too
			expect(await verifyPublicationTree(targetRoot, 'v1', sha)).toEqual({ ok: true });
			expect(await verifyPublicationTree(targetRoot, 'v2', sha)).toEqual({ ok: true });
			// the OLD process (restart pending) must not ship it under its own release
			expect(await verifyPublicationTree(targetRoot, 'v1', 'c'.repeat(64))).toMatchObject({
				reason: 'digest_mismatch',
			});
			// the old tree's manifest went WITH it into the restore point
			const backups = readdirSync(backupRoot).filter((n) => n.startsWith('dedalo_'));
			expect(backups.length).toBe(1);
			expect(
				readFileSync(join(backupRoot, backups[0] as string, PUBLICATION_MANIFEST_PATH), 'utf8'),
			).toBe(oldManifest);
		} finally {
			server.stop(true);
			unmockUpdateEnv();
		}
	}, 60000);
});

/*
 * THE INSTANCE-DIR RULE (2026-10-12, owner decision): the code tree lives in an
 * INSTANCE DIR the service user owns (`/home/my_domain.org/dedalo/master_dedalo`,
 * the installer's `/home/ded_<i>/dedalo`), and every rename the update, the in-app
 * restore and the supervisor-side rollback make stays INSIDE it — the instance
 * dir's PARENT may be root-owned. Driven for real: the full update chain, the
 * restore, and deploy/dedalo-code-rollback.sh EXECUTED, against a scratch
 * instance dir whose parent is chmod 0555. Anti-vacuity: the parent is PROVEN
 * unwritable first (a root run would make this whole block meaningless).
 */
describe('the instance-dir rule: an update, a restore and a rollback never write the parent', () => {
	const ROLLBACK_SCRIPT = join(import.meta.dir, '..', '..', 'deploy', 'dedalo-code-rollback.sh');

	/** A scratch `<parent>/instance/master_dedalo` + `<parent>/instance/backups/code`. */
	function instanceLayout(name: string): {
		parent: string;
		instance: string;
		targetRoot: string;
		backupRoot: string;
	} {
		const parent = mkdtempSync(join(ROOT, `instance_rule_${name}_`));
		const instance = join(parent, 'instance');
		const targetRoot = join(instance, 'master_dedalo');
		buildLiveTree(targetRoot);
		// bootable as a restore point (restorePointIsBootable): node_modules travels with it
		mkdirSync(join(targetRoot, 'node_modules', 'dep'), { recursive: true });
		writeFileSync(join(targetRoot, 'node_modules', 'dep', 'index.js'), '// old dep');
		// …and declares its version (a restore point must say what it holds)
		mkdirSync(join(targetRoot, 'src', 'core', 'update'), { recursive: true });
		writeFileSync(
			join(targetRoot, 'src', 'core', 'update', 'version.ts'),
			`export const DEDALO_VERSION_TRIPLE = Object.freeze([${DEDALO_VERSION_TRIPLE.join(', ')}]);\n`,
		);
		return { parent, instance, targetRoot, backupRoot: join(instance, 'backups', 'code') };
	}

	/** Lock the parent (root-owned in production), run, and ALWAYS unlock it. */
	async function withLockedParent<T>(parent: string, run: () => Promise<T>): Promise<T> {
		chmodSync(parent, 0o555);
		try {
			// anti-vacuity: the lock bites for THIS process (a root run is red here)
			expect(() => writeFileSync(join(parent, 'probe'), '')).toThrow();
			return await run();
		} finally {
			chmodSync(parent, 0o755);
		}
	}

	async function update(
		origin: string,
		sha: string,
		targetRoot: string,
		backupRoot: string,
	): Promise<unknown> {
		return updateCode(
			{ file: { version: '7.0.1', url: `${origin}/7.0.1.zip`, sha256: sha }, waive_backup: true },
			SUPERUSER,
			pipelineSeams({ targetRoot, backupRoot }),
		);
	}

	test('update, then the supervisor-side rollback (the script, executed), with a 0555 parent', async () => {
		expect(zipAvailable).toBe(true); // no silent early return (gate_vacuity_tripwire): no zip CLI = red here too
		const layout = instanceLayout('rollback');
		const zipPath = await buildReleaseZip(join(layout.parent, 'release_src'));
		rmSync(join(layout.parent, 'release_src', 'stage'), { recursive: true, force: true });
		const sha = createHash('sha256').update(readFileSync(zipPath)).digest('hex');
		const server = Bun.serve({ port: 0, fetch: () => new Response(readFileSync(zipPath)) });
		const parentBefore = readdirSync(layout.parent).sort();
		try {
			mockUpdateEnv(`http://localhost:${server.port}`);
			await withLockedParent(layout.parent, async () => {
				const out = (await update(
					`http://localhost:${server.port}`,
					sha,
					layout.targetRoot,
					layout.backupRoot,
				)) as { ok: boolean };
				expect(out.ok).toBe(true);
				expect(existsSync(join(layout.targetRoot, 'src', 'new_file.ts'))).toBe(true);
				// the supervisor-side rollback, as the rollback unit runs it (no restart)
				const run = spawnSync(
					'bash',
					[
						ROLLBACK_SCRIPT,
						'--no-restart',
						'--app-dir',
						layout.targetRoot,
						'--backup-root',
						layout.backupRoot,
					],
					{ encoding: 'utf8' },
				);
				expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
				expect(readFileSync(join(layout.targetRoot, 'package.json'), 'utf8')).toBe(
					'{"name":"old"}',
				);
				expect(readdirSync(layout.backupRoot).some((n) => n.startsWith('failed_'))).toBe(true);
				const sentinel = JSON.parse(
					readFileSync(join(layout.backupRoot, 'last_code_update.json'), 'utf8'),
				) as Record<string, unknown>;
				expect(sentinel.status).toBe('rolled_back');
			});
			// nothing was created, renamed or removed beside the instance dir
			expect(readdirSync(layout.parent).sort()).toEqual(parentBefore);
		} finally {
			server.stop(true);
			unmockUpdateEnv();
		}
	}, 60000);

	test('update, then the in-app restore of the restore point it made, with a 0555 parent', async () => {
		expect(zipAvailable).toBe(true); // no silent early return (gate_vacuity_tripwire): no zip CLI = red here too
		const layout = instanceLayout('restore');
		const zipPath = await buildReleaseZip(join(layout.parent, 'release_src'));
		rmSync(join(layout.parent, 'release_src', 'stage'), { recursive: true, force: true });
		const sha = createHash('sha256').update(readFileSync(zipPath)).digest('hex');
		const server = Bun.serve({ port: 0, fetch: () => new Response(readFileSync(zipPath)) });
		const parentBefore = readdirSync(layout.parent).sort();
		try {
			mockUpdateEnv(`http://localhost:${server.port}`);
			await withLockedParent(layout.parent, async () => {
				const out = (await update(
					`http://localhost:${server.port}`,
					sha,
					layout.targetRoot,
					layout.backupRoot,
				)) as { ok: boolean };
				expect(out.ok).toBe(true);
				const point = readdirSync(layout.backupRoot).find((n) => n.startsWith('dedalo_'));
				expect(point).toBeDefined();
				// the release's tree is not bootable as a point without node_modules
				mkdirSync(join(layout.targetRoot, 'node_modules'), { recursive: true });
				const restored = await restoreCode({ name: point, confirm_downgrade: true }, SUPERUSER, {
					targetRoot: layout.targetRoot,
					backupRoot: layout.backupRoot,
					restart: () => {},
					supervised: true,
					smokeBoot: async () => {},
					channel: 'tree_swap',
				});
				expect(restored.ok).toBe(true);
				expect(readFileSync(join(layout.targetRoot, 'package.json'), 'utf8')).toBe(
					'{"name":"old"}',
				);
			});
			expect(readdirSync(layout.parent).sort()).toEqual(parentBefore);
		} finally {
			server.stop(true);
			unmockUpdateEnv();
		}
	}, 60000);

	test('a layout that needs the parent refuses BEFORE the download, naming the directory', async () => {
		// (1) the code tree directly under the root-owned dir (the pre-2026-10-12
		// hand-built /opt/dedalo/master_dedalo); (2) a backup root beside the
		// instance dir. Both used to download, install and smoke boot, then die at
		// the first rename with EACCES.
		const layout = instanceLayout('refuse');
		const looseTree = join(layout.parent, 'master_dedalo');
		buildLiveTree(looseTree);
		let fetched = 0;
		const server = Bun.serve({
			port: 0,
			fetch: () => {
				fetched += 1;
				return new Response('not a zip');
			},
		});
		const sha = 'a'.repeat(64);
		try {
			mockUpdateEnv(`http://localhost:${server.port}`);
			await withLockedParent(layout.parent, async () => {
				const loose = await refusalOf(
					update(`http://localhost:${server.port}`, sha, looseTree, layout.backupRoot),
				);
				expect(loose.code).toBe('update.refused');
				expect(loose.message).toContain(`instance directory ${layout.parent}`);
				const beside = await refusalOf(
					update(
						`http://localhost:${server.port}`,
						sha,
						layout.targetRoot,
						join(layout.parent, 'backups', 'code'),
					),
				);
				expect(beside.code).toBe('update.refused');
				expect(beside.message).toContain(`code-backup root ${layout.parent}`);
			});
			expect(fetched).toBe(0);
			expect(unwritableSwapDirs(layout.targetRoot, layout.backupRoot)).toEqual([]);
		} finally {
			server.stop(true);
			unmockUpdateEnv();
		}
	});
});

// ---------------------------------------------------------------------------
// THE IDENTITY WALK AT THE SWAP DOOR (RELEASE_IDENTITY design §2.8 item 3,
// 2026-10-18). The door walks from what this engine CALLS ITSELF to what the
// item names (`file.release` on a prerelease item): within a data triple a
// newer identity is legal with no rung, and the frames carry the IDENTITY
// /health will answer — the triple is the same on both sides of such a swap.
// The full truth table is gate 15 (release_identity_walk_native).
// ---------------------------------------------------------------------------
describe('the identity walk at the swap door', () => {
	const T = DEDALO_VERSION_TRIPLE.join('.');

	/**
	 * The refusal an update request draws before any fetch (url points nowhere).
	 * The url names the archive the item names (`release`, else `version`), as a
	 * manifest item's does — the name check is its own case below.
	 */
	async function walkRefusal(
		file: Record<string, unknown>,
		runningRelease: string,
		runningChannel: InstallChannel | null = null,
	) {
		const name = typeof file.release === 'string' ? file.release : String(file.version);
		return refusalOf(
			updateCode(
				{
					file: { url: `http://localhost:1/${name}.zip`, sha256: 'e'.repeat(64), ...file },
					waive_backup: true,
				},
				SUPERUSER,
				pipelineSeams({
					targetRoot: join(ROOT, 'never_touched'),
					runningRelease,
					runningChannel,
				}),
			),
		);
	}

	test('§2.8.5 bootstrap: a tree RUNNING a developer build it was installed as walks to every tag of its triple', async () => {
		// beta.6 → 7.0.0-dev.zip (stamped `dev`, calls itself .dev) → the
		// triple's prereleases AND its release, each under the item's own token
		const STAMPED_DEV = [`${T}.dev`, 'dev'] as const;
		for (const file of [
			{ version: T, release: `${T}-beta.7`, channel: 'prerelease' },
			{ version: T, release: `${T}-beta.6`, channel: 'prerelease' },
			{ version: T, channel: 'master' },
		]) {
			const passed = await walkRefusal(file, ...STAMPED_DEV);
			// past the walk: what refuses now is the download from nowhere
			expect(passed.message, JSON.stringify(file)).not.toContain('same-version install');
			expect(passed.message, JSON.stringify(file)).not.toContain('installs only on');
		}
		// the standing is the TREE's, never the request's: a .dev that no dev
		// stamp put there (unstamped checkout, a master-stamped archive) keeps
		// the conservative reading — its bare triple, nothing of it is newer
		for (const stamp of [null, 'master', 'prerelease'] as const) {
			for (const file of [
				{ version: T, release: `${T}-beta.7`, channel: 'prerelease' },
				{ version: T, channel: 'master' },
			]) {
				expect(
					(await walkRefusal(file, `${T}.dev`, stamp)).message,
					`${stamp} ${JSON.stringify(file)}`,
				).toContain('same-version install');
			}
		}
		// a dev stamp under a TAGGED identity (a dev-channel archive of a tag
		// calls itself the tag) is no developer build: the release order holds
		expect(
			(
				await walkRefusal(
					{ version: T, release: `${T}-beta.6`, channel: 'prerelease' },
					`${T}-beta.7`,
					'dev',
				)
			).message,
		).toContain('same-version install');
	});

	test('a newer identity of the SAME triple passes the walk; an older or equal one is refused', async () => {
		const legal = await walkRefusal(
			{ version: T, release: `${T}-beta.7`, channel: 'prerelease' },
			`${T}-beta.6`,
		);
		// past the walk: what refuses now is the download from nowhere, never the walk
		expect(legal.message).not.toContain('same-version install');
		expect(legal.message).not.toContain('prerelease');
		for (const [file, running] of [
			[{ version: T, release: `${T}-beta.6`, channel: 'prerelease' }, `${T}-beta.7`],
			[{ version: T, release: `${T}-rc.1`, channel: 'prerelease' }, T],
			[{ version: T, channel: 'master' }, T],
		] as const) {
			expect((await walkRefusal(file, running)).message, JSON.stringify(file)).toContain(
				'same-version install',
			);
		}
		// a release of the running prerelease's triple is the newer identity
		const release = await walkRefusal({ version: T, channel: 'master' }, `${T}-rc.1`);
		expect(release.message).not.toContain('same-version install');
	});

	test('a version outside the shared grammar is a TYPED refusal, never the walk throwing', async () => {
		// `7.0` and `07.0.1` passed the door's old wider regex and reached the
		// walk, which throws a raw RangeError on garbage (job ends unexpected).
		for (const version of ['7.0', '07.0.1', `${T}.4`, `${T}-beta.1`, `${T}.dev`]) {
			const refusal = await walkRefusal({ version, channel: 'prerelease' }, T);
			expect(refusal.code, version).toBe('request.invalid_options');
			expect(refusal.message, version).toContain('Malformed release version');
		}
	});

	test('a prerelease needs the prerelease channel; a release naming another triple is malformed', async () => {
		const next = [
			DEDALO_VERSION_TRIPLE[0],
			DEDALO_VERSION_TRIPLE[1],
			DEDALO_VERSION_TRIPLE[2] + 1,
		].join('.');
		expect(
			(await walkRefusal({ version: next, release: `${next}-beta.1`, channel: 'master' }, T))
				.message,
		).toContain('installs only on the prerelease');
		for (const release of [
			`${T}-beta.1`,
			`${next}-pre.1`,
			next,
			`${next}.dev`,
			`${next}-beta.01`,
		]) {
			const refusal = await walkRefusal({ version: next, release, channel: 'prerelease' }, T);
			expect(refusal.code, release).toBe('request.invalid_options');
			expect(refusal.message, release).toContain('Malformed release identity');
		}
	});

	test('beta.6 → beta.7 installs end to end; the restart frame and the envelope carry the IDENTITY', async () => {
		// no silent early-out (gate_vacuity_tripwire): without zip this is red, like the canary
		expect(zipAvailable, 'the zip CLI builds the synthetic release').toBe(true);
		const base = join(ROOT, 'identity_swap');
		const zipPath = await buildReleaseZip(base, undefined, `${T}-beta.7`);
		const sha = createHash('sha256').update(readFileSync(zipPath)).digest('hex');
		const server = Bun.serve({ port: 0, fetch: () => new Response(readFileSync(zipPath)) });
		const origin = `http://localhost:${server.port}`;
		const targetRoot = join(base, 'live');
		buildLiveTree(targetRoot);
		const frames: Record<string, unknown>[] = [];
		try {
			mockUpdateEnv(origin);
			const out = await updateCode(
				{
					file: {
						version: T,
						release: `${T}-beta.7`,
						url: `${origin}/${T}-beta.7.zip`,
						sha256: sha,
						channel: 'prerelease',
					},
					waive_backup: true,
				},
				SUPERUSER,
				pipelineSeams({
					targetRoot,
					backupRoot: join(base, 'backups'),
					runningRelease: `${T}-beta.6`,
					onPhase: (frame) => frames.push(frame as unknown as Record<string, unknown>),
				}),
			);
			expect(out.ok).toBe(true);
			expect(out.data).toEqual({ version: T, release: `${T}-beta.7` });
			const restart = frames.find((frame) => frame.phase === 'restart');
			expect(restart?.expected_version).toBe(`${T}-beta.7`);
			const stamp = JSON.parse(
				readFileSync(join(targetRoot, 'src', 'core', 'update', 'install_stamp.json'), 'utf8'),
			) as Record<string, unknown>;
			expect(stamp.channel).toBe('prerelease');
		} finally {
			server.stop(true);
			unmockUpdateEnv();
		}
	}, 60000);

	test('the url must name the archive the walk judged — refused before any fetch', async () => {
		const next = [
			DEDALO_VERSION_TRIPLE[0],
			DEDALO_VERSION_TRIPLE[1],
			DEDALO_VERSION_TRIPLE[2] + 1,
		].join('.');
		let fetched = 0;
		const server = Bun.serve({
			port: 0,
			fetch: () => {
				fetched += 1;
				return new Response('not a zip');
			},
		});
		const origin = `http://localhost:${server.port}`;
		const ask = (file: Record<string, unknown>) =>
			refusalOf(
				updateCode(
					{ file: { sha256: 'e'.repeat(64), ...file }, waive_backup: true },
					SUPERUSER,
					pipelineSeams({ targetRoot: join(ROOT, 'never_touched') }),
				),
			);
		try {
			mockUpdateEnv(origin);
			for (const [file, name] of [
				// a stable request whose url is a prerelease of the same triple
				[{ version: next, url: `${origin}/7/7.0/${next}-beta.2.zip` }, `${next}-beta.2.zip`],
				// a prerelease request whose url is another prerelease
				[
					{
						version: next,
						release: `${next}-beta.3`,
						channel: 'prerelease',
						url: `${origin}/${next}-beta.2.zip`,
					},
					`${next}-beta.2.zip`,
				],
				// a developer build request served a stable archive (and the reverse)
				[{ version: next, channel: 'dev', url: `${origin}/${next}.zip` }, `${next}.zip`],
				[{ version: next, url: `${origin}/${next}-dev.zip` }, `${next}-dev.zip`],
				// not an archive name at all
				[{ version: next, url: `${origin}/latest.zip?v=${next}` }, 'latest.zip'],
			] as const) {
				const refusal = await ask(file);
				expect(refusal.code, JSON.stringify(file)).toBe('request.invalid_options');
				expect(refusal.message, JSON.stringify(file)).toContain(
					`The release archive '${name}' is not the release the request names`,
				);
			}
			expect(fetched).toBe(0);
			// CONTROL: the matching name gets past the check (to the download)
			const control = await ask({ version: next, url: `${origin}/${next}.zip` });
			expect(control.message).not.toContain('is not the release the request names');
			expect(fetched).toBe(1);
		} finally {
			server.stop(true);
			unmockUpdateEnv();
		}
	});

	test('a quarantine that calls itself another release is refused before the swap', async () => {
		expect(zipAvailable, 'the zip CLI builds the synthetic release').toBe(true);
		const base = join(ROOT, 'foreign_quarantine');
		// a correctly NAMED 7.0.1.zip whose own stamp is the 7.0.1-beta.2 tag
		const zipPath = await buildReleaseZip(base, undefined, '7.0.1-beta.2');
		const sha = createHash('sha256').update(readFileSync(zipPath)).digest('hex');
		const server = Bun.serve({ port: 0, fetch: () => new Response(readFileSync(zipPath)) });
		const origin = `http://localhost:${server.port}`;
		const targetRoot = join(base, 'live');
		buildLiveTree(targetRoot);
		const before = treeDigest(targetRoot);
		let restarted = false;
		try {
			mockUpdateEnv(origin);
			const refusal = await refusalOf(
				updateCode(
					{
						file: { version: '7.0.1', url: `${origin}/7.0.1.zip`, sha256: sha },
						waive_backup: true,
					},
					SUPERUSER,
					pipelineSeams({
						targetRoot,
						backupRoot: join(base, 'backups'),
						restart: () => {
							restarted = true;
						},
					}),
				),
			);
			expect(refusal.code).toBe('update.refused');
			expect(refusal.message).toContain('calls itself 7.0.1-beta.2, not the requested 7.0.1');
			expect(treeDigest(targetRoot)).toBe(before);
			expect(restarted).toBe(false);
		} finally {
			server.stop(true);
			unmockUpdateEnv();
		}
	}, 60000);
});
