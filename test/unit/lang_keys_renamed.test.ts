/**
 * The language keys carry their v6 names (owner ruling 2026-11-22, extending the
 * DEDALO_DATA_LANG_SYNC rename — data_lang_sync_key.test.ts): early v7 spelled
 * four of them without the DEDALO_ prefix. Each early spelling is RETIRED the
 * way every renamed key is (env.ts RETIRED_ENV_KEYS): left ALONE in
 * ../private/.env it REFUSES the boot naming the new key; set beside the new key
 * it configures nothing. Never an alias (two spellings that could disagree).
 *
 * Each boot case runs the config in a CHILD (the active_ontology_tlds.test.ts
 * probe) whose ../private/.env is EMPTY (DEDALO_PRIVATE_DIR → a scratch dir):
 * the parent's merged config (envSnapshot — process env over the real file) is
 * handed over as process env with every language-key spelling removed, so the
 * case alone decides which spelling is set — the real file may carry the new
 * names, and "alone" must mean alone. Values travel in env, never to disk. The
 * child prints what the engine READ for every key, so "the new name is read" is
 * measured, not spelled.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONFIG_CATALOG } from '../../src/config/catalog/index.ts';
import { envSnapshot, RETIRED_ENV_KEYS } from '../../src/config/env.ts';
import { V6_MIGRATION } from '../../src/config/migration_map.ts';

const ROOT = join(import.meta.dir, '..', '..');

/** early-v7 spelling → v6/catalog name. */
const RENAMED = {
	APPLICATION_LANG: 'DEDALO_APPLICATION_LANG',
	DATA_LANG: 'DEDALO_DATA_LANG',
	DATA_NOLAN: 'DEDALO_DATA_NOLAN',
	PROJECTS_DEFAULT_LANGS: 'DEDALO_PROJECTS_DEFAULT_LANGS',
} as const;

// What the engine read for each key: the three config.ts readers + the
// DEDALO_DATA_NOLAN reader the environment/RAG modules share (readers.ts).
const READ_LANG_KEYS =
	"const { config } = await import('./src/config/config.ts');" +
	"const { readString } = await import('./src/config/readers.ts');" +
	'console.log(JSON.stringify({' +
	'applicationLang: config.menu.applicationLang,' +
	'dataLang: config.menu.dataLang,' +
	'projects: config.menu.projectsDefaultLangs,' +
	"nolan: readString('DEDALO_DATA_NOLAN')}));";

const EMPTY_PRIVATE_DIR = mkdtempSync(join(tmpdir(), 'dd_lang_keys_'));
afterAll(() => rmSync(EMPTY_PRIVATE_DIR, { recursive: true, force: true }));

/** The parent's merged config minus every spelling of the renamed keys. */
function baseEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(envSnapshot())) {
		if (value !== undefined) env[key] = value;
	}
	for (const [early, name] of Object.entries(RENAMED)) {
		delete env[early];
		delete env[name];
	}
	env.DEDALO_PRIVATE_DIR = EMPTY_PRIVATE_DIR;
	return env;
}

function bootWith(env: Record<string, string>): {
	exitCode: number;
	read: Record<string, unknown> | null;
	stderr: string;
} {
	const child = Bun.spawnSync(['bun', '-e', READ_LANG_KEYS], {
		cwd: ROOT,
		env: { ...baseEnv(), ...env },
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const last = (child.stdout.toString().trim().split('\n').pop() ?? '').trim();
	return {
		exitCode: child.exitCode,
		read: child.exitCode === 0 ? JSON.parse(last) : null,
		stderr: child.stderr.toString().trim(),
	};
}

// Values distinct from every default, so a read of the wrong key shows.
const NEW_VALUES = {
	DEDALO_APPLICATION_LANG: 'lg-cat',
	DEDALO_DATA_LANG: 'lg-cat',
	DEDALO_DATA_NOLAN: 'lg-zzno',
	DEDALO_PROJECTS_DEFAULT_LANGS: '["lg-cat","lg-eng"]',
};

describe('language keys renamed to their DEDALO_ (v6) names', () => {
	test('the catalog declares the DEDALO_ names and none of the early spellings; each is RETIRED to its new name', () => {
		for (const [early, name] of Object.entries(RENAMED)) {
			expect(CONFIG_CATALOG[name]).toBeDefined();
			expect(CONFIG_CATALOG[early]).toBeUndefined();
			expect(RETIRED_ENV_KEYS[early]).toBe(name);
		}
	});

	test('the engine READS the new names', () => {
		const boot = bootWith(NEW_VALUES);
		expect(boot.stderr).not.toContain('RETIRED');
		expect(boot.exitCode).toBe(0);
		expect(boot.read).toEqual({
			applicationLang: 'lg-cat',
			dataLang: 'lg-cat',
			projects: ['lg-cat', 'lg-eng'],
			nolan: 'lg-zzno',
		});
	});

	for (const [early, name] of Object.entries(RENAMED)) {
		test(`${early} ALONE refuses the boot, naming ${name}`, () => {
			const env: Record<string, string> = { ...NEW_VALUES, [early]: 'lg-eng' };
			// The new key must be ABSENT for "alone" (baseEnv removed the inherited one).
			delete env[name];
			const boot = bootWith(env);
			expect(boot.exitCode).not.toBe(0);
			expect(boot.stderr).toContain(`'${early}' is RETIRED`);
			expect(boot.stderr).toContain(name);
		});

		test(`${early} beside ${name} configures nothing`, () => {
			const boot = bootWith({ ...NEW_VALUES, [early]: 'lg-spa' });
			expect(boot.exitCode).toBe(0);
			expect(boot.read).toEqual({
				applicationLang: 'lg-cat',
				dataLang: 'lg-cat',
				projects: ['lg-cat', 'lg-eng'],
				nolan: 'lg-zzno',
			});
		});

		test(`the v6 migration maps ${name} straight across`, () => {
			expect(V6_MIGRATION[name]).toEqual({ cls: 'SAME', target: name });
		});
	}
});
