/**
 * THE EXPORT'S DATA LANG IS THE ONE THE USER PICKED — withExportLang.
 *
 * tool_export sends `lang` (the data-lang selector) with every build. The build
 * handler fills in the SUBMITTER's data lang only when `lang` is absent, and
 * refuses a value that is not a Dédalo lang code. The producer no longer falls
 * back to a hardcoded install language (grid.ts exportLangOf).
 */

import { describe, expect, test } from 'bun:test';
import { DedaloError } from '../../src/core/errors/index.ts';
import { withExportLang } from '../../tools/tool_export/server/export_job.ts';

describe('withExportLang', () => {
	test('keeps the lang the user picked, over the submitter lang', () => {
		const options = withExportLang({ section_tipo: 'test3', lang: 'lg-cat' }, 'lg-eng');
		expect(options.lang).toBe('lg-cat');
	});

	test('takes the submitter data lang when the request carries none', () => {
		const options = withExportLang({ section_tipo: 'test3' }, 'lg-fra');
		expect(options.lang).toBe('lg-fra');
		expect(options.section_tipo).toBe('test3');
	});

	test('does not mutate the caller options', () => {
		const input = { section_tipo: 'test3' };
		withExportLang(input, 'lg-eng');
		expect(Object.hasOwn(input, 'lang')).toBe(false);
	});

	test('refuses a value that is not a Dédalo lang code', () => {
		expect(() => withExportLang({ lang: 'Spanish' }, 'lg-eng')).toThrow(DedaloError);
		expect(() => withExportLang({ lang: 42 }, 'lg-eng')).toThrow(DedaloError);
	});
});
