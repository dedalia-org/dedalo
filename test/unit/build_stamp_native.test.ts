/**
 * Build provenance gate (core/update/build_stamp.ts) — design gate 2.
 *
 *  - the parser contract: placeholder/malformed → dev values (never a throw),
 *    the legacy TWO-field stamp and the THREE-field stamp both accepted;
 *  - the committed build_info.txt keeps the literal placeholder (an expanded
 *    value committed would stamp every checkout as that release), and that
 *    placeholder carries EXACTLY ONE `%(describe` — git expands a bounded
 *    number of `%(describe)` per archive, so a second one anywhere export-subst
 *    reaches could silently stop the first from expanding;
 *  - only build_info.txt is export-subst;
 *  - the ARCHIVE ROUND-TRIP: a real `git archive` of a real tagged repository
 *    carrying the committed placeholder expands to `<HEAD sha> <date> <tag>`;
 *  - the minimum git that expands `%(describe:match=…)` is recorded, and this
 *    machine's git meets it (else the round-trip above proves nothing).
 * The identity truth table itself is release_identity_native.test.ts (gate 1).
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	BUILD_INFO_PATH,
	DEDALO_BUILD,
	DEDALO_ENGINE_VERSION,
	parseBuildInfo,
	RELEASE_IDENTITY,
	readBuildInfoOf,
	readReleaseIdentityOf,
} from '../../src/core/update/build_stamp.ts';
import { MIN_GIT_FOR_DESCRIBE } from '../../src/core/update/release_identity.ts';
import {
	compareVersionArrays,
	DEDALO_DATA_VERSION,
	DEDALO_NEXT_RELEASE,
} from '../../src/core/update/version.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const COMMITTED = readFileSync(join(REPO_ROOT, BUILD_INFO_PATH), 'utf8');
const SHA = 'a334a7b6e05f0c1d2e3f4a5b6c7d8e9f00112233';
const DATE = '2026-08-23T10:15:00+02:00';

const SCRATCH = mkdtempSync(join(tmpdir(), 'dedalo-build-stamp-'));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

describe('parseBuildInfo', () => {
	test('the unexpanded placeholder (current and legacy) means no stamp', () => {
		const none = { sha: null, build: null, describe: null, legacy: false };
		expect(parseBuildInfo(COMMITTED)).toEqual(none);
		expect(parseBuildInfo('$Format:%H %cI$')).toEqual(none);
		expect(parseBuildInfo('$Format:%H %cI$\n')).toEqual(none);
	});

	test('a THREE-field stamp parses to sha + date + describe', () => {
		expect(parseBuildInfo(`${SHA} ${DATE} v7.0.0-beta.6\n`)).toEqual({
			sha: SHA,
			build: DATE,
			describe: 'v7.0.0-beta.6',
			legacy: false,
		});
		expect(parseBuildInfo(`${SHA} ${DATE} v7.0.0-beta.5-889-g2915808635\n`).describe).toBe(
			'v7.0.0-beta.5-889-g2915808635',
		);
	});

	test('an EMPTY describe (no tag reachable) is three fields, not legacy', () => {
		expect(parseBuildInfo(`${SHA} ${DATE} \n`)).toEqual({
			sha: SHA,
			build: DATE,
			describe: '',
			legacy: false,
		});
	});

	test('a legacy TWO-field stamp is still read, and flagged legacy', () => {
		expect(parseBuildInfo(`${SHA} ${DATE}\n`)).toEqual({
			sha: SHA,
			build: DATE,
			describe: null,
			legacy: true,
		});
	});

	test('malformed content degrades to no stamp, never a throw', () => {
		for (const bad of [
			'',
			'\n',
			'garbage',
			`not-a-sha ${DATE}`,
			'a334a7b6', // sha with no date
			'a334a7b6e0 not-a-date',
			`${SHA} ${DATE} two words`,
		]) {
			expect(parseBuildInfo(bad)).toEqual({
				sha: null,
				build: null,
				describe: null,
				legacy: false,
			});
		}
	});
});

describe('module-level constants (relational: a checkout AT a tag is that release)', () => {
	test('the engine version IS the release identity this tree resolves to', async () => {
		expect(DEDALO_ENGINE_VERSION).toBe(RELEASE_IDENTITY.version);
		const again = await readReleaseIdentityOf(REPO_ROOT, { triple: DEDALO_DATA_VERSION });
		expect(RELEASE_IDENTITY).toEqual(again);
		// a developer build names the NEXT triple; a tag names its own release (never below data)
		if (RELEASE_IDENTITY.kind === 'dev')
			expect(RELEASE_IDENTITY.triple).toEqual(DEDALO_NEXT_RELEASE);
		else
			expect(
				compareVersionArrays(RELEASE_IDENTITY.triple, DEDALO_DATA_VERSION),
			).toBeGreaterThanOrEqual(0);
		// the identity starts with the triple it names (the identity's own, not the data's)
		expect(DEDALO_ENGINE_VERSION.startsWith(RELEASE_IDENTITY.triple.join('.'))).toBe(true);
		expect(DEDALO_BUILD).toBe(readBuildInfoOf(REPO_ROOT).build);
	});
});

describe('TRIPWIRE — the committed placeholder and its export-subst scope', () => {
	test('build_info.txt is the unexpanded placeholder (expansion belongs to git archive only)', () => {
		expect(COMMITTED.trim()).toBe('$Format:%H %cI %(describe:match=v[0-9]*,abbrev=40)$');
	});

	test('it holds EXACTLY ONE %(describe', () => {
		expect(COMMITTED.split('%(describe').length - 1).toBe(1);
	});

	test('build_info.txt is the ONLY export-subst path (so the one %(describe is the only one an archive expands)', () => {
		const lines = readFileSync(join(REPO_ROOT, '.gitattributes'), 'utf8')
			.split('\n')
			.filter((line) => /\bexport-subst\b/.test(line) && !line.trimStart().startsWith('#'));
		expect(lines.map((line) => line.trim().split(/\s+/)[0])).toEqual([BUILD_INFO_PATH]);
	});
});

function git(cwd: string, ...args: string[]): string {
	const run = Bun.spawnSync(
		['git', '-c', 'user.name=gate', '-c', 'user.email=gate@example.org', ...args],
		{ cwd, env: { PATH: '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin', HOME: SCRATCH } },
	);
	if (run.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr.toString()}`);
	return run.stdout.toString().trim();
}

describe('the archive round-trip and the minimum git', () => {
	test(`this machine's git expands %(describe:match=…) (>= ${MIN_GIT_FOR_DESCRIBE})`, () => {
		const version = /git version (\d+)\.(\d+)/.exec(git(SCRATCH, '--version'));
		expect(version).not.toBeNull();
		const [minMajor, minMinor] = MIN_GIT_FOR_DESCRIBE.split('.').map(Number) as [number, number];
		const [major, minor] = [Number(version?.[1]), Number(version?.[2])];
		expect(major > minMajor || (major === minMajor && minor >= minMinor)).toBe(true);
	});

	test('a real git archive of a tagged commit expands the COMMITTED placeholder to <HEAD sha> <date> <tag>', () => {
		const repo = join(SCRATCH, 'repo');
		mkdirSync(join(repo, 'src', 'core', 'update'), { recursive: true });
		writeFileSync(join(repo, BUILD_INFO_PATH), COMMITTED);
		writeFileSync(join(repo, '.gitattributes'), `${BUILD_INFO_PATH} export-subst\n`);
		git(repo, 'init', '-q', '-b', 'master');
		git(repo, 'add', '-A');
		git(repo, 'commit', '-q', '-m', 'release');
		git(repo, 'tag', '-a', 'v7.0.0-beta.6', '-m', 'beta 6');
		const tar = join(SCRATCH, 'repo.tar');
		git(repo, 'archive', '--format=tar', '-o', tar, 'HEAD');
		const out = join(SCRATCH, 'out');
		mkdirSync(out);
		expect(Bun.spawnSync(['tar', '-xf', tar, '-C', out]).exitCode).toBe(0);
		const info = readBuildInfoOf(out);
		expect(info.sha).toBe(git(repo, 'rev-parse', 'HEAD'));
		expect(info.build).toBe(git(repo, 'show', '-s', '--format=%cI', 'HEAD'));
		expect(info.describe).toBe('v7.0.0-beta.6');
		expect(info.legacy).toBe(false);
	});
});
