/**
 * UPDATE DRILL CONFIG — the drill's two servers are configured from the OPERATOR CONFIG,
 * and nothing that is not configuration crosses into them.
 *
 * P0-1 residual of the 2026-08-26 deep audit (GATE-14/15). `scripts/update_drill.ts`
 * used to copy `../private/.env` byte-for-byte into the consumer install and boot the
 * master off the checkout's own file. A hosted runner has no such file — its whole
 * configuration is the process environment scripts/ci/hosted_env.sh composes — so the
 * copy threw ENOENT and the master died with `Missing required config key`: the drills
 * could not run on the instance tier at all. Now both are composed by
 * scripts/lib/operator_config.ts: the file if present, overlaid by the process
 * environment's CATALOG keys only.
 *
 * What is held:
 *   1. composition — precedence is readEnv's (process over file), and a key absent from
 *      the config catalog NEVER crosses: PATH, HOME, GITHUB_TOKEN, a shell history file,
 *      DEDALO_PRIVATE_DIR (the bootstrap pointer, not a setting) are all planted and
 *      all refused, while a catalog key and a PHP alias spelling both cross;
 *   2. rendering — `renderEnvFile` round-trips through the engine's own `parseEnvFile`
 *      for the awkward values (quotes, `#`, `=`, spaces, empty), and REFUSES a newline
 *      rather than writing a second bogus line;
 *   3. the drill — its consumer `.env` is written from the rendered operator config and
 *      its spawn base is the operator config; a byte copy of the private file is gone.
 *      Asserted on the drill's source: the script runs `main()` at import and boots real
 *      servers, so it cannot be imported here — but the two call sites are the exact
 *      shapes a regression would re-introduce, and a planted offender proves the scan
 *      sees them.
 *   4. the release clone — STEP 1 of the drill (scripts/lib/release_clone.ts) cuts the
 *      release commit on the release branch from a source whose HEAD is DETACHED at a
 *      commit no branch names: the `pull_request` checkout shape (refs/remotes/pull/N/
 *      merge). The old verb, `git branch -m`, refuses exactly that and the drills died at
 *      STEP 1 on every PR run; the leg proves the scratch source HAS that shape by
 *      running the old verb against it (RED) before running the new sequence (GREEN),
 *      then the attached-branch control, and holds the drill's source to the library.
 *
 * DB-free: pure functions, scratch git repositories under the scratch dir, a source scan.
 * Leg 1 also drives the REAL reader (`operatorConfig()`) with a planted process key —
 * the pure composition alone left a reader that ignored the environment green.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
	composeOperatorConfig,
	FORWARDABLE_KEYS,
	operatorConfig,
	renderEnvFile,
} from '../../scripts/lib/operator_config.ts';
import {
	cloneForReleaseCommit,
	currentBranch,
	overlayWorkingTree,
	runGit,
	tagNextCommit,
} from '../../scripts/lib/release_clone.ts';
import { CONFIG_CATALOG } from '../../src/config/catalog/index.ts';
import { PHP_KEY_ALIASES, parseEnvFile } from '../../src/config/env.ts';
import {
	prereleaseTagAbove,
	releaseTagsNewestFirst,
} from '../../src/core/update/code_build_plan.ts';
import { scratchDir } from '../helpers/scratch_dir.ts';

const ROOT = resolve(import.meta.dir, '../..');
const DRILL = 'scripts/update_drill.ts';

/** The shapes that would re-introduce a byte copy or a bare-env spawn. */
function byteCopyOffenders(source: string): string[] {
	return source
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => !line.startsWith('//') && !line.startsWith('*'))
		.filter(
			(line) =>
				/readFileSync\(join\(privateDir, '\.env'\)/.test(line) ||
				/copyFileSync\([^)]*privateDir/.test(line),
		);
}

describe('update drill config — operator config, catalog keys only', () => {
	test('1. process env wins over the file, and only catalog keys (or PHP alias spellings) cross', () => {
		// A catalog key present in both, one only in the file, one only in the env.
		expect(CONFIG_CATALOG.DB_HOST).toBeDefined();
		expect(CONFIG_CATALOG.ENTITY).toBeDefined();
		const phpAlias = PHP_KEY_ALIASES.DB_HOST as string; // DEDALO_HOSTNAME_CONN
		expect(phpAlias).toBeString();
		const planted = {
			DB_HOST: 'from-env',
			[phpAlias]: 'alias-from-env',
			DEDALO_TIMEZONE: 'Europe/Madrid',
			// NOT configuration — every one of these must be refused.
			PATH: '/usr/bin',
			HOME: '/home/runner',
			GITHUB_TOKEN: 'ghs_planted_token_must_never_land_on_disk',
			HISTFILE: '/home/runner/.bash_history',
			DEDALO_PRIVATE_DIR: '/tmp/somewhere-else',
			RUNNER_TEMP: '/tmp',
			UNDEFINED_KEY: undefined,
		};
		const composed = composeOperatorConfig('ENTITY=from-file\nDB_HOST=from-file\n', planted);
		expect(composed.ENTITY).toBe('from-file');
		expect(composed.DB_HOST).toBe('from-env');
		expect(composed[phpAlias]).toBe('alias-from-env');
		expect(composed.DEDALO_TIMEZONE).toBe('Europe/Madrid');
		for (const refused of [
			'PATH',
			'HOME',
			'GITHUB_TOKEN',
			'HISTFILE',
			'DEDALO_PRIVATE_DIR',
			'RUNNER_TEMP',
			'UNDEFINED_KEY',
		]) {
			expect(
				refused in composed,
				`${refused} crossed into the operator config — it is not a catalog key`,
			).toBe(false);
			expect(FORWARDABLE_KEYS.has(refused)).toBe(false);
		}
		// The runner's condition: no file at all, config is the environment alone.
		const runner = composeOperatorConfig(undefined, planted);
		expect(runner.DB_HOST).toBe('from-env');
		expect('ENTITY' in runner).toBe(false);
		expect('GITHUB_TOKEN' in runner).toBe(false);
		// Anti-vacuity: the forwardable set is the catalog, not a hand list.
		expect(FORWARDABLE_KEYS.size).toBeGreaterThan(Object.keys(CONFIG_CATALOG).length);
		expect(FORWARDABLE_KEYS.size).toBeGreaterThan(100);

		// THE REAL READER. `operatorConfig()` must overlay the process environment — on a
		// hosted runner that environment is the whole configuration. A reader that
		// composed the file alone passed every assertion above (measured by a reviewer
		// neutering it), so the planted key goes through the real door.
		const savedTz = process.env.DEDALO_TIMEZONE;
		const savedToken = process.env.GITHUB_TOKEN;
		try {
			process.env.DEDALO_TIMEZONE = 'Planted/Operator_Config_Gate';
			process.env.GITHUB_TOKEN = 'ghs_planted_for_the_real_reader';
			const real = operatorConfig();
			expect(real.DEDALO_TIMEZONE, 'operatorConfig() ignores the process environment').toBe(
				'Planted/Operator_Config_Gate',
			);
			expect('GITHUB_TOKEN' in real).toBe(false);
		} finally {
			if (savedTz === undefined) delete process.env.DEDALO_TIMEZONE;
			else process.env.DEDALO_TIMEZONE = savedTz;
			if (savedToken === undefined) delete process.env.GITHUB_TOKEN;
			else process.env.GITHUB_TOKEN = savedToken;
		}
	});

	test('2. renderEnvFile round-trips through the engine parser and refuses a newline', () => {
		const awkward: Record<string, string> = {
			PLAIN: 'value',
			EMPTY: '',
			SPACED: '  padded  ',
			HASH: 'a # not a comment',
			EQUALS: 'k=v=w',
			SINGLE: "it's",
			DOUBLE: 'say "hi"',
			QUOTED: '"already"',
			JSON_MAP: '{"lg-spa":"Castellano","lg-eng":"English"}',
			JSON_LIST: '["lg-spa","lg-eng"]',
		};
		const text = renderEnvFile(awkward);
		expect(parseEnvFile(text)).toEqual(awkward);
		expect(() => renderEnvFile({ BAD: 'line one\nline two' })).toThrow(/newline/);
		expect(() => renderEnvFile({ 'not a key': 'x' })).toThrow(/dotenv key/);
		// The GITHUB_TOKEN control end to end: composed then rendered, the token is
		// nowhere in the bytes that would land on disk.
		const rendered = renderEnvFile(
			composeOperatorConfig('ENTITY=e\n', { GITHUB_TOKEN: 'ghs_planted', DB_HOST: 'h' }),
		);
		expect(rendered).not.toContain('ghs_planted');
		expect(rendered).toContain('DB_HOST="h"');
	});

	test('3. the drill composes both servers from the operator config, never a byte copy of the private file', () => {
		// Positive controls: the scan sees the shapes it forbids, and ignores prose.
		expect(
			byteCopyOffenders("writeFileSync(f, readFileSync(join(privateDir, '.env'), 'utf8'));"),
		).toHaveLength(1);
		expect(byteCopyOffenders("copyFileSync(join(privateDir, '.env'), target);")).toHaveLength(1);
		expect(byteCopyOffenders("// used to be readFileSync(join(privateDir, '.env'))")).toHaveLength(
			0,
		);

		const source = readFileSync(join(ROOT, DRILL), 'utf8');
		expect(
			byteCopyOffenders(source),
			`${DRILL} copies the private file again — on a hosted runner there is none`,
		).toEqual([]);
		// Both composition sites, by the shapes that make them work on a runner.
		expect(source, `${DRILL} must import the operator config`).toMatch(
			/import \{[^}]*\boperatorConfig\b[^}]*\} from '\.\/lib\/operator_config\.ts'/,
		);
		expect(source, 'the consumer .env is the RENDERED operator config').toMatch(
			/writeFileSync\(consumerEnvFile, renderEnvFile\(operatorConfig\(\)\)/,
		);
		expect(
			source,
			'the spawn env is BASED on the operator config, overridden by the drill surfaces',
		).toMatch(/return \{\s*(?:\/\/[^\n]*\n\s*)*\.\.\.operatorConfig\(\),/);
		// The master is this checkout as configured: it gets the drill's private dir.
		expect(source).toMatch(/DEDALO_PRIVATE_DIR: privateDir,/);
		// STEP 1 goes through the library leg 4 proves, never a `branch -m` of its own.
		expect(
			source,
			`${DRILL} must cut its release commit through scripts/lib/release_clone.ts`,
		).toMatch(/import \{[^}]*\bcloneForReleaseCommit\b[^}]*\} from '\.\/lib\/release_clone\.ts'/);
		expect(source).toMatch(/await cloneForReleaseCommit\(\{/);
		expect(
			source
				.split('\n')
				.filter((l) => !l.trim().startsWith('//') && /'branch',\s*'-m'|branch -m/.test(l)),
			`${DRILL} renames a branch with \`branch -m\` — git refuses that on a detached HEAD (every pull_request checkout)`,
		).toEqual([]);
	});

	test('4. the release clone cuts its commit on the release branch from a DETACHED source (the pull_request checkout shape)', async () => {
		const scratch = scratchDir('release_clone_gate');
		mkdirSync(scratch, { recursive: true });
		const git = (cwd: string, ...args: string[]) => runGit(['-C', cwd, ...args], args[0] as string);
		const commit = (cwd: string, msg: string) =>
			git(
				cwd,
				'-c',
				'user.name=g',
				'-c',
				'user.email=g@localhost',
				'commit',
				'--quiet',
				'--allow-empty',
				'-m',
				msg,
			);
		try {
			// The source: a branch with two commits, then HEAD detached and moved to a
			// THIRD commit no branch points to — what actions/checkout leaves behind on a
			// pull_request event (refs/remotes/pull/N/merge).
			const source = join(scratch, 'source');
			mkdirSync(source);
			await runGit(['init', '--quiet', '-b', 'v7', source], 'init');
			writeFileSync(join(source, 'a.txt'), 'a\n');
			await git(source, 'add', '-A');
			await commit(source, 'one');
			// a HISTORICAL tag of the very version the rehearsal cuts: the shared clone
			// inherits it, and the release tag must be moved onto the new commit
			await git(source, 'tag', 'v7.0.1');
			await commit(source, 'two');
			await git(source, 'checkout', '--quiet', '--detach');
			await commit(source, 'pr merge commit');
			await git(source, 'update-ref', 'refs/remotes/pull/1/merge', 'HEAD');
			const mergeCommit = Bun.spawnSync(['git', '-C', source, 'rev-parse', 'HEAD'], {
				stdout: 'pipe',
			})
				.stdout.toString()
				.trim();
			expect(mergeCommit).toMatch(/^[0-9a-f]{40}$/);
			expect(
				currentBranch(source),
				'the scratch source is not detached — the leg would test the push shape',
			).toBeNull();

			// NEGATIVE CONTROL — the old verb against this source: the clone lands on no
			// branch and `branch -m` refuses. Without this, a source that happened to be
			// attached would make the positive leg vacuous.
			const oldWay = join(scratch, 'old_way');
			await runGit(['clone', '--shared', '--quiet', source, oldWay], 'clone');
			expect(currentBranch(oldWay)).toBeNull();
			await expect(git(oldWay, 'branch', '-m', 'master')).rejects.toThrow(
				/not on any branch|cannot rename/i,
			);

			// THE SEQUENCE the drill runs, on the detached source.
			const cloneDir = join(scratch, 'release_clone');
			let editedIn = '';
			await cloneForReleaseCommit({
				source,
				cloneDir,
				releaseBranch: 'master',
				tag: 'v7.0.1',
				message: 'release 7.0.1 (gate)',
				edit: (dir) => {
					editedIn = dir;
					writeFileSync(join(dir, '.bun-version'), 'x.y.z\n');
				},
			});
			expect(editedIn).toBe(cloneDir);
			expect(currentBranch(cloneDir), 'the release commit is not on the release branch').toBe(
				'master',
			);
			const head = Bun.spawnSync(['git', '-C', cloneDir, 'log', '-1', '--format=%s'], {
				stdout: 'pipe',
			});
			expect(head.stdout.toString().trim()).toBe('release 7.0.1 (gate)');
			// only a release TAG publishes (code_build_plan.ts): it names the release commit
			const tagged = Bun.spawnSync(
				['git', '-C', cloneDir, 'log', '-1', '--format=%s', 'refs/tags/v7.0.1'],
				{ stdout: 'pipe' },
			);
			expect(tagged.stdout.toString().trim()).toBe('release 7.0.1 (gate)');
			const clean = Bun.spawnSync(['git', '-C', cloneDir, 'status', '--porcelain'], {
				stdout: 'pipe',
			});
			expect(clean.stdout.toString(), 'the edit was not committed').toBe('');
			// `master` names the release commit AND descends from the PR merge commit.
			const ancestry = Bun.spawnSync(
				['git', '-C', cloneDir, 'merge-base', '--is-ancestor', mergeCommit, 'master'],
				{ stdout: 'pipe', stderr: 'pipe' },
			);
			expect(
				ancestry.exitCode,
				'the release branch does not descend from the detached source commit',
			).toBe(0);

			// CONTROL — the attached (push-event) shape still works, including the `--dev`
			// spelling: `master` while the source is on another branch, and NO tag.
			await git(source, 'checkout', '--quiet', 'v7');
			const attached = join(scratch, 'attached_clone');
			await cloneForReleaseCommit({
				source,
				cloneDir: attached,
				releaseBranch: 'master',
				message: 'release dev (gate)',
				edit: (dir) => writeFileSync(join(dir, '.bun-version'), 'x.y.z\n'),
			});
			expect(currentBranch(attached)).toBe('master');
			// the inherited historical tag stays where it was: a dev pass tags nothing
			const untouched = Bun.spawnSync(
				['git', '-C', attached, 'log', '-1', '--format=%s', 'refs/tags/v7.0.1'],
				{ stdout: 'pipe' },
			);
			expect(untouched.stdout.toString().trim()).toBe('one');
			expect(existsSync(join(attached, 'a.txt'))).toBe(true);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	test('5. the drill tests the WORKING TREE: uncommitted edits reach the clone and the consumer export; each prerelease-leg tag gets its own annotated commit', async () => {
		const scratch = scratchDir('overlay_gate');
		mkdirSync(scratch, { recursive: true });
		const git = (cwd: string, ...args: string[]) => runGit(['-C', cwd, ...args], args[0] as string);
		const stdout = (cwd: string, ...args: string[]) =>
			Bun.spawnSync(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe' })
				.stdout.toString()
				.trim();
		try {
			const source = join(scratch, 'source');
			const stampDir = join(source, 'src', 'core', 'update');
			mkdirSync(stampDir, { recursive: true });
			await runGit(['init', '--quiet', '-b', 'master', source], 'init');
			writeFileSync(join(source, 'kept.txt'), 'committed\n');
			writeFileSync(join(source, 'gone.txt'), 'committed\n');
			writeFileSync(join(stampDir, 'build_info.txt'), '$Format:%H$\n');
			await git(source, 'add', '-A');
			await git(
				source,
				'-c',
				'user.name=g',
				'-c',
				'user.email=g@localhost',
				'commit',
				'--quiet',
				'-m',
				'one',
			);
			// The UNCOMMITTED state a developer runs the drill on.
			writeFileSync(join(source, 'kept.txt'), 'edited\n');
			rmSync(join(source, 'gone.txt'));
			mkdirSync(join(source, 'src', 'new'), { recursive: true });
			writeFileSync(join(source, 'src', 'new', 'leaf.ts'), 'untracked\n');
			writeFileSync(join(source, 'stray_root.txt'), 'not ours\n');
			// never carried: the archive expands the stamp, the checkout holds a placeholder
			writeFileSync(join(stampDir, 'build_info.txt'), 'edited placeholder\n');

			// The consumer shape: a `git archive HEAD` export, then the overlay.
			const exported = join(scratch, 'export');
			mkdirSync(exported);
			const tar = Bun.spawnSync(
				['bash', '-c', `git -C '${source}' archive --format=tar HEAD | tar -x -C '${exported}'`],
				{ stdout: 'ignore', stderr: 'pipe' },
			);
			expect(tar.exitCode).toBe(0);
			// NEGATIVE CONTROL — HEAD alone is the old drill: the edit is absent.
			expect(readFileSync(join(exported, 'kept.txt'), 'utf8')).toBe('committed\n');
			const overlay = overlayWorkingTree(source, exported);
			expect(readFileSync(join(exported, 'kept.txt'), 'utf8')).toBe('edited\n');
			expect(existsSync(join(exported, 'gone.txt')), 'a deleted file survived the overlay').toBe(
				false,
			);
			expect(readFileSync(join(exported, 'src', 'new', 'leaf.ts'), 'utf8')).toBe('untracked\n');
			expect(
				existsSync(join(exported, 'stray_root.txt')),
				'an untracked ROOT file was carried',
			).toBe(false);
			expect(readFileSync(join(exported, 'src', 'core', 'update', 'build_info.txt'), 'utf8')).toBe(
				'$Format:%H$\n',
			);
			expect(overlay.copied.sort()).toEqual(['kept.txt', 'src/new/leaf.ts']);
			expect(overlay.removed).toEqual(['gone.txt']);
			expect(overlay.skipped).toEqual(['stray_root.txt']);
			// The source is read, never written: its uncommitted state is untouched.
			expect(stdout(source, 'status', '--porcelain').split('\n').length).toBe(5);

			// The source ALREADY holds release tags of the leg's triple and above —
			// the real `v7.0.1` once it is cut, a real rc, a later beta — plus an
			// older one. A shared clone inherits them all.
			const inherited = ['v7.0.0', 'v7.0.1', 'v7.0.1-rc.1', 'v7.0.2-beta.1'];
			for (const tag of inherited) await git(source, 'tag', tag);

			// The release-clone shape: the overlay inside the edit is COMMITTED.
			const cloneDir = join(scratch, 'clone');
			const cloned = await cloneForReleaseCommit({
				source,
				cloneDir,
				releaseBranch: 'master',
				tag: 'v7.0.1-beta.1',
				dropReleaseTagsFrom: [7, 0, 1],
				message: 'release (gate)',
				edit: (dir) => {
					overlayWorkingTree(source, dir);
				},
			});
			// OUTCOME, as Build prerelease computes it over the clone's whole tag set
			// (code_build_plan.ts): the drill's own first tag is THE prerelease to
			// build — not superseded by the inherited `v7.0.1`, not displaced by the
			// inherited rc.
			const cloneTags = stdout(cloneDir, 'tag', '--list', 'v*').split('\n');
			expect(
				prereleaseTagAbove(
					releaseTagsNewestFirst(cloneTags, 'prerelease')[0] ?? null,
					releaseTagsNewestFirst(cloneTags, 'stable')[0] ?? null,
				),
				'an inherited release tag decides what the leg builds',
			).toBe('v7.0.1-beta.1');
			expect(cloned.droppedTags.sort()).toEqual(['v7.0.1', 'v7.0.1-rc.1', 'v7.0.2-beta.1']);
			expect(cloneTags.sort()).toEqual(['v7.0.0', 'v7.0.1-beta.1']);
			// the SOURCE's tags are untouched: the clone's refs are its own
			expect(stdout(source, 'tag', '--list').split('\n').sort()).toEqual(inherited.sort());
			expect(stdout(cloneDir, 'show', 'HEAD:kept.txt')).toBe('edited');
			expect(stdout(cloneDir, 'show', 'HEAD:src/new/leaf.ts')).toBe('untracked');
			expect(stdout(cloneDir, 'status', '--porcelain')).toBe('');

			// tagNextCommit: a NEW commit per tag, annotated — so each archive's
			// %(describe) names exactly its own tag.
			await tagNextCommit(cloneDir, 'v7.0.1-beta.2');
			await tagNextCommit(cloneDir, 'v7.0.1');
			const commits = ['v7.0.1-beta.1', 'v7.0.1-beta.2', 'v7.0.1'].map((tag) =>
				stdout(cloneDir, 'rev-list', '-n', '1', tag),
			);
			expect(new Set(commits).size, 'two tags share a commit').toBe(3);
			for (const tag of ['v7.0.1-beta.2', 'v7.0.1']) {
				expect(stdout(cloneDir, 'cat-file', '-t', tag), `${tag} is lightweight`).toBe('tag');
				expect(stdout(cloneDir, 'describe', '--exact-match', `${tag}^{commit}`)).toBe(tag);
			}
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});
});
