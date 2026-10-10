/**
 * image_release.ts — the program behind .github/workflows/image-release.yml: the
 * official Dédalo image, built once, signed once, published with ONE digest to every
 * provisioned registry of engineering/image_registries.json.
 *
 *   bun run scripts/ci/image_release.ts plan      which release this run publishes (or refuse)
 *   bun run scripts/ci/image_release.ts context   the build context: a `git archive` of the release commit
 *   bun run scripts/ci/image_release.ts smoke     the built bytes, run and asserted
 *   bun run scripts/ci/image_release.ts publish   index → immutability → sign → copy → verify → record
 *
 * WHAT A RELEASE IS here is what it is for the code server (engineering/RELEASE.md):
 * the stable tag `vX.Y.Z` whose own version.ts declares X.Y.Z — `<v>.zip` there,
 * `:<v>` here — or the developer build of `master` — `<v>-dev.zip` there, `:<v>-dev`
 * here. The rules are code_build_plan.ts's (`releaseTagVersion`, `parseDeclaredTriple`,
 * `DEV_REF`), imported, never restated; a prerelease tag never publishes, and no image
 * is ever tagged `latest`.
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
 *      X must carry the official signature, and X is what the missing targets receive;
 *   5. sign ONCE, keyless (`cosign sign` on staging@D; Rekor records it);
 *   6. `cosign copy` the signed bytes (image + signature) to every target;
 *   7. every target must now hold the SAME digest AND pass the exact `cosign verify`
 *      an operator runs;
 *   8. record: the job summary + image-release.json (uploaded as an artifact).
 * Nothing is copied before it is signed; nothing is signed before step 4 passes; an
 * unpinned or tampered cosign refuses before the first push.
 *
 * I/O: inputs come from the environment the workflow composes (static names, every
 * expression through `env:`); outputs go to $GITHUB_OUTPUT and $GITHUB_STEP_SUMMARY.
 * The only process boundary is ONE injectable command runner. Test seams:
 * IMAGE_REGISTRIES_FILE (another list), COSIGN_PIN_FILE (another pin).
 */

import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	DEV_REF,
	parseDeclaredTriple,
	qualifiedReleaseTag,
	releaseTagVersion,
	VERSION_TS_PATH,
} from '../../src/core/update/code_build_plan.ts';
import {
	type ImageRegistry,
	type ImageRegistryList,
	loadImageRegistries,
	parseImageRegistries,
} from '../../src/core/update/image_registries.ts';
import { cosignDownloadUrl, isPinSet, readCosignPin } from '../ci_cosign_pin.ts';

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

/** The real runner. Passwords travel on stdin, never in argv, so the echo is safe. */
export const spawnRunner: Runner = (argv, options) => {
	console.log(`$ ${argv.join(' ')}`);
	const result = Bun.spawnSync([...argv], {
		cwd: options?.cwd,
		stdin: options?.stdin === undefined ? 'ignore' : Buffer.from(options.stdin),
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const stderr = result.stderr.toString();
	if (stderr !== '') process.stderr.write(stderr);
	return { code: result.exitCode ?? 1, stdout: result.stdout.toString(), stderr };
};

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

/** What the plan needs from git, injectable so the rules are testable without a repository. */
export interface PlanGit {
	/** The X.Y.Z a commit's version.ts declares, or null. */
	declaredAt(rev: string): string | null;
	/** The commit a ref names, or null when it does not exist. */
	commitOf(ref: string): string | null;
}

export interface ReleasePlan {
	version: string;
	/** The image tag: X.Y.Z (release, immutable) or X.Y.Z-dev (developer, mutable). */
	tag: string;
	/** The install-stamp channel: master (release) or dev. */
	channel: 'master' | 'dev';
	source_sha: string;
	staging: string;
	/** What the image's own DEDALO_ENGINE_VERSION must say: X.Y.Z or X.Y.Z.dev. */
	expected_engine_version: string;
}

const DEV_BRANCH_REF = `refs/heads/${DEV_REF}`;

/** A stable release tag → its plan, or the refusal. The code server's rules, imported. */
function releasePlanFor(tagRef: string, git: PlanGit, staging: string): ReleasePlan {
	const version = releaseTagVersion(tagRef);
	if (version === null)
		throw new Refusal(
			`'${tagRef}' is not a stable release tag vX.Y.Z — prerelease tags are never published`,
		);
	const commit = git.commitOf(qualifiedReleaseTag(version));
	if (commit === null)
		throw new Refusal(`release tag v${version} does not exist in this repository`);
	const declared = git.declaredAt(commit);
	if (declared !== version)
		throw new Refusal(
			`tag v${version} names version ${version}, but its ${VERSION_TS_PATH} declares ${declared ?? 'nothing'}`,
		);
	return {
		version,
		tag: version,
		channel: 'master',
		source_sha: commit,
		staging,
		expected_engine_version: version,
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
 * A release dispatch publishes an EXISTING tag. It must run from a ref the signing
 * identity accepts (the release tag itself or the dev branch), or every copy would fail
 * the very verify step that operators run.
 */
function dispatchedReleasePlan(facts: PlanFacts, git: PlanGit, staging: string): ReleasePlan {
	if (facts.ref !== DEV_BRANCH_REF && releaseTagVersion(facts.ref) === null)
		throw new Refusal(
			`a release dispatch runs from ${DEV_BRANCH_REF} or a release tag (this run is on ${facts.ref})`,
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
	return {
		declaredAt: (rev) => {
			const shown = run(['git', 'show', `${rev}:${VERSION_TS_PATH}`], { cwd });
			return shown.code === 0 ? parseDeclaredTriple(shown.stdout) : null;
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

/** `git archive --format=tar <sha>` into `tarPath`; returns the stream's sha256. */
export function archiveTree(run: Runner, cwd: string, sha: string, tarPath: string): string {
	must(run(['git', 'archive', '--format=tar', '-o', tarPath, sha], { cwd }), `git archive ${sha}`);
	return sha256File(tarPath);
}

// ─────────────────────────────────────────────────────────────────────────────
// smoke — the exact bytes, run and asserted
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The in-container assertions (POSIX sh, run as the image's own user). `SMOKE_ROOT`
 * prefixes the filesystem paths so the gate can execute this text against a scratch
 * tree; in the image it is empty.
 */
export const SMOKE_SCRIPT = `R="\${SMOKE_ROOT:-}"
fail() { echo "smoke: FAIL $*" >&2; exit 1; }
[ "$(bun --version)" = "$WANT_BUN" ] || fail "bun $(bun --version) is not .bun-version $WANT_BUN"
[ -f "$R/etc/dedalo/image_tree" ] || fail "no image-channel marker /etc/dedalo/image_tree"
pg_dump --version | grep -q "PostgreSQL) 18\\." || fail "pg_dump is not PostgreSQL 18"
for b in ffmpeg ffprobe magick pdftoppm pdfinfo pdftotext gs rsvg-convert ocrmypdf git rsync unzip; do
  command -v "$b" >/dev/null || fail "missing media/ops tool: $b"
done
[ "$(id -u)" = 1000 ] || fail "the image runs as uid $(id -u), not bun (1000)"
[ "$(stat -c %u "$R/srv/dedalo/client")" = 1000 ] || fail "/srv/dedalo/client is not owned by bun"
[ ! -e "$R/opt/dedalo/master_dedalo/deploy" ] || fail "deploy/ is inside the image"
cd "$R/opt/dedalo/master_dedalo"
got="$(bun -e 'const b = await import("./src/core/update/build_stamp.ts"); const s = await import("./src/core/update/install_stamp.ts"); console.log([b.DEDALO_ENGINE_VERSION, s.INSTALLED_CHANNEL, s.INSTALLED_DIGEST].join(" "))')"
[ "$got" = "$WANT_VERSION $WANT_CHANNEL $WANT_DIGEST" ] || fail "the engine reports '$got', expected '$WANT_VERSION $WANT_CHANNEL $WANT_DIGEST'"
echo "smoke: ok"
`;

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
// publish — targets, immutability, sign, copy, verify, record
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
 * Step 4, pure. Dev tags are mutable by definition. A release tag held anywhere IS the
 * release: every holder must agree on one digest, which the missing targets then
 * receive; disagreement or an unreadable target refuses before anything is signed.
 */
export function immutabilityVerdict(
	channel: 'master' | 'dev',
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
	status: 'pushed' | 'unchanged' | 'skipped' | 'failed';
	reason: string | null;
	verified: boolean;
}

export interface ReleaseRecord {
	schema: 1;
	version: string;
	tag: string;
	channel: 'master' | 'dev';
	source_sha: string;
	archive_sha256: string;
	digest: string;
	registries: RegistryRecord[];
}

interface PublishContext {
	env: Env;
	run: Runner;
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

function cosignVerify(ctx: PublishContext, ref: string): boolean {
	const { identity_regexp: identity, issuer } = ctx.list.signing;
	return (
		ctx.run([
			ctx.cosign,
			'verify',
			ref,
			'--certificate-identity-regexp',
			identity,
			'--certificate-oidc-issuer',
			issuer,
		]).code === 0
	);
}

/** Steps 4+5: what is published — a freshly signed D, or the release that already exists. */
function chooseSource(
	ctx: PublishContext,
	targets: readonly PublishTarget[],
	built: string,
): { source: string; digest: string; overwrite: boolean; holders: Set<string> } {
	const existing = targets.map((target) => ({
		repository: target.repository,
		state: inspectDigest(ctx.run, `${target.repository}:${ctx.plan.tag}`),
	}));
	const verdict = immutabilityVerdict(ctx.plan.channel, existing);
	if (verdict.kind === 'fresh') {
		must(
			ctx.run([ctx.cosign, 'sign', '--yes', `${ctx.plan.staging}@${built}`]),
			'signing the image',
		);
		return {
			source: `${ctx.plan.staging}@${built}`,
			digest: built,
			overwrite: verdict.overwrite,
			holders: new Set(),
		};
	}
	const source = `${verdict.holder}@${verdict.digest}`;
	if (!cosignVerify(ctx, source))
		throw new Refusal(
			`release ${ctx.plan.tag} already exists as ${source}, but it does not carry the official signature — refusing to spread it`,
		);
	const holders = new Set(
		existing.filter((item) => item.state.state === 'present').map((item) => item.repository),
	);
	return { source, digest: verdict.digest, overwrite: false, holders };
}

type PublishTarget = Extract<TargetVerdict, { publish: true }>;

/** Step 6: one copy per target that does not hold the release yet. */
function copyTo(
	ctx: PublishContext,
	target: PublishTarget,
	chosen: ReturnType<typeof chooseSource>,
): RegistryRecord['status'] {
	if (chosen.holders.has(target.repository)) return 'unchanged';
	const force = chosen.overwrite ? ['--force'] : [];
	const copied = ctx.run([
		ctx.cosign,
		'copy',
		...force,
		chosen.source,
		`${target.repository}:${ctx.plan.tag}`,
	]);
	return copied.code === 0 ? 'pushed' : 'failed';
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

/** Render the job summary for a finished (or failed) publication. */
export function renderSummary(record: ReleaseRecord, list: ImageRegistryList): string {
	const rows = record.registries.map(
		(item) =>
			`| ${item.id} | ${item.repository === null ? '—' : `\`${item.repository}\``} | ${item.status} | ${item.verified ? 'yes' : 'no'} | ${item.reason ?? ''} |`,
	);
	const verifiedTarget =
		record.registries.find((item) => item.verified)?.repository ?? '<repository>';
	return [
		`### Dédalo image ${record.tag} (${record.channel === 'master' ? 'release' : 'developer'})`,
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
	if (input.CHANNEL !== 'master' && input.CHANNEL !== 'dev')
		throw new Refusal(`CHANNEL must be master or dev (got ${input.CHANNEL})`);
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

function publish(env: Env, run: Runner): number {
	const list = registriesOf(env);
	const plan = publishPlan(env);
	if (plan.staging !== list.ci.staging_repository)
		throw new Refusal(
			`STAGING ${plan.staging} is not the list's staging repository ${list.ci.staging_repository}`,
		);
	smokedDigests(env); // refuse a missing digest before the first download or push
	const cosign = installCosign(env, run);
	const ctx: PublishContext = { env, run, list, plan, cosign };
	const verdicts = classifyTargets(list, env);
	const targets = verdicts.filter((verdict): verdict is PublishTarget => verdict.publish);
	if (targets.length === 0)
		throw new Refusal('no provisioned registry can be published to — every target was skipped');
	loginAll(ctx, verdicts);
	const chosen = chooseSource(ctx, targets, assembleIndex(ctx));
	// Step 6 for EVERY target, then step 7 for every target: a verify never runs while a
	// copy is still pending, so the verified set is the final state of the publication.
	const statuses = new Map(targets.map((target) => [target, copyTo(ctx, target, chosen)]));
	const records = verdicts.map((verdict) =>
		verdict.publish
			? verifiedRecord(ctx, verdict, statuses.get(verdict) ?? 'failed', chosen.digest)
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
	status: RegistryRecord['status'],
	digest: string,
): RegistryRecord {
	const verified = status !== 'failed' && verifyTarget(ctx, target, digest);
	if (!verified)
		console.log(
			`::error::${target.entry.id}: ${target.repository}:${ctx.plan.tag} is not ${digest} with a valid signature`,
		);
	return { id: target.entry.id, repository: target.repository, status, reason: null, verified };
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
	if (plan.channel === 'master') {
		const fault = fullGateFault(plan.source_sha, fullGateGreens(env, run, plan.source_sha));
		if (fault !== null) throw new Refusal(fault);
		console.log(`plan: full gate green on ${plan.source_sha} (${FULL_GATE_WORKFLOWS.join(' + ')})`);
	}
	const tmp = requireEnv(env, ['RUNNER_TEMP']).RUNNER_TEMP as string;
	const archive = archiveTree(run, cwd, plan.source_sha, join(tmp, 'plan-source.tar'));
	writeOutputs(env, { ...plan, archive_sha256: archive, created: new Date().toISOString() });
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

const VERBS: Readonly<Record<string, (env: Env, run: Runner) => number>> = {
	plan: planVerb,
	context: contextVerb,
	smoke,
	publish,
};

export function main(
	argv: readonly string[],
	env: Env = process.env,
	run: Runner = spawnRunner,
): number {
	const verb = VERBS[argv[0] ?? ''];
	if (verb === undefined) {
		console.error('usage: bun run scripts/ci/image_release.ts plan|context|smoke|publish');
		return 2;
	}
	try {
		return verb(env, run);
	} catch (error) {
		if (!(error instanceof Refusal)) throw error;
		console.log(`::error::${error.message}`);
		if (env.GITHUB_STEP_SUMMARY)
			appendFileSync(env.GITHUB_STEP_SUMMARY, `### Refused\n\n${error.message}\n`);
		return 1;
	}
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
