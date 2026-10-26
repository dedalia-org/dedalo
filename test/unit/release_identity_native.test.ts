/**
 * RELEASE IDENTITY FROM THE GIT TAG (src/core/update/release_identity.ts +
 * build_stamp.ts readReleaseIdentityOf) — design gates 1 and 8.
 *
 * GATE 1 — the resolver's truth table over REAL throwaway git repositories,
 * each scenario judged twice: as a CHECKOUT (the committed placeholder + a
 * `.git` the bounded `git describe --exact-match` reader asks) and as a
 * `git archive`-EXTRACTED tree (export-subst expanded by the real git, no
 * `.git`, no spawn). The repositories carry the REAL committed build_info.txt
 * and the REAL `.gitattributes` export-subst line, so a change to either is
 * judged here, not a copy of it. Nothing is stubbed: what the archive says is
 * what git wrote.
 *
 * The control the whole design exists for (finding C3i-F1): an archive of
 * `v7.0.0-beta.6` NEVER calls itself `7.0.0`.
 *
 * GATE 8 — one semver ordering fixture (test/fixtures/release_identity/
 * ordering.json), every reader held to it: the engine's comparator and the
 * changelog's (which must BE the engine's) here; the shell twin
 * (deploy/dedalo-image-lib.sh dedalo_identity_cmp) in
 * test/unit/release_identity_shell_parity.test.ts, over the same file.
 *
 * DB-free; spawns git + tar: hermetic tier.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareVersions as changelogCompare, parseRelease } from '../../scripts/lib/change_log.ts';
import {
	BUILD_INFO_PATH,
	CHECKOUT_DESCRIBE_TIMEOUT_MS,
	parseBuildInfo,
	readBuildInfoOf,
	readReleaseIdentityOf,
} from '../../src/core/update/build_stamp.ts';
import {
	compareReleaseIdentities,
	imageTagOf,
	MIN_GIT_FOR_DESCRIBE,
	parseReleaseVersion,
	type ReleaseIdentity,
	resolveReleaseIdentity,
} from '../../src/core/update/release_identity.ts';
import {
	REAL_PLACEHOLDER,
	releaseTrees,
	TRUTH_TABLE,
	type TruthRow,
} from '../helpers/release_identity_trees.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const TRIPLE = TRUTH_TABLE.triple;
const ORDERING = JSON.parse(
	readFileSync(join(REPO_ROOT, 'test', 'fixtures', 'release_identity', 'ordering.json'), 'utf8'),
) as {
	ascending: string[];
	dev: string[];
	dev_below_stable: [string, string][];
	not_identities: string[];
};
/**
 * The declared NEXT triple (version.ts DEDALO_NEXT_DEV_TRIPLE): an untagged tree
 * names its dev identity with it, so the truth table's untagged rows read
 * `7.0.1-dev` while the DATA triple stays 7.0.0.
 */
const NEXT_DEV_TRIPLE = [7, 0, 1] as const;

const SCRATCH = mkdtempSync(join(tmpdir(), 'dedalo-release-identity-'));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

// The trees and the truth table are SHARED with the shell twin's gate
// (release_identity_shell_parity, design gate 7): one history, every resolver.
const { scratch, git, repoWith, archiveOf, stampChannel } = releaseTrees(SCRATCH);

function identityOf(tree: string, gitBinary?: string): Promise<ReleaseIdentity> {
	return readReleaseIdentityOf(tree, {
		triple: TRIPLE,
		...(gitBinary === undefined ? {} : { git: gitBinary }),
	});
}

// ---------------------------------------------------------------------------
// GATE 1 — checkout AND archive, one truth table
// ---------------------------------------------------------------------------

const ROWS: TruthRow[] = TRUTH_TABLE.rows;

describe('GATE 1 — the release identity of real git trees', () => {
	for (const row of ROWS) {
		describe(row.name, () => {
			const repo = repoWith(row.name, row.steps);

			test(`checkout → ${row.version}`, async () => {
				expect(readBuildInfoOf(repo).build).toBeNull(); // the placeholder: git is asked
				const identity = await identityOf(repo);
				expect(identity.version).toBe(row.version);
				expect(identity.kind).toBe(row.kind);
				if (row.notice === null) expect(identity.notice).toBeNull();
				else expect(identity.notice ?? '').toMatch(new RegExp(row.notice));
			});

			test(`git-archive-extracted → ${row.version} (the same answer, no spawn)`, async () => {
				const tree = archiveOf(repo);
				const info = readBuildInfoOf(tree);
				expect(info.sha).toBe(git(repo, 'rev-parse', 'HEAD'));
				expect(info.legacy).toBe(false);
				// no git to ask: an archive judges from its stamp alone
				const identity = await identityOf(tree, join(SCRATCH, 'no-such-git'));
				expect(identity.version).toBe(row.version);
				expect(identity.kind).toBe(row.kind);
				if (row.notice === null) expect(identity.notice).toBeNull();
				else expect(identity.notice ?? '').toMatch(new RegExp(row.notice));
			});
		});
	}

	test('CONTROL (C3i-F1): an archive of v7.0.0-beta.6 never says 7.0.0 — not even on the master channel', async () => {
		const tree = archiveOf(repoWith('control', [{ tag: 'v7.0.0-beta.6', annotated: true }]));
		expect((await identityOf(tree)).version).toBe('7.0.0-beta.6');
		stampChannel(tree, 'master');
		expect((await identityOf(tree)).version).toBe('7.0.0-beta.6');
		expect((await identityOf(tree)).version).not.toBe('7.0.0');
	});

	test('rule 5 (Q5): a DEV-channel archive of an exactly tagged commit calls itself by the tag', async () => {
		const tree = archiveOf(repoWith('dev_tagged', [{ tag: 'v7.0.0-beta.6', annotated: true }]));
		stampChannel(tree, 'dev');
		expect(await identityOf(tree)).toMatchObject({ version: '7.0.0-beta.6', kind: 'prerelease' });
	});

	test('a dev-channel archive of an untagged commit is the next triple -dev', async () => {
		const tree = archiveOf(repoWith('dev_untagged', [{ commit: true }]));
		stampChannel(tree, 'dev');
		expect(await identityOf(tree)).toMatchObject({ version: '7.0.1-dev', kind: 'dev' });
	});

	test('no .git: a tree holding the unexpanded placeholder is .dev, and nothing is spawned', async () => {
		const tree = scratch('no_git');
		mkdirSync(join(tree, 'src', 'core', 'update'), { recursive: true });
		writeFileSync(join(tree, BUILD_INFO_PATH), REAL_PLACEHOLDER);
		// a git that does not exist proves no spawn was needed: no notice about it
		const identity = await identityOf(tree, join(SCRATCH, 'no-such-git'));
		expect(identity).toMatchObject({ version: '7.0.1-dev', kind: 'dev', notice: null });
	});

	test('no git binary: a checkout whose git cannot run is .dev, SAYS so, never throws', async () => {
		const repo = repoWith('no_git_binary', [{ tag: 'v7.0.0', annotated: true }]);
		expect((await identityOf(repo)).version).toBe('7.0.0'); // the control: git can tell
		const identity = await identityOf(repo, join(SCRATCH, 'no-such-git'));
		expect(identity).toMatchObject({ version: '7.0.1-dev', kind: 'dev' });
		expect(identity.notice ?? '').toMatch(/git describe could not read/);
	});

	test(`a git that never answers is bounded: .dev, SAYS so, within the limit (${CHECKOUT_DESCRIBE_TIMEOUT_MS} ms) — even when it leaves a grandchild holding the pipes`, async () => {
		const repo = repoWith('hung_git', [{ tag: 'v7.0.0', annotated: true }]);
		const pidFile = join(SCRATCH, 'hung_git_grandchild.pid');
		const fakeGit = join(SCRATCH, 'hung-git');
		// The grandchild inherits stdout/stderr: killing the direct child does not
		// close them — only a reader that stops waiting is bounded.
		writeFileSync(
			fakeGit,
			`#!/bin/sh\nsleep 30 &\necho $! > ${JSON.stringify(pidFile)}\nexec sleep 30\n`,
			{ mode: 0o755 },
		);
		const started = performance.now();
		try {
			const identity = await identityOf(repo, fakeGit);
			const elapsed = performance.now() - started;
			expect(identity).toMatchObject({ version: '7.0.1-dev', kind: 'dev' });
			expect(identity.notice ?? '').toMatch(
				new RegExp(`no answer within ${CHECKOUT_DESCRIBE_TIMEOUT_MS} ms`),
			);
			expect(elapsed).toBeGreaterThanOrEqual(CHECKOUT_DESCRIBE_TIMEOUT_MS - 50);
			expect(elapsed).toBeLessThan(CHECKOUT_DESCRIBE_TIMEOUT_MS + 2000);
		} finally {
			const pid = Number.parseInt(readFileSync(pidFile, 'utf8'), 10);
			if (Number.isInteger(pid)) {
				try {
					process.kill(pid, 'SIGKILL');
				} catch {
					// already gone
				}
			}
		}
	}, 15_000);

	test("a TRANSLATED git: the untagged answer in the operator's language is still the normal untagged answer (no notice)", () => {
		// Apple git ships no catalogs, so a real git cannot show this here: the fake
		// answers like Debian's translated git — in the locale its environment selects.
		const fakeGit = join(SCRATCH, 'translated-git');
		writeFileSync(
			fakeGit,
			[
				'#!/bin/sh',
				'case "${LC_ALL:-${LC_MESSAGES:-${LANG:-C}}}" in',
				'  C|POSIX) echo "fatal: no tag exactly matches \'abc\'" >&2 ;;',
				'  *) echo "fatal: ninguna etiqueta coincide exactamente con \'abc\'" >&2 ;;',
				'esac',
				'exit 128',
				'',
			].join('\n'),
			{ mode: 0o755 },
		);
		const untagged = repoWith('translated_untagged', []);
		const probe = Bun.spawnSync(
			[
				'bun',
				'-e',
				`const { readReleaseIdentityOf } = await import(${JSON.stringify(join(REPO_ROOT, 'src/core/update/build_stamp.ts'))});
				console.log(JSON.stringify(await readReleaseIdentityOf(${JSON.stringify(untagged)}, { triple: [7, 0, 0], git: ${JSON.stringify(fakeGit)} })));`,
			],
			{
				cwd: SCRATCH,
				env: { ...process.env, LANG: 'es_ES.UTF-8', LC_ALL: 'es_ES.UTF-8', LANGUAGE: 'es' },
			},
		);
		expect(probe.exitCode, probe.stderr.toString()).toBe(0);
		const identity = JSON.parse(probe.stdout.toString().trim().split('\n').at(-1) as string);
		expect(identity).toMatchObject({ version: '7.0.1-dev', kind: 'dev', notice: null });
	});

	test('an inherited GIT_DIR does not make the checkout describe ANOTHER repository', () => {
		const tagged = repoWith('foreign_tagged', [{ tag: 'v7.0.0', annotated: true }]);
		const untagged = repoWith('own_untagged', []);
		const probe = Bun.spawnSync(
			[
				'bun',
				'-e',
				`const { readReleaseIdentityOf } = await import(${JSON.stringify(join(REPO_ROOT, 'src/core/update/build_stamp.ts'))});
				console.log((await readReleaseIdentityOf(${JSON.stringify(untagged)}, { triple: [7, 0, 0] })).version);`,
			],
			{ cwd: SCRATCH, env: { ...process.env, GIT_DIR: join(tagged, '.git') } },
		);
		expect(probe.exitCode, probe.stderr.toString()).toBe(0);
		expect(probe.stdout.toString().trim().split('\n').at(-1)).toBe('7.0.1-dev');
	});

	describe('rule 4 — a LEGACY two-field stamp keeps the old channel rule', () => {
		const LEGACY = 'a334a7b6e05f0c1d2e3f4a5b6c7d8e9f00112233 2026-08-23T10:15:00+02:00\n';
		for (const [channel, version] of [
			[null, '7.0.0'],
			['master', '7.0.0'],
			['dev', '7.0.1-dev'],
		] as const) {
			test(`channel ${channel ?? 'unstamped'} → ${version}`, async () => {
				const tree = scratch(`legacy_${channel ?? 'none'}`);
				mkdirSync(join(tree, 'src', 'core', 'update'), { recursive: true });
				writeFileSync(join(tree, BUILD_INFO_PATH), LEGACY);
				if (channel !== null) stampChannel(tree, channel);
				expect(readBuildInfoOf(tree).legacy).toBe(true);
				expect((await identityOf(tree)).version).toBe(version);
			});
		}
	});
});

// ---------------------------------------------------------------------------
// The resolver's own rules, evidence in hand (what the trees above feed it)
// ---------------------------------------------------------------------------

describe('resolveReleaseIdentity — the rules on direct evidence', () => {
	const other = { stamp: 'other', channel: null } as const;

	test('an untagged-archive describe ("") is dev, not legacy — the trailing space is load-bearing', () => {
		const info = parseBuildInfo('a334a7b6e05f 2026-08-23T10:15:00+02:00 \n');
		expect(info).toMatchObject({ describe: '', legacy: false });
		expect(
			resolveReleaseIdentity({
				triple: TRIPLE,
			nextDevTriple: NEXT_DEV_TRIPLE,
				describe: info.describe,
				provenance: { stamp: 'other', channel: 'master' },
			}).version,
		).toBe('7.0.1-dev');
	});

	test(`an archive an old git (< ${MIN_GIT_FOR_DESCRIBE}) left unexpanded is .dev and names the minimum`, () => {
		const info = parseBuildInfo(
			'a334a7b6e05f 2026-08-23T10:15:00+02:00 %(describe:match=v[0-9]*,abbrev=40)\n',
		);
		const identity = resolveReleaseIdentity({
			triple: TRIPLE,
			nextDevTriple: NEXT_DEV_TRIPLE,
			describe: info.describe,
			provenance: other,
		});
		expect(identity.version).toBe('7.0.1-dev');
		expect(identity.notice ?? '').toContain(MIN_GIT_FOR_DESCRIBE);
	});

	test('a describe past a tag is dev with no notice (normal development)', () => {
		const identity = resolveReleaseIdentity({
			triple: TRIPLE,
			nextDevTriple: NEXT_DEV_TRIPLE,
			describe: 'v7.0.0-beta.5-889-g2915808635',
			provenance: other,
		});
		expect(identity).toMatchObject({ version: '7.0.1-dev', kind: 'dev', notice: null, tag: null });
	});

	test('the identity carries its tag and its data triple, frozen', () => {
		const identity = resolveReleaseIdentity({
			triple: TRIPLE,
			nextDevTriple: NEXT_DEV_TRIPLE,
			describe: 'v7.0.0-beta.6',
			provenance: other,
		});
		expect(identity).toEqual({
			version: '7.0.0-beta.6',
			kind: 'prerelease',
			triple: [7, 0, 0],
			tag: 'v7.0.0-beta.6',
			notice: null,
		});
		expect(Object.isFrozen(identity)).toBe(true);
		expect(Object.isFrozen(identity.triple)).toBe(true);
	});
});

describe('imageTagOf — the tag an identity is built/published under', () => {
	test.each([
		['7.0.0', '7.0.0'],
		['7.0.0-beta.6', '7.0.0-beta.6'],
		['7.0.0-rc.1', '7.0.0-rc.1'],
		['7.0.0-dev', '7.0.0-dev'],
		['7.0.1-dev', '7.0.1-dev'],
	])('%s → %s', (identity, tag) => {
		expect(imageTagOf(identity)).toBe(tag);
	});

	test('a non-identity is refused, never tagged (the retired dotted spelling 7.0.1.dev included)', () => {
		expect(() => imageTagOf('7.0.0-pre.1')).toThrow(/not a release identity/);
		expect(() => imageTagOf('7.0.1.dev')).toThrow(/not a release identity/);
	});
});

// ---------------------------------------------------------------------------
// GATE 8 — one ordering fixture, every reader
// ---------------------------------------------------------------------------

const READERS: [string, (a: string, b: string) => number][] = [
	['engine compareReleaseIdentities', compareReleaseIdentities],
	['changelog compareVersions', changelogCompare],
];

describe('GATE 8 — semver ordering, one fixture, every reader', () => {
	test('the fixture is a real ordering (anti-vacuity)', () => {
		expect(ORDERING.ascending.length).toBeGreaterThanOrEqual(15);
		expect(ORDERING.ascending.some((v) => v.includes('-alpha.'))).toBe(true);
		expect(ORDERING.ascending.some((v) => v.includes('-rc.'))).toBe(true);
	});

	for (const [name, compare] of READERS) {
		test(`${name}: every pair of the ascending list is ordered, both ways`, () => {
			const list = ORDERING.ascending;
			let pairs = 0;
			for (let i = 0; i < list.length; i++) {
				for (let j = 0; j < list.length; j++) {
					const a = list[i] as string;
					const b = list[j] as string;
					expect(Math.sign(compare(a, b)), `${a} vs ${b}`).toBe(Math.sign(i - j));
					pairs += 1;
				}
			}
			expect(pairs).toBe(list.length ** 2);
		});

		test(`${name}: sorting a shuffle restores the fixture`, () => {
			const shuffled = [...ORDERING.ascending].reverse();
			shuffled.push(shuffled.splice(3, 1)[0] as string);
			expect(shuffled.sort(compare)).toEqual(ORDERING.ascending);
		});

		test(`${name}: refuses every non-identity`, () => {
			for (const bad of ORDERING.not_identities) {
				expect(() => compare(bad, '7.0.0'), `'${bad}'`).toThrow();
			}
		});
	}

	test('the full order of the plan: 7.0.0 < 7.0.1-alpha.1 < 7.0.1-beta.1 < 7.0.1-rc.1 < 7.0.1-dev < 7.0.1 < 7.0.2', () => {
		const plan = ['7.0.0', '7.0.1-alpha.1', '7.0.1-beta.1', '7.0.1-rc.1', '7.0.1-dev', '7.0.1', '7.0.2'];
		for (let i = 0; i + 1 < plan.length; i++) {
			expect(compareReleaseIdentities(plan[i] as string, plan[i + 1] as string), `${plan[i]} < ${plan[i + 1]}`).toBe(-1);
		}
	});

	test('a dev identity is its own rank: strictly below the stable of its triple, strictly above every prerelease of it', () => {
		for (const [dev, stable] of ORDERING.dev_below_stable) {
			expect(compareReleaseIdentities(dev, stable)).toBe(-1);
			expect(compareReleaseIdentities(stable, dev)).toBe(1);
			expect(parseReleaseVersion(dev)?.dev).toBe(true);
			expect(parseReleaseVersion(stable)?.dev).toBe(false);
		}
		// the comparator trap: a null prerelease is the STABLE release, never a
		// missing label, so the dev rank must be explicit (beta.10 < dev, dev < stable)
		expect(compareReleaseIdentities('7.0.1-rc.99', '7.0.1-dev')).toBe(-1);
		expect(compareReleaseIdentities('7.0.1-dev', '7.0.1')).toBe(-1);
	});

	test('the changelog accepts exactly the release grammar: every fixture release, no dev identity, no non-identity', () => {
		const release = (version: string) =>
			JSON.stringify({
				version,
				date: '2026-10-15',
				from: null,
				to: 'v1',
				commits: 1,
				wire_contract: [],
			});
		for (const version of ORDERING.ascending.filter((v) => !ORDERING.dev.includes(v))) {
			expect(parseRelease('changes/x/release.json', release(version)).version).toBe(version);
		}
		// a developer identity is an identity but never a release: the changelog refuses it
		for (const bad of [...ORDERING.not_identities, ...ORDERING.dev]) {
			expect(() => parseRelease('changes/x/release.json', release(bad)), `'${bad}'`).toThrow(
				/is not <major>/,
			);
		}
	});
});
