/**
 * Build provenance + release identity — read ONCE at module init.
 *
 * The committed `build_info.txt` holds the literal placeholder
 * `$Format:%H %cI %(describe:match=v[0-9]*,abbrev=40)$`; `.gitattributes` marks it
 * `export-subst`, so inside any `git archive` (a release zip, code_build.ts; an
 * image build context) git writes `<commit sha> <commit ISO date> <describe>`,
 * where `<describe>` is the exact `v*` tag of the commit (`v7.0.0-beta.6`), the
 * nearest tag plus distance (`v7.0.0-beta.5-889-g<full sha>`), or nothing.
 * `abbrev=40` because the archive's BYTES are provenance (the image pipeline
 * refuses a context whose sha256 differs from the plan's): git's default
 * abbreviation length depends on the clone's object count and `core.abbrev`,
 * so two clones of one commit would otherwise archive different bytes. The
 * describe also depends on the clone HAVING the tags — a shallow, tagless
 * clone archives an empty field (a dev identity); every archiving job fetches them.
 * That one file answers three questions:
 *  - DEDALO_BUILD: the commit date on an archive, null on a checkout — what the
 *    update_code widget shows as "Current build".
 *  - DEDALO_BUILD_SHA: WHICH commit (null on a checkout).
 *  - RELEASE_IDENTITY: what the program calls itself (release_identity.ts) —
 *    `7.0.0-beta.6` from an archive of that tag, `7.0.1-dev` off a tag.
 *
 * A CHECKOUT keeps the placeholder, so the tag is asked of git: one bounded
 * `git describe --exact-match` at import (see readCheckoutDescribe for why at
 * import and not as a boot step). An archive never spawns anything.
 *
 * Never throws at import — any unreadable/malformed file or failing git
 * degrades to the dev identity.
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { liveProcessEnv } from '../../config/env.ts';
import { readInstallStampOf } from './install_stamp.ts';
import {
	type BuildInfo,
	parseBuildInfo,
	type ReleaseIdentity,
	resolveReleaseIdentity,
} from './release_identity.ts';
import { DEDALO_NEXT_DEV_TRIPLE, DEDALO_VERSION_TRIPLE } from './version.ts';

// The stamp grammar is pure and lives with the resolver; re-exported here, where
// the file is read.
export { type BuildInfo, parseBuildInfo };

/** build_info.txt's path inside any Dédalo tree, relative to the tree root. */
export const BUILD_INFO_PATH = 'src/core/update/build_info.txt';

/** The stamp of the tree at `treeRoot` (DEV when absent or unreadable). */
export function readBuildInfoOf(treeRoot: string): BuildInfo {
	try {
		return parseBuildInfo(readFileSync(join(treeRoot, BUILD_INFO_PATH), 'utf8'));
	} catch {
		return parseBuildInfo('');
	}
}

/** How long the checkout reader waits for git before calling the tree a dev build. */
export const CHECKOUT_DESCRIBE_TIMEOUT_MS = 3000;

/**
 * The process environment WITHOUT `GIT_*` and in the C locale.
 * - `GIT_*`: `-C <root>` does not override an inherited GIT_DIR /
 *   GIT_WORK_TREE (a server started from a git hook, a supervisor that exports
 *   them), and git would then describe ANOTHER repository's HEAD and name this
 *   tree after its tag.
 * - `LC_ALL=C` (and no LANGUAGE): a translated git (Debian/Ubuntu ship the
 *   catalogs) says "no tag exactly matches" in the operator's language, and
 *   UNTAGGED_ANSWER_RE would read the normal untagged answer as a failure —
 *   a false `[release]` warning on every boot of an untagged checkout.
 */
function gitFreeEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(liveProcessEnv())) {
		if (!key.startsWith('GIT_') && key !== 'LANGUAGE') env[key] = value;
	}
	env.LC_ALL = 'C';
	return env;
}

/** git's own (C-locale) words for "this commit carries no matching tag" — the normal untagged answer. */
const UNTAGGED_ANSWER_RE = /no tag exactly matches|no names found|cannot describe/i;

/**
 * A pipe drained into text, with a way to stop waiting for it: a pipe stays
 * open while ANY holder of its write end lives (a grandchild that inherited it,
 * a git wedged in uninterruptible I/O), so "read to EOF" is not bounded by
 * killing the child — only by cancelling our own read.
 */
function drain(stream: ReadableStream<Uint8Array>): { text: Promise<string>; cancel(): void } {
	const reader = stream.getReader();
	const text = (async () => {
		const chunks: Uint8Array[] = [];
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
		}
		return Buffer.concat(chunks).toString('utf8');
	})();
	return {
		text,
		cancel: () => {
			reader.cancel().catch(() => {});
		},
	};
}

/**
 * The exact `v*` tag of a CHECKOUT's HEAD, asked of git (design §2.2 step 2).
 * `''` = git answered "no exact tag" (normal: an untagged commit). null +
 * notice = git could not answer (absent binary, timeout, an error that is not
 * the untagged answer) — the caller then says a dev identity, never throws.
 *
 * - `--exact-match`, not a plain describe: only a commit that IS a release
 *   may call itself one; distance is irrelevant to identity.
 * - `--match 'v[0-9]*'`: a newer non-release annotated tag on the same commit
 *   (`museum-snapshot`) would otherwise win and the release would call
 *   itself a dev build — the archive's `%(describe:match=…)` filters the same way.
 * - No `--tags`: lightweight tags are ignored, exactly as the archive's
 *   `%(describe)` ignores them, so a checkout and an archive of the same
 *   commit always agree (release tags are annotated — owner Q7).
 * - `safe.directory=<root>`: a tree owned by another uid (the image's checkout,
 *   a service user) would otherwise make git refuse; it names THIS tree only.
 * - `core.fsmonitor=false`: no repository-configured helper is started.
 * - git, not a reader of `.git/refs`: annotated tags live packed and peeled in
 *   `packed-refs`; a hand-rolled ref reader is a second, worse git.
 *
 * THE BOUND IS REAL: the whole read (both pipes AND the exit) races a timer of
 * its own. Bun's spawn `timeout` only signals the direct child, and awaiting
 * the pipes then waits for every process holding them — measured: a git
 * wrapper that leaves a grandchild behind held the read for 20 s past a 3 s
 * "timeout". When the timer wins, the child is SIGKILLed and our reads are
 * cancelled; nothing here waits for a process to die.
 *
 * WHY AT IMPORT, NOT A BOOT STEP: the identity is a process-lifetime,
 * request-independent constant that a dozen modules bind at their own import
 * (`DEDALO_ENGINE_VERSION`). A boot step would make it a module `let` that is
 * WRONG until the step runs (module_state_tripwire would rightly demand a
 * lifecycle justification for it) and every early reader would see the stale
 * value. One bounded spawn while the module graph loads costs milliseconds,
 * happens before the server accepts a request, and never on an archive. It is
 * awaited at the top level (an async spawn, not `spawnSync`): ESM holds every
 * importer until it settles, so no reader can see a half-made identity, and
 * no synchronous child process joins the served module graph
 * (sync_io_on_request_path_tripwire).
 */
export async function readCheckoutDescribe(
	treeRoot: string,
	git = 'git',
	timeoutMs = CHECKOUT_DESCRIBE_TIMEOUT_MS,
): Promise<{ describe: string | null; notice: string | null }> {
	let root: string;
	try {
		root = realpathSync(treeRoot);
	} catch {
		return { describe: null, notice: `the tree root ${treeRoot} cannot be resolved` };
	}
	let child: DescribeChild;
	try {
		child = spawnDescribe(git, root);
	} catch (error) {
		// spawn itself failed: no git binary, or not executable. The raw text goes
		// to the log only; the notice carries a deliberate sentence (SEC-18).
		console.warn('[release] git describe spawn failed:', error);
		return { describe: null, notice: describeFailure('git could not be started') };
	}
	const settled = await boundedRead(child, timeoutMs);
	if (settled === 'failed') {
		return { describe: null, notice: describeFailure("git's answer could not be read") };
	}
	if (settled === 'timeout') {
		return { describe: null, notice: describeFailure(`no answer within ${timeoutMs} ms`) };
	}
	return describeAnswer(child, settled);
}

type DescribeChild = ReturnType<typeof Bun.spawn<'ignore', 'pipe', 'pipe'>>;
type DescribeOutput = [stdout: string, stderr: string, status: number];

/** The one git invocation (flags: see readCheckoutDescribe). */
function spawnDescribe(git: string, root: string): DescribeChild {
	return Bun.spawn(
		[
			git,
			'-c',
			`safe.directory=${root}`,
			'-c',
			'core.fsmonitor=false',
			'-C',
			root,
			'describe',
			'--exact-match',
			'--match',
			'v[0-9]*',
			'HEAD',
		],
		{ env: gitFreeEnv(), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
	);
}

/**
 * Both pipes AND the exit, raced against our own timer. On a timeout the child
 * is SIGKILLed and our reads cancelled — nothing here waits for it to die.
 */
async function boundedRead(
	child: DescribeChild,
	timeoutMs: number,
): Promise<DescribeOutput | 'timeout' | 'failed'> {
	const out = drain(child.stdout);
	const err = drain(child.stderr);
	const finished = Promise.all([out.text, err.text, child.exited]);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timedOut = new Promise<'timeout'>((resolve) => {
		timer = setTimeout(() => resolve('timeout'), timeoutMs);
	});
	try {
		const settled = await Promise.race([finished, timedOut]);
		if (settled === 'timeout') {
			finished.catch(() => {}); // abandoned: never an unhandled rejection later
			child.kill('SIGKILL');
			out.cancel();
			err.cancel();
		}
		return settled;
	} catch (error) {
		console.warn('[release] git describe read failed:', error);
		return 'failed';
	} finally {
		clearTimeout(timer);
	}
}

/** git's finished answer: the tag, the normal untagged answer (`''`), or a failure notice. */
function describeAnswer(
	child: DescribeChild,
	[stdout, stderrText, status]: DescribeOutput,
): { describe: string | null; notice: string | null } {
	if (status === 0) return { describe: stdout.trim(), notice: null };
	const stderr = stderrText.trim();
	const killed = child.signalCode !== null;
	if (!killed && UNTAGGED_ANSWER_RE.test(stderr)) return { describe: '', notice: null };
	const why = killed ? `killed by ${child.signalCode}` : stderr.split('\n')[0] || `exit ${status}`;
	return { describe: null, notice: describeFailure(why) };
}

function describeFailure(why: string): string {
	return `git describe could not read this checkout's tag (${why}); calling it a dev build (-dev)`;
}

/**
 * The release identity of the tree at `treeRoot`, from THAT tree's own
 * evidence (build_info.txt, install_stamp.json, its `.git`): the module
 * constant below reads this tree; gates read throwaway ones. `triple` is the
 * running DATA version — the tree's own version.ts in production.
 * `nextDevTriple` names an untagged tree's dev identity; it defaults to
 * version.ts DEDALO_NEXT_DEV_TRIPLE so every caller resolves it the same way.
 */
export async function readReleaseIdentityOf(
	treeRoot: string,
	options: {
		triple: readonly [number, number, number];
		nextDevTriple?: readonly [number, number, number];
		git?: string;
	},
	info: BuildInfo = readBuildInfoOf(treeRoot),
): Promise<ReleaseIdentity> {
	const channel = readInstallStampOf(treeRoot)?.channel ?? null;
	const reader = await checkoutEvidence(treeRoot, info, options.git);
	const identity = resolveReleaseIdentity({
		triple: options.triple,
		nextDevTriple: options.nextDevTriple ?? DEDALO_NEXT_DEV_TRIPLE,
		describe: reader.describe,
		provenance: { stamp: info.legacy ? 'legacy' : 'other', channel },
	});
	return reader.notice === null || identity.notice !== null
		? identity
		: Object.freeze({ ...identity, notice: reader.notice });
}

/** The describe evidence: the stamp's own field, or — on a checkout — git's answer. */
async function checkoutEvidence(
	treeRoot: string,
	info: BuildInfo,
	git: string | undefined,
): Promise<{ describe: string | null; notice: string | null }> {
	// A checkout: the placeholder is unexpanded and git is there to ask.
	if (info.build === null && existsSync(join(treeRoot, '.git'))) {
		return readCheckoutDescribe(treeRoot, git);
	}
	return { describe: info.describe, notice: null };
}

// This file sits in src/core/update/, so the tree root is three up.
const TREE_ROOT = join(import.meta.dir, '..', '..', '..');

const INFO = readBuildInfoOf(TREE_ROOT);

/** Release build stamp (commit ISO date) — null on a checkout. */
export const DEDALO_BUILD: string | null = INFO.build;

/**
 * The COMMIT the running release was built from — null on a checkout.
 * The date alone answers "is new code live?"; the sha answers "WHICH code",
 * which is what an operator needs when comparing an install against a master's
 * HEAD (update_code's status panel shows both side by side).
 */
export const DEDALO_BUILD_SHA: string | null = INFO.sha;

/** What this running tree calls itself (release_identity.ts). */
export const RELEASE_IDENTITY: ReleaseIdentity = await readReleaseIdentityOf(
	TREE_ROOT,
	{ triple: DEDALO_VERSION_TRIPLE, nextDevTriple: DEDALO_NEXT_DEV_TRIPLE },
	INFO,
);

/** The code-version string the client displays — the release identity. */
export const DEDALO_ENGINE_VERSION: string = RELEASE_IDENTITY.version;
