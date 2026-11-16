/**
 * INSTALL STATE at boot — `src/config/install_state.ts` (UNCONFIGURED,
 * notInstalledRefusal, NOT_INSTALLED_EXIT_CODE). Successor of install_mode_boot
 * (2026-10-12, WC-2026-10-12-install-surface-removed): there is no install mode any
 * more — a box that is not installed refuses to start. This gate holds the PREDICATE
 * in fresh child processes (both values are decided at import, so each case gets
 * its own environment); no_install_surface_tripwire spawns the real server and holds
 * the boot outcome (exit code, no listener, no write).
 *
 * The four required keys are blanked to '' in the child env: process env wins over
 * `../private/.env` in readEnv, and '' reads as unset regardless of the dev
 * machine's real `.env`. DEDALO_PRIVATE_DIR points at an EMPTY scratch dir (no
 * `.env` there), DEDALO_TS_STATE_PATH at a scratch state file per case.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
	type ConfiguredWritablePath,
	parseWritableRootsManifest,
	pathUnderRoot,
	writableRootsRefusal,
	writableRootsViolations,
} from '../../src/config/writable_roots.ts';

const STATE_MODULE = resolve(import.meta.dir, '../../src/config/install_state.ts');
const CONFIG_MODULE = resolve(import.meta.dir, '../../src/config/config.ts');
const SCRATCH = mkdtempSync(join(tmpdir(), 'dedalo_zzisb_install_state_'));
const PRIVATE_DIR = join(SCRATCH, 'private');
mkdirSync(PRIVATE_DIR, { recursive: true });

afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

const BLANK = { ENTITY: '', DB_NAME: '', DB_HOST: '', DB_USER: '' };
const CONFIGURED = { ENTITY: 'zzisb', DB_NAME: 'zzisb', DB_HOST: 'localhost', DB_USER: 'zzisb' };

/** A scratch state file carrying `status` (undefined = no file at all). */
function statePath(name: string, status?: string): string {
	const path = join(SCRATCH, `${name}.json`);
	if (status !== undefined) writeFileSync(path, JSON.stringify({ install_status: status }));
	return path;
}

/** Import install_state in a child with `env`; its UNCONFIGURED + refusal. */
function probe(env: Record<string, string>): {
	unconfigured: boolean;
	refusal: string | null;
	exitCode: number;
} {
	const program = `const m = await import(${JSON.stringify(STATE_MODULE)});
		console.log(JSON.stringify({ unconfigured: m.UNCONFIGURED, refusal: m.notInstalledRefusal(), exitCode: m.NOT_INSTALLED_EXIT_CODE }));`;
	const proc = Bun.spawnSync(['bun', '-e', program], {
		env: { ...process.env, DEDALO_PRIVATE_DIR: PRIVATE_DIR, ...env },
		stdout: 'pipe',
		stderr: 'pipe',
	});
	if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
	return JSON.parse(proc.stdout.toString().trim().split('\n').at(-1) ?? '');
}

describe('UNCONFIGURED and the refusal', () => {
	test('the exit code is EX_CONFIG (78): not the restart code, not a crash, not success', () => {
		const result = probe({ ...BLANK, DEDALO_TS_STATE_PATH: statePath('none') });
		expect(result.exitCode).toBe(78);
		expect([0, 1, 75]).not.toContain(result.exitCode);
	});

	test('no keys, no state → not installed: run the installer', () => {
		const result = probe({ ...BLANK, DEDALO_TS_STATE_PATH: statePath('none') });
		expect(result.unconfigured).toBe(true);
		expect(result.refusal).toStartWith('not installed:');
		expect(result.refusal).toContain('ENTITY, DB_NAME, DB_HOST, DB_USER');
		expect(result.refusal).toContain('bun run dedalo:install');
	});

	test('no keys, SEALED → configuration missing: restore .env (the seal is NOT an install mode)', () => {
		const result = probe({ ...BLANK, DEDALO_TS_STATE_PATH: statePath('sealed', 'sealed') });
		expect(result.unconfigured).toBe(true);
		expect(result.refusal).toStartWith('configuration missing:');
		expect(result.refusal).toContain('Restore .env from backup');
	});

	test('no keys, a .env with content but none of the four → incomplete: do not reinstall', () => {
		const dir = join(SCRATCH, 'private_with_env');
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, '.env'), 'DEDALO_SOME_OTHER_KEY=1\n');
		const result = probe({
			...BLANK,
			DEDALO_PRIVATE_DIR: dir,
			DEDALO_TS_STATE_PATH: statePath('none'),
		});
		expect(result.refusal).toStartWith('configuration incomplete:');
		expect(result.refusal).toContain('do not reinstall');
	});

	test('keys set + any install_status other than sealed → install not finished: --resume', () => {
		for (const status of ['terminal_installing', 'configured', 'installing', 'zzisb-garbage']) {
			const result = probe({ ...CONFIGURED, DEDALO_TS_STATE_PATH: statePath(status, status) });
			expect(result.unconfigured, status).toBe(false);
			expect(result.refusal, status).toStartWith('install not finished');
			expect(result.refusal, status).toContain('--resume');
		}
	});

	test('keys set + sealed, or no state file, or a garbled one → null (boot)', () => {
		const garbled = join(SCRATCH, 'garbled.json');
		writeFileSync(garbled, '{ not json');
		for (const path of [statePath('sealed', 'sealed'), statePath('none'), garbled]) {
			expect(probe({ ...CONFIGURED, DEDALO_TS_STATE_PATH: path }).refusal, path).toBeNull();
		}
	});
});

describe('the config import on a box that is not installed', () => {
	/** Import config in a child; ok + the resolved entity. */
	function importConfig(env: Record<string, string>): {
		ok: boolean;
		stdout: string;
		stderr: string;
	} {
		const proc = Bun.spawnSync(
			[
				'bun',
				'-e',
				`const { config } = await import(${JSON.stringify(CONFIG_MODULE)}); console.log(JSON.stringify({ entity: config.entity, database: config.db.database }));`,
			],
			{
				env: { ...process.env, DEDALO_PRIVATE_DIR: PRIVATE_DIR, ...env },
				stdout: 'pipe',
				stderr: 'pipe',
			},
		);
		return {
			ok: proc.exitCode === 0,
			stdout: proc.stdout.toString().trim(),
			stderr: proc.stderr.toString(),
		};
	}

	test('UNCONFIGURED (sealed or not) imports on sentinels — so the server can reach its refusal', () => {
		for (const path of [statePath('none'), statePath('sealed', 'sealed')]) {
			const result = importConfig({ ...BLANK, DEDALO_TS_STATE_PATH: path });
			expect(result.ok, result.stderr.slice(-800)).toBe(true);
			expect(JSON.parse(result.stdout.split('\n').at(-1) ?? '')).toEqual({
				entity: 'install',
				database: 'dedalo_install_placeholder',
			});
		}
	});

	test('PARTIAL config still throws the precise missing-key error (misconfigured, not unconfigured)', () => {
		const result = importConfig({
			...BLANK,
			ENTITY: 'zzisb',
			DEDALO_TS_STATE_PATH: statePath('none'),
		});
		expect(result.ok).toBe(false);
		// Which key is named first depends on the config build order; the shape is the law.
		expect(result.stderr).toMatch(/Missing required config key '[A-Z_]+'/);
	});
});

/**
 * THE WRITABLE ROOTS (owner ruling C32, 2026-11-13 — src/config/writable_roots.ts):
 * under ProtectSystem=strict the engine may write only the roots its drop-in
 * opened; the installer's manifest names them, and a configured path outside
 * them is a boot REFUSAL (exit 78) naming the root re-render command — never
 * an EROFS at the first write.
 */
describe("the writable roots: a configured path outside the unit's roots refuses the boot (C32)", () => {
	const manifest = (over: Record<string, unknown> = {}) =>
		JSON.stringify({
			format: 1,
			instance: 'zzisb',
			stamp: 'abcdef0123456789',
			read_write_paths: ['/home/ded_zzisb', '/srv/dedalo/zzisb', '/run/dedalo-zzisb', '/tmp'],
			refresh:
				'sudo /opt/dedalo/bun/1.4.4/bun run /home/ded_zzisb/dedalo/scripts/ops/host_units_refresh.ts --instance zzisb',
			...over,
		});
	const file = (name: string, text: string): string => {
		const path = join(SCRATCH, name);
		writeFileSync(path, text);
		return path;
	};
	const inside: ConfiguredWritablePath[] = [
		{ label: 'the private directory', path: '/home/ded_zzisb/private' },
		{ label: 'MEDIA_PATH', path: '/srv/dedalo/zzisb/dedalo/media' },
		{ label: 'SERVER_UNIX_SOCKET (its directory)', path: '/run/dedalo-zzisb' },
		{ label: 'the temp directory', path: '/tmp' },
	];

	test('every configured path under a listed root → null (the boot proceeds)', () => {
		expect(writableRootsRefusal(file('ok.json', manifest()), inside)).toBeNull();
	});

	test('no manifest named (docker, trial, developer) → null: no check', () => {
		expect(writableRootsRefusal(undefined, inside)).toBeNull();
		expect(writableRootsRefusal('', inside)).toBeNull();
	});

	test('a path outside every root → the refusal names the path, the roots and the re-render command', () => {
		const moved = [...inside, { label: 'MEDIA_PATH', path: '/data/museum/dedalo/media' }];
		const refusal = writableRootsRefusal(file('moved.json', manifest()), moved);
		expect(refusal).not.toBeNull();
		expect(refusal).toContain('MEDIA_PATH /data/museum/dedalo/media');
		expect(refusal).toContain('ProtectSystem=strict');
		expect(refusal).toContain('/home/ded_zzisb /srv/dedalo/zzisb /run/dedalo-zzisb /tmp');
		expect(refusal).toContain('host_units_refresh.ts --instance zzisb');
		// the paths that ARE under a root are not named
		expect(refusal).not.toContain('/srv/dedalo/zzisb/dedalo/media');
	});

	test('a sibling prefix is not "under" (/home/ded_zzisb2 vs /home/ded_zzisb); the root itself is', () => {
		expect(pathUnderRoot('/home/ded_zzisb2/private', '/home/ded_zzisb')).toBe(false);
		expect(pathUnderRoot('/home/ded_zzisb', '/home/ded_zzisb')).toBe(true);
		expect(pathUnderRoot('/x', '/')).toBe(true);
		expect(
			writableRootsViolations(['/home/ded_zzisb'], [{ label: 'HOME', path: '/home/ded_zzisb2' }]),
		).toEqual(['HOME /home/ded_zzisb2']);
	});

	test('a manifest that is named but missing, not JSON, or malformed → refused (fail closed), naming the re-render script', () => {
		const missing = writableRootsRefusal(join(SCRATCH, 'no_such_manifest.json'), inside);
		expect(missing).toMatch(/cannot be read \(ENOENT\)/);
		expect(missing).toContain('host_units_refresh.ts');
		expect(writableRootsRefusal(file('bad.json', '{ not json'), inside)).toMatch(
			/malformed \(not JSON\)/,
		);
		for (const [name, over, why] of [
			['format', { format: 2 }, 'format 2, expected 1'],
			['instance', { instance: '' }, 'no instance'],
			['refresh', { refresh: '' }, 'no refresh command'],
			[
				'roots',
				{ read_write_paths: [] },
				'read_write_paths is not a non-empty list of absolute paths',
			],
			[
				'relative',
				{ read_write_paths: ['home/x'] },
				'read_write_paths is not a non-empty list of absolute paths',
			],
		] as const) {
			expect(parseWritableRootsManifest(manifest(over)), name).toBe(why);
			expect(writableRootsRefusal(file(`${name}.json`, manifest(over)), inside)).toContain(why);
		}
		const parsed = parseWritableRootsManifest(manifest());
		expect(typeof parsed).toBe('object');
		expect((parsed as { instance: string }).instance).toBe('zzisb');
	});
});

/**
 * THE WIRING (review 2026-11-14): the pure predicate above proves what a refusal
 * SAYS; nothing proved the engine ASKS it. A refactor that drops
 * `refuseBootOutsideWritableRoots()` from startServer, or moves it after the
 * listener and the boot writers, left every gate green — and the C32 promise
 * (a path outside the roots fails at BOOT, never at its first write under
 * ProtectSystem=strict) would be false. Source-pinned: the call sits in
 * startServer after the install-state refusal and BEFORE the dev-listener
 * resolution, the smoke-boot branch and the first `Bun.serve(`.
 */
describe('the writable-roots refusal is WIRED into startServer, before any listener or boot writer', () => {
	const source = readFileSync(resolve(import.meta.dir, '../../src/server.ts'), 'utf8');
	const body = source.slice(source.indexOf('export async function startServer()'));

	test('startServer calls refuseBootOutsideWritableRoots() exactly once, imported from config/writable_roots.ts', () => {
		expect(source).toContain(
			"import { refuseBootOutsideWritableRoots } from './config/writable_roots.ts';",
		);
		expect(body.indexOf('export async function startServer()')).toBe(0);
		expect(body.split('refuseBootOutsideWritableRoots();').length - 1).toBe(1);
	});

	test('the call follows the install-state refusal and precedes the dev listener, the smoke-boot branch and the first Bun.serve(', () => {
		const at = (needle: string): number => {
			const index = body.indexOf(needle);
			expect(index, `startServer no longer contains ${needle}`).toBeGreaterThan(-1);
			return index;
		};
		const refusal = at('refuseBootOutsideWritableRoots();');
		expect(refusal).toBeGreaterThan(at('refuseBootWhenNotInstalled();'));
		expect(refusal).toBeLessThan(at('resolveDevListenerOrRefuse('));
		expect(refusal).toBeLessThan(at("readEnv('DEDALO_SMOKE_BOOT')"));
		expect(refusal).toBeLessThan(at('Bun.serve('));
	});
});
