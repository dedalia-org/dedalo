/**
 * DEDALO_DATA_LANG_SYNC — the catalog name of the data-language sync switch
 * (owner ruling 2026-11-22). Its siblings are DEDALO_-prefixed
 * (DEDALO_DATA_LANG_SELECTOR, DEDALO_DATA_LANG_DEFAULT…) and v6 named it
 * DEDALO_DATA_LANG_SYNC; the TS-era spelling `DATA_LANG_SYNC` is RETIRED the way
 * every renamed key is (env.ts RETIRED_ENV_KEYS): left alone in ../private/.env it
 * REFUSES the boot, naming the new key — never a silent fall back to the default
 * (sync off), and not an alias (an alias would let the two spellings disagree).
 *
 * Each case boots the config in a CHILD with the keys set in its process env
 * (the same probe as active_ontology_tlds.test.ts); the parent's env is the
 * suite's, so neither key is set there.
 */

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { CONFIG_CATALOG } from '../../src/config/catalog/index.ts';
import { RETIRED_ENV_KEYS } from '../../src/config/env.ts';
import { V6_MIGRATION } from '../../src/config/migration_map.ts';

const ROOT = join(import.meta.dir, '..', '..');

const READ_SYNC =
	"const { config } = await import('./src/config/config.ts');" +
	'console.log(JSON.stringify(config.menu.dataLangSync));';

function bootWith(env: Record<string, string | undefined>): {
	exitCode: number;
	stdout: string;
	stderr: string;
} {
	const child = Bun.spawnSync(['bun', '-e', READ_SYNC], {
		cwd: ROOT,
		env: { ...process.env, ...env } as Record<string, string>,
		stdout: 'pipe',
		stderr: 'pipe',
	});
	return {
		exitCode: child.exitCode,
		stdout: (child.stdout.toString().trim().split('\n').pop() ?? '').trim(),
		stderr: child.stderr.toString().trim(),
	};
}

describe('DEDALO_DATA_LANG_SYNC (renamed from DATA_LANG_SYNC)', () => {
	test('the catalog declares DEDALO_DATA_LANG_SYNC (default false) and no DATA_LANG_SYNC', () => {
		expect(CONFIG_CATALOG.DEDALO_DATA_LANG_SYNC?.default).toBe(false);
		expect(CONFIG_CATALOG.DATA_LANG_SYNC).toBeUndefined();
		expect(RETIRED_ENV_KEYS.DATA_LANG_SYNC).toBe('DEDALO_DATA_LANG_SYNC');
	});

	test('the new key configures sync; unset is off', () => {
		const on = bootWith({ DEDALO_DATA_LANG_SYNC: 'true' });
		expect(on.exitCode).toBe(0);
		expect(JSON.parse(on.stdout)).toBe(true);
		const unset = bootWith({});
		expect(unset.exitCode).toBe(0);
		expect(JSON.parse(unset.stdout)).toBe(false);
	});

	test('the old spelling ALONE refuses the boot, naming the new key', () => {
		const boot = bootWith({ DATA_LANG_SYNC: 'true' });
		expect(boot.exitCode).not.toBe(0);
		expect(boot.stderr).toContain('DATA_LANG_SYNC');
		expect(boot.stderr).toContain('RETIRED');
		expect(boot.stderr).toContain('DEDALO_DATA_LANG_SYNC');
	});

	test('the old spelling configures NOTHING when the new key is set', () => {
		const boot = bootWith({ DEDALO_DATA_LANG_SYNC: 'false', DATA_LANG_SYNC: 'true' });
		expect(boot.exitCode).toBe(0);
		expect(JSON.parse(boot.stdout)).toBe(false);
	});

	test('the v6 migration maps DEDALO_DATA_LANG_SYNC straight across', () => {
		expect(V6_MIGRATION.DEDALO_DATA_LANG_SYNC).toEqual({
			cls: 'SAME',
			target: 'DEDALO_DATA_LANG_SYNC',
		});
	});
});
