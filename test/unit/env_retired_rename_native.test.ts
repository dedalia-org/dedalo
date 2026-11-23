/**
 * GATE — a RETIRED config key is RENAMED, not refused (2026-11-23, owner ruling
 * after beta7's update died at the smoke boot on DATA_LANG_SYNC).
 *
 * src/config/env_retired_rename.ts is the ONE door: the updater runs it pre-swap
 * through the new tree's entry (scripts/ops/rename_retired_env_keys.ts), the real
 * boot runs it on its own .env (an updater too old to call the entry), and the
 * smoke child judges what that real boot will do. Every case builds its own
 * scratch private dir — never ../private. Children get a CONTROLLED environment,
 * so "set in the process environment" is the case's choice, not the machine's.
 *
 * Pipeline ordering (rename before smoke, a refusal swaps nothing) lives in
 * code_update.test.ts beside the other preflight seams.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { envSnapshot, processEnvValue, RETIRED_ENV_KEYS } from '../../src/config/env.ts';
import {
	RETIRED_ENV_RENAME_ENTRY,
	renameRetiredEnvKeysPreSwap,
} from '../../src/core/update/code_update.ts';
import { refusalOf } from '../helpers/refusal.ts';

const ROOT = join(import.meta.dir, '..', '..');
const SCRATCH = mkdtempSync(join(tmpdir(), 'dd_retired_rename_'));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

let counter = 0;
/** A fresh scratch private dir holding `.env` = `content`; returns the .env path. */
function envFile(content: string): string {
	const dir = join(SCRATCH, `p${counter++}`);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, '.env');
	writeFileSync(path, content);
	return path;
}

/** Run the release's entry on `path` with ONLY `extraEnv` in the process env. */
function runEntry(path: string, extraEnv: Record<string, string> = {}) {
	const child = Bun.spawnSync(['bun', 'run', RETIRED_ENV_RENAME_ENTRY, path], {
		cwd: ROOT,
		env: { PATH: Bun.env.PATH ?? '', DEDALO_PRIVATE_DIR: join(SCRATCH, 'none'), ...extraEnv },
		stdout: 'pipe',
		stderr: 'pipe',
	});
	expect(child.stderr.toString()).toBe('');
	expect(child.exitCode).toBe(0);
	return JSON.parse(child.stdout.toString().trim()) as {
		appended: { retired: string; replacement: string; value: string }[];
		refused: { retired: string; replacement: string; blocker: string }[];
	};
}

/** Every spelling of every retired key — removed from a booted child's inherited env. */
const ALL_SPELLINGS = Object.entries(RETIRED_ENV_KEYS).flat();

/** Boot the config in a child whose private dir is `privateDir`; print the lang keys read. */
function bootConfig(privateDir: string, env: Record<string, string> = {}) {
	const base: Record<string, string> = {};
	for (const [key, value] of Object.entries(envSnapshot())) {
		if (value !== undefined && !ALL_SPELLINGS.includes(key)) base[key] = value;
	}
	const child = Bun.spawnSync(
		[
			'bun',
			'-e',
			"const { config } = await import('./src/config/config.ts');" +
				"const { readString } = await import('./src/config/readers.ts');" +
				'console.log(JSON.stringify({ app: config.menu.applicationLang, projects: config.menu.projectsDefaultLangs,' +
				" nolan: readString('DEDALO_DATA_NOLAN') }));",
		],
		{
			cwd: ROOT,
			env: { ...base, DEDALO_PRIVATE_DIR: privateDir, ...env },
			stdout: 'pipe',
			stderr: 'pipe',
		},
	);
	const last = (child.stdout.toString().trim().split('\n').pop() ?? '').trim();
	return {
		exitCode: child.exitCode,
		read: child.exitCode === 0 ? (JSON.parse(last) as Record<string, unknown>) : null,
		stderr: child.stderr.toString(),
	};
}

const dirOf = (path: string): string => join(path, '..');

describe('the rename door (the release entry, in a controlled environment)', () => {
	test('appends replacements, the old bytes untouched; value fidelity incl. quotes, CRLF, last-wins; idempotent', () => {
		const original = [
			'# install',
			'APPLICATION_LANG="lg-cat"',
			'PROJECTS_DEFAULT_LANGS=\'["lg-cat","lg-eng"]\'',
			'DATA_NOLAN="a\\"b"',
			'DATA_LANG=lg-eng',
			'DATA_LANG = lg-spa \r',
			'export DATA_LANG_SYNC=true',
		].join('\n');
		const path = envFile(original); // no trailing newline
		const mode = statSync(path).mode;
		const report = runEntry(path);
		expect(report.appended.length).toBeGreaterThan(0); // corpus floor for the toEqual([]) below
		expect(report.refused).toEqual([]);
		expect(report.appended.map((row) => row.replacement).sort()).toEqual([
			'DEDALO_APPLICATION_LANG',
			'DEDALO_DATA_LANG',
			'DEDALO_DATA_NOLAN',
			'DEDALO_PROJECTS_DEFAULT_LANGS',
		]);
		const after = readFileSync(path, 'utf8');
		// append-only: the old content is a byte prefix, a newline separates the append
		expect(after.startsWith(`${original}\n`)).toBe(true);
		expect(statSync(path).mode).toBe(mode);
		const appended = after.slice(original.length + 1);
		expect(appended).toContain('DEDALO_APPLICATION_LANG="lg-cat"\n');
		expect(appended).toContain('DEDALO_PROJECTS_DEFAULT_LANGS=\'["lg-cat","lg-eng"]\'\n');
		expect(appended).toContain('DEDALO_DATA_NOLAN="a\\"b"\n');
		// last-wins, raw bytes after '=' (the loader trims the spaces alike)
		expect(appended).toContain('DEDALO_DATA_LANG= lg-spa \n');
		// `export X=` is not X for the loader, so not for the door either
		expect(appended).not.toContain('DEDALO_DATA_LANG_SYNC');
		const values = Object.fromEntries(report.appended.map((row) => [row.replacement, row.value]));
		expect(values).toEqual({
			DEDALO_APPLICATION_LANG: 'lg-cat',
			DEDALO_PROJECTS_DEFAULT_LANGS: '["lg-cat","lg-eng"]',
			DEDALO_DATA_NOLAN: 'a"b',
			DEDALO_DATA_LANG: 'lg-spa',
		});
		// idempotent
		expect(runEntry(path)).toEqual({ appended: [], refused: [] });
		expect(readFileSync(path, 'utf8')).toBe(after);
	});

	test('a replacement set in the file or the process env → nothing; a missing file → nothing', () => {
		const content = 'DATA_LANG=lg-eng\nDEDALO_DATA_LANG=lg-cat\nDATA_NOLAN=lg-zz\n';
		const path = envFile(content);
		expect(runEntry(path, { DEDALO_DATA_NOLAN: 'lg-nolan' })).toEqual({
			appended: [],
			refused: [],
		});
		expect(readFileSync(path, 'utf8')).toBe(content);
		expect(runEntry(join(SCRATCH, 'absent', '.env'))).toEqual({ appended: [], refused: [] });
	});

	test('a retired key the process env ALSO sets is not renamed — refused, file untouched', () => {
		const content = 'DATA_LANG=lg-eng\nAPPLICATION_LANG=lg-eng\n';
		const path = envFile(content);
		const report = runEntry(path, { DATA_LANG: 'lg-spa', APPLICATION_LANG: 'lg-spa' });
		expect(report.appended).toEqual([]);
		expect(report.refused.map((row) => [row.retired, row.blocker]).sort()).toEqual([
			['APPLICATION_LANG', 'process_env'],
			['DATA_LANG', 'process_env'],
		]);
		expect(readFileSync(path, 'utf8')).toBe(content);
	});

	test('an unwritable file → every pending key refused, nothing written', () => {
		const content = 'DATA_LANG=lg-eng\nDATA_NOLAN=lg-zz\n';
		const path = envFile(content);
		chmodSync(path, 0o444);
		try {
			const report = runEntry(path);
			expect(report.appended).toEqual([]);
			expect(report.refused.map((row) => row.blocker)).toEqual(['unwritable', 'unwritable']);
			expect(readFileSync(path, 'utf8')).toBe(content);
		} finally {
			chmodSync(path, 0o644);
		}
	});
});

/**
 * The door with a hostile `append` seam, in a child with a CONTROLLED env:
 * `short` writes half the bytes then throws ENOSPC (a short write), `garble`
 * writes a line that reads back as another value.
 */
function runDoorWith(path: string, mode: 'short' | 'garble') {
	const child = Bun.spawnSync(
		[
			'bun',
			'-e',
			"const { appendFileSync } = await import('node:fs');" +
				"const { renameRetiredEnvKeys } = await import('./src/config/env_retired_rename.ts');" +
				`const mode = ${JSON.stringify(mode)};` +
				'const append = (p, data) => {' +
				"  if (mode === 'garble') { appendFileSync(p, data.replace('lg-cat', 'lg-XXX')); return; }" +
				'  appendFileSync(p, data.slice(0, Math.floor(data.length / 2)));' +
				"  throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });" +
				'};' +
				`console.log(JSON.stringify(renameRetiredEnvKeys(${JSON.stringify(path)}, append)));`,
		],
		{
			cwd: ROOT,
			env: { PATH: Bun.env.PATH ?? '', DEDALO_PRIVATE_DIR: join(SCRATCH, 'none') },
			stdout: 'pipe',
			stderr: 'pipe',
		},
	);
	expect(child.exitCode, child.stderr.toString()).toBe(0);
	return JSON.parse(child.stdout.toString().trim().split('\n').pop() ?? '') as {
		appended: unknown[];
		refused: { retired: string; blocker: string }[];
	};
}

describe('an append that fails or reads back wrong is ROLLED BACK (no partial line is ever trusted)', () => {
	for (const [mode, blocker] of [
		['short', 'unwritable'],
		['garble', 'readback'],
	] as const) {
		test(`${mode} → file byte-identical, every key refused '${blocker}', the retry renames cleanly`, () => {
			const content = 'APPLICATION_LANG=lg-cat\nPROJECTS_DEFAULT_LANGS=lg-spa,lg-cat,lg-eng';
			const path = envFile(content);
			const report = runDoorWith(path, mode);
			expect(report.appended).toEqual([]);
			expect(report.refused.map((row) => [row.retired, row.blocker]).sort()).toEqual([
				['APPLICATION_LANG', blocker],
				['PROJECTS_DEFAULT_LANGS', blocker],
			]);
			expect(readFileSync(path, 'utf8')).toBe(content);
			// the retry (disk freed) is not fooled by leftovers: full values land
			const retry = runEntry(path);
			expect(Object.fromEntries(retry.appended.map((row) => [row.replacement, row.value]))).toEqual(
				{
					DEDALO_APPLICATION_LANG: 'lg-cat',
					DEDALO_PROJECTS_DEFAULT_LANGS: 'lg-spa,lg-cat,lg-eng',
				},
			);
		});
	}
});

const LANG_FILE =
	'APPLICATION_LANG=lg-cat\nDATA_LANG=lg-cat\nDATA_NOLAN=lg-zzno\nPROJECTS_DEFAULT_LANGS=["lg-cat","lg-eng"]\n';
const READ = { app: 'lg-cat', projects: ['lg-cat', 'lg-eng'], nolan: 'lg-zzno' };

describe('the real boot heals its own .env (an updater too old to call the entry)', () => {
	test('retired lines in the file are appended under the new names and READ this boot', () => {
		const path = envFile(LANG_FILE);
		const boot = bootConfig(dirOf(path));
		expect(boot.exitCode).toBe(0);
		expect(boot.read).toEqual(READ);
		const after = readFileSync(path, 'utf8');
		expect(after.startsWith(LANG_FILE)).toBe(true);
		expect(after).toContain('DEDALO_PROJECTS_DEFAULT_LANGS=["lg-cat","lg-eng"]\n');
		expect(boot.stderr).toContain("RETIRED key renamed: appended 'DEDALO_DATA_NOLAN'");
		// the next boot appends nothing
		expect(bootConfig(dirOf(path)).exitCode).toBe(0);
		expect(readFileSync(path, 'utf8')).toBe(after);
	});

	test('retired keys in the PROCESS env (or an unwritable file) refuse — ALL named in one message', () => {
		const path = envFile('DEDALO_PROJECTS_DEFAULT_LANGS=["lg-eng"]\n');
		const boot = bootConfig(dirOf(path), { APPLICATION_LANG: 'lg-cat', DATA_NOLAN: 'lg-zz' });
		expect(boot.exitCode).not.toBe(0);
		expect(boot.stderr).toContain(
			"'APPLICATION_LANG' is RETIRED and set in the process environment",
		);
		expect(boot.stderr).toContain('DEDALO_APPLICATION_LANG');
		expect(boot.stderr).toContain("'DATA_NOLAN' is RETIRED and set in the process environment");

		const locked = envFile(LANG_FILE);
		chmodSync(locked, 0o444);
		try {
			const refused = bootConfig(dirOf(locked));
			expect(refused.exitCode).not.toBe(0);
			for (const key of ['APPLICATION_LANG', 'DATA_LANG', 'DATA_NOLAN', 'PROJECTS_DEFAULT_LANGS']) {
				expect(refused.stderr).toContain(`'${key}' is RETIRED and ${locked} is not writable`);
			}
			expect(readFileSync(locked, 'utf8')).toBe(LANG_FILE);
		} finally {
			chmodSync(locked, 0o644);
		}
	});
});

describe('the smoke child gives the verdict the real boot will reach (it never writes)', () => {
	/** As smoke_boot.ts spawns it: the live values in the process env, a throwaway private dir. */
	const smoke = (env: Record<string, string>) =>
		bootConfig(join(SCRATCH, 'throwaway'), {
			DEDALO_SMOKE_BOOT: 'true',
			APPLICATION_LANG: 'lg-cat',
			DATA_LANG: 'lg-cat',
			DATA_NOLAN: 'lg-zzno',
			PROJECTS_DEFAULT_LANGS: '["lg-cat","lg-eng"]',
			...env,
		});

	test('renamable (in the live, writable file) → tolerated and read; the live file is NOT touched', () => {
		const live = envFile(LANG_FILE);
		const boot = smoke({ DEDALO_SMOKE_ENV_FILE: live });
		expect(boot.exitCode).toBe(0);
		expect(boot.read).toEqual(READ);
		expect(readFileSync(live, 'utf8')).toBe(LANG_FILE);
	});

	test('already renamed pre-swap (the updater snapshot predates it) → tolerated', () => {
		const live = envFile(
			`${LANG_FILE}DEDALO_APPLICATION_LANG=lg-cat\nDEDALO_DATA_LANG=lg-cat\nDEDALO_DATA_NOLAN=lg-zzno\nDEDALO_PROJECTS_DEFAULT_LANGS=["lg-cat","lg-eng"]\n`,
		);
		const boot = smoke({ DEDALO_SMOKE_ENV_FILE: live });
		expect(boot.exitCode).toBe(0);
		expect(boot.read).toEqual(READ);
	});

	test('not in the live file (process env) or an unwritable live file → refused, all named', () => {
		const live = envFile('DATA_NOLAN=lg-zzno\nPROJECTS_DEFAULT_LANGS=["lg-cat","lg-eng"]\n');
		const boot = smoke({ DEDALO_SMOKE_ENV_FILE: live });
		expect(boot.exitCode).not.toBe(0);
		expect(boot.stderr).toContain(
			"'APPLICATION_LANG' is RETIRED and set in the process environment",
		);
		expect(boot.stderr).toContain("'DATA_LANG' is RETIRED and set in the process environment");

		const locked = envFile(LANG_FILE);
		chmodSync(locked, 0o444);
		try {
			const refused = smoke({ DEDALO_SMOKE_ENV_FILE: locked });
			expect(refused.exitCode).not.toBe(0);
			expect(refused.stderr).toContain(`'DATA_NOLAN' is RETIRED and ${locked} is not writable`);
		} finally {
			chmodSync(locked, 0o644);
		}
	});

	test('an older updater names no live file → tolerated, said, nothing judged', () => {
		const boot = smoke({});
		expect(boot.exitCode).toBe(0);
		expect(boot.read).toEqual(READ);
		expect(boot.stderr).toContain('named no DEDALO_SMOKE_ENV_FILE');
	});
});

describe('the updater pre-swap call (the quarantine tree decides)', () => {
	test('a tree with the entry renames in the live .env and returns the operator sentence', async () => {
		// The entry inherits THIS process's env (the live one): use a pair it sets in neither spelling.
		const pair = Object.entries(RETIRED_ENV_KEYS).find(
			([retired, replacement]) =>
				processEnvValue(retired) === undefined && processEnvValue(replacement) === undefined,
		);
		expect(pair).toBeDefined();
		const [retired, replacement] = pair as [string, string];
		const path = envFile(`${retired}="v 1"`);
		const sentence = await renameRetiredEnvKeysPreSwap(ROOT, path);
		expect(sentence).toContain(`${retired} → ${replacement}`);
		expect(readFileSync(path, 'utf8')).toBe(`${retired}="v 1"\n${replacement}="v 1"\n`);
		expect(await renameRetiredEnvKeysPreSwap(ROOT, path)).toBeNull();
	});

	test('a tree without the entry (an older release) is skipped, the file untouched', async () => {
		const path = envFile('DATA_LANG=lg-eng\n');
		const olderTree = join(SCRATCH, 'older_tree');
		mkdirSync(olderTree, { recursive: true });
		expect(await renameRetiredEnvKeysPreSwap(olderTree, path)).toBeNull();
		expect(readFileSync(path, 'utf8')).toBe('DATA_LANG=lg-eng\n');
	});

	test('a key the entry cannot rename refuses the update, naming every one', async () => {
		const path = envFile('DATA_LANG=lg-eng\nDATA_NOLAN=lg-zz\n');
		chmodSync(path, 0o444);
		try {
			const refusal = await refusalOf(renameRetiredEnvKeysPreSwap(ROOT, path));
			expect(refusal.code).toBe('update.refused');
			expect(refusal.message).toContain('DATA_LANG → DEDALO_DATA_LANG');
			expect(refusal.message).toContain('DATA_NOLAN → DEDALO_DATA_NOLAN');
		} finally {
			chmodSync(path, 0o644);
		}
	});
});
