/**
 * Site-A emission decision table (PHP build_structure_context_core,
 * class.common.php:1801-1846) — resolveEmittedPropertiesAndCss, DB-free.
 *
 * The rule under test: component css add-ons are EDIT-oriented and must never
 * leak into list mode (PHP remove_edit_css); sections/portals swap to their
 * section_list child's css in list mode; the section node's properties.css[tipo]
 * overrides a component's css in any mode; and the TS-only WC-016 extension
 * (`css.list` / `css.search` reserved keys) mode-scopes a css object while
 * keeping every bare (PHP-era) object byte-identical to the oracle.
 */

import { describe, expect, test } from 'bun:test';
import { resolveEmittedPropertiesAndCss } from '../../src/core/resolve/structure_context.ts';

const EDIT_CSS = { '.wrapper_component': { 'grid-column': 'span 5' } };
const CHILD_CSS = { '.column_numisdata77': { style: { width: '200px' } } };

function resolve(overrides: Partial<Parameters<typeof resolveEmittedPropertiesAndCss>[0]>) {
	return resolveEmittedPropertiesAndCss({
		model: 'component_input_text',
		mode: 'list',
		tipo: 'test281',
		ownProperties: { css: structuredClone(EDIT_CSS), other: 'kept' },
		sectionListChildProperties: null,
		sectionProperties: null,
		...overrides,
	});
}

describe('plain components (remove_edit_css, PHP :1823-1830)', () => {
	test('list mode strips the edit css', () => {
		const { properties, css } = resolve({ mode: 'list' });
		expect(css).toBeNull();
		expect(properties.other).toBe('kept');
	});

	test('edit, search and tm modes keep the authored css', () => {
		for (const mode of ['edit', 'search', 'tm']) {
			expect(resolve({ mode }).css).toEqual(EDIT_CSS);
		}
	});

	test('css is ALWAYS stripped from the emitted properties (PHP :1834)', () => {
		for (const mode of ['edit', 'list', 'search']) {
			expect(resolve({ mode }).properties).not.toContainKey('css');
		}
	});

	test('component without css emits null in every mode', () => {
		for (const mode of ['edit', 'list']) {
			expect(resolve({ mode, ownProperties: { other: 1 } }).css).toBeNull();
		}
	});

	test('non-object css passes through outside list and nulls in list', () => {
		expect(resolve({ mode: 'edit', ownProperties: { css: 'raw' } }).css).toBe('raw');
		expect(resolve({ mode: 'list', ownProperties: { css: 'raw' } }).css).toBeNull();
	});

	test('groupers and buttons follow the same list strip', () => {
		for (const model of ['section_group', 'button_save']) {
			expect(resolve({ model, mode: 'list' }).css).toBeNull();
			expect(resolve({ model, mode: 'edit' }).css).toEqual(EDIT_CSS);
		}
	});
});

describe('areas keep their css in list mode (WC-2026-11-07-area-css-list-mode, TS-only)', () => {
	for (const model of ['area', 'area_thesaurus', 'area_maintenance']) {
		test(`${model}+list emits its own css (one render for list and edit)`, () => {
			expect(resolve({ model, mode: 'list' }).css).toEqual(EDIT_CSS);
		});
	}

	test('a model merely containing "area" is still stripped', () => {
		expect(resolve({ model: 'component_text_area', mode: 'list' }).css).toBeNull();
	});
});

describe('section / component_portal list swap (PHP :1806-1822)', () => {
	for (const model of ['section', 'component_portal']) {
		test(`${model}+list with a section_list child emits the CHILD properties/css`, () => {
			const { properties, css } = resolve({
				model,
				mode: 'list',
				sectionListChildProperties: { css: structuredClone(CHILD_CSS), from: 'child' },
			});
			expect(css).toEqual(CHILD_CSS);
			expect(properties.from).toBe('child');
			expect(properties).not.toContainKey('css');
		});

		test(`${model}+list with a css-less child emits null css (child still wins)`, () => {
			const { properties, css } = resolve({
				model,
				mode: 'list',
				sectionListChildProperties: { from: 'child' },
			});
			expect(css).toBeNull();
			expect(properties.from).toBe('child');
		});

		test(`${model}+list WITHOUT child strips to null over own properties`, () => {
			const { properties, css } = resolve({ model, mode: 'list' });
			expect(css).toBeNull();
			expect(properties.other).toBe('kept');
		});
	}

	test('section in tm mode emits its OWN properties and css (swap is list-only)', () => {
		const { properties, css } = resolve({
			model: 'section',
			mode: 'tm',
			sectionListChildProperties: null,
		});
		expect(css).toEqual(EDIT_CSS);
		expect(properties.other).toBe('kept');
	});
});

describe('section-node css override (PHP :1840-1846)', () => {
	const SECTION_PROPS = { css: { test281: { '.cell': { color: 'red' } } } };

	test('replaces a list-stripped null (override survives list mode)', () => {
		const { css } = resolve({ mode: 'list', sectionProperties: SECTION_PROPS });
		expect(css).toEqual({ '.cell': { color: 'red' } });
	});

	test('replaces a non-null edit css', () => {
		const { css } = resolve({ mode: 'edit', sectionProperties: SECTION_PROPS });
		expect(css).toEqual({ '.cell': { color: 'red' } });
	});

	test('isset semantics: a null override value does not override', () => {
		const { css } = resolve({
			mode: 'edit',
			sectionProperties: { css: { test281: null } },
		});
		expect(css).toEqual(EDIT_CSS);
	});

	test('only component_* models are overridden', () => {
		const { css } = resolve({
			model: 'section',
			mode: 'edit',
			tipo: 'test281',
			sectionProperties: SECTION_PROPS,
		});
		expect(css).toEqual(EDIT_CSS);
	});
});

describe('WC-016 mode keys (css.list / css.search, TS-only)', () => {
	const MODE_KEYED = {
		'.wrapper_component': { 'grid-column': 'span 5' },
		list: { '.cell': { width: '12%' } },
		search: { label: { color: 'blue' } },
	};

	test('css.list opts a component into list-mode css despite the strip', () => {
		const { css } = resolve({ mode: 'list', ownProperties: { css: MODE_KEYED } });
		expect(css).toEqual({ '.cell': { width: '12%' } });
	});

	test('css.search wins in search mode; bare keys win elsewhere without leaks', () => {
		const own = { css: MODE_KEYED };
		expect(resolve({ mode: 'search', ownProperties: own }).css).toEqual({
			label: { color: 'blue' },
		});
		for (const mode of ['edit', 'tm']) {
			expect(resolve({ mode, ownProperties: own }).css).toEqual({
				'.wrapper_component': { 'grid-column': 'span 5' },
			});
		}
	});

	test('an object with ONLY reserved keys emits null (not {}) outside its modes', () => {
		const { css } = resolve({
			mode: 'edit',
			ownProperties: { css: { list: { '.cell': { width: '1px' } } } },
		});
		expect(css).toBeNull();
	});

	test('bare (PHP-era) objects pass through BYTE-identically — {} stays {}', () => {
		expect(resolve({ mode: 'edit', ownProperties: { css: {} } }).css).toEqual({});
	});

	test('mode keys resolve inside a section-node override too', () => {
		const { css } = resolve({
			mode: 'list',
			sectionProperties: { css: { test281: { list: { '.cell': { width: '9%' } } } } },
		});
		expect(css).toEqual({ '.cell': { width: '9%' } });
	});

	test('a bare override is NOT list-stripped (PHP replaces the nulled css)', () => {
		const { css } = resolve({
			mode: 'list',
			sectionProperties: { css: { test281: { '.cell': { color: 'red' } } } },
		});
		expect(css).toEqual({ '.cell': { color: 'red' } });
	});

	test('section_list child css can carry mode keys', () => {
		const { css } = resolve({
			model: 'section',
			mode: 'list',
			sectionListChildProperties: { css: { ...CHILD_CSS, list: { '.only': { x: '1' } } } },
		});
		expect(css).toEqual({ '.only': { x: '1' } });
	});
});

describe('reference isolation (the inputs come from the resolver cache)', () => {
	test('mutating the returned properties/css never reaches the inputs', () => {
		const own = { css: { '.a': { w: '1' } }, nested: { deep: true } };
		const sectionProps = { css: { test281: { '.b': { w: '2' } } } };
		// No override here: css must be the OWN-properties clone.
		const result = resolve({ mode: 'edit', ownProperties: own });
		expect(result.css).toEqual({ '.a': { w: '1' } });
		(result.properties.nested as Record<string, unknown>).deep = false;
		(result.css as Record<string, Record<string, string>>)['.a'] = { w: 'mutated' };
		expect(own.nested.deep).toBe(true);
		expect(own.css['.a']).toEqual({ w: '1' });

		const overridden = resolve({
			mode: 'edit',
			ownProperties: own,
			sectionProperties: sectionProps,
		});
		(overridden.css as Record<string, Record<string, string>>)['.b'] = { w: 'mutated' };
		expect(sectionProps.css.test281['.b']).toEqual({ w: '2' });
	});
});
