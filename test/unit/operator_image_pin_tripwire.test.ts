/**
 * TRIPWIRE — every third-party image a compose stack or Dockerfile of this repo
 * runs is pinned `name:<version>@sha256:<digest>`, has an updater, and the
 * installer runs THOSE bytes (T1-17 / S11, 2026-11-12).
 *
 * WHAT WENT WRONG. The operator stacks pulled `certbot/certbot` (no tag at all),
 * `postgres:18`, `nginx:alpine`, `mariadb:11`, `pgvector/pgvector:pg18`: mutable
 * tags, so two installs of one release ran different bytes and a repointed
 * upstream tag ran beside the database and the secrets volume on the next pull.
 * Dependabot had no `docker-compose` entry for `/`, so nothing proposed a bump —
 * and the installer spelled the same unpinned refs AGAIN in TypeScript (the Let's
 * Encrypt issuance, the generated renewal override, the abort's image list), so
 * pinning only the YAML would have left certbot on `latest`.
 *
 * WHAT IS HELD, by outcome, over a DERIVED census (`git ls-files` of every
 * compose file and Dockerfile, by NAME (isDockerfileName) — a new stack is
 * in scope the day it lands):
 *   1. every non-exempt compose `image:` is a pinned reference (tag ≠ latest,
 *      64-hex digest); exemptions are a named, reasoned list (first-party images
 *      with their own pin laws);
 *   2. one image name = one pin across the operator stacks;
 *   3. the installer derives its images from the stack files: stackImages ==
 *      the stack file's pins (+ product, + certbot on Let's Encrypt), the Let's
 *      Encrypt issuance runs the stack file's certbot pin, the generated
 *      override spells no image;
 *   4. every directory holding a pinned compose image / Dockerfile has its
 *      Dependabot entry, and the file name is one Dependabot discovers;
 *   5. every Dockerfile FROM that names no earlier stage is pinned;
 *   6. an override written BEFORE the pin (its own unpinned certbot, no profile
 *      switch) is refused by the host library with its repair — merged over the
 *      new stack file it would silently stop the certificate renewal (T1-17
 *      review).
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { stackImages } from '../../src/core/install/host/stack/database.ts';
import { renderEnvFile, renderOverride } from '../../src/core/install/host/stack/files.ts';
import {
	isPinnedImage,
	stackFileServiceImages,
	stackServiceImage,
} from '../../src/core/install/host/stack/images.ts';
import { imageRefOf } from '../../src/core/install/host/stack/layout.ts';
import { stack_tls } from '../../src/core/install/host/stack/tls.ts';
import {
	isProductImageService,
	parseComposeFile,
	trackedRepoFiles,
} from '../helpers/deploy_artifact_corpus.ts';
import { REPO_ROOT, stackPlanCtx } from '../helpers/install_host_scratch.ts';
import { PINNED_IDENTITY, pinInstallerIdentity } from '../helpers/installer_identity.ts';

// A released installer (a dev identity plans no Docker image).
pinInstallerIdentity(PINNED_IDENTITY.stable);

/** The two operator stacks (the installer's docker and trial routes). */
const OPERATOR_STACKS = ['docker-compose.yml', 'docker-compose.simple.yml'] as const;

/**
 * Images NOT pinned here, by file + service, each with its reason. Product
 * images are exempt by OUTCOME (isProductImageService: the stack's
 * `${DEDALO_IMAGE:-localhost/dedalo}` — built here or pulled cosign-verified,
 * image_source_tripwire); this list holds the rest. Shrink-only.
 */
const EXEMPT: Readonly<Record<string, string>> = {
	'ci/compose.yml#runner':
		'the CI image itself, built from ci/Dockerfile and referenced by the fingerprint ci/image.json pins (DEDALO_CI_IMAGE_REF) — its own exactness law, not a third-party pull',
};

interface ImageRef {
	readonly file: string;
	readonly service: string;
	readonly image: string;
}

/** The git index, through the shared deploy-artifact lister (it owns the root). */
const TRACKED = trackedRepoFiles();

/** `git ls-files '*compose*.yml' '*compose*.yaml'`: `*` crosses `/` in a pathspec. */
const COMPOSE_FILES = TRACKED.filter((path) => /compose.*\.ya?ml$/.test(path));

/**
 * A Dockerfile by NAME, the way the builders and Dependabot's docker ecosystem
 * take one (T1-17 review): `Dockerfile`, `Dockerfile.<name>`, `<name>.Dockerfile`,
 * and the `Containerfile` spellings — case-insensitive. NOT a BuildKit
 * `<Dockerfile>.dockerignore` (an ignore list, no FROM), nor prose about one.
 */
function isDockerfileName(path: string): boolean {
	const name = path.split('/').pop() as string;
	if (/\.(dockerignore|md|txt)$/i.test(name)) return false;
	return (
		/^(docker|container)file(\.[\w.-]+)?$/i.test(name) || /\.(docker|container)file$/i.test(name)
	);
}

const DOCKERFILES = TRACKED.filter(isDockerfileName);

/** Every `image:` of every tracked compose file (product images flagged). */
function composeImages(): { pinnable: ImageRef[]; product: ImageRef[] } {
	const pinnable: ImageRef[] = [];
	const product: ImageRef[] = [];
	for (const file of COMPOSE_FILES) {
		for (const [service, spec] of Object.entries(parseComposeFile(file).services ?? {})) {
			if (typeof spec.image !== 'string') continue;
			const ref = { file, service, image: spec.image };
			if (isProductImageService(spec)) product.push(ref);
			else if (EXEMPT[`${file}#${service}`] === undefined) pinnable.push(ref);
		}
	}
	return { pinnable, product };
}

/** The FROM images of a Dockerfile that name no earlier stage. */
function externalFroms(file: string): string[] {
	const stages = new Set<string>();
	const images: string[] = [];
	for (const line of readFileSync(join(REPO_ROOT, file), 'utf8').split('\n')) {
		const from = /^FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/i.exec(line.trim());
		if (from === null) continue;
		const image = from[1] as string;
		if (!stages.has(image.toLowerCase())) images.push(image);
		if (from[2] !== undefined) stages.add(from[2].toLowerCase());
	}
	return images;
}

const DIGEST = 'a'.repeat(64);

describe('the pin predicate', () => {
	test('accepts name:version@sha256:<64 hex>; rejects a bare tag, a bare digest, latest, a short digest', () => {
		expect(isPinnedImage(`postgres:18.1@sha256:${DIGEST}`)).toBe(true);
		expect(isPinnedImage(`pgvector/pgvector:0.8.7-pg18@sha256:${DIGEST}`)).toBe(true);
		expect(isPinnedImage('postgres:18')).toBe(false);
		expect(isPinnedImage('certbot/certbot')).toBe(false);
		expect(isPinnedImage(`postgres@sha256:${DIGEST}`)).toBe(false);
		expect(isPinnedImage(`x:latest@sha256:${DIGEST}`)).toBe(false);
		expect(isPinnedImage('postgres:18@sha256:abc123')).toBe(false);
	});
});

describe('the census is not blind', () => {
	test('every Dockerfile spelling is in the census (Dockerfile.<name>, <name>.Dockerfile, Containerfile)', () => {
		for (const path of [
			'Dockerfile',
			'ci/Dockerfile',
			'deploy/Dockerfile.publication',
			'ci/agent.Dockerfile',
			'Containerfile',
			'x/Containerfile.dev',
			'x/dockerfile',
		])
			expect(isDockerfileName(path), path).toBe(true);
		for (const path of [
			'ci/Dockerfile.dockerignore',
			'.dockerignore',
			'docs/dockerfile.md',
			'Dockerfiles/x',
		])
			expect(isDockerfileName(path), path).toBe(false);
	});

	test('every compose file and Dockerfile is found, and the third-party refs with them', () => {
		expect(COMPOSE_FILES.length).toBeGreaterThanOrEqual(5);
		for (const stack of OPERATOR_STACKS) expect(COMPOSE_FILES).toContain(stack);
		expect(DOCKERFILES.length).toBeGreaterThanOrEqual(2);
		const { pinnable, product } = composeImages();
		expect(pinnable.length).toBeGreaterThanOrEqual(6);
		expect(product.length).toBeGreaterThanOrEqual(4);
		for (const key of Object.keys(EXEMPT)) {
			const [file, service] = key.split('#') as [string, string];
			expect(parseComposeFile(file).services?.[service]?.image, key).toBeString();
			expect((EXEMPT[key] as string).length, key).toBeGreaterThanOrEqual(60);
		}
	});
});

describe('1-2. every third-party compose image is pinned, one pin per image across the operator stacks', () => {
	test('no mutable compose image (a tag alone, no tag, latest)', () => {
		const offenders = composeImages()
			.pinnable.filter((ref) => !isPinnedImage(ref.image))
			.map((ref) => `${ref.file}#${ref.service}: ${ref.image}`);
		expect(offenders).toEqual([]);
	});

	test('the same image name pins the same version and digest in both operator stacks', () => {
		const pins = new Map<string, Set<string>>();
		for (const ref of composeImages().pinnable) {
			if (!(OPERATOR_STACKS as readonly string[]).includes(ref.file)) continue;
			const name = ref.image.split(/[:@]/)[0] as string;
			pins.set(name, (pins.get(name) ?? new Set()).add(ref.image));
		}
		expect(pins.size).toBeGreaterThanOrEqual(5);
		const split = [...pins]
			.filter(([, set]) => set.size > 1)
			.map(([name, set]) => [name, [...set]]);
		expect(split).toEqual([]);
	});
});

describe('3. the installer runs the stack files’ pins, never its own spelling', () => {
	const TRIAL = { route: 'trial', entity: 'trial_museum' };
	const DOCKER_LOCAL = {
		route: 'docker',
		entity: 'museo',
		server_name: 'dedalo.example.org',
		tls_mode: 'local_ca',
	};
	const DOCKER_LE = {
		route: 'docker',
		entity: 'museo',
		server_name: 'dedalo.example.org',
		letsencrypt_email: 'ops@example.org',
	};

	test('stackImages = the product ref + the stack file’s non-profile pins (+ its certbot on Let’s Encrypt)', () => {
		const cases: [Record<string, unknown>, string, boolean][] = [
			[TRIAL, 'docker-compose.simple.yml', false],
			[DOCKER_LOCAL, 'docker-compose.yml', false],
			[DOCKER_LE, 'docker-compose.yml', true],
		];
		for (const [raw, file, le] of cases) {
			const ctx = stackPlanCtx(raw);
			const pins = stackFileServiceImages(REPO_ROOT, file);
			expect(pins.length).toBeGreaterThanOrEqual(2);
			const certbot = le ? [stackServiceImage(REPO_ROOT, file, 'certbot')] : [];
			expect(stackImages(ctx)).toEqual([imageRefOf(ctx.answers), ...pins, ...certbot]);
			for (const image of stackImages(ctx).slice(1)) expect(isPinnedImage(image)).toBe(true);
		}
	});

	test('the Let’s Encrypt issuance runs docker-compose.yml’s certbot pin; the override spells no image', () => {
		const ctx = stackPlanCtx(DOCKER_LE);
		const pin = stackServiceImage(REPO_ROOT, 'docker-compose.yml', 'certbot');
		const argvImages = stack_tls
			.commands(ctx)
			.flatMap((command) => (command.kind === 'exec' ? [...command.argv] : []))
			.filter((arg) => arg.startsWith('certbot/'));
		expect(argvImages.length).toBeGreaterThanOrEqual(1);
		expect([...new Set(argvImages)]).toEqual([pin]);
		const override = renderOverride(ctx);
		expect(override).toContain('certbot:');
		expect(override).not.toMatch(/^\s*image:/m);
	});

	test('a stack file without the service, or with an unpinned image, is refused loudly', () => {
		expect(() => stackServiceImage(REPO_ROOT, 'docker-compose.yml', 'no_such_service')).toThrow(
			/no pinned image for the no_such_service service/,
		);
		expect(() => stackServiceImage(REPO_ROOT, 'docker-compose.yml', 'dedalo')).toThrow(
			/no pinned image for the dedalo service/,
		);
	});
});

/**
 * Dependabot's docker-compose file discovery (dependabot-core
 * docker/lib/dependabot/docker_compose/file_fetcher.rb FILENAME_REGEX, read
 * 2026-11-12): a compose file it does not match is a pin nobody updates.
 */
const DEPENDABOT_COMPOSE_FILENAME = /(docker-)?compose(-[\w]+)?(?:\.[\w-]+)?\.ya?ml/i;

describe('4. every pinned image has its updater', () => {
	interface Update {
		readonly 'package-ecosystem': string;
		readonly directory: string;
	}
	const updates = (
		Bun.YAML.parse(readFileSync(join(REPO_ROOT, '.github/dependabot.yml'), 'utf8')) as {
			updates: Update[];
		}
	).updates;
	const has = (ecosystem: string, dir: string): boolean =>
		updates.some((u) => u['package-ecosystem'] === ecosystem && u.directory === dir);
	const dirOf = (file: string): string => {
		const dir = dirname(file);
		return dir === '.' ? '/' : `/${dir}`;
	};

	test('a docker-compose entry for every directory holding a pinned compose image, under a discovered name', () => {
		const files = [...new Set(composeImages().pinnable.map((ref) => ref.file))];
		expect(files.length).toBeGreaterThanOrEqual(3);
		const uncovered = files.filter((file) => !has('docker-compose', dirOf(file)));
		expect(uncovered).toEqual([]);
		const undiscovered = files.filter(
			(file) => !DEPENDABOT_COMPOSE_FILENAME.test(file.split('/').pop() as string),
		);
		expect(undiscovered).toEqual([]);
	});

	test('a docker entry for every directory holding a Dockerfile', () => {
		expect(DOCKERFILES.filter((file) => !has('docker', dirOf(file)))).toEqual([]);
	});
});

describe('5. every Dockerfile base image is pinned', () => {
	test('each FROM naming no earlier stage is name:version@sha256', () => {
		const froms = DOCKERFILES.flatMap((file) =>
			externalFroms(file).map((image) => ({ file, image })),
		);
		expect(froms.length).toBeGreaterThanOrEqual(2);
		expect(froms.filter((ref) => !isPinnedImage(ref.image))).toEqual([]);
	});
});

/**
 * The Let's Encrypt override as the installer wrote it BEFORE T1-17 (b35846d20f^
 * src/core/install/host/stack/files.ts letsEncryptOverride, verbatim shape): its
 * own `certbot/certbot` service, no `profiles`. Merged over the new
 * docker-compose.yml (certbot `profiles: ["letsencrypt"]`), compose keeps the
 * profile and the unpinned image — certbot is never started again (measured with
 * Compose v5.5.1: `config --services` lists no certbot).
 */
const PRE_PIN_LE_OVERRIDE = [
	'# WRITTEN BY THE INSTALLER (scripts/install.ts, docker route).',
	'services:',
	'  nginx:',
	'    command: >',
	`      sh -c "nginx -g 'daemon off;'"`,
	'    volumes:',
	'      - letsencrypt:/etc/letsencrypt:ro',
	'      - certbot_www:/var/www/certbot:ro',
	'  certbot:',
	'    image: certbot/certbot',
	'    restart: unless-stopped',
	'    volumes:',
	'      - letsencrypt:/etc/letsencrypt',
	'      - certbot_www:/var/www/certbot',
	'    entrypoint: >',
	'      sh -c "trap exit TERM; while :; do certbot renew --webroot -w /var/www/certbot --quiet; sleep 12h & wait $${!}; done"',
	'volumes:',
	'  letsencrypt:',
	'  certbot_www:',
	'',
].join('\n');

describe('6. an override written before the pin is refused, with its repair', () => {
	const LIB = join(REPO_ROOT, 'deploy', 'dedalo-image-lib.sh');
	const SCRATCH = mkdtempSync(join(tmpdir(), 'dedalo-override-pin-'));
	afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));
	let cases = 0;
	const DOCKER_LE = {
		route: 'docker',
		entity: 'museo',
		server_name: 'dedalo.example.org',
		letsencrypt_email: 'ops@example.org',
	};

	/** dedalo_compose_args in a stack dir holding the real stack file and this override. */
	function composeArgs(raw: Record<string, unknown>, override: string | null) {
		const ctx = stackPlanCtx(raw);
		cases += 1;
		const dir = join(SCRATCH, `case-${cases}`);
		mkdirSync(dir, { recursive: true });
		const stack =
			ctx.answers.route === 'trial' ? 'docker-compose.simple.yml' : 'docker-compose.yml';
		copyFileSync(join(REPO_ROOT, stack), join(dir, stack));
		writeFileSync(join(dir, '.dedalo.env'), renderEnvFile(ctx, 'pw'), { mode: 0o600 });
		if (override !== null) writeFileSync(join(dir, 'compose.override.yaml'), override);
		const run = spawnSync(
			'bash',
			['-c', `set -euo pipefail; . ${JSON.stringify(LIB)}; dedalo_compose_args .dedalo.env plain`],
			{ cwd: dir, encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } },
		);
		return { code: run.status, stdout: run.stdout, stderr: run.stderr, stack };
	}

	test('the pre-pin Let’s Encrypt override: status 3, no argv, the repair on stderr', () => {
		const run = composeArgs(DOCKER_LE, PRE_PIN_LE_OVERRIDE);
		expect(run.code).toBe(3);
		expect(run.stdout).toBe('');
		expect(run.stderr).toContain('predates the pinned certbot');
		expect(run.stderr).toContain('    profiles: !reset []');
	});

	test('the same override with only the profile switch added still spells the unpinned image: refused', () => {
		const half = PRE_PIN_LE_OVERRIDE.replace(
			'    image: certbot/certbot\n',
			'    image: certbot/certbot\n    profiles: !reset []\n',
		);
		expect(composeArgs(DOCKER_LE, half).code).toBe(3);
	});

	test('the repaired override, and every override the installer writes today, pass', () => {
		const repaired = PRE_PIN_LE_OVERRIDE.replace(
			/ {2}certbot:\n[\s\S]*?(?=^volumes:)/m,
			'  certbot:\n    profiles: !reset []\n',
		);
		expect(repaired).not.toContain('certbot/certbot');
		const ok: [Record<string, unknown>, string | null][] = [
			[DOCKER_LE, repaired],
			[DOCKER_LE, renderOverride(stackPlanCtx(DOCKER_LE))],
			[DOCKER_LE, null],
			...[
				{ route: 'trial', entity: 'trial_museum' },
				{
					route: 'docker',
					entity: 'museo',
					server_name: 'dedalo.example.org',
					tls_mode: 'local_ca',
				},
			].map((raw): [Record<string, unknown>, string] => [raw, renderOverride(stackPlanCtx(raw))]),
		];
		for (const [raw, override] of ok) {
			const run = composeArgs(raw, override);
			expect({ code: run.code, stderr: run.stderr }).toEqual({ code: 0, stderr: '' });
			expect(run.stdout.split('\n')).toContain(run.stack);
			if (override !== null) expect(run.stdout.split('\n')).toContain('compose.override.yaml');
		}
	});
});
