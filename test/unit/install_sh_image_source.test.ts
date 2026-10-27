/**
 * install.sh — WHERE THE IMAGE COMES FROM, and the shared host library it is
 * decided with (installer unification D2, 2026-10-09).
 *
 * The compose stacks no longer build: they run `${DEDALO_IMAGE}:${DEDALO_VERSION}`
 * from `.dedalo.env`. install.sh asks where that image comes from — one of
 * Dédalo's official registries (the GENERATED deploy/image_registries.sh), a
 * registry of your own, or a local build — and every later update takes it
 * from the same place. The decisions live in deploy/dedalo-image-lib.sh, shared
 * with deploy/dedalo-image-update.sh and the host updater, so this gate EXECUTES
 * the library under bash with stub `docker`/`cosign` binaries and checks each
 * answer against the engine's own definition of the same thing:
 *
 *  A. the checkout version equals parseDeclaredTriple (code_build_plan.ts) on
 *     the real version.ts and on fixtures, malformed ones included;
 *  B. the .dedalo.env reader/writer: a set keeps every other line byte for
 *     byte, appends an absent key, is atomic and owner-only;
 *  C. the grammars equal isRepositoryReference / normalizeRepository /
 *     the release identity's image-tag grammar and semver order
 *     (identityOfImageTag / compareReleaseIdentities) over a corpus — the full
 *     parity is release_identity_shell_parity;
 *  D. the registry probe (available / absent / unknown) and the default rule:
 *     the first official registry that publishes the version, else a build;
 *  E. the offered set equals the provisioned entries of the ONE list
 *     (engineering/image_registries.json), primary first; the signing identity
 *     cannot be inherited from the environment; cosign verification refuses
 *     without an identity;
 *  F. (terminal installer phase 4: install.sh is a bootstrap; the image is the
 *     TypeScript step stack_image's) the installer DECIDES LIKE THE LIBRARY:
 *     its cosign argv is dedalo_cosign_verify's, its verifyImage refuses a bad
 *     signature and a re-pointed tag (label ≠ tag) and claims no signature for
 *     a registry of your own or a local build; the .dedalo.env it renders is
 *     complete for dedalo_env_problems, its five image keys read back as the
 *     TS answers, and its compose argv EQUALS dedalo_compose_args' (plain and
 *     build) — one stack for the installer, the updater and the operator.
 *
 * No network, no daemon: every docker/cosign is a stub on PATH in a temp dir.
 */

import { afterAll, describe, expect, test } from 'bun:test';
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
import { join } from 'node:path';
import type { HostCtx } from '../../src/core/install/host/contract.ts';
import { hostFs } from '../../src/core/install/host/fs.ts';
import { type RecordedResponse, recordingRunner } from '../../src/core/install/host/runner.ts';
import { composeFiles } from '../../src/core/install/host/stack/compose.ts';
import { STACK_BINARIES } from '../../src/core/install/host/stack/facts.ts';
import { renderEnvFile, renderOverride } from '../../src/core/install/host/stack/files.ts';
import {
	BUILD_CONTEXT,
	buildContextDir,
	IMAGE_BUILDER,
	imageCommands,
} from '../../src/core/install/host/stack/image.ts';
import { cosignCommand, verifyImage } from '../../src/core/install/host/stack/image_verify.ts';
import {
	imageRepositoryOf,
	imageVerifyOf,
	imageVersionOf,
	stackFileOf,
} from '../../src/core/install/host/stack/layout.ts';
import { emptyHostCreated, type StackImage } from '../../src/core/install/host/state_types.ts';
import { newInstallState } from '../../src/core/install/run_files_core.ts';
import { BUILD_INFO_PATH, readReleaseIdentityOf } from '../../src/core/update/build_stamp.ts';
import { parseDeclaredTriple } from '../../src/core/update/code_build_plan.ts';
import {
	isRepositoryReference,
	loadImageRegistries,
	normalizeRepository,
	provisionedRegistries,
} from '../../src/core/update/image_registries.ts';
import {
	compareReleaseIdentities,
	identityOfImageTag,
	imageTagOf,
} from '../../src/core/update/release_identity.ts';
import { DEDALO_VERSION_TRIPLE } from '../../src/core/update/version.ts';
import { stackPlanCtx } from '../helpers/install_host_scratch.ts';
import {
	PINNED_IDENTITY,
	pinInstallerIdentity,
	withInstallerIdentity,
} from '../helpers/installer_identity.ts';
import { scratchRunEntries } from '../helpers/scratch_run_entries.ts';

// The installer's release identity is the checkout's (a tagged commit says `-beta.N`, the
// next commit `.dev`) and the image decisions follow its kind: these cases are written for
// a STABLE installer, so they pin one (test/helpers/installer_identity.ts).
pinInstallerIdentity(PINNED_IDENTITY.stable);

const REPO_ROOT = join(import.meta.dir, '..', '..');
const LIB = join(REPO_ROOT, 'deploy', 'dedalo-image-lib.sh');
const REGISTRIES_SH = join(REPO_ROOT, 'deploy', 'image_registries.sh');
const SCRATCH = mkdtempSync(join(tmpdir(), 'dedalo-install-image-'));
let scratchCount = 0;

afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

function scratchDir(): string {
	scratchCount += 1;
	const dir = join(SCRATCH, `case-${scratchCount}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

interface BashRun {
	code: number;
	stdout: string;
	stderr: string;
}

/** Run `body` under `set -euo pipefail` with the library + the generated list loaded. */
function bash(
	body: string,
	options: { args?: string[]; cwd?: string; env?: Record<string, string>; stdin?: string } = {},
): BashRun {
	const script = [
		'set -euo pipefail',
		`. ${JSON.stringify(LIB)}`,
		`dedalo_registries_load ${JSON.stringify(REGISTRIES_SH)}`,
		body,
	].join('\n');
	const run = Bun.spawnSync(['bash', '-c', script, 'lib', ...(options.args ?? [])], {
		cwd: options.cwd ?? SCRATCH,
		env: { PATH: '/usr/bin:/bin', ...options.env },
		stdin: options.stdin === undefined ? undefined : new TextEncoder().encode(options.stdin),
	});
	return {
		code: run.exitCode ?? -1,
		stdout: new TextDecoder().decode(run.stdout),
		stderr: new TextDecoder().decode(run.stderr),
	};
}

// ---------------------------------------------------------------------------
// A. The checkout version.
// ---------------------------------------------------------------------------

/** dedalo_checkout_version over a tree whose version.ts holds `source`; null on failure. */
function checkoutVersion(source: string | null): string | null {
	const dir = scratchDir();
	if (source !== null) {
		mkdirSync(join(dir, 'src', 'core', 'update'), { recursive: true });
		writeFileSync(join(dir, 'src', 'core', 'update', 'version.ts'), source);
	}
	const run = bash('dedalo_checkout_version "$1"', { args: [dir] });
	return run.code === 0 ? run.stdout : null;
}

const VERSION_FIXTURES: Record<string, string> = {
	multiLine: 'export const T = Object.freeze([\n\t7, 1, 2,\n]) as [number, number, number];\n',
	singleLine: 'export const T = Object.freeze([8,0,13]);\n',
	spacedEverywhere: 'Object.freeze([ \t\n  9 \n , \r\n 4\t,\n\n 0 \n ])',
	crlf: 'export const T = Object.freeze([\r\n\t7,\r\n\t0,\r\n\t3,\r\n]);\r\n',
	firstOfTwo: 'Object.freeze([7, 2, 0]);\nObject.freeze([9, 9, 9]);\n',
	leadingZeros: 'Object.freeze([07, 00, 1])',
	twoNumbers: 'Object.freeze([7, 0])',
	spaceBeforeParen: 'Object.freeze ([7, 0, 0])',
	splitDigits: 'Object.freeze([7 1, 0, 0])',
	fourNumbers: 'Object.freeze([7, 0, 0, 1])',
	noTriple: 'export const DEDALO_VERSION = "7.0.0";\n',
	empty: '',
};

describe('A. the checkout version is parseDeclaredTriple, in bash', () => {
	test('the real version.ts', () => {
		const source = readFileSync(join(REPO_ROOT, 'src', 'core', 'update', 'version.ts'), 'utf8');
		const expected = parseDeclaredTriple(source);
		expect(expected, 'the real version.ts declares no triple').not.toBeNull();
		const run = bash('dedalo_checkout_version "$1"', { args: [REPO_ROOT] });
		expect(run.code).toBe(0);
		expect(run.stdout).toBe(expected as string);
	});

	test('every fixture: the same triple, or the same refusal', () => {
		let accepted = 0;
		let refused = 0;
		for (const [name, source] of Object.entries(VERSION_FIXTURES)) {
			const expected = parseDeclaredTriple(source);
			expect({ name, got: checkoutVersion(source) }).toEqual({ name, got: expected });
			if (expected === null) refused += 1;
			else accepted += 1;
		}
		// Both directions are exercised, or the comparison proves nothing.
		expect(accepted).toBeGreaterThan(4);
		expect(refused).toBeGreaterThan(3);
	});

	test('an unreadable tree is a failure, not an empty version', () => {
		expect(checkoutVersion(null)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// B. The .dedalo.env reader and writer.
// ---------------------------------------------------------------------------

const ENV_BEFORE = [
	'# Written by install.sh — compose variable substitution only.',
	'POSTGRES_PASSWORD=pa$$w0rd"with\\odd=chars',
	'',
	'   indented line kept as is   ',
	'DEDALO_VERSION=7.0.0',
	'DEDALO_IMAGE="ghcr.io/x/y"',
	"QUOTED='single'",
	'WINDOWS=crlf\r',
	'DEDALO_VERSION=7.0.1',
	'LAST_WITHOUT_NEWLINE=1',
].join('\n');

describe('B. .dedalo.env: read like compose, rewritten line-preserving and atomic', () => {
	test('get: the last line wins, one pair of quotes is removed, an absent key is empty', () => {
		const dir = scratchDir();
		const file = join(dir, '.dedalo.env');
		writeFileSync(file, ENV_BEFORE);
		const get = (key: string): string =>
			bash('dedalo_env_get "$1" "$2"', { args: [file, key] }).stdout;
		expect(get('DEDALO_VERSION')).toBe('7.0.1');
		expect(get('DEDALO_IMAGE')).toBe('ghcr.io/x/y');
		expect(get('QUOTED')).toBe('single');
		expect(get('WINDOWS')).toBe('crlf');
		expect(get('LAST_WITHOUT_NEWLINE')).toBe('1');
		expect(get('POSTGRES_PASSWORD')).toBe('pa$$w0rd"with\\odd=chars');
		expect(get('ABSENT')).toBe('');
		expect(bash('dedalo_env_get "$1" "bad key"', { args: [file] }).code).toBe(2);
	});

	test("get/set follow COMPOSE's line rules: indentation, export, inline comments, quoted comments", () => {
		// What an operator pastes from a manual or a refusal: compose reads these lines
		// (verified with `docker compose config`), so the updater must read them alike.
		const dir = scratchDir();
		const file = join(dir, '.dedalo.env');
		const text = [
			'    DEDALO_IMAGE=localhost/dedalo  # missing',
			'DEDALO_VERSION=7.0.1   # the version this checkout declares',
			'export DEDALO_IMAGE_MODE=build',
			'DEDALO_IMAGE_VERIFY="none" # quoted, then a comment',
			"DEDALO_COMPOSE_FILE='docker-compose.yml'",
			'HASH_IN_VALUE=a#b',
			'# DEDALO_VERSION=9.9.9 a commented-out line assigns nothing',
			'PREFIXED_DEDALO_VERSION=8.0.0',
		].join('\n');
		writeFileSync(file, `${text}\n`);
		const get = (key: string): string =>
			bash('dedalo_env_get "$1" "$2"', { args: [file, key] }).stdout;
		expect({
			DEDALO_IMAGE: get('DEDALO_IMAGE'),
			DEDALO_VERSION: get('DEDALO_VERSION'),
			DEDALO_IMAGE_MODE: get('DEDALO_IMAGE_MODE'),
			DEDALO_IMAGE_VERIFY: get('DEDALO_IMAGE_VERIFY'),
			DEDALO_COMPOSE_FILE: get('DEDALO_COMPOSE_FILE'),
			HASH_IN_VALUE: get('HASH_IN_VALUE'),
		}).toEqual({
			DEDALO_IMAGE: 'localhost/dedalo',
			DEDALO_VERSION: '7.0.1',
			DEDALO_IMAGE_MODE: 'build',
			DEDALO_IMAGE_VERIFY: 'none',
			DEDALO_COMPOSE_FILE: 'docker-compose.yml',
			HASH_IN_VALUE: 'a#b',
		});
		expect(bash('dedalo_env_problems "$1"', { args: [file] }).stdout).toBe('');
		// set replaces the line compose reads (here: the indented one), not a duplicate.
		expect(bash('dedalo_env_set "$1" DEDALO_IMAGE ghcr.io/x/y', { args: [file] }).code).toBe(0);
		const after = readFileSync(file, 'utf8').split('\n');
		expect(after[0]).toBe('DEDALO_IMAGE=ghcr.io/x/y');
		expect(after.filter((line) => line.includes('DEDALO_IMAGE='))).toHaveLength(1);
		expect(after.slice(1, -1)).toEqual(text.split('\n').slice(1));
	});

	test('set: every other line byte-identical, the key replaced in place, owner-only, no temp left', () => {
		const dir = scratchDir();
		const file = join(dir, '.dedalo.env');
		writeFileSync(file, ENV_BEFORE, { mode: 0o644 });
		const run = bash('dedalo_env_set "$1" DEDALO_VERSION 7.0.2', { args: [file] });
		expect(run.code, run.stderr).toBe(0);
		const before = ENV_BEFORE.split('\n');
		const after = readFileSync(file, 'utf8').split('\n');
		// The file gains exactly its missing final newline.
		expect(after.length).toBe(before.length + 1);
		expect(after.at(-1)).toBe('');
		for (const [index, line] of before.entries()) {
			const expected = line.startsWith('DEDALO_VERSION=') ? 'DEDALO_VERSION=7.0.2' : line;
			expect({ index, line: after[index] }).toEqual({ index, line: expected });
		}
		expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(scratchRunEntries(dir)).toEqual(['.dedalo.env']);
	});

	test('set: an absent key is appended; a line break or a bad key is refused and changes nothing', () => {
		const dir = scratchDir();
		const file = join(dir, '.dedalo.env');
		writeFileSync(file, 'A=1\n');
		expect(bash('dedalo_env_set "$1" NEW_KEY value', { args: [file] }).code).toBe(0);
		expect(readFileSync(file, 'utf8')).toBe('A=1\nNEW_KEY=value\n');
		expect(bash(`dedalo_env_set "$1" NEW_KEY $'two\\nlines'`, { args: [file] }).code).toBe(2);
		expect(bash('dedalo_env_set "$1" "bad key" v', { args: [file] }).code).toBe(2);
		expect(bash('dedalo_env_set "$1/missing" A v', { args: [dir] }).code).toBe(1);
		expect(readFileSync(file, 'utf8')).toBe('A=1\nNEW_KEY=value\n');
	});
});

// ---------------------------------------------------------------------------
// C. The grammars equal the engine's.
// ---------------------------------------------------------------------------

const REPOSITORY_CORPUS = [
	'ghcr.io/dedalia-org/dedalo',
	'docker.io/example/dedalo',
	'example/dedalo',
	'localhost/dedalo',
	'localhost:5000/dedalo',
	'registry.example.org:443/a/b/c',
	'a',
	'a.b-c_d/e__f',
	'a-b/c',
	'Ghcr.io/x/y',
	'ghcr.io/x/Y',
	'ghcr.io/x/y:7.0.1',
	'ghcr.io/x/y@sha256:abc',
	'-a/b',
	'a/-b',
	'a//b',
	'a/b/',
	'',
	'host:port/x',
	'a..b/c',
	'a_b.c/d',
	`a/${'b'.repeat(260)}`,
	'ghcr.io/x/y z',
];

describe('C. the grammars are the engine grammars', () => {
	test('repository: dedalo_repository_grammar ≡ isRepositoryReference', () => {
		let accepted = 0;
		for (const value of REPOSITORY_CORPUS) {
			const bashSays = bash('dedalo_repository_grammar "$1"', { args: [value] }).code === 0;
			expect({ value, bashSays }).toEqual({ value, bashSays: isRepositoryReference(value) });
			if (bashSays) accepted += 1;
		}
		expect(accepted).toBeGreaterThan(5);
		expect(accepted).toBeLessThan(REPOSITORY_CORPUS.length - 5);
	});

	test('repository: dedalo_repository_normalize ≡ normalizeRepository', () => {
		for (const value of ['docker.io/A/b', 'index.docker.io/a/b', 'GHCR.io/x/y', 'a/b']) {
			expect(bash('dedalo_repository_normalize "$1"', { args: [value] }).stdout).toBe(
				normalizeRepository(value),
			);
		}
	});

	// The FULL parity (every fixture string, both spellings, the ordering fixture)
	// is test/unit/release_identity_shell_parity.test.ts; these are the .dedalo.env
	// reader's own edges, judged against the engine's image-tag grammar.
	test('version: an image tag — X.Y.Z, X.Y.Z-(alpha|beta|rc).N or X.Y.Z-dev — ≡ identityOfImageTag', () => {
		const verdict = (value: string): boolean =>
			bash('dedalo_version_grammar "$1"', { args: [value] }).code === 0;
		for (const ok of ['7.0.0', '7.0.1-dev', '10.20.300', '0.0.0', '7.0.0-beta.1', '7.0.0-rc.12'])
			expect({ ok, v: verdict(ok), engine: identityOfImageTag(ok) !== null }).toEqual({
				ok,
				v: true,
				engine: true,
			});
		for (const bad of [
			'7.0',
			'7x0x1',
			'7.0.0-pre.1',
			'7.0.0-beta',
			'7.0.0-beta.1-dev',
			'07.0.0',
			'v7.0.0',
			'7.0.0-DEV',
			'7.0.0.dev',
			'',
			' 7.0.0',
		])
			expect({ bad, v: verdict(bad), engine: identityOfImageTag(bad) !== null }).toEqual({
				bad,
				v: false,
				engine: false,
			});
	});

	test('version order: dedalo_version_cmp ≡ compareReleaseIdentities of the identities the tags name', () => {
		const pairs: [string, string][] = [
			['7.0.1', '7.0.0'],
			['7.0.0', '7.0.1'],
			['7.0.0-dev', '7.0.0'],
			['7.10.0', '7.9.9'],
			['8.0.0', '7.99.99'],
			['7.0.0-beta.7', '7.0.0'],
			['7.0.0-beta.10', '7.0.0-beta.9'],
			['7.0.0-rc.1', '7.0.0-beta.9'],
			['7.0.0-dev', '7.0.0-rc.1'],
		];
		for (const [a, b] of pairs) {
			const expected = compareReleaseIdentities(
				identityOfImageTag(a) as string,
				identityOfImageTag(b) as string,
			);
			expect({
				a,
				b,
				got: bash('dedalo_version_cmp "$1" "$2"', { args: [a, b] }).stdout.trim(),
			}).toEqual({
				a,
				b,
				got: String(expected),
			});
		}
		expect(bash('dedalo_version_cmp 7.0 7.0.0').code).toBe(2);
		expect(bash('dedalo_version_cmp 07.0.0 7.0.0').code).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// D. The probe and the default rule.
// ---------------------------------------------------------------------------

/**
 * A stub `docker` for the probe: `manifest inspect` and `buildx imagetools
 * inspect` answer per repository from $STUB/<verb>.<sanitized ref> = "<code> <stderr>".
 */
const PROBE_DOCKER = `#!/bin/bash
ref="\${!#}"
key="$(printf '%s' "$ref" | tr -c 'a-zA-Z0-9.' '_')"
case "$1 $2" in
	'manifest inspect') verb=manifest ;;
	'buildx imagetools') verb=imagetools ;;
	*) verb=other ;;
esac
answer="$(cat "$STUB/$verb.$key" 2>/dev/null || echo '1 dial tcp: network is unreachable')"
printf '%s\\n' "\${answer#* }" >&2
exit "\${answer%% *}"
`;

function probeBin(answers: Record<string, string>): { bin: string; stub: string } {
	const dir = scratchDir();
	const bin = join(dir, 'bin');
	mkdirSync(bin);
	writeFileSync(join(bin, 'docker'), PROBE_DOCKER);
	chmodSync(join(bin, 'docker'), 0o755);
	for (const [file, answer] of Object.entries(answers)) writeFileSync(join(dir, file), answer);
	return { bin, stub: dir };
}

function sanitize(ref: string): string {
	return ref.replace(/[^a-zA-Z0-9.]/g, '_');
}

describe('D. which registry publishes this version, and the default it gives', () => {
	test('dedalo_image_available: 0 available, 1 absent (a registry SAYING so), 2 unknown', () => {
		const ref = 'ghcr.io/x/y:7.0.1';
		const cases: [Record<string, string>, number][] = [
			[{ [`manifest.${sanitize(ref)}`]: '0 ' }, 0],
			[
				{
					[`manifest.${sanitize(ref)}`]: "1 docker: 'manifest' is not a docker command",
					[`imagetools.${sanitize(ref)}`]: '0 ',
				},
				0,
			],
			[{ [`manifest.${sanitize(ref)}`]: '1 no such manifest: ghcr.io/x/y:7.0.1' }, 1],
			[
				{
					[`manifest.${sanitize(ref)}`]: '1 dial tcp: timeout',
					[`imagetools.${sanitize(ref)}`]: '1 ERROR: ghcr.io/x/y:7.0.1: not found',
				},
				1,
			],
			[
				{
					[`manifest.${sanitize(ref)}`]: '1 unauthorized',
					[`imagetools.${sanitize(ref)}`]: '1 denied',
				},
				2,
			],
			[{}, 2],
		];
		for (const [answers, expected] of cases) {
			const { bin, stub } = probeBin(answers);
			const run = bash('dedalo_image_available "$1"', {
				args: [ref],
				env: { PATH: `${bin}:/usr/bin:/bin`, STUB: stub },
			});
			expect({ answers, code: run.code }).toEqual({ answers, code: expected });
		}
	});

	test('dedalo_default_source: the first AVAILABLE official registry, else build', () => {
		const cases: [string[], string][] = [
			[[], 'build'],
			[['1'], 'build'],
			[['2', '2'], 'build'],
			[['1', '0'], '1'],
			[['0', '0'], '0'],
			[['2', '1', '0'], '2'],
			[['2', '0', '1'], '1'],
		];
		for (const [codes, expected] of cases) {
			expect({
				codes,
				got: bash('dedalo_default_source "$@"', { args: codes }).stdout.trim(),
			}).toEqual({
				codes,
				got: expected,
			});
		}
	});

	test('probe + default over the GENERATED list: the published mirror wins, nothing published builds', () => {
		const provisioned = provisionedRegistries(loadImageRegistries());
		expect(
			provisioned.length,
			'no provisioned registry — the probe chain is untested',
		).toBeGreaterThan(0);
		const last = provisioned.at(-1)?.repository as string;
		const published = probeBin({ [`manifest.${sanitize(`${last}:7.0.1`)}`]: '0 ' });
		const chain = 'dedalo_default_source $(dedalo_probe_registries "$1")';
		expect(
			bash(chain, {
				args: ['7.0.1'],
				env: { PATH: `${published.bin}:/usr/bin:/bin`, STUB: published.stub },
			}).stdout.trim(),
		).toBe(String(provisioned.length - 1));
		const none = probeBin({});
		expect(
			bash(chain, {
				args: ['7.0.1'],
				env: { PATH: `${none.bin}:/usr/bin:/bin`, STUB: none.stub },
			}).stdout.trim(),
		).toBe('build');
	});
});

// ---------------------------------------------------------------------------
// E. The offered set IS the list.
// ---------------------------------------------------------------------------

describe('E. the offered registries are the provisioned entries of the one list', () => {
	test('dedalo_offered_registries ≡ provisionedRegistries(engineering/image_registries.json)', () => {
		const list = loadImageRegistries();
		const expected = provisionedRegistries(list).map(
			(entry, index) => `${index}\t${entry.id}\t${entry.label}\t${entry.role}\t${entry.repository}`,
		);
		expect(expected.length).toBeGreaterThan(0);
		const offered = bash('dedalo_offered_registries').stdout.split('\n').filter(Boolean);
		expect(offered).toEqual(expected);
		// Primary first — and an unprovisioned entry is never offered.
		const roles = offered.map((line) => line.split('\t')[3]);
		expect(roles.indexOf('primary') <= 0).toBe(true);
		for (const entry of list.registries.filter((registry) => !registry.provisioned)) {
			expect(offered.some((line) => line.split('\t')[1] === entry.id)).toBe(false);
		}
	});

	test('dedalo_official_index names an official repository in any spelling; yours is not one', () => {
		const provisioned = provisionedRegistries(loadImageRegistries());
		for (const [index, entry] of provisioned.entries()) {
			const spelled = (entry.repository as string).toUpperCase();
			expect(bash('dedalo_official_index "$1"', { args: [spelled] }).stdout.trim()).toBe(
				String(index),
			);
		}
		expect(bash('dedalo_official_index registry.example.org/dedalo').code).toBe(1);
	});

	test('the signing identity is the generated one, never inherited from the environment', () => {
		const dir = scratchDir();
		const partial = join(dir, 'image_registries.sh');
		writeFileSync(
			partial,
			'DEDALO_REGISTRY_IDS=()\nDEDALO_REGISTRY_LABELS=()\nDEDALO_REGISTRY_ROLES=()\nDEDALO_REGISTRY_REPOSITORIES=()\n',
		);
		const run = bash(
			'dedalo_registries_load "$1"; printf "[%s][%s]" "$DEDALO_IMAGE_SIGNING_ISSUER" "$DEDALO_IMAGE_SIGNING_IDENTITY_REGEXP"',
			{
				args: [partial],
				env: {
					DEDALO_IMAGE_SIGNING_ISSUER: 'https://evil.invalid',
					DEDALO_IMAGE_SIGNING_IDENTITY_REGEXP: '.*',
				},
			},
		);
		expect(run.stdout).toBe('[][]');
		const list = loadImageRegistries();
		const real = bash(
			'printf "%s\\n%s" "$DEDALO_IMAGE_SIGNING_ISSUER" "$DEDALO_IMAGE_SIGNING_IDENTITY_REGEXP"',
		);
		expect(real.stdout).toBe(`${list.signing.issuer}\n${list.signing.identity_regexp}`);
	});

	test('cosign verification: the official identity is passed; no identity or no cosign refuses', () => {
		const dir = scratchDir();
		const bin = join(dir, 'bin');
		mkdirSync(bin);
		writeFileSync(join(bin, 'cosign'), '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$OUT"\nexit 0\n');
		chmodSync(join(bin, 'cosign'), 0o755);
		const ref = `ghcr.io/x/y@sha256:${'c'.repeat(64)}`;
		const env = { PATH: `${bin}:/usr/bin:/bin`, OUT: join(dir, 'argv') };
		expect(bash('dedalo_cosign_verify "$1"', { args: [ref], env }).code).toBe(0);
		const list = loadImageRegistries();
		expect(readFileSync(join(dir, 'argv'), 'utf8').split('\n').slice(0, -1)).toEqual([
			'verify',
			'--certificate-identity-regexp',
			list.signing.identity_regexp,
			'--certificate-oidc-issuer',
			list.signing.issuer,
			ref,
		]);
		// no identity loaded → refused, cosign never asked
		rmSync(join(dir, 'argv'));
		const blank = bash('DEDALO_IMAGE_SIGNING_IDENTITY_REGEXP=""; dedalo_cosign_verify "$1"', {
			args: [ref],
			env,
		});
		expect(blank.code).toBe(1);
		expect(existsSync(join(dir, 'argv'))).toBe(false);
		// a tag, not a digest → refused
		expect(bash('dedalo_cosign_verify "$1"', { args: ['ghcr.io/x/y:7.0.1'], env }).code).toBe(1);
		// no cosign on PATH → refused
		expect(bash('dedalo_cosign_verify "$1"', { args: [ref] }).code).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// F. The terminal installer's stack_image (phase 4) decides like the library.
// ---------------------------------------------------------------------------

/** A docker/trial step context over a recording runner answering `responses`. */
function stackCtx(raw: Record<string, unknown>, responses: RecordedResponse[]) {
	const plan = stackPlanCtx(raw);
	const runner = recordingRunner({ responses: () => responses });
	const ctx: HostCtx = {
		...plan,
		state: newInstallState(plan.plan, emptyPreflight()),
		created: emptyHostCreated(),
		secrets: {},
		runner,
		fs: hostFs(SCRATCH),
		io: { log: () => {}, warn: () => {} },
		children: new Set(),
		say: () => {},
		warn: () => {},
		save: () => {},
		sleep: async () => {},
		now: () => Date.now(),
	};
	return { ctx, log: runner.log };
}

function emptyPreflight(): Parameters<typeof newInstallState>[1] {
	return {
		preexisting_extensions: [],
		env_backups_before: [],
		env_existed: false,
		env_sha256: null,
		env_had_salt: true,
		sample_env_existed: false,
		install_status_before: null,
		directories_missing: [],
	};
}

const PROVISIONED = provisionedRegistries(loadImageRegistries());
const FIRST = PROVISIONED[0]?.repository as string;
const DIGEST = `sha256:${'d'.repeat(64)}`;
const DOCKER = '/usr/bin/docker';
const COSIGN = '/usr/local/bin/cosign';

/** The pulled image's answers: its version label, its registry digest, cosign's verdict. */
function imageAnswers(options: {
	label: string;
	repository?: string;
	cosignExit?: number;
}): RecordedResponse[] {
	return [
		{
			match: `${DOCKER} image inspect --format {{index .Config.Labels`,
			stdout: `${options.label}\n`,
		},
		{
			match: `${DOCKER} image inspect --format {{range .RepoDigests}}`,
			stdout: `${options.repository ?? FIRST}@${DIGEST}\n`,
		},
		{ match: `${COSIGN} verify`, exit: options.cosignExit ?? 0 },
	];
}

/** Run verifyImage; answers its record, or the refusal's sentence. */
async function verified(
	raw: Record<string, unknown>,
	responses: RecordedResponse[],
): Promise<{ record: StackImage | null; refusal: string | null; log: string[] }> {
	const { ctx, log } = stackCtx(raw, responses);
	try {
		return {
			record: await verifyImage(ctx),
			refusal: null,
			log: log.map((entry) => entry.argv.join(' ')),
		};
	} catch (error) {
		return {
			record: null,
			refusal: error instanceof Error ? error.message : String(error),
			log: log.map((entry) => entry.argv.join(' ')),
		};
	}
}

const TRIAL = { route: 'trial', entity: 'trial_museum' };

describe('F. the installer verifies the image as the library does (stack_image)', () => {
	test("the cosign argv is the library's: the same identity, the same issuer, the same repository@digest", () => {
		const dir = scratchDir();
		const bin = join(dir, 'bin');
		mkdirSync(bin);
		writeFileSync(join(bin, 'cosign'), '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$OUT"\nexit 0\n');
		chmodSync(join(bin, 'cosign'), 0o755);
		const ref = `${FIRST}@${DIGEST}`;
		const run = bash('dedalo_cosign_verify "$1"', {
			args: [ref],
			env: { PATH: `${bin}:/usr/bin:/bin`, OUT: join(dir, 'argv') },
		});
		expect(run.code, run.stderr).toBe(0);
		const library = readFileSync(join(dir, 'argv'), 'utf8').split('\n').slice(0, -1);
		const ts = cosignCommand(stackCtx(TRIAL, []).ctx, ref).argv;
		expect(ts[0]).toBe(COSIGN);
		expect(ts.slice(1)).toEqual(library);
	});

	test('an official image: the label must be its tag, the signature verified over its ONE digest, the digest pinned', async () => {
		const version = imageVersionOf(stackPlanCtx(TRIAL).answers);
		const ok = await verified(TRIAL, imageAnswers({ label: version }));
		expect(ok.refusal).toBeNull();
		expect(ok.record).toEqual({ repository: FIRST, version, digest: DIGEST, verify: 'cosign' });
		expect(ok.log.filter((line) => line.startsWith(`${COSIGN} verify`))).toEqual([
			`${COSIGN} verify --certificate-identity-regexp ${loadImageRegistries().signing.identity_regexp} --certificate-oidc-issuer ${loadImageRegistries().signing.issuer} ${FIRST}@${DIGEST}`,
		]);
	});

	test('a signature that does not verify is refused', async () => {
		const version = imageVersionOf(stackPlanCtx(TRIAL).answers);
		const bad = await verified(TRIAL, imageAnswers({ label: version, cosignExit: 1 }));
		expect(bad.record).toBeNull();
		expect(bad.refusal).toContain("does NOT carry Dédalo's signature");
	});

	test('a SIGNED image declaring another version is refused (a re-pointed tag is not that release)', async () => {
		const repointed = await verified(TRIAL, imageAnswers({ label: '6.9.0' }));
		expect(repointed.record).toBeNull();
		expect(repointed.refusal).toContain("declares version '6.9.0'");
		// Refused BEFORE cosign is asked: the label is the cheaper, earlier check.
		expect(repointed.log.some((line) => line.startsWith(COSIGN))).toBe(false);
	});

	test('a registry of your own: no signature claimed, cosign never asked; the label is checked when present', async () => {
		const raw = {
			...TRIAL,
			image_source: 'custom',
			image_repository: 'registry.example.org/dedalo',
		};
		const version = imageVersionOf(stackPlanCtx(raw).answers);
		const own = await verified(
			raw,
			imageAnswers({ label: version, repository: 'registry.example.org/dedalo' }),
		);
		expect(own.record).toEqual({
			repository: 'registry.example.org/dedalo',
			version,
			digest: null,
			verify: 'none',
		});
		expect(own.log.some((line) => line.startsWith(COSIGN))).toBe(false);
		const unlabelled = await verified(raw, imageAnswers({ label: '' }));
		expect(unlabelled.record?.verify).toBe('none');
		const wrong = await verified(raw, imageAnswers({ label: '6.9.0' }));
		expect(wrong.refusal).toContain("declares version '6.9.0'");
	});

	test('a build here: the SHARED builder over the checkout (its HEAD, snapshotted in the run dir), no pull, no signature', async () => {
		const raw = { ...TRIAL, image_source: 'build' };
		const base = stackPlanCtx(raw);
		const ref = `localhost/dedalo:${imageVersionOf(base.answers)}`;
		const argvOf = (sourceIsGit: boolean) =>
			imageCommands({ ...base, facts: { ...base.facts, sourceIsGit } }).map((command) =>
				command.kind === 'exec' ? command.argv : [],
			);
		// a checkout: ONE command, the builder the image updater's build mode runs too
		expect(argvOf(true)).toEqual([
			[
				STACK_BINARIES.bash,
				join(base.source, IMAGE_BUILDER),
				base.source,
				ref,
				base.facts.stack?.docker as string,
			],
		]);
		// a verified release tree (no .git) is its own context, already stamped
		expect(argvOf(false).map((argv) => argv.slice(1))).toEqual([
			['build', '--tag', ref, base.source],
		]);
		// the snapshot's place is the library's
		expect(bash('printf %s "$DEDALO_IMAGE_CONTEXT"').stdout).toBe(BUILD_CONTEXT);
		expect(buildContextDir(base)).toBe(join(base.source, '.dedalo-install', 'image-context'));
		const built = await verified(raw, []);
		expect(built.record?.verify).toBe('none');
		expect(built.log).toEqual([]);
	});

	test("C3-46 OUTCOME: the installer's build command over a checkout with a dirty and an untracked file builds a context without them, stamped (export-subst expanded)", async () => {
		const { repo, seen, docker } = builderFixture();
		writeFileSync(join(repo, 'tracked.txt'), 'an uncommitted edit\n');
		writeFileSync(join(repo, 'stray_untracked.txt'), 'never committed\n');
		writeFileSync(join(repo, 'src', 'core', 'stray_untracked.ts'), 'export const stray = 1;\n');
		const base = stackPlanCtx({ ...TRIAL, image_source: 'build' }, repo);
		const ctx = {
			...base,
			facts: {
				...base.facts,
				sourceIsGit: true,
				stack: { ...(base.facts.stack as NonNullable<typeof base.facts.stack>), docker },
			},
		};
		const [command] = imageCommands(ctx);
		const argv = command?.kind === 'exec' ? [...command.argv] : [];
		const run = Bun.spawnSync(argv, { cwd: repo, env: { PATH: '/usr/bin:/bin', STUB_SEEN: seen } });
		expect(run.exitCode, run.stderr.toString()).toBe(0);
		const context = join(repo, BUILD_CONTEXT);
		const built = readFileSync(`${seen}.argv`, 'utf8').trim();
		expect(built).toStartWith(`build --tag localhost/dedalo:${imageVersionOf(ctx.answers)} `);
		expect(built).toEndWith(` ${context}`);
		// its own version label, never the base image's (campaign 3b N1) — and never the
		// tag's word for it: the commit carries no release tag, so the label says the
		// identity the engine in the image reports, as an image tag (X.Y.Z-dev), even
		// under a `:X.Y.Z` tag (C3i-F1); the builder says so
		const contextIdentity = await readReleaseIdentityOf(seen, { triple: DEDALO_VERSION_TRIPLE });
		expect(built).toContain(
			`--label org.opencontainers.image.version=${imageTagOf(contextIdentity.version)} `,
		);
		expect(imageTagOf(contextIdentity.version)).not.toBe(imageVersionOf(ctx.answers));
		expect(run.stderr.toString()).toContain(
			`calls itself ${imageTagOf(contextIdentity.version)} — its version label says so`,
		);
		// committed content only
		expect(readFileSync(join(seen, 'tracked.txt'), 'utf8')).toBe('committed\n');
		for (const stray of ['stray_untracked.txt', 'src/core/stray_untracked.ts']) {
			expect(existsSync(join(seen, stray)), `${stray} reached the build context`).toBe(false);
		}
		// export-subst expanded (a stamped context, not the placeholder) — and the commit
		// carries no release tag, so the engine in that image honestly calls itself .dev
		// (release identity from the tag, owner decision 2026-10-15; C3i-F1)
		const identity = await readReleaseIdentityOf(seen, { triple: DEDALO_VERSION_TRIPLE });
		expect(readFileSync(join(seen, BUILD_INFO_PATH), 'utf8')).not.toStartWith('$Format:');
		expect(identity).toMatchObject({ kind: 'dev', notice: null });
		// the snapshot is removed after the build
		expect(existsSync(context)).toBe(false);
		expect(existsSync(`${context}.tar`)).toBe(false);
	});

	// Release identity, gate 6 (design §2.5): a prerelease installer's Build is tagged, labelled
	// AND self-named by its identity — the three agree, and none of them is the bare data version.
	test('prerelease + Build: tag, version label and the built engine’s own identity are all X.Y.Z-beta.N', async () => {
		const beta = PINNED_IDENTITY.prerelease;
		await withInstallerIdentity(beta, async () => {
			const { repo, seen, docker } = builderFixture({ tag: `v${beta}` });
			const base = stackPlanCtx({ ...TRIAL, image_source: 'build' }, repo);
			const ctx = {
				...base,
				facts: {
					...base.facts,
					sourceIsGit: true,
					stack: { ...(base.facts.stack as NonNullable<typeof base.facts.stack>), docker },
				},
			};
			expect(imageVersionOf(ctx.answers)).toBe(beta);
			const [command] = imageCommands(ctx);
			const argv = command?.kind === 'exec' ? [...command.argv] : [];
			const run = Bun.spawnSync(argv, {
				cwd: repo,
				env: { PATH: '/usr/bin:/bin', STUB_SEEN: seen },
			});
			expect(run.exitCode, run.stderr.toString()).toBe(0);
			const built = readFileSync(`${seen}.argv`, 'utf8').trim();
			expect(built).toStartWith(`build --tag localhost/dedalo:${beta} `);
			expect(built).toContain(`--label org.opencontainers.image.version=${beta} `);
			// what /health of that image will say: the archive's identity is the tag
			const identity = await readReleaseIdentityOf(seen, { triple: DEDALO_VERSION_TRIPLE });
			expect(identity).toMatchObject({ version: beta, kind: 'prerelease', notice: null });
			// and the stack is pinned to it
			expect(renderEnvFile(ctx, 'pw')).toContain(`\nDEDALO_VERSION=${beta}\n`);
		});
	});

	test('the builder: a failed build removes its snapshot (status 1); a tree without git is refused with the sentence (status 3)', () => {
		const failing = builderFixture({ fail: true });
		const red = Bun.spawnSync(
			[
				'bash',
				join(failing.repo, IMAGE_BUILDER),
				failing.repo,
				'localhost/dedalo:7.0.0',
				failing.docker,
			],
			{ env: { PATH: '/usr/bin:/bin', STUB_SEEN: failing.seen } },
		);
		expect(red.exitCode).toBe(1);
		expect(existsSync(join(failing.repo, BUILD_CONTEXT))).toBe(false);
		const release = scratchDir();
		const refused = Bun.spawnSync(
			['bash', join(REPO_ROOT, IMAGE_BUILDER), release, 'localhost/dedalo:7.0.0', failing.docker],
			{ env: { PATH: '/usr/bin:/bin', STUB_SEEN: failing.seen } },
		);
		expect(refused.exitCode).toBe(3);
		expect(refused.stderr.toString()).toContain(`${release} is not a git checkout`);
		expect(existsSync(join(release, '.dedalo-install'))).toBe(false);
	});
});

/**
 * A real git checkout carrying the shared builder (deploy/dedalo-image-build.sh +
 * the library), build_info.txt export-subst as in the repo, a tracked file —
 * all committed — and a stub docker that copies the context its `build` reads
 * to `seen` (its argv to `seen.argv`), or fails.
 */
function builderFixture(options: { fail?: boolean; tag?: string } = {}): {
	repo: string;
	seen: string;
	docker: string;
} {
	const root = scratchDir();
	const repo = join(root, 'checkout');
	const seen = join(root, 'context_seen');
	const docker = join(root, 'docker');
	mkdirSync(join(repo, 'deploy'), { recursive: true });
	mkdirSync(join(repo, 'src', 'core', 'update'), { recursive: true });
	for (const file of ['dedalo-image-build.sh', 'dedalo-image-lib.sh']) {
		writeFileSync(join(repo, 'deploy', file), readFileSync(join(REPO_ROOT, 'deploy', file)));
	}
	writeFileSync(join(repo, BUILD_INFO_PATH), readFileSync(join(REPO_ROOT, BUILD_INFO_PATH)));
	// a Dédalo tree declares its data version: the builder labels the identity it resolves to
	writeFileSync(
		join(repo, 'src', 'core', 'update', 'version.ts'),
		readFileSync(join(REPO_ROOT, 'src', 'core', 'update', 'version.ts')),
	);
	writeFileSync(join(repo, '.gitattributes'), 'src/core/update/build_info.txt export-subst\n');
	writeFileSync(join(repo, '.gitignore'), '/.dedalo-install/\n');
	writeFileSync(join(repo, 'tracked.txt'), 'committed\n');
	const git = (...args: string[]) => {
		const run = Bun.spawnSync(
			['git', '-c', 'user.name=gate', '-c', 'user.email=gate@example.org', ...args],
			{ cwd: repo, env: { PATH: '/usr/bin:/bin', HOME: root, GIT_CONFIG_NOSYSTEM: '1' } },
		);
		if (run.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr.toString()}`);
	};
	git('init', '-q', '-b', 'master');
	git('add', '-A');
	git('commit', '-q', '-m', 'fixture');
	// release tags are annotated (owner Q7): `%(describe)` in the archive reads only those
	if (options.tag !== undefined) git('tag', '-a', options.tag, '-m', options.tag);
	writeFileSync(
		docker,
		`#!/bin/bash\nfor a in "$@"; do last="$a"; done\nprintf '%s\\n' "$*" > "$STUB_SEEN.argv"\ncp -R "$last" "$STUB_SEEN"\n${options.fail === true ? 'exit 1' : 'exit 0'}\n`,
	);
	chmodSync(docker, 0o755);
	return { repo, seen, docker };
}

describe("F. the .dedalo.env the installer writes is the library's contract", () => {
	for (const raw of [
		TRIAL,
		{
			route: 'docker',
			entity: 'museo',
			server_name: 'dedalo.example.org',
			letsencrypt_email: 'ops@example.org',
		},
		{ ...TRIAL, image_source: 'build' },
	]) {
		test(`${String(raw.route)}${'image_source' in raw ? ` (${String(raw.image_source)})` : ''}: complete for the updater; the compose argv is dedalo_compose_args'`, () => {
			const ctx = stackPlanCtx(raw);
			const dir = scratchDir();
			writeFileSync(join(dir, stackFileOf(ctx.answers)), 'services: {}\n');
			writeFileSync(join(dir, '.dedalo.env'), renderEnvFile(ctx, 'pw'), { mode: 0o600 });
			writeFileSync(join(dir, 'compose.override.yaml'), renderOverride(ctx));
			const run = bash(
				[
					'dedalo_env_problems .dedalo.env',
					'printf "PLAIN:%s\\n" "$(dedalo_compose_args .dedalo.env plain | tr "\\n" " ")"',
					'printf "BUILD:%s\\n" "$(dedalo_compose_args .dedalo.env build | tr "\\n" " ")"',
				].join('\n'),
				{ cwd: dir },
			);
			expect(run.code, run.stderr).toBe(0);
			expect(run.stdout.split('\n').filter((line) => / (missing|invalid)$/.test(line))).toEqual([]);
			const line = (prefix: string) =>
				(run.stdout.split('\n').find((item) => item.startsWith(prefix)) ?? '')
					.slice(prefix.length)
					.trim();
			// The installer and every host tool drive ONE stack (compose.ts says so; this proves it).
			expect(line('PLAIN:')).toBe(composeFiles(ctx, 'plain').join(' '));
			expect(line('BUILD:')).toBe(composeFiles(ctx, 'build').join(' '));
			const get = (key: string): string =>
				bash('dedalo_env_get "$1" "$2"', { args: [join(dir, '.dedalo.env'), key] }).stdout;
			expect({
				DEDALO_COMPOSE_FILE: get('DEDALO_COMPOSE_FILE'),
				DEDALO_IMAGE: get('DEDALO_IMAGE'),
				DEDALO_VERSION: get('DEDALO_VERSION'),
				DEDALO_IMAGE_MODE: get('DEDALO_IMAGE_MODE'),
				DEDALO_IMAGE_VERIFY: get('DEDALO_IMAGE_VERIFY'),
			}).toEqual({
				DEDALO_COMPOSE_FILE: stackFileOf(ctx.answers),
				DEDALO_IMAGE: imageRepositoryOf(ctx.answers),
				DEDALO_VERSION: imageVersionOf(ctx.answers),
				DEDALO_IMAGE_MODE: ctx.answers.image_source === 'build' ? 'build' : 'pull',
				DEDALO_IMAGE_VERIFY: imageVerifyOf(ctx.answers),
			});
			const contract = bash('printf "%s" "$DEDALO_ENV_IMAGE_KEYS"').stdout.split(' ');
			expect(contract.length).toBe(5);
			for (const key of contract)
				expect(readFileSync(join(dir, '.dedalo.env'), 'utf8')).toMatch(new RegExp(`^${key}=`, 'm'));
		});
	}

	test("without the installer's override (a stack made by hand) the library omits it — the override is opt-in by existence", () => {
		const ctx = stackPlanCtx(TRIAL);
		const dir = scratchDir();
		writeFileSync(join(dir, stackFileOf(ctx.answers)), 'services: {}\n');
		writeFileSync(join(dir, '.dedalo.env'), renderEnvFile(ctx, 'pw'), { mode: 0o600 });
		const run = bash('dedalo_compose_args .dedalo.env plain | tr "\\n" " "', { cwd: dir });
		expect(run.stdout.trim()).toBe(`-f ${stackFileOf(ctx.answers)} --env-file .dedalo.env`);
	});
});
