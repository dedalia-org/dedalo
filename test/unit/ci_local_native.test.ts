/**
 * GATE — `ci:local --docker` tests THE TREE ON DISK, and its `--summary` names the stages
 * the tier scripts actually ran (scripts/ci_local.ts).
 *
 * Two things the pre-push hook trusts without seeing:
 *
 *   1. THE OVERLAY (`workingTreeLists`). The container gets HEAD + the paths to copy +
 *      the paths to delete. Proven by OUTCOME in a scratch repo that builds every state
 *      a developer's tree can be in — unstaged edit, STAGED edit, staged new file,
 *      untracked file, ignored file, unstaged delete, `git rm`, a staged rename, a staged
 *      edit reverted on disk. The defect this pins (2026-09-26): `ls-files --modified`
 *      compares disk with the INDEX, so every staged change vanished and the container
 *      tested a tree that was not the one on disk.
 *   2. THE STAGE PARSER (`parseStages`). The summary is read back from the tier scripts'
 *      own `== <prefix>: …` protocol. Fixture outputs pin every verdict path (red,
 *      SKIPPED from a child, died-under-set-e, the final verdict line that is
 *      NOT a stage, a workflow step, ANSI, bun's recap dedup, drift blocks → fix_hint);
 *      and the REAL tier scripts are read to prove they still speak that protocol under
 *      the prefix `TIERS` expects — a renamed prefix or marker would otherwise empty the
 *      summary silently.
 *
 *   3. A HOSTILE AMBIENT GIT_* (GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE exported, as git
 *      does into a hook run from a linked worktree) redirects neither this file's scratch
 *      git calls nor `workingTreeLists`: a decoy repository comes out byte-identical.
 *
 *   4. A LINKED WORKTREE (`containerMounts` + the driver's clone line). The worktree's `.git`
 *      is a file naming a host path; the container clones the COMMON git dir mounted
 *      beside it. Proven by copying each mount into a sandbox, moving the originals away,
 *      and running the driver's own clone source — with the old source as negative control.
 *      A repository whose objects come through ALTERNATES (`git clone --shared`) is refused
 *      up front (exit 2, naming the file) — its objects live at a host path the container
 *      cannot see; a plain clone of the same repository is the positive control.
 *
 *   5. A SYMLINKED top-level node_modules (the one the hook lends a linked worktree) is not
 *      in the overlay: `.gitignore`'s `node_modules/` matches only a directory, so git lists
 *      the link as untracked, and the container died at `bun install` on a dangling link.
 *
 *   6. THE UNIT STAGE IS BLOCKING, AND THE DESK SKIP IS RETIRED (2026-10-02). db_tier.sh's
 *      unit stage is pinned line-for-line, its raise included; `--skip-advisory` (what the
 *      pre-push hook used to pass) is REFUSED by the CLI, exit 2, naming why — never a
 *      generic unknown flag, never silently ignored; no tier script, compose file or the
 *      CLI names the retired key; an own-prefix SKIPPED line still never launders a red.
 *      That the stage's red fails the WHOLE tier script is tier_wiring leg L (executed).
 *
 *   7. `--record-unit-baseline` (the unit baseline recorded IN THE IMAGE): refused outside
 *      --docker and beside any flag that would change what is recorded; `--allow-regression`
 *      only with a `--reason`; both record keys ALWAYS set explicitly (a shell export never
 *      turns a check into a write); and EXECUTED — db_tier.sh's own pinned stage block runs
 *      in bash with `bun`/`cp` stubbed: record mode runs the WRITER (never --check), passes
 *      --allow-regression only on ALLOW=1, `--record-new <files>` only on NEW=<files>, copies
 *      out only a write that was not refused and raises the tier on a refusal; with the keys
 *      off it runs the check. The recording reaches the checkout only from a GREEN db tier
 *      (recordCopyFault), and `--ref` must be this checkout's HEAD on a clean tree
 *      (recordRefFault). `--new <files>` takes only unit-tier test paths, never beside
 *      --allow-regression.
 *
 * HERMETIC: a scratch git repo under the OS temp dir, and repo files read. No DB, no
 * docker, no network, no repo file written. Every git spawned here gets NO GIT_* variable.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import {
	accessSync,
	chmodSync,
	cpSync,
	existsSync,
	constants as fsConstants,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	CI_LOGS_DIR,
	CONTAINER_GIT,
	CONTAINER_LOG_DIR,
	CONTAINER_OUT,
	CONTAINER_SRC,
	containerMounts,
	DEFAULT_UNIT_BINS,
	DRIVER_SCRIPT,
	dockerComposeEnv,
	failFastSkip,
	finishDockerRun,
	gitScrubbedEnv,
	INSTANCE_LANES,
	instanceLanesEnv,
	instanceLanesFault,
	keepRunLogs,
	MAX_UNIT_BINS,
	orphanCiVolumes,
	parseStages,
	prefixLines,
	pruneRunLogs,
	recordArgsFault,
	recordCopyFault,
	recordEnv,
	recordNewFiles,
	recordRefFault,
	runStreaming,
	type Stage,
	statRunDir,
	stepsFileName,
	TIERS,
	tierSchedule,
	type TierResult,
	unitBinsEnv,
	unitBinsFault,
	workingTreeLists,
} from '../../scripts/ci_local.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..');

// ── 1. the overlay ───────────────────────────────────────────────────────────

const scratch = mkdtempSync(join(tmpdir(), 'dedalo-ci-local-gate-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/**
 * The environment of every git THIS FILE spawns: no GIT_* at all. A scratch repo is named
 * by `cwd`; an inherited GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE (a hook's context, a
 * caller's export) would override it and run `init`, `add`, `commit`, `rm` against that
 * repository — this checkout, when `bun test` runs under a hook. Read at call time, so the
 * hostile-environment case below exercises it.
 */
function noGitEnv(): Record<string, string | undefined> {
	return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
}

function sh(args: string[], cwd: string = scratch): void {
	const proc = Bun.spawnSync(
		[
			'git',
			'-c',
			'user.name=gate',
			'-c',
			'user.email=gate@example.invalid',
			'-c',
			'commit.gpgsign=false',
			'-c',
			'core.hooksPath=/dev/null',
			...args,
		],
		{ cwd, env: noGitEnv(), stdout: 'pipe', stderr: 'pipe' },
	);
	if (proc.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${proc.stderr.toString()}`);
}
function gitOut(cwd: string, args: string[]): string {
	const proc = Bun.spawnSync(['git', ...args], {
		cwd,
		env: noGitEnv(),
		stdout: 'pipe',
		stderr: 'pipe',
	});
	if (proc.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${proc.stderr.toString()}`);
	return proc.stdout.toString();
}
const put = (path: string, text: string, root: string = scratch) => {
	mkdirSync(join(root, path, '..'), { recursive: true });
	writeFileSync(join(root, path), text);
};

describe('workingTreeLists — the overlay is HEAD vs THE DISK', () => {
	sh(['init', '-q', '-b', 'main']);
	for (const name of [
		'unstaged_edit',
		'staged_edit',
		'staged_then_reverted',
		'unstaged_delete',
		'git_rm',
		'rename_from',
		'untouched',
	])
		put(`tracked/${name}.txt`, `${name}\n`);
	put('.gitignore', 'ignored.txt\n');
	sh(['add', '-A']);
	sh(['commit', '-q', '-m', 'base']);

	put('tracked/unstaged_edit.txt', 'changed\n');
	put('tracked/staged_edit.txt', 'changed\n');
	sh(['add', 'tracked/staged_edit.txt']);
	put('tracked/staged_then_reverted.txt', 'changed\n');
	sh(['add', 'tracked/staged_then_reverted.txt']);
	put('tracked/staged_then_reverted.txt', 'staged_then_reverted\n');
	put('new/staged_new.txt', 'new\n');
	sh(['add', 'new/staged_new.txt']);
	put('new/untracked.txt', 'new\n');
	put('ignored.txt', 'ignored\n');
	rmSync(join(scratch, 'tracked/unstaged_delete.txt'));
	sh(['rm', '-q', 'tracked/git_rm.txt']);
	sh(['mv', 'tracked/rename_from.txt', 'tracked/rename_to.txt']);
	put('with space/ütf8 name.txt', 'quoted path\n');

	const lists = workingTreeLists(scratch);

	test('every path that differs on disk is copied — staged or not', () => {
		expect(lists.copy).toEqual([
			'new/staged_new.txt',
			'new/untracked.txt',
			'tracked/rename_to.txt',
			'tracked/staged_edit.txt',
			'tracked/unstaged_edit.txt',
			'with space/ütf8 name.txt',
		]);
	});

	test('every path HEAD has and the disk does not is deleted — git rm and rename source too', () => {
		expect(lists.remove).toEqual([
			'tracked/git_rm.txt',
			'tracked/rename_from.txt',
			'tracked/unstaged_delete.txt',
		]);
	});

	test('what equals HEAD on disk (a staged edit reverted, untouched, ignored) is not in the overlay', () => {
		const all = [...lists.copy, ...lists.remove];
		expect(all).not.toContain('tracked/staged_then_reverted.txt');
		expect(all).not.toContain('tracked/untouched.txt');
		expect(all).not.toContain('ignored.txt');
	});
});

// ── 1b. a hostile ambient GIT_* never redirects a git call ──────────────────

describe('a hostile GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE in the environment', () => {
	test('gitScrubbedEnv drops every repository-local variable and keeps transport ones', () => {
		const env = gitScrubbedEnv({
			PATH: '/usr/bin',
			GIT_DIR: '/x/.git',
			GIT_WORK_TREE: '/x',
			GIT_INDEX_FILE: '/x/.git/index',
			GIT_COMMON_DIR: '/x/.git',
			GIT_OBJECT_DIRECTORY: '/x/.git/objects',
			GIT_CONFIG_COUNT: '1',
			GIT_CONFIG_KEY_0: 'core.worktree',
			GIT_CONFIG_VALUE_0: '/x',
			GIT_SSH_COMMAND: 'ssh -i key',
			GIT_CONFIG_GLOBAL: '/home/me/.gitconfig',
		});
		expect(Object.keys(env).sort()).toEqual(['GIT_CONFIG_GLOBAL', 'GIT_SSH_COMMAND', 'PATH']);
	});

	test('building a scratch repo and listing its overlay touch only the scratch repo, never the decoy', () => {
		// The decoy stands in for "the real repository": a committed repo whose refs,
		// index and working tree must come out byte-identical.
		const decoy = join(scratch, 'decoy');
		mkdirSync(decoy, { recursive: true });
		sh(['init', '-q', '-b', 'main'], decoy);
		put('kept.txt', 'decoy\n', decoy);
		sh(['add', '-A'], decoy);
		sh(['commit', '-q', '-m', 'decoy'], decoy);
		const decoyState = () => ({
			refs: gitOut(decoy, ['for-each-ref', '--format=%(refname) %(objectname)']),
			status: gitOut(decoy, ['status', '--porcelain', '--untracked-files=all']),
			index: readFileSync(join(decoy, '.git', 'index')).toString('base64'),
			log: gitOut(decoy, ['log', '--all', '--format=%H %s']),
		});
		const before = decoyState();

		const hostile = {
			GIT_DIR: join(decoy, '.git'),
			GIT_WORK_TREE: decoy,
			GIT_INDEX_FILE: join(decoy, '.git', 'index'),
		};
		const saved = Object.fromEntries(Object.keys(hostile).map((key) => [key, process.env[key]]));
		const target = join(scratch, 'target');
		mkdirSync(target, { recursive: true });
		let lists: { copy: string[]; remove: string[] };
		try {
			Object.assign(process.env, hostile);
			sh(['init', '-q', '-b', 'main'], target);
			put('a.txt', 'a\n', target);
			put('gone.txt', 'gone\n', target);
			sh(['add', '-A'], target);
			sh(['commit', '-q', '-m', 'base'], target);
			put('a.txt', 'changed\n', target);
			put('new.txt', 'new\n', target);
			sh(['rm', '-q', 'gone.txt'], target);
			lists = workingTreeLists(target);
		} finally {
			for (const [key, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
		// The scratch repo got the commit and its overlay describes IT …
		expect(gitOut(target, ['log', '--format=%s'])).toBe('base\n');
		expect(lists).toEqual({ copy: ['a.txt', 'new.txt'], remove: ['gone.txt'] });
		// … and the decoy is exactly as it was.
		expect(decoyState()).toEqual(before);
	});
});

// ── 1c. a linked worktree: the container can clone what it is mounted ─────────

describe('containerMounts — from a LINKED WORKTREE the container still clones the commit', () => {
	// The defect (2026-09-26): only the worktree was mounted, its `.git` is a FILE naming a
	// HOST path, and the driver's `git clone … /src` died in the container. Measured by
	// outcome: each mount is COPIED to <sandbox><container path>, the originals are moved
	// away (so no host path resolves — the container's condition), and the DRIVER'S OWN
	// clone line runs against the sandbox.
	const root = join(scratch, 'wt');
	const main = join(root, 'main');
	const linked = join(root, 'linked');
	mkdirSync(main, { recursive: true });
	sh(['init', '-q', '-b', 'main'], main);
	put('a.txt', 'a\n', main);
	sh(['add', '-A'], main);
	sh(['commit', '-q', '-m', 'a'], main);
	sh(['worktree', 'add', '-q', linked, '-b', 'feat'], main);
	put('b.txt', 'b\n', linked);
	sh(['add', '-A'], linked);
	sh(['commit', '-q', '-m', 'b'], linked);
	const sha = gitOut(linked, ['rev-parse', 'HEAD']).trim();
	const mounts = containerMounts(linked);
	const plain = containerMounts(main);

	const sandbox = join(scratch, 'container');
	for (const mount of mounts)
		cpSync(mount.host, join(sandbox, mount.container), { recursive: true, verbatimSymlinks: true });
	renameSync(root, join(scratch, 'wt_moved_away'));

	const cloneLine = DRIVER_SCRIPT.match(/^git clone (?:--\S+ )*(\/\S+) dedalo$/m);
	const tarSource = DRIVER_SCRIPT.match(/tar -C (\/\S+) --null -T \/ci-in\/copy\.lst/);
	const clone = (source: string, into: string) =>
		Bun.spawnSync(
			['git', 'clone', '--quiet', '--shared', '--no-checkout', join(sandbox, source), into],
			{
				cwd: sandbox,
				env: noGitEnv(),
				stdout: 'pipe',
				stderr: 'pipe',
			},
		);

	test('two mounts: the checkout at CONTAINER_SRC, the COMMON git dir at CONTAINER_GIT', () => {
		expect(mounts.map((mount) => mount.container)).toEqual([CONTAINER_SRC, CONTAINER_GIT]);
		expect(mounts[1]?.host).toMatch(/\/wt\/main\/\.git$/);
		// A plain checkout: its own .git is the common dir.
		expect(plain.map((mount) => mount.host.replace(/.*\/wt\//, ''))).toEqual(['main', 'main/.git']);
	});

	test("the driver's clone source, as mounted, yields the pushed commit on its branch", () => {
		expect(cloneLine?.[1]).toBe(CONTAINER_GIT);
		const into = join(sandbox, 'work_new');
		const cloned = clone(cloneLine?.[1] as string, into);
		expect(cloned.exitCode, cloned.stderr.toString()).toBe(0);
		sh(['checkout', '-q', '-B', 'feat', sha], into);
		expect(gitOut(into, ['log', '--format=%s']).split('\n').filter(Boolean)).toEqual(['b', 'a']);
		expect(readFileSync(join(into, 'b.txt'), 'utf8')).toBe('b\n');
	});

	test('negative control: the worktree mount alone (the old clone source) cannot be cloned', () => {
		const cloned = clone(CONTAINER_SRC, join(sandbox, 'work_old'));
		expect(cloned.exitCode).not.toBe(0);
		expect(cloned.stderr.toString()).toContain('not a git repository');
	});

	test("the overlay is still read from the checkout mount, which holds the worktree's files", () => {
		expect(tarSource?.[1]).toBe(CONTAINER_SRC);
		expect(readFileSync(join(sandbox, CONTAINER_SRC, 'b.txt'), 'utf8')).toBe('b\n');
	});
});

describe('containerMounts — a repository borrowing objects through ALTERNATES is refused', () => {
	// fail() exits the process, so the call runs in a subprocess: `bun -e` importing the
	// real containerMounts, handed the scratch repository through the environment.
	const source = join(scratch, 'alt_source');
	mkdirSync(source);
	sh(['init', '-q', '-b', 'main'], source);
	put('a.txt', 'a\n', source);
	sh(['add', '-A'], source);
	sh(['commit', '-q', '-m', 'a'], source);
	const shared = join(scratch, 'alt_shared');
	const full = join(scratch, 'alt_full');
	sh(['clone', '-q', '--shared', source, shared]);
	sh(['clone', '-q', '--no-local', source, full]);
	const mountsOf = (dir: string) => {
		const proc = Bun.spawnSync(
			[
				process.execPath,
				'-e',
				`const { containerMounts } = await import(${JSON.stringify(join(REPO_ROOT, 'scripts/ci_local.ts'))});\nconsole.log(JSON.stringify(containerMounts(process.env.CI_LOCAL_GATE_DIR)));`,
			],
			{
				cwd: scratch,
				env: { ...noGitEnv(), CI_LOCAL_GATE_DIR: dir },
				stdout: 'pipe',
				stderr: 'pipe',
			},
		);
		return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() };
	};

	test('a --shared clone: exit 2 (could-not-run), naming the alternates file and the cure', () => {
		const run = mountsOf(shared);
		expect(run.code, run.err).toBe(2);
		expect(run.err).toContain(join('alt_shared', '.git', 'objects', 'info', 'alternates'));
		expect(run.err).toContain('git repack -a -d');
		expect(run.out).toBe('');
	});

	test('positive control: a full clone of the same repository mounts normally', () => {
		const run = mountsOf(full);
		expect(run.code, run.err).toBe(0);
		const mounts = JSON.parse(run.out) as { host: string; container: string }[];
		expect(mounts.map((mount) => mount.container)).toEqual([CONTAINER_SRC, CONTAINER_GIT]);
		expect(mounts[1]?.host).toMatch(/\/alt_full\/\.git$/);
	});
});

describe('workingTreeLists — a SYMLINKED top-level node_modules is never in the overlay', () => {
	const repo = join(scratch, 'nm');
	const deps = join(scratch, 'nm_deps');
	mkdirSync(join(deps, 'dep'), { recursive: true });
	writeFileSync(join(deps, 'dep', 'marker'), 'installed\n');
	mkdirSync(repo);
	sh(['init', '-q', '-b', 'main'], repo);
	put('.gitignore', 'node_modules/\n', repo);
	put('a.txt', 'a\n', repo);
	sh(['add', '-A'], repo);
	sh(['commit', '-q', '-m', 'a'], repo);
	symlinkSync(deps, join(repo, 'node_modules'));
	// Positive control: a symlink under any other name IS an untracked path to copy.
	symlinkSync(deps, join(repo, 'other_link'));
	put('new.txt', 'new\n', repo);
	const lists = workingTreeLists(repo);

	test("the case is live: git itself reports the linked node_modules as untracked (`.gitignore`'s dir pattern misses it)", () => {
		const status = gitOut(repo, ['status', '--porcelain', '--untracked-files=all']);
		expect(status.split('\n')).toContain('?? node_modules');
	});

	test('the overlay copies the new file and the other link, never node_modules', () => {
		expect(lists.copy).toEqual(['new.txt', 'other_link']);
		expect(lists.remove).toEqual([]);
	});
});

// ── 2. the stage parser ──────────────────────────────────────────────────────

const ESC = '\u001b';

describe('parseStages — fixture outputs of the tier protocol', () => {
	test('green stages, a RED stage with keyed + deduplicated failures, the final line is not a stage', () => {
		const output = [
			'== hermetic: bun install (frozen lockfile)',
			'done',
			'== hermetic: static tripwires (3)',
			`${ESC}[1mtest/unit/a_tripwire.test.ts:${ESC}[0m`,
			'(pass) fine',
			'(fail) broke one [2.00ms]',
			'::group::test/unit/b_tripwire.test.ts:',
			'(fail) broke two',
			'',
			' 2 tests failed:',
			'(fail) broke one [2.00ms]',
			'(fail) broke two',
			'== hermetic: RED in static tripwires (exit 1)',
			'== hermetic: crap ledger (append-only vs the reference)',
			'== hermetic: RED — see the stage verdicts above',
		].join('\n');
		const stages = parseStages('hermetic', output, 1);
		expect(stages.map((stage) => [stage.name, stage.verdict])).toEqual([
			['bun install (frozen lockfile)', 'green'],
			['static tripwires (3)', 'red'],
			['crap ledger (append-only vs the reference)', 'green'],
		]);
		const red = stages[1];
		expect(red?.failures).toEqual([
			'test/unit/a_tripwire.test.ts › broke one [2.00ms]',
			'test/unit/b_tripwire.test.ts › broke two',
		]);
		expect(red?.notes).toEqual(['RED in static tripwires (exit 1)']);
		expect(red?.fix_hint).toContain('bun test --timeout=30000');
		expect(stages[0]?.fix_hint).toBeNull();
	});

	test('unit-tier drift is RED, a child SKIPPED, a banner line', () => {
		const output = [
			'== db_tier: bun 1.3.0 (pin: 1.3.0)',
			'== db_tier: unit tier (test/unit + test/integration) vs its frozen red baseline',
			'STALE:',
			'  test/unit/x.test.ts › now passes',
			'SUMMARY:',
			'  fail 10 → 9',
			'== db_tier: RED in the unit tier (exit 1)',
			'== db_tier: dependency audit',
			'== audit: SKIPPED — no audit input changed since origin/master',
			'== db_tier: RED',
		].join('\n');
		const stages = parseStages('db_tier', output, 1);
		expect(stages.map((stage) => [stage.name, stage.verdict])).toEqual([
			['unit tier (test/unit + test/integration) vs its frozen red baseline', 'red'],
			['dependency audit', 'skipped'],
		]);
		expect(stages[0]?.drift).toEqual([
			'STALE: test/unit/x.test.ts › now passes',
			'SUMMARY: fail 10 → 9',
		]);
		// The unit baseline is recorded in the image only (UNIT_TIER.recordOnlyInCiImage):
		// improvement drift there is re-recorded, never banked on a desk.
		expect(stages[0]?.fix_hint).toContain('bun run ci:local --docker --record-unit-baseline');
		expect(stages[0]?.fix_hint).not.toContain('baselines:bank');
		expect(stages[1]?.notes).toEqual(['SKIPPED — no audit input changed since origin/master']);
		expect(stages[1]?.fix_hint).toBeNull();
	});

	test('REGRESSION drift is never told to bank', () => {
		const output = [
			'== db_tier: parity tier vs its frozen red baseline',
			'REGRESSIONS:',
			'  test/unit/y.test.ts › newly red',
			'== db_tier: RED in the parity tier (exit 1)',
			'== db_tier: RED',
		].join('\n');
		const [stage] = parseStages('db_tier', output, 1);
		expect(stage?.verdict).toBe('red');
		expect(stage?.drift).toEqual(['REGRESSIONS: test/unit/y.test.ts › newly red']);
		expect(stage?.fix_hint).toContain('REGRESSION');
		expect(stage?.fix_hint).not.toContain('improvement-only drift');
	});

	test('a non-zero exit with no RED stage: the running stage is where it died; none at all is "tier start"', () => {
		const died = parseStages(
			'hermetic',
			['== hermetic: bun install (frozen lockfile)', 'error: lockfile had changes'].join('\n'),
			1,
		);
		expect(died).toHaveLength(1);
		expect(died[0]?.verdict).toBe('red');
		expect(died[0]?.notes[0]).toContain('ABORTED here (exit 1)');
		expect(died[0]?.fix_hint).toContain('bun install --frozen-lockfile');

		const early = parseStages('hermetic', 'bash: nope: command not found', 127);
		expect(early.map((stage) => [stage.name, stage.verdict])).toEqual([['tier start', 'red']]);
	});

	test("ci:local's own workflow_step marker opens a stage", () => {
		const output = [
			'== workflow_step: bun install --frozen-lockfile',
			'== db_tier: build the suite database (from repo-vendored bytes)',
			'== db_tier: OK',
		].join('\n');
		expect(parseStages('db_tier', output, 0).map((stage) => stage.name)).toEqual([
			'bun install --frozen-lockfile',
			'build the suite database (from repo-vendored bytes)',
		]);
	});
});

describe('--fail-fast — a red tier ends the run, the rest is REPORTED not_run', () => {
	const [hermetic, db, instance] = TIERS;
	const result = (tier: string, verdict: 'green' | 'red'): TierResult => ({
		tier,
		verdict,
		exit_code: verdict === 'green' ? 0 : 1,
		duration_s: 1,
		stages: [],
	});
	const on = { flags: new Set(['--fail-fast']) };
	const off = { flags: new Set<string>() };

	test('after a red tier, with --fail-fast: the next tier is not run and says so', () => {
		const skipped = failFastSkip(on, db as (typeof TIERS)[number], [
			result(hermetic?.id ?? 'hermetic', 'red'),
		]);
		expect(skipped).toEqual({
			tier: db?.id,
			verdict: 'not_run',
			exit_code: -1,
			duration_s: 0,
			stages: [],
		});
	});

	test('without --fail-fast every tier runs; with it, green predecessors never skip', () => {
		const red = [result(hermetic?.id ?? 'hermetic', 'red')];
		expect(failFastSkip(off, db as (typeof TIERS)[number], red)).toBeNull();
		const green = [result(hermetic?.id ?? 'hermetic', 'green'), result(db?.id ?? 'db', 'green')];
		expect(failFastSkip(on, instance as (typeof TIERS)[number], green)).toBeNull();
		expect(failFastSkip(on, hermetic as (typeof TIERS)[number], [])).toBeNull();
	});
});

describe('tier schedule — --docker runs the tiers CONCURRENTLY, serial only where it must be', () => {
	const flags = (...names: string[]) => ({ flags: new Set(names) });

	test('docker, several tiers: concurrent', () => {
		expect(tierSchedule(flags('--docker'), 3).concurrent).toBe(true);
		expect(tierSchedule(flags('--docker', '--db', '--instance'), 2).concurrent).toBe(true);
	});

	test('serial: host mode, --fail-fast, a recording, --serial-tiers, one tier — each says why', () => {
		const cases: [ReturnType<typeof flags>, number, RegExp][] = [
			[flags(), 3, /host mode/],
			[flags('--docker', '--fail-fast'), 3, /fail-fast/],
			[flags('--docker', '--record-unit-baseline'), 1, /one tier/],
			[flags('--docker', '--record-parity-baseline'), 2, /recording/],
			[flags('--docker', '--serial-tiers'), 3, /serial-tiers/],
			[flags('--docker'), 1, /one tier/],
		];
		for (const [args, count, why] of cases) {
			const schedule = tierSchedule(args, count);
			expect(schedule.concurrent).toBe(false);
			expect(schedule.reason).toMatch(why);
		}
	});

	test('each tier reads its OWN steps file — the name the driver derives from DEDALO_CI_TIER_SCRIPT', () => {
		// Concurrent tiers share one /ci-in: a single steps.lst would hand every tier the
		// last writer's steps. The driver's derivation is run, not re-spelled.
		const names = TIERS.map((tier) => stepsFileName(tier));
		expect(new Set(names).size).toBe(TIERS.length);
		for (const tier of TIERS) {
			const derived = Bun.spawnSync(['bash', '-c', 'basename "$DEDALO_CI_TIER_SCRIPT" .sh'], {
				env: { ...process.env, DEDALO_CI_TIER_SCRIPT: tier.script },
			});
			expect(`${derived.stdout.toString().trim()}.lst`).toBe(stepsFileName(tier));
		}
		expect(DRIVER_SCRIPT).toContain(
			'done < "/ci-in/steps/$(basename "$DEDALO_CI_TIER_SCRIPT" .sh).lst"',
		);
		expect(DRIVER_SCRIPT).not.toContain('/ci-in/steps.lst');
	});

	test('prefixLines tags every complete line, blank ones included, and adds no line', () => {
		expect(prefixLines('a\nb\n', '[db] ')).toBe('[db] a\n[db] b\n');
		expect(prefixLines('\n\nx\n', '[i] ')).toBe('[i] \n[i] \n[i] x\n');
		expect(prefixLines('', '[i] ')).toBe('');
	});

	test('a prefixed run still CAPTURES untagged — the stage parser never sees the prefix', async () => {
		const { code, output } = await runStreaming(
			['bash', '-c', 'echo "== db_tier: stage"; echo "(fail) x" >&2; printf "tail"'],
			{ cwd: REPO_ROOT, env: process.env, prefix: '[db] ' },
		);
		expect(code).toBe(0);
		expect(output).not.toContain('[db] ');
		expect(output).toContain('== db_tier: stage\n');
		expect(output).toContain('(fail) x\n');
		expect(output).toContain('tail\n');
	});
});

describe('stage durations — each stage is timed from its marker to the next', () => {
	test('lineTimes give every stage its wall seconds; the last runs to the final line', () => {
		const output = [
			'== instance_tier: build',
			'x',
			'== instance_tier: client suite',
			'== instance_tier: RED in the client suite (exit 1)',
			'== instance_tier: crawl',
			'y',
			'',
		].join('\n');
		const times = [0, 1_000, 5_000, 65_000, 66_000, 186_000];
		const stages = parseStages('instance_tier', output, 1, times);
		expect(stages.map((stage) => [stage.name, stage.duration_s])).toEqual([
			['build', 5],
			['client suite', 61],
			['crawl', 120],
		]);
		expect(stages[1]?.verdict).toBe('red');
		expect(JSON.stringify(stages)).not.toContain('started_ms');
	});

	test("a stage's own TOOK line wins over arrival time (lane logs print whole at the lane's end)", () => {
		const output = [
			'== instance_tier: crawl',
			'x',
			'== instance_tier: TOOK 1170s',
			'== instance_tier: phone',
			'== instance_tier: RED in the phone contract (exit 1)',
			'== instance_tier: TOOK 549s',
			'',
		].join('\n');
		const stages = parseStages('instance_tier', output, 1, [0, 1, 2, 3, 4, 5]);
		expect(stages.map((stage) => [stage.name, stage.duration_s, stage.verdict])).toEqual([
			['crawl', 1170, 'green'],
			['phone', 549, 'red'],
		]);
		expect(JSON.stringify(stages)).not.toContain('took_s');
	});

	test('untimed (no lineTimes): no duration_s key at all', () => {
		const stages = parseStages('db_tier', '== db_tier: a\n== db_tier: b\n', 0);
		expect(stages.every((stage) => !('duration_s' in stage))).toBe(true);
	});

	test('runStreaming returns one arrival time per captured line', async () => {
		const { output, lineTimes } = await runStreaming(
			['bash', '-c', 'echo a; echo b >&2; printf c'],
			{
				cwd: REPO_ROOT,
				env: process.env,
			},
		);
		expect(lineTimes.length).toBe(output.split('\n').length - 1);
		expect(lineTimes.length).toBe(3);
	});
});

describe('instance lanes — opt-in (--instance-lanes 3), serial by default', () => {
	const args = (flags: string[], values: Record<string, string> = {}) => ({
		flags: new Set(flags),
		values: new Map(Object.entries(values)),
	});

	test('serial by DEFAULT everywhere (lanes beside the db tier overran a 7.6 GiB VM); the flag opts in', () => {
		expect(instanceLanesEnv(args(['--docker']))).toEqual({ DEDALO_CI_INSTANCE_LANES: '1' });
		expect(instanceLanesEnv(args([]))).toEqual({ DEDALO_CI_INSTANCE_LANES: '1' });
		expect(
			instanceLanesEnv(args(['--docker'], { '--instance-lanes': String(INSTANCE_LANES) })),
		).toEqual({ DEDALO_CI_INSTANCE_LANES: String(INSTANCE_LANES) });
	});

	test('--instance-lanes takes 1 or the planned lane count, nothing else', () => {
		expect(instanceLanesFault(args([]) as never)).toBeNull();
		expect(instanceLanesFault(args([], { '--instance-lanes': '1' }) as never)).toBeNull();
		expect(
			instanceLanesFault(args([], { '--instance-lanes': String(INSTANCE_LANES) }) as never),
		).toBeNull();
		for (const bad of ['2', '4', '0', 'x'])
			expect(instanceLanesFault(args([], { '--instance-lanes': bad }) as never)).toMatch(
				/takes 1 \(serial\) or/,
			);
	});

	test('the planned lane count is the one the provisioner clones and the tier reads', () => {
		const tier = readFileSync(join(REPO_ROOT, 'scripts/ci/instance_tier.sh'), 'utf8');
		const lanes = readFileSync(join(REPO_ROOT, 'scripts/ci/instance_lanes.ts'), 'utf8');
		expect(lanes).toContain(`export const INSTANCE_LANES = ${INSTANCE_LANES};`);
		// one clone name read per lane, and one background lane per clone
		expect([...tier.matchAll(/sed -n (\d)p "\$lane_logs\/databases"/g)].map((m) => m[1])).toEqual(
			Array.from({ length: INSTANCE_LANES }, (_, i) => String(i + 1)),
		);
		expect([...tier.matchAll(/\(in_lane "\$\w+" && lane_\w+\) >/g)]).toHaveLength(INSTANCE_LANES);
		expect(readFileSync(join(REPO_ROOT, 'ci/compose.yml'), 'utf8')).toContain(
			'DEDALO_CI_INSTANCE_LANES: ${DEDALO_CI_INSTANCE_LANES:-1}',
		);
	});
});

describe('instance lanes — a lane log reaches stdout WHOLE through a non-blocking pipe', () => {
	test('writeAllToStdout resumes after partial writes and waits out EAGAIN; any other error throws', async () => {
		const { writeAllToStdout } = await import('../../scripts/ci/instance_lanes.ts');
		const bytes = new TextEncoder().encode('0123456789');
		const got: number[] = [];
		let calls = 0;
		const flaky = ((_fd: number, buf: Uint8Array, offset: number, length: number) => {
			calls++;
			if (calls % 2 === 0) throw Object.assign(new Error('EAGAIN'), { code: 'EAGAIN' });
			const n = Math.min(3, length); // a full pipe takes a few bytes at a time
			got.push(...buf.subarray(offset, offset + n));
			return n;
		}) as unknown as typeof import('node:fs').writeSync;
		writeAllToStdout(bytes, flaky);
		expect(new TextDecoder().decode(new Uint8Array(got))).toBe('0123456789');
		expect(calls).toBeGreaterThan(4);
		const broken = (() => {
			throw Object.assign(new Error('EPIPE'), { code: 'EPIPE' });
		}) as unknown as typeof import('node:fs').writeSync;
		expect(() => writeAllToStdout(bytes, broken)).toThrow('EPIPE');
	});

	test('the tier prints lane logs through it, never cat (cat dies on EAGAIN mid-file)', () => {
		const tier = readFileSync(join(REPO_ROOT, 'scripts/ci/instance_tier.sh'), 'utf8');
		expect(tier).toContain(
			'bun run scripts/ci/instance_lanes.ts print "$lane_logs/$lane.log" || print_rc=$?',
		);
		expect(tier).not.toMatch(/^\s*cat "\$lane_logs/m);
		// the clone names travel in a FILE: the shard helpers log on stdout, and a
		// captured stdout once handed lane 1 a log line as its database
		expect(tier).toContain(
			'bun run scripts/ci/instance_lanes.ts provision "$lane_logs/databases" || lanes_rc=$?',
		);
		expect(tier).not.toMatch(/instance_lanes\.ts provision[^\n]*>/);
	});
});

describe('the REAL tier scripts still speak the protocol parseStages reads', () => {
	for (const tier of TIERS) {
		const source = readFileSync(join(REPO_ROOT, tier.script), 'utf8');
		const markers = [...source.matchAll(/echo "== ([a-z_]+): ([^"$]*)/g)].map(
			(match) => [match[1], match[2] ?? ''] as const,
		);

		test(`${tier.script}: every marker uses prefix '${tier.prefix}'`, () => {
			expect(markers.length).toBeGreaterThan(2);
			expect([...new Set(markers.map(([prefix]) => prefix))]).toEqual([tier.prefix]);
		});

		test(`${tier.script}: opens stages, marks RED stages, and ends on a final verdict`, () => {
			const texts = markers.map(([, text]) => text);
			expect(texts.some((text) => text.startsWith('RED in '))).toBe(true);
			expect(texts.some((text) => /^(GREEN|OK)\b/.test(text))).toBe(true);
			// a stage header is a marker that is none of the protocol's verdict words
			expect(
				texts.filter((text) => !/^(RED|GREEN|OK|SKIPPED)\b/.test(text)).length,
			).toBeGreaterThan(1);
		});

		test(`${tier.script}: a synthesized run of its own headers parses into those stages`, () => {
			const headers = markers
				.map(([, text]) => text)
				.filter((text) => text !== '' && !/^(RED|GREEN|OK|SKIPPED|bun \d|installing )/.test(text));
			const output = headers.map((text) => `== ${tier.prefix}: ${text}`).join('\n');
			expect(parseStages(tier.prefix, output, 0).map((stage) => stage.name)).toEqual(headers);
		});
	}
});

describe('the unit stage is BLOCKING — and the desk skip is retired', () => {
	const KEY = 'DEDALO_CI_SKIP_ADVISORY';
	const dbTier = readFileSync(join(REPO_ROOT, 'scripts/ci/db_tier.sh'), 'utf8');

	test('`--skip-advisory` is REFUSED by the CLI (exit 2, naming why), in either spelling', () => {
		for (const flag of ['--skip-advisory', '--skip-advisory=1']) {
			const proc = Bun.spawnSync([process.execPath, 'scripts/ci_local.ts', '--docker', flag], {
				cwd: REPO_ROOT,
				env: noGitEnv(),
				stdout: 'pipe',
				stderr: 'pipe',
			});
			expect(proc.exitCode, flag).toBe(2);
			expect(proc.stderr.toString()).toContain('--skip-advisory is retired');
			expect(proc.stderr.toString()).toContain('the unit stage is blocking');
		}
		// Control: a plain unknown flag gets the generic refusal, not the retired one.
		const other = Bun.spawnSync([process.execPath, 'scripts/ci_local.ts', '--skip-adv'], {
			cwd: REPO_ROOT,
			env: noGitEnv(),
			stdout: 'pipe',
			stderr: 'pipe',
		});
		expect(other.exitCode).toBe(2);
		expect(other.stderr.toString()).toContain("unknown argument '--skip-adv'");
	});

	test('no tier script, compose file, hook or the CLI names the retired key', () => {
		for (const rel of [
			'scripts/ci/db_tier.sh',
			'scripts/ci/hermetic.sh',
			'scripts/ci/instance_tier.sh',
			'scripts/ci/hosted_env.sh',
			'scripts/ci/client_gate.sh',
			'ci/compose.yml',
			'scripts/ci_local.ts',
			'scripts/hooks/pre-push',
		]) {
			expect(readFileSync(join(REPO_ROOT, rel), 'utf8'), rel).not.toContain(KEY);
		}
		expect(readFileSync(join(REPO_ROOT, 'scripts/hooks/pre-push'), 'utf8')).not.toContain(
			'--skip-advisory',
		);
	});

	test('an own-prefix SKIPPED line marks the open stage skipped, never a red one', () => {
		const output = [
			'== db_tier: some stage',
			'== db_tier: SKIPPED — nothing to do',
			'== db_tier: parity tier vs its frozen red baseline',
			'== db_tier: RED in the parity tier (exit 1)',
			'== db_tier: SKIPPED — must not launder a red',
			'== db_tier: RED',
		].join('\n');
		expect(parseStages('db_tier', output, 1).map((stage) => [stage.name, stage.verdict])).toEqual([
			['some stage', 'skipped'],
			['parity tier vs its frozen red baseline', 'red'],
		]);
	});

	test("the stage's EXACT code: one check, one write branch, and the raise", () => {
		const code = (text: string) =>
			text.split('\n').filter((line) => line.trim() !== '' && !/^\s*#/.test(line));
		const start = dbTier.indexOf('echo "== db_tier: unit tier');
		const end = dbTier.indexOf('echo "== db_tier: parity tier');
		expect(start).toBeGreaterThan(-1);
		expect(end).toBeGreaterThan(start);
		// Any edit to the stage — a raise dropped or spelled to swallow (`|| echo`, `|| true`),
		// a skip branch brought back, a second read — must come through here.
		expect(code(dbTier.slice(start, end))).toEqual([
			'echo "== db_tier: unit tier (test/unit + test/integration) vs its frozen red baseline"',
			'unit_rc=0',
			// Record mode (ci:local --docker --record-unit-baseline) — §7 executes this branch.
			'if [ -n "${DEDALO_CI_UNIT_RECORD_OUT:-}" ]; then',
			'\techo "== db_tier: RECORDING engineering/unit_baseline.json (ci:local --record-unit-baseline)"',
			'\trecord_rc=0',
			"\trecord_args=''",
			'\t[ "${DEDALO_CI_UNIT_RECORD_ALLOW:-0}" != 1 ] || record_args=--allow-regression',
			'\t[ -z "${DEDALO_CI_UNIT_RECORD_NEW:-}" ] || record_args="--record-new ${DEDALO_CI_UNIT_RECORD_NEW}"',
			'\tbun run scripts/unit_baseline.ts $record_args || record_rc=$?',
			'\t[ "$record_rc" -eq 0 ] || { echo "== db_tier: RED in the unit-baseline recording (exit $record_rc) — nothing copied out"; tier_status=1; }',
			'\t[ "$record_rc" -ne 0 ] || cp engineering/unit_baseline.json "$DEDALO_CI_UNIT_RECORD_OUT/unit_baseline.json"',
			'else',
			'\tbun run scripts/unit_baseline.ts --check --bins="${DEDALO_CI_UNIT_BINS:-1}" || unit_rc=$?',
			'fi',
			'[ "$unit_rc" -eq 0 ] || { echo "== db_tier: RED in the unit tier (exit $unit_rc)"; tier_status=1; }',
		]);
	});
});

// ── 7. --record-unit-baseline ────────────────────────────────────────────────

describe('--record-unit-baseline — the unit baseline is recorded IN THE IMAGE, through one door', () => {
	const args = (flags: string[], values: Record<string, string> = {}) => ({
		flags: new Set(flags),
		values: new Map(Object.entries(values)),
	});
	const REASON = 'closure_openquestions: audits/ is absent from a clone (+7 skips)';

	test('refused outside --docker and beside every flag that would change what is recorded', () => {
		expect(recordArgsFault(args(['--docker', '--record-unit-baseline']))).toBeNull();
		expect(recordArgsFault(args([]))).toBeNull();
		expect(recordArgsFault(args(['--record-unit-baseline']))).toMatch(/needs --docker/);
		for (const flag of ['--hermetic', '--instance', '--fail-fast', '--keep'])
			expect(recordArgsFault(args(['--docker', '--record-unit-baseline', flag]))).toContain(flag);
		// The parity recording: the same door, the same refusals.
		expect(recordArgsFault(args(['--docker', '--record-parity-baseline']))).toBeNull();
		expect(recordArgsFault(args(['--record-parity-baseline']))).toMatch(/needs --docker/);
		expect(recordArgsFault(args(['--docker', '--record-parity-baseline', '--keep']))).toContain(
			'--keep',
		);
		expect(
			recordArgsFault(args(['--docker', '--record-parity-baseline', '--allow-regression'])),
		).toMatch(/needs --reason/);
		// --db is what a recording runs anyway: harmless, not refused.
		expect(recordArgsFault(args(['--docker', '--record-unit-baseline', '--db']))).toBeNull();
	});

	test('--allow-regression only with a --reason, and neither without a recording', () => {
		const rec = ['--docker', '--record-unit-baseline'];
		expect(recordArgsFault(args([...rec, '--allow-regression']))).toMatch(/needs --reason/);
		expect(recordArgsFault(args([...rec, '--allow-regression'], { '--reason': 'short' }))).toMatch(
			/needs --reason/,
		);
		expect(
			recordArgsFault(args([...rec, '--allow-regression'], { '--reason': REASON })),
		).toBeNull();
		expect(recordArgsFault(args(rec, { '--reason': REASON }))).toMatch(
			/without --allow-regression/,
		);
		expect(recordArgsFault(args(['--docker', '--allow-regression']))).toMatch(
			/belong to --record-unit-baseline/,
		);
		expect(recordArgsFault(args(['--docker'], { '--reason': REASON }))).toMatch(
			/belong to --record-unit-baseline/,
		);
	});

	test('--new <files>: unit-tier test paths only, never beside --allow-regression, never alone', () => {
		const rec = ['--docker', '--record-unit-baseline'];
		const NEW = 'test/unit/zz_new_native.test.ts';
		expect(recordArgsFault(args(rec, { '--new': NEW }))).toBeNull();
		expect(
			recordArgsFault(args(rec, { '--new': `${NEW}, test/integration/a/b_flow.test.ts` })),
		).toBeNull();
		expect(recordArgsFault(args(['--docker'], { '--new': NEW }))).toMatch(
			/belong to --record-unit-baseline/,
		);
		expect(
			recordArgsFault(args([...rec, '--allow-regression'], { '--new': NEW, '--reason': REASON })),
		).toMatch(/nothing to accept/);
		expect(recordArgsFault(args(rec, { '--new': ' , ' }))).toMatch(/needs <file>/);
		// Shapes db_tier.sh's word split could not carry exactly, or that are not unit files.
		for (const bad of [
			'test/client/x.test.ts',
			'test/unit/a b.test.ts',
			'test/unit/*.test.ts',
			'test/unit/../../x.test.ts',
			'test/unit/x.ts',
			'/abs/test/unit/x.test.ts',
			'test/unit/$(x).test.ts',
		])
			expect(recordArgsFault(args(rec, { '--new': bad })), bad).toContain(bad);
		// --new is a unit-tier list: beside a parity-only recording it has nothing to name,
		// and with BOTH recordings --allow-regression is the parity writer's.
		expect(
			recordArgsFault(args(['--docker', '--record-parity-baseline'], { '--new': NEW })),
		).toMatch(/belongs to --record-unit-baseline/);
		expect(
			recordArgsFault(
				args([...rec, '--record-parity-baseline', '--allow-regression'], {
					'--new': NEW,
					'--reason': REASON,
				}),
			),
		).toBeNull();
		expect(recordNewFiles(undefined)).toEqual([]);
		expect(recordNewFiles(`${NEW},,test/unit/b.test.ts `)).toEqual([NEW, 'test/unit/b.test.ts']);
	});

	test('--ref must be THIS checkout: HEAD on a clean tree — the measure is written here', () => {
		const head = 'a'.repeat(40);
		expect(recordRefFault(undefined, head, head, true)).toBeNull();
		expect(recordRefFault('HEAD', head, head, false)).toBeNull();
		expect(recordRefFault('v7.0.1', 'b'.repeat(40), head, false)).toMatch(
			/not this checkout's HEAD/,
		);
		expect(recordRefFault('HEAD', head, head, true)).toMatch(/working tree has changes/);
	});

	test('the recording reaches the checkout only from a GREEN db tier — any red stage refuses, loudly', () => {
		const stage = (name: string, verdict: Stage['verdict']): Stage => ({
			name,
			verdict,
			fix_hint: null,
			failures: [],
			notes: [],
			drift: [],
			lines: [],
		});
		const tier = (exit: number, stages: Stage[]): TierResult => ({
			tier: 'db',
			verdict: exit === 0 ? 'green' : 'red',
			exit_code: exit,
			duration_s: 1,
			stages,
		});
		const recording = stage('recording engineering/unit_baseline.json', 'green');
		expect(recordCopyFault(tier(0, [recording, stage('parity tier', 'green')]))).toBeNull();
		// The writer wrote, but a LATER stage went red: the platform was not healthy.
		const red = recordCopyFault(tier(1, [recording, stage('parity tier vs baseline', 'red')]));
		expect(red).toContain('RED');
		expect(red).toContain('parity tier vs baseline');
		// An EARLIER red too (a DB tripwire), and a red exit no stage claimed.
		expect(recordCopyFault(tier(1, [stage('DB tripwires', 'red'), recording]))).toContain(
			'DB tripwires',
		);
		expect(recordCopyFault(tier(1, [recording]))).toContain('exit 1');
		expect(recordCopyFault(undefined)).toContain('never ran');
	});

	test('the unit bin count is ALWAYS set — sharded by default in the image, serial on the host and for a recording', () => {
		// Explicit, so a shell export never changes what the gate measures.
		expect(unitBinsEnv(args(['--docker']))).toEqual({
			DEDALO_CI_UNIT_BINS: String(DEFAULT_UNIT_BINS),
		});
		expect(DEFAULT_UNIT_BINS).toBeGreaterThan(1);
		expect(DEFAULT_UNIT_BINS).toBeLessThanOrEqual(MAX_UNIT_BINS);
		// The host's cluster is not compose's: serial unless asked.
		expect(unitBinsEnv(args([]))).toEqual({ DEDALO_CI_UNIT_BINS: '1' });
		expect(unitBinsEnv(args([], { '--unit-bins': '1' }))).toEqual({ DEDALO_CI_UNIT_BINS: '1' });
		expect(unitBinsEnv(args([], { '--unit-bins': '6' }))).toEqual({ DEDALO_CI_UNIT_BINS: '6' });
		// The baseline is DEFINED by the serial run: a recording never shards.
		expect(unitBinsEnv(args(['--docker', '--record-unit-baseline']))).toEqual({
			DEDALO_CI_UNIT_BINS: '1',
		});
		expect(unitBinsFault(args([]))).toBeNull();
		expect(unitBinsFault(args([], { '--unit-bins': '4' }))).toBeNull();
		for (const bad of ['0', '-1', '2.5', 'four', '99', String(MAX_UNIT_BINS + 1)])
			expect(unitBinsFault(args([], { '--unit-bins': bad })), bad).toContain('--unit-bins');
		expect(
			unitBinsFault(args(['--docker', '--record-unit-baseline'], { '--unit-bins': '4' })),
		).toContain('recorded serially');
		// …and the docker run hands it to the tier.
		expect(
			dockerComposeEnv({
				image: 'img',
				inputs: '/in',
				outputs: '/out',
				sha: 'a'.repeat(40),
				branch: 'master',
				base: undefined,
				auditBase: '',
				overlay: false,
				args: args([], { '--unit-bins': '3' }),
				mounts: [],
			}).DEDALO_CI_UNIT_BINS,
		).toBe('3');
	});

	test('both record keys are ALWAYS set — off is explicit, so a shell export never turns a check into a write', () => {
		const NEW_OFF = {
			DEDALO_CI_UNIT_RECORD_NEW: '',
			DEDALO_CI_PARITY_RECORD_OUT: '',
			DEDALO_CI_PARITY_RECORD_ALLOW: '0',
		} as const;
		expect(recordEnv(args([]), CONTAINER_OUT)).toEqual({
			DEDALO_CI_UNIT_RECORD_OUT: '',
			DEDALO_CI_UNIT_RECORD_ALLOW: '0',
			...NEW_OFF,
		});
		expect(recordEnv(args(['--allow-regression']), CONTAINER_OUT)).toEqual({
			DEDALO_CI_UNIT_RECORD_OUT: '',
			DEDALO_CI_UNIT_RECORD_ALLOW: '0',
			...NEW_OFF,
		});
		expect(recordEnv(args(['--record-unit-baseline']), CONTAINER_OUT)).toEqual({
			DEDALO_CI_UNIT_RECORD_OUT: '/ci-out',
			DEDALO_CI_UNIT_RECORD_ALLOW: '0',
			...NEW_OFF,
		});
		expect(
			recordEnv(args(['--record-unit-baseline', '--allow-regression']), CONTAINER_OUT),
		).toEqual({
			DEDALO_CI_UNIT_RECORD_OUT: '/ci-out',
			DEDALO_CI_UNIT_RECORD_ALLOW: '1',
			...NEW_OFF,
		});
		// --new reaches the tier only on a recording, space-joined for db_tier.sh's split.
		const files = 'test/unit/a.test.ts,test/unit/b.test.ts';
		expect(recordEnv(args(['--record-unit-baseline'], { '--new': files }), CONTAINER_OUT)).toEqual({
			DEDALO_CI_UNIT_RECORD_OUT: '/ci-out',
			DEDALO_CI_UNIT_RECORD_ALLOW: '0',
			DEDALO_CI_UNIT_RECORD_NEW: 'test/unit/a.test.ts test/unit/b.test.ts',
			DEDALO_CI_PARITY_RECORD_OUT: '',
			DEDALO_CI_PARITY_RECORD_ALLOW: '0',
		});
		// The parity writer: its own keys; --allow-regression reaches it, and beside a unit
		// --new recording it reaches ONLY it (--record-new refuses a red by design).
		expect(
			recordEnv(args(['--record-parity-baseline', '--allow-regression']), CONTAINER_OUT),
		).toEqual({
			DEDALO_CI_UNIT_RECORD_OUT: '',
			DEDALO_CI_UNIT_RECORD_ALLOW: '0',
			DEDALO_CI_UNIT_RECORD_NEW: '',
			DEDALO_CI_PARITY_RECORD_OUT: '/ci-out',
			DEDALO_CI_PARITY_RECORD_ALLOW: '1',
		});
		expect(
			recordEnv(
				args(['--record-unit-baseline', '--record-parity-baseline', '--allow-regression'], {
					'--new': 'test/unit/a.test.ts',
				}),
				CONTAINER_OUT,
			),
		).toEqual({
			DEDALO_CI_UNIT_RECORD_OUT: '/ci-out',
			DEDALO_CI_UNIT_RECORD_ALLOW: '0',
			DEDALO_CI_UNIT_RECORD_NEW: 'test/unit/a.test.ts',
			DEDALO_CI_PARITY_RECORD_OUT: '/ci-out',
			DEDALO_CI_PARITY_RECORD_ALLOW: '1',
		});
		expect(recordEnv(args([], { '--new': files }), CONTAINER_OUT)).toEqual({
			DEDALO_CI_UNIT_RECORD_OUT: '',
			DEDALO_CI_UNIT_RECORD_ALLOW: '0',
			...NEW_OFF,
		});
		// The compose file passes both through, and gives /ci-out its writable mount while
		// every source mount stays read-only.
		const compose = readFileSync(join(REPO_ROOT, 'ci/compose.yml'), 'utf8');
		expect(compose).toContain('DEDALO_CI_UNIT_RECORD_OUT: ${DEDALO_CI_UNIT_RECORD_OUT:-}');
		expect(compose).toContain('DEDALO_CI_UNIT_RECORD_ALLOW: ${DEDALO_CI_UNIT_RECORD_ALLOW:-0}');
		expect(compose).toContain('DEDALO_CI_UNIT_RECORD_NEW: ${DEDALO_CI_UNIT_RECORD_NEW:-}');
		expect(compose).toContain('DEDALO_CI_PARITY_RECORD_OUT: ${DEDALO_CI_PARITY_RECORD_OUT:-}');
		expect(compose).toContain('DEDALO_CI_PARITY_RECORD_ALLOW: ${DEDALO_CI_PARITY_RECORD_ALLOW:-0}');
		expect(compose).toContain(`\${DEDALO_CI_OUT:?set by scripts/ci_local.ts}:${CONTAINER_OUT}\n`);
		const mounts = compose.split('\n').filter((line) => /^\s+- \$\{DEDALO_CI_[A-Z]+:\?/.test(line));
		expect(mounts.filter((line) => !line.endsWith(':ro'))).toEqual([
			`    - \${DEDALO_CI_OUT:?set by scripts/ci_local.ts}:${CONTAINER_OUT}`,
		]);
	});

	test("db_tier.sh's unit stage, EXECUTED with bun and cp stubbed: record writes, check checks, a refusal copies nothing and is red", () => {
		const dbTier = readFileSync(join(REPO_ROOT, 'scripts/ci/db_tier.sh'), 'utf8');
		const start = dbTier.indexOf('echo "== db_tier: unit tier');
		const end = dbTier.indexOf('echo "== db_tier: parity tier');
		const dir = mkdtempSync(join(tmpdir(), 'dedalo-ci-record-'));
		try {
			const script = join(dir, 'stage.sh');
			writeFileSync(
				script,
				[
					'set -euo pipefail',
					'tier_status=0',
					'bun() { printf "bun %s\\n" "$*" >> "$LOG"; return "$BUN_RC"; }',
					'cp() { printf "cp %s\\n" "$*" >> "$LOG"; }',
					dbTier.slice(start, end),
					'printf "tier_status=%s\\n" "$tier_status" >> "$LOG"',
				].join('\n'),
			);
			const drive = (env: Record<string, string>) => {
				const log = join(dir, 'log');
				writeFileSync(log, '');
				const proc = Bun.spawnSync(['bash', script], {
					env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LOG: log, BUN_RC: '0', ...env },
					stdout: 'pipe',
					stderr: 'pipe',
				});
				expect(proc.exitCode).toBe(0);
				return readFileSync(log, 'utf8').trim().split('\n');
			};
			const off = {
				DEDALO_CI_UNIT_RECORD_OUT: '',
				DEDALO_CI_UNIT_RECORD_ALLOW: '0',
				DEDALO_CI_UNIT_RECORD_NEW: '',
			};
			// Unset = serial (GitHub's db.yml sets nothing); ci:local hands its bin count through.
			expect(drive(off)).toEqual([
				'bun run scripts/unit_baseline.ts --check --bins=1',
				'tier_status=0',
			]);
			expect(drive({ ...off, DEDALO_CI_UNIT_BINS: '4' })).toEqual([
				'bun run scripts/unit_baseline.ts --check --bins=4',
				'tier_status=0',
			]);
			// A recording ignores the bin count: the writer is serial by definition.
			expect(
				drive({
					DEDALO_CI_UNIT_RECORD_OUT: '/ci-out',
					DEDALO_CI_UNIT_RECORD_ALLOW: '0',
					DEDALO_CI_UNIT_RECORD_NEW: '',
					DEDALO_CI_UNIT_BINS: '4',
				}),
			).toEqual([
				'bun run scripts/unit_baseline.ts',
				'cp engineering/unit_baseline.json /ci-out/unit_baseline.json',
				'tier_status=0',
			]);
			// BLOCKING: a check that exits 1 raises the tier (the whole script: tier_wiring leg L).
			expect(drive({ ...off, BUN_RC: '1' })).toEqual([
				'bun run scripts/unit_baseline.ts --check --bins=1',
				'tier_status=1',
			]);
			// ALLOW alone records nothing.
			expect(drive({ ...off, DEDALO_CI_UNIT_RECORD_ALLOW: '1' })).toEqual([
				'bun run scripts/unit_baseline.ts --check --bins=1',
				'tier_status=0',
			]);
			const rec = {
				DEDALO_CI_UNIT_RECORD_OUT: '/ci-out',
				DEDALO_CI_UNIT_RECORD_ALLOW: '0',
				DEDALO_CI_UNIT_RECORD_NEW: '',
			};
			expect(drive(rec)).toEqual([
				'bun run scripts/unit_baseline.ts',
				'cp engineering/unit_baseline.json /ci-out/unit_baseline.json',
				'tier_status=0',
			]);
			expect(drive({ ...rec, DEDALO_CI_UNIT_RECORD_ALLOW: '1' })).toEqual([
				'bun run scripts/unit_baseline.ts --allow-regression',
				'cp engineering/unit_baseline.json /ci-out/unit_baseline.json',
				'tier_status=0',
			]);
			// NEW alone records nothing; with OUT it runs --record-new, one argument per file.
			expect(drive({ ...off, DEDALO_CI_UNIT_RECORD_NEW: 'test/unit/a.test.ts' })).toEqual([
				'bun run scripts/unit_baseline.ts --check --bins=1',
				'tier_status=0',
			]);
			expect(
				drive({ ...rec, DEDALO_CI_UNIT_RECORD_NEW: 'test/unit/a.test.ts test/unit/b.test.ts' }),
			).toEqual([
				'bun run scripts/unit_baseline.ts --record-new test/unit/a.test.ts test/unit/b.test.ts',
				'cp engineering/unit_baseline.json /ci-out/unit_baseline.json',
				'tier_status=0',
			]);
			// The writer REFUSED: nothing leaves the container, and the tier is red.
			expect(drive({ ...rec, BUN_RC: '1' })).toEqual([
				'bun run scripts/unit_baseline.ts',
				'tier_status=1',
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("db_tier.sh's parity stage, EXECUTED with bun and cp stubbed: record writes, check checks, a refusal copies nothing and is red", () => {
		const dbTier = readFileSync(join(REPO_ROOT, 'scripts/ci/db_tier.sh'), 'utf8');
		const start = dbTier.indexOf('echo "== db_tier: parity tier');
		const end = dbTier.indexOf('# ── THE MARIADB TIER');
		expect(start).toBeGreaterThan(0);
		expect(end).toBeGreaterThan(start);
		const dir = mkdtempSync(join(tmpdir(), 'dedalo-ci-precord-'));
		try {
			const script = join(dir, 'stage.sh');
			writeFileSync(
				script,
				[
					'set -euo pipefail',
					'tier_status=0',
					'bun() { printf "bun %s\\n" "$*" >> "$LOG"; return "$BUN_RC"; }',
					'cp() { printf "cp %s\\n" "$*" >> "$LOG"; }',
					dbTier.slice(start, end),
					'printf "tier_status=%s\\n" "$tier_status" >> "$LOG"',
				].join('\n'),
			);
			const drive = (env: Record<string, string>) => {
				const log = join(dir, 'log');
				writeFileSync(log, '');
				const proc = Bun.spawnSync(['bash', script], {
					env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LOG: log, BUN_RC: '0', ...env },
					stdout: 'pipe',
					stderr: 'pipe',
				});
				expect(proc.exitCode).toBe(0);
				return readFileSync(log, 'utf8').trim().split('\n');
			};
			const off = { DEDALO_CI_PARITY_RECORD_OUT: '', DEDALO_CI_PARITY_RECORD_ALLOW: '0' };
			expect(drive(off)).toEqual(['bun run scripts/parity_baseline.ts --check', 'tier_status=0']);
			expect(drive({ ...off, BUN_RC: '1' })).toEqual([
				'bun run scripts/parity_baseline.ts --check',
				'tier_status=1',
			]);
			// ALLOW alone records nothing.
			expect(drive({ ...off, DEDALO_CI_PARITY_RECORD_ALLOW: '1' })).toEqual([
				'bun run scripts/parity_baseline.ts --check',
				'tier_status=0',
			]);
			const rec = { DEDALO_CI_PARITY_RECORD_OUT: '/ci-out', DEDALO_CI_PARITY_RECORD_ALLOW: '0' };
			expect(drive(rec)).toEqual([
				'bun run scripts/parity_baseline.ts',
				'cp engineering/parity_baseline.json /ci-out/parity_baseline.json',
				'tier_status=0',
			]);
			expect(drive({ ...rec, DEDALO_CI_PARITY_RECORD_ALLOW: '1' })).toEqual([
				'bun run scripts/parity_baseline.ts --allow-regression',
				'cp engineering/parity_baseline.json /ci-out/parity_baseline.json',
				'tier_status=0',
			]);
			expect(drive({ ...rec, BUN_RC: '1' })).toEqual([
				'bun run scripts/parity_baseline.ts',
				'tier_status=1',
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('leftover CI volumes — only a dead run’s, never a live one’s', () => {
	const rows = [
		{ name: 'dedalo-ci-111-db_pgdata', project: 'dedalo-ci-111-db' }, // killed run
		{ name: 'dedalo-ci-222-db_pgdata', project: 'dedalo-ci-222-db' }, // live pid, no container yet
		{ name: 'dedalo-ci-333-instance_pgdata', project: 'dedalo-ci-333-instance' }, // container still there
		{ name: 'other_pgdata', project: 'other' }, // not ours
		{ name: 'dedalo-ci-bun-cache', project: '' },
	];
	const alive = (pid: number) => pid === 222;

	test('a dead pid with no container is swept; a live pid, a held project and a foreign project are not', () => {
		expect(orphanCiVolumes(rows, new Set(['dedalo-ci-333-instance']), alive)).toEqual([
			'dedalo-ci-111-db_pgdata',
		]);
	});

	test('the postgres service mounts a NAMED volume (an anonymous one cannot be attributed)', () => {
		const compose = readFileSync(join(REPO_ROOT, 'ci', 'compose.yml'), 'utf8');
		const postgres = /\n {2}postgres:\n([\s\S]*?)\n {2}\S/.exec(compose)?.[1] ?? '';
		expect(/^ {6}- pgdata:\/var\/lib\/postgresql$/m.test(postgres)).toBe(true);
		expect(/^volumes:\n(?: {2}.*\n)*? {2}pgdata:/m.test(compose)).toBe(true);
	});
});

describe('tier logs leave the container before /ci-out is removed (keepRunLogs)', () => {
	test('the logs dir is copied to <root>/<runId>/, one dir per run; nothing kept → null', () => {
		const dir = mkdtempSync(join(tmpdir(), 'dedalo-ci-keep-logs-'));
		try {
			const outputs = join(dir, 'out');
			const root = join(dir, 'ci-logs');
			mkdirSync(outputs);
			expect(keepRunLogs(outputs, root, 'run-a')).toBeNull();
			mkdirSync(join(outputs, 'logs', 'hermetic'), { recursive: true });
			writeFileSync(join(outputs, 'logs', 'hermetic', 'publication_site_builder.log'), 'kept\n');
			expect(keepRunLogs(outputs, root, 'run-a')).toBe(join(root, 'run-a'));
			expect(keepRunLogs(outputs, root, 'run-b')).toBe(join(root, 'run-b'));
			for (const run of ['run-a', 'run-b'])
				expect(
					readFileSync(join(root, run, 'hermetic', 'publication_site_builder.log'), 'utf8'),
				).toBe('kept\n');
			// The container is told to write there: the log dir is under the writable mount,
			// and compose passes DEDALO_CI_LOG_DIR through to the tier.
			expect(CONTAINER_LOG_DIR).toBe(`${CONTAINER_OUT}/logs`);
			const compose = readFileSync(join(REPO_ROOT, 'ci', 'compose.yml'), 'utf8');
			expect(compose).toContain('DEDALO_CI_LOG_DIR: ${DEDALO_CI_LOG_DIR:-}');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('a docker run: the compose env, the end of the run, the driver hands /ci-out back', () => {
	const facts = (outputs: string) => ({
		image: 'img@sha256:x',
		inputs: '/tmp/in',
		outputs,
		sha: 'a'.repeat(40),
		branch: 'master',
		base: undefined,
		auditBase: '',
		overlay: false,
		args: { flags: new Set<string>() },
		mounts: [
			{ host: '/h/src', container: CONTAINER_SRC },
			{ host: '/h/git', container: CONTAINER_GIT },
		],
	});

	test('the env maps the tier log dir to the container log dir, under the writable mount', () => {
		const env = dockerComposeEnv(facts('/tmp/out-x'));
		expect(env.DEDALO_CI_LOG_DIR).toBe(CONTAINER_LOG_DIR);
		expect(env.DEDALO_CI_OUT).toBe('/tmp/out-x');
		expect(CONTAINER_LOG_DIR.startsWith(`${CONTAINER_OUT}/`)).toBe(true);
		expect(env.DEDALO_CI_TIER_SCRIPT).toBe('none');
		expect([env.DEDALO_CI_SRC, env.DEDALO_CI_GIT]).toEqual(['/h/src', '/h/git']);
		// compose passes it through to the tier, which is what makes the mapping reach hermetic.sh.
		expect(readFileSync(join(REPO_ROOT, 'ci', 'compose.yml'), 'utf8')).toContain(
			'DEDALO_CI_LOG_DIR: ${DEDALO_CI_LOG_DIR:-}',
		);
	});

	test('finishDockerRun keeps the logs BEFORE removing the mounts, and an unremovable tree never throws', () => {
		const dir = mkdtempSync(join(tmpdir(), 'dedalo-ci-finish-'));
		try {
			const inputs = join(dir, 'in');
			const outputs = join(dir, 'out');
			mkdirSync(inputs);
			mkdirSync(join(outputs, 'logs', 'hermetic'), { recursive: true });
			writeFileSync(join(outputs, 'logs', 'hermetic', 'x.log'), 'kept\n');
			const root = join(dir, CI_LOGS_DIR);
			expect(finishDockerRun(inputs, outputs, root, 'docker-a')).toBe(join(root, 'docker-a'));
			expect(readFileSync(join(root, 'docker-a', 'hermetic', 'x.log'), 'utf8')).toBe('kept\n');
			expect(existsSync(outputs)).toBe(false);
			expect(existsSync(inputs)).toBe(false);

			// A tree the host cannot unlink (a 0555 dir with an entry — what a uid-1001 dir is to
			// a Linux host): reported, never thrown over the run's verdict; the logs still kept.
			const outputs2 = join(dir, 'out2');
			const locked = join(outputs2, 'logs', 'hermetic');
			mkdirSync(locked, { recursive: true });
			writeFileSync(join(locked, 'y.log'), 'kept too\n');
			chmodSync(locked, 0o555);
			const inputs2 = join(dir, 'in2');
			mkdirSync(inputs2);
			const finished: { kept: string | null } = { kept: null };
			const warnings = captureErrors(() => {
				expect(() => {
					finished.kept = finishDockerRun(inputs2, outputs2, root, 'docker-b');
				}).not.toThrow();
			});
			// The precondition, or the case proves nothing (a uid-0 run ignores the mode bits).
			expect(
				existsSync(outputs2),
				'precondition: the locked tree must survive the removal (running as root?)',
			).toBe(true);
			expect(warnings.some((w) => w.includes("could not remove the run's scratch dir"))).toBe(true);
			expect(existsSync(inputs2), 'the removable mount was still removed').toBe(false);
			expect(finished.kept).toBe(join(root, 'docker-b'));
			expect(readFileSync(join(root, 'docker-b', 'hermetic', 'y.log'), 'utf8')).toBe('kept too\n');
		} finally {
			// cpSync keeps the 0555 mode on the copy too.
			for (const locked of [
				join(dir, 'out2', 'logs', 'hermetic'),
				join(dir, CI_LOGS_DIR, 'docker-b', 'hermetic'),
			])
				if (existsSync(locked)) chmodSync(locked, 0o755);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('pruneRunLogs is total: an unlistable root warns and returns [], and the run still removes its own mounts', () => {
		const dir = mkdtempSync(join(tmpdir(), 'dedalo-ci-prune-total-'));
		const root = join(dir, CI_LOGS_DIR);
		try {
			// A FILE where the root should be: the listing fails (ENOTDIR).
			writeFileSync(join(dir, 'not-a-dir'), '');
			const asFile = captureErrors(() => {
				expect(pruneRunLogs(join(dir, 'not-a-dir'))).toEqual([]);
			});
			expect(asFile.some((w) => w.includes('could not list'))).toBe(true);
			// A root this user may write into but not list (0333): keepRunLogs still copies,
			// the prune cannot read it — finishDockerRun returns and removes both mounts.
			mkdirSync(root);
			for (let i = 0; i < 12; i++) mkdirSync(join(root, `docker-old-${i}`));
			chmodSync(root, 0o333);
			// PRECONDITION: the root really is unlistable here (a uid-0 run reads through 0333 —
			// then this case would prove nothing, so it says so instead of failing obscurely).
			let listable = true;
			try {
				accessSync(root, fsConstants.R_OK);
			} catch {
				listable = false;
			}
			if (listable) {
				throw new Error(
					`precondition: a 0333 ${root} must be unlistable for this user (running as root?)`,
				);
			}
			const inputs = join(dir, 'in');
			const outputs = join(dir, 'out');
			mkdirSync(inputs);
			mkdirSync(join(outputs, 'logs', 'hermetic'), { recursive: true });
			writeFileSync(join(outputs, 'logs', 'hermetic', 'z.log'), 'z\n');
			const unlistable = captureErrors(() => {
				expect(finishDockerRun(inputs, outputs, root, 'docker-new')).toBe(join(root, 'docker-new'));
			});
			expect(unlistable.some((w) => w.includes('could not list'))).toBe(true);
			expect(existsSync(inputs)).toBe(false);
			expect(existsSync(outputs)).toBe(false);
		} finally {
			if (existsSync(root)) chmodSync(root, 0o755);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('pruneRunLogs skips an entry that vanished before its stat, and reports + skips one whose stat fails', () => {
		const root = mkdtempSync(join(tmpdir(), 'dedalo-ci-prune-stat-'));
		try {
			for (let i = 0; i < 5; i++) mkdirSync(join(root, `docker-run-${i}`));
			// The DEFAULT stat on a path another run just pruned: undefined, not an ENOENT throw.
			expect(statRunDir(join(root, 'docker-gone'))).toBeUndefined();
			const order: Record<string, number> = {
				'docker-run-0': 1,
				'docker-run-1': 2,
				'docker-run-2': 3,
				'docker-run-3': 4,
				'docker-run-4': 5,
			};
			const stat = (path: string) => {
				const name = path.slice(root.length + 1);
				if (name === 'docker-run-3') {
					rmSync(path, { recursive: true, force: true }); // pruned between listing and stat
					return statRunDir(path);
				}
				if (name === 'docker-run-1') throw new Error('EACCES: permission denied (planted)');
				return { mtimeMs: order[name] ?? 0 };
			};
			let removed: string[] = [];
			const warnings = captureErrors(() => {
				removed = pruneRunLogs(root, 1, stat);
			});
			// run-4 kept (newest), run-3 vanished, run-1 unstattable: only 0 and 2 pruned.
			expect(removed.sort()).toEqual(['docker-run-0', 'docker-run-2']);
			expect(existsSync(join(root, 'docker-run-4'))).toBe(true);
			expect(existsSync(join(root, 'docker-run-1'))).toBe(true);
			expect(warnings.filter((w) => w.includes('could not stat')).length).toBe(1);
			expect(warnings.some((w) => w.includes('docker-run-1'))).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('finishDockerRun: a prune that throws is reported, never thrown, and the mounts are already gone', () => {
		const dir = mkdtempSync(join(tmpdir(), 'dedalo-ci-prune-throws-'));
		const root = join(dir, CI_LOGS_DIR);
		try {
			const inputs = join(dir, 'in');
			const outputs = join(dir, 'out');
			mkdirSync(inputs);
			mkdirSync(join(outputs, 'logs', 'hermetic'), { recursive: true });
			writeFileSync(join(outputs, 'logs', 'hermetic', 'z.log'), 'z\n');
			const mountsAtPrune: boolean[] = [];
			const prune = (_root: string) => {
				mountsAtPrune.push(existsSync(inputs), existsSync(outputs));
				throw new Error('planted prune failure');
			};
			const result: { logs: string | null } = { logs: null };
			const warnings = captureErrors(() => {
				result.logs = finishDockerRun(inputs, outputs, root, 'docker-new', prune);
			});
			expect(result.logs).toBe(join(root, 'docker-new'));
			expect(mountsAtPrune).toEqual([false, false]); // own mounts removed BEFORE the prune
			expect(existsSync(inputs)).toBe(false);
			expect(existsSync(outputs)).toBe(false);
			expect(
				warnings.some((w) => w.includes('pruning') && w.includes('planted prune failure')),
			).toBe(true);
			expect(readFileSync(join(root, 'docker-new', 'hermetic', 'z.log'), 'utf8')).toBe('z\n');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('pruneRunLogs keeps the newest K docker-* run dirs and touches nothing else', () => {
		const root = mkdtempSync(join(tmpdir(), 'dedalo-ci-prune-'));
		try {
			const now = Date.now() / 1000;
			for (let i = 0; i < 5; i++) {
				const run = join(root, `docker-run-${i}`);
				mkdirSync(run);
				utimesSync(run, now - (5 - i) * 60, now - (5 - i) * 60); // run-4 newest
			}
			mkdirSync(join(root, 'hermetic')); // a host run's dir, not a docker run
			expect(pruneRunLogs(root, 2).sort()).toEqual([
				'docker-run-0',
				'docker-run-1',
				'docker-run-2',
			]);
			for (const [name, kept] of [
				['docker-run-0', false],
				['docker-run-1', false],
				['docker-run-2', false],
				['docker-run-3', true],
				['docker-run-4', true],
				['hermetic', true],
			] as const)
				expect(existsSync(join(root, name)), name).toBe(kept);
			expect(pruneRunLogs(join(root, 'absent'))).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("the driver's root half chmods the writable mount a+rwX and keeps the child's exit status", () => {
		const perl = /exec (perl -e '[^']*') \\/.exec(DRIVER_SCRIPT)?.[1];
		expect(perl, 'the driver no longer forks its tier under perl').toBeDefined();
		expect(perl).toContain(`"chmod", "-R", "a+rwX", "${CONTAINER_OUT}"`);
		const dir = mkdtempSync(join(tmpdir(), 'dedalo-ci-driver-'));
		try {
			const owned = join(dir, 'logs', 'hermetic');
			// Run the REAL one-liner with the mount swapped for a scratch dir: the child creates a
			// 0755 tree and exits 3; perl must exit 3 and leave the tree a+rwX.
			const local = (perl as string).replace(`"${CONTAINER_OUT}"`, JSON.stringify(dir));
			const proc = Bun.spawnSync([
				'bash',
				'-c',
				`${local.replace(/^perl -e /, 'perl -e ')} bash -c 'umask 022; mkdir -p ${owned}; echo x > ${owned}/f.log; exit 3'`,
			]);
			expect(proc.exitCode, proc.stderr.toString()).toBe(3);
			expect(statSync(owned).mode & 0o777).toBe(0o777);
			expect(statSync(join(owned, 'f.log')).mode & 0o666).toBe(0o666);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

/** Run `fn` with console.error captured; returns the lines it printed. */
function captureErrors(fn: () => void): string[] {
	const lines: string[] = [];
	const original = console.error;
	console.error = (...args: unknown[]) => {
		lines.push(args.map(String).join(' '));
	};
	try {
		fn();
	} finally {
		console.error = original;
	}
	return lines;
}
