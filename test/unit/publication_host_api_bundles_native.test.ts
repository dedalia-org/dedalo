/**
 * publication_host_api_bundles_native — the Publication API bundle builder
 * (src/core/publication_host/api_bundles.ts; phase-4 plan L1–L3, Review Focus 1).
 *
 * Pinned:
 *  - a bundle is EXACTLY the manifest's files for that API (+ v2's engine-built
 *    node_modules), in the writer's own order (compareBundlePaths — sibling shapes
 *    `docu/x.js` + `docu-x.js` and `lib/fp.js` + `lib/fp/` are in the fixture), and the
 *    AGENT'S OWN reader (publication/host_agent/src/releases/ustar.ts, zero-dep) extracts it
 *    byte-for-byte, PAX long paths and exec modes included. An untouched tree BUILDS: a
 *    verifier that never answers ok cannot pass this gate;
 *  - the same tree gives the same bytes;
 *  - a path Task 2 tolerates (`.env`, `server_config_api.php`) is never shipped and never
 *    refuses; an agent-reserved name Task 2 does not tolerate (`.bundle_sha256`,
 *    `.env.local`) refuses, named; tolerated ∪ reserved covers the agent's D8 set;
 *  - drift — a tree file edited after the manifest, caught by the tree check OR by the
 *    pack-time re-hash, cache hit or not — refuses, NAMES the file, leaves no bundle;
 *  - no verified release, a missing manifest, a digest that is not the manifest's, a v2
 *    release without bun.lock, a dependency symlink: typed refusals;
 *  - reads never follow a link and never block on a FIFO (readBundleFile);
 *  - the cache: a hit needs sidecar + re-hash; a corrupted bundle rebuilds; concurrent
 *    calls share one build; the newest API_BUNDLE_CACHE_KEEP release dirs survive;
 *  - the REAL installer runs the pinned Bun frozen in the build dir with a MINIMAL env —
 *    hermetic: only `file:` dependencies, no registry (bun installs those as symlinks:
 *    refused).
 *
 * Hermetic: scratch trees and backup roots under the OS temp dir. Every call passes
 * treeRoot + backupRoot, so the installation's backup root is never resolved.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { extractBundle } from '../../publication/host_agent/src/releases/ustar.ts';
import {
	API_BUILD_DIR,
	API_BUNDLE_CACHE_KEEP,
	ApiBundleError,
	type ApiBundleSeams,
	apiBuildPaths,
	apiTreePrefix,
	assertRegistryLockfile,
	buildApiBundle,
	ENGINE_RESERVED_BUNDLE_PATHS,
	installV2DepsReal,
	isReservedBundlePath,
	publicationReleaseId,
	readBundleFile,
	V2_DEPS_INSTALL_ARGS,
	v2DepsInstallEnv,
} from '../../src/core/publication_host/api_bundles.ts';
import { INSTALL_STAMP_PATH } from '../../src/core/update/install_stamp.ts';
import {
	isToleratedPath,
	writePublicationManifest,
} from '../../src/core/update/publication_manifest.ts';

const scratch = mkdtempSync(join(tmpdir(), 'dd_pubapi_bundles_'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const DIGEST = `a1b2c3d${'0'.repeat(57)}`;
const RELEASE = '7.0.0_a1b2c3d';
const LONG = `docu/${'d'.repeat(70)}/${'e'.repeat(70)}.js`;
const LIMITS = { maxBytes: 1 << 24, maxEntries: 10_000, maxPathLength: 1024 };
/** reservedBundlePaths(api, false) of the agent (phase-2 Task 6 store.ts). */
const AGENT_RESERVED = {
	v1: ['.bundle_sha256', 'config_api/server_config_api.php'],
	v2: ['.bundle_sha256', '.env', '.env.local', '.env.production', '.env.production.local'],
} as const;

type TreeFiles = Record<string, string>;

const V1_FILES: TreeFiles = {
	'json/index.php': '<?php // v1 entry',
	'common/utils.php': '<?php // utils',
	'common/run.sh': '#!/bin/sh\necho v1\n',
	'config_api/server_config_headers.php': '<?php // tracked default headers',
	'config_api/sample.server_config_api.php': '<?php // sample',
	// sibling shapes a whole-path byte sort orders differently from the writer:
	'docu/x.js': '// a dir child',
	'docu-x.js': "// '-' (0x2d) sorts before '/' (0x2f) in a whole-path compare",
	'lib/fp.js': '// file beside a dir of the same stem',
	'lib/fp/a.js': "// '.' (0x2e) sorts before '/' in a whole-path compare",
	[LONG]: 'a path longer than the 100-byte ustar name field',
};
const V2_FILES = {
	'package.json': '{"name":"dedalo-publication-api-v2","version":"2.1.0"}',
	'bun.lock': '{"lockfileVersion":1}',
	'bunfig.toml': '[install]\npeer = false\n',
	'src/index.ts': 'export {} satisfies TreeFiles;\n',
};

let seq = 0;
function freshDir(label: string): string {
	seq += 1;
	const dir = join(scratch, `${label}_${seq}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** An installed tree: API files, the install stamp, and (by default) the extract-time manifest. */
async function makeTree(
	files: { v1?: TreeFiles; v2?: TreeFiles } = { v1: V1_FILES, v2: V2_FILES },
	withManifest = true,
): Promise<string> {
	const root = freshDir('tree');
	for (const api of ['v1', 'v2'] as const) {
		for (const [rel, text] of Object.entries(files[api] ?? {})) {
			const abs = join(root, 'publication/server_api', api, rel);
			mkdirSync(dirname(abs), { recursive: true });
			writeFileSync(abs, text);
			if (rel.endsWith('.sh')) chmodSync(abs, 0o755);
		}
	}
	const stamp = join(root, INSTALL_STAMP_PATH);
	mkdirSync(dirname(stamp), { recursive: true });
	writeFileSync(stamp, JSON.stringify({ digest: DIGEST, channel: 'master' }));
	if (withManifest) await writePublicationManifest(root, DIGEST);
	return root;
}

interface FakeDeps {
	calls: string[];
	inputs: Record<string, string>[];
	install: (depsDir: string) => Promise<void>;
}

/** A stand-in `bun install`: records its inputs, then lays down a hoisted node_modules with
 * .bin symlinks at two depths (dropped), regular package files (shipped), and the
 * `zod` / `zod-x` sibling shape (writer order). */
function fakeDeps(extra?: (depsDir: string) => void): FakeDeps {
	const calls: string[] = [];
	const inputs: Record<string, string>[] = [];
	const install = async (depsDir: string): Promise<void> => {
		calls.push(depsDir);
		inputs.push(
			Object.fromEntries(
				readdirSync(depsDir)
					.sort()
					.map((name) => [name, readFileSync(join(depsDir, name), 'utf8')]),
			),
		);
		const nm = join(depsDir, 'node_modules');
		mkdirSync(join(nm, 'zod'), { recursive: true });
		writeFileSync(join(nm, 'zod/package.json'), '{"name":"zod"}');
		writeFileSync(join(nm, 'zod/index.js'), 'module.exports = {};');
		mkdirSync(join(nm, 'zod-x'), { recursive: true });
		writeFileSync(join(nm, 'zod-x/index.js'), 'module.exports = 2;');
		mkdirSync(join(nm, '.bin'), { recursive: true });
		symlinkSync('../zod/index.js', join(nm, '.bin/zod'));
		mkdirSync(join(nm, 'p/node_modules/.bin'), { recursive: true });
		writeFileSync(join(nm, 'p/index.js'), 'p');
		symlinkSync('../../index.js', join(nm, 'p/node_modules/.bin/q'));
		extra?.(depsDir);
	};
	return { calls, inputs, install };
}

function seams(treeRoot: string, over: ApiBundleSeams = {}): ApiBundleSeams {
	return {
		treeRoot,
		backupRoot: freshDir('backup'),
		digest: DIGEST,
		version: '7.0.0',
		installDeps: fakeDeps().install,
		...over,
	};
}

function backupOf(s: ApiBundleSeams): string {
	return s.backupRoot as string;
}

async function extract(
	file: string,
	api: 'v1' | 'v2',
): Promise<{ dir: string; sha256: string; files: string[] }> {
	const dir = freshDir('extract');
	const result = await extractBundle(Bun.file(file).stream(), dir, LIMITS, AGENT_RESERVED[api]);
	const files = (readdirSync(dir, { recursive: true }) as string[])
		.filter((path) => statSync(join(dir, path)).isFile())
		.sort();
	return { dir, sha256: result.sha256, files };
}

async function refusal(pending: Promise<unknown>): Promise<ApiBundleError> {
	try {
		await pending;
	} catch (error) {
		expect(error).toBeInstanceOf(ApiBundleError);
		return error as ApiBundleError;
	}
	throw new Error('expected an ApiBundleError; the build succeeded');
}

describe('release id (L2)', () => {
	test('is <version>_<digest7>', () => {
		expect(publicationReleaseId('7.0.0', DIGEST)).toBe(RELEASE);
	});

	test('no digest (dev checkout, pre-stamp tree) is no verified release', () => {
		expect(() => publicationReleaseId('7.0.0', null)).toThrow(ApiBundleError);
		try {
			publicationReleaseId('7.0.0', null);
		} catch (error) {
			expect((error as ApiBundleError).reason).toBe('no_verified_release');
		}
	});

	test('a digest that is not 64-hex is no verified release', () => {
		expect(() => publicationReleaseId('7.0.0', 'abc')).toThrow(ApiBundleError);
	});
});

describe('v1 bundle (L1)', () => {
	test('an untouched tree builds: exactly the manifest files, in writer order, extracted byte-for-byte by the agent', async () => {
		const s = seams(await makeTree());
		const bundle = await buildApiBundle('v1', s);
		expect(bundle.releaseId).toBe(RELEASE);
		expect(bundle.file).toBe(apiBuildPaths(backupOf(s), RELEASE, 'v1').bundle);
		const out = await extract(bundle.file, 'v1');
		expect(out.sha256).toBe(bundle.sha256);
		expect(out.files).toEqual(Object.keys(V1_FILES).sort());
		for (const [rel, text] of Object.entries(V1_FILES)) {
			expect(readFileSync(join(out.dir, rel), 'utf8')).toBe(text);
		}
		expect(statSync(join(out.dir, 'common/run.sh')).mode & 0o777).toBe(0o755);
		expect(statSync(join(out.dir, 'json/index.php')).mode & 0o777).toBe(0o644);
	});

	test('the same tree gives the same bytes', async () => {
		const tree = await makeTree();
		const a = await buildApiBundle('v1', seams(tree));
		const b = await buildApiBundle('v1', seams(tree));
		expect(a.sha256).toBe(b.sha256);
	});

	test('the operator v1 config file (Task 2 tolerated) never ships and never refuses', async () => {
		const tree = await makeTree({
			v1: { ...V1_FILES, 'config_api/server_config_api.php': '<?php $pw = 1;' },
		});
		const bundle = await buildApiBundle('v1', seams(tree));
		const out = await extract(bundle.file, 'v1');
		expect(out.files).toEqual(Object.keys(V1_FILES).sort());
		expect(existsSync(join(out.dir, 'config_api/server_config_api.php'))).toBe(false);
	});

	test('an agent-reserved name Task 2 does not tolerate refuses, naming it', async () => {
		const tree = await makeTree({ v1: { ...V1_FILES, '.bundle_sha256': 'f'.repeat(64) } });
		const err = await refusal(buildApiBundle('v1', seams(tree)));
		expect(err.reason).toBe('reserved_path');
		expect(err.paths).toEqual(['publication/server_api/v1/.bundle_sha256']);
	});
});

describe('refusals — nothing unverified is packed (Review Focus 1)', () => {
	test('a file edited after the manifest refuses, names it, writes no bundle', async () => {
		const tree = await makeTree();
		appendFileSync(join(tree, 'publication/server_api/v1/json/index.php'), '\n// edited');
		const s = seams(tree);
		const err = await refusal(buildApiBundle('v1', s));
		expect(err.reason).toBe('drift');
		expect(err.paths.some((path) => path.includes('v1/json/index.php'))).toBe(true);
		expect(err.message).toContain('json/index.php');
		expect(existsSync(apiBuildPaths(backupOf(s), RELEASE, 'v1').bundle)).toBe(false);
	});

	test('a cached bundle never bypasses the tree check', async () => {
		const tree = await makeTree();
		const s = seams(tree);
		await buildApiBundle('v1', s);
		appendFileSync(join(tree, 'publication/server_api/v1/common/utils.php'), '\n// edited');
		const err = await refusal(buildApiBundle('v1', s));
		expect(err.reason).toBe('drift');
		expect(err.paths.some((path) => path.includes('v1/common/utils.php'))).toBe(true);
	});

	test('a file edited DURING the build is caught by the pack-time re-hash', async () => {
		const tree = await makeTree();
		const deps = fakeDeps(() =>
			appendFileSync(join(tree, 'publication/server_api/v2/src/index.ts'), '// late'),
		);
		const s = seams(tree, { installDeps: deps.install });
		const paths = apiBuildPaths(backupOf(s), RELEASE, 'v2');
		const err = await refusal(buildApiBundle('v2', s));
		expect(err.reason).toBe('drift');
		expect(err.paths).toEqual(['publication/server_api/v2/src/index.ts']);
		expect(existsSync(paths.bundle)).toBe(false);
		expect(readdirSync(paths.releaseDir)).toEqual([]);
	});

	test('a tree without the manifest refuses', async () => {
		const err = await refusal(buildApiBundle('v1', seams(await makeTree(undefined, false))));
		expect(err.reason).toBe('missing_manifest');
	});

	test('a running digest that is not the manifest digest refuses', async () => {
		const err = await refusal(
			buildApiBundle('v1', seams(await makeTree(), { digest: `b${'0'.repeat(63)}` })),
		);
		expect(err.reason).toBe('digest_mismatch');
	});

	test('no verified release refuses before anything is created', async () => {
		const s = seams(await makeTree(), { digest: null });
		const err = await refusal(buildApiBundle('v1', s));
		expect(err.reason).toBe('no_verified_release');
		expect(existsSync(join(backupOf(s), API_BUILD_DIR))).toBe(false);
	});

	test('a scratch tree without its own backup root is refused', async () => {
		const err = await refusal(buildApiBundle('v1', { treeRoot: await makeTree() }));
		expect(err.reason).toBe('unsafe_seams');
	});
});

describe('v2 bundle (L3)', () => {
	test('ships the manifest files + engine-built node_modules, never .bin; deps dir removed', async () => {
		const deps = fakeDeps();
		const s = seams(await makeTree(), { installDeps: deps.install });
		const bundle = await buildApiBundle('v2', s);
		const depsDir = apiBuildPaths(backupOf(s), RELEASE, 'v2').depsDir;
		expect(deps.calls).toEqual([depsDir]);
		expect(deps.inputs[0]).toEqual({
			'bun.lock': V2_FILES['bun.lock'],
			'bunfig.toml': V2_FILES['bunfig.toml'],
			'package.json': V2_FILES['package.json'],
		});
		expect(existsSync(depsDir)).toBe(false);
		const out = await extract(bundle.file, 'v2');
		expect(out.sha256).toBe(bundle.sha256);
		expect(out.files).toEqual(
			[
				...Object.keys(V2_FILES),
				'node_modules/p/index.js',
				'node_modules/zod/index.js',
				'node_modules/zod/package.json',
				'node_modules/zod-x/index.js',
			].sort(),
		);
		expect(existsSync(join(out.dir, 'node_modules/.bin'))).toBe(false);
		expect(existsSync(join(out.dir, 'node_modules/p/node_modules/.bin'))).toBe(false);
	});

	test('a v2 release without bun.lock refuses before any install', async () => {
		const { 'bun.lock': _lock, ...rest } = V2_FILES;
		const deps = fakeDeps();
		const err = await refusal(
			buildApiBundle('v2', seams(await makeTree({ v2: rest }), { installDeps: deps.install })),
		);
		expect(err.reason).toBe('lockfile_missing');
		expect(err.paths).toEqual(['publication/server_api/v2/bun.lock']);
		expect(deps.calls).toEqual([]);
	});

	test('a v2 .env (Task 2 tolerated) never ships and never refuses', async () => {
		const bundle = await buildApiBundle(
			'v2',
			seams(await makeTree({ v2: { ...V2_FILES, '.env': 'SECRET=1' } })),
		);
		const out = await extract(bundle.file, 'v2');
		expect(out.files).not.toContain('.env');
		expect(existsSync(join(out.dir, '.env'))).toBe(false);
	});

	test('a v2 .env.local (agent-reserved, not tolerated) refuses, naming it', async () => {
		const err = await refusal(
			buildApiBundle(
				'v2',
				seams(await makeTree({ v2: { ...V2_FILES, '.env.local': 'SECRET=1' } })),
			),
		);
		expect(err.reason).toBe('reserved_path');
		expect(err.paths).toEqual(['publication/server_api/v2/.env.local']);
	});

	test('a dependency symlink outside node_modules/.bin refuses, naming it', async () => {
		const deps = fakeDeps((dir) => symlinkSync('/etc/hosts', join(dir, 'node_modules/zod/evil')));
		const s = seams(await makeTree(), { installDeps: deps.install });
		const err = await refusal(buildApiBundle('v2', s));
		expect(err.reason).toBe('deps_symlink');
		expect(err.paths).toEqual(['node_modules/zod/evil']);
		expect(existsSync(apiBuildPaths(backupOf(s), RELEASE, 'v2').bundle)).toBe(false);
	});

	test('several dependency symlinks refuse ONCE, naming every one in bundle order (not readdir order)', async () => {
		// Planted in reverse order, in two directories: the walk finishes before it refuses,
		// so the answer is the same set and the same order on every filesystem.
		const deps = fakeDeps((dir) => {
			symlinkSync('/etc/hosts', join(dir, 'node_modules/zod/zz_link'));
			symlinkSync('/etc/hosts', join(dir, 'node_modules/zod/aa_link'));
			symlinkSync('/etc/hosts', join(dir, 'node_modules/aa_top_link'));
		});
		const s = seams(await makeTree(), { installDeps: deps.install });
		const err = await refusal(buildApiBundle('v2', s));
		expect(err.reason).toBe('deps_symlink');
		expect(err.paths).toEqual([
			'node_modules/aa_top_link',
			'node_modules/zod/aa_link',
			'node_modules/zod/zz_link',
		]);
		expect(err.message).toContain('node_modules/zod/zz_link');
		expect(existsSync(apiBuildPaths(backupOf(s), RELEASE, 'v2').bundle)).toBe(false);
	});
});

describe('readBundleFile — never follows a link, never blocks', () => {
	test('a regular file reads with its mode; a link, a FIFO and a missing path are refused kinds', async () => {
		const dir = freshDir('nofollow');
		writeFileSync(join(dir, 'f'), 'abc');
		chmodSync(join(dir, 'f'), 0o755);
		symlinkSync(join(dir, 'f'), join(dir, 'l'));
		expect(Bun.spawnSync(['mkfifo', join(dir, 'p')]).exitCode).toBe(0);
		const file = await readBundleFile(join(dir, 'f'));
		expect(file.kind).toBe('file');
		if (file.kind === 'file') {
			expect(new TextDecoder().decode(file.data)).toBe('abc');
			expect(file.mode).toBe(0o755);
		}
		expect(await readBundleFile(join(dir, 'l'))).toEqual({ kind: 'symlink' });
		expect(await readBundleFile(join(dir, 'p'))).toEqual({ kind: 'not_regular' });
		expect(await readBundleFile(join(dir, 'missing'))).toEqual({ kind: 'not_regular' });
	});
});

describe('cache', () => {
	test('a hit re-uses the bundle; a corrupted bundle rebuilds to the same bytes', async () => {
		const deps = fakeDeps();
		const s = seams(await makeTree(), { installDeps: deps.install });
		const first = await buildApiBundle('v2', s);
		const second = await buildApiBundle('v2', s);
		expect(second).toEqual(first);
		expect(deps.calls.length).toBe(1);
		appendFileSync(first.file, 'x');
		const third = await buildApiBundle('v2', s);
		expect(deps.calls.length).toBe(2);
		expect(third.sha256).toBe(first.sha256);
	});

	test('concurrent calls for the same release share one build', async () => {
		let open: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			open = resolve;
		});
		const deps = fakeDeps();
		const install = async (dir: string): Promise<void> => {
			await gate;
			await deps.install(dir);
		};
		const s = seams(await makeTree(), { installDeps: install });
		const a = buildApiBundle('v2', s);
		const b = buildApiBundle('v2', s);
		open();
		const [ra, rb] = await Promise.all([a, b]);
		expect(deps.calls.length).toBe(1);
		expect(ra).toEqual(rb);
	});

	test('the newest API_BUNDLE_CACHE_KEEP release dirs survive; other names are untouched', async () => {
		expect(API_BUNDLE_CACHE_KEEP).toBe(3);
		const s = seams(await makeTree());
		const buildRoot = join(backupOf(s), API_BUILD_DIR);
		const old = ['7.0.0_0000001', '7.0.0_0000002', '7.0.0_0000003', '7.0.0_0000004'];
		old.forEach((name, i) => {
			const dir = join(buildRoot, name);
			mkdirSync(dir, { recursive: true });
			const at = new Date(Date.now() - (10 - i) * 86_400_000);
			utimesSync(dir, at, at);
		});
		mkdirSync(join(buildRoot, 'not_a_release'));
		mkdirSync(join(buildRoot, '.bun_install_cache'));
		await buildApiBundle('v1', s);
		expect(readdirSync(buildRoot).sort()).toEqual(
			[RELEASE, '7.0.0_0000003', '7.0.0_0000004', 'not_a_release', '.bun_install_cache'].sort(),
		);
	});

	test('a crashed build temp is swept', async () => {
		const s = seams(await makeTree());
		const paths = apiBuildPaths(backupOf(s), RELEASE, 'v1');
		mkdirSync(paths.releaseDir, { recursive: true });
		writeFileSync(`${paths.bundle}.tmp-dead`, 'half');
		await buildApiBundle('v1', s);
		expect(readdirSync(paths.releaseDir).sort()).toEqual(['v1.json', 'v1.tar.gz']);
	});
});

describe('the real installer (pinned Bun, frozen, hoisted, minimal env)', () => {
	/** A v2 tree whose only dependency is a local `file:` package, its bun.lock generated
	 * here by the pinned Bun — no registry. `extraDep` adds a dependency the lock lacks.
	 * bun.lock records a `file:` path RELATIVE to the lockfile, so the dep and the lock
	 * generator sit in the release dir, beside the deps build dir (`../dep` resolves the
	 * same from both), under a realpath'd root (macOS /var → /private/var would skew it). */
	async function fileDepTree(extraDep: boolean): Promise<ApiBundleSeams> {
		const backupRoot = realpathSync(freshDir('backup'));
		const releaseDir = apiBuildPaths(backupRoot, RELEASE, 'v2').releaseDir;
		const dep = join(releaseDir, 'dep');
		const gen = join(releaseDir, 'lockgen');
		mkdirSync(dep, { recursive: true });
		mkdirSync(gen, { recursive: true });
		writeFileSync(join(dep, 'package.json'), '{"name":"dep","version":"1.0.0","main":"index.js"}');
		writeFileSync(join(dep, 'index.js'), 'module.exports = 1;');
		const pkg = {
			name: 'dedalo-publication-api-v2',
			version: '2.1.0',
			private: true,
			dependencies: { dep: 'file:../dep' },
		};
		writeFileSync(join(gen, 'package.json'), JSON.stringify(pkg));
		const made = Bun.spawnSync([process.execPath, 'install'], {
			cwd: gen,
			stdout: 'ignore',
			stderr: 'pipe',
		});
		if (made.exitCode !== 0)
			throw new Error(`lockfile generation failed: ${made.stderr.toString()}`);
		// extraDep: a lockfile that pins NOTHING (bun writes none for a dependency-free
		// package, so it is spelled here in bun's own shape) under a package.json that
		// declares the file: dependency — clean provenance, uncovered manifest.
		const lockfile = extraDep
			? '{\n  "lockfileVersion": 2,\n  "configVersion": 1,\n  "workspaces": {\n    "": {\n      "name": "dedalo-publication-api-v2",\n    },\n  },\n  "packages": {}\n}\n'
			: readFileSync(join(gen, 'bun.lock'), 'utf8');
		const tree = await makeTree({
			v2: {
				'package.json': JSON.stringify(pkg),
				'bun.lock': lockfile,
				'src/index.ts': 'export {};\n',
			},
		});
		return seams(tree, { backupRoot, installDeps: installV2DepsReal });
	}

	test('argv is the pinned frozen production hoisted no-scripts install', () => {
		expect([...V2_DEPS_INSTALL_ARGS]).toEqual([
			'install',
			'--frozen-lockfile',
			'--production',
			'--linker',
			'hoisted',
			'--ignore-scripts',
		]);
	});

	test('the child env is minimal: no engine secret, no registry override, HOME = build dir, shared cache', () => {
		const depsDir = '/b/.pubapi_build/7.0.0_a1b2c3d/v2';
		expect(
			v2DepsInstallEnv(depsDir, {
				PATH: '/usr/bin',
				TMPDIR: '/t',
				HTTPS_PROXY: 'http://proxy:3128',
				no_proxy: 'localhost',
				HOME: '/home/operator',
				DB_PASSWORD: 'x',
				DEDALO_PASSWORD_CONN: 'y',
				DEDALO_SERVICE_TOKEN: 'z',
				NPM_CONFIG_REGISTRY: 'http://elsewhere.invalid',
				BUN_CONFIG_REGISTRY: 'http://elsewhere.invalid',
				EMPTY: '',
				UNSET: undefined,
			}),
		).toEqual({
			PATH: '/usr/bin',
			TMPDIR: '/t',
			HTTPS_PROXY: 'http://proxy:3128',
			no_proxy: 'localhost',
			HOME: depsDir,
			BUN_INSTALL_CACHE_DIR: '/b/.pubapi_build/.bun_install_cache',
		});
		expect(v2DepsInstallEnv(depsDir, {}).PATH).toBe('/usr/local/bin:/usr/bin:/bin');
	});

	test('a file: dependency is refused by PROVENANCE, before the install runs', async () => {
		// Bun 1.4.3 materialised it as symlinks (deps_symlink caught it by accident); 1.4.4
		// hardlinks the files and the walk saw regular files. The refusal must not depend on
		// how Bun lays the bytes out: no installer runs at all.
		const s = await fileDepTree(false);
		let installed = false;
		const err = await refusal(
			buildApiBundle('v2', {
				...s,
				installDeps: async () => {
					installed = true;
				},
			}),
		);
		expect(err.reason).toBe('deps_unpinned');
		expect(err.paths).toEqual(['bun.lock:dep']);
		expect(installed).toBe(false);
	});

	test('a package.json the lockfile does not cover fails frozen', async () => {
		// The lockfile is provenance-clean (it pins nothing), so the provenance rule passes
		// and the FROZEN install is what refuses the dependency package.json adds.
		const s = await fileDepTree(true);
		const err = await refusal(buildApiBundle('v2', s));
		expect(err.reason).toBe('deps_install_failed');
		expect(err.message).toContain('frozen');
	});
});

describe('the provenance rule — every bun.lock package is registry-resolved with an integrity hash', () => {
	const INTEGRITY = 'sha512-AAAA';
	async function verdict(packages: Record<string, unknown>): Promise<string[] | 'ok'> {
		const dir = freshDir('lockrule');
		// bun's own JSONC shape, trailing commas included: the parse must take them.
		const body = JSON.stringify({ lockfileVersion: 2, packages }, null, 2).replace(
			/\n(\s*)([}\]])/g,
			',\n$1$2',
		);
		writeFileSync(join(dir, 'bun.lock'), body);
		try {
			await assertRegistryLockfile(dir);
			return 'ok';
		} catch (error) {
			expect((error as ApiBundleError).reason).toBe('deps_unpinned');
			return [...(error as ApiBundleError).paths];
		}
	}

	test('positive control: registry tuples (plain and scoped) with an integrity pass', async () => {
		expect(
			await verdict({
				hono: ['hono@4.6.0', '', {}, INTEGRITY],
				'@scope/pkg': ['@scope/pkg@1.0.0', '', {}, 'sha256-BBBB'],
			}),
		).toBe('ok');
	});

	test('every non-registry shape, and a registry tuple without integrity, is named — sorted', async () => {
		expect(
			await verdict({
				ok: ['ok@1.0.0', '', {}, INTEGRITY],
				z_file: ['z_file@file:../dep', {}],
				y_link: ['y_link@link:y_link', {}],
				x_git: ['x_git@github:o/r#abc', {}, 'o-r-abc'],
				w_url: ['w_url@https://example.org/w.tgz', {}],
				t_userinfo: ['t_userinfo@https://user@example.org/t.tgz', {}, INTEGRITY],
				v_bare: ['v_bare@1.0.0', '', {}],
				u_shape: 'not a tuple',
			}),
		).toEqual([
			'bun.lock:t_userinfo',
			'bun.lock:u_shape',
			'bun.lock:v_bare',
			'bun.lock:w_url',
			'bun.lock:x_git',
			'bun.lock:y_link',
			'bun.lock:z_file',
		]);
	});

	test("the repo's own shipped lockfiles pass (server_api/v2, host_agent)", async () => {
		for (const dir of ['publication/server_api/v2', 'publication/host_agent']) {
			await assertRegistryLockfile(join(import.meta.dir, '../..', dir));
		}
	});
});

describe('twin: Task 2 tolerance ∪ the engine reserve covers the agent D8 rule', () => {
	test('every agent-reserved name is tolerated (never shipped) or reserved (refused); the reserve is exact', () => {
		const store = readFileSync(
			join(import.meta.dir, '../../publication/host_agent/src/releases/store.ts'),
			'utf8',
		);
		for (const name of [
			'.bundle_sha256',
			'.env',
			'.env.local',
			'.env.production',
			'.env.production.local',
			'server_config_api.php',
		]) {
			expect(store).toContain(`'${name}'`);
		}
		for (const api of ['v1', 'v2'] as const) {
			for (const name of AGENT_RESERVED[api]) {
				const covered =
					isToleratedPath(`${apiTreePrefix(api)}${name}`) || isReservedBundlePath(api, name);
				expect({ api, name, covered }).toEqual({ api, name, covered: true });
			}
		}
		expect(ENGINE_RESERVED_BUNDLE_PATHS.v1).toEqual(['.bundle_sha256']);
		expect(ENGINE_RESERVED_BUNDLE_PATHS.v2).toEqual([
			'.bundle_sha256',
			'.env.local',
			'.env.production',
			'.env.production.local',
		]);
	});
});
