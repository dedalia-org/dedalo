/**
 * An unset DEDALO_APPLICATION_LANG / DEDALO_DATA_LANG must fall back to the install's
 * declared defaults, never a literal: the login form (anonymous, no session) renders in
 * that language, and a literal 'lg-spa' once overrode DEDALO_APPLICATION_LANGS_DEFAULT=lg-eng.
 */
import { describe, expect, test } from 'bun:test';
import { catalogEntry } from '../../src/config/catalog/index.ts';
import type { ComputedDefault } from '../../src/config/catalog_types.ts';

const fakeGet = (key: string): string => `<${key}>`;

describe('session lang keys default to the install defaults', () => {
	for (const [key, source] of [
		['DEDALO_APPLICATION_LANG', 'DEDALO_APPLICATION_LANGS_DEFAULT'],
		['DEDALO_DATA_LANG', 'DEDALO_DATA_LANG_DEFAULT'],
	] as const) {
		test(`${key} ← ${source}`, () => {
			const { default: value } = catalogEntry(key);
			expect(typeof value).toBe('function');
			expect((value as ComputedDefault)(fakeGet)).toBe(`<${source}>`);
			expect(catalogEntry(key).emptyIsUnset).toBe(true);
		});
	}
});
