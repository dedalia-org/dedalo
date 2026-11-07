/**
 * ACTIVE STYLE REGISTRY — the active-field styles stay one list (2026-11-02).
 *
 * `client/dedalo/core/page/js/active_style.js` ACTIVE_STYLES is the registry.
 * Every non-default id needs exactly one stylesheet `core/page/css/active_styles/<id>.less`,
 * scoped under its own `:root[data-active_style="<id>"]` and imported by main.less;
 * every label key is a defined label; head-init.js caches under the same key.
 * And the server side: `pickUiPreferences` ships only a small plain object.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pickUiPreferences } from '../../src/core/security/user_identity.ts';

const ROOT = join(import.meta.dir, '../..');
const PAGE = join(ROOT, 'client/dedalo/core/page');
const registrySource = readFileSync(join(PAGE, 'js/active_style.js'), 'utf8');

const registry = [
	...registrySource.matchAll(/\{\s*id\s*:\s*'([a-z_]+)',\s*label\s*:\s*'([a-z_]+)'\s*\}/g),
].map((m) => ({ id: m[1] as string, label: m[2] as string }));

describe('active style registry', () => {
	test('parses, default first (anti-vacuity)', () => {
		expect(registry.length).toBeGreaterThanOrEqual(3);
		expect(registry[0]?.id).toBe('default');
	});

	test('every non-default style has its own scoped stylesheet, and nothing else does', () => {
		const ids = registry.map((s) => s.id).filter((id) => id !== 'default');
		const files = readdirSync(join(PAGE, 'css/active_styles'))
			.filter((f) => f.endsWith('.less'))
			.map((f) => f.slice(0, -5));
		expect(files.sort()).toEqual([...ids].sort());
		for (const id of ids) {
			const less = readFileSync(join(PAGE, `css/active_styles/${id}.less`), 'utf8');
			const selectors = [...less.matchAll(/:root\[data-active_style="([a-z_]+)"\]/g)].map(
				(m) => m[1],
			);
			expect(selectors.length).toBeGreaterThan(0);
			expect(new Set(selectors)).toEqual(new Set([id]));
		}
	});

	test('main.less imports exactly the registered stylesheets', () => {
		const main = readFileSync(join(PAGE, 'css/main.less'), 'utf8');
		const imported = [...main.matchAll(/@import '\.\/active_styles\/([a-z_]+)'/g)].map((m) => m[1]);
		expect(imported.sort()).toEqual(
			registry
				.map((s) => s.id)
				.filter((id) => id !== 'default')
				.sort(),
		);
	});

	test('every style label is a defined label', () => {
		const master = JSON.parse(readFileSync(join(ROOT, 'src/core/labels/master.json'), 'utf8'));
		for (const { label } of registry) expect(typeof master[label]).toBe('string');
	});

	test('head-init.js caches under ACTIVE_STYLE_KEY', () => {
		const key = registrySource.match(/ACTIVE_STYLE_KEY = '([a-z_]+)'/)?.[1];
		expect(key).toBeDefined();
		expect(readFileSync(join(PAGE, 'js/head-init.js'), 'utf8')).toContain(`'${key}'`);
	});
});

describe('pickUiPreferences', () => {
	test('the first item value when it is a plain object', () => {
		expect(pickUiPreferences([{ id: 1, value: { active_style: 'lift' } }])).toEqual({
			active_style: 'lift',
		});
	});

	test('null for no data, scalars, arrays and oversized documents', () => {
		expect(pickUiPreferences(null)).toBeNull();
		expect(pickUiPreferences([])).toBeNull();
		expect(pickUiPreferences([{ value: 'lift' }])).toBeNull();
		expect(pickUiPreferences([{ value: [1] }])).toBeNull();
		expect(pickUiPreferences([{ value: null }])).toBeNull();
		expect(pickUiPreferences([{ value: { x: 'a'.repeat(5000) } }])).toBeNull();
	});
});
