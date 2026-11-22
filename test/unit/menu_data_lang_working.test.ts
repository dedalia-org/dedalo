/**
 * THE MENU DATA LANGUAGE IS A WORKING LANGUAGE — at BOOT (owner ruling
 * 2026-11-22, review LOW-1). `lg-nolan` is declared (the non-translatable
 * storage slot) but nobody works in it, and the menu data language is what every
 * fresh session, MCP stdio and the seed clamp fall back to. So:
 *   - `DEDALO_DATA_LANG=lg-nolan` is OVERRULED by DEDALO_DATA_LANG_DEFAULT and
 *     REPORTED at boot — the precedent of an undeclared value (data_langs.ts
 *     `resolveCurrentDataLang`: report, not throw, so a working server does not
 *     die for a language-list mistake);
 *   - `DEDALO_DATA_LANG_DEFAULT=lg-nolan` REFUSES the boot — the precedent of a
 *     default that names no real language (data_langs.ts `declaredDataLangs`).
 * The pure rule is gated in write_lang_provenance_native.test.ts; these legs
 * measure what the CONFIG MODULE publishes. Each boots config in a CHILD whose
 * ../private/.env is EMPTY (DEDALO_PRIVATE_DIR → scratch) and whose env is the
 * parent's merged config with the case's keys set — values travel in env, never
 * to disk (the lang_keys_renamed.test.ts probe).
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { envSnapshot } from '../../src/config/env.ts';

const ROOT = join(import.meta.dir, '..', '..');
const EMPTY_PRIVATE_DIR = mkdtempSync(join(tmpdir(), 'dd_menu_lang_'));
afterAll(() => rmSync(EMPTY_PRIVATE_DIR, { recursive: true, force: true }));

const READ_MENU_LANG =
	"const { config } = await import('./src/config/config.ts');" +
	'console.log(JSON.stringify({ dataLang: config.menu.dataLang, dataLangDefault: config.lang.dataLangDefault }));';

/** A real declared working language and its default, distinct so the overrule shows. */
const BASE = {
	DEDALO_PROJECTS_DEFAULT_LANGS: '["lg-cat","lg-eng"]',
	DEDALO_DATA_LANG_DEFAULT: 'lg-eng',
	DEDALO_DATA_LANG: 'lg-cat',
};

function bootWith(env: Record<string, string>): {
	exitCode: number;
	read: { dataLang: string; dataLangDefault: string } | null;
	stderr: string;
} {
	const merged: Record<string, string> = {};
	for (const [key, value] of Object.entries(envSnapshot())) {
		if (value !== undefined) merged[key] = value;
	}
	const child = Bun.spawnSync(['bun', '-e', READ_MENU_LANG], {
		cwd: ROOT,
		env: { ...merged, DEDALO_PRIVATE_DIR: EMPTY_PRIVATE_DIR, ...BASE, ...env },
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const last = (child.stdout.toString().trim().split('\n').pop() ?? '').trim();
	return {
		exitCode: child.exitCode,
		read: child.exitCode === 0 ? JSON.parse(last) : null,
		stderr: child.stderr.toString(),
	};
}

describe('the menu data language is a working language (boot)', () => {
	test('FLOOR: a declared working DEDALO_DATA_LANG is kept, nothing reported', () => {
		const boot = bootWith({});
		expect(boot.exitCode).toBe(0);
		expect(boot.read).toEqual({ dataLang: 'lg-cat', dataLangDefault: 'lg-eng' });
		expect(boot.stderr).not.toContain('DEDALO_DATA_LANG =');
	});

	test('DEDALO_DATA_LANG = lg-nolan is overruled by the default and REPORTED', () => {
		const boot = bootWith({ DEDALO_DATA_LANG: 'lg-nolan' });
		expect(boot.exitCode).toBe(0);
		expect(boot.read).toEqual({ dataLang: 'lg-eng', dataLangDefault: 'lg-eng' });
		expect(boot.stderr).toContain(
			"[config] DEDALO_DATA_LANG = 'lg-nolan' is the no-language storage slot",
		);
	});

	test('a MISSPELT lg-nolan default is refused by the GRAMMAR (no spelling slips past the slot check)', () => {
		for (const misspelt of [' lg-nolan', 'LG-NOLAN']) {
			const boot = bootWith({ DEDALO_DATA_LANG_DEFAULT: misspelt });
			expect(boot.exitCode, misspelt).not.toBe(0);
			expect(boot.stderr, misspelt).toContain(
				`DEDALO_DATA_LANG_DEFAULT = '${misspelt}' does not name one real language`,
			);
		}
	});

	test('DEDALO_DATA_LANG_DEFAULT = lg-nolan REFUSES the boot, naming the key', () => {
		const boot = bootWith({ DEDALO_DATA_LANG_DEFAULT: 'lg-nolan' });
		expect(boot.exitCode).not.toBe(0);
		expect(boot.stderr).toContain(
			"DEDALO_DATA_LANG_DEFAULT = 'lg-nolan' is the no-language storage slot",
		);
	});
});
