/**
 * IMAGE RELEASE — scripts/ci/image_release.ts, EXECUTED (installer unification D1).
 *
 * The release workflow cannot be run from a test (it pushes, signs, holds secrets), so
 * its program is run here as the workflow runs it — `bun scripts/ci/image_release.ts
 * <verb>` — with `docker`, `curl` and the downloaded `cosign` replaced by ONE recording
 * stub on PATH. The stub keeps a tiny registry in a state directory (reference →
 * digest, plus one signature marker per `<repository>@<digest>` — a signature lives in
 * ONE registry, as cosign 3's OCI 1.1 referrers do), so a copy, a sign, an inspect and a
 * verify see each other's effects, and every invocation is appended to a log. What is asserted is the OUTCOME and the ORDER of
 * effects, which is the safety argument of the publish verb:
 *
 *   - an unpinned cosign, or a downloaded binary whose sha256 is not the pin, refuses
 *     before ANY registry command;
 *   - an unprovisioned registry is skipped with its reason; a provisioned one whose
 *     secrets are absent is skipped LOUDLY (::warning::) and the others still publish;
 *   - nothing is signed before every target was inspected (immutability), nothing leaves
 *     staging before D is signed there, every target is copied by digest and then signed
 *     AT its own digest, nothing is verified before every copy and signature; `cosign
 *     copy` is never invoked (it does not carry cosign 3's referrers signatures — the
 *     v7.0.0-beta.7 incident);
 *   - release channel: holders that disagree refuse before signing or copying; an
 *     existing release whose digest carries no signature of THIS release (exact identity
 *     @refs/tags/v<tag> — a dev or other-tag signature never counts) at a holder or at
 *     staging@X refuses before copying; a tag appearing between check and copy is never
 *     re-pointed; a hanging command fails its target at the ceiling, record written; agreeing holders are kept, the missing target receives
 *     THEIR digest (never a rebuild), and a holder without the signature in its own
 *     registry is signed in place when X verifies elsewhere (the recovery door);
 *   - dev channel: the mutable tag is overwritten;
 *   - a target that ends with another digest fails the run, and the record says so;
 *   - the record (image-release.json) has the documented schema.
 * The plan rules run on a REAL scratch git repository (tags, version.ts, branches): a
 * stable tag whose version.ts agrees publishes; a disagreeing tag, a prerelease tag and
 * a developer build off another branch are refused; a developer build of master is
 * X.Y.Z-dev / X.Y.Z.dev. The plan reads the identity its OWN archive expands to (the real
 * placeholder): a lightweight release tag is refused, a dev build of a release commit expects
 * the tag; and the context step, run in a full clone and in a shallow tagless one, agrees with
 * or refuses the plan's archive digest.
 *
 * A release TAG must also be CUT (gate 11, scripts/lib/release_tag.ts — the function the
 * pre-push hook runs too): a tag whose commit carries no changes/<identity>/release.json is
 * refused. An archiving git older than MIN_GIT_FOR_DESCRIBE is refused before any archive.
 *
 * GATE 10 — the identity the image SERVES: the smoke's /health fragment
 * (SMOKE_HEALTH_SCRIPT) is EXECUTED here against this checkout — the real server booted
 * in smoke mode with no database — and passes only when /health serves the expected
 * identity and kind; a wrong expectation is red.
 *
 * HONEST LIMIT: the rest of `smoke` is checked for what it asks the container to prove
 * (the pulled reference, the expectations, every assertion in its script) — those lines
 * run only inside the Debian image (uid 1000, GNU stat), i.e. on the first real release run.
 *
 * DB-free; spawns bun, bash and git in scratch directories: hermetic tier.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
	FULL_GATE_WORKFLOWS,
	fullGateFault,
	type ManifestState,
	main,
	type PlanGit,
	Refusal,
	type Runner,
	resolvePlan,
	SMOKE_HEALTH_SCRIPT,
	SMOKE_SCRIPT,
	sha256File,
} from '../../scripts/ci/image_release.ts';
import { acceptedImageVersions, imageVersionOf } from '../../src/core/install/host/stack/layout.ts';
import { BUILD_INFO_PATH, RELEASE_IDENTITY } from '../../src/core/update/build_stamp.ts';
import {
	IMAGE_REGISTRIES_PATH,
	type ImageRegistryList,
	validateImageRegistries,
} from '../../src/core/update/image_registries.ts';
import {
	MIN_GIT_FOR_DESCRIBE,
	parseBuildInfo,
	resolveReleaseIdentity,
} from '../../src/core/update/release_identity.ts';

const ROOT = join(import.meta.dir, '..', '..');
/** The real git, behind the plan's `git --version` stub. */
const REAL_GIT = Bun.which('git') ?? '/usr/bin/git';
const PROGRAM = join(ROOT, 'scripts', 'ci', 'image_release.ts');
/**
 * A FIXTURE list: the real one with its Docker Hub entry provisioned at a fixture
 * address, so a secret-authenticated mirror is exercised independently of the real
 * list's address — the program reads this copy through its IMAGE_REGISTRIES_FILE
 * seam, never a shipped address.
 */
const FIXTURE_HUB = 'docker.io/fixture-namespace-not-real/dedalo';
const LIST = ((): ImageRegistryList => {
	const raw = JSON.parse(readFileSync(IMAGE_REGISTRIES_PATH, 'utf8')) as {
		registries: {
			id: string;
			repository: string | null;
			provisioned: boolean;
			reason: string | null;
		}[];
	};
	const hub = raw.registries.find((entry) => entry.id === 'dockerhub');
	if (hub === undefined) throw new Error('the registry list has no dockerhub entry');
	Object.assign(hub, { repository: FIXTURE_HUB, provisioned: true, reason: null });
	return raw as unknown as ImageRegistryList;
})();
const STAGING = LIST.ci.staging_repository;
const REPO = Object.fromEntries(LIST.registries.map((entry) => [entry.id, entry.repository]));
const D = (n: number): string => `sha256:${String(n).repeat(64).slice(0, 64)}`;
const BUILT = D(1);
/** The per-arch digests the build legs smoke-tested (the build job's outputs). */
const ARCH_AMD64 = D(2);
const ARCH_ARM64 = D(3);

/**
 * The recording stub: docker, curl and (once downloaded) cosign. State: one file per
 * reference holding its digest. Behaviour switches come from STUB_* variables.
 */
const STUB = `#!/bin/bash
me="$(basename "$0")"
printf '%s %s\\n' "$me" "$*" >> "$STUB_LOG"
key() { printf '%s' "$1" | tr '/:@' '___'; }
digest_of() { case "$1" in *@sha256:*) printf '%s' "\${1#*@}" ;; *) cat "$STUB_STATE/$(key "$1")" 2>/dev/null ;; esac; }
# Every reference the stub registry is made to hold, one per line (the run's write set).
put() { printf '%s' "$2" > "$STUB_STATE/$(key "$1")"; printf '%s\n' "$1" >> "$STUB_STATE.writes"; }
case "$me" in
  curl)
    out=""; while [ $# -gt 0 ]; do [ "$1" = "-o" ] && out="$2"; shift; done
    cp "$STUB_COSIGN_SOURCE" "$out"; exit 0 ;;
  docker)
    case "$1 $2 $3" in
      "login "*) [ -n "\${STUB_LOGIN_HANG:-}" ] && exec sleep 30; cat >/dev/null; exit 0 ;;
      "buildx imagetools create")
        # ONE source = a carbon copy (same digest); several = the assembled index.
        if [ $# -eq 6 ]; then
          [ -n "\${STUB_COPY_FAIL:-}" ] && [ "$5" = "$STUB_COPY_FAIL" ] && { echo "denied" >&2; exit 1; }
          d="$(digest_of "$6")"
          [ -n "\${STUB_COPY_WRONG:-}" ] && [ "$5" = "$STUB_COPY_WRONG" ] && d="sha256:$(printf 'f%.0s' $(seq 64))"
          put "$5" "$d"
        else put "$5" "$STUB_BUILT"; fi
        exit 0 ;;
      "buildx imagetools inspect")
        # STUB_APPEAR_REF: absent at the first inspect, then written (STUB_APPEAR_DIGEST) by
        # "someone else" before the next — a tag that appears between check and copy.
        if [ -n "\${STUB_INSPECT_ERROR_AFTER_FIRST:-}" ] && [ "$4" = "$STUB_INSPECT_ERROR_AFTER_FIRST" ]; then
          [ -f "$STUB_STATE.seen" ] && { echo "unauthorized: denied" >&2; exit 1; }
          touch "$STUB_STATE.seen"
        fi
        if [ -n "\${STUB_APPEAR_REF:-}" ] && [ "$4" = "$STUB_APPEAR_REF" ]; then
          if [ -f "$STUB_STATE.appear" ]; then printf '%s' "$STUB_APPEAR_DIGEST" > "$STUB_STATE/$(key "$4")"
          else touch "$STUB_STATE.appear"; fi
        fi
        if [ -n "\${STUB_INSPECT_ERROR:-}" ] && [ "$4" = "$STUB_INSPECT_ERROR" ]; then echo "unauthorized: denied" >&2; exit 1; fi
        d="$(digest_of "$4")"
        if [ -z "$d" ]; then echo "ERROR: $4: not found" >&2; exit 1; fi
        printf '{"mediaType":"application/vnd.oci.image.index.v1+json","digest":"%s"}\\n' "$d"; exit 0 ;;
      *) exit 0 ;;
    esac ;;
  cosign)
    case "$1" in
      sign)
        [ "\${STUB_SIGN_RC:-0}" = 0 ] || exit "$STUB_SIGN_RC"
        [ -n "\${STUB_SIGN_FAIL:-}" ] && [ "$3" = "$STUB_SIGN_FAIL" ] && { echo "denied" >&2; exit 1; }
        [ -n "\${STUB_SIGN_HANG:-}" ] && [ "$3" = "$STUB_SIGN_HANG" ] && exec sleep 30
        # STUB_SIGNER = the certificate identity (SAN) the run's keyless signature carries,
        # recorded per signature (a reference may hold several, one per line).
        printf '%s\n' "$STUB_SIGNER" >> "$STUB_STATE/sig_$(key "$3")"; exit 0 ;;
      copy) echo 'Command "copy" is deprecated' >&2; exit 0 ;;
      verify)
        sigs="$STUB_STATE/sig_$(key "$2")"
        [ -f "$sigs" ] || { echo "no signatures found" >&2; exit 1; }
        # As cosign does: --certificate-identity-regexp matches a pattern, --certificate-identity
        # an EXACT identity; one recorded signature satisfying it is enough.
        re=""; exact=""; while [ $# -gt 0 ]; do
          [ "$1" = "--certificate-identity-regexp" ] && re="$2"
          [ "$1" = "--certificate-identity" ] && exact="$2"; shift; done
        if [ -n "$exact" ]; then grep -qxF -- "$exact" "$sigs" && exit 0
        elif [ -n "$re" ]; then grep -Eq -- "$re" "$sigs" && exit 0; fi
        echo "none of the expected identities matched" >&2; exit 1 ;;
    esac ;;
esac
exit 0
`;

let scratch = '';
let stubDir = '';
let cosignSource = '';
let listFile = '';

beforeAll(() => {
	scratch = mkdtempSync(join(tmpdir(), 'dedalo-image-release-'));
	stubDir = join(scratch, 'bin');
	mkdirSync(stubDir);
	for (const name of ['docker', 'curl']) {
		writeFileSync(join(stubDir, name), STUB);
		chmodSync(join(stubDir, name), 0o755);
	}
	// The "release asset" curl downloads: the same stub, which then answers as `cosign`.
	cosignSource = join(scratch, 'cosign-asset');
	writeFileSync(cosignSource, STUB);
	expect(validateImageRegistries(LIST)).toEqual([]);
	listFile = join(scratch, 'image_registries.json');
	writeFileSync(listFile, JSON.stringify(LIST));
});

afterAll(() => {
	rmSync(scratch, { recursive: true, force: true });
});

interface Run {
	code: number;
	stdout: string;
	log: string[];
	record: Record<string, unknown> | null;
	/** The job summary the run appended ($GITHUB_STEP_SUMMARY), '' when none. */
	summary: string;
	state: (ref: string) => string | null;
	/**
	 * Every tag `repository` holds after the run: the preset references plus every one
	 * the run made the stub registry hold (its write log), sorted, unique.
	 */
	tagsHeld: (repository: string) => string[];
}

let runCounter = 0;

/** One `publish` run in a fresh state dir; `preset` seeds the stub registry. */
function publish(options: {
	channel?: 'master' | 'prerelease' | 'dev';
	preset?: Record<string, string>;
	/** `<repository>@<digest>` references signed by THIS run's release identity. */
	signed?: string[];
	/** `<repository>@<digest>` → the identity its signature carries (another tag, master…). */
	signedBy?: Record<string, string>;
	env?: Record<string, string>;
	pin?: { version: string | null; linux_amd64_sha256: string | null };
	/**
	 * Run IN-PROCESS (main with an injected runner over the same stub) and make the command
	 * whose log line starts with this THROW a plain Error — a bug mid-publication.
	 */
	throwOn?: string;
}): Run {
	const dir = join(scratch, `run-${++runCounter}`);
	const state = join(dir, 'state');
	mkdirSync(state, { recursive: true });
	const key = (ref: string) => ref.replaceAll(/[/:@]/g, '_');
	for (const [ref, digest] of Object.entries(options.preset ?? {}))
		writeFileSync(join(state, key(ref)), digest);
	const channel = options.channel ?? 'master';
	const tag =
		options.env?.TAG ?? { master: '7.0.1', prerelease: '7.0.1-beta.2', dev: '7.0.1-dev' }[channel];
	// The run's own ref, as GitHub sets it: the release tag's push, or master for dev.
	const ref = channel === 'dev' ? 'refs/heads/master' : `refs/tags/v${tag}`;
	const signer = SIGNER(ref);
	const signatures: Record<string, string> = {
		...Object.fromEntries((options.signed ?? []).map((ref) => [ref, signer])),
		...options.signedBy,
	};
	for (const [ref, identity] of Object.entries(signatures))
		writeFileSync(join(state, `sig_${key(ref)}`), `${identity}\n`);
	const pinFile = join(dir, 'cosign.json');
	writeFileSync(
		pinFile,
		JSON.stringify(
			options.pin ?? { version: '9.9.9', linux_amd64_sha256: sha256File(cosignSource) },
		),
	);
	const env: Record<string, string> = {
		PATH: `${stubDir}:/usr/bin:/bin`,
		HOME: dir,
		STUB_LOG: join(dir, 'log'),
		STUB_STATE: state,
		STUB_BUILT: BUILT,
		STUB_COSIGN_SOURCE: cosignSource,
		RUNNER_TEMP: dir,
		RECORD_PATH: join(dir, 'image-release.json'),
		GITHUB_STEP_SUMMARY: join(dir, 'summary.md'),
		COSIGN_PIN_FILE: pinFile,
		IMAGE_REGISTRIES_FILE: listFile,
		DIGEST_AMD64: ARCH_AMD64,
		DIGEST_ARM64: ARCH_ARM64,
		VERSION: '7.0.1',
		TAG: tag,
		GITHUB_REPOSITORY: 'dedalia-org/dedalo',
		GITHUB_SERVER_URL: 'https://github.com',
		GITHUB_REF: ref,
		STUB_SIGNER: signer,
		CHANNEL: channel,
		STAGING,
		RUN_ID: '42',
		SOURCE_SHA: 'a'.repeat(40),
		ARCHIVE_SHA256: 'b'.repeat(64),
		GHCR_ACTOR: 'release-bot',
		GHCR_TOKEN: 'ghcr-token',
		DOCKERHUB_USERNAME: 'dedalia',
		DOCKERHUB_TOKEN: 'hub-token',
		...options.env,
	};
	const proc =
		options.throwOn === undefined ? spawnPublish(env) : inProcessPublish(env, options.throwOn);
	const logPath = join(dir, 'log');
	return {
		code: proc.code,
		stdout: proc.stdout,
		log: existsSync(logPath) ? readFileSync(logPath, 'utf8').trimEnd().split('\n') : [],
		summary: existsSync(env.GITHUB_STEP_SUMMARY as string)
			? readFileSync(env.GITHUB_STEP_SUMMARY as string, 'utf8')
			: '',
		record: isFile(env.RECORD_PATH as string)
			? (JSON.parse(readFileSync(env.RECORD_PATH as string, 'utf8')) as Record<string, unknown>)
			: null,
		state: (ref) =>
			existsSync(join(state, key(ref))) ? readFileSync(join(state, key(ref)), 'utf8') : null,
		tagsHeld: (repository) => {
			const writes = `${state}.writes`;
			const written = existsSync(writes) ? readFileSync(writes, 'utf8').split('\n') : [];
			const refs = [...Object.keys(options.preset ?? {}), ...written];
			const prefix = `${repository}:`;
			const tags = refs
				.filter((ref) => ref.startsWith(prefix))
				.map((ref) => ref.slice(prefix.length));
			return [...new Set(tags)].sort();
		},
	};
}

const isFile = (path: string): boolean => existsSync(path) && statSync(path).isFile();

function spawnPublish(env: Record<string, string>): { code: number; stdout: string } {
	const proc = Bun.spawnSync([process.execPath, PROGRAM, 'publish'], {
		cwd: ROOT,
		env,
		stdout: 'pipe',
		stderr: 'pipe',
	});
	return { code: proc.exitCode ?? 1, stdout: proc.stdout.toString() + proc.stderr.toString() };
}

/** `main` in this process over the stub; the command matching `throwOn` throws instead. */
function inProcessPublish(
	env: Record<string, string>,
	throwOn: string,
): { code: number; stdout: string; thrown?: unknown } {
	const runner: Runner = (argv, options) => {
		const line = `${basename(argv[0] as string)} ${argv.slice(1).join(' ')}`;
		if (line.startsWith(throwOn)) throw new Error(`injected failure at: ${line}`);
		const binary = Bun.which(argv[0] as string, { PATH: env.PATH }) ?? (argv[0] as string);
		const result = Bun.spawnSync([binary, ...argv.slice(1)], {
			env,
			stdin: options?.stdin === undefined ? 'ignore' : Buffer.from(options.stdin),
			stdout: 'pipe',
			stderr: 'pipe',
		});
		return {
			code: result.exitCode ?? 1,
			stdout: result.stdout.toString(),
			stderr: result.stderr.toString(),
		};
	};
	// What main prints is part of the outcome (::error::, ::warning::, record lines):
	// captured for the call, restored after, returned like spawnPublish's stdout.
	const printed: string[] = [];
	const { log, error: logError } = console;
	console.log = (...parts: unknown[]) => void printed.push(parts.map(String).join(' '));
	console.error = console.log;
	try {
		const code = main(['publish'], env, runner);
		return { code, stdout: printed.join('\n') };
	} catch (error) {
		return { code: 99, stdout: `${printed.join('\n')}\n${String(error)}`, thrown: error };
	} finally {
		console.log = log;
		console.error = logError;
	}
}

/** Index of the first log line matching, -1 when none. */
const at = (log: string[], pattern: RegExp): number => log.findIndex((line) => pattern.test(line));
const lastAt = (log: string[], pattern: RegExp): number =>
	log.reduce((found, line, i) => (pattern.test(line) ? i : found), -1);
const GHCR = REPO.ghcr as string;
const HUB = REPO.dockerhub as string;
/** A carbon copy to a TARGET (one source); the staging index assembly has two. */
const COPY_TO_TARGET = new RegExp(
	`^docker buildx imagetools create -t (${GHCR}|${HUB}):\\S+ \\S+$`,
);
/** Any registry write of the publish step: a sign or a copy to a target. */
const THIS_RELEASE_REFUSAL = 'carries a signature of THIS release';
type RecordRow = {
	id: string;
	repository: string | null;
	status: string;
	reason: string | null;
	verified: boolean;
};
const rowOf = (run: Run, id: string): RecordRow | undefined =>
	(run.record?.registries as RecordRow[] | undefined)?.find((item) => item.id === id);
const statusOf = (run: Run, id: string) => rowOf(run, id)?.status;
const reasonOf = (run: Run, id: string) => rowOf(run, id)?.reason;
const touchesRelease = (line: string): boolean =>
	line.startsWith('cosign sign ') || line.startsWith('cosign copy') || COPY_TO_TARGET.test(line);

describe('publish — the order of effects is the safety argument', () => {
	test('a fresh release: index once, every target inspected, signed in staging, copied by digest, signed per target, verified — one digest', () => {
		const run = publish({});
		expect(run.code, run.stdout).toBe(0);
		const { log } = run;
		const create = at(log, /^docker buildx imagetools create /);
		const sign = at(log, /^cosign sign /);
		const firstCopy = at(log, COPY_TO_TARGET);
		const lastInspectOfTargets = Math.max(
			lastAt(log, new RegExp(`^docker buildx imagetools inspect ${GHCR}:7\\.0\\.1 `)),
			lastAt(log, new RegExp(`^docker buildx imagetools inspect ${HUB}:7\\.0\\.1 `)),
		);
		const firstTargetInspect = Math.min(
			at(log, new RegExp(`^docker buildx imagetools inspect ${GHCR}:7\\.0\\.1 `)),
			at(log, new RegExp(`^docker buildx imagetools inspect ${HUB}:7\\.0\\.1 `)),
		);
		// Anti-vacuity: every effect happened.
		for (const index of [create, sign, firstCopy, firstTargetInspect])
			expect(index).toBeGreaterThanOrEqual(0);
		expect(at(log, /^curl /)).toBe(0); // the pinned cosign first
		expect(at(log, /^docker login /)).toBeLessThan(create);
		expect(firstTargetInspect).toBeLessThan(sign); // immutability before signing
		expect(sign).toBeLessThan(firstCopy); // nothing leaves staging unsigned
		// The staging anchor, then ONE signature per target registry, each AT its digest.
		expect(log.filter((line) => line.startsWith('cosign sign '))).toEqual([
			`cosign sign --yes ${STAGING}@${BUILT}`,
			`cosign sign --yes ${GHCR}@${BUILT}`,
			`cosign sign --yes ${HUB}@${BUILT}`,
		]);
		// Each target is signed only after IT holds the digest.
		for (const target of [GHCR, HUB])
			expect(at(log, new RegExp(`^cosign sign --yes ${target}@`))).toBeGreaterThan(
				at(log, new RegExp(`^docker buildx imagetools create -t ${target}:7\\.0\\.1 `)),
			);
		// THE v7.0.0-beta.7 bug: `cosign copy` carries no cosign 3 signature — never invoked.
		expect(log.some((line) => line.startsWith('cosign copy'))).toBe(false);
		// The index is assembled from the SMOKE-TESTED digests, never from a staging tag.
		expect(
			log.filter((line) => line.startsWith(`docker buildx imagetools create -t ${STAGING}:`)),
		).toEqual([
			`docker buildx imagetools create -t ${STAGING}:7.0.1-run-42 ${STAGING}@${ARCH_AMD64} ${STAGING}@${ARCH_ARM64}`,
		]);
		expect(log.some((line) => line.includes(':run-42-'))).toBe(false);
		expect(log.filter((line) => COPY_TO_TARGET.test(line))).toEqual([
			`docker buildx imagetools create -t ${GHCR}:7.0.1 ${STAGING}@${BUILT}`,
			`docker buildx imagetools create -t ${HUB}:7.0.1 ${STAGING}@${BUILT}`,
		]);
		const verifies = log.filter((line) => line.startsWith('cosign verify '));
		expect(verifies.map((line) => line.split(' ')[2])).toEqual([
			`${GHCR}@${BUILT}`,
			`${HUB}@${BUILT}`,
		]);
		expect(verifies[0]).toContain(`--certificate-identity-regexp ${LIST.signing.identity_regexp}`);
		expect(verifies[0]).toContain(`--certificate-oidc-issuer ${LIST.signing.issuer}`);
		expect(at(log, /^cosign verify /)).toBeGreaterThan(lastAt(log, /^cosign sign /));
		expect(lastInspectOfTargets).toBeGreaterThan(firstCopy); // re-inspected after the copy
		// The SAME digest everywhere.
		expect(run.state(`${GHCR}:7.0.1`)).toBe(BUILT);
		expect(run.state(`${HUB}:7.0.1`)).toBe(BUILT);
		// The password reached docker on stdin, never on argv.
		expect(log.join('\n')).not.toContain('hub-token');
		expect(log.join('\n')).not.toContain('ghcr-token');
	});

	test('the record has the documented schema, and the unprovisioned registry is skipped with its reason', () => {
		const run = publish({});
		expect(run.record).toEqual({
			schema: 1,
			version: '7.0.1',
			tag: '7.0.1',
			channel: 'master',
			source_sha: 'a'.repeat(40),
			archive_sha256: 'b'.repeat(64),
			digest: BUILT,
			registries: [
				{
					id: 'gitdedalo',
					repository: null,
					status: 'skipped',
					reason: `not_provisioned: ${LIST.registries[0]?.reason}`,
					verified: false,
				},
				{ id: 'ghcr', repository: GHCR, status: 'pushed', reason: null, verified: true },
				{ id: 'dockerhub', repository: HUB, status: 'pushed', reason: null, verified: true },
			],
		});
	});

	test('a missing secret skips that registry LOUDLY; the others still publish', () => {
		const run = publish({ env: { DOCKERHUB_TOKEN: '' } });
		expect(run.code, run.stdout).toBe(0);
		expect(run.stdout).toContain('::warning::dockerhub: skipped — missing_secret: DOCKERHUB_TOKEN');
		const hub = (run.record?.registries as { id: string; status: string; reason: string }[]).find(
			(item) => item.id === 'dockerhub',
		);
		expect(hub).toMatchObject({ status: 'skipped', reason: 'missing_secret: DOCKERHUB_TOKEN' });
		expect(run.log.some((line) => line.includes(HUB))).toBe(false);
		expect(run.state(`${GHCR}:7.0.1`)).toBe(BUILT);
	});

	test('a missing or non-digest arch digest refuses before ANY command (no tag fallback)', () => {
		const cases: Record<string, string>[] = [
			{ DIGEST_ARM64: '' },
			{ DIGEST_AMD64: `${STAGING}:run-42-amd64` },
		];
		for (const env of cases) {
			const run = publish({ env });
			expect(run.code).toBe(1);
			expect(run.stdout).toContain('publish assembles only what the build legs smoke-tested');
			expect(run.log).toEqual([]);
		}
	});

	test('an UNPINNED cosign refuses before any registry command', () => {
		const run = publish({ pin: { version: null, linux_amd64_sha256: null } });
		expect(run.code).toBe(1);
		expect(run.stdout).toContain('unsigned images are never published');
		expect(run.log).toEqual([]);
	});

	test('a downloaded cosign whose sha256 is not the pin refuses before any registry command', () => {
		const run = publish({ pin: { version: '9.9.9', linux_amd64_sha256: 'c'.repeat(64) } });
		expect(run.code).toBe(1);
		expect(run.stdout).toContain('refusing to sign with it');
		expect(run.log.map((line) => line.split(' ')[0])).toEqual(['curl']);
	});
});

describe('publish — immutability of a release', () => {
	test('agreeing holders are kept; the missing target receives THEIR digest — never a rebuild, signed in its own registry', () => {
		const existing = D(7);
		const run = publish({
			preset: { [`${GHCR}:7.0.1`]: existing },
			signed: [`${GHCR}@${existing}`],
		});
		expect(run.code, run.stdout).toBe(0);
		expect(run.log.filter((line) => line.startsWith('cosign sign '))).toEqual([
			`cosign sign --yes ${HUB}@${existing}`,
		]);
		expect(run.log.filter((line) => COPY_TO_TARGET.test(line))).toEqual([
			`docker buildx imagetools create -t ${HUB}:7.0.1 ${GHCR}@${existing}`,
		]);
		// The official signature of the existing release is checked before it is spread.
		expect(at(run.log, new RegExp(`^cosign verify ${GHCR}@${existing} `))).toBeLessThan(
			at(run.log, COPY_TO_TARGET),
		);
		expect(run.state(`${HUB}:7.0.1`)).toBe(existing);
		expect(run.record?.digest).toBe(existing);
		const statuses = (run.record?.registries as { id: string; status: string }[]).map(
			(item) => item.status,
		);
		expect(statuses).toEqual(['skipped', 'unchanged', 'pushed']);
	});

	test('RECOVERY (v7.0.0-beta.7): holders of X unsigned, staging@X signed by the TAG run → each holder signed IN PLACE (from master) and verified', () => {
		const existing = D(7);
		const run = publish({
			preset: { [`${GHCR}:7.0.1`]: existing, [`${HUB}:7.0.1`]: existing },
			// staging@X: the tag-push run's signature (refs/tags/v7.0.1), as on the real run.
			signed: [`${STAGING}@${existing}`],
			// The recovery door is a release dispatch from master: it signs as heads/master.
			env: { STUB_SIGNER: SIGNER('refs/heads/master'), GITHUB_REF: 'refs/heads/master' },
		});
		expect(run.code, run.stdout).toBe(0);
		// Nothing is rebuilt, copied or re-pointed: only signatures are added, AT X.
		expect(run.log.filter((line) => line.startsWith('cosign sign '))).toEqual([
			`cosign sign --yes ${GHCR}@${existing}`,
			`cosign sign --yes ${HUB}@${existing}`,
		]);
		expect(run.log.some((line) => COPY_TO_TARGET.test(line))).toBe(false);
		expect(run.log.some((line) => line.startsWith('cosign copy'))).toBe(false);
		// The anchor (staging@X) verified before the first in-place signature.
		expect(at(run.log, new RegExp(`^cosign verify ${STAGING}@${existing} `))).toBeLessThan(
			at(run.log, /^cosign sign /),
		);
		expect(run.record?.digest).toBe(existing);
		expect(
			(run.record?.registries as { id: string; status: string; verified: boolean }[]).map(
				(item) => [item.id, item.status, item.verified],
			),
		).toEqual([
			['gitdedalo', 'skipped', false],
			['ghcr', 'signed', true],
			['dockerhub', 'signed', true],
		]);
	});

	test('RECOVERY, mixed: one holder signed, one unsigned, the staging anchor not needed → only the unsigned one is signed', () => {
		const existing = D(7);
		const run = publish({
			preset: { [`${GHCR}:7.0.1`]: existing, [`${HUB}:7.0.1`]: existing },
			signed: [`${GHCR}@${existing}`],
		});
		expect(run.code, run.stdout).toBe(0);
		expect(run.log.filter((line) => line.startsWith('cosign sign '))).toEqual([
			`cosign sign --yes ${HUB}@${existing}`,
		]);
		const statuses = (run.record?.registries as { status: string }[]).map((item) => item.status);
		expect(statuses).toEqual(['skipped', 'unchanged', 'signed']);
	});

	test('holders that DISAGREE refuse before anything is signed or copied', () => {
		const run = publish({
			preset: { [`${GHCR}:7.0.1`]: D(7), [`${HUB}:7.0.1`]: D(8) },
			signed: [`${GHCR}@${D(7)}`, `${STAGING}@${D(7)}`],
		});
		expect(run.code).toBe(1);
		expect(run.stdout).toContain('INCONSISTENTLY');
		expect(run.log.some(touchesRelease)).toBe(false);
		expect(run.state(`${HUB}:7.0.1`)).toBe(D(8));
	});

	test('an existing release whose digest verifies NOWHERE official refuses before any sign or copy', () => {
		// Holders of X, none signed; staging@X unsigned too; a signature on ANOTHER digest
		// in staging is not X's.
		const run = publish({
			preset: { [`${GHCR}:7.0.1`]: D(7), [`${HUB}:7.0.1`]: D(7) },
			signed: [`${STAGING}@${BUILT}`],
		});
		expect(run.code).toBe(1);
		expect(run.stdout).toContain(THIS_RELEASE_REFUSAL);
		expect(run.log.some(touchesRelease)).toBe(false);
		// Every official place was asked: each holder, then staging@X.
		for (const ref of [`${GHCR}@${D(7)}`, `${HUB}@${D(7)}`, `${STAGING}@${D(7)}`])
			expect(at(run.log, new RegExp(`^cosign verify ${ref} `))).toBeGreaterThanOrEqual(0);
	});

	test('a single unsigned holder with no anchor refuses, and the missing target is NOT filled', () => {
		const run = publish({ preset: { [`${GHCR}:7.0.1`]: D(7) } });
		expect(run.code).toBe(1);
		expect(run.stdout).toContain(THIS_RELEASE_REFUSAL);
		expect(run.log.some(touchesRelease)).toBe(false);
		expect(run.state(`${HUB}:7.0.1`)).toBeNull();
	});

	test.each([
		['a DEV build (heads/master)', SIGNER('refs/heads/master')],
		['ANOTHER release tag (v7.0.0)', SIGNER('refs/tags/v7.0.0')],
	])(
		'S2: staging@X signed only by %s never anchors this release — refused before any sign or copy',
		(_, identity) => {
			const run = publish({
				preset: { [`${GHCR}:7.0.1`]: D(7), [`${HUB}:7.0.1`]: D(7) },
				signedBy: { [`${STAGING}@${D(7)}`]: identity },
			});
			expect(run.code).toBe(1);
			expect(run.stdout).toContain(THIS_RELEASE_REFUSAL);
			expect(run.log.some(touchesRelease)).toBe(false);
			// The anchor is asked with the EXACT identity of this release, not the shared regexp.
			expect(
				run.log.some((line) =>
					line.startsWith(
						`cosign verify ${STAGING}@${D(7)} --certificate-identity ${SIGNER('refs/tags/v7.0.1')} `,
					),
				),
			).toBe(true);
		},
	);

	test('S2: a holder signed only by heads/master passes the shared verify but does not anchor; with no release signature anywhere → refused', () => {
		const run = publish({
			preset: { [`${GHCR}:7.0.1`]: D(7) },
			signedBy: { [`${GHCR}@${D(7)}`]: SIGNER('refs/heads/master') },
		});
		expect(run.code).toBe(1);
		expect(run.stdout).toContain(THIS_RELEASE_REFUSAL);
		expect(run.log.some(touchesRelease)).toBe(false);
	});

	test('RECOVERY copy: X held unsigned by one target, missing at another, staging@X anchors → copied FROM staging and both signed', () => {
		const existing = D(7);
		const run = publish({
			preset: { [`${GHCR}:7.0.1`]: existing },
			signed: [`${STAGING}@${existing}`],
		});
		expect(run.code, run.stdout).toBe(0);
		expect(run.log.filter((line) => COPY_TO_TARGET.test(line))).toEqual([
			`docker buildx imagetools create -t ${HUB}:7.0.1 ${STAGING}@${existing}`,
		]);
		expect(run.log.filter((line) => line.startsWith('cosign sign '))).toEqual([
			`cosign sign --yes ${GHCR}@${existing}`,
			`cosign sign --yes ${HUB}@${existing}`,
		]);
		expect(
			(run.record?.registries as { id: string; status: string; verified: boolean }[]).map(
				(item) => [item.id, item.status, item.verified],
			),
		).toEqual([
			['gitdedalo', 'skipped', false],
			['ghcr', 'signed', true],
			['dockerhub', 'pushed', true],
		]);
	});

	test('RECOVERY: an in-place signature that fails fails THAT holder (record failed/unverified), the run is red, nothing copied', () => {
		const existing = D(7);
		const run = publish({
			preset: { [`${GHCR}:7.0.1`]: existing, [`${HUB}:7.0.1`]: existing },
			signed: [`${STAGING}@${existing}`],
			env: { STUB_SIGN_FAIL: `${HUB}@${existing}` },
		});
		expect(run.code).toBe(1);
		expect(run.log.some((line) => COPY_TO_TARGET.test(line))).toBe(false);
		expect(reasonOf(run, 'dockerhub')).toBe('signing failed');
		expect(
			(run.record?.registries as { id: string; status: string; verified: boolean }[]).map(
				(item) => [item.id, item.status, item.verified],
			),
		).toEqual([
			['gitdedalo', 'skipped', false],
			['ghcr', 'signed', true],
			['dockerhub', 'failed', false],
		]);
	});

	test('a release tag that APPEARS between the immutability check and the copy is never re-pointed', () => {
		const run = publish({ env: { STUB_APPEAR_REF: `${HUB}:7.0.1`, STUB_APPEAR_DIGEST: D(9) } });
		expect(run.code).toBe(1);
		expect(
			run.log.some((line) => line.startsWith(`docker buildx imagetools create -t ${HUB}:`)),
		).toBe(false);
		expect(run.state(`${HUB}:7.0.1`)).toBe(D(9));
		const hub = (run.record?.registries as { id: string; status: string; reason: string }[]).find(
			(item) => item.id === 'dockerhub',
		);
		expect(hub?.status).toBe('failed');
		expect(hub?.reason).toContain(`appeared as ${D(9)}`);
		expect(run.state(`${GHCR}:7.0.1`)).toBe(BUILT); // the other target still published
	});

	test('a command that HANGS is killed at the per-command ceiling: that target fails, the record is still written', () => {
		const run = publish({
			env: { STUB_SIGN_HANG: `${HUB}@${BUILT}`, IMAGE_RELEASE_COMMAND_TIMEOUT_MS: '5000' },
		});
		expect(run.code).toBe(1);
		expect(run.stdout).toContain('timed out after 5000 ms');
		expect(
			(run.record?.registries as { id: string; status: string; verified: boolean }[]).map(
				(item) => [item.id, item.status, item.verified],
			),
		).toEqual([
			['gitdedalo', 'skipped', false],
			['ghcr', 'pushed', true],
			['dockerhub', 'failed', false],
		]);
	}, 30_000);

	test('S2: a release dispatch from master never MINTS a release — no holder → refused before any sign or copy', () => {
		const run = publish({
			env: { GITHUB_REF: 'refs/heads/master', STUB_SIGNER: SIGNER('refs/heads/master') },
		});
		expect(run.code).toBe(1);
		expect(run.stdout).toContain('a never-published release is published only from its own tag');
		expect(run.log.some(touchesRelease)).toBe(false);
	});

	test('S2: a run on ANOTHER release tag never mints this one either', () => {
		const run = publish({ env: { GITHUB_REF: 'refs/tags/v7.0.0' } });
		expect(run.code).toBe(1);
		expect(run.stdout).toContain('a never-published release is published only from its own tag');
		expect(run.log.some(touchesRelease)).toBe(false);
	});

	test('the fork guard: a release identity outside the list (GITHUB_REPOSITORY=someone/fork) refuses, nothing touched', () => {
		const run = publish({
			preset: { [`${GHCR}:7.0.1`]: D(7) },
			signed: [`${STAGING}@${D(7)}`],
			env: { GITHUB_REPOSITORY: 'someone/fork' },
		});
		expect(run.code).toBe(1);
		expect(run.stdout).toContain("is not inside the list's signing identity");
		expect(run.log.some(touchesRelease)).toBe(false);
	});

	test("a copy that fails is recorded 'copy failed' — and nothing is signed there", () => {
		const run = publish({ env: { STUB_COPY_FAIL: `${HUB}:7.0.1` } });
		expect(run.code).toBe(1);
		expect(reasonOf(run, 'dockerhub')).toBe('copy failed');
		expect(run.log.some((line) => line.startsWith(`cosign sign --yes ${HUB}@`))).toBe(false);
	});

	test("a target's tag that becomes UNREADABLE before the copy is not copied to (unreadable is not absent)", () => {
		const run = publish({ env: { STUB_INSPECT_ERROR_AFTER_FIRST: `${HUB}:7.0.1` } });
		expect(run.code).toBe(1);
		expect(
			run.log.some((line) => line.startsWith(`docker buildx imagetools create -t ${HUB}:`)),
		).toBe(false);
		expect(statusOf(run, 'dockerhub')).toBe('failed');
		expect(reasonOf(run, 'dockerhub')).toContain('unreadable');
		expect(statusOf(run, 'ghcr')).toBe('pushed');
	});

	test('past the verb DEADLINE no target is attempted: the rest fail "deadline exceeded", the record is still written', () => {
		// GHCR's signature hangs; the per-command ceiling is far away, the 4 s budget is not.
		const run = publish({
			env: {
				STUB_SIGN_HANG: `${GHCR}@${BUILT}`,
				IMAGE_RELEASE_COMMAND_TIMEOUT_MS: '60000',
				IMAGE_RELEASE_DEADLINE_MS: '4000',
			},
		});
		expect(run.code).toBe(1);
		expect(run.record).not.toBeNull();
		expect(statusOf(run, 'ghcr')).toBe('failed');
		expect(reasonOf(run, 'dockerhub')).toBe('deadline exceeded');
		expect(run.log.some((line) => line.includes(HUB) && !line.includes('inspect'))).toBe(false);
	}, 30_000);

	test('a REFUSAL after the plan still writes the record: every publish target failed with the reason, digest null', () => {
		const run = publish({ preset: { [`${GHCR}:7.0.1`]: D(7) } });
		expect(run.code).toBe(1);
		expect(run.stdout).toContain(THIS_RELEASE_REFUSAL); // main's ::error:: as before
		expect(run.record?.digest).toBeNull();
		expect(statusOf(run, 'gitdedalo')).toBe('skipped');
		for (const id of ['ghcr', 'dockerhub']) {
			expect(statusOf(run, id)).toBe('failed');
			expect(reasonOf(run, id)).toContain(THIS_RELEASE_REFUSAL);
			expect(rowOf(run, id)?.verified).toBe(false);
		}
		// The summary an operator reads says the same — and never prints a null digest.
		expect(run.summary).toContain('digest: none');
		expect(run.summary).toContain(`| ghcr | \`${GHCR}\` | failed | no | release 7.0.1`);
		expect(run.summary).toContain(`| dockerhub | \`${HUB}\` | failed | no | release 7.0.1`);
		expect(run.summary).not.toContain('@null');
		expect(run.summary).not.toContain('`null`');
	});

	test('a PLAIN error after the plan (a malformed cosign pin file) is recorded too: all targets failed, digest null', () => {
		const badPin = join(scratch, `bad-pin-${runCounter}.json`);
		writeFileSync(badPin, '{ not json');
		const run = publish({ env: { COSIGN_PIN_FILE: badPin } });
		expect(run.code).not.toBe(0);
		expect(run.record?.digest).toBeNull();
		for (const id of ['ghcr', 'dockerhub']) {
			expect(statusOf(run, id)).toBe('failed');
			expect(reasonOf(run, id)?.length ?? 0).toBeGreaterThan(0);
		}
		expect(run.log).toEqual([]);
	});

	test('a record that cannot be WRITTEN is a warning — the ORIGINAL error still decides the run', () => {
		const run = publish({
			preset: { [`${GHCR}:7.0.1`]: D(7) },
			env: { RECORD_PATH: join(scratch, 'no-such-dir', 'image-release.json') },
		});
		expect(run.code).toBe(1);
		expect(run.stdout).toContain('::warning::record not written');
		expect(run.stdout).toContain(`::error::release 7.0.1 already exists`);
		expect(run.record).toBeNull();
	});

	test('a hang BEFORE the per-target loop (a registry login) hits the deadline — and the record is still written', () => {
		const run = publish({ env: { STUB_LOGIN_HANG: '1', IMAGE_RELEASE_DEADLINE_MS: '4000' } });
		expect(run.code).toBe(1);
		expect(run.record).not.toBeNull();
		expect(run.record?.digest).toBeNull();
		for (const id of ['ghcr', 'dockerhub']) {
			expect(statusOf(run, id)).toBe('failed');
			expect(reasonOf(run, id)).toContain('docker login');
		}
		expect(run.log.some(touchesRelease)).toBe(false);
	}, 30_000);

	test('a GREEN publish whose summary cannot be appended keeps its true record and exit 0 (summary is a named warning)', () => {
		const run = publish({
			env: { GITHUB_STEP_SUMMARY: join(scratch, 'no-such-dir', 'summary.md') },
		});
		expect(run.code, run.stdout).toBe(0);
		expect(run.stdout).toContain('::warning::summary not written');
		expect(run.stdout).not.toContain('record not written');
		expect(run.record?.digest).toBe(BUILT);
		for (const id of ['ghcr', 'dockerhub']) {
			expect(statusOf(run, id)).toBe('pushed');
			expect(rowOf(run, id)?.verified).toBe(true);
		}
	});

	test('an error AFTER a target was published keeps what really happened: that target pushed + verified, the real digest', () => {
		// A plain Error thrown at dockerhub's verify, after ghcr was copied, signed and verified.
		const run = publish({ throwOn: `cosign verify ${HUB}@` });
		expect(run.code).toBe(99); // main rethrows a non-Refusal
		expect(run.stdout).toContain('injected failure at: cosign verify');
		// The error record was written (no fallback warning), and ghcr's verify ran clean.
		expect(run.stdout).toContain('record: ');
		expect(run.stdout).not.toContain('record not written');
		expect(run.stdout).not.toContain('::error::ghcr');
		expect(run.record?.digest).toBe(BUILT);
		expect(rowOf(run, 'ghcr')).toMatchObject({ status: 'pushed', verified: true, reason: null });
		// dockerhub WAS pushed (step 6) — kept, unverified, with the error as its reason.
		expect(rowOf(run, 'dockerhub')).toMatchObject({ status: 'pushed', verified: false });
		expect(reasonOf(run, 'dockerhub')).toBe(
			`interrupted: injected failure at: cosign verify ${HUB}@${BUILT} --certificate-identity-regexp ${LIST.signing.identity_regexp} --certificate-oidc-issuer ${LIST.signing.issuer}`,
		);
	});

	test("an interrupted record keeps a target's OWN finished verdict and reason — never the other target's error", () => {
		// ghcr's copy fails on its own (step 6 'copy failed', step 7 final); then a plain Error
		// is thrown at dockerhub's verify.
		const run = publish({
			throwOn: `cosign verify ${HUB}@`,
			env: { STUB_COPY_FAIL: `${GHCR}:7.0.1` },
		});
		expect(run.code).toBe(99);
		expect(run.stdout).toContain(`::error::ghcr: ${GHCR}:7.0.1 is not ${BUILT}`);
		expect(rowOf(run, 'ghcr')).toEqual({
			id: 'ghcr',
			repository: GHCR,
			status: 'failed',
			reason: 'copy failed',
			verified: false,
		});
		expect(reasonOf(run, 'dockerhub')).toStartWith('interrupted: injected failure');
		// A step-6 row whose verify never ran keeps its OWN reason, the interruption appended.
		const early = publish({
			throwOn: `cosign verify ${GHCR}@`,
			env: { STUB_SIGN_FAIL: `${HUB}@${BUILT}` },
		});
		expect(early.code).toBe(99);
		expect(reasonOf(early, 'dockerhub')).toStartWith(
			'signing failed; interrupted: injected failure',
		);
		expect(statusOf(early, 'dockerhub')).toBe('failed');
	});

	test('a TERMINAL record that cannot be written: NOT retried, one warning, the original error, no partial file', () => {
		const NOT_RETRIED = /::warning::record not written \(terminal write, not retried\)/g;
		const dir = join(scratch, `gone-${runCounter}`);
		const recordPath = join(dir, 'image-release.json');
		const run = publish({ env: { RECORD_PATH: recordPath } });
		expect(run.code).not.toBe(0);
		expect(run.stdout.match(NOT_RETRIED)?.length).toBe(1);
		expect(run.stdout.match(/record not written/g)?.length).toBe(1); // no error-record retry
		expect(run.stdout).toContain('ENOENT'); // the original error decides the run
		expect(existsSync(recordPath)).toBe(false);
		expect(existsSync(`${recordPath}.part`)).toBe(false);
		// The rename itself fails (the path is a directory): the written .part is removed.
		const blocked = join(scratch, `blocked-${runCounter}`);
		mkdirSync(join(blocked, 'occupied'), { recursive: true });
		const second = publish({ env: { RECORD_PATH: blocked } });
		expect(second.code).not.toBe(0);
		expect(second.stdout.match(NOT_RETRIED)?.length).toBe(1);
		expect(existsSync(`${blocked}.part`)).toBe(false);
	});

	test('ATOMIC: a write that fails leaves the PREVIOUS record byte-for-byte (an in-place write would clobber it)', () => {
		const dir = join(scratch, `atomic-${runCounter}`);
		mkdirSync(dir, { recursive: true });
		const recordPath = join(dir, 'image-release.json');
		const previous = '{"previous":"bytes","must":"survive"}\n';
		writeFileSync(recordPath, previous);
		// The .part cannot be created (it is a directory) — and cannot be removed either.
		mkdirSync(`${recordPath}.part`);
		const run = publish({ env: { RECORD_PATH: recordPath } });
		expect(run.code).not.toBe(0);
		expect(readFileSync(recordPath, 'utf8')).toBe(previous);
		// The ORIGINAL error (the .part open) is reported — not the failed cleanup's rm error.
		expect(run.stdout).toContain(`illegal operation on a directory, open '${recordPath}.part'`);
		expect(run.stdout).not.toContain('rm returned');
	});

	test('a failing staging signature refuses before anything leaves staging', () => {
		const run = publish({ env: { STUB_SIGN_RC: '1' } });
		expect(run.code).toBe(1);
		expect(run.stdout).toContain('signing the image in staging failed');
		expect(run.log.some((line) => COPY_TO_TARGET.test(line))).toBe(false);
	});

	test('a signature that fails in ONE target registry fails that target and the run; the record says so', () => {
		const run = publish({ env: { STUB_SIGN_FAIL: `${HUB}@${BUILT}` } });
		expect(run.code).toBe(1);
		expect(
			(run.record?.registries as { id: string; status: string; verified: boolean }[]).map(
				(item) => [item.id, item.status, item.verified],
			),
		).toEqual([
			['gitdedalo', 'skipped', false],
			['ghcr', 'pushed', true],
			['dockerhub', 'failed', false],
		]);
	});

	test('a target that cannot be READ refuses (absent and unreadable are different answers)', () => {
		const run = publish({ env: { STUB_INSPECT_ERROR: `${HUB}:7.0.1` } });
		expect(run.code).toBe(1);
		expect(run.stdout).toContain(`cannot read ${HUB}`);
		expect(run.log.some(touchesRelease)).toBe(false);
	});

	test('the DEV channel overwrites its mutable tag', () => {
		const run = publish({ channel: 'dev', preset: { [`${GHCR}:7.0.1-dev`]: D(7) } });
		expect(run.code, run.stdout).toBe(0);
		expect(run.log.filter((line) => COPY_TO_TARGET.test(line))).toEqual([
			`docker buildx imagetools create -t ${GHCR}:7.0.1-dev ${STAGING}@${BUILT}`,
			`docker buildx imagetools create -t ${HUB}:7.0.1-dev ${STAGING}@${BUILT}`,
		]);
		expect(run.state(`${GHCR}:7.0.1-dev`)).toBe(BUILT);
	});

	test('a target left holding another digest after the copy FAILS the run, and the record says so', () => {
		const run = publish({ env: { STUB_COPY_WRONG: `${HUB}:7.0.1` } });
		expect(run.code).toBe(1);
		const hub = (run.record?.registries as { id: string; verified: boolean }[]).find(
			(item) => item.id === 'dockerhub',
		);
		expect(hub?.verified).toBe(false);
		expect(run.stdout).toContain(`::error::dockerhub: ${HUB}:7.0.1 is not ${BUILT}`);
	});
});

// GATE 16 (RELEASE_IDENTITY_DESIGN §3) — a run writes ONE tag to every target and never a
// floating one. Read from the OUTCOME: the tags each target registry holds after the run.
describe('publish — GATE 16: the tag SET a run writes', () => {
	const FLOATING = ['latest', '7', '7.0'];

	test.each([
		['master', '7.0.1'],
		['prerelease', '7.0.1-beta.2'],
		['dev', '7.0.1-dev'],
	] as const)('channel %s: every target ends holding exactly {%s}', (channel, tag) => {
		const run = publish({ channel });
		expect(run.code, run.stdout).toBe(0);
		for (const repository of [GHCR, HUB]) expect(run.tagsHeld(repository)).toEqual([tag]);
		for (const floating of FLOATING)
			expect(
				run.log.some((line) => line.includes(`:${floating} `) || line.endsWith(`:${floating}`)),
			).toBe(false);
		expect(run.record).toMatchObject({ tag, channel, version: '7.0.1' });
	});

	test('a prerelease never touches its triple: an existing stable :7.0.1 keeps its digest, no :7.0.1 is written', () => {
		const stable = D(9);
		const run = publish({
			channel: 'prerelease',
			preset: { [`${GHCR}:7.0.1`]: stable },
		});
		expect(run.code, run.stdout).toBe(0);
		expect(run.tagsHeld(GHCR)).toEqual(['7.0.1', '7.0.1-beta.2']);
		expect(run.state(`${GHCR}:7.0.1`)).toBe(stable);
		expect(run.tagsHeld(HUB)).toEqual(['7.0.1-beta.2']);
		expect(
			run.log.some((line) => /^docker buildx imagetools create -t \S+:7\.0\.1 /.test(line)),
		).toBe(false);
	});

	test('a published prerelease is IMMUTABLE: the existing digest is spread, never re-signed or forced', () => {
		const existing = D(7);
		const run = publish({
			channel: 'prerelease',
			preset: { [`${GHCR}:7.0.1-beta.2`]: existing },
			signed: [`${GHCR}@${existing}`],
		});
		expect(run.code, run.stdout).toBe(0);
		expect(run.log.filter((line) => line.startsWith('cosign sign '))).toEqual([
			`cosign sign --yes ${HUB}@${existing}`,
		]);
		expect(run.log.filter((line) => COPY_TO_TARGET.test(line))).toEqual([
			`docker buildx imagetools create -t ${HUB}:7.0.1-beta.2 ${GHCR}@${existing}`,
		]);
	});

	test.each([
		['prerelease', '7.0.1', 'its bare triple'],
		['prerelease', '7.0.2-beta.1', "another triple's prerelease"],
		['prerelease', '7.0.1-dev', 'a dev tag'],
		['master', 'latest', 'latest'],
		['master', '7.0', 'a minor float'],
		['master', '7', 'a major float'],
		['master', '7.0.1-beta.2', 'a prerelease'],
		['dev', '7.0.1', 'a release tag'],
		['dev', 'latest', 'latest'],
	] as const)('channel %s refuses TAG %s (%s) before ANY command', (channel, tag) => {
		const run = publish({ channel, env: { TAG: tag } });
		expect(run.code).toBe(1);
		expect(run.stdout).toContain(`TAG '${tag}' is not the`);
		expect(run.log).toEqual([]);
	});
});

// GATE 16, second half — the SIGNING IDENTITY of a prerelease-tag run. A keyless signature
// carries the workflow's identity at the ref the run was triggered from
// (…/image-release.yml@refs/tags/v7.0.1-beta.2); `cosign verify` — the publish verb's own,
// the installer's, the image updater's, the operator's — accepts it only through
// engineering/image_registries.json signing.identity_regexp. The stub verifies exactly that.
const SIGNER = (ref: string) =>
	`https://github.com/dedalia-org/dedalo/.github/workflows/image-release.yml@${ref}`;

describe('publish — GATE 16: a prerelease-tag run passes the verify that reads the list', () => {
	test('signed at refs/tags/v7.0.1-beta.2: every target verifies with the list regexp', () => {
		const run = publish({
			channel: 'prerelease',
			env: { STUB_SIGNER: SIGNER('refs/tags/v7.0.1-beta.2') },
		});
		expect(run.code, run.stdout).toBe(0);
		const verified = (run.record?.registries as { id: string; verified: boolean }[]).filter(
			(item) => item.verified,
		);
		expect(verified.map((item) => item.id)).toEqual(['ghcr', 'dockerhub']);
	});

	test('CONTROL: a signature from another ref fails the same verify, and the run with it', () => {
		const run = publish({
			channel: 'prerelease',
			env: { STUB_SIGNER: SIGNER('refs/heads/feature') },
		});
		expect(run.code).toBe(1);
		expect(run.stdout).toContain('with a valid signature');
	});

	test('the regexp accepts every release tag of the shared grammar and the dev branch — nothing else', () => {
		const identity = new RegExp(LIST.signing.identity_regexp);
		const ordering = JSON.parse(
			readFileSync(join(ROOT, 'test', 'fixtures', 'release_identity', 'ordering.json'), 'utf8'),
		) as { ascending: string[]; not_identities: string[] };
		expect(ordering.ascending.length).toBeGreaterThan(10);
		for (const version of ordering.ascending)
			expect(identity.test(SIGNER(`refs/tags/v${version}`)), version).toBe(true);
		expect(identity.test(SIGNER('refs/heads/master'))).toBe(true);
		for (const ref of [
			'refs/heads/feature',
			'refs/tags/v7.0.1-beta.2-evil',
			'refs/tags/v7.0.1-gamma.1',
			'refs/tags/v7.0.1-beta',
			'refs/tags/v7.0.1.dev',
			'refs/tags/x7.0.1',
		])
			expect(identity.test(SIGNER(ref)), ref).toBe(false);
		expect(
			identity.test(
				'https://github.com/dedalia-org/dedalo/.github/workflows/ci.yml@refs/tags/v7.0.1-beta.2',
			),
		).toBe(false);
	});
});

/**
 * A GitHub Actions filter pattern (the subset image-release.yml's `on.push.tags` uses) as
 * a RegExp over the whole tag name: `[…]` a class, `+` one or more of the preceding
 * character/class, `*` any run without `/`, `?` zero or one of the preceding; everything
 * else literal (`.` included — GitHub treats it as a plain character).
 */
function githubFilter(pattern: string): RegExp {
	let source = '';
	for (let i = 0; i < pattern.length; i++) {
		const char = pattern[i] as string;
		if (char === '[') {
			const end = pattern.indexOf(']', i);
			source += pattern.slice(i, end + 1);
			i = end;
		} else if (char === '+' || char === '?') source += char;
		else if (char === '*') source += '[^/]*';
		else source += char.replace(/[.\\^$|(){}]/g, '\\$&');
	}
	return new RegExp(`^${source}$`);
}

describe('the trigger — every release tag reaches `plan`, which validates it exactly', () => {
	const workflow = Bun.YAML.parse(
		readFileSync(join(ROOT, '.github', 'workflows', 'image-release.yml'), 'utf8'),
	) as { on: { push: { tags: string[] } } };
	const triggers = workflow.on.push.tags.map(githubFilter);
	const ordering = JSON.parse(
		readFileSync(join(ROOT, 'test', 'fixtures', 'release_identity', 'ordering.json'), 'utf8'),
	) as { ascending: string[]; not_identities: string[] };
	const fake: PlanGit = { declaredAt: () => null, commitOf: () => null, fileAt: () => null };
	const planOf = (tag: string) =>
		resolvePlan(
			{ event: 'push', ref: `refs/tags/${tag}`, sha: 'x', inputChannel: '', inputTag: '' },
			fake,
			STAGING,
		);

	test('every stable AND prerelease identity of the shared ordering fixture triggers a run', () => {
		expect(ordering.ascending.some((version) => version.includes('-'))).toBe(true);
		for (const version of ordering.ascending)
			expect(
				triggers.some((trigger) => trigger.test(`v${version}`)),
				`v${version}`,
			).toBe(true);
	});

	test('no trigger fires for a branch-shaped or developer name', () => {
		for (const name of ['v7.0.0.dev', 'v7.0.0-dev', 'v7.0', 'release-7.0.0', 'v7.0.0-pre.1'])
			expect(
				triggers.some((trigger) => trigger.test(name)),
				name,
			).toBe(false);
	});

	test('what the globs cannot say, plan refuses: every non-identity, trigger-matching ones included', () => {
		const matching = ordering.not_identities.filter((name) =>
			triggers.some((trigger) => trigger.test(`v${name}`)),
		);
		expect(matching).toContain('7.0.0-beta.01'); // the glob is wider than the grammar
		for (const name of ordering.not_identities)
			expect(() => planOf(`v${name}`), name).toThrow('is not a release tag');
	});
});

describe('time bounds — every verb finishes (and records) before GitHub kills its job', () => {
	test('the per-command ceilings and verb budgets are the documented defaults; bad overrides fall back', async () => {
		const { commandTimeoutMs, verbBudgetMs } = await import('../../scripts/ci/image_release.ts');
		expect(commandTimeoutMs('publish', {})).toBe(8 * 60_000);
		expect(verbBudgetMs('publish', {})).toBe(22 * 60_000);
		expect(commandTimeoutMs('plan', {})).toBe(5 * 60_000);
		for (const bad of ['0', 'abc', '-5', ''])
			expect(commandTimeoutMs('publish', { IMAGE_RELEASE_COMMAND_TIMEOUT_MS: bad })).toBe(
				8 * 60_000,
			);
		expect(commandTimeoutMs('publish', { IMAGE_RELEASE_COMMAND_TIMEOUT_MS: '1234' })).toBe(1234);
		expect(verbBudgetMs('publish', { IMAGE_RELEASE_DEADLINE_MS: 'x' })).toBe(22 * 60_000);
	});

	test("each job: its verbs' budgets + its declared non-verb overhead fit its timeout-minutes; each ceiling within its verb's budget", async () => {
		const { COMMAND_TIMEOUT_MS, JOB_OVERHEAD_MS, VERB_BUDGET_MS, VERB_JOBS } = await import(
			'../../scripts/ci/image_release.ts'
		);
		const workflow = Bun.YAML.parse(
			readFileSync(join(ROOT, '.github', 'workflows', 'image-release.yml'), 'utf8'),
		) as { jobs: Record<string, { 'timeout-minutes'?: number; steps: { run?: string }[] }> };
		const perJob = new Map<string, number>();
		for (const [verb, job] of Object.entries(VERB_JOBS)) {
			const definition = workflow.jobs[job];
			expect(definition, job).toBeDefined();
			// The map is honest: that job really runs that verb.
			expect(
				definition?.steps.some((step) =>
					new RegExp(`image_release\\.ts ${verb}\\b`).test(step.run ?? ''),
				),
				`${job} runs ${verb}`,
			).toBe(true);
			expect(COMMAND_TIMEOUT_MS[verb], verb).toBeLessThanOrEqual(VERB_BUDGET_MS[verb] as number);
			perJob.set(job, (perJob.get(job) ?? 0) + (VERB_BUDGET_MS[verb] as number));
		}
		// Every verb the workflow runs is mapped.
		const runs = Object.values(workflow.jobs).flatMap((job) =>
			job.steps.flatMap((step) => [...(step.run ?? '').matchAll(/image_release\.ts (\w+)/g)]),
		);
		expect(runs.length).toBeGreaterThan(0);
		for (const match of runs) expect(Object.keys(VERB_JOBS)).toContain(match[1] as string);
		// Every job that runs a verb declares its non-verb allowance, with a reason — and the
		// allowance is ENFORCED: every step carries a step timeout; the non-verb steps' sum
		// fits the allowance, each verb step outlasts its verb's budget (the program's own
		// deadline fires first), and all step timeouts together fit the job's.
		expect(Object.keys(JOB_OVERHEAD_MS).sort()).toEqual([...perJob.keys()].sort());
		for (const job of perJob.keys()) {
			const steps = workflow.jobs[job]?.steps ?? [];
			let nonVerb = 0;
			let all = 0;
			for (const step of steps) {
				const minutes = (step as { 'timeout-minutes'?: number })['timeout-minutes'];
				expect(minutes, `${job}: every step has timeout-minutes`).toBeGreaterThan(0);
				all += (minutes as number) * 60_000;
				const verb = /image_release\.ts (\w+)/.exec(step.run ?? '')?.[1];
				if (verb === undefined) nonVerb += (minutes as number) * 60_000;
				else
					expect((minutes as number) * 60_000, `${job}/${verb}`).toBeGreaterThan(
						VERB_BUDGET_MS[verb] as number,
					);
			}
			// The set-up/post reserve is explicit, with its reason, and counted.
			const overhead = JOB_OVERHEAD_MS[job];
			expect(overhead?.setupMs ?? 0, `${job} setupMs`).toBeGreaterThan(0);
			expect(overhead?.setupReason ?? '', `${job} setupReason`).not.toBe('');
			expect(
				nonVerb + (overhead?.setupMs ?? 0),
				`${job} non-verb steps + set-up reserve`,
			).toBeLessThanOrEqual(overhead?.ms ?? 0);
			expect(all, `${job} all steps`).toBeLessThanOrEqual(
				(workflow.jobs[job]?.['timeout-minutes'] ?? 0) * 60_000,
			);
		}
		for (const [job, budget] of perJob) {
			const limit = workflow.jobs[job]?.['timeout-minutes'];
			const overhead = JOB_OVERHEAD_MS[job];
			expect(limit, `${job} timeout-minutes`).toBeGreaterThan(0);
			expect(overhead?.ms ?? 0, `${job} overhead`).toBeGreaterThan(0);
			expect(overhead?.reason ?? '', `${job} overhead reason`).not.toBe('');
			expect(budget + (overhead?.ms ?? 0), job).toBeLessThanOrEqual((limit as number) * 60_000);
		}
	});
});

describe('the pure verdicts', () => {
	test('immutability: absent everywhere is fresh, and an error is never read as absent', async () => {
		const { immutabilityVerdict } = await import('../../scripts/ci/image_release.ts');
		const absent: ManifestState = { state: 'absent' };
		expect(immutabilityVerdict('master', [{ repository: 'a', state: absent }])).toEqual({
			kind: 'fresh',
			overwrite: false,
		});
		expect(() =>
			immutabilityVerdict('master', [{ repository: 'a', state: { state: 'error', detail: 'x' } }]),
		).toThrow(Refusal);
		expect(
			immutabilityVerdict('dev', [{ repository: 'a', state: { state: 'error', detail: 'x' } }]),
		).toEqual({
			kind: 'fresh',
			overwrite: true,
		});
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// plan — the code server's release rules, on a real scratch repository
// ─────────────────────────────────────────────────────────────────────────────

const VERSION_TS = (triple: string) =>
	`export const DEDALO_VERSION_TRIPLE = Object.freeze([${triple.replaceAll('.', ', ')}]);\n`;

describe('plan — which release a run publishes', () => {
	let repo = '';
	const git = (...args: string[]) => {
		const result = Bun.spawnSync(['git', '-C', repo, ...args], { stdout: 'pipe', stderr: 'pipe' });
		expect(result.exitCode, `git ${args.join(' ')}: ${result.stderr.toString()}`).toBe(0);
		return result.stdout.toString().trim();
	};
	const commitVersion = (triple: string) => {
		mkdirSync(join(repo, 'src', 'core', 'update'), { recursive: true });
		writeFileSync(join(repo, 'src', 'core', 'update', 'version.ts'), VERSION_TS(triple));
		git('add', '.');
		git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', triple);
		return git('rev-parse', 'HEAD');
	};
	let releaseSha = '';
	let masterSha = '';
	/** A commit declaring 7.0.3 under a LIGHTWEIGHT v7.0.3 (describe ignores it). */
	let lightSha = '';
	/** A dev-branch commit that IS a release commit: annotated v7.0.2-rc.1. */
	let rcSha = '';
	const annotated = (tag: string) =>
		git('-c', 'user.name=t', '-c', 'user.email=t@t', 'tag', '-a', tag, '-m', tag);
	/** The changelog cut of `identity` (`bun run changelog release`), committed with the next commit. */
	const cut = (identity: string) => {
		mkdirSync(join(repo, 'changes', identity), { recursive: true });
		writeFileSync(
			join(repo, 'changes', identity, 'release.json'),
			`${JSON.stringify({ version: identity, date: '2026-10-15', from: null, to: `v${identity}`, commits: 1, wire_contract: [] }, null, '\t')}\n`,
		);
	};
	/** An ANNOTATED v7.0.4 whose version.ts agrees but whose release was never CUT. */
	let uncutSha = '';
	/** An ANNOTATED, CUT prerelease v7.0.2-beta.1 (declares 7.0.2). */
	let betaSha = '';
	/** A CUT prerelease v7.0.2-beta.2 under a LIGHTWEIGHT tag (describe ignores it). */
	let lightBetaSha = '';

	beforeAll(() => {
		repo = mkdtempSync(join(tmpdir(), 'dedalo-image-plan-'));
		git('init', '--quiet', '-b', 'master');
		// The REAL stamp machinery: the committed placeholder + its export-subst line,
		// so the plan reads the identity a real archive of each commit expands to.
		mkdirSync(join(repo, 'src', 'core', 'update'), { recursive: true });
		writeFileSync(join(repo, BUILD_INFO_PATH), readFileSync(join(ROOT, BUILD_INFO_PATH), 'utf8'));
		writeFileSync(join(repo, '.gitattributes'), `${BUILD_INFO_PATH} export-subst\n`);
		cut('7.0.1');
		releaseSha = commitVersion('7.0.1');
		annotated('v7.0.1');
		git('branch', 'rel');
		git('tag', 'v7.0.2'); // a tag whose tree still declares 7.0.1
		git('tag', 'v7.0.1-beta.1');
		masterSha = commitVersion('7.0.2');
		git('branch', 'v7');
		git('checkout', '--quiet', '-b', 'light');
		cut('7.0.3');
		lightSha = commitVersion('7.0.3');
		git('tag', 'v7.0.3');
		git('checkout', '--quiet', '-b', 'uncut', masterSha);
		uncutSha = commitVersion('7.0.4');
		annotated('v7.0.4');
		git('checkout', '--quiet', '-b', 'rc', masterSha);
		writeFileSync(join(repo, 'rc.txt'), 'rc\n');
		git('add', '.');
		git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'rc');
		rcSha = git('rev-parse', 'HEAD');
		annotated('v7.0.2-rc.1');
		git('checkout', '--quiet', '-b', 'beta', masterSha);
		cut('7.0.2-beta.1');
		betaSha = commitVersion('7.0.2');
		annotated('v7.0.2-beta.1');
		git('checkout', '--quiet', '-b', 'lightbeta', masterSha);
		cut('7.0.2-beta.2');
		lightBetaSha = commitVersion('7.0.2');
		git('tag', 'v7.0.2-beta.2');
		git('checkout', '--quiet', 'master');
	});
	afterAll(() => rmSync(repo, { recursive: true, force: true }));

	let ghLog = '';
	function plan(env: Record<string, string>): {
		code: number;
		out: Record<string, string>;
		text: string;
		gh: string[];
	} {
		const tmp = mkdtempSync(join(tmpdir(), 'dedalo-image-plan-run-'));
		try {
			const outputs = join(tmp, 'out');
			// `gh` stub: the Actions API's count of successful push runs per workflow file
			// (STUB_GH_<CI|DB>, default 1 = green), STUB_GH_FAIL=1 → the API errors; argv logged.
			const bin = join(tmp, 'bin');
			mkdirSync(bin);
			writeFileSync(
				join(bin, 'gh'),
				[
					'#!/bin/sh',
					'printf "gh %s\\n" "$*" >> "$GH_LOG"',
					'[ "${STUB_GH_FAIL:-0}" = 1 ] && { echo "HTTP 502" >&2; exit 1; }',
					'case "$*" in',
					'  */ci.yml/runs*) echo "${STUB_GH_CI:-1}" ;;',
					'  */db.yml/runs*) echo "${STUB_GH_DB:-1}" ;;',
					'  *) echo "unexpected gh call" >&2; exit 2 ;;',
					'esac',
					'',
				].join('\n'),
				{ mode: 0o755 },
			);
			// `git` stub: STUB_GIT_VERSION answers `git --version`; everything else is the real git.
			writeFileSync(
				join(bin, 'git'),
				[
					'#!/bin/sh',
					'if [ -n "${STUB_GIT_VERSION:-}" ] && [ "$1" = --version ]; then echo "$STUB_GIT_VERSION"; exit 0; fi',
					`exec ${REAL_GIT} "$@"`,
					'',
				].join('\n'),
				{ mode: 0o755 },
			);
			ghLog = join(tmp, 'gh.log');
			const proc = Bun.spawnSync([process.execPath, PROGRAM, 'plan'], {
				cwd: repo,
				env: {
					PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
					HOME: tmp,
					RUNNER_TEMP: tmp,
					GITHUB_OUTPUT: outputs,
					GITHUB_REPOSITORY: 'dedalia-org/dedalo',
					GH_LOG: ghLog,
					...env,
				},
				stdout: 'pipe',
				stderr: 'pipe',
			});
			const lines = existsSync(outputs) ? readFileSync(outputs, 'utf8').trim().split('\n') : [];
			const out = Object.fromEntries(
				lines.map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
			);
			return {
				code: proc.exitCode ?? 1,
				out,
				text: proc.stdout.toString() + proc.stderr.toString(),
				gh: existsSync(ghLog) ? readFileSync(ghLog, 'utf8').trim().split('\n') : [],
			};
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	}

	test('a stable tag push whose version.ts agrees publishes X.Y.Z, release posture', () => {
		const result = plan({
			GITHUB_EVENT_NAME: 'push',
			GITHUB_REF: 'refs/tags/v7.0.1',
			GITHUB_SHA: releaseSha,
		});
		expect(result.code, result.text).toBe(0);
		expect(result.out).toMatchObject({
			version: '7.0.1',
			tag: '7.0.1',
			channel: 'master',
			source_sha: releaseSha,
			staging: STAGING,
			expected_engine_version: '7.0.1',
		});
		// The archive digest IS the git archive of the release commit.
		const tar = join(repo, '..', `plan-check-${Date.now()}.tar`);
		git('archive', '--format=tar', '-o', tar, releaseSha);
		expect(result.out.archive_sha256).toBe(sha256File(tar));
		rmSync(tar, { force: true });
	});

	test('a tag whose version.ts declares another version is refused', () => {
		const result = plan({
			GITHUB_EVENT_NAME: 'push',
			GITHUB_REF: 'refs/tags/v7.0.2',
			GITHUB_SHA: releaseSha,
		});
		expect(result.code).toBe(1);
		expect(result.text).toContain('declares 7.0.1');
		expect(result.out).toEqual({});
	});

	test('a release tag whose commit carries no changelog cut (changes/<v>/release.json) is refused, nothing planned', () => {
		const result = plan({
			GITHUB_EVENT_NAME: 'push',
			GITHUB_REF: 'refs/tags/v7.0.4',
			GITHUB_SHA: uncutSha,
		});
		expect(result.code).toBe(1);
		expect(result.text).toContain('carries no changes/7.0.4/release.json');
		expect(result.text).toContain('bun run changelog release 7.0.4');
		expect(result.out).toEqual({});
	});

	test(`an archiving git older than ${MIN_GIT_FOR_DESCRIBE} is refused before the archive; ${MIN_GIT_FOR_DESCRIBE} passes`, () => {
		const old = plan({
			GITHUB_EVENT_NAME: 'workflow_dispatch',
			GITHUB_REF: 'refs/heads/master',
			GITHUB_SHA: masterSha,
			INPUT_CHANNEL: 'dev',
			STUB_GIT_VERSION: 'git version 2.34.8',
		});
		expect(old.code).toBe(1);
		expect(old.text).toContain(`git 2.34 cannot expand %(describe`);
		expect(old.text).not.toContain('git archive --format=tar');
		expect(old.out).toEqual({});
		const minimum = plan({
			GITHUB_EVENT_NAME: 'workflow_dispatch',
			GITHUB_REF: 'refs/heads/master',
			GITHUB_SHA: masterSha,
			INPUT_CHANNEL: 'dev',
			STUB_GIT_VERSION: `git version ${MIN_GIT_FOR_DESCRIBE}.0`,
		});
		expect(minimum.code, minimum.text).toBe(0);
	});

	// A PRERELEASE TAG IS A RELEASE (RELEASE_IDENTITY_DESIGN §2.8.4, owner Q1).
	const betaPush = {
		GITHUB_EVENT_NAME: 'push',
		GITHUB_REF: 'refs/tags/v7.0.2-beta.1',
	};
	test('a prerelease tag push publishes its identity: tag X.Y.Z-beta.N, channel prerelease, held to the full gate', () => {
		const result = plan({ ...betaPush, GITHUB_SHA: betaSha });
		expect(result.code, result.text).toBe(0);
		expect(result.out).toMatchObject({
			version: '7.0.2',
			tag: '7.0.2-beta.1',
			channel: 'prerelease',
			source_sha: betaSha,
			staging: STAGING,
			expected_engine_version: '7.0.2-beta.1',
		});
		expect(result.gh).toHaveLength(FULL_GATE_WORKFLOWS.length);
		const red = plan({ ...betaPush, GITHUB_SHA: betaSha, STUB_GH_CI: '0' });
		expect(red.code).toBe(1);
		expect(red.text).toContain('has no green FULL gate');
		expect(red.out).toEqual({});
	});

	test('GATE 16, end to end: the prerelease plan → publish writes {X.Y.Z-beta.N} only, the tag the installer asks for', () => {
		const planned = plan({ ...betaPush, GITHUB_SHA: betaSha });
		expect(planned.code, planned.text).toBe(0);
		const { version, tag, channel } = planned.out as Record<string, string>;
		const run = publish({
			channel: channel as 'prerelease',
			env: { VERSION: version as string, TAG: tag as string },
		});
		expect(run.code, run.stdout).toBe(0);
		for (const repository of [GHCR, HUB])
			expect(run.tagsHeld(repository)).toEqual(['7.0.2-beta.1']);
		// The installer of THIS release (its archive's own build stamp, resolved as the
		// engine resolves it) asks the registry for exactly the tag the run wrote (§2.5).
		const tar = join(repo, '..', `beta-stamp-${Date.now()}.tar`);
		git('archive', '--format=tar', '-o', tar, betaSha, BUILD_INFO_PATH);
		const stamp = Bun.spawnSync(['tar', '-xOf', tar, BUILD_INFO_PATH], { stdout: 'pipe' });
		rmSync(tar, { force: true });
		const identity = resolveReleaseIdentity({
			triple: [7, 0, 2],
			describe: parseBuildInfo(stamp.stdout.toString()).describe,
			provenance: { stamp: 'other', channel: 'prerelease' },
		});
		expect(identity.version).toBe(planned.out.expected_engine_version as string);
		const answers = { image_version: '' } as Parameters<typeof imageVersionOf>[0];
		expect(imageVersionOf(answers, identity)).toBe(tag as string);
		expect(acceptedImageVersions(identity)).toContain(tag as string);
	});

	test('the release-tag check (gate 11) runs for a prerelease tag: an uncut v7.0.2-rc.1 is refused', () => {
		const result = plan({
			GITHUB_EVENT_NAME: 'push',
			GITHUB_REF: 'refs/tags/v7.0.2-rc.1',
			GITHUB_SHA: rcSha,
		});
		expect(result.code).toBe(1);
		expect(result.text).toContain('carries no changes/7.0.2-rc.1/release.json');
		expect(result.out).toEqual({});
	});

	test('a prerelease whose tag is LIGHTWEIGHT is refused before any build (its archive would say .dev)', () => {
		const result = plan({
			GITHUB_EVENT_NAME: 'push',
			GITHUB_REF: 'refs/tags/v7.0.2-beta.2',
			GITHUB_SHA: lightBetaSha,
		});
		expect(result.code).toBe(1);
		expect(result.text).toContain('calls itself 7.0.2.dev, not 7.0.2-beta.2');
		expect(result.out).toEqual({});
	});

	test('a release dispatch re-publishes an existing PRERELEASE tag, also run from that tag', () => {
		const result = plan({
			GITHUB_EVENT_NAME: 'workflow_dispatch',
			GITHUB_REF: 'refs/tags/v7.0.2-beta.1',
			GITHUB_SHA: betaSha,
			INPUT_CHANNEL: 'release',
			INPUT_TAG: 'v7.0.2-beta.1',
		});
		expect(result.code, result.text).toBe(0);
		expect(result.out).toMatchObject({ tag: '7.0.2-beta.1', channel: 'prerelease' });
	});

	test('a dev dispatch from master is X.Y.Z-dev, reporting X.Y.Z.dev', () => {
		const result = plan({
			GITHUB_EVENT_NAME: 'workflow_dispatch',
			GITHUB_REF: 'refs/heads/master',
			GITHUB_SHA: masterSha,
			INPUT_CHANNEL: 'dev',
		});
		expect(result.code, result.text).toBe(0);
		expect(result.out).toMatchObject({
			tag: '7.0.2-dev',
			channel: 'dev',
			expected_engine_version: '7.0.2.dev',
		});
	});

	test('a release whose tag is LIGHTWEIGHT is refused before any build (its archive would say .dev)', () => {
		const result = plan({
			GITHUB_EVENT_NAME: 'push',
			GITHUB_REF: 'refs/tags/v7.0.3',
			GITHUB_SHA: lightSha,
		});
		expect(result.code).toBe(1);
		expect(result.text).toContain('calls itself 7.0.3.dev, not 7.0.3');
		expect(result.text).toContain('ANNOTATED');
		expect(result.out).toEqual({});
	});

	test('a dev dispatch whose commit IS a release commit expects the TAG identity (owner Q5)', () => {
		const result = plan({
			GITHUB_EVENT_NAME: 'workflow_dispatch',
			GITHUB_REF: 'refs/heads/master',
			GITHUB_SHA: rcSha,
			INPUT_CHANNEL: 'dev',
		});
		expect(result.code, result.text).toBe(0);
		expect(result.out).toMatchObject({
			tag: '7.0.2-dev',
			channel: 'dev',
			expected_engine_version: '7.0.2-rc.1',
		});
	});

	test('a dev dispatch from another branch is refused', () => {
		const result = plan({
			GITHUB_EVENT_NAME: 'workflow_dispatch',
			GITHUB_REF: 'refs/heads/v7',
			GITHUB_SHA: masterSha,
			INPUT_CHANNEL: 'dev',
		});
		expect(result.code).toBe(1);
		expect(result.text).toContain('only from refs/heads/master');
	});

	test('a release dispatch re-publishes an EXISTING tag only', () => {
		const ok = plan({
			GITHUB_EVENT_NAME: 'workflow_dispatch',
			GITHUB_REF: 'refs/heads/master',
			GITHUB_SHA: masterSha,
			INPUT_CHANNEL: 'release',
			INPUT_TAG: 'v7.0.1',
		});
		expect(ok.code, ok.text).toBe(0);
		expect(ok.out).toMatchObject({ tag: '7.0.1', source_sha: releaseSha });
		const missing = plan({
			GITHUB_EVENT_NAME: 'workflow_dispatch',
			GITHUB_REF: 'refs/heads/master',
			GITHUB_SHA: masterSha,
			INPUT_CHANNEL: 'release',
			INPUT_TAG: 'v7.0.9',
		});
		expect(missing.code).toBe(1);
		expect(missing.text).toContain('does not exist');
	});

	test("a release dispatch run on ANOTHER release tag's ref is refused at plan (no v7.0.2-beta.1 run publishing v7.0.1)", () => {
		const other = plan({
			GITHUB_EVENT_NAME: 'workflow_dispatch',
			GITHUB_REF: 'refs/tags/v7.0.2-beta.1',
			GITHUB_SHA: betaSha,
			INPUT_CHANNEL: 'release',
			INPUT_TAG: 'v7.0.1',
		});
		expect(other.code).toBe(1);
		expect(other.text).toContain('runs from refs/heads/master or from that same tag');
		expect(other.out).toEqual({});
	});

	// A release is cut only from a commit the FULL gate passed on GitHub (2026-10-10):
	// a successful push run of ci.yml (hermetic) AND db.yml (db + instance) at that sha.
	const tagPush = { GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/tags/v7.0.1' };
	test('a release asks the Actions API for green push runs of ci.yml AND db.yml at its commit', () => {
		const result = plan({ ...tagPush, GITHUB_SHA: releaseSha });
		expect(result.code, result.text).toBe(0);
		expect(result.gh).toHaveLength(FULL_GATE_WORKFLOWS.length);
		for (const workflow of FULL_GATE_WORKFLOWS)
			expect(result.gh).toContainEqual(
				`gh api -X GET repos/dedalia-org/dedalo/actions/workflows/${workflow}/runs -f head_sha=${releaseSha} -f event=push -f status=success --jq .total_count`,
			);
	});

	test('a release whose commit lacks a green ci.yml or db.yml push run is REFUSED, nothing planned', () => {
		for (const [key, workflow] of [
			['STUB_GH_CI', 'ci.yml'],
			['STUB_GH_DB', 'db.yml'],
		] as const) {
			const result = plan({ ...tagPush, GITHUB_SHA: releaseSha, [key]: '0' });
			expect(result.code).toBe(1);
			expect(result.text).toContain(`release commit ${releaseSha} has no green FULL gate`);
			expect(result.text).toContain(`${workflow} (no successful push run)`);
			expect(result.out).toEqual({});
		}
		// The release DISPATCH (re-publishing an existing tag) is held the same way.
		const dispatched = plan({
			GITHUB_EVENT_NAME: 'workflow_dispatch',
			GITHUB_REF: 'refs/heads/master',
			GITHUB_SHA: masterSha,
			INPUT_CHANNEL: 'release',
			INPUT_TAG: 'v7.0.1',
			STUB_GH_DB: '0',
		});
		expect(dispatched.code).toBe(1);
		expect(dispatched.text).toContain('db.yml (no successful push run)');
	});

	test('an unreadable Actions API refuses (fail closed); a dev build never asks', () => {
		const down = plan({ ...tagPush, GITHUB_SHA: releaseSha, STUB_GH_FAIL: '1' });
		expect(down.code).toBe(1);
		expect(down.text).toContain('runs unreadable');
		const noRepo = plan({ ...tagPush, GITHUB_SHA: releaseSha, GITHUB_REPOSITORY: '' });
		expect(noRepo.code).toBe(1);
		expect(noRepo.text).toContain('runs unreadable');
		const dev = plan({
			GITHUB_EVENT_NAME: 'workflow_dispatch',
			GITHUB_REF: 'refs/heads/master',
			GITHUB_SHA: masterSha,
			INPUT_CHANNEL: 'dev',
			STUB_GH_FAIL: '1',
		});
		expect(dev.code, dev.text).toBe(0);
		expect(dev.gh).toEqual([]);
	});

	// THE BUILD JOB'S ARCHIVE MUST BE THE PLAN'S. build_info.txt expands %(describe) from
	// the tags the archiving clone holds and from git's abbreviation length, so the
	// context step runs here in OTHER clones of the fixture, as the build job's runner
	// would, against the digest the plan published.
	function context(clone: string, sha: string, expected: string): { code: number; text: string } {
		const tmp = mkdtempSync(join(tmpdir(), 'dedalo-image-context-run-'));
		try {
			const proc = Bun.spawnSync([process.execPath, PROGRAM, 'context'], {
				cwd: clone,
				env: {
					PATH: process.env.PATH ?? '/usr/bin:/bin',
					HOME: tmp,
					RUNNER_TEMP: tmp,
					GITHUB_OUTPUT: join(tmp, 'out'),
					SOURCE_SHA: sha,
					EXPECTED_ARCHIVE_SHA256: expected,
				},
				stdout: 'pipe',
				stderr: 'pipe',
			});
			return { code: proc.exitCode ?? 1, text: proc.stdout.toString() + proc.stderr.toString() };
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	}
	function cloneOf(...args: string[]): string {
		const dir = join(mkdtempSync(join(tmpdir(), 'dedalo-image-clone-')), 'c');
		const cloned = Bun.spawnSync(['git', 'clone', '--quiet', ...args, `file://${repo}`, dir], {
			stdout: 'pipe',
			stderr: 'pipe',
		});
		expect(cloned.exitCode, cloned.stderr.toString()).toBe(0);
		return dir;
	}

	test("another FULL clone archives the plan's exact bytes — also off a tag, whatever its core.abbrev", () => {
		const release = plan({ ...tagPush, GITHUB_SHA: releaseSha });
		const dev = plan({
			GITHUB_EVENT_NAME: 'workflow_dispatch',
			GITHUB_REF: 'refs/heads/master',
			GITHUB_SHA: masterSha,
			INPUT_CHANNEL: 'dev',
		});
		expect(release.code, release.text).toBe(0);
		expect(dev.code, dev.text).toBe(0);
		const clone = cloneOf();
		// A different default abbreviation is what another runner's object count gives.
		expect(Bun.spawnSync(['git', '-C', clone, 'config', 'core.abbrev', '13']).exitCode).toBe(0);
		try {
			const releaseContext = context(clone, releaseSha, release.out.archive_sha256 as string);
			expect(releaseContext.code, releaseContext.text).toBe(0);
			const devContext = context(clone, masterSha, dev.out.archive_sha256 as string);
			expect(devContext.code, devContext.text).toBe(0);
		} finally {
			rmSync(join(clone, '..'), { recursive: true, force: true });
		}
	});

	test("a SHALLOW, TAGLESS clone (actions/checkout's default) is refused at the context step", () => {
		const release = plan({ ...tagPush, GITHUB_SHA: releaseSha });
		expect(release.code, release.text).toBe(0);
		const shallow = cloneOf('--depth=1', '--no-tags', '--branch', 'rel');
		try {
			const refused = context(shallow, releaseSha, release.out.archive_sha256 as string);
			expect(refused.code).toBe(1);
			expect(refused.text).toContain('the arches would carry different provenance');
		} finally {
			rmSync(join(shallow, '..'), { recursive: true, force: true });
		}
	});

	test('so every image-release job that archives (plan, context) checks out the full history with its tags', () => {
		type Step = { uses?: string; run?: string; with?: Record<string, unknown> };
		const workflow = Bun.YAML.parse(
			readFileSync(join(ROOT, '.github', 'workflows', 'image-release.yml'), 'utf8'),
		) as { jobs: Record<string, { steps: Step[] }> };
		const archiving = Object.entries(workflow.jobs).filter(([, job]) =>
			job.steps.some((step) => /image_release\.ts (plan|context)\b/.test(step.run ?? '')),
		);
		expect(archiving.map(([name]) => name).sort()).toEqual(['build', 'plan']);
		for (const [name, job] of archiving) {
			const checkouts = job.steps.filter((step) =>
				(step.uses ?? '').startsWith('actions/checkout@'),
			);
			expect(checkouts.length, name).toBeGreaterThan(0);
			for (const checkout of checkouts) expect(checkout.with?.['fetch-depth'], name).toBe(0);
		}
	});

	test('fullGateFault: green only when every full-gate workflow has ≥1 successful push run', () => {
		const of = (ci: number | null, db: number | null) =>
			fullGateFault(
				'abc',
				new Map([
					['ci.yml', ci],
					['db.yml', db],
				]),
			);
		expect(of(1, 2)).toBeNull();
		expect(of(0, 1)).toContain('ci.yml (no successful push run)');
		expect(of(1, null)).toContain('db.yml (runs unreadable)');
		expect(fullGateFault('abc', new Map())).toContain('ci.yml (runs unreadable)');
	});

	test('any other event never publishes', () => {
		const fake: PlanGit = { declaredAt: () => '7.0.1', commitOf: () => 'x', fileAt: () => null };
		for (const event of ['pull_request', 'schedule', 'workflow_run'])
			expect(() =>
				resolvePlan(
					{ event, ref: 'refs/tags/v7.0.1', sha: 'x', inputChannel: '', inputTag: '' },
					fake,
					STAGING,
				),
			).toThrow('never publishes');
	});
});

describe('the build stamps what operators verify', () => {
	test('the image declares its tag as org.opencontainers.image.version (bound by the signature)', () => {
		// dedalo_verify_release (deploy/dedalo-image-lib.sh) refuses a signed image whose
		// version label is not the tag it was pulled under: without this label every
		// official pull would be refused, and without the check a re-pointed mirror tag
		// could serve an older signed release as a newer one.
		const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'image-release.yml'), 'utf8');
		expect(workflow).toMatch(
			/^\s+org\.opencontainers\.image\.version=\$\{\{ needs\.plan\.outputs\.tag \}\}$/m,
		);
		const lib = readFileSync(join(ROOT, 'deploy', 'dedalo-image-lib.sh'), 'utf8');
		expect(lib).toContain('org.opencontainers.image.version');
	});
});

describe('smoke — what the container is asked to prove', () => {
	test('it pulls the exact reference and runs every assertion with the plan’s expectations', () => {
		const dir = mkdtempSync(join(tmpdir(), 'dedalo-image-smoke-'));
		try {
			const log = join(dir, 'log');
			const output = join(dir, 'github_output');
			const image = `${STAGING}@${BUILT}`;
			const smokeRun = (overrides: Record<string, string>) =>
				Bun.spawnSync([process.execPath, PROGRAM, 'smoke'], {
					cwd: ROOT,
					env: {
						PATH: `${stubDir}:/usr/bin:/bin`,
						STUB_LOG: log,
						STUB_STATE: dir,
						GITHUB_OUTPUT: output,
						IMAGE: image,
						ARCH: 'arm64',
						EXPECTED_ENGINE_VERSION: '7.0.1',
						CHANNEL: 'master',
						ARCHIVE_SHA256: 'b'.repeat(64),
						...overrides,
					},
					stdout: 'pipe',
					stderr: 'pipe',
				});
			// A TAG is refused before anything runs: only a digest can be handed on.
			const tagged = smokeRun({ IMAGE: `${STAGING}:run-42-arm64` });
			expect(tagged.exitCode).toBe(1);
			expect(tagged.stdout.toString()).toContain('is not pinned by digest');
			expect(existsSync(log)).toBe(false);
			const proc = smokeRun({});
			expect(proc.exitCode, proc.stderr.toString()).toBe(0);
			// The leg hands on exactly the digest it smoke-tested, under its arch's name.
			expect(readFileSync(output, 'utf8')).toBe(`digest_arm64=${BUILT}\n`);
			const lines = readFileSync(log, 'utf8').trimEnd().split('\n');
			expect(lines[0]).toBe(`docker pull ${image}`);
			expect(lines[1]).toContain(
				`docker run --rm -e WANT_BUN=${readFileSync(join(ROOT, '.bun-version'), 'utf8').trim()}`,
			);
			expect(lines[1]).toContain(
				'-e WANT_VERSION=7.0.1 -e WANT_KIND=stable -e WANT_CHANNEL=master',
			);
			// An expectation that is no release identity is refused before anything runs.
			rmSync(log, { force: true });
			const garbage = smokeRun({ EXPECTED_ENGINE_VERSION: '7.0.1-pre.1' });
			expect(garbage.exitCode).toBe(1);
			expect(garbage.stdout.toString()).toContain('is not a release identity');
			expect(lines[1]).toContain(`${image} sh -euc`);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
		for (const assertion of [
			'$WANT_BUN',
			'/etc/dedalo/image_tree',
			'PostgreSQL) 18',
			'ffmpeg',
			'rsvg-convert',
			'id -u)" = 1000',
			'/srv/dedalo/client',
			'master_dedalo/deploy',
			'INSTALLED_CHANNEL',
			'INSTALLED_DIGEST',
		])
			expect(SMOKE_SCRIPT, assertion).toContain(assertion);
		// The served-identity fragment is PART of the container's script, not a side copy.
		expect(SMOKE_SCRIPT).toContain(
			SMOKE_HEALTH_SCRIPT.slice(SMOKE_HEALTH_SCRIPT.indexOf('P="$(mktemp')),
		);
		// The script is valid POSIX sh.
		expect(Bun.spawnSync(['sh', '-n', '-c', SMOKE_SCRIPT]).exitCode).toBe(0);
	});
});

describe('smoke — GATE 10: the identity the image SERVES on /health', () => {
	/** SMOKE_HEALTH_SCRIPT run as the container runs it — here, in this checkout's tree. */
	const servedCheck = (want: { version: string; kind: string }) => {
		const proc = Bun.spawnSync(['sh', '-euc', SMOKE_HEALTH_SCRIPT], {
			cwd: ROOT,
			env: {
				PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
				WANT_VERSION: want.version,
				WANT_KIND: want.kind,
			},
			stdout: 'pipe',
			stderr: 'pipe',
		});
		return { code: proc.exitCode ?? 1, text: proc.stdout.toString() + proc.stderr.toString() };
	};

	test("the real server, booted with no database, serves this tree's own identity — and only that passes", () => {
		const own = { version: RELEASE_IDENTITY.version, kind: RELEASE_IDENTITY.kind };
		const served = servedCheck(own);
		expect(served.code, served.text).toBe(0);
		// Negative control: a wrong expectation is red, and its failure carries the server's
		// own log — the value compared is what a listener SERVED, not a constant read.
		const wrong = servedCheck({ version: `${own.version}-not-this`, kind: own.kind });
		expect(wrong.code).toBe(1);
		expect(wrong.text).toContain(`/health serves '${own.version} ${own.kind}'`);
		expect(wrong.text).toContain('listening on unix socket');
		const wrongKind = servedCheck({
			version: own.version,
			kind: own.kind === 'dev' ? 'stable' : 'dev',
		});
		expect(wrongKind.code).toBe(1);
	}, 120_000);
});
