/**
 * GATE — the pre-push gate (scripts/hooks/pre-push) and the gated multi-remote push
 * (scripts/push.ts) do what their headers say, measured by OUTCOME on a scratch repo.
 *
 * The hook is the thing that stands between a red and a published push; a hook whose
 * tier selection silently narrows, whose verdict describes a tree that is not the
 * pushed commit, or whose bank step commits the wrong files is worse than no hook —
 * it is a green light nobody checks. Everything below drives the REAL hook and the
 * REAL push.ts through `git push` / `bun run push` against local bare remotes, with
 * `baselines:bank` and `ci:local` replaced by scratch stubs (package.json of the
 * scratch repo) that log their argv and return a planted verdict:
 *
 *   1. HERMETIC_ONLY_PATHS is EARNED — every entry is re-measured: no tracked file in
 *      what the db/instance tiers execute names it as a path (the hermetic tier's own
 *      static tripwires excepted: their verdict the gate delivers anyway). A positive
 *      control proves the measurement can see a reader (docs/ has several).
 *   2. TIER SELECTION — a hermetic-only change runs `--hermetic`; a DELETION of an
 *      engineering json (the 2026-09-26 glob-expansion defect: `engineering/*.json`
 *      expanded against the checkout and missed a deleted file) runs the full gate; a
 *      RENAME out of src/ runs the full gate (its old path counts); DEDALO_PREPUSH=full
 *      forces it; a NEW branch computes its range against the remote's other refs.
 *   3. THE GATED TREE IS THE COMMIT — ci:local always receives `--ref <HEAD sha>`, and
 *      baselines:bank runs in a throwaway worktree of that commit (installed deps lent,
 *      the worktree removed after), so an untracked file can neither green/redden a
 *      verdict CI will not reproduce nor be measured into a banked floor; a bank commit
 *      that would overwrite a local untracked file is refused, not forced.
 *   4. VERDICTS — red blocks and the remote is unchanged; the refusal lists red stages
 *      as ✗, and never a skipped/green stage; bank exit 3 commits
 *      exactly the written files as "chore(baselines): bank improvements" ON EVERY
 *      PUSHED BRANCH (HEAD's by fast-forward, the others — a detached HEAD's branch
 *      included — by compare-and-swap; one checked out in another worktree is refused,
 *      not moved) and stops the push (exit 3); bank exit 1 refuses with no commit and
 *      names no flag (it points at the bank's per-ratchet line); Docker down refuses.
 *   5. ONCE PER SHA — two refs at one sha gate once; a second remote reuses the green.
 *      THE AUDIT BASE — ci:local gets `--audit-base <the remote's sha>` (all zeros, i.e.
 *      the audit FORCED, for a new branch or gated refs whose remote tips differ), and a
 *      green is reused only for the same base or from a forced run: a verdict whose audit
 *      skipped against one remote's base never answers for another's range.
 *   5c. THE REPOSITORY IS DISCOVERED — a push from a linked worktree (git exports GIT_DIR
 *      into the hook) banks into THAT worktree; a hostile GIT_INDEX_FILE is not used; push.ts
 *      under a hostile GIT_DIR/GIT_WORK_TREE pushes its own repository, a decoy untouched.
 *   5d. SIGNALS END THE HOOK — SIGINT to the whole process group (Ctrl-C) or SIGTERM to the
 *      hook alone, while a stage runs: the hook exits 130 once that stage returns, runs NO
 *      later stage (ci:local never starts, nothing is pushed), and its temp files and bank
 *      worktree are gone. The defect: a cleanup-only INT/TERM trap returned into the script,
 *      which carried on to the next stage.
 *   6. `prepare` — installs core.hooksPath once, is silent the second time, is a no-op
 *      under CI / in the CI image / outside a git checkout, and never overrides a
 *      foreign hooksPath.
 *   7. push.ts — fast-forwards the stale branch by compare-and-swap, gates once, pushes
 *      both branches to all three remotes; refuses diverged branches with nothing
 *      pushed; after a bank commit (hook exit 3) re-aligns and pushes the NEW sha.
 *
 * HERMETIC: scratch git repos under the OS temp dir, a fake `docker` on PATH, stub
 * scripts. No DB, no network, no Docker, nothing in this checkout written.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawn } from 'node:child_process';
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const HOOK_PATH = join(REPO_ROOT, 'scripts/hooks/pre-push');
const PUSH_PATH = join(REPO_ROOT, 'scripts/push.ts');
const THIS_FILE = 'test/unit/pre_push_gate_native.test.ts';
const HOOK_REL = 'scripts/hooks/pre-push';

// Each case drives real git pushes and `bun run` subprocesses (~1-3 s apiece).
setDefaultTimeout(60_000);

// ─────────────────────────────────────────────── 1. the hermetic-only list

/** The hook's HERMETIC_ONLY_PATHS, read from its source (one quoted line). */
function hermeticOnlyPaths(): string[] {
	const match = readFileSync(HOOK_PATH, 'utf8').match(/^HERMETIC_ONLY_PATHS='([^']*)'$/m);
	if (match === null) throw new Error(`${HOOK_REL}: no HERMETIC_ONLY_PATHS='…' line`);
	return (match[1] as string).split(/\s+/).filter((entry) => entry !== '');
}

/** The static tripwires the hermetic tier runs (scripts/ci/hermetic.sh HERMETIC_TRIPWIRES). */
function hermeticTripwires(): Set<string> {
	const source = readFileSync(join(REPO_ROOT, 'scripts/ci/hermetic.sh'), 'utf8');
	const block = source.match(/^HERMETIC_TRIPWIRES=\(\n([\s\S]*?)^\)/m);
	if (block === null) throw new Error('scripts/ci/hermetic.sh: no HERMETIC_TRIPWIRES=( … ) block');
	return new Set(
		[...(block[1] as string).matchAll(/^\s*(test\/unit\/\S+\.ts)\s*$/gm)].map(
			(m) => m[1] as string,
		),
	);
}

/**
 * process.env minus every GIT_*: the one git this file runs against THIS checkout names it
 * by `cwd`, and an ambient GIT_DIR (a hook's context) would grep another repository.
 * The scratch-repo harness below never inherits process.env at all (baseEnv).
 */
function noGitEnv(): Record<string, string | undefined> {
	return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
}

/** Where the db and instance tiers' executed code lives. */
const TIER_READERS = ['test', 'src', 'tools', 'client', 'install', 'ci', 'scripts'];

/**
 * WORD collisions, not readers: a matched line in `file` whose text matches `line` is
 * not a path reference to `entry`. Line-scoped on purpose — a real reference added to
 * the same file elsewhere is still caught.
 */
const WORD_COLLISIONS: { entry: string; file: string; line: RegExp; why: string }[] = [
	{
		entry: 'presentation/',
		file: 'client/dedalo/core/login/js/render_login.js',
		line: /role\s*:\s*'presentation'/,
		why: 'the ARIA role',
	},
	{
		entry: 'overrides/',
		file: 'test/unit/dependency_integrity_tripwire.test.ts',
		line: /^\s*'overrides',$|`overrides` may nest/,
		why: 'the package.json "overrides" dependency block',
	},
	{
		entry: 'overrides/',
		file: 'test/unit/lint_scope_tripwire.test.ts',
		line: /an `overrides` entry|so an `overrides`/,
		why: 'the biome.jsonc "overrides" key',
	},
];

/**
 * Lines in tracked files under TIER_READERS that name `entry` as a PATH — `name/…`
 * (not glued to a longer word before it) or a quoted `'name'` / `'name/` — minus the
 * `exempt` files and the WORD_COLLISIONS. Comments count: a false reader only keeps an
 * entry OFF the skip list, the safe direction.
 */
function readersOf(entry: string, exempt: Set<string>): string[] {
	const name = entry.replace(/\/$/, '').replace(/[.[\]()*+?^$|\\{}]/g, '\\$&');
	const pattern = `(^|[^A-Za-z0-9_.-])${name}/|['"\`]${name}['"\`/]`;
	const proc = Bun.spawnSync(
		['git', 'grep', '-n', '-I', '-E', '-e', pattern, '--', ...TIER_READERS],
		{ cwd: REPO_ROOT, env: noGitEnv(), stdout: 'pipe', stderr: 'pipe' },
	);
	// git grep: 0 found, 1 none, anything else is an error (not a checkout, bad regex).
	if (proc.exitCode !== 0 && proc.exitCode !== 1) {
		throw new Error(
			`git grep failed for ${entry} (exit ${proc.exitCode}): ${proc.stderr.toString()}`,
		);
	}
	return proc.stdout
		.toString()
		.split('\n')
		.filter((hit) => {
			const match = hit.match(/^([^:]+):\d+:(.*)$/);
			if (match === null) return false;
			const [, file, text] = match as unknown as [string, string, string];
			if (exempt.has(file)) return false;
			return !WORD_COLLISIONS.some(
				(collision) =>
					collision.entry === entry && collision.file === file && collision.line.test(text),
			);
		});
}

describe('pre-push gate: HERMETIC_ONLY_PATHS is earned', () => {
	const exempt = new Set([...hermeticTripwires(), THIS_FILE, HOOK_REL]);

	test('the list parses and is non-empty; hermetic.sh tripwire list parses', () => {
		expect(hermeticOnlyPaths().length).toBeGreaterThan(0);
		expect(hermeticTripwires().size).toBeGreaterThan(10);
	});

	test('no entry has a reader in what the db/instance tiers execute', () => {
		const offenders = hermeticOnlyPaths()
			.map((entry) => ({ entry, readers: readersOf(entry, exempt) }))
			.filter((row) => row.readers.length > 0);
		expect(
			offenders,
			`HERMETIC_ONLY_PATHS entries with a reader — a change there can redden the db/instance tiers, so drop the entry from ${HOOK_REL}: ${JSON.stringify(offenders)}`,
		).toEqual([]);
	});

	test('positive control: the measurement sees a real reader (docs/ ← test/helpers/docs_corpus.ts)', () => {
		const files = readersOf('docs/', exempt).map((hit) => hit.split(':')[0]);
		expect(files).toContain('test/helpers/docs_corpus.ts');
	});

	test('every entry is PUSHABLE — a gitignored path never appears in a range, so it would be inert', () => {
		const ignored = hermeticOnlyPaths().filter((entry) => {
			// A directory entry is probed by a file inside it.
			const probe = entry.endsWith('/') ? `${entry}probe` : entry;
			const proc = Bun.spawnSync(['git', 'check-ignore', '-q', '--no-index', probe], {
				cwd: REPO_ROOT,
				env: noGitEnv(),
			});
			if (proc.exitCode !== 0 && proc.exitCode !== 1)
				throw new Error(`git check-ignore failed for ${entry} (exit ${proc.exitCode})`);
			return proc.exitCode === 0;
		});
		expect(ignored, `gitignored HERMETIC_ONLY_PATHS entries — drop them from ${HOOK_REL}`).toEqual(
			[],
		);
	});

	test('every entry is a plain word — no glob metacharacter the shell could expand', () => {
		for (const entry of hermeticOnlyPaths()) expect(entry).toMatch(/^[A-Za-z0-9_.\-/]+$/);
	});

	test('every WORD_COLLISIONS exemption still matches a line (a stale exemption is removed)', () => {
		for (const collision of WORD_COLLISIONS) {
			const text = readFileSync(join(REPO_ROOT, collision.file), 'utf8');
			expect(
				text.split('\n').some((line) => collision.line.test(line)),
				`${collision.file}: exemption for ${collision.entry} (${collision.why}) matches nothing`,
			).toBe(true);
			expect(hermeticOnlyPaths()).toContain(collision.entry);
		}
	});
});

// ─────────────────────────────────────────────── the scratch harness

let scratch = '';
let fakeBin = '';
let stubDir = '';
let gitConfig = '';

interface Run {
	code: number;
	out: string;
	err: string;
}

function baseEnv(extra: Record<string, string> = {}): Record<string, string> {
	return {
		PATH: `${fakeBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
		HOME: scratch,
		TMPDIR: join(scratch, 'tmp'),
		GIT_CONFIG_GLOBAL: gitConfig,
		GIT_CONFIG_NOSYSTEM: '1',
		STUB_LOG: join(scratch, 'stub.log'),
		...extra,
	};
}

function run(cmd: string[], cwd: string, env: Record<string, string> = {}, stdin?: string): Run {
	const proc = Bun.spawnSync(cmd, {
		cwd,
		env: baseEnv(env),
		stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin),
		stdout: 'pipe',
		stderr: 'pipe',
	});
	return { code: proc.exitCode ?? 1, out: proc.stdout.toString(), err: proc.stderr.toString() };
}

function git(cwd: string, ...args: string[]): string {
	const r = run(['git', ...args], cwd);
	if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.err}`);
	return r.out.trim();
}

function write(repo: string, path: string, content: string): void {
	mkdirSync(dirname(join(repo, path)), { recursive: true });
	writeFileSync(join(repo, path), content);
}

function commitAll(repo: string, message: string): string {
	git(repo, 'add', '-A');
	git(repo, 'commit', '-q', '-m', message);
	return git(repo, 'rev-parse', 'HEAD');
}

function stubLog(): string[] {
	const path = join(scratch, 'stub.log');
	if (!existsSync(path)) return [];
	return readFileSync(path, 'utf8')
		.split('\n')
		.filter((line) => line !== '');
}

function resetLog(): void {
	rmSync(join(scratch, 'stub.log'), { force: true });
}

function ciCalls(): string[] {
	return stubLog().filter((line) => line.startsWith('ci '));
}

let repoCounter = 0;

/** The bare remote `freshRepo` creates for `remote` in repo number `n`. */
function bareFor(n: number, remote: string): string {
	return join(scratch, `remote${n}_${remote}.git`);
}

/** The REAL hook's identity of a remote URL (`--remote-id`). */
function remoteId(url: string): string {
	const r = run(['sh', HOOK_PATH, '--remote-id', url], scratch);
	if (r.code !== 0 || !/^[0-9a-f]{40}\n?$/.test(r.out)) throw new Error(`--remote-id ${url}: ${r.err}`);
	return r.out.trim();
}

/** The REAL hook's class of a remote URL (`--remote-class`). */
function remoteClass(url: string, hookPath = HOOK_PATH): string {
	const r = run(['sh', hookPath, '--remote-class', url], scratch);
	if (r.code !== 0) throw new Error(`--remote-class ${url}: ${r.err}`);
	return r.out.trim();
}

/** The hook text with INTERNAL_REMOTE_IDS replaced (a control must APPLY). */
function withInternalIds(hook: string, ids: string[]): string {
	const out = hook.replace(/^INTERNAL_REMOTE_IDS='[^']*'$/m, `INTERNAL_REMOTE_IDS='${ids.join(' ')}'`);
	if (out === hook) throw new Error(`${HOOK_REL}: no INTERNAL_REMOTE_IDS='…' line to replace`);
	return out;
}

/**
 * A fresh developer repo on branch v7 (+ master at the same commit) with the real hook
 * and push.ts, stubbed package.json scripts, and `remotes` bare remotes that already
 * hold the initial commit (pushed with --no-verify, tracking refs fetched).
 */
function freshRepo(remotes: string[] = ['origin'], internal: string[] = []): string {
	repoCounter++;
	const repo = join(scratch, `work${repoCounter}`);
	mkdirSync(repo, { recursive: true });
	git(repo, 'init', '-q', '-b', 'v7');
	mkdirSync(join(repo, 'scripts/hooks'), { recursive: true });
	// `internal` remotes: their bare-repo URL's identity REPLACES the hook's
	// INTERNAL_REMOTE_IDS in this scratch copy — the real internal URL is named nowhere
	// in the repository, so the policy is exercised on a stand-in identity.
	const hook = readFileSync(HOOK_PATH, 'utf8');
	const ids = internal.map((remote) => remoteId(bareFor(repoCounter, remote)));
	writeFileSync(
		join(repo, HOOK_REL),
		internal.length === 0 ? hook : withInternalIds(hook, ids),
	);
	chmodSync(join(repo, HOOK_REL), 0o755);
	copyFileSync(PUSH_PATH, join(repo, 'scripts/push.ts'));
	write(
		repo,
		'package.json',
		JSON.stringify(
			{
				name: 'scratch',
				private: true,
				scripts: {
					'baselines:bank': `sh ${join(stubDir, 'bank.sh')}`,
					'ci:local': `sh ${join(stubDir, 'ci.sh')}`,
				},
			},
			null,
			'\t',
		),
	);
	write(repo, 'src/a.ts', 'export const a = 1;\n');
	// A ratchet-like directory of JSON floors. NOT named engineering/: the scratch repo's
	// fixtures are not this checkout's baselines, and baseline_registry_tripwire
	// discovers every engineering/ path a test names as one the bank must know.
	write(repo, 'floors/keep.json', '{}\n');
	write(repo, 'floors/gone.json', '{}\n');
	// Installed dependencies: ignored, and lent to the bank's isolated worktree.
	write(repo, '.gitignore', 'node_modules/\n');
	write(repo, 'node_modules/dep/marker', 'installed\n');
	write(repo, 'presentation/notes.md', 'v1\n');
	commitAll(repo, 'initial');
	git(repo, 'branch', 'master');
	git(repo, 'config', 'core.hooksPath', 'scripts/hooks');
	for (const remote of remotes) {
		const bare = bareFor(repoCounter, remote);
		git(scratch, 'init', '-q', '--bare', bare);
		git(repo, 'remote', 'add', remote, bare);
		git(repo, 'push', '-q', '--no-verify', remote, 'v7', 'master');
		git(repo, 'fetch', '-q', remote);
	}
	resetLog();
	return repo;
}

function remoteTip(repo: string, remote: string, branch: string): string {
	const out = git(repo, 'ls-remote', remote, `refs/heads/${branch}`);
	return out.split('\t')[0] ?? '';
}

beforeAll(() => {
	scratch = mkdtempSync(join(tmpdir(), 'dedalo-prepush-gate-'));
	mkdirSync(join(scratch, 'tmp'));
	fakeBin = join(scratch, 'bin');
	stubDir = join(scratch, 'stubs');
	mkdirSync(fakeBin);
	mkdirSync(stubDir);
	gitConfig = join(scratch, 'gitconfig');
	writeFileSync(
		gitConfig,
		'[user]\n\tname = gate\n\temail = gate@example.invalid\n[init]\n\tdefaultBranch = v7\n[advice]\n\tdetachedHead = false\n',
	);
	// docker: `docker info` answers per STUB_DOCKER (default up).
	writeFileSync(
		join(fakeBin, 'docker'),
		'#!/bin/sh\n[ "${STUB_DOCKER:-up}" = up ] || exit 1\nexit 0\n',
		{ mode: 0o755 },
	);
	// baselines:bank — logs its argv and what it can SEE (an untracked checkout file must
	// be invisible; the installed deps must be lent), then STUB_BANK_CODE; 3 writes
	// floors/banked_floor.json.
	// STUB_BANK_ONCE=<file>: 3 the first time only (the file marks "already banked").
	// STUB_BANK_REPORT: printed on stdout, as the real bank prints its per-ratchet report.
	writeFileSync(
		join(stubDir, 'bank.sh'),
		[
			'printf "bank %s\\n" "$*" >>"$STUB_LOG"',
			'printf "bank-cwd %s\\n" "$PWD" >>"$STUB_LOG"',
			// STUB_BANK_SLEEP: a long-running stage, for the signal cases.
			'if [ -n "${STUB_BANK_SLEEP:-}" ]; then printf "bank-sleeping\\n" >>"$STUB_LOG"; sleep "$STUB_BANK_SLEEP"; fi',
			'[ -e src/untracked.ts ] && printf "bank-saw-untracked\\n" >>"$STUB_LOG"',
			'[ -e node_modules/dep/marker ] && printf "bank-saw-deps\\n" >>"$STUB_LOG"',
			'[ -n "${STUB_BANK_REPORT:-}" ] && printf "%s\\n" "$STUB_BANK_REPORT"',
			'code="${STUB_BANK_CODE:-0}"',
			'if [ -n "${STUB_BANK_ONCE:-}" ]; then',
			'  if [ -f "$STUB_BANK_ONCE" ]; then code=0; else : >"$STUB_BANK_ONCE"; code=3; fi',
			'fi',
			'[ "$code" = 3 ] && printf "{\\"floor\\": 1}\\n" >floors/banked_floor.json',
			'exit "$code"',
			'',
		].join('\n'),
	);
	// ci:local — logs argv, copies STUB_SUMMARY to the --summary path, exits STUB_CI_CODE.
	writeFileSync(
		join(stubDir, 'ci.sh'),
		[
			'printf "ci %s\\n" "$*" >>"$STUB_LOG"',
			'summary=""; prev=""',
			'for a in "$@"; do [ "$prev" = --summary ] && summary="$a"; prev="$a"; done',
			'[ -n "${STUB_SUMMARY:-}" ] && [ -n "$summary" ] && cp "$STUB_SUMMARY" "$summary"',
			'exit "${STUB_CI_CODE:-0}"',
			'',
		].join('\n'),
	);
});

afterAll(() => {
	if (scratch !== '') rmSync(scratch, { recursive: true, force: true });
});

// ─────────────────────────────────────────────── 2 + 3. tier selection, --ref

describe('pre-push gate: tier selection and the gated tree', () => {
	test('a hermetic-only change runs --hermetic with --ref <HEAD> and --audit-base <remote sha>; untracked files do not reach the gate', () => {
		const repo = freshRepo();
		const before = remoteTip(repo, 'origin', 'v7');
		write(repo, 'presentation/notes.md', 'v2\n');
		const sha = commitAll(repo, 'docs');
		write(repo, 'src/untracked.ts', 'export {};\n'); // untracked, never committed
		const r = run(['git', 'push', 'origin', 'v7'], repo);
		expect(r.code, r.err).toBe(0);
		expect(ciCalls()).toEqual([
			expect.stringMatching(
				new RegExp(`^ci --docker --hermetic --ref ${sha} --audit-base ${before} --summary \\S+$`),
			),
		]);
		expect(remoteTip(repo, 'origin', 'v7')).toBe(sha);
		// The bank ran — in an isolated worktree of the commit, not in this checkout: it
		// did not see the untracked file, it did see the lent deps, and the worktree is gone.
		const log = stubLog();
		const cwd = log.find((line) => line.startsWith('bank-cwd '))?.slice('bank-cwd '.length);
		expect(cwd).toBeDefined();
		expect(cwd).not.toBe(repo);
		// …and told it the tree is DISCARDED (--ephemeral), so its report never says
		// "commit these files" about files the hook deletes with the worktree.
		const bankArgv = log.filter((line) => line.startsWith('bank ') && !line.startsWith('bank-'));
		expect(bankArgv.length).toBe(1);
		expect((bankArgv[0] ?? '').split(/\s+/).slice(1)).toContain('--ephemeral');
		expect(log).not.toContain('bank-saw-untracked');
		expect(log).toContain('bank-saw-deps');
		expect(existsSync(cwd as string)).toBe(false);
		expect(git(repo, 'worktree', 'list', '--porcelain').match(/^worktree /gm)?.length).toBe(1);
	});

	test('DELETING a floor json while another exists runs the full gate (the glob defect)', () => {
		const repo = freshRepo();
		git(repo, 'rm', '-q', 'floors/gone.json');
		commitAll(repo, 'drop floor');
		const r = run(['git', 'push', 'origin', 'v7'], repo);
		expect(r.code, r.err).toBe(0);
		expect(r.err).toContain('the range touches floors/gone.json');
		expect(ciCalls()[0]).toMatch(/^ci --docker --hermetic --db --instance --ref /);
	});

	test('a RENAME out of src/ into a hermetic-only dir runs the full gate (the old path counts)', () => {
		const repo = freshRepo();
		renameSync(join(repo, 'src/a.ts'), join(repo, 'presentation/a.ts'));
		commitAll(repo, 'move');
		const r = run(['git', 'push', 'origin', 'v7'], repo);
		expect(r.code, r.err).toBe(0);
		expect(r.err).toContain('the range touches src/a.ts');
		expect(ciCalls()[0]).toMatch(/--db --instance/);
	});

	test('a path outside the list (a new top-level dir) runs the full gate by default', () => {
		const repo = freshRepo();
		write(repo, 'brand_new_dir/x.txt', 'x\n');
		commitAll(repo, 'new dir');
		expect(run(['git', 'push', 'origin', 'v7'], repo).code).toBe(0);
		expect(ciCalls()[0]).toMatch(/--db --instance/);
	});

	test('an EVIL MERGE on a new branch (a change made in the merge itself) runs the full gate', () => {
		const repo = freshRepo();
		// A side branch with a hermetic-only change, already on the remote…
		git(repo, 'checkout', '-q', '-b', 'side');
		write(repo, 'presentation/notes.md', 'side\n');
		commitAll(repo, 'side docs');
		git(repo, 'push', '-q', '--no-verify', 'origin', 'side');
		git(repo, 'fetch', '-q', 'origin');
		// …merged into a new branch, the merge commit ALSO adding src/y.ts. The merge is
		// the only commit new to the remote; `git log --name-only` alone lists no file
		// for it, which would have selected the hermetic-only level.
		git(repo, 'checkout', '-q', '-b', 'feature', 'v7');
		git(repo, 'merge', '-q', '--no-ff', '--no-commit', 'side');
		write(repo, 'src/y.ts', 'export const y = 1;\n');
		commitAll(repo, 'evil merge');
		resetLog();
		const r = run(['git', 'push', 'origin', 'feature'], repo);
		expect(r.code, r.err).toBe(0);
		expect(r.err).toContain('the range touches src/y.ts');
		expect(ciCalls()[0]).toMatch(/--db --instance/);
	});

	test('DEDALO_PREPUSH=full forces the full gate on a hermetic-only change', () => {
		const repo = freshRepo();
		write(repo, 'presentation/notes.md', 'v3\n');
		commitAll(repo, 'docs');
		expect(run(['git', 'push', 'origin', 'v7'], repo, { DEDALO_PREPUSH: 'full' }).code).toBe(0);
		expect(ciCalls()[0]).toMatch(/--db --instance/);
	});

	test('a NEW branch (remote sha 000…) is ranged against the remote’s other refs', () => {
		const repo = freshRepo();
		git(repo, 'checkout', '-q', '-b', 'feature');
		write(repo, 'presentation/notes.md', 'feature\n');
		const sha = commitAll(repo, 'feature docs');
		const r = run(['git', 'push', 'origin', 'feature'], repo);
		expect(r.code, r.err).toBe(0);
		// Only the one new commit (presentation/) is in range — not the whole history —
		// and the audit is FORCED (all-zero base), as GitHub runs it for a new branch.
		expect(ciCalls()).toEqual([
			expect.stringMatching(
				new RegExp(`^ci --docker --hermetic --ref ${sha} --audit-base 0{40} --summary `),
			),
		]);
	});
});

// ─────────────────────────────────────────────── 4. verdicts

describe('pre-push gate: verdicts', () => {
	test('red blocks; the refusal lists red as ✗, never skipped/green', () => {
		const repo = freshRepo();
		const before = remoteTip(repo, 'origin', 'v7');
		write(repo, 'presentation/notes.md', 'red\n');
		commitAll(repo, 'docs');
		const summary = join(scratch, 'red_summary.json');
		writeFileSync(
			summary,
			JSON.stringify({
				tiers: [
					{
						tier: 'hermetic',
						verdict: 'red',
						stages: [
							{ name: 'typecheck', verdict: 'green', fix_hint: null },
							{ name: 'audit', verdict: 'skipped', fix_hint: null },
							{ name: 'tripwires', verdict: 'red', fix_hint: 'fix the tripwire' },
						],
					},
				],
			}),
		);
		const r = run(['git', 'push', 'origin', 'v7'], repo, {
			STUB_CI_CODE: '1',
			STUB_SUMMARY: summary,
		});
		expect(r.code).not.toBe(0);
		expect(r.err).toContain('✗ hermetic › tripwires — fix the tripwire');
		// Exactly the one red stage is listed (StageVerdict is green | red | skipped).
		expect(r.err.match(/✗ hermetic › /g)).toHaveLength(1);
		expect(r.err).not.toContain('hermetic › audit');
		expect(r.err).not.toContain('hermetic › typecheck');
		expect(remoteTip(repo, 'origin', 'v7')).toBe(before);
	});

	test('bank exit 3 commits exactly the written file, stops the push, and the re-run passes', () => {
		const repo = freshRepo();
		const before = remoteTip(repo, 'origin', 'v7');
		write(repo, 'presentation/notes.md', 'bank\n');
		const pushed = commitAll(repo, 'docs');
		const once = join(scratch, `bank_once_${repoCounter}`);
		const r = run(['git', 'push', 'origin', 'v7'], repo, { STUB_BANK_ONCE: once });
		expect(r.code).not.toBe(0);
		expect(r.err).toContain('improvements banked — re-run the push');
		expect(ciCalls()).toEqual([]); // the gate never ran on the pre-bank sha
		expect(git(repo, 'log', '-1', '--format=%s')).toBe('chore(baselines): bank improvements');
		expect(git(repo, 'rev-parse', 'HEAD^')).toBe(pushed);
		expect(git(repo, 'show', '--name-only', '--format=', 'HEAD')).toBe('floors/banked_floor.json');
		expect(git(repo, 'status', '--porcelain', '--untracked-files=no')).toBe('');
		expect(remoteTip(repo, 'origin', 'v7')).toBe(before);
		// The banked commit touches floors/ → the re-run gates it at full.
		const again = run(['git', 'push', 'origin', 'v7'], repo, { STUB_BANK_ONCE: once });
		expect(again.code, again.err).toBe(0);
		expect(ciCalls()[0]).toMatch(/--db --instance/);
		expect(remoteTip(repo, 'origin', 'v7')).toBe(git(repo, 'rev-parse', 'HEAD'));
	});

	test('bank exit 3 from a DETACHED HEAD lands on the pushed BRANCH (CAS), not only on HEAD; the re-push passes', () => {
		const repo = freshRepo();
		write(repo, 'presentation/notes.md', 'detached\n');
		const pushed = commitAll(repo, 'docs');
		git(repo, 'checkout', '-q', '--detach');
		const once = join(scratch, `bank_once_${repoCounter}`);
		const r = run(['git', 'push', 'origin', 'v7'], repo, { STUB_BANK_ONCE: once });
		expect(r.code).not.toBe(0);
		expect(r.err).toContain('improvements banked — re-run the push');
		const banked = git(repo, 'rev-parse', 'HEAD');
		expect(git(repo, 'log', '-1', '--format=%s', banked)).toBe(
			'chore(baselines): bank improvements',
		);
		expect(git(repo, 'rev-parse', `${banked}^`)).toBe(pushed);
		// The branch carries it (the defect: only the detached HEAD did, the commit dangled).
		expect(git(repo, 'rev-parse', 'refs/heads/v7')).toBe(banked);
		expect(git(repo, 'reflog', '-1', '--format=%gs', 'refs/heads/v7')).toBe(
			'pre-push: bank improvements',
		);
		expect(run(['git', 'symbolic-ref', '-q', 'HEAD'], repo).code).not.toBe(0); // still detached
		expect(r.err).toContain('HEAD is DETACHED');
		expect(r.err).toContain('refs/heads/v7');
		expect(r.err).toContain('git switch v7');
		const again = run(['git', 'push', 'origin', 'v7'], repo, { STUB_BANK_ONCE: once });
		expect(again.code, again.err).toBe(0);
		expect(remoteTip(repo, 'origin', 'v7')).toBe(banked);
	});

	test('bank exit 3 with TWO pushed branches at the sha advances both (HEAD’s by merge, the other by CAS)', () => {
		const repo = freshRepo();
		write(repo, 'presentation/notes.md', 'two\n');
		const pushed = commitAll(repo, 'docs');
		git(repo, 'branch', '-f', 'master', 'v7');
		const once = join(scratch, `bank_once_${repoCounter}`);
		const r = run(['git', 'push', 'origin', 'v7', 'master'], repo, { STUB_BANK_ONCE: once });
		expect(r.code).not.toBe(0);
		expect(r.err).toContain('improvements banked — re-run the push');
		const banked = git(repo, 'rev-parse', 'HEAD');
		expect(git(repo, 'rev-parse', `${banked}^`)).toBe(pushed);
		expect(git(repo, 'symbolic-ref', 'HEAD')).toBe('refs/heads/v7');
		expect(git(repo, 'rev-parse', 'refs/heads/master')).toBe(banked);
		const again = run(['git', 'push', 'origin', 'v7', 'master'], repo, { STUB_BANK_ONCE: once });
		expect(again.code, again.err).toBe(0);
		expect(remoteTip(repo, 'origin', 'master')).toBe(banked);
		expect(remoteTip(repo, 'origin', 'v7')).toBe(banked);
	});

	test('a pushed branch checked out in ANOTHER worktree is not moved under it — refused with the command', () => {
		const repo = freshRepo();
		write(repo, 'presentation/notes.md', 'other wt\n');
		const pushed = commitAll(repo, 'docs');
		git(repo, 'branch', '-f', 'master', 'v7');
		const other = join(scratch, `other_wt_${repoCounter}`);
		git(repo, 'worktree', 'add', '-q', other, 'master');
		const r = run(['git', 'push', 'origin', 'v7', 'master'], repo, { STUB_BANK_CODE: '3' });
		expect(r.code).not.toBe(0);
		expect(r.err).toContain('NOT on every pushed branch');
		expect(r.err).not.toContain('re-run the push. New commit');
		expect(r.err).toContain('NOT moved: refs/heads/master is checked out in another worktree');
		expect(r.err).toContain('could not land on: refs/heads/master');
		expect(git(repo, 'rev-parse', 'refs/heads/master')).toBe(pushed);
		expect(git(repo, 'rev-parse', 'refs/heads/v7')).not.toBe(pushed); // HEAD's branch did move
		expect(remoteTip(repo, 'origin', 'master')).not.toBe(pushed);
	});

	test('a bank commit that would overwrite a local UNTRACKED file is refused, not forced', () => {
		const repo = freshRepo();
		write(repo, 'presentation/notes.md', 'clash\n');
		const pushed = commitAll(repo, 'docs');
		write(repo, 'floors/banked_floor.json', 'local scratch\n'); // untracked, at the banked path
		const r = run(['git', 'push', 'origin', 'v7'], repo, { STUB_BANK_CODE: '3' });
		expect(r.code).not.toBe(0);
		expect(r.err).toContain('could not be fast-forwarded into this checkout');
		expect(git(repo, 'rev-parse', 'HEAD')).toBe(pushed);
		expect(readFileSync(join(repo, 'floors/banked_floor.json'), 'utf8')).toBe('local scratch\n');
		expect(ciCalls()).toEqual([]);
		expect(git(repo, 'worktree', 'list', '--porcelain').match(/^worktree /gm)?.length).toBe(1);
	});

	test('bank exit 1 (a regression) refuses with no commit and no CI run', () => {
		const repo = freshRepo();
		write(repo, 'presentation/notes.md', 'regress\n');
		const sha = commitAll(repo, 'docs');
		const r = run(['git', 'push', 'origin', 'v7'], repo, {
			STUB_BANK_CODE: '1',
			STUB_BANK_REPORT: 'REGRESSED  twin_map — 1 new untwinned differential',
		});
		expect(r.code).not.toBe(0);
		expect(r.err).toContain('a ratchet REGRESSED');
		expect(r.err).toContain('twin_map');
		// The hook names no flag (several ratchets take no --reason): it points at the
		// bank's own per-ratchet line, which it printed above.
		expect(r.out).toContain('REGRESSED  twin_map');
		expect(r.err).toContain("the bank's\npre-push: REGRESSED line above names for that ratchet");
		expect(r.err).not.toContain('--allow-regression');
		expect(r.err).not.toContain('--reason');
		expect(git(repo, 'rev-parse', 'HEAD')).toBe(sha);
		expect(ciCalls()).toEqual([]);
	});

	test('bank exit 1 from an ERROR (a check that could not run) is NOT reported as a regression', () => {
		const repo = freshRepo();
		write(repo, 'presentation/notes.md', 'broken env\n');
		const sha = commitAll(repo, 'docs');
		const r = run(['git', 'push', 'origin', 'v7'], repo, {
			STUB_BANK_CODE: '1',
			STUB_BANK_REPORT: 'ERROR      lint_browser_budget — biome reported only 0 files',
		});
		expect(r.code).not.toBe(0);
		expect(r.err).toContain('could not RUN a check');
		expect(r.err).toContain('lint_browser_budget');
		expect(r.err).not.toContain('a ratchet REGRESSED');
		expect(r.err).not.toContain('--allow-regression');
		expect(git(repo, 'rev-parse', 'HEAD')).toBe(sha);
		expect(ciCalls()).toEqual([]);
	});

	test('a SYMLINKED node_modules (a linked worktree’s) is lent to the bank too', () => {
		const repo = freshRepo();
		// Replace the installed tree with a link to one elsewhere — the shape a linked
		// worktree has, and one `.gitignore`'s `node_modules/` does not even ignore.
		const elsewhere = join(scratch, `deps_elsewhere${repoCounter}`);
		mkdirSync(join(elsewhere, 'dep'), { recursive: true });
		writeFileSync(join(elsewhere, 'dep/marker'), 'installed\n');
		rmSync(join(repo, 'node_modules'), { recursive: true, force: true });
		symlinkSync(elsewhere, join(repo, 'node_modules'));
		write(repo, 'presentation/notes.md', 'linked deps\n');
		// NOT commitAll: `add -A` would COMMIT the unignored link, and the commit would
		// then carry the deps itself. On a desk the link is merely untracked.
		git(repo, 'add', 'presentation/notes.md');
		git(repo, 'commit', '-q', '-m', 'docs');
		// The link is NOT in the commit: HEAD has no object at node_modules (control: it
		// has one at the file just committed, so the probe can answer yes).
		expect(run(['git', 'cat-file', '-e', 'HEAD:node_modules'], repo).code).not.toBe(0);
		expect(run(['git', 'cat-file', '-e', 'HEAD:presentation/notes.md'], repo).code).toBe(0);
		const r = run(['git', 'push', 'origin', 'v7'], repo);
		expect(r.code, r.err).toBe(0);
		expect(stubLog()).toContain('bank-saw-deps');
	});

	test('Docker down refuses with instructions — never a silent skip', () => {
		const repo = freshRepo();
		write(repo, 'presentation/notes.md', 'nodocker\n');
		commitAll(repo, 'docs');
		const r = run(['git', 'push', 'origin', 'v7'], repo, { STUB_DOCKER: 'down' });
		expect(r.code).not.toBe(0);
		expect(r.err).toContain('Docker is not available');
		expect(r.err).toContain('--no-verify');
		expect(stubLog()).toEqual([]);
	});

	test('a dirty tracked file refuses (the verdict would not describe the pushed commit)', () => {
		const repo = freshRepo();
		write(repo, 'presentation/notes.md', 'committed\n');
		commitAll(repo, 'docs');
		write(repo, 'src/a.ts', 'export const a = 2;\n');
		const r = run(['git', 'push', 'origin', 'v7'], repo);
		expect(r.code).not.toBe(0);
		expect(r.err).toContain('tracked files differ from HEAD');
		expect(stubLog()).toEqual([]);
	});
});

// ─────────────────────────────────────────────── 5. once per sha

describe('pre-push gate: once per sha', () => {
	test('two refs at one sha gate once; a second remote reuses the green verdict', () => {
		const repo = freshRepo(['origin', 'mirror']);
		write(repo, 'presentation/notes.md', 'twice\n');
		const sha = commitAll(repo, 'docs');
		git(repo, 'branch', '-f', 'master', 'v7');
		expect(run(['git', 'push', 'origin', 'v7', 'master'], repo).code).toBe(0);
		expect(ciCalls().length).toBe(1);
		const second = run(['git', 'push', 'mirror', 'v7', 'master'], repo);
		expect(second.code, second.err).toBe(0);
		expect(second.err).toContain('already gated green');
		expect(ciCalls().length).toBe(1);
		expect(remoteTip(repo, 'mirror', 'master')).toBe(sha);
	});
});

// ─────────────────────────────────────────────── 5b. the audit base and the green cache

describe('pre-push gate: the audit base is the remote sha, and the green cache keys on it', () => {
	test('a verdict gated against one remote’s base is NOT reused for a remote at another base', () => {
		const repo = freshRepo(['origin', 'mirror']);
		const initial = remoteTip(repo, 'mirror', 'v7');
		write(repo, 'presentation/notes.md', 'A\n');
		const a = commitAll(repo, 'A');
		git(repo, 'push', '-q', '--no-verify', 'origin', 'v7'); // origin now at A, mirror at initial
		write(repo, 'presentation/notes.md', 'B\n');
		const b = commitAll(repo, 'B');
		expect(run(['git', 'push', 'origin', 'v7'], repo).code).toBe(0);
		expect(ciCalls()).toEqual([expect.stringMatching(new RegExp(`--ref ${b} --audit-base ${a} `))]);
		// Same sha, same level — but the mirror's range starts at `initial`: a lockfile bump
		// in A would be in it and not in origin's. The origin verdict must not answer for it.
		const second = run(['git', 'push', 'mirror', 'v7'], repo);
		expect(second.code, second.err).toBe(0);
		expect(second.err).not.toContain('already gated green');
		expect(ciCalls()).toEqual([
			expect.stringMatching(new RegExp(`--ref ${b} --audit-base ${a} `)),
			expect.stringMatching(new RegExp(`--ref ${b} --audit-base ${initial} `)),
		]);
		const green = readFileSync(join(repo, '.git', 'dedalo-prepush-green'), 'utf8');
		expect(green).toBe(`${b} hermetic audit:${a}\n${b} hermetic audit:${initial}\n`);
	});

	test('gated refs whose remote tips differ FORCE the audit; a forced green answers any base', () => {
		const repo = freshRepo(['origin', 'mirror']);
		write(repo, 'presentation/notes.md', 'A\n');
		commitAll(repo, 'A');
		git(repo, 'push', '-q', '--no-verify', 'origin', 'v7'); // origin: v7=A, master=initial
		write(repo, 'presentation/notes.md', 'B\n');
		const b = commitAll(repo, 'B');
		git(repo, 'branch', '-f', 'master', 'v7');
		const r = run(['git', 'push', 'origin', 'v7', 'master'], repo);
		expect(r.code, r.err).toBe(0);
		expect(ciCalls()).toEqual([
			expect.stringMatching(new RegExp(`--ref ${b} --audit-base 0{40} `)),
		]);
		// The forced run audited regardless of base — the mirror's push reuses it.
		const second = run(['git', 'push', 'mirror', 'v7', 'master'], repo);
		expect(second.code, second.err).toBe(0);
		expect(second.err).toContain('already gated green');
		expect(ciCalls().length).toBe(1);
	});

	test('a cache line from before the audit field (`<sha> <level>`) is never reused', () => {
		const repo = freshRepo();
		write(repo, 'presentation/notes.md', 'legacy\n');
		const sha = commitAll(repo, 'docs');
		writeFileSync(join(repo, '.git', 'dedalo-prepush-green'), `${sha} full\n`);
		expect(run(['git', 'push', 'origin', 'v7'], repo).code).toBe(0);
		expect(ciCalls().length).toBe(1);
	});
});

// ─────────────────────────────────────────────── 5e. the gate is per remote (2026-10-10)

describe('pre-push gate: remotes are classified by URL — internal hermetic-only, public/unknown full', () => {
	const PUBLIC_SPELLINGS = [
		'https://github.com/dedalia-org/dedalo.git',
		'https://github.com/dedalia-org/dedalo',
		'git@github.com:dedalia-org/dedalo.git',
		'ssh://git@github.com/dedalia-org/dedalo.git',
		'ssh://git@github.com:22/dedalia-org/dedalo/',
		'https://GitHub.com/dedalia-org/dedalo.git',
		'https://gitlab.com/dedalia/dedalo.git',
		'https://oauth2:token@gitlab.com:443/dedalia/dedalo',
		'git@gitlab.com:dedalia/dedalo.git',
	];
	const LOOKALIKES = [
		'https://github.com/dedalia-org/dedalo-fork.git',
		'https://github.com/someone/dedalo.git',
		'https://github.com.evil.example/dedalia-org/dedalo.git',
		'https://evil.example/github.com/dedalia-org/dedalo.git',
		'/srv/git/dedalo.git',
		'file:///srv/git/dedalo.git',
		'',
	];

	test('every spelling of the public mirrors is public; a look-alike or a local path is unknown', () => {
		for (const url of PUBLIC_SPELLINGS) expect(remoteClass(url), url).toBe('public');
		for (const url of LOOKALIKES) expect(remoteClass(url), url).toBe('unknown');
	});

	test('the real INTERNAL_REMOTE_IDS are identities (40-hex), and none is a public mirror', () => {
		const line = readFileSync(HOOK_PATH, 'utf8').match(/^INTERNAL_REMOTE_IDS='([^']*)'$/m);
		expect(line, `${HOOK_REL}: no INTERNAL_REMOTE_IDS line`).not.toBeNull();
		const ids = (line?.[1] ?? '').split(/\s+/).filter((id) => id !== '');
		expect(ids.length).toBeGreaterThanOrEqual(1);
		for (const id of ids) expect(id).toMatch(/^[0-9a-f]{40}$/);
		const publicIds = new Set([...PUBLIC_SPELLINGS, ...LOOKALIKES].map(remoteId));
		for (const id of ids) expect(publicIds.has(id), `internal id ${id} is a public URL`).toBe(false);
	});

	test('a stand-in internal identity matches its own spellings only (port, path, host all count)', () => {
		const url = 'ssh://git@internal.example:2222/srv/repo.git';
		const hook = join(scratch, 'pre-push-internal');
		writeFileSync(hook, withInternalIds(readFileSync(HOOK_PATH, 'utf8'), [remoteId(url)]));
		for (const same of [
			url,
			'ssh://other@INTERNAL.example:2222/srv/repo',
			'ssh://git@internal.example:2222//srv/repo.git/',
		])
			expect(remoteClass(same, hook), same).toBe('internal');
		for (const other of [
			'ssh://git@internal.example/srv/repo.git', // port 22: another server
			'ssh://git@internal.example:2222/srv/repo2.git',
			'ssh://git@internal.example.evil:2222/srv/repo.git',
			'https://github.com/dedalia-org/dedalo.git',
		])
			expect(remoteClass(other, hook), other).not.toBe('internal');
	});

	test('an INTERNAL push of a src/ change runs --hermetic only, says so, and a public-class push of the same sha re-gates full', () => {
		const repo = freshRepo(['gitdedalo', 'mirror'], ['gitdedalo']);
		write(repo, 'src/a.ts', 'export const a = 2;\n');
		const sha = commitAll(repo, 'src change');
		const r = run(['git', 'push', 'gitdedalo', 'v7'], repo);
		expect(r.code, r.err).toBe(0);
		expect(r.err).toContain('internal push: hermetic only; db/instance run nightly');
		expect(ciCalls()).toEqual([expect.stringMatching(/^ci --docker --hermetic --ref /)]);
		expect(remoteTip(repo, 'gitdedalo', 'v7')).toBe(sha);
		// The hermetic green never answers for a remote that needs the full gate.
		const second = run(['git', 'push', 'mirror', 'v7'], repo);
		expect(second.code, second.err).toBe(0);
		expect(second.err).toContain('remote: unknown');
		expect(ciCalls()[1]).toMatch(/^ci --docker --hermetic --db --instance --ref /);
	});

	test('the URL decides, not the name: a RENAMED internal remote stays hermetic; a remote NAMED gitdedalo elsewhere is full', () => {
		const repo = freshRepo(['gitdedalo', 'other'], ['gitdedalo']);
		git(repo, 'remote', 'rename', 'gitdedalo', 'github');
		write(repo, 'src/a.ts', 'export const a = 3;\n');
		commitAll(repo, 'one');
		expect(run(['git', 'push', 'github', 'v7'], repo).code).toBe(0);
		expect(ciCalls()).toEqual([expect.stringMatching(/^ci --docker --hermetic --ref /)]);
		resetLog();
		git(repo, 'remote', 'rename', 'other', 'gitdedalo');
		write(repo, 'src/a.ts', 'export const a = 4;\n');
		commitAll(repo, 'two');
		const r = run(['git', 'push', 'gitdedalo', 'v7'], repo);
		expect(r.code, r.err).toBe(0);
		expect(ciCalls()).toEqual([expect.stringMatching(/^ci --docker --hermetic --db --instance /)]);
	});

	test('DEDALO_PREPUSH=full forces the full gate on an internal push', () => {
		const repo = freshRepo(['gitdedalo'], ['gitdedalo']);
		write(repo, 'src/a.ts', 'export const a = 5;\n');
		commitAll(repo, 'src');
		expect(run(['git', 'push', 'gitdedalo', 'v7'], repo, { DEDALO_PREPUSH: 'full' }).code).toBe(0);
		expect(ciCalls()).toEqual([expect.stringMatching(/^ci --docker --hermetic --db --instance /)]);
	});

	test('a red internal push says honestly that no CI runs there after --no-verify', () => {
		const repo = freshRepo(['gitdedalo'], ['gitdedalo']);
		write(repo, 'src/a.ts', 'export const a = 6;\n');
		commitAll(repo, 'src');
		const r = run(['git', 'push', 'gitdedalo', 'v7'], repo, { STUB_CI_CODE: '1' });
		expect(r.code).not.toBe(0);
		expect(r.err).toContain('no CI runs on the internal remote');
		expect(r.err).not.toContain('CI still runs');
	});
});

describe('pre-push gate: a release tag needs a FULL green for its commit, on any remote', () => {
	test('a release tag at HEAD whose commit is already on the internal remote is gated FULL (audit forced)', () => {
		const repo = freshRepo(['gitdedalo'], ['gitdedalo']);
		write(repo, 'src/a.ts', 'export const a = 7;\n');
		const sha = commitAll(repo, 'release');
		expect(run(['git', 'push', 'gitdedalo', 'v7'], repo).code).toBe(0);
		resetLog();
		git(repo, 'tag', '-a', '-m', 'release', 'v7.0.1');
		const r = run(['git', 'push', 'gitdedalo', 'v7.0.1'], repo);
		expect(r.code, r.err).toBe(0);
		expect(r.err).toContain('release tag v7.0.1 names HEAD');
		expect(ciCalls()).toEqual([
			expect.stringMatching(
				new RegExp(`^ci --docker --hermetic --db --instance --ref ${sha} --audit-base 0{40} `),
			),
		]);
		expect(git(repo, 'ls-remote', 'gitdedalo', 'refs/tags/v7.0.1^{}').split('\t')[0]).toBe(sha);
	});

	test('a release tag on a commit with no FULL green (not HEAD) is refused — nothing gated, nothing pushed', () => {
		const repo = freshRepo(['gitdedalo'], ['gitdedalo']);
		const old = git(repo, 'rev-parse', 'HEAD');
		write(repo, 'src/a.ts', 'export const a = 8;\n');
		commitAll(repo, 'later');
		git(repo, 'tag', 'v7.0.2', old);
		const r = run(['git', 'push', 'gitdedalo', 'v7.0.2'], repo);
		expect(r.code).not.toBe(0);
		expect(r.err).toContain(`REFUSED — release tag v7.0.2 names ${old}, which has no FULL green`);
		expect(ciCalls()).toEqual([]);
		expect(git(repo, 'ls-remote', 'gitdedalo', 'refs/tags/v7.0.2')).toBe('');
		// A HERMETIC green is not enough: gate the commit internally, then tag it.
		write(repo, 'src/a.ts', 'export const a = 9;\n');
		const sha = commitAll(repo, 'hermetic only');
		expect(run(['git', 'push', 'gitdedalo', 'v7'], repo).code).toBe(0);
		write(repo, 'src/a.ts', 'export const a = 10;\n');
		commitAll(repo, 'moved on');
		git(repo, 'tag', 'v7.0.3', sha);
		expect(run(['git', 'push', 'gitdedalo', 'v7.0.3'], repo).code).not.toBe(0);
	});

	test('a release tag on a commit the FULL gate passed is accepted without re-gating, even off HEAD', () => {
		const repo = freshRepo(['gitdedalo', 'mirror'], ['gitdedalo']);
		write(repo, 'src/a.ts', 'export const a = 11;\n');
		const sha = commitAll(repo, 'gated full on the mirror');
		expect(run(['git', 'push', 'mirror', 'v7'], repo).code).toBe(0); // unknown → full
		git(repo, 'push', '-q', '--no-verify', 'gitdedalo', 'v7');
		write(repo, 'src/a.ts', 'export const a = 12;\n');
		commitAll(repo, 'moved on');
		resetLog();
		git(repo, 'tag', 'v7.0.4', sha);
		const r = run(['git', 'push', 'gitdedalo', 'v7.0.4'], repo);
		expect(r.code, r.err).toBe(0);
		expect(r.err).toContain('already gated green at the FULL level');
		expect(ciCalls()).toEqual([]);
	});

	test('a PRERELEASE tag (never published) needs no full green', () => {
		const repo = freshRepo(['gitdedalo'], ['gitdedalo']);
		git(repo, 'tag', 'v7.0.5-beta.1');
		const r = run(['git', 'push', 'gitdedalo', 'v7.0.5-beta.1'], repo);
		expect(r.code, r.err).toBe(0);
		expect(ciCalls()).toEqual([]);
	});
});

// ─────────────────────────────────────────────── 5c. hostile ambient GIT_*

describe('pre-push gate + push.ts: the repository is discovered, never inherited from GIT_*', () => {
	test('a push from a LINKED worktree (git exports GIT_DIR to the hook) banks into that worktree’s branch', () => {
		const repo = freshRepo();
		const wt = join(scratch, `linked_wt_${repoCounter}`);
		git(repo, 'worktree', 'add', '-q', '-b', 'side', wt);
		write(wt, 'presentation/notes.md', 'from the linked tree\n');
		const pushed = commitAll(wt, 'side docs');
		const mainTip = git(repo, 'rev-parse', 'v7');
		const r = run(['git', 'push', 'origin', 'side'], wt, { STUB_BANK_CODE: '3' });
		expect(r.code, r.err).not.toBe(0); // git reports any hook refusal as its own exit 1
		expect(r.err).toContain('improvements banked');
		// The bank commit is on the pushing worktree's branch, on top of the pushed commit,
		// carrying exactly the banked file — and neither tree is left dirty.
		expect(git(wt, 'log', '-1', '--format=%s')).toBe('chore(baselines): bank improvements');
		expect(git(wt, 'rev-parse', 'HEAD^')).toBe(pushed);
		expect(git(wt, 'show', '--name-only', '--format=', 'HEAD')).toBe('floors/banked_floor.json');
		expect(git(wt, 'status', '--porcelain', '--untracked-files=no')).toBe('');
		expect(git(repo, 'rev-parse', 'v7')).toBe(mainTip);
		expect(git(repo, 'status', '--porcelain', '--untracked-files=no')).toBe('');
	});

	test('a hostile GIT_INDEX_FILE in the push environment is not used by the gate', () => {
		const repo = freshRepo();
		write(repo, 'presentation/notes.md', 'index\n');
		const sha = commitAll(repo, 'docs');
		const hostileIndex = join(scratch, `hostile_index_${repoCounter}`);
		const r = run(['git', 'push', 'origin', 'v7'], repo, { GIT_INDEX_FILE: hostileIndex });
		expect(r.code, r.err).toBe(0);
		expect(existsSync(hostileIndex)).toBe(false);
		expect(remoteTip(repo, 'origin', 'v7')).toBe(sha);
	});

	test('push.ts with a hostile GIT_DIR / GIT_WORK_TREE pushes ITS repository; the decoy is untouched', () => {
		const repo = freshRepo(['gitdedalo', 'github', 'gitlab']);
		const decoy = join(scratch, `decoy_${repoCounter}`);
		mkdirSync(decoy);
		git(decoy, 'init', '-q', '-b', 'v7');
		write(decoy, 'decoy.txt', 'decoy\n');
		const decoyTip = commitAll(decoy, 'decoy');
		const decoyRefs = () => git(decoy, 'for-each-ref', '--format=%(refname) %(objectname)');
		const refsBefore = decoyRefs();
		write(repo, 'presentation/notes.md', 'land\n');
		const sha = commitAll(repo, 'docs');
		const r = run(['bun', 'run', 'scripts/push.ts'], repo, {
			GIT_DIR: join(decoy, '.git'),
			GIT_WORK_TREE: decoy,
			GIT_INDEX_FILE: join(decoy, '.git', 'index'),
		});
		expect(r.code, r.out + r.err).toBe(0);
		for (const remote of ['gitdedalo', 'github', 'gitlab']) {
			expect(remoteTip(repo, remote, 'v7')).toBe(sha);
			expect(remoteTip(repo, remote, 'master')).toBe(sha);
		}
		expect(decoyRefs()).toBe(refsBefore);
		expect(git(decoy, 'rev-parse', 'HEAD')).toBe(decoyTip);
		expect(git(decoy, 'status', '--porcelain', '--untracked-files=all')).toBe('');
	});
});

// ─────────────────────────────────────────────── 5d. signals

describe('pre-push gate: a signal ends the hook — no later stage, nothing left behind', () => {
	/**
	 * Runs the REAL hook as git would (argv + one ref line on stdin), in its own process
	 * group, with baselines:bank sleeping; once the bank is running, `signal` goes to the
	 * hook alone or to its whole group (what a terminal's Ctrl-C does).
	 */
	async function interrupted(signal: 'SIGINT' | 'SIGTERM', target: 'hook' | 'group') {
		const repo = freshRepo();
		const before = remoteTip(repo, 'origin', 'v7');
		write(repo, 'src/a.ts', 'export const a = 2;\n');
		const sha = commitAll(repo, 'change');
		// A TMPDIR of this case's own: removing it empty proves every temp file is gone.
		const tmp = join(scratch, `tmp_signal_${repoCounter}`);
		mkdirSync(tmp);
		const child = spawn(join(repo, HOOK_REL), ['origin', join(scratch, 'unused')], {
			cwd: repo,
			env: baseEnv({ TMPDIR: tmp, STUB_BANK_SLEEP: '3' }),
			detached: true,
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		let err = '';
		child.stderr?.on('data', (chunk) => {
			err += chunk.toString();
		});
		child.stdout?.resume();
		const exited = new Promise<number | null>((done) => child.on('exit', (code) => done(code)));
		child.stdin?.end(`refs/heads/v7 ${sha} refs/heads/v7 ${before}\n`);
		const deadline = Date.now() + 30_000;
		while (!stubLog().includes('bank-sleeping')) {
			if (Date.now() > deadline) throw new Error(`the bank stage never started: ${err}`);
			await Bun.sleep(25);
		}
		const sentAt = Date.now();
		process.kill(target === 'group' ? -(child.pid as number) : (child.pid as number), signal);
		const code = await exited;
		return { repo, before, code, err, tmp, elapsed: Date.now() - sentAt };
	}

	for (const [signal, target] of [
		['SIGINT', 'group'],
		['SIGTERM', 'hook'],
	] as const) {
		test(`${signal} to the ${target}: exit 130, ci:local never runs, temp files and bank worktree removed`, async () => {
			const r = await interrupted(signal, target);
			expect(r.code, r.err).toBe(130);
			// Promptly: at most the running stage's remaining sleep (3 s), never another stage.
			expect(r.elapsed).toBeLessThan(10_000);
			expect(ciCalls()).toEqual([]);
			expect(r.err).not.toContain('GREEN');
			expect(remoteTip(r.repo, 'origin', 'v7')).toBe(r.before);
			// rmdir refuses a non-empty directory: every mktemp file and the bank tree are gone.
			expect(() => rmdirSync(r.tmp)).not.toThrow();
			expect(git(r.repo, 'worktree', 'list', '--porcelain').match(/^worktree /gm)?.length).toBe(1);
		});
	}
});

// ─────────────────────────────────────────────── 6. prepare

describe('package.json "prepare"', () => {
	const prepare = (
		JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
			scripts: Record<string, string>;
		}
	).scripts.prepare as string;

	function prepareIn(cwd: string, env: Record<string, string> = {}): Run {
		return run(['sh', '-c', prepare], cwd, env);
	}

	test('installs core.hooksPath once, then is silent; never overrides a foreign value', () => {
		const repo = freshRepo();
		git(repo, 'config', '--unset', 'core.hooksPath');
		const first = prepareIn(repo);
		expect(first.code).toBe(0);
		expect(first.out).toContain('pre-push gate installed');
		expect(git(repo, 'config', '--get', 'core.hooksPath')).toBe('scripts/hooks');
		const second = prepareIn(repo);
		expect(second.code).toBe(0);
		expect(second.out + second.err).toBe('');
		git(repo, 'config', 'core.hooksPath', '.husky');
		const foreign = prepareIn(repo);
		expect(foreign.code).toBe(0);
		expect(foreign.err).toContain('NOT active');
		expect(git(repo, 'config', '--get', 'core.hooksPath')).toBe('.husky');
	});

	test('a no-op under CI, in the CI image, and outside a git checkout (a git-archive tree)', () => {
		for (const env of [{ CI: 'true' }, { DEDALO_CI_IMAGE: '1' }] as Record<string, string>[]) {
			const repo = freshRepo();
			git(repo, 'config', '--unset', 'core.hooksPath');
			const r = prepareIn(repo, env);
			expect(r.code).toBe(0);
			expect(run(['git', 'config', '--get', 'core.hooksPath'], repo).out.trim()).toBe('');
		}
		const archive = join(scratch, 'archive_tree');
		mkdirSync(join(archive, 'scripts/hooks'), { recursive: true });
		copyFileSync(HOOK_PATH, join(archive, HOOK_REL));
		const r = prepareIn(archive, { GIT_CEILING_DIRECTORIES: scratch });
		expect(r.code).toBe(0);
		expect(r.out + r.err).toBe('');
		expect(existsSync(join(archive, '.git'))).toBe(false);
	});
});

// ─────────────────────────────────────────────── 7. push.ts

describe('scripts/push.ts', () => {
	const REMOTES = ['gitdedalo', 'github', 'gitlab'];

	test('fast-forwards master by CAS, gates ONCE, pushes both branches to all three remotes', () => {
		const repo = freshRepo(REMOTES);
		write(repo, 'presentation/notes.md', 'land\n');
		const sha = commitAll(repo, 'docs'); // on v7; master stays behind (an ancestor)
		const r = run(['bun', 'run', 'scripts/push.ts'], repo);
		expect(r.code, r.out + r.err).toBe(0);
		expect(git(repo, 'rev-parse', 'master')).toBe(sha);
		expect(git(repo, 'reflog', '-1', '--format=%gs', 'master')).toBe('push: fast-forward to v7');
		expect(ciCalls().length).toBe(1);
		for (const remote of REMOTES) {
			expect(remoteTip(repo, remote, 'v7')).toBe(sha);
			expect(remoteTip(repo, remote, 'master')).toBe(sha);
		}
	});

	test('DIVERGED branches are refused and nothing is gated or pushed', () => {
		const repo = freshRepo(REMOTES);
		const before = remoteTip(repo, 'github', 'master');
		write(repo, 'presentation/notes.md', 'on v7\n');
		commitAll(repo, 'v7 side');
		git(repo, 'checkout', '-q', 'master');
		write(repo, 'presentation/other.md', 'on master\n');
		commitAll(repo, 'master side');
		const r = run(['bun', 'run', 'scripts/push.ts'], repo);
		expect(r.code).not.toBe(0);
		expect(r.err).toContain('DIVERGED');
		expect(stubLog()).toEqual([]);
		for (const remote of REMOTES) expect(remoteTip(repo, remote, 'master')).toBe(before);
	});

	test('a bank commit mid-gate (hook exit 3) is re-aligned, re-gated and the NEW sha is pushed', () => {
		const repo = freshRepo(REMOTES);
		write(repo, 'presentation/notes.md', 'bank then land\n');
		const docs = commitAll(repo, 'docs');
		const once = join(scratch, `push_bank_once_${repoCounter}`);
		const r = run(['bun', 'run', 'scripts/push.ts'], repo, { STUB_BANK_ONCE: once });
		expect(r.code, r.out + r.err).toBe(0);
		const head = git(repo, 'rev-parse', 'HEAD');
		expect(head).not.toBe(docs);
		expect(git(repo, 'log', '-1', '--format=%s')).toBe('chore(baselines): bank improvements');
		expect(git(repo, 'rev-parse', 'master')).toBe(head);
		for (const remote of REMOTES) {
			expect(remoteTip(repo, remote, 'v7')).toBe(head);
			expect(remoteTip(repo, remote, 'master')).toBe(head);
		}
		// Gated once, on the banked sha, at full (the bank commit touches floors/).
		expect(ciCalls()).toEqual([
			expect.stringMatching(new RegExp(`--db --instance --ref ${head} `)),
		]);
	});
});

// ─────────────────────────── bun is FOUND, never assumed on PATH (2026-09-26)
// A GUI/IDE git client hands the hook a PATH without ~/.bun/bin; the hook tries the
// installer's own location ($BUN_INSTALL/bin) and otherwise refuses by name — after the
// ref scan, so a push with nothing to gate needs no bun at all.
describe('pre-push gate: bun is found, never assumed on PATH', () => {
	// PATH with the docker stub and the system tools, but no bun.
	const noBunPath = () => `${fakeBin}:/usr/bin:/bin`;
	const bunHome = () => {
		const home = join(scratch, `bun_install_${repoCounter}`);
		mkdirSync(join(home, 'bin'), { recursive: true });
		const link = join(home, 'bin', 'bun');
		if (!existsSync(link)) symlinkSync(process.execPath, link);
		return home;
	};

	test('anti-vacuity: the bare PATH really has no bun', () => {
		const probe = run(['/bin/sh', '-c', 'command -v bun'], scratch, { PATH: noBunPath() });
		expect(
			probe.code,
			`bun resolved on the bare PATH at ${probe.out.trim()} — the cases below prove nothing`,
		).not.toBe(0);
	});

	test('bun off PATH but at $BUN_INSTALL/bin: the gate runs', () => {
		const repo = freshRepo();
		write(repo, 'presentation/notes.md', 'found bun\n');
		const sha = commitAll(repo, 'docs');
		resetLog();
		const r = run(['git', 'push', 'origin', 'v7'], repo, {
			PATH: noBunPath(),
			BUN_INSTALL: bunHome(),
		});
		expect(r.code, r.err).toBe(0);
		expect(ciCalls()).toHaveLength(1);
		expect(remoteTip(repo, 'origin', 'v7')).toBe(sha);
	});

	test('bun nowhere: REFUSED by name, nothing gated, nothing pushed', () => {
		const repo = freshRepo();
		const before = remoteTip(repo, 'origin', 'v7');
		write(repo, 'presentation/notes.md', 'no bun\n');
		commitAll(repo, 'docs');
		resetLog();
		const empty = join(scratch, `no_bun_${repoCounter}`);
		mkdirSync(empty, { recursive: true });
		const r = run(['git', 'push', 'origin', 'v7'], repo, { PATH: noBunPath(), BUN_INSTALL: empty });
		expect(r.code).not.toBe(0);
		expect(r.err).toContain('REFUSED — bun is not on PATH');
		expect(stubLog()).toEqual([]);
		expect(remoteTip(repo, 'origin', 'v7')).toBe(before);
	});

	test('nothing to gate needs no bun (an already-published ref)', () => {
		const repo = freshRepo();
		const empty = join(scratch, `no_bun_idle_${repoCounter}`);
		mkdirSync(empty, { recursive: true });
		resetLog();
		const r = run(['git', 'push', 'origin', 'v7'], repo, { PATH: noBunPath(), BUN_INSTALL: empty });
		expect(r.code, r.err).toBe(0);
		expect(stubLog()).toEqual([]);
	});
});
