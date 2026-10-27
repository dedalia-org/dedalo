/**
 * PRODUCT IMAGE TRIPWIRE — the `Dockerfile` the official Dédalo images are built from
 * (installer unification D1, 2026-10-09) keeps the three properties a SIGNED, PUBLISHED
 * image depends on.
 *
 *  A. THE CODE IS LAST. Successive releases share the big layers (OS, toolchain,
 *     dependencies) only if nothing release-specific sits under them: in the runtime
 *     stage no COPY before the dependency install may bring application code (only the
 *     manifests and the single ImageMagick policy file), the system layers (apt, policy,
 *     image-channel marker, writable trees) come before the dependencies, and after the
 *     generated COPY block only the provenance ARG/RUN and image metadata may follow.
 *     Judged by `layerOrderFaults` over the parsed instructions, with a planted control
 *     for each way of breaking it.
 *  B. THE BASE IS PINNED BY DIGEST (tag kept for the reader and Dependabot), and the
 *     `docker` Dependabot entry for "/" — its updater — exists.
 *  C. PROVENANCE IS HONEST. The provenance RUN is EXECUTED in a scratch tree, the way
 *     the builder runs it (ARG values arrive as environment variables): no arguments →
 *     no stamp (an untagged local build stays `.dev`); a valid channel + archive digest → a
 *     stamp `parseInstallStamp` accepts, whose channel the release identity reads (a
 *     legacy two-field stamp: '' on master, '.dev' on dev — release_identity.ts rule 4;
 *     a tagged archive is named by its tag on either channel, rule 5 — gate 1 in
 *     release_identity_native); a half-set, unknown-channel or malformed digest
 *     → the build FAILS and writes nothing. No instruction writes build_info.txt (git
 *     archive expands it; build_stamp_native holds the committed placeholder).
 *  D. /srv/dedalo/client is created bun-owned (the engine publishes its client into the
 *     `client` volume mounted there).
 *
 * DB-free; fs plus one `sh` per provenance case: hermetic tier.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INSTALL_STAMP_PATH, parseInstallStamp } from '../../src/core/update/install_stamp.ts';
import { resolveReleaseIdentity } from '../../src/core/update/release_identity.ts';
import { DEDALO_NEXT_DEV_TRIPLE } from '../../src/core/update/version.ts';

const ROOT = join(import.meta.dir, '..', '..');
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');
const DOCKERFILE = read('Dockerfile');

const POLICY_SOURCE = 'src/core/media/engine/imagemagick-policy/policy.xml';
/** The only COPY sources allowed below the dependency install: manifests and the policy file. */
const PRE_DEPS_SOURCES = new Set(['package.json', 'bun.lock*', 'bun.lockb*', POLICY_SOURCE]);
/** Instructions allowed after the code: metadata, plus the provenance ARG/RUN. */
const AFTER_CODE = new Set([
	'ARG',
	'LABEL',
	'USER',
	'EXPOSE',
	'ENTRYPOINT',
	'CMD',
	'STOPSIGNAL',
	'HEALTHCHECK',
]);

interface Instruction {
	keyword: string;
	args: string;
}

/** The instructions, comments dropped and `\` continuations joined — how the builder reads them. */
function instructions(text: string): Instruction[] {
	return text
		.split('\n')
		.filter((line) => !/^\s*#/.test(line))
		.join('\n')
		.replaceAll(/\\\n/g, ' ')
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line !== '')
		.map((line) => {
			const at = line.search(/\s/);
			return at === -1
				? { keyword: line.toUpperCase(), args: '' }
				: { keyword: line.slice(0, at).toUpperCase(), args: line.slice(at + 1).trim() };
		});
}

/** The runtime stage: from the first FROM up to the next one. */
function runtimeStage(text: string): Instruction[] {
	const all = instructions(text);
	const next = all.findIndex((one, i) => i > 0 && one.keyword === 'FROM');
	return all.slice(0, next === -1 ? all.length : next);
}

function copySources(one: Instruction): string[] {
	const operands = one.args.split(/\s+/).filter((token) => !token.startsWith('--'));
	return operands.slice(0, -1);
}

const isDepsInstall = (one: Instruction) =>
	one.keyword === 'RUN' && /^bun install\b/.test(one.args);
const isApt = (one: Instruction) => one.keyword === 'RUN' && /\bapt-get\s+install\b/.test(one.args);
const isPolicyInstall = (one: Instruction) =>
	one.keyword === 'RUN' && one.args.includes('/etc/ImageMagick-6');
const isMarker = (one: Instruction) =>
	one.keyword === 'RUN' && one.args.includes('/etc/dedalo/image_tree');
const isWritableTrees = (one: Instruction) =>
	one.keyword === 'RUN' && /^mkdir -p \/private\b/.test(one.args);
const isProvenance = (one: Instruction) =>
	one.keyword === 'RUN' && one.args.includes(INSTALL_STAMP_PATH);

/** Every way the runtime stage breaks "OS/toolchain → deps → code LAST". [] when it holds. */
function layerOrderFaults(text: string): string[] {
	const stage = runtimeStage(text);
	const faults: string[] = [];
	const deps = stage.findIndex(isDepsInstall);
	const lastCopy = stage.map((one) => one.keyword).lastIndexOf('COPY');
	if (deps === -1) return ['no `RUN bun install` in the runtime stage'];
	for (const [name, find] of [
		['the apt toolchain', isApt],
		['the ImageMagick policy install', isPolicyInstall],
		['the image-channel marker', isMarker],
		['the writable-trees line', isWritableTrees],
	] as const) {
		const at = stage.findIndex(find);
		if (at === -1 || at > deps)
			faults.push(`${name} is missing or sits above the dependency install`);
	}
	for (const one of stage.slice(0, deps))
		for (const source of one.keyword === 'COPY' || one.keyword === 'ADD' ? copySources(one) : [])
			if (!PRE_DEPS_SOURCES.has(source))
				faults.push(
					`\`${one.keyword} ${one.args}\` brings '${source}' in below the dependency install`,
				);
	if (lastCopy < deps) faults.push('no application COPY after the dependency install');
	const after = stage.slice(lastCopy + 1);
	for (const one of after)
		if (!AFTER_CODE.has(one.keyword) && !isProvenance(one))
			faults.push(
				`\`${one.keyword} ${one.args.slice(0, 60)}\` follows the code (only provenance + metadata may)`,
			);
	if (!after.some(isProvenance)) faults.push('the provenance RUN does not follow the code');
	return faults;
}

describe('A. the code is the last layer of the runtime stage', () => {
	test('the real Dockerfile keeps the order (and was really parsed)', () => {
		const stage = runtimeStage(DOCKERFILE);
		// Anti-vacuity: the generated block's 14 COPYs and the system RUNs were seen.
		expect(stage.filter((one) => one.keyword === 'COPY').length).toBeGreaterThan(12);
		expect(stage.filter((one) => one.keyword === 'RUN').length).toBeGreaterThanOrEqual(6);
		expect(layerOrderFaults(DOCKERFILE)).toEqual([]);
	});

	const plant = (from: string | RegExp, to: string): string[] => {
		const mutated = DOCKERFILE.replace(from, to);
		expect(mutated === DOCKERFILE, `control did not apply: ${String(from)}`).toBe(false);
		return layerOrderFaults(mutated);
	};

	test('CONTROL: application code copied above the dependency install is red', () => {
		expect(
			plant(
				'COPY package.json bun.lock* bun.lockb* ./',
				'COPY src ./src\nCOPY package.json bun.lock* bun.lockb* ./',
			).join(),
		).toContain("brings 'src'");
	});

	test('CONTROL: a build step after the code is red', () => {
		expect(plant(/^USER bun$/m, 'RUN bun run css:build\nUSER bun').join()).toContain(
			'follows the code',
		);
		expect(plant(/^USER bun$/m, 'ENV X=1\nUSER bun').join()).toContain('follows the code');
	});

	test('CONTROL: the toolchain below the dependencies is red, and so is a missing provenance step', () => {
		const apt = DOCKERFILE.match(
			/^RUN apt-get update[\s\S]*?rm -rf \/var\/lib\/apt\/lists\/\*\n/m,
		)?.[0] as string;
		expect(apt.length).toBeGreaterThan(100);
		const moved = DOCKERFILE.replace(apt, '').replace(/^USER bun$/m, `${apt}USER bun`);
		expect(layerOrderFaults(moved).join()).toContain('the apt toolchain');
		expect(
			plant(/^RUN set -eu; \\\n {4}channel=[\s\S]*?echo "provenance: channel[^\n]*\n/m, '').join(),
		).toContain('provenance RUN');
	});
});

describe('B. the base is pinned by digest, and Dependabot updates it', () => {
	test('FROM names the .bun-version tag AND a sha256 digest', () => {
		const from = runtimeStage(DOCKERFILE)[0] as Instruction;
		expect(from.keyword).toBe('FROM');
		const matched = /^oven\/bun:([^\s@]+)-debian@sha256:([0-9a-f]{64}) AS runtime$/.exec(from.args);
		expect(matched, `FROM ${from.args}`).not.toBeNull();
		expect(matched?.[1]).toBe(read('.bun-version').trim());
	});

	test('a `docker` Dependabot entry for "/" proposes the base bumps', () => {
		const dependabot = read('.github/dependabot.yml');
		const entries = [
			...dependabot.matchAll(/^\s*- package-ecosystem: (\S+)\s*\n\s+directory: "([^"]+)"/gm),
		].map((m) => `${m[1]} ${m[2]}`);
		// Anti-vacuity: the reader sees the file's other entries too.
		expect(entries).toContain('docker /ci');
		expect(entries).toContain('docker /');
	});
});

/** Run the Dockerfile's provenance RUN in a scratch tree with the given build arguments. */
function runProvenance(args: Record<string, string>): {
	code: number;
	stamp: string | null;
	stderr: string;
} {
	const command = runtimeStage(DOCKERFILE).find(isProvenance)?.args as string;
	const tree = mkdtempSync(join(tmpdir(), 'dedalo-provenance-'));
	try {
		mkdirSync(join(tree, 'src', 'core', 'update'), { recursive: true });
		const run = Bun.spawnSync(['sh', '-c', command], {
			cwd: tree,
			env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...args },
			stdout: 'pipe',
			stderr: 'pipe',
		});
		const stampPath = join(tree, INSTALL_STAMP_PATH);
		return {
			code: run.exitCode ?? 1,
			stamp: existsSync(stampPath) ? readFileSync(stampPath, 'utf8') : null,
			stderr: run.stderr.toString(),
		};
	} finally {
		rmSync(tree, { recursive: true, force: true });
	}
}

const DIGEST = 'a'.repeat(32) + '0123456789abcdef'.repeat(2);

describe('C. the provenance step, EXECUTED', () => {
	test('it declares its two build arguments and never writes build_info.txt', () => {
		const stage = runtimeStage(DOCKERFILE);
		const args = stage.filter((one) => one.keyword === 'ARG').map((one) => one.args.split('=')[0]);
		expect(args).toEqual(['DEDALO_RELEASE_CHANNEL', 'DEDALO_RELEASE_ARCHIVE_SHA256']);
		expect(instructions(DOCKERFILE).filter((one) => one.args.includes('build_info.txt'))).toEqual(
			[],
		);
	});

	test('no arguments: no stamp — an untagged local build reports .dev', () => {
		const result = runProvenance({});
		expect(result.code).toBe(0);
		expect(result.stamp).toBeNull();
		expect(
			resolveReleaseIdentity({
				triple: [7, 0, 0],
				nextDevTriple: DEDALO_NEXT_DEV_TRIPLE,
				describe: '',
				provenance: { stamp: 'other', channel: null },
			}).kind,
		).toBe('dev');
	});

	test.each([
		['master', ''],
		['prerelease', ''],
		['dev', '-dev'],
	] as const)('channel %s: a stamp the engine parses, posture "%s"', (channel, tag) => {
		const result = runProvenance({
			DEDALO_RELEASE_CHANNEL: channel,
			DEDALO_RELEASE_ARCHIVE_SHA256: DIGEST,
		});
		expect(result.code, result.stderr).toBe(0);
		const stamp = parseInstallStamp(result.stamp ?? '');
		expect(stamp).toEqual({ digest: DIGEST, channel });
		// a LEGACY expanded stamp (no describe field) takes its suffix from the channel
		const identity = resolveReleaseIdentity({
			triple: [7, 0, 0],
			nextDevTriple: DEDALO_NEXT_DEV_TRIPLE,
			describe: null,
			provenance: { stamp: 'legacy', channel: stamp?.channel ?? null },
		});
		expect(identity.version.slice(identity.triple.join('.').length)).toBe(tag);
	});

	test('channel prerelease: the image of a prerelease tag stamps it, and calls itself the tag (release posture)', () => {
		// image-release.yml builds a prerelease tag with DEDALO_RELEASE_CHANNEL=prerelease
		// (scripts/ci/image_release.ts releasePlanFor): the step must accept it, and the
		// engine reading that stamp beside the archive's expanded describe must say the tag.
		const result = runProvenance({
			DEDALO_RELEASE_CHANNEL: 'prerelease',
			DEDALO_RELEASE_ARCHIVE_SHA256: DIGEST,
		});
		expect(result.code, result.stderr).toBe(0);
		const stamp = parseInstallStamp(result.stamp ?? '');
		expect(stamp).toEqual({ digest: DIGEST, channel: 'prerelease' });
		const identity = resolveReleaseIdentity({
			triple: [7, 0, 0],
			nextDevTriple: DEDALO_NEXT_DEV_TRIPLE,
			describe: 'v7.0.0-beta.7',
			provenance: { stamp: 'other', channel: stamp?.channel ?? null },
		});
		expect([identity.version, identity.kind]).toEqual(['7.0.0-beta.7', 'prerelease']);
	});

	test.each([
		['channel without digest', { DEDALO_RELEASE_CHANNEL: 'master' }],
		['digest without channel', { DEDALO_RELEASE_ARCHIVE_SHA256: DIGEST }],
		[
			'unknown channel',
			{ DEDALO_RELEASE_CHANNEL: 'release', DEDALO_RELEASE_ARCHIVE_SHA256: DIGEST },
		],
		[
			'uppercase digest',
			{ DEDALO_RELEASE_CHANNEL: 'master', DEDALO_RELEASE_ARCHIVE_SHA256: DIGEST.toUpperCase() },
		],
		[
			'short digest',
			{ DEDALO_RELEASE_CHANNEL: 'dev', DEDALO_RELEASE_ARCHIVE_SHA256: DIGEST.slice(1) },
		],
		[
			'digest with a newline',
			{ DEDALO_RELEASE_CHANNEL: 'dev', DEDALO_RELEASE_ARCHIVE_SHA256: `${DIGEST}\nx` },
		],
		[
			'injection attempt',
			{ DEDALO_RELEASE_CHANNEL: 'master"; touch pwned; "', DEDALO_RELEASE_ARCHIVE_SHA256: DIGEST },
		],
	] as const)('refused, build fails, nothing written: %s', (_name, args) => {
		const result = runProvenance(args);
		expect(result.code).not.toBe(0);
		expect(result.stamp).toBeNull();
		expect(result.stderr).toContain('DEDALO_RELEASE_');
	});
});

describe('D. the client publication target exists, bun-owned', () => {
	test('the writable-trees line creates /srv/dedalo/client in both halves', () => {
		const writable = DOCKERFILE.match(
			/^RUN mkdir -p ([^\n\\]+)\\\n\s*&& chown -R bun:bun ([^\n]+)$/m,
		);
		expect(writable, 'no `mkdir -p … && chown -R bun:bun …` writable-trees line').not.toBeNull();
		const made = (writable?.[1] ?? '').trim().split(/\s+/);
		const owned = (writable?.[2] ?? '').trim().split(/\s+/);
		// Anti-vacuity: the line still carries the trees it always did.
		expect(made).toContain('/private');
		expect(made).toContain('/srv/dedalo/client');
		expect(owned).toContain('/srv/dedalo/client');
	});
});
