/**
 * IMAGE RELEASE — scripts/ci/image_release.ts, EXECUTED (installer unification D1).
 *
 * The release workflow cannot be run from a test (it pushes, signs, holds secrets), so
 * its program is run here as the workflow runs it — `bun scripts/ci/image_release.ts
 * <verb>` — with `docker`, `curl` and the downloaded `cosign` replaced by ONE recording
 * stub on PATH. The stub keeps a tiny registry in a state directory (reference →
 * digest), so a copy, an inspect and a verify see each other's effects, and every
 * invocation is appended to a log. What is asserted is the OUTCOME and the ORDER of
 * effects, which is the safety argument of the publish verb:
 *
 *   - an unpinned cosign, or a downloaded binary whose sha256 is not the pin, refuses
 *     before ANY registry command;
 *   - an unprovisioned registry is skipped with its reason; a provisioned one whose
 *     secrets are absent is skipped LOUDLY (::warning::) and the others still publish;
 *   - nothing is signed before every target was inspected (immutability), nothing is
 *     copied before it is signed, nothing is verified before it is copied;
 *   - release channel: holders that disagree refuse before signing or copying; an
 *     existing release without the official signature refuses before copying; agreeing
 *     holders are kept and the missing target receives THEIR digest, never a rebuild;
 *   - dev channel: the tag is overwritten (`cosign copy --force`);
 *   - a target that ends with another digest fails the run, and the record says so;
 *   - the record (image-release.json) has the documented schema.
 * The plan rules run on a REAL scratch git repository (tags, version.ts, branches): a
 * stable tag whose version.ts agrees publishes; a disagreeing tag, a prerelease tag and
 * a developer build off another branch are refused; a developer build of master is
 * X.Y.Z-dev / X.Y.Z.dev.
 *
 * HONEST LIMIT: `smoke` is checked for what it asks the container to prove (the pulled
 * reference, the expectations, every assertion in its script) — the script itself runs
 * only inside the Debian image (uid 1000, GNU stat), i.e. on the first real release run.
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
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	FULL_GATE_WORKFLOWS,
	fullGateFault,
	type ManifestState,
	type PlanGit,
	Refusal,
	resolvePlan,
	SMOKE_SCRIPT,
	sha256File,
} from '../../scripts/ci/image_release.ts';
import {
	IMAGE_REGISTRIES_PATH,
	type ImageRegistryList,
	validateImageRegistries,
} from '../../src/core/update/image_registries.ts';

const ROOT = join(import.meta.dir, '..', '..');
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
case "$me" in
  curl)
    out=""; while [ $# -gt 0 ]; do [ "$1" = "-o" ] && out="$2"; shift; done
    cp "$STUB_COSIGN_SOURCE" "$out"; exit 0 ;;
  docker)
    case "$1 $2 $3" in
      "login "*) cat >/dev/null; exit 0 ;;
      "buildx imagetools create") printf '%s' "$STUB_BUILT" > "$STUB_STATE/$(key "$5")"; exit 0 ;;
      "buildx imagetools inspect")
        if [ -n "\${STUB_INSPECT_ERROR:-}" ] && [ "$4" = "$STUB_INSPECT_ERROR" ]; then echo "unauthorized: denied" >&2; exit 1; fi
        d="$(digest_of "$4")"
        if [ -z "$d" ]; then echo "ERROR: $4: not found" >&2; exit 1; fi
        printf '{"mediaType":"application/vnd.oci.image.index.v1+json","digest":"%s"}\\n' "$d"; exit 0 ;;
      *) exit 0 ;;
    esac ;;
  cosign)
    case "$1" in
      sign) exit "\${STUB_SIGN_RC:-0}" ;;
      copy)
        [ "$2" = "--force" ] && shift
        d="$(digest_of "$2")"
        [ -n "\${STUB_COPY_WRONG:-}" ] && [ "$3" = "$STUB_COPY_WRONG" ] && d="sha256:$(printf 'f%.0s' $(seq 64))"
        printf '%s' "$d" > "$STUB_STATE/$(key "$3")"; exit 0 ;;
      verify)
        case " \${STUB_UNSIGNED:-} " in *" $(digest_of "$2") "*) echo "no matching signatures" >&2; exit 1 ;; esac
        exit 0 ;;
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
	state: (ref: string) => string | null;
}

let runCounter = 0;

/** One `publish` run in a fresh state dir; `preset` seeds the stub registry. */
function publish(options: {
	channel?: 'master' | 'dev';
	preset?: Record<string, string>;
	env?: Record<string, string>;
	pin?: { version: string | null; linux_amd64_sha256: string | null };
}): Run {
	const dir = join(scratch, `run-${++runCounter}`);
	const state = join(dir, 'state');
	mkdirSync(state, { recursive: true });
	const key = (ref: string) => ref.replaceAll(/[/:@]/g, '_');
	for (const [ref, digest] of Object.entries(options.preset ?? {}))
		writeFileSync(join(state, key(ref)), digest);
	const pinFile = join(dir, 'cosign.json');
	writeFileSync(
		pinFile,
		JSON.stringify(
			options.pin ?? { version: '9.9.9', linux_amd64_sha256: sha256File(cosignSource) },
		),
	);
	const channel = options.channel ?? 'master';
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
		TAG: channel === 'dev' ? '7.0.1-dev' : '7.0.1',
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
	const proc = Bun.spawnSync([process.execPath, PROGRAM, 'publish'], {
		cwd: ROOT,
		env,
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const logPath = join(dir, 'log');
	return {
		code: proc.exitCode ?? 1,
		stdout: proc.stdout.toString() + proc.stderr.toString(),
		log: existsSync(logPath) ? readFileSync(logPath, 'utf8').trimEnd().split('\n') : [],
		record: existsSync(env.RECORD_PATH as string)
			? (JSON.parse(readFileSync(env.RECORD_PATH as string, 'utf8')) as Record<string, unknown>)
			: null,
		state: (ref) =>
			existsSync(join(state, key(ref))) ? readFileSync(join(state, key(ref)), 'utf8') : null,
	};
}

/** Index of the first log line matching, -1 when none. */
const at = (log: string[], pattern: RegExp): number => log.findIndex((line) => pattern.test(line));
const lastAt = (log: string[], pattern: RegExp): number =>
	log.reduce((found, line, i) => (pattern.test(line) ? i : found), -1);
const GHCR = REPO.ghcr as string;
const HUB = REPO.dockerhub as string;

describe('publish — the order of effects is the safety argument', () => {
	test('a fresh release: index once, every target inspected, signed once, copied, verified — one digest', () => {
		const run = publish({});
		expect(run.code, run.stdout).toBe(0);
		const { log } = run;
		const create = at(log, /^docker buildx imagetools create /);
		const sign = at(log, /^cosign sign /);
		const firstCopy = at(log, /^cosign copy /);
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
		expect(sign).toBeLessThan(firstCopy); // nothing copied unsigned
		expect(log.filter((line) => line.startsWith('cosign sign '))).toEqual([
			`cosign sign --yes ${STAGING}@${BUILT}`,
		]);
		// The index is assembled from the SMOKE-TESTED digests, never from a staging tag.
		expect(log.filter((line) => line.startsWith('docker buildx imagetools create '))).toEqual([
			`docker buildx imagetools create -t ${STAGING}:7.0.1-run-42 ${STAGING}@${ARCH_AMD64} ${STAGING}@${ARCH_ARM64}`,
		]);
		expect(log.some((line) => line.includes(':run-42-'))).toBe(false);
		expect(log.filter((line) => line.startsWith('cosign copy '))).toEqual([
			`cosign copy ${STAGING}@${BUILT} ${GHCR}:7.0.1`,
			`cosign copy ${STAGING}@${BUILT} ${HUB}:7.0.1`,
		]);
		const verifies = log.filter((line) => line.startsWith('cosign verify '));
		expect(verifies.map((line) => line.split(' ')[2])).toEqual([
			`${GHCR}@${BUILT}`,
			`${HUB}@${BUILT}`,
		]);
		expect(verifies[0]).toContain(`--certificate-identity-regexp ${LIST.signing.identity_regexp}`);
		expect(verifies[0]).toContain(`--certificate-oidc-issuer ${LIST.signing.issuer}`);
		expect(at(log, /^cosign verify /)).toBeGreaterThan(lastAt(log, /^cosign copy /));
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
	test('agreeing holders are kept; the missing target receives THEIR digest — never a rebuild or re-sign', () => {
		const existing = D(7);
		const run = publish({ preset: { [`${GHCR}:7.0.1`]: existing } });
		expect(run.code, run.stdout).toBe(0);
		expect(run.log.some((line) => line.startsWith('cosign sign '))).toBe(false);
		expect(run.log.filter((line) => line.startsWith('cosign copy '))).toEqual([
			`cosign copy ${GHCR}@${existing} ${HUB}:7.0.1`,
		]);
		// The official signature of the existing release is checked before it is spread.
		expect(at(run.log, new RegExp(`^cosign verify ${GHCR}@${existing} `))).toBeLessThan(
			at(run.log, /^cosign copy /),
		);
		expect(run.state(`${HUB}:7.0.1`)).toBe(existing);
		expect(run.record?.digest).toBe(existing);
		const statuses = (run.record?.registries as { id: string; status: string }[]).map(
			(item) => item.status,
		);
		expect(statuses).toEqual(['skipped', 'unchanged', 'pushed']);
	});

	test('holders that DISAGREE refuse before anything is signed or copied', () => {
		const run = publish({ preset: { [`${GHCR}:7.0.1`]: D(7), [`${HUB}:7.0.1`]: D(8) } });
		expect(run.code).toBe(1);
		expect(run.stdout).toContain('INCONSISTENTLY');
		expect(run.log.some((line) => /^cosign (sign|copy) /.test(line))).toBe(false);
		expect(run.state(`${HUB}:7.0.1`)).toBe(D(8));
	});

	test('an existing release WITHOUT the official signature refuses before any copy', () => {
		const run = publish({ preset: { [`${GHCR}:7.0.1`]: D(7) }, env: { STUB_UNSIGNED: D(7) } });
		expect(run.code).toBe(1);
		expect(run.stdout).toContain('does not carry the official signature');
		expect(run.log.some((line) => /^cosign (sign|copy) /.test(line))).toBe(false);
		expect(run.state(`${HUB}:7.0.1`)).toBeNull();
	});

	test('a target that cannot be READ refuses (absent and unreadable are different answers)', () => {
		const run = publish({ env: { STUB_INSPECT_ERROR: `${HUB}:7.0.1` } });
		expect(run.code).toBe(1);
		expect(run.stdout).toContain(`cannot read ${HUB}`);
		expect(run.log.some((line) => /^cosign (sign|copy) /.test(line))).toBe(false);
	});

	test('the DEV channel overwrites its mutable tag', () => {
		const run = publish({ channel: 'dev', preset: { [`${GHCR}:7.0.1-dev`]: D(7) } });
		expect(run.code, run.stdout).toBe(0);
		expect(run.log.filter((line) => line.startsWith('cosign copy '))).toEqual([
			`cosign copy --force ${STAGING}@${BUILT} ${GHCR}:7.0.1-dev`,
			`cosign copy --force ${STAGING}@${BUILT} ${HUB}:7.0.1-dev`,
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

	beforeAll(() => {
		repo = mkdtempSync(join(tmpdir(), 'dedalo-image-plan-'));
		git('init', '--quiet', '-b', 'master');
		releaseSha = commitVersion('7.0.1');
		git('tag', 'v7.0.1');
		git('tag', 'v7.0.2'); // a tag whose tree still declares 7.0.1
		git('tag', 'v7.0.1-beta.1');
		masterSha = commitVersion('7.0.2');
		git('branch', 'v7');
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

	test('a prerelease tag is refused', () => {
		const result = plan({
			GITHUB_EVENT_NAME: 'push',
			GITHUB_REF: 'refs/tags/v7.0.1-beta.1',
			GITHUB_SHA: releaseSha,
		});
		expect(result.code).toBe(1);
		expect(result.text).toContain('prerelease tags are never published');
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
		const fake: PlanGit = { declaredAt: () => '7.0.1', commitOf: () => 'x' };
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
			expect(lines[1]).toContain('-e WANT_VERSION=7.0.1 -e WANT_CHANNEL=master');
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
			'DEDALO_ENGINE_VERSION',
			'INSTALLED_CHANNEL',
			'INSTALLED_DIGEST',
		])
			expect(SMOKE_SCRIPT, assertion).toContain(assertion);
		// The script is valid POSIX sh.
		expect(Bun.spawnSync(['sh', '-n', '-c', SMOKE_SCRIPT]).exitCode).toBe(0);
	});
});
