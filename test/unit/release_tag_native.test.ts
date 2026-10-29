/**
 * RELEASE TAG CHECK (scripts/lib/release_tag.ts) — RELEASE_IDENTITY design gate 11 —
 * and the minimum git a release archive is built with (gate 2's refusal half).
 *
 * GATE 11: a tag `v<identity>` is publishable only when ITS commit declares the tag's
 * triple in version.ts AND carries `changes/<identity>/release.json`, the changelog cut
 * of exactly that release (version = identity, `to` = the tag). Judged here on a REAL
 * scratch git repository through the real `git show` lookups and the real CLI the
 * pre-push hook runs (`bun run push:release-tag`, the REAL package.json entry, run from
 * this checkout against the scratch repository through GIT_DIR); the hook's wiring is gated in
 * pre_push_gate_native, the image-release plan's in image_release_native — both call
 * this one function.
 *
 * The working tree is never the evidence: a cut sitting uncommitted next to a tag that
 * lacks it is still refused.
 *
 * MIN_GIT_FOR_DESCRIBE: gitDescribeSupportFault's table — the version is SOURCED in
 * release_identity.ts (git RelNotes 2.32/2.35 + pretty-formats.txt at v2.32/v2.34/v2.35).
 *
 * DB-free; spawns git + bun in a scratch directory: hermetic tier.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	FIRST_CUT_RELEASE,
	gitShowLookups,
	NOTHING_TO_HOLD,
	predatesReleaseCutRule,
	releaseNotesPath,
	releaseTagFault,
} from '../../scripts/lib/release_tag.ts';
import {
	gitDescribeSupportFault,
	MIN_GIT_FOR_DESCRIBE,
} from '../../src/core/update/release_identity.ts';

const ROOT = join(import.meta.dir, '..', '..');
const PROGRAM = join(ROOT, 'scripts', 'lib', 'release_tag.ts');

// A tagged commit names its release in DEDALO_NEXT_RELEASE (RELEASE.md step 1); the
// data triple is the lower bound, and a code-only release leaves it below the name.
const VERSION_TS = (data: string, release: string = data) =>
	(
		[
			['DEDALO_DATA_VERSION', data],
			['DEDALO_NEXT_RELEASE', release],
		] as const
	)
		.map(
			([constant, triple]) =>
				`export const ${constant}: readonly [number, number, number] = Object.freeze([\n\t${triple.split('.').join(', ')},\n]) as [number, number, number];\n`,
		)
		.join('');

let repo = '';
const git = (...args: string[]): string => {
	const result = Bun.spawnSync(
		['git', '-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args],
		{ stdout: 'pipe', stderr: 'pipe' },
	);
	if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr.toString()}`);
	return result.stdout.toString().trim();
};
const write = (path: string, text: string) => {
	mkdirSync(join(repo, path, '..'), { recursive: true });
	writeFileSync(join(repo, path), text);
};
const cutJson = (version: string, to: string) =>
	`${JSON.stringify({ version, date: '2026-10-15', from: null, to, commits: 3, wire_contract: [] }, null, '\t')}\n`;
const commit = (message: string): string => {
	git('add', '-A');
	git('commit', '--quiet', '-m', message);
	return git('rev-parse', 'HEAD');
};

/** The commits of the truth table, by name. */
const at: Record<string, string> = {};

beforeAll(() => {
	repo = mkdtempSync(join(tmpdir(), 'dedalo-release-tag-'));
	git('init', '--quiet', '-b', 'master');
	write('src/core/update/version.ts', VERSION_TS('7.0.1'));
	at.uncut = commit('7.0.1, no cut');
	write(releaseNotesPath('7.0.1'), cutJson('7.0.1', 'v7.0.1'));
	at.stable = commit('cut 7.0.1');
	write('src/core/update/version.ts', VERSION_TS('7.0.2'));
	write(releaseNotesPath('7.0.2-beta.1'), cutJson('7.0.2-beta.1', 'v7.0.2-beta.1'));
	at.prerelease = commit('cut 7.0.2-beta.1');
	// A cut of ANOTHER release only (its directory is not the tag's).
	write(releaseNotesPath('7.0.2-beta.2'), cutJson('7.0.2-beta.1', 'v7.0.2-beta.1'));
	at.mislabelled = commit('a release.json naming another version');
	write(releaseNotesPath('7.0.2-rc.1'), '{"version": "7.0.2-rc.1"\n');
	at.broken = commit('an unparseable cut');
	// The working tree holds a cut the commits do not: it must never count.
	write(releaseNotesPath('7.0.2'), cutJson('7.0.2', 'v7.0.2'));
	// The tag OBJECTS the push door is handed: annotated on the cut commits, plus one
	// LIGHTWEIGHT tag on a cut commit (the push hands the commit itself as the object).
	git('tag', '-a', '-m', 'release', 'v7.0.1', at.stable as string);
	git('tag', '-a', '-m', 'beta', 'v7.0.2-beta.1', at.prerelease as string);
	git('tag', 'v7.0.2-beta.1-light', at.prerelease as string);
	obj.stable = git('rev-parse', 'refs/tags/v7.0.1');
	obj.prerelease = git('rev-parse', 'refs/tags/v7.0.2-beta.1');
});

/** The pushed tag objects, by name (an annotated tag's object is not its commit). */
const obj: Record<string, string> = {};
afterAll(() => rmSync(repo, { recursive: true, force: true }));

const fault = (tag: string, name: string) =>
	releaseTagFault(tag, at[name] as string, gitShowLookups(repo));

describe('GATE 11 — a release tag is publishable only when its commit is the cut release', () => {
	test('a stable tag on the commit that declares its triple and carries its cut passes', () => {
		expect(fault('v7.0.1', 'stable')).toBeNull();
	});

	test('a prerelease tag passes on the same terms (identity 7.0.2-beta.1, data triple 7.0.2)', () => {
		expect(fault('v7.0.2-beta.1', 'prerelease')).toBeNull();
	});

	test('the commit before the cut is refused, naming the file and the command that cuts it', () => {
		const why = fault('v7.0.1', 'uncut');
		expect(why).toContain('carries no changes/7.0.1/release.json');
		expect(why).toContain('bun run changelog release 7.0.1');
	});

	test('a code-only release names its NEXT triple, not the data triple it keeps (the drill case)', () => {
		write('src/core/update/version.ts', VERSION_TS('7.0.0', '7.0.1'));
		write(releaseNotesPath('7.0.1'), cutJson('7.0.1', 'v7.0.1'));
		const codeOnly = commit('code-only 7.0.1: data stays 7.0.0');
		expect(releaseTagFault('v7.0.1', codeOnly, gitShowLookups(repo))).toBeNull();
		expect(releaseTagFault('v7.0.0', codeOnly, gitShowLookups(repo))).toContain('declares 7.0.1');
	});

	test("a tag naming another triple than the commit's version.ts is refused", () => {
		expect(fault('v7.0.3', 'stable')).toContain('declares 7.0.1');
		expect(fault('v7.0.1-rc.1', 'prerelease')).toContain('declares 7.0.2');
	});

	test('a release.json that is not the cut of THIS identity, or not a cut at all, is refused', () => {
		expect(fault('v7.0.2-beta.2', 'mislabelled')).toContain('is the cut of 7.0.2-beta.1');
		expect(fault('v7.0.2-rc.1', 'broken')).toContain('is not a JSON object');
	});

	test('a cut present only in the WORKING TREE does not count — the commit is the evidence', () => {
		expect(fault('v7.0.2', 'broken')).toContain('carries no changes/7.0.2/release.json');
	});

	test('a name outside the release grammar is refused by the function (the caller picks release tags)', () => {
		for (const tag of ['7.0.1', 'v7.0.01', 'v7.0.1.dev', 'v7.0.1-pre.1', 'v6.0.0.beta.1'])
			expect(fault(tag, 'stable'), tag).toContain('is not a release tag');
	});
});

describe('the CLI the pre-push hook runs (bun run push:release-tag <tag> <commit> <object>)', () => {
	const cli = (...args: string[]) => {
		const proc = Bun.spawnSync([process.execPath, PROGRAM, ...args], {
			cwd: repo,
			stdout: 'pipe',
			stderr: 'pipe',
		});
		return { code: proc.exitCode ?? 1, text: proc.stdout.toString() + proc.stderr.toString() };
	};

	test('exit 0 for a cut, annotated release (stable or prerelease), 1 with the reason for an uncut one', () => {
		expect(obj.stable).not.toBe(at.stable); // the annotated tag object is its own object
		expect(cli('check', 'v7.0.1', at.stable as string, obj.stable as string).code).toBe(0);
		expect(
			cli('check', 'v7.0.2-beta.1', at.prerelease as string, obj.prerelease as string).code,
		).toBe(0);
		const refused = cli('check', 'v7.0.1', at.uncut as string, obj.stable as string);
		expect(refused.code).toBe(1);
		expect(refused.text).toContain('REFUSED — tag v7.0.1:');
	});

	test('GATE 18: a LIGHTWEIGHT release tag is refused (stable or prerelease), however cut its commit', () => {
		// The push hands the COMMIT as the object of a lightweight tag — the archive's
		// %(describe) cannot see it, so the release would call itself `.dev`.
		for (const [tag, commit] of [
			['v7.0.2-beta.1', at.prerelease],
			['v7.0.1', at.stable],
		] as const) {
			const light = cli('check', tag, commit as string, commit as string);
			expect(light.code, light.text).toBe(1);
			expect(light.text).toContain(`tag ${tag} is a LIGHTWEIGHT tag (it names a commit)`);
			expect(light.text).toContain('git tag -a');
		}
		// a real lightweight ref, resolved as the hook resolves it
		const lightObject = git('rev-parse', 'refs/tags/v7.0.2-beta.1-light');
		expect(lightObject).toBe(at.prerelease as string);
		expect(cli('check', 'v7.0.2-beta.1', at.prerelease as string, lightObject).code).toBe(1);
		// an object git cannot read is no evidence: refused too
		const unreadable = cli('check', 'v7.0.1', at.stable as string, 'f'.repeat(40));
		expect(unreadable.code).toBe(1);
		expect(unreadable.text).toContain('an object git cannot read');
	});

	test(`a v* name that is no release identity (an old v6 tag shape) holds nothing: exit ${NOTHING_TO_HOLD}`, () => {
		const old = cli('check', 'v6.0.0.beta.1', at.uncut as string, at.uncut as string);
		expect(old.code, old.text).toBe(NOTHING_TO_HOLD);
		expect(old.text).toContain('not a release identity tag');
	});

	test(`a tag published before the rule (below v${FIRST_CUT_RELEASE}) is history: exit ${NOTHING_TO_HOLD}, said out loud — lightweight or not`, () => {
		// The commit holds no cut for any of them (and v6/v4 no matching version.ts): each
		// would be refused by releaseTagFault, which stays strict for the image plan. The
		// object is the bare commit (a lightweight tag): history is not held to Q7 either.
		for (const tag of ['v7.0.0-beta.5', 'v7.0.0-alpha.1', 'v6.4.0-beta.1', 'v4.0.0']) {
			expect(releaseTagFault(tag, at.uncut as string, gitShowLookups(repo)), tag).not.toBeNull();
			const old = cli('check', tag, at.uncut as string, at.uncut as string);
			expect(old.code, `${tag}: ${old.text}`).toBe(NOTHING_TO_HOLD);
			expect(old.text).toContain('predates the cut rule');
		}
	});

	test(`the floor itself (v${FIRST_CUT_RELEASE}) and everything above it are held`, () => {
		expect(predatesReleaseCutRule(FIRST_CUT_RELEASE)).toBe(false);
		for (const tag of [`v${FIRST_CUT_RELEASE}`, 'v7.0.0-rc.1', 'v7.0.0']) {
			const held = cli('check', tag, at.uncut as string, obj.stable as string);
			expect(held.code, `${tag}: ${held.text}`).toBe(1);
			expect(held.text).toContain('REFUSED');
		}
	});

	test('a malformed call is a usage error (2), never a pass', () => {
		expect(cli('check', 'v7.0.1').code).toBe(2);
		// the object is REQUIRED: without it the annotation rule could not be held
		expect(cli('check', 'v7.0.1', at.stable as string).code).toBe(2);
		expect(cli('verify', 'v7.0.1', at.stable as string, obj.stable as string).code).toBe(2);
	});
});

describe("the hook's door is the REAL package.json script (bun run push:release-tag)", () => {
	// Run exactly as the hook runs it, from this checkout, so a script entry that ignores
	// its arguments (`"push:release-tag": "true"`) is red. GIT_DIR points the check's
	// `git show` at the scratch repository's objects.
	const viaScript = (tag: string, name: string) => {
		const proc = Bun.spawnSync(
			['bun', 'run', 'push:release-tag', tag, at[name] as string, obj.stable as string],
			{
				cwd: ROOT,
				stdout: 'pipe',
				stderr: 'pipe',
				env: { ...Bun.env, GIT_DIR: join(repo, '.git') },
			},
		);
		return { code: proc.exitCode ?? 1, text: proc.stdout.toString() + proc.stderr.toString() };
	};

	test('an uncut commit is refused (exit 1, the reason), the cut one passes', () => {
		const refused = viaScript('v7.0.1', 'uncut');
		expect(refused.code, refused.text).toBe(1);
		expect(refused.text).toContain('carries no changes/7.0.1/release.json');
		const passed = viaScript('v7.0.1', 'stable');
		expect(passed.code, passed.text).toBe(0);
		expect(passed.text).toContain('annotated, and version.ts and the changelog cut agree');
	});
});

describe(`the minimum git that stamps the tag into an archive (${MIN_GIT_FOR_DESCRIBE})`, () => {
	test('older than the minimum is a fault naming it; the minimum and newer pass', () => {
		for (const old of ['git version 2.34.8', 'git version 2.32.0', 'git version 1.9.5'])
			expect(gitDescribeSupportFault(old), old).toContain(`git ${MIN_GIT_FOR_DESCRIBE} or newer`);
		for (const ok of [
			`git version ${MIN_GIT_FOR_DESCRIBE}.0`,
			'git version 2.39.5 (Apple Git-154)',
			'git version 2.51.0',
			'git version 3.0.0',
		])
			expect(gitDescribeSupportFault(ok), ok).toBeNull();
	});

	test('an unreadable answer is a fault (fail closed), never a pass', () => {
		for (const garbage of ['', 'hub version 2.14', 'git version'])
			expect(gitDescribeSupportFault(garbage), garbage).toContain('could not be read');
	});

	test("this machine's git passes (it builds this repository's archives)", () => {
		const version = Bun.spawnSync(['git', '--version'], { stdout: 'pipe' }).stdout.toString();
		expect(gitDescribeSupportFault(version)).toBeNull();
	});
});
