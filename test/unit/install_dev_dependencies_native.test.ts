/**
 * TODO-052 (design DEV_ROUTE_SERVE §1.0, gate 0): a developer-route install
 * leaves the checkout able to run `bun run dev` — measured as OUTCOMES:
 *
 *  A. the plan: the developer route carries `install_dev_dependencies` (after
 *     the probes, before anything is written); production / docker / trial —
 *     their host plans AND their delegated engine children — never do (they keep
 *     the bootstrap's `--production` tree);
 *  B. the REAL lockfile: a tree bootstrapped exactly as install.sh does
 *     (`bun install --frozen-lockfile --production --ignore-scripts`) cannot
 *     resolve `less` from its scripts/ directory (where build_css.ts imports it
 *     — the TODO's crash); after the step every devDependency is at its locked
 *     version, `less` resolves from scripts/ and a child process imports and
 *     renders with it; a second run spawns nothing;
 *  C. the same over a hermetic `file:` fixture (no registry, no cache);
 *  D. a failing `bun install` (a lockfile that does not match package.json, as
 *     --frozen-lockfile refuses) REFUSES the step — install.step_failed, the
 *     exit code and bun's own words — never a silent "complete";
 *  E. root in a tree it does not own is refused before anything is spawned
 *     (never a root-owned node_modules in a developer's clone);
 *  F. the package manager gets no install secret.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
	DEV_INSTALL_ARGS,
	devDependencyGaps,
	devDependencyNames,
	installDevDependencies,
	lockedVersion,
	ownerRefusal,
	packageManagerEnv,
	satisfiesLock,
} from '../../src/core/install/dev_dependencies.ts';
import {
	answersFromCliArgs,
	buildInstallPlan,
	type InstallPlan,
} from '../../src/core/install/install_plan.ts';
import { BASE_ARGV } from '../helpers/install_answer_cases.ts';
import { PINNED_IDENTITY, pinInstallerIdentity } from '../helpers/installer_identity.ts';

// The installer's release identity is the checkout's: a dev checkout names no image,
// so these cases are written for a STABLE installer (test/helpers/installer_identity.ts).
pinInstallerIdentity(PINNED_IDENTITY.stable);

const ROOT = resolve(import.meta.dir, '../..');
const scratch = mkdtempSync(join(tmpdir(), 'dedalo_dev_deps_'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function plan(argv: readonly string[]): InstallPlan {
	const invocation = answersFromCliArgs(argv);
	expect(invocation.errors).toEqual([]);
	const built = buildInstallPlan(invocation.raw);
	expect(built.errors).toEqual([]);
	return built;
}

/** install.sh's bootstrap, verbatim: the installer's dependencies only. */
function bootstrapProduction(tree: string): void {
	const proc = Bun.spawnSync(
		[process.execPath, 'install', '--frozen-lockfile', '--production', '--ignore-scripts'],
		{ cwd: tree, stdout: 'pipe', stderr: 'pipe' },
	);
	expect(proc.exitCode, proc.stderr.toString()).toBe(0);
}

/**
 * Does `name` resolve from `dir` (the way a script there imports it)? In a
 * FRESH process, as `bun run dev` meets it: this one's resolver caches a miss.
 */
function resolvesFrom(name: string, dir: string): boolean {
	const proc = Bun.spawnSync(
		[process.execPath, '-e', `Bun.resolveSync(${JSON.stringify(name)}, process.cwd())`],
		{ cwd: dir, stdout: 'pipe', stderr: 'pipe' },
	);
	return proc.exitCode === 0;
}

/** The DedaloError the call threw (or null). */
async function refusal(
	call: () => Promise<unknown>,
): Promise<{ code: string; message: string } | null> {
	try {
		await call();
		return null;
	} catch (error) {
		return error as { code: string; message: string };
	}
}

describe('A. the developer route plans the step; no other route ever does', () => {
	const IDENTITY = ['--entity', 'devdeps', '--langs', 'lg-spa,lg-eng', '--app-lang', 'lg-spa'];
	const HOST = ['--server-name', 'prado.example.org', '--letsencrypt-email', 'ops@example.org'];

	test('developer: after the probes, before the first write (persist_config)', () => {
		const steps = plan(BASE_ARGV).steps;
		expect(steps).toContain('install_dev_dependencies');
		// Before every write: only the developer certificate's two steps (D1 local_ca,
		// which write <private>/tls and the trust store) sit between it and persist_config.
		const deps = steps.indexOf('install_dev_dependencies');
		expect(steps.slice(deps + 1, steps.indexOf('persist_config'))).toEqual([
			'dev_tls_certificate',
			'dev_trust_ca',
		]);
		expect(steps.indexOf('install_dev_dependencies')).toBeGreaterThan(
			steps.indexOf('test_db_connection'),
		);
	});

	for (const route of [
		['--route', 'production', '--instance', 'prado', ...HOST],
		['--route', 'docker', ...HOST],
		['--route', 'trial'],
	]) {
		test(`${route[1]}: neither the host plan nor its engine child installs devDependencies`, () => {
			const host = plan([...IDENTITY, ...route]);
			expect(host.steps.length).toBeGreaterThan(5);
			expect(host.steps).not.toContain('install_dev_dependencies');
			const child = plan([...IDENTITY, ...route, '--engine-only']);
			expect(child.steps).toContain('install_db_from_default_file');
			expect(child.steps).not.toContain('install_dev_dependencies');
		});
	}
});

describe('B. the real lockfile: a --production tree gains its devDependencies', () => {
	test('less missing after the bootstrap → the step → every devDependency usable, less renders', async () => {
		const tree = join(scratch, 'real');
		mkdirSync(join(tree, 'scripts'), { recursive: true });
		cpSync(join(ROOT, 'package.json'), join(tree, 'package.json'));
		cpSync(join(ROOT, 'bun.lock'), join(tree, 'bun.lock'));
		bootstrapProduction(tree);

		// The TODO's crash, reproduced: build_css.ts lives in scripts/ and imports less.
		expect(resolvesFrom('less', join(tree, 'scripts'))).toBe(false);
		const missing = devDependencyGaps(tree).map((gap) => gap.name);
		expect(missing).toContain('less');

		const result = await installDevDependencies({ tree });
		expect(result.installed.sort()).toEqual(missing.sort());
		expect(devDependencyGaps(tree)).toEqual([]);
		for (const name of devDependencyNames(tree)) {
			expect(existsSync(join(tree, 'node_modules', name, 'package.json')), name).toBe(true);
		}
		expect(resolvesFrom('less', join(tree, 'scripts'))).toBe(true);
		const render = Bun.spawnSync(
			[
				process.execPath,
				'-e',
				"const less = (await import('less')).default; const out = await less.render('@c: #123; a { color: @c; }'); console.log(out.css.replace(/\\s+/g, ' ').trim());",
			],
			{ cwd: join(tree, 'scripts'), stdout: 'pipe', stderr: 'pipe' },
		);
		expect(render.stderr.toString()).toBe('');
		expect(render.stdout.toString().trim()).toBe('a { color: #123; }');

		// Done = nothing spawned: the second run answers from the tree.
		const again = await installDevDependencies({ tree, bun: join(scratch, 'no-such-bun') });
		expect(again.installed).toEqual([]);
		expect(again.msg).toContain('already installed');
	}, 180000);
});

/** A tree with one production and one development `file:` dependency, locked. */
function fixtureTree(name: string): string {
	const tree = join(scratch, name);
	for (const [pkg, version] of [
		['fx-prod', '1.0.0'],
		['fx-dev', '2.0.0'],
	] as const) {
		mkdirSync(join(tree, 'vendor', pkg), { recursive: true });
		writeFileSync(
			join(tree, 'vendor', pkg, 'package.json'),
			JSON.stringify({ name: pkg, version, main: 'index.js' }),
		);
		writeFileSync(
			join(tree, 'vendor', pkg, 'index.js'),
			`module.exports = ${JSON.stringify(pkg)};\n`,
		);
	}
	writeFileSync(
		join(tree, 'package.json'),
		JSON.stringify({
			name: 'fx-tree',
			private: true,
			dependencies: { 'fx-prod': 'file:./vendor/fx-prod' },
			devDependencies: { 'fx-dev': 'file:./vendor/fx-dev' },
		}),
	);
	const lock = Bun.spawnSync([process.execPath, 'install', '--ignore-scripts'], {
		cwd: tree,
		stdout: 'pipe',
		stderr: 'pipe',
	});
	expect(lock.exitCode, lock.stderr.toString()).toBe(0);
	rmSync(join(tree, 'node_modules'), { recursive: true, force: true });
	return tree;
}

describe('C. hermetic: the same over file: dependencies', () => {
	test('bootstrap → fx-dev absent → step → fx-dev resolves', async () => {
		const tree = fixtureTree('fixture');
		bootstrapProduction(tree);
		expect(readdirSync(join(tree, 'node_modules')).sort()).toEqual(['fx-prod']);
		expect(devDependencyGaps(tree).map((gap) => gap.name)).toEqual(['fx-dev']);
		const result = await installDevDependencies({ tree });
		expect(result.installed).toEqual(['fx-dev']);
		expect(resolvesFrom('fx-dev', tree)).toBe(true);
		expect(devDependencyGaps(tree)).toEqual([]);
	}, 60000);
});

describe('D. a failed bun install refuses the step', () => {
	test('a lockfile that does not match package.json → install.step_failed with bun’s words', async () => {
		const tree = fixtureTree('stale_lock');
		bootstrapProduction(tree);
		// A devDependency the lock never saw: --frozen-lockfile must refuse.
		writeFileSync(
			join(tree, 'package.json'),
			JSON.stringify({
				name: 'fx-tree',
				private: true,
				dependencies: { 'fx-prod': 'file:./vendor/fx-prod' },
				devDependencies: { 'fx-dev': 'file:./vendor/fx-dev', 'fx-late': 'file:./vendor/fx-dev' },
			}),
		);
		const error = await refusal(() => installDevDependencies({ tree }));
		expect(error?.code).toBe('install.step_failed');
		expect(error?.message).toContain('bun install exited');
		expect(error?.message).toContain('npm registry');
		expect(error?.message).toMatch(/lockfile/i);
	}, 60000);
});

describe('E. root never writes in a tree it does not own', () => {
	test('the predicate', () => {
		expect(ownerRefusal(0, 501)).toContain('not root');
		expect(ownerRefusal(0, 0)).toBeNull();
		expect(ownerRefusal(501, 501)).toBeNull();
		expect(ownerRefusal(null, 501)).toBeNull();
	});

	test.if(process.geteuid?.() !== 0)(
		'as "root" over this user’s tree: refused, node_modules untouched',
		async () => {
			const tree = fixtureTree('owner');
			bootstrapProduction(tree);
			const error = await refusal(() => installDevDependencies({ tree, euid: 0 }));
			expect(error?.code).toBe('install.state_conflict');
			expect(error?.message).toContain("runs as the checkout's owner");
			expect(readdirSync(join(tree, 'node_modules')).sort()).toEqual(['fx-prod']);
		},
		60000,
	);
});

describe('F. the package manager’s environment carries no install secret', () => {
	test('registry/cache/proxy keys pass; secrets do not', () => {
		const env = packageManagerEnv({
			PATH: '/usr/bin',
			HOME: '/home/dev',
			BUN_INSTALL_CACHE_DIR: '/cache',
			https_proxy: 'http://proxy:3128',
			DEDALO_INSTALL_DB_PASSWORD: 'secret',
			DEDALO_INSTALL_ROOT_PASSWORD: 'secret',
			DB_PASSWORD: 'secret',
			SMTP_PASS: 'secret',
		});
		expect(env).toEqual({
			PATH: '/usr/bin',
			HOME: '/home/dev',
			BUN_INSTALL_CACHE_DIR: '/cache',
			https_proxy: 'http://proxy:3128',
		});
	});

	test('the argv is the bootstrap minus --production', () => {
		expect([...DEV_INSTALL_ARGS]).toEqual(['install', '--frozen-lockfile', '--ignore-scripts']);
	});

	test('lock parsing: top-level pins only; a file: spec is checked by presence', () => {
		const lock =
			'  "packages": {\n    "less": ["less@4.9.1", ""],\n    "x/less": ["less@3.0.0", ""],\n    "fx": ["fx@file:vendor/fx", {}],\n';
		expect(lockedVersion(lock, 'less')).toBe('4.9.1');
		expect(lockedVersion(lock, 'fx')).toBe('file:vendor/fx');
		expect(lockedVersion(lock, 'absent')).toBeNull();
		expect(satisfiesLock('4.9.1', '4.9.1')).toBe(true);
		expect(satisfiesLock('4.9.1', '4.9.0')).toBe(false);
		expect(satisfiesLock('file:vendor/fx', '2.0.0')).toBe(true);
		expect(satisfiesLock('file:vendor/fx', null)).toBe(false);
		expect(satisfiesLock(null, '1.0.0')).toBe(false);
	});
});
