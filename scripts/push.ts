#!/usr/bin/env bun
/**
 * PUBLISH `v7` + `master` TO EVERY REMOTE — gated once, pushed everywhere.
 *
 *   bun run push              # align, gate, push v7 + master to all remotes
 *   bun run push --internal   # the same, to the internal remote (gitdedalo) ONLY
 *   bun run push --dry-run    # print the plan (alignment, remote tips); change nothing
 *
 * --internal (2026-10-10) is the day-to-day landing: the hook gates a push to the
 * internal remote HERMETIC-ONLY (~3 min) and the nightly full gate runs db/instance on
 * gitdedalo/master. The plain form publishes to the public mirrors too, which the hook
 * gates FULL. The hook decides the level by the remote's URL, not by this list — a
 * `gitdedalo` remote pointing anywhere else is gated full.
 *
 * WHY THIS EXISTS. The landing ritual was manual: commit on one branch,
 * `git checkout` the other, `git merge` it fast-forward, then `git push` to
 * gitdedalo, github and gitlab by hand — six ref updates, each one a chance to
 * publish a branch that was never gated, or to gate the same sha three times.
 * This is that ritual as one command with the pre-push gate in front of it.
 *
 * THE FLOW.
 *   1. PRECONDITIONS. Every remote in REMOTES exists; no tracked file differs
 *      from HEAD (the gate tests the checkout, and step 2 may move it); HEAD is
 *      on `v7` or `master`.
 *   2. ALIGN. The two branches must name the same commit before anything is
 *      published. `master` is fast-forwarded to `v7` when it is an ancestor;
 *      symmetrically `v7` to `master` when THAT is the ancestor (a commit made
 *      on `master` — the reflog shows both directions are part of the ritual).
 *      DIVERGED BRANCHES ARE REFUSED: a merge is a decision, not a push step.
 *      The checked-out branch moves with `git merge --ff-only` (its working tree
 *      must follow); the other with a compare-and-swap `git update-ref`, refused
 *      if another worktree has it checked out (that tree would silently desync).
 *   3. GATE — ONCE. `scripts/hooks/pre-push` is run directly, per remote, with
 *      the exact stdin git would hand it (the remote tips come from
 *      `git ls-remote`, not from possibly-stale tracking refs). It remembers a
 *      green sha, so remotes 2 and 3 cost nothing unless a staler remote needs
 *      a wider tier set. Exit 3 means the bank committed improvements: HEAD
 *      moved, so this script re-aligns and re-gates by itself (bounded).
 *   4. PUSH with `--no-verify` — the gate already ran on exactly these shas;
 *      re-running it inside each `git push` is the triple cost this replaces.
 *      A failing remote does not stop the others; the exit code reports it.
 *
 * NOT A BYPASS. There is no flag here that skips the gate. The bypass is
 * `git push --no-verify`, typed by a human, visible in their history.
 *
 * Exit: 0 all pushed · 1 refused, red, or some remote failed · 2 usage.
 */

import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..');

/** The landing remotes, in push order. gitdedalo first: it is the primary. */
const ALL_REMOTES = ['gitdedalo', 'github', 'gitlab'] as const;
/** `--internal`: the day-to-day remote only. */
const INTERNAL_REMOTES = ['gitdedalo'] as const;
/** The remotes THIS run lands on (set once in main, from the arguments). */
let REMOTES: readonly string[] = ALL_REMOTES;

/** The branches published together. Both must name the same commit. */
const BRANCHES = ['v7', 'master'] as const;

const HOOK = join(REPO_ROOT, 'scripts/hooks/pre-push');

/** Re-gate bound after the bank commits improvements (exit 3). One is expected; two is odd; three is a loop. */
const MAX_GATE_ATTEMPTS = 3;

/** Hook exit code: improvements were banked into a new commit. */
const HOOK_BANKED = 3;

/**
 * The environment every child of this script gets: ours minus every variable git calls
 * REPOSITORY-LOCAL (`git rev-parse --local-env-vars` — git's own list: GIT_DIR,
 * GIT_WORK_TREE, GIT_INDEX_FILE, GIT_COMMON_DIR, …) and the GIT_CONFIG_KEY_/VALUE_<n>
 * pairs. Every git here names its repository by `cwd: REPO_ROOT`; an inherited GIT_DIR
 * (a caller's export, a hook's context) would override that silently and align, gate and
 * PUSH a different repository's branches. Transport variables (GIT_SSH_COMMAND, …) pass
 * through: the pushes need them. Same rule as scripts/ci_local.ts gitScrubbedEnv and the
 * pre-push hook's own scrub; this file stays self-contained (the gate's fixture copies it
 * alone into a scratch repo). Held by test/unit/pre_push_gate_native.test.ts (a push with
 * a hostile GIT_DIR/GIT_WORK_TREE leaves the decoy repository untouched).
 */
const CHILD_ENV: Record<string, string | undefined> = (() => {
	const bare = Object.fromEntries(
		Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
	);
	const list = Bun.spawnSync(['git', 'rev-parse', '--local-env-vars'], {
		env: bare,
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const local = new Set(
		list.stdout
			.toString()
			.split('\n')
			.filter((name) => name !== ''),
	);
	if (list.exitCode !== 0 || !local.has('GIT_DIR')) {
		console.error(
			`push: git rev-parse --local-env-vars failed or omitted GIT_DIR: ${list.stderr.toString().trim()}`,
		);
		process.exit(1);
	}
	return Object.fromEntries(
		Object.entries(process.env).filter(
			([key]) => !local.has(key) && !/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key),
		),
	);
})();

interface GitResult {
	code: number;
	out: string;
	err: string;
}

function git(args: string[], stdin?: string): GitResult {
	const proc = Bun.spawnSync(['git', ...args], {
		cwd: REPO_ROOT,
		env: CHILD_ENV,
		stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin),
		stdout: 'pipe',
		stderr: 'pipe',
	});
	return {
		code: proc.exitCode ?? 1,
		out: proc.stdout.toString().trim(),
		err: proc.stderr.toString().trim(),
	};
}

function gitOk(args: string[]): string {
	const r = git(args);
	if (r.code !== 0) fail(`git ${args.join(' ')} failed: ${r.err || r.out}`);
	return r.out;
}

function fail(message: string): never {
	console.error(`push: ${message}`);
	process.exit(1);
}

function say(message: string): void {
	console.log(`push: ${message}`);
}

function revParse(ref: string): string {
	return gitOk(['rev-parse', '--verify', '-q', `${ref}^{commit}`]);
}

function isAncestor(ancestor: string, descendant: string): boolean {
	return git(['merge-base', '--is-ancestor', ancestor, descendant]).code === 0;
}

/** The branch HEAD is on, or null when detached. */
function currentBranch(): string | null {
	const r = git(['symbolic-ref', '--quiet', '--short', 'HEAD']);
	return r.code === 0 ? r.out : null;
}

/** Branches checked out in a worktree OTHER than this one. */
function branchesCheckedOutElsewhere(): Set<string> {
	const here = gitOk(['rev-parse', '--show-toplevel']);
	const found = new Set<string>();
	let worktree = '';
	for (const line of gitOk(['worktree', 'list', '--porcelain']).split('\n')) {
		if (line.startsWith('worktree ')) worktree = line.slice('worktree '.length);
		else if (line.startsWith('branch refs/heads/') && worktree !== here) {
			found.add(line.slice('branch refs/heads/'.length));
		}
	}
	return found;
}

function assertPreconditions(): void {
	const known = new Set(gitOk(['remote']).split('\n'));
	const missing = REMOTES.filter((remote) => !known.has(remote));
	if (missing.length > 0) fail(`remote(s) not configured in this clone: ${missing.join(', ')}`);

	const dirty = gitOk(['status', '--porcelain', '--untracked-files=no']);
	if (dirty !== '') {
		fail(
			`tracked files differ from HEAD — commit or set them aside first (the gate tests the checkout):\n${dirty
				.split('\n')
				.map((line) => `    ${line}`)
				.join('\n')}`,
		);
	}

	const branch = currentBranch();
	if (branch === null || !(BRANCHES as readonly string[]).includes(branch)) {
		fail(`HEAD must be on ${BRANCHES.join(' or ')} (it is on ${branch ?? 'a detached commit'})`);
	}
}

/**
 * Make both branches name the same commit, fast-forward only. Returns that
 * commit. `dryRun` reports the move without making it.
 */
function alignBranches(dryRun: boolean): string {
	const [a, b] = BRANCHES;
	const tipA = revParse(a);
	const tipB = revParse(b);
	if (tipA === tipB) {
		say(`${a} and ${b} both at ${tipA.slice(0, 10)}`);
		return tipA;
	}

	let behind: string;
	let target: string;
	let targetSha: string;
	if (isAncestor(tipB, tipA)) [behind, target, targetSha] = [b, a, tipA];
	else if (isAncestor(tipA, tipB)) [behind, target, targetSha] = [a, b, tipB];
	else {
		fail(
			`${a} (${tipA.slice(0, 10)}) and ${b} (${tipB.slice(0, 10)}) have DIVERGED — neither is an ancestor of the other.\n` +
				'    Reconcile them deliberately (a merge or rebase is a decision, not a push step), then run again.',
		);
	}
	const behindSha = revParse(behind);
	say(
		`fast-forward ${behind} ${behindSha.slice(0, 10)} → ${target} ${targetSha.slice(0, 10)}${dryRun ? ' (dry run: not moved)' : ''}`,
	);
	if (dryRun) return targetSha;

	if (currentBranch() === behind) {
		// The checked-out branch: its working tree must follow, so a real merge.
		const r = git(['merge', '--ff-only', '--quiet', target]);
		if (r.code !== 0) fail(`git merge --ff-only ${target} failed: ${r.err || r.out}`);
	} else {
		if (branchesCheckedOutElsewhere().has(behind)) {
			fail(
				`${behind} is checked out in another worktree — moving it here would desync that tree. Fast-forward it there.`,
			);
		}
		// Compare-and-swap: refuses if the branch moved since it was read.
		gitOk([
			'update-ref',
			'-m',
			`push: fast-forward to ${target}`,
			`refs/heads/${behind}`,
			targetSha,
			behindSha,
		]);
	}
	return targetSha;
}

/** The remote's current tip per branch (all-zero when the branch is new there). */
function remoteTips(remote: string): Map<string, string> {
	const r = git([
		'ls-remote',
		'--heads',
		remote,
		...BRANCHES.map((branch) => `refs/heads/${branch}`),
	]);
	if (r.code !== 0)
		fail(`git ls-remote ${remote} failed (network? credentials?): ${r.err || r.out}`);
	const tips = new Map<string, string>();
	for (const line of r.out.split('\n')) {
		const [sha, ref] = line.split('\t');
		if (sha !== undefined && ref !== undefined) tips.set(ref.replace(/^refs\/heads\//, ''), sha);
	}
	return tips;
}

/** Run the pre-push hook exactly as git would for a push of BRANCHES to `remote`. */
function runGate(remote: string, localSha: string): number {
	const zero = '0'.repeat(localSha.length);
	const tips = remoteTips(remote);
	const stdin = BRANCHES.map(
		(branch) =>
			`refs/heads/${branch} ${localSha} refs/heads/${branch} ${tips.get(branch) ?? zero}\n`,
	).join('');
	const url = git(['remote', 'get-url', '--push', remote]).out;
	say(`gate for ${remote} (${BRANCHES.join(' + ')} @ ${localSha.slice(0, 10)})`);
	const proc = Bun.spawnSync(['sh', HOOK, remote, url], {
		cwd: REPO_ROOT,
		env: CHILD_ENV,
		stdin: new TextEncoder().encode(stdin),
		stdout: 'inherit',
		stderr: 'inherit',
	});
	return proc.exitCode ?? 1;
}

function main(): void {
	const args = process.argv.slice(2);
	const known = ['--dry-run', '--internal', '--help', '-h'];
	const unknown = args.filter((arg) => !known.includes(arg));
	if (unknown.length > 0 || args.includes('--help') || args.includes('-h')) {
		console.log(
			'bun run push [--internal] [--dry-run]\n\n' +
				`Fast-forwards ${BRANCHES.join('/')} to each other, runs the pre-push gate once, then pushes both\n` +
				`branches to ${ALL_REMOTES.join(', ')} (--internal: ${INTERNAL_REMOTES.join(', ')} only) with --no-verify.\n` +
				'There is no gate-skipping flag: the hook picks the level from each remote URL.',
		);
		process.exit(unknown.length > 0 ? 2 : 0);
	}
	const dryRun = args.includes('--dry-run');
	if (args.includes('--internal')) REMOTES = INTERNAL_REMOTES;

	assertPreconditions();

	let sha = alignBranches(dryRun);
	if (dryRun) {
		for (const remote of REMOTES) {
			const tips = remoteTips(remote);
			say(
				`${remote}: ${BRANCHES.map((branch) => `${branch}=${(tips.get(branch) ?? '(new)').slice(0, 10)}`).join(' ')}`,
			);
		}
		say('dry run — nothing gated, moved or pushed.');
		return;
	}

	// Gate every remote (cheap after the first green: the hook remembers the sha).
	let attempt = 1;
	gate: for (;;) {
		for (const remote of REMOTES) {
			const code = runGate(remote, sha);
			if (code === 0) continue;
			if (code === HOOK_BANKED && attempt < MAX_GATE_ATTEMPTS) {
				attempt++;
				say('the bank committed improvements — re-aligning and re-gating the new HEAD.');
				sha = alignBranches(false);
				continue gate;
			}
			fail(`the gate refused the push to ${remote} (exit ${code}). Nothing was pushed.`);
		}
		break;
	}

	// Push. The shas cannot have moved: the gate ran on this checkout and
	// nothing since touched the refs.
	const failed: string[] = [];
	for (const remote of REMOTES) {
		say(`git push --no-verify ${remote} ${BRANCHES.join(' ')}`);
		const proc = Bun.spawnSync(['git', 'push', '--no-verify', remote, ...BRANCHES], {
			cwd: REPO_ROOT,
			env: CHILD_ENV,
			stdin: 'ignore',
			stdout: 'inherit',
			stderr: 'inherit',
		});
		if (proc.exitCode !== 0) failed.push(remote);
	}
	if (failed.length > 0) {
		fail(
			`push FAILED for: ${failed.join(', ')} (the others succeeded). Re-run once the cause is fixed — the green sha is remembered.`,
		);
	}
	say(`pushed ${BRANCHES.join(' + ')} @ ${sha.slice(0, 10)} to ${REMOTES.join(', ')}.`);
}

main();
