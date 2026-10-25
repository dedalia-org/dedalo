/**
 * image_release.ts — the program behind .github/workflows/image-release.yml: the
 * official Dédalo image, built once, signed in every registry, published with ONE digest to every
 * provisioned registry of engineering/image_registries.json.
 *
 *   bun run scripts/ci/image_release.ts plan      which release this run publishes (or refuse)
 *   bun run scripts/ci/image_release.ts context   the build context: a `git archive` of the release commit
 *   bun run scripts/ci/image_release.ts smoke     the built bytes, run and asserted
 *   bun run scripts/ci/image_release.ts publish   index → immutability → sign → copy + sign per target → verify → record
 *
 * WHAT A RELEASE IS here is what it is for the code server (engineering/RELEASE.md):
 * a release tag whose own version.ts declares its data triple — the stable `vX.Y.Z`
 * (`<v>.zip` there, `:<v>` here) or, since 2026-10-18 (RELEASE_IDENTITY_DESIGN §2.8.4,
 * owner Q1: a prerelease tag IS a release), the prerelease `vX.Y.Z-(alpha|beta|rc).N`
 * (`<X.Y.Z-beta.N>.zip` there, `:<X.Y.Z-beta.N>` here, install-stamp channel
 * `prerelease`) — or the developer build of `master` (`<v>-dev.zip` there, `:<v>-dev`
 * here). The rules are code_build_plan.ts's (`releaseTagIdentity`, `parseDeclaredTriple`,
 * `DEV_REF`), imported, never restated.
 *
 * ONE TAG PER RUN, NEVER A FLOATING ONE. The image tag a run writes to a target registry
 * is `imageTagOf(identity)` (release_identity.ts — the function the installer's Official
 * probe asks with) and nothing else: no `latest`, no `X` / `X.Y`, and for a prerelease
 * never its triple `X.Y.Z` — after the stable release that tag is another image, and a
 * beta must never be what a stable consumer pulls. `publish` writes `<target>:<plan tag>`
 * only (publishTo); the staging repository gets run-scoped names only. Gate 16:
 * image_release_native ("the tag SET").
 *
 * A RELEASE NEEDS THE FULL GATE GREEN ON ITS COMMIT (2026-10-10). `plan` refuses a
 * release whose commit has no SUCCESSFUL `push` run of BOTH ci.yml (hermetic) and db.yml
 * (db + instance) — the full gate, as GitHub ran it — read through the Actions API
 * (`gh api`, the run's own read-only token, `actions: read`). The pre-push hook holds the
 * same rule at the desk (a release tag needs a FULL green); this is the half no
 * `--no-verify` reaches. An unreadable API refuses too: fail closed. The developer
 * channel is not held (a mutable `-dev` build of the master tip, like `<v>-dev.zip`).
 *
 * THE BUILD CONTEXT IS A GIT ARCHIVE of the release commit — the code server's own
 * mechanism — so `build_info.txt` is expanded exactly as in the release zip, and the
 * image reports the commit it was built from. The sha256 of that tar stream is the
 * install stamp's digest (the Dockerfile's provenance step).
 *
 * THE PUBLISH ORDER IS THE SAFETY ARGUMENT, and test/unit/image_release_native.test.ts
 * executes it with stub docker/cosign/git/curl and asserts the order of effects:
 *   1. cosign is the PINNED binary (ci/cosign.json) or nothing is published at all;
 *   2. targets: the provisioned registries; an unprovisioned one is skipped with its
 *      reason, a provisioned one whose secrets are missing is skipped LOUDLY;
 *   3. the multi-arch index is assembled ONCE, in the staging repository, from the
 *      per-arch DIGESTS the build legs smoke-tested (never a staging tag, which any
 *      workflow holding packages: write could move while publish waits for review) → D;
 *   4. IMMUTABILITY (release channel): a release already published anywhere is never
 *      rebuilt or overwritten — every holder must agree on one digest X (else refuse),
 *      X must carry a signature of THIS release — the EXACT identity
 *      `…/image-release.yml@refs/tags/v<tag>`, never just the shared regexp, which also
 *      accepts dev builds and other tags — SOMEWHERE OFFICIAL (a holder, or staging@X,
 *      where the workflow built it — else refuse), and X is what the missing targets
 *      receive; a holder of X whose registry lacks the signature is signed in place; a
 *      target tag that appeared since this check with another digest is never re-pointed;
 *   5. a fresh D (no holder) only from the release's OWN tag ref (GITHUB_REF =
 *      refs/tags/v<tag> — the identity step 4 demands of an anchor; a dispatch from
 *      master never mints a release), signed FIRST in staging (`cosign sign` keyless on
 *      staging@D; Rekor): the anchor a recovery run finds if this one dies after a copy;
 *   6. per target: carbon-copy the digest (`docker buildx imagetools create -t
 *      <target>:<tag> <source>@D`, one source → same digest), then `cosign sign` AT
 *      <target>@D — one signature per registry. NEVER `cosign copy`: cosign 3 signs in
 *      the OCI 1.1 referrers bundle format, which that deprecated verb does not carry
 *      (the first real run, v7.0.0-beta.7, published both mirrors unsigned through it);
 *   7. every target must now hold the SAME digest AND pass the exact `cosign verify`
 *      an operator runs;
 *   8. record: the job summary + image-release.json (uploaded as an artifact).
 * Nothing leaves staging before D is signed there; nothing is signed before step 4
 * passes; an unpinned or tampered cosign refuses before the first push.
 * Every verb has a deadline below its job's timeout-minutes and every command a ceiling
 * (VERB_BUDGET_MS / COMMAND_TIMEOUT_MS): a hung registry fails targets, the record is
 * still written.
 *
 * I/O: inputs come from the environment the workflow composes (static names, every
 * expression through `env:`); outputs go to $GITHUB_OUTPUT and $GITHUB_STEP_SUMMARY.
 * The only process boundary is ONE injectable command runner. Test seams:
 * IMAGE_REGISTRIES_FILE (another list), COSIGN_PIN_FILE (another pin),
 * IMAGE_RELEASE_COMMAND_TIMEOUT_MS (another per-command ceiling), IMAGE_RELEASE_DEADLINE_MS
 * (another verb budget).
 */

import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	DEV_REF,
	parseDeclaredTriple,
	qualifiedReleaseTag,
	releaseTagIdentity,
	VERSION_TS_PATH,
} from '../../src/core/update/code_build_plan.ts';
import {
	type ImageRegistry,
	type ImageRegistryList,
	loadImageRegistries,
	parseImageRegistries,
} from '../../src/core/update/image_registries.ts';
import { type InstallChannel, isInstallChannel } from '../../src/core/update/install_stamp.ts';
import {
	gitDescribeSupportFault,
	identityOfImageTag,
	imageTagOf,
	parseBuildInfo,
	parseReleaseVersion,
	type ReleaseKind,
	resolveReleaseIdentity,
} from '../../src/core/update/release_identity.ts';
import { cosignDownloadUrl, isPinSet, readCosignPin } from '../ci_cosign_pin.ts';
import { type ReleaseTagGit, releaseTagFault } from '../lib/release_tag.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..');

type Env = Readonly<Record<string, string | undefined>>;

// ─────────────────────────────────────────────────────────────────────────────
// The one process boundary
// ─────────────────────────────────────────────────────────────────────────────

export interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

export type Runner = (
	argv: readonly string[],
	options?: { stdin?: string; cwd?: string },
) => CommandResult;

/**
 * Time is bounded twice, so a registry, Fulcio or Rekor that accepts the connection and
 * never answers fails commands — never the job, which GitHub would kill at its
 * `timeout-minutes` before any record is written:
 *  - VERB_BUDGET_MS: the whole verb's deadline, kept BELOW the timeout-minutes of the job
 *    that runs it (VERB_JOBS; the gate reads the workflow and sums the budgets per job).
 *    Past it, no command starts (it answers `deadline exceeded`), the remaining publish
 *    targets are recorded `failed` (`deadline exceeded`), and the record is still written;
 *  - COMMAND_TIMEOUT_MS: one command's ceiling, never above its verb's budget; each command
 *    gets min(ceiling, time left before the deadline).
 * Seams: IMAGE_RELEASE_COMMAND_TIMEOUT_MS, IMAGE_RELEASE_DEADLINE_MS.
 */
export const VERB_BUDGET_MS: Readonly<Record<string, number>> = {
	plan: 8 * 60_000,
	context: 10 * 60_000,
	smoke: 30 * 60_000,
	publish: 25 * 60_000,
};
export const COMMAND_TIMEOUT_MS: Readonly<Record<string, number>> = {
	plan: 5 * 60_000,
	context: 10 * 60_000,
	smoke: 30 * 60_000,
	publish: 8 * 60_000,
};
/** The image-release.yml job each verb runs in (the deadline gate's map). */
export const VERB_JOBS: Readonly<Record<string, string>> = {
	plan: 'plan',
	context: 'build',
	smoke: 'build',
	publish: 'publish',
};
const DEFAULT_LIMIT_MS = 5 * 60_000;

function positiveInt(raw: string | undefined): number | null {
	const value = Number.parseInt(raw ?? '', 10);
	return Number.isFinite(value) && value > 0 ? value : null;
}

/** The ceiling one of a verb's commands runs under (ms). */
export function commandTimeoutMs(verb: string, env: Env): number {
	return (
		positiveInt(env.IMAGE_RELEASE_COMMAND_TIMEOUT_MS) ??
		COMMAND_TIMEOUT_MS[verb] ??
		DEFAULT_LIMIT_MS
	);
}

/** The whole verb's budget (ms): its deadline is the start plus this. */
export function verbBudgetMs(verb: string, env: Env): number {
	return positiveInt(env.IMAGE_RELEASE_DEADLINE_MS) ?? VERB_BUDGET_MS[verb] ?? DEFAULT_LIMIT_MS;
}

/**
 * The real runner. Passwords travel on stdin, never in argv, so the echo is safe. Each
 * command runs under min(`capMs`, time left before `deadline`) and is killed past it,
 * answering a non-zero result that names why; past the deadline nothing is started.
 */
export function spawnRunner(capMs: number, deadline: number): Runner {
	return (argv, options) => {
		const left = deadline - Date.now();
		if (left <= 0)
			return { code: 124, stdout: '', stderr: `${argv[0]}: not started — deadline exceeded` };
		const timeoutMs = Math.min(capMs, left);
		console.log(`$ ${argv.join(' ')}`);
		const result = Bun.spawnSync([...argv], {
			cwd: options?.cwd,
			stdin: options?.stdin === undefined ? 'ignore' : Buffer.from(options.stdin),
			stdout: 'pipe',
			stderr: 'pipe',
			timeout: timeoutMs,
			killSignal: 'SIGKILL',
		});
		const timedOut = result.exitedDueToTimeout === true;
		const stderr = `${result.stderr.toString()}${timedOut ? `\n${argv[0]}: timed out after ${timeoutMs} ms` : ''}`;
		if (stderr !== '') process.stderr.write(stderr);
		const code = timedOut ? 124 : (result.exitCode ?? 1);
		return { code, stdout: result.stdout.toString(), stderr };
	};
}

/** A refusal the operator must read: printed as a workflow error, the step fails. */
export class Refusal extends Error {}

function must(result: CommandResult, what: string): string {
	if (result.code !== 0)
		throw new Refusal(`${what} failed (exit ${result.code}): ${result.stderr.trim()}`);
	return result.stdout;
}

// ─────────────────────────────────────────────────────────────────────────────
// plan — which release this run publishes
// ─────────────────────────────────────────────────────────────────────────────

export interface PlanFacts {
	event: string;
	ref: string;
	sha: string;
	inputChannel: string;
	inputTag: string;
}

/**
 * What the plan needs from git, injectable so the rules are testable without a
 * repository. `fileAt` is the release-tag check's own lookup (release_tag.ts).
 */
export interface PlanGit extends ReleaseTagGit {
	/** The X.Y.Z a commit's version.ts declares, or null. */
	declaredAt(rev: string): string | null;
	/** The commit a ref names, or null when it does not exist. */
	commitOf(ref: string): string | null;
}

export interface ReleasePlan {
	/** The DATA triple X.Y.Z (version.ts) — for a prerelease too; the identity is in `tag`. */
	version: string;
	/**
	 * The ONE image tag the run writes: `imageTagOf(identity)` — X.Y.Z (release,
	 * immutable), X.Y.Z-(alpha|beta|rc).N (prerelease, immutable) or X.Y.Z-dev
	 * (developer, mutable).
	 */
	tag: string;
	/**
	 * The install-stamp channel the image carries (the Dockerfile's provenance step,
	 * install_stamp.ts InstallChannel): master (stable), prerelease, or dev.
	 */
	channel: InstallChannel;
	source_sha: string;
	staging: string;
	/**
	 * What the image's own DEDALO_ENGINE_VERSION must say — the release identity
	 * its archive resolves to (archiveIdentityPlan): X.Y.Z for a release; for a
	 * developer build X.Y.Z.dev, or the tag when the commit is exactly tagged (Q5).
	 */
	expected_engine_version: string;
}

const DEV_BRANCH_REF = `refs/heads/${DEV_REF}`;

/**
 * A release tag (stable or prerelease, the shared grammar) → its plan, or the refusal.
 * The code server's rules, imported. The workflow's trigger globs are wider than the
 * grammar (`v7.0.0-beta.01` matches them): THIS is the exact check.
 */
function releasePlanFor(tagRef: string, git: PlanGit, staging: string): ReleasePlan {
	const identity = releaseTagIdentity(tagRef);
	const parsed = identity === null ? null : parseReleaseVersion(identity);
	if (identity === null || parsed === null)
		throw new Refusal(
			`'${tagRef}' is not a release tag v<X.Y.Z>[-(alpha|beta|rc).N] (canonical numbers)`,
		);
	const commit = git.commitOf(qualifiedReleaseTag(identity));
	if (commit === null)
		throw new Refusal(`release tag v${identity} does not exist in this repository`);
	// THE release-tag check (gate 11) — the pre-push hook runs the same function, for
	// stable and prerelease tags alike: version.ts at the tag's commit declares its
	// triple, and the changelog was cut for this identity.
	const fault = releaseTagFault(`v${identity}`, commit, git);
	if (fault !== null) throw new Refusal(fault);
	return {
		version: parsed.triple.join('.'),
		tag: imageTagOf(identity),
		channel: parsed.prerelease === null ? 'master' : 'prerelease',
		source_sha: commit,
		staging,
		expected_engine_version: identity,
	};
}

/** A developer build: dispatched on the dev branch, tagged after the version it declares. */
function devPlanFor(facts: PlanFacts, git: PlanGit, staging: string): ReleasePlan {
	if (facts.ref !== DEV_BRANCH_REF)
		throw new Refusal(
			`a developer image is built only from ${DEV_BRANCH_REF} (this run is on ${facts.ref})`,
		);
	const declared = git.declaredAt(facts.sha);
	if (declared === null)
		throw new Refusal(`${facts.sha} declares no version in ${VERSION_TS_PATH}`);
	return {
		version: declared,
		tag: `${declared}-dev`,
		channel: 'dev',
		source_sha: facts.sha,
		staging,
		expected_engine_version: `${declared}.dev`,
	};
}

/**
 * A release dispatch publishes an EXISTING tag. It runs from the dev branch (which may only
 * fill or sign a release already anchored — publish's fresh-path rule) or from THAT SAME
 * tag (whose signature is this release's own identity) — never from another release tag,
 * whose identity would sign this release as that one.
 */
function dispatchedReleasePlan(facts: PlanFacts, git: PlanGit, staging: string): ReleasePlan {
	const wanted = releaseTagIdentity(facts.inputTag);
	const sameTag = wanted !== null && releaseTagIdentity(facts.ref) === wanted;
	if (facts.ref !== DEV_BRANCH_REF && !sameTag)
		throw new Refusal(
			`a release dispatch of ${facts.inputTag} runs from ${DEV_BRANCH_REF} or from that same tag (this run is on ${facts.ref})`,
		);
	return releasePlanFor(facts.inputTag, git, staging);
}

/** The plan of this run, or a Refusal. Pure over its facts and the git lookups. */
export function resolvePlan(facts: PlanFacts, git: PlanGit, staging: string): ReleasePlan {
	if (facts.event === 'push') return releasePlanFor(facts.ref, git, staging);
	if (facts.event !== 'workflow_dispatch')
		throw new Refusal(`a '${facts.event}' event never publishes an image`);
	if (facts.inputChannel === 'dev') return devPlanFor(facts, git, staging);
	if (facts.inputChannel === 'release') return dispatchedReleasePlan(facts, git, staging);
	throw new Refusal(`channel must be dev or release (got '${facts.inputChannel}')`);
}

/** The workflows whose green push runs ARE the full gate on GitHub: hermetic; db + instance. */
export const FULL_GATE_WORKFLOWS = ['ci.yml', 'db.yml'] as const;

/**
 * The refusal for a release commit whose full gate is not green, or null. `greens` maps each
 * workflow to its count of SUCCESSFUL push runs at the commit — null when it could not be read.
 * Pure.
 */
export function fullGateFault(
	sha: string,
	greens: ReadonlyMap<string, number | null>,
): string | null {
	const missing: string[] = [];
	for (const workflow of FULL_GATE_WORKFLOWS) {
		const count = greens.get(workflow);
		if (count === null || count === undefined) missing.push(`${workflow} (runs unreadable)`);
		else if (count < 1) missing.push(`${workflow} (no successful push run)`);
	}
	if (missing.length === 0) return null;
	return `release commit ${sha} has no green FULL gate: ${missing.join(', ')} — push the commit to master (or v7) on GitHub and let ci.yml + db.yml pass, then re-run (a release is cut only from a commit the full gate passed)`;
}

/** Successful `push` runs of each FULL_GATE_WORKFLOWS workflow at `sha`, via `gh api`. */
export function fullGateGreens(env: Env, run: Runner, sha: string): Map<string, number | null> {
	const repo = env.GITHUB_REPOSITORY ?? '';
	const greens = new Map<string, number | null>();
	for (const workflow of FULL_GATE_WORKFLOWS) {
		if (repo === '') {
			greens.set(workflow, null);
			continue;
		}
		const result = run([
			'gh',
			'api',
			'-X',
			'GET',
			`repos/${repo}/actions/workflows/${workflow}/runs`,
			'-f',
			`head_sha=${sha}`,
			'-f',
			'event=push',
			'-f',
			'status=success',
			'--jq',
			'.total_count',
		]);
		const count = Number.parseInt(result.stdout.trim(), 10);
		greens.set(workflow, result.code === 0 && Number.isFinite(count) ? count : null);
	}
	return greens;
}

/** The real git lookups, in the checkout this program runs from. */
export function gitLookups(run: Runner, cwd: string): PlanGit {
	const fileAt = (rev: string, path: string): string | null => {
		const shown = run(['git', 'show', `${rev}:${path}`], { cwd });
		return shown.code === 0 ? shown.stdout : null;
	};
	return {
		fileAt,
		declaredAt: (rev) => {
			const source = fileAt(rev, VERSION_TS_PATH);
			return source === null ? null : parseDeclaredTriple(source);
		},
		commitOf: (ref) => {
			const parsed = run(['git', 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd });
			return parsed.code === 0 ? parsed.stdout.trim() : null;
		},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// context — the git archive the image is built from
// ─────────────────────────────────────────────────────────────────────────────

export function sha256File(path: string): string {
	return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** build_info.txt's path inside the archive (build_stamp.ts BUILD_INFO_PATH). */
const BUILD_INFO_IN_ARCHIVE = 'src/core/update/build_info.txt';

/**
 * The plan, held against what its ARCHIVE will call itself. The image's engine
 * reads its release identity from the archive's expanded build_info.txt
 * (release_identity.ts), so that — not the plan's arithmetic — is what the smoke
 * step will find. Resolved here exactly as the engine resolves it, with the
 * install channel the image is stamped with:
 *  - a release whose archive does not call itself the tag is REFUSED before any
 *    build: a lightweight tag (describe ignores it) or a clone without the tags
 *    would ship an image that says `.dev`;
 *  - a developer build expects whatever its archive says: `X.Y.Z.dev`, or the
 *    tag when the dev branch's head IS a release commit (owner Q5).
 * `stamp` is the archived build_info.txt, '' when the archive has none.
 */
export function archiveIdentityPlan(plan: ReleasePlan, stamp: string): ReleasePlan {
	const declared = parseReleaseVersion(plan.version);
	if (declared === null || declared.prerelease !== null || declared.dev)
		throw new Refusal(`the plan's version '${plan.version}' is not a data triple`);
	const info = parseBuildInfo(stamp);
	const identity = resolveReleaseIdentity({
		triple: declared.triple,
		describe: info.describe,
		provenance: { stamp: info.legacy ? 'legacy' : 'other', channel: plan.channel },
	});
	if (plan.channel !== 'dev') {
		if (identity.version !== plan.expected_engine_version)
			throw new Refusal(
				`the archive of ${plan.source_sha} calls itself ${identity.version}, not ${plan.expected_engine_version}: ` +
					`a release tag must be ANNOTATED (git tag -a — the archive's %(describe) ignores lightweight tags) ` +
					`and the archiving clone must hold the tags${identity.notice === null ? '' : ` (${identity.notice})`}`,
			);
		return plan;
	}
	return { ...plan, expected_engine_version: identity.version };
}

/** The archived build_info.txt of `tarPath`, '' when the archive has none. */
function archivedStamp(run: Runner, tarPath: string): string {
	const shown = run(['tar', '-xOf', tarPath, BUILD_INFO_IN_ARCHIVE]);
	return shown.code === 0 ? shown.stdout : '';
}

/**
 * `git archive --format=tar <sha>` into `tarPath`; returns the stream's sha256.
 * Refused on a git too old to expand build_info.txt's `%(describe:…)` (release_identity.ts
 * MIN_GIT_FOR_DESCRIBE): its archive would carry no tag, and the image would call itself `.dev`.
 */
export function archiveTree(run: Runner, cwd: string, sha: string, tarPath: string): string {
	const tooOld = gitDescribeSupportFault(must(run(['git', '--version'], { cwd }), 'git --version'));
	if (tooOld !== null) throw new Refusal(`refusing to archive ${sha}: ${tooOld}`);
	must(run(['git', 'archive', '--format=tar', '-o', tarPath, sha], { cwd }), `git archive ${sha}`);
	return sha256File(tarPath);
}

// ─────────────────────────────────────────────────────────────────────────────
// smoke — the exact bytes, run and asserted
// ─────────────────────────────────────────────────────────────────────────────

/** The refusal helper every smoke fragment shares (POSIX sh). */
const SMOKE_FAIL = `fail() { echo "smoke: FAIL $*" >&2; exit 1; }
`;

/**
 * GATE 10 — the identity the image SERVES (RELEASE_IDENTITY_DESIGN §3): boot the
 * image's own server, in its own tree (the current directory), and read `/health`
 * the way every consumer reads it — the update panel's post-restart poll, the
 * installer, an operator's curl. `version` must be WANT_VERSION (the identity of
 * the tag/ref the run was planned for: the tag's `X.Y.Z` for a release; for a
 * developer build its archive's identity, the tag when the commit is exactly
 * tagged, else `X.Y.Z.dev`) and `release_kind` WANT_KIND. A module import would
 * prove what a constant says; this proves what the listener answers.
 *
 * How it boots with no database and no installation: DEDALO_SMOKE_BOOT (the code
 * updater's pre-swap check — no migrations, schedulers or writers), a throwaway
 * private dir holding a sealed ts_state.json, the four required config keys plus
 * the language keys, a unix socket in that dir, and `env -i` so nothing of the
 * runner's (or a test's) environment leaks in. The DB host is a path that does
 * not exist: /health then answers 503 `db: down` — and STILL carries the
 * identity, which is the point (a poisoned process answers without `version`,
 * and is refused). Bun itself is the HTTP client: the image has no promise of curl.
 */
const SMOKE_HEALTH_ASSERTION = `P="$(mktemp -d)"
printf '{"install_status":"sealed"}\n' >"$P/ts_state.json"
env -i PATH="$PATH" HOME="$P" DEDALO_SMOKE_BOOT=true SERVER_UNIX_SOCKET="$P/health.sock" SERVER_TCP_PORT= \
  DEDALO_PRIVATE_DIR="$P" DEDALO_SESSION_DB_PATH="$P/sessions.sqlite" DEDALO_TS_STATE_PATH="$P/ts_state.json" \
  ENTITY=smoke DB_NAME=smoke DB_USER=smoke DB_HOST="$P/no-database" \
  DEDALO_APPLICATION_LANGS='{"lg-eng":"English"}' DEDALO_APPLICATION_LANGS_DEFAULT=lg-eng \
  DEDALO_DATA_LANG_DEFAULT=lg-eng PROJECTS_DEFAULT_LANGS='["lg-eng"]' \
  bun run src/server.ts >"$P/server.log" 2>&1 &
server=$!
served="$(bun -e '
const socket = process.argv[1];
for (const deadline = Date.now() + 60000; Date.now() < deadline; await Bun.sleep(250)) {
  try {
    const body = await (await fetch("http://localhost/health", { unix: socket, signal: AbortSignal.timeout(5000) })).json();
    console.log(\`\${body.version ?? "<none>"} \${body.release_kind ?? "<none>"}\`);
    process.exit(0);
  } catch {}
}
process.exit(1);
' "$P/health.sock")" || { kill "$server" 2>/dev/null; tail -n 30 "$P/server.log" >&2; fail "the image's server never answered /health"; }
kill -TERM "$server" 2>/dev/null || :
wait "$server" || :
[ "$served" = "$WANT_VERSION $WANT_KIND" ] || { tail -n 30 "$P/server.log" >&2; fail "/health serves '$served', expected '$WANT_VERSION $WANT_KIND'"; }
rm -rf "\${P:?}"
`;

/** The /health identity check alone, runnable from any Dédalo tree (the gate runs it on the checkout). */
export const SMOKE_HEALTH_SCRIPT = SMOKE_FAIL + SMOKE_HEALTH_ASSERTION;

/**
 * The in-container assertions (POSIX sh, run as the image's own user). `SMOKE_ROOT`
 * prefixes the filesystem paths so the gate can execute this text against a scratch
 * tree; in the image it is empty.
 */
export const SMOKE_SCRIPT = `R="\${SMOKE_ROOT:-}"
${SMOKE_FAIL}[ "$(bun --version)" = "$WANT_BUN" ] || fail "bun $(bun --version) is not .bun-version $WANT_BUN"
[ -f "$R/etc/dedalo/image_tree" ] || fail "no image-channel marker /etc/dedalo/image_tree"
pg_dump --version | grep -q "PostgreSQL) 18\\." || fail "pg_dump is not PostgreSQL 18"
for b in ffmpeg ffprobe magick pdftoppm pdfinfo pdftotext gs rsvg-convert ocrmypdf git rsync unzip; do
  command -v "$b" >/dev/null || fail "missing media/ops tool: $b"
done
[ "$(id -u)" = 1000 ] || fail "the image runs as uid $(id -u), not bun (1000)"
[ "$(stat -c %u "$R/srv/dedalo/client")" = 1000 ] || fail "/srv/dedalo/client is not owned by bun"
[ ! -e "$R/opt/dedalo/master_dedalo/deploy" ] || fail "deploy/ is inside the image"
cd "$R/opt/dedalo/master_dedalo"
got="$(bun -e 'const s = await import("./src/core/update/install_stamp.ts"); console.log([s.INSTALLED_CHANNEL, s.INSTALLED_DIGEST].join(" "))')"
[ "$got" = "$WANT_CHANNEL $WANT_DIGEST" ] || fail "the install stamp says '$got', expected '$WANT_CHANNEL $WANT_DIGEST'"
${SMOKE_HEALTH_ASSERTION}echo "smoke: ok"
`;

/** The `release_kind` /health must serve for an expected identity; a non-identity is refused. */
export function expectedReleaseKind(identity: string): ReleaseKind {
	const parsed = parseReleaseVersion(identity);
	if (parsed === null)
		throw new Refusal(`EXPECTED_ENGINE_VERSION '${identity}' is not a release identity`);
	if (parsed.dev) return 'dev';
	return parsed.prerelease === null ? 'stable' : 'prerelease';
}

function requireEnv(env: Env, keys: readonly string[]): Record<string, string> {
	const missing = keys.filter((key) => (env[key] ?? '') === '');
	if (missing.length > 0) throw new Refusal(`missing input: ${missing.join(', ')}`);
	return Object.fromEntries(keys.map((key) => [key, env[key] as string]));
}

/** The architectures the release builds; each smoke leg hands its digest on under its own name. */
export const RELEASE_ARCHES = ['amd64', 'arm64'] as const;

/** `<repo>@sha256:<hex>` → the digest; null for any reference a push could move (a tag). */
function pinnedDigestOf(image: string): string | null {
	const digest = image.slice(image.lastIndexOf('@') + 1);
	return image.includes('@') && DIGEST_RE.test(digest) ? digest : null;
}

/**
 * The smoke-tested reference, by digest only, and the output name it is handed on
 * under (`digest_<arch>`): what `publish` assembles is exactly what this leg ran.
 */
function smokeTarget(input: Record<string, string>): { digest: string; output: string } {
	const digest = pinnedDigestOf(input.IMAGE as string);
	if (digest === null)
		throw new Refusal(
			`IMAGE ${input.IMAGE} is not pinned by digest — a tag can move after the smoke`,
		);
	if (!(RELEASE_ARCHES as readonly string[]).includes(input.ARCH as string))
		throw new Refusal(`ARCH must be one of ${RELEASE_ARCHES.join(', ')} (got ${input.ARCH})`);
	return { digest, output: `digest_${input.ARCH}` };
}

function smoke(env: Env, run: Runner): number {
	const input = requireEnv(env, [
		'IMAGE',
		'ARCH',
		'EXPECTED_ENGINE_VERSION',
		'CHANNEL',
		'ARCHIVE_SHA256',
	]);
	const target = smokeTarget(input);
	const wantBun = readFileSync(join(REPO_ROOT, '.bun-version'), 'utf8').trim();
	must(run(['docker', 'pull', input.IMAGE as string]), `docker pull ${input.IMAGE}`);
	const vars = {
		WANT_BUN: wantBun,
		WANT_VERSION: input.EXPECTED_ENGINE_VERSION,
		WANT_KIND: expectedReleaseKind(input.EXPECTED_ENGINE_VERSION as string),
		WANT_CHANNEL: input.CHANNEL,
		WANT_DIGEST: input.ARCHIVE_SHA256,
	};
	const flags = Object.entries(vars).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
	must(
		run(['docker', 'run', '--rm', ...flags, input.IMAGE as string, 'sh', '-euc', SMOKE_SCRIPT]),
		'the smoke test of the built image',
	);
	console.log(`smoke: ${input.IMAGE} is the image this release claims to be`);
	// Only now, after every assertion passed, is the digest handed on to publish.
	writeOutputs(env, { [target.output]: target.digest });
	return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// publish — targets, immutability, sign, copy + sign per target, verify, record
// ─────────────────────────────────────────────────────────────────────────────

export interface RegistryLogin {
	host: string;
	username: string;
	password: string;
}

export type TargetVerdict =
	| { entry: ImageRegistry; publish: true; repository: string; login: RegistryLogin }
	| { entry: ImageRegistry; publish: false; reason: string; loud: boolean };

/** The registry host docker logs in to (`docker.io` for an implicit Docker Hub reference). */
export function registryHost(repository: string): string {
	const first = repository.split('/')[0] ?? '';
	const explicit = repository.includes('/') && (/[.:]/.test(first) || first === 'localhost');
	return explicit ? first : 'docker.io';
}

function secretTarget(entry: ImageRegistry, env: Env): TargetVerdict {
	const auth = entry.auth as { username_secret: string; password_secret: string };
	const missing = [auth.username_secret, auth.password_secret].filter(
		(name) => (env[name] ?? '') === '',
	);
	if (missing.length > 0)
		return { entry, publish: false, reason: `missing_secret: ${missing.join(', ')}`, loud: true };
	const repository = entry.repository as string;
	const login = {
		host: registryHost(repository),
		username: env[auth.username_secret] as string,
		password: env[auth.password_secret] as string,
	};
	return { entry, publish: true, repository, login };
}

function tokenTarget(entry: ImageRegistry, env: Env): TargetVerdict {
	if ((env.GHCR_TOKEN ?? '') === '' || (env.GHCR_ACTOR ?? '') === '')
		return { entry, publish: false, reason: 'missing_secret: GHCR_TOKEN, GHCR_ACTOR', loud: true };
	const repository = entry.repository as string;
	const login = {
		host: registryHost(repository),
		username: env.GHCR_ACTOR as string,
		password: env.GHCR_TOKEN as string,
	};
	return { entry, publish: true, repository, login };
}

/** One verdict per registry of the list, primary first, then the mirrors in list order. */
export function classifyTargets(list: ImageRegistryList, env: Env): TargetVerdict[] {
	const ordered = [
		...list.registries.filter((entry) => entry.role === 'primary'),
		...list.registries.filter((entry) => entry.role !== 'primary'),
	];
	return ordered.map((entry) => {
		if (!entry.provisioned)
			return {
				entry,
				publish: false,
				reason: `not_provisioned: ${entry.reason ?? ''}`,
				loud: false,
			};
		return entry.auth.kind === 'secret' ? secretTarget(entry, env) : tokenTarget(entry, env);
	});
}

export type ManifestState =
	| { state: 'present'; digest: string }
	| { state: 'absent' }
	| { state: 'error'; detail: string };

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/** The digest a reference resolves to — absent and unreadable are DIFFERENT answers. */
export function inspectDigest(run: Runner, ref: string): ManifestState {
	const result = run([
		'docker',
		'buildx',
		'imagetools',
		'inspect',
		ref,
		'--format',
		'{{json .Manifest}}',
	]);
	if (result.code !== 0)
		return /not found|manifest unknown|name unknown/i.test(result.stderr)
			? { state: 'absent' }
			: { state: 'error', detail: result.stderr.trim() };
	let digest: unknown;
	try {
		digest = (JSON.parse(result.stdout) as { digest?: unknown }).digest;
	} catch {
		digest = undefined;
	}
	return typeof digest === 'string' && DIGEST_RE.test(digest)
		? { state: 'present', digest }
		: { state: 'error', detail: `no digest in the manifest of ${ref}` };
}

export type Immutability =
	| { kind: 'fresh'; overwrite: boolean }
	| { kind: 'existing'; digest: string; holder: string };

/**
 * Step 4, pure. Dev tags are mutable by definition. A release tag (stable or
 * prerelease — both immutable) held anywhere IS the
 * release: every holder must agree on one digest, which the missing targets then
 * receive; disagreement or an unreadable target refuses before anything is signed.
 */
export function immutabilityVerdict(
	channel: InstallChannel,
	existing: readonly { repository: string; state: ManifestState }[],
): Immutability {
	if (channel === 'dev') return { kind: 'fresh', overwrite: true };
	const unreadable = existing.find((item) => item.state.state === 'error');
	if (unreadable !== undefined)
		throw new Refusal(
			`cannot read ${unreadable.repository}: ${(unreadable.state as { detail: string }).detail}`,
		);
	const holders = existing.filter((item) => item.state.state === 'present');
	const digests = new Set(holders.map((item) => (item.state as { digest: string }).digest));
	if (digests.size > 1)
		throw new Refusal(
			`the release is published INCONSISTENTLY: ${holders.map((item) => `${item.repository}=${(item.state as { digest: string }).digest}`).join(', ')} — fix by hand; nothing was changed`,
		);
	const first = holders[0];
	if (first === undefined) return { kind: 'fresh', overwrite: false };
	return {
		kind: 'existing',
		digest: (first.state as { digest: string }).digest,
		holder: first.repository,
	};
}

export interface RegistryRecord {
	id: string;
	repository: string | null;
	status: 'pushed' | 'signed' | 'unchanged' | 'skipped' | 'failed';
	reason: string | null;
	verified: boolean;
}

export interface ReleaseRecord {
	schema: 1;
	version: string;
	tag: string;
	channel: InstallChannel;
	source_sha: string;
	archive_sha256: string;
	digest: string;
	registries: RegistryRecord[];
}

interface PublishContext {
	env: Env;
	run: Runner;
	/** Epoch ms past which no target is attempted (verbBudgetMs). */
	deadline: number;
	list: ImageRegistryList;
	plan: ReleasePlan & { archive_sha256: string; run_id: string };
	cosign: string;
}

/** Step 1: the pinned cosign, downloaded and checked, or the refusal — before any push. */
export function installCosign(env: Env, run: Runner): string {
	const pin = readCosignPin(env.COSIGN_PIN_FILE || undefined);
	if (!isPinSet(pin))
		throw new Refusal(
			'cosign is not pinned (ci/cosign.json) — unsigned images are never published. Run: bun run ci:cosign:pin',
		);
	const dir = join(requireEnv(env, ['RUNNER_TEMP']).RUNNER_TEMP as string, 'cosign-bin');
	mkdirSync(dir, { recursive: true });
	const binary = join(dir, 'cosign');
	must(
		run(['curl', '-fsSL', '--retry', '3', '-o', binary, cosignDownloadUrl(pin.version)]),
		'the cosign download',
	);
	const actual = sha256File(binary);
	if (actual !== pin.linux_amd64_sha256)
		throw new Refusal(
			`the downloaded cosign v${pin.version} has sha256 ${actual}, the pin says ${pin.linux_amd64_sha256} — refusing to sign with it`,
		);
	chmodSync(binary, 0o755);
	return binary;
}

function login(run: Runner, credentials: RegistryLogin): void {
	must(
		run(
			['docker', 'login', credentials.host, '--username', credentials.username, '--password-stdin'],
			{ stdin: credentials.password },
		),
		`docker login ${credentials.host}`,
	);
}

/** The staging repository is on GHCR and is reached with the run's own token. */
function stagingLogin(ctx: PublishContext): RegistryLogin {
	const { GHCR_ACTOR: username, GHCR_TOKEN: password } = requireEnv(ctx.env, [
		'GHCR_ACTOR',
		'GHCR_TOKEN',
	]);
	return {
		host: registryHost(ctx.plan.staging),
		username: username as string,
		password: password as string,
	};
}

/** Log in once per host: the staging host (GHCR) and every target's. */
function loginAll(ctx: PublishContext, targets: readonly TargetVerdict[]): void {
	const staging = stagingLogin(ctx);
	const byHost = new Map<string, RegistryLogin>([[staging.host, staging]]);
	for (const target of targets) if (target.publish) byHost.set(target.login.host, target.login);
	for (const credentials of byHost.values()) login(ctx.run, credentials);
}

/**
 * The per-arch digests the build legs smoke-tested (DIGEST_AMD64 / DIGEST_ARM64, the
 * build job's outputs). Never the staging TAGS: a tag in the staging repository can be
 * moved by any workflow holding packages: write while this job waits for its reviewer.
 */
export function smokedDigests(env: Env): string[] {
	return RELEASE_ARCHES.map((arch) => {
		const key = `DIGEST_${arch.toUpperCase()}`;
		const digest = env[key] ?? '';
		if (!DIGEST_RE.test(digest))
			throw new Refusal(
				`${key} is not a sha256 digest (got '${digest}') — publish assembles only what the build legs smoke-tested`,
			);
		return digest;
	});
}

/** Step 3: the multi-arch index, assembled once in staging from the smoke-tested digests → D. */
function assembleIndex(ctx: PublishContext): string {
	const { staging, tag, run_id: runId } = ctx.plan;
	const index = `${staging}:${tag}-run-${runId}`;
	const sources = smokedDigests(ctx.env).map((digest) => `${staging}@${digest}`);
	must(
		ctx.run(['docker', 'buildx', 'imagetools', 'create', '-t', index, ...sources]),
		'assembling the multi-arch index',
	);
	const built = inspectDigest(ctx.run, index);
	if (built.state !== 'present')
		throw new Refusal(`the assembled index ${index} has no readable digest`);
	return built.digest;
}

/** The operator's verify: the list's shared identity regexp (every release tag + master). */
function cosignVerify(ctx: PublishContext, ref: string): boolean {
	return verifyWith(ctx, ref, ['--certificate-identity-regexp', ctx.list.signing.identity_regexp]);
}

function verifyWith(ctx: PublishContext, ref: string, identity: readonly string[]): boolean {
	const issuer = ['--certificate-oidc-issuer', ctx.list.signing.issuer];
	return ctx.run([ctx.cosign, 'verify', ref, ...identity, ...issuer]).code === 0;
}

/**
 * The EXACT identity a signature of THIS release carries: the workflow at
 * `refs/tags/v<tag>` of this repository — and it must lie inside the list's shared
 * identity (a fork's repository never does). The recovery anchor is held to it: the
 * shared regexp also accepts a dev build (`heads/master`) and every OTHER release tag,
 * and neither may be minted into this release.
 */
export function releaseSignerIdentity(env: Env, list: ImageRegistryList, tag: string): string {
	const server = env.GITHUB_SERVER_URL || 'https://github.com';
	const repository = requireEnv(env, ['GITHUB_REPOSITORY']).GITHUB_REPOSITORY as string;
	const identity = `${server}/${repository}/.github/workflows/image-release.yml@refs/tags/v${tag}`;
	if (!new RegExp(list.signing.identity_regexp).test(identity))
		throw new Refusal(
			`the release identity ${identity} is not inside the list's signing identity — refusing to anchor on it`,
		);
	return identity;
}

/** A signature of `ref` by exactly this release's identity. */
function verifiedAsThisRelease(ctx: PublishContext, ref: string): boolean {
	const identity = releaseSignerIdentity(ctx.env, ctx.list, ctx.plan.tag);
	return verifyWith(ctx, ref, ['--certificate-identity', identity]);
}

/**
 * What is published: the digest, a reference to copy it FROM (one that carries the
 * official signature), and the targets that already hold it — each with whether its own
 * registry already carries the signature (a holder that does not is signed in place).
 */
interface PublishSource {
	source: string;
	digest: string;
	holders: ReadonlyMap<string, { signed: boolean }>;
}

/** Steps 4+5: a freshly signed D, or the release that already exists (immutability). */
function chooseSource(
	ctx: PublishContext,
	targets: readonly PublishTarget[],
	built: string,
): PublishSource {
	const existing = targets.map((target) => ({
		repository: target.repository,
		state: inspectDigest(ctx.run, `${target.repository}:${ctx.plan.tag}`),
	}));
	const verdict = immutabilityVerdict(ctx.plan.channel, existing);
	if (verdict.kind === 'existing') return existingRelease(ctx, existing, verdict.digest);
	const refFault = freshReleaseRefFault(ctx);
	if (refFault !== null) throw new Refusal(refFault);
	// The ANCHOR signature, before anything leaves staging: a run that dies after a copy
	// leaves a digest whose official signature is provably somewhere (recovery, below).
	const source = `${ctx.plan.staging}@${built}`;
	must(ctx.run([ctx.cosign, 'sign', '--yes', source]), 'signing the image in staging');
	return { source, digest: built, holders: new Map() };
}

/**
 * The anchor's WRITER must be what its reader accepts: a never-published release (no
 * holder) is signed only by its OWN tag's run — the identity officialAnchor demands
 * (`refs/tags/v<tag>`). A dispatch from master (or any other ref) may only fill or sign
 * an EXISTING anchored release; minting one would leave signatures no later run can
 * anchor on. Dev tags are mutable and anchor nothing. Null = may publish fresh.
 */
function freshReleaseRefFault(ctx: PublishContext): string | null {
	if (ctx.plan.channel === 'dev') return null;
	const own = `refs/tags/v${ctx.plan.tag}`;
	const ref = ctx.env.GITHUB_REF ?? '';
	if (ref === own) return null;
	return `release ${ctx.plan.tag} is published nowhere yet, and this run is on ${ref || '<no GITHUB_REF>'}: a never-published release is published only from its own tag (${own} — the tag push, or a release dispatch run on that tag); a dispatch from another ref only fills or signs an existing release`;
}

/**
 * Step 4, an existing release X. Accepted ONLY when X carries the official signature
 * somewhere official — at a holder, or at the staging repository the workflow built it
 * in (staging@X) — and that verified reference is the copy source. A holder whose own
 * registry lacks the signature is then signed in place: that attests only what the
 * workflow provably built. X verifiable nowhere → refuse, nothing is changed.
 */
function existingRelease(
	ctx: PublishContext,
	existing: readonly { repository: string; state: ManifestState }[],
	digest: string,
): PublishSource {
	const holders = new Map<string, { signed: boolean }>();
	for (const item of existing)
		if (item.state.state === 'present')
			holders.set(item.repository, { signed: cosignVerify(ctx, `${item.repository}@${digest}`) });
	const anchor = officialAnchor(ctx, [...holders.keys()], digest);
	return { source: anchor, digest, holders };
}

/**
 * The reference that proves `digest` IS this release: a holder, else staging@digest,
 * signed by exactly this release's identity (`refs/tags/v<tag>`). A signature under the
 * shared regexp alone — a dev build, another release tag, a recovery run's own
 * `heads/master` signature — never anchors.
 */
function officialAnchor(ctx: PublishContext, holders: readonly string[], digest: string): string {
	const candidates = [...holders, ctx.plan.staging].map((repository) => `${repository}@${digest}`);
	const anchor = candidates.find((ref) => verifiedAsThisRelease(ctx, ref));
	if (anchor !== undefined) return anchor;
	throw new Refusal(
		`release ${ctx.plan.tag} already exists as ${digest}, but no official place (${candidates.join(', ')}) carries a signature of THIS release (refs/tags/v${ctx.plan.tag}) — refusing to spread it`,
	);
}

type PublishTarget = Extract<TargetVerdict, { publish: true }>;

/** Keyless-sign `target` AT the digest, in its own registry (one Rekor entry per registry). */
function signAt(ctx: PublishContext, target: PublishTarget, digest: string): boolean {
	return ctx.run([ctx.cosign, 'sign', '--yes', `${target.repository}@${digest}`]).code === 0;
}

/**
 * Step 6, one target: a holder already signed is left alone; a holder without the
 * signature is signed in place; a target without the release receives the digest (a
 * carbon copy: `imagetools create` from ONE source by digest keeps the digest — the
 * re-inspect of step 7 proves it) and is then signed there. Never `cosign copy`: cosign 3
 * signs in the OCI 1.1 referrers bundle format, which that deprecated verb does not carry.
 */
function publishTo(
	ctx: PublishContext,
	target: PublishTarget,
	chosen: PublishSource,
): TargetOutcome {
	const holder = chosen.holders.get(target.repository);
	if (holder?.signed) return { status: 'unchanged', reason: null };
	if (Date.now() >= ctx.deadline) return { status: 'failed', reason: 'deadline exceeded' };
	if (holder !== undefined) return signedOutcome(ctx, target, chosen.digest, 'signed');
	const moved = tagMovedFault(ctx, target, chosen.digest);
	if (moved !== null) return { status: 'failed', reason: moved };
	const copied = ctx.run([
		'docker',
		'buildx',
		'imagetools',
		'create',
		'-t',
		`${target.repository}:${ctx.plan.tag}`,
		chosen.source,
	]);
	if (copied.code !== 0) return { status: 'failed', reason: 'copy failed' };
	return signedOutcome(ctx, target, chosen.digest, 'pushed');
}

/** What one target ended as, and why when it failed. */
interface TargetOutcome {
	status: RegistryRecord['status'];
	reason: string | null;
}

function signedOutcome(
	ctx: PublishContext,
	target: PublishTarget,
	digest: string,
	done: RegistryRecord['status'],
): TargetOutcome {
	return signAt(ctx, target, digest)
		? { status: done, reason: null }
		: { status: 'failed', reason: 'signing failed' };
}

/**
 * The release channel's compare-and-set: `imagetools create` overwrites a tag, so right
 * before the copy the target's release tag is read again — one that appeared since the
 * immutability inspect with another digest (or that cannot be read) is never re-pointed.
 * Dev tags are mutable by definition. Null = clear to copy.
 */
function tagMovedFault(ctx: PublishContext, target: PublishTarget, digest: string): string | null {
	if (ctx.plan.channel === 'dev') return null;
	const now = inspectDigest(ctx.run, `${target.repository}:${ctx.plan.tag}`);
	if (now.state === 'absent' || (now.state === 'present' && now.digest === digest)) return null;
	const found = now.state === 'present' ? now.digest : `unreadable (${now.detail})`;
	return `${target.repository}:${ctx.plan.tag} appeared as ${found} after the immutability check — a release tag is never re-pointed; nothing was copied`;
}

/** Step 7: the SAME digest everywhere, and the operator's own verify passes. */
function verifyTarget(ctx: PublishContext, target: PublishTarget, digest: string): boolean {
	const now = inspectDigest(ctx.run, `${target.repository}:${ctx.plan.tag}`);
	if (now.state !== 'present' || now.digest !== digest) return false;
	return cosignVerify(ctx, `${target.repository}@${digest}`);
}

function skippedRecord(verdict: Extract<TargetVerdict, { publish: false }>): RegistryRecord {
	if (verdict.loud) console.log(`::warning::${verdict.entry.id}: skipped — ${verdict.reason}`);
	return {
		id: verdict.entry.id,
		repository: verdict.entry.repository,
		status: 'skipped',
		reason: verdict.reason,
		verified: false,
	};
}

/** How the summary names each channel. */
const CHANNEL_WORDS: Readonly<Record<InstallChannel, string>> = {
	master: 'release',
	prerelease: 'prerelease',
	dev: 'developer',
};

/** Render the job summary for a finished (or failed) publication. */
export function renderSummary(record: ReleaseRecord, list: ImageRegistryList): string {
	const rows = record.registries.map(
		(item) =>
			`| ${item.id} | ${item.repository === null ? '—' : `\`${item.repository}\``} | ${item.status} | ${item.verified ? 'yes' : 'no'} | ${item.reason ?? ''} |`,
	);
	const verifiedTarget =
		record.registries.find((item) => item.verified)?.repository ?? '<repository>';
	return [
		`### Dédalo image ${record.tag} (${CHANNEL_WORDS[record.channel]})`,
		'',
		`- source: \`${record.source_sha}\` (git archive sha256 \`${record.archive_sha256}\`)`,
		`- digest: \`${record.digest}\` — the SAME on every registry below`,
		'',
		'| Registry | Repository | Status | Verified | Reason |',
		'|---|---|---|---|---|',
		...rows,
		'',
		'Verify, as an operator does:',
		'',
		'```shell',
		`cosign verify ${verifiedTarget}@${record.digest} \\`,
		`  --certificate-identity-regexp '${list.signing.identity_regexp}' \\`,
		`  --certificate-oidc-issuer '${list.signing.issuer}'`,
		'```',
		'',
	].join('\n');
}

function writeRecord(env: Env, record: ReleaseRecord, list: ImageRegistryList): void {
	const path = env.RECORD_PATH || join(env.RUNNER_TEMP as string, 'image-release.json');
	writeFileSync(path, `${JSON.stringify(record, null, '\t')}\n`);
	if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, renderSummary(record, list));
	console.log(`record: ${path}`);
}

/**
 * Why `tag` may NOT be the one tag a `channel` run of data version `version` writes,
 * or null. THE floating-tag decision (gate 16): the publish verb writes exactly
 * `<target>:<TAG>`, so this is where a `latest`, an `X` / `X.Y`, or a prerelease's
 * bare triple would enter — and is refused, before any download or push:
 *   master      TAG = version (a stable identity IS its tag);
 *   prerelease  TAG = a prerelease identity of version's triple (`7.0.0-beta.6`) —
 *               never `7.0.0`, which after the stable release is another image;
 *   dev         TAG = `<version>-dev`.
 * Pure.
 */
export function publishTagFault(
	version: string,
	tag: string,
	channel: InstallChannel,
): string | null {
	const identity = identityOfImageTag(tag);
	const parsed = identity === null ? null : parseReleaseVersion(identity);
	const kind: ReleaseKind | null =
		parsed === null
			? null
			: parsed.dev
				? 'dev'
				: parsed.prerelease === null
					? 'stable'
					: 'prerelease';
	const wanted: ReleaseKind = CHANNEL_KIND[channel];
	if (parsed !== null && kind === wanted && parsed.triple.join('.') === version) return null;
	return `TAG '${tag}' is not the ${CHANNEL_WORDS[channel]} tag of ${version} — a ${channel} run writes exactly ${channel === 'master' ? version : channel === 'dev' ? `${version}-dev` : `${version}-(alpha|beta|rc).N`}, never a floating tag (latest, X, X.Y${channel === 'prerelease' ? `, ${version}` : ''})`;
}

/** The release kind each install channel publishes. */
const CHANNEL_KIND: Readonly<Record<InstallChannel, ReleaseKind>> = {
	master: 'stable',
	prerelease: 'prerelease',
	dev: 'dev',
};

function publishPlan(env: Env): PublishContext['plan'] {
	const input = requireEnv(env, [
		'VERSION',
		'TAG',
		'CHANNEL',
		'STAGING',
		'RUN_ID',
		'SOURCE_SHA',
		'ARCHIVE_SHA256',
	]);
	if (!isInstallChannel(input.CHANNEL))
		throw new Refusal(`CHANNEL must be master, prerelease or dev (got ${input.CHANNEL})`);
	const tagFault = publishTagFault(input.VERSION as string, input.TAG as string, input.CHANNEL);
	if (tagFault !== null) throw new Refusal(tagFault);
	return {
		version: input.VERSION as string,
		tag: input.TAG as string,
		channel: input.CHANNEL,
		source_sha: input.SOURCE_SHA as string,
		staging: input.STAGING as string,
		expected_engine_version: '',
		archive_sha256: input.ARCHIVE_SHA256 as string,
		run_id: input.RUN_ID as string,
	};
}

/**
 * The registry list a verb works on: the tree's own, or IMAGE_REGISTRIES_FILE
 * (a gate's scratch copy) read here and validated through the same door.
 */
function registriesOf(env: Env): ImageRegistryList {
	const file = env.IMAGE_REGISTRIES_FILE;
	if (file === undefined || file === '') return loadImageRegistries();
	return parseImageRegistries(JSON.parse(readFileSync(file, 'utf8')), file);
}

function publish(env: Env, run: Runner, deadline: number): number {
	const list = registriesOf(env);
	const plan = publishPlan(env);
	if (plan.staging !== list.ci.staging_repository)
		throw new Refusal(
			`STAGING ${plan.staging} is not the list's staging repository ${list.ci.staging_repository}`,
		);
	smokedDigests(env); // refuse a missing digest before the first download or push
	const cosign = installCosign(env, run);
	const ctx: PublishContext = { env, run, deadline, list, plan, cosign };
	const verdicts = classifyTargets(list, env);
	const targets = verdicts.filter((verdict): verdict is PublishTarget => verdict.publish);
	if (targets.length === 0)
		throw new Refusal('no provisioned registry can be published to — every target was skipped');
	loginAll(ctx, verdicts);
	const chosen = chooseSource(ctx, targets, assembleIndex(ctx));
	// Step 6 for EVERY target, then step 7 for every target: a verify never runs while a
	// copy or a signature is still pending, so the verified set is the final state.
	const statuses = new Map(targets.map((target) => [target, publishTo(ctx, target, chosen)]));
	const records = verdicts.map((verdict) =>
		verdict.publish
			? verifiedRecord(
					ctx,
					verdict,
					statuses.get(verdict) ?? { status: 'failed', reason: 'not attempted' },
					chosen.digest,
				)
			: skippedRecord(verdict),
	);
	const record: ReleaseRecord = {
		schema: 1,
		version: plan.version,
		tag: plan.tag,
		channel: plan.channel,
		source_sha: plan.source_sha,
		archive_sha256: plan.archive_sha256,
		digest: chosen.digest,
		registries: records,
	};
	writeRecord(env, record, list);
	return records.every((item) => item.status === 'skipped' || item.verified) ? 0 : 1;
}

function verifiedRecord(
	ctx: PublishContext,
	target: PublishTarget,
	outcome: TargetOutcome,
	digest: string,
): RegistryRecord {
	const { status, reason } = outcome;
	const verified = status !== 'failed' && verifyTarget(ctx, target, digest);
	if (!verified)
		console.log(
			`::error::${target.entry.id}: ${target.repository}:${ctx.plan.tag} is not ${digest} with a valid signature${reason === null ? '' : ` — ${reason}`}`,
		);
	return { id: target.entry.id, repository: target.repository, status, reason, verified };
}

// ─────────────────────────────────────────────────────────────────────────────
// The verbs
// ─────────────────────────────────────────────────────────────────────────────

function writeOutputs(env: Env, outputs: Record<string, string>): void {
	const lines = Object.entries(outputs).map(([key, value]) => `${key}=${value}`);
	for (const line of lines) console.log(`output ${line}`);
	if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
}

/** The run's facts, as the workflow hands them over (absent = empty). */
export function planFactsOf(env: Env): PlanFacts {
	const pick = (key: string): string => env[key] ?? '';
	return {
		event: pick('GITHUB_EVENT_NAME'),
		ref: pick('GITHUB_REF'),
		sha: pick('GITHUB_SHA'),
		inputChannel: pick('INPUT_CHANNEL'),
		inputTag: pick('INPUT_TAG'),
	};
}

function planVerb(env: Env, run: Runner): number {
	const cwd = process.cwd();
	const list = registriesOf(env);
	const plan = resolvePlan(planFactsOf(env), gitLookups(run, cwd), list.ci.staging_repository);
	// A prerelease IS a release (owner Q1): held to the same full gate as a stable one.
	if (plan.channel !== 'dev') {
		const fault = fullGateFault(plan.source_sha, fullGateGreens(env, run, plan.source_sha));
		if (fault !== null) throw new Refusal(fault);
		console.log(`plan: full gate green on ${plan.source_sha} (${FULL_GATE_WORKFLOWS.join(' + ')})`);
	}
	const tmp = requireEnv(env, ['RUNNER_TEMP']).RUNNER_TEMP as string;
	const tarPath = join(tmp, 'plan-source.tar');
	const archive = archiveTree(run, cwd, plan.source_sha, tarPath);
	const held = archiveIdentityPlan(plan, archivedStamp(run, tarPath));
	writeOutputs(env, { ...held, archive_sha256: archive, created: new Date().toISOString() });
	return 0;
}

function contextVerb(env: Env, run: Runner): number {
	const input = requireEnv(env, ['SOURCE_SHA', 'RUNNER_TEMP']);
	const tmp = input.RUNNER_TEMP as string;
	const context = join(tmp, 'ctx');
	mkdirSync(context, { recursive: true });
	const tarPath = join(tmp, 'source.tar');
	const archive = archiveTree(run, process.cwd(), input.SOURCE_SHA as string, tarPath);
	const expected = env.EXPECTED_ARCHIVE_SHA256 ?? '';
	if (expected !== '' && expected !== archive)
		throw new Refusal(
			`this runner's git archive of ${input.SOURCE_SHA} has sha256 ${archive}, the plan's has ${expected} — the arches would carry different provenance`,
		);
	must(run(['tar', '-xf', tarPath, '-C', context]), 'extracting the build context');
	writeOutputs(env, { context, archive_sha256: archive });
	return 0;
}

const VERBS: Readonly<Record<string, (env: Env, run: Runner, deadline: number) => number>> = {
	plan: planVerb,
	context: contextVerb,
	smoke,
	publish,
};

export function main(argv: readonly string[], env: Env = process.env, runner?: Runner): number {
	const name = argv[0] ?? '';
	const verb = VERBS[name];
	if (verb === undefined) {
		console.error('usage: bun run scripts/ci/image_release.ts plan|context|smoke|publish');
		return 2;
	}
	const deadline = Date.now() + verbBudgetMs(name, env);
	const run = runner ?? spawnRunner(commandTimeoutMs(name, env), deadline);
	try {
		return verb(env, run, deadline);
	} catch (error) {
		if (!(error instanceof Refusal)) throw error;
		console.log(`::error::${error.message}`);
		if (env.GITHUB_STEP_SUMMARY)
			appendFileSync(env.GITHUB_STEP_SUMMARY, `### Refused\n\n${error.message}\n`);
		return 1;
	}
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
