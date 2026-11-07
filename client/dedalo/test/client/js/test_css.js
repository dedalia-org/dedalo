// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global it, describe, after, assert */
/*eslint no-undef: "error"*/

import { ui } from '../../../core/common/js/ui.js';
/**
 * TEST_CSS
 * The ontology-css engine (core/page/js/css.js): what set_element_css writes into
 * #elements_style_sheet, and the area consumer (ui.area.build_wrapper_edit).
 * Backend-free; every key is a zzcss_* scope class swept after.
 */
import {
	get_elements_style_sheet,
	get_inserted_rules,
	prune_rules,
	set_element_css,
} from '../../../core/page/js/css.js';

// flush: the engine batches on requestAnimationFrame; a rAF requested after the
// engine's own runs after it
const flush = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

// rules whose text mentions a token
const rules_with = (token) =>
	[...get_elements_style_sheet().cssRules].filter((rule) => rule.cssText.includes(token));

// a literal colour, as ontology data carries one — read from the palette main.css
// declares (frame.html loads it), so no colour is spelled in this source
const palette_colour = () => {
	const value = getComputedStyle(document.documentElement)
		.getPropertyValue('--color_hilite')
		.trim();
	if (!value) throw new Error('--color_hilite not declared: main.css not loaded in the frame');
	return value;
};

const sweep = () => prune_rules((rule) => rule.cssText.includes('zzcss_'));

describe('CSS (ontology css engine)', () => {
	after(sweep);

	it('scopes .wrapper fragments as compound and others as direct child', async () => {
		await set_element_css('zzcss_a.edit', {
			'.wrapper_component': { 'grid-column': 'span 2' },
			'.content_data': { padding: '1px' },
			'> .label': { 'padding-left': '2px' },
		});
		await flush();
		const selectors = rules_with('zzcss_a').map((rule) => rule.selectorText);
		assert.include(selectors, '.zzcss_a.edit.wrapper_component');
		assert.include(selectors, '.zzcss_a.edit > .content_data');
		assert.include(selectors, '.zzcss_a.edit > .label');
	});

	it('scopes EVERY top-level comma branch (none leaks globally)', async () => {
		await set_element_css('zzcss_b', { '.content_data, .label:is(.x, .y)': { margin: '0px' } });
		await flush();
		const [rule] = rules_with('zzcss_b');
		assert.ok(rule, 'rule inserted');
		const branches = rule.selectorText.split(/,(?![^(]*\))/).map((el) => el.trim());
		assert.equal(branches.length, 2);
		for (const el of branches) {
			assert.ok(el.startsWith('.zzcss_b'), `branch scoped: ${el}`);
		}
	});

	it('two elements sharing one @media query BOTH keep their responsive css', async () => {
		const media = '@media screen and (max-width: 1024px)';
		await set_element_css('zzcss_m1', {
			'.wrapper_component': { 'grid-column': 'span 5', [media]: { 'grid-column': 'span 10' } },
		});
		await set_element_css('zzcss_m2', {
			'.wrapper_component': { 'grid-column': 'span 3', [media]: { 'grid-column': 'span 6' } },
		});
		await flush();
		const m1 = rules_with('zzcss_m1')
			.map((rule) => rule.cssText)
			.join(' ');
		const m2 = rules_with('zzcss_m2')
			.map((rule) => rule.cssText)
			.join(' ');
		assert.include(m1, 'span 10', 'first element keeps its @media block');
		assert.include(m2, 'span 6', 'second element keeps its @media block');
	});

	it('nested ":hover" / "&" keys become nested rules of the owner', async () => {
		await set_element_css('zzcss_h', { '.wrapper_component': { ':hover': { opacity: '0.5' } } });
		await flush();
		const [rule] = rules_with('zzcss_h');
		assert.ok(rule, 'rule inserted');
		assert.equal(rule.selectorText, '.zzcss_h.wrapper_component');
		assert.match(rule.cssText, /&:hover\s*\{\s*opacity: 0.5;?\s*\}/);
	});

	it('accepts numeric values and skips the legacy v5 style/mixin block', async () => {
		await set_element_css('zzcss_n', {
			'.wrapper_component': { order: 2, mixin: ['.vertical'], style: { width: '50%' } },
		});
		await flush();
		const rules = rules_with('zzcss_n');
		assert.equal(rules.length, 1);
		assert.include(rules[0].cssText, 'order: 2');
		assert.notInclude(rules[0].cssText, '50%');
	});

	it('identical re-set is a no-op; a changed body REPLACES the rule', async () => {
		await set_element_css('zzcss_r', { '.wrapper_component': { width: '10px' } });
		await flush();
		await set_element_css('zzcss_r', { '.wrapper_component': { width: '10px' } });
		await flush();
		assert.equal(rules_with('zzcss_r').length, 1);
		await set_element_css('zzcss_r', { '.wrapper_component': { width: '20px' } });
		await flush();
		const rules = rules_with('zzcss_r');
		assert.equal(rules.length, 1, 'old rule removed, not duplicated');
		assert.include(rules[0].cssText, '20px');
	});

	it('replace works when the browser re-serializes the selector', async () => {
		// ':before' is serialized '::before': a selector-text match would miss it
		await set_element_css('zzcss_s', { '.wrapper_component:before': { content: 'A' } });
		await flush();
		await set_element_css('zzcss_s', { '.wrapper_component:before': { content: 'B' } });
		await flush();
		const rules = rules_with('zzcss_s');
		assert.equal(rules.length, 1, 'no duplicate after replace');
		assert.include(rules[0].cssText, '"B"');
	});

	it('prune_rules evicts the cache so the next set re-inserts', async () => {
		await set_element_css('zzcss_p', { '.wrapper_component:before': { content: 'P' } });
		await flush();
		prune_rules((rule) => rule.cssText.includes('zzcss_p'));
		assert.equal(rules_with('zzcss_p').length, 0);
		assert.notOk(
			[...get_inserted_rules().keys()].some((key) => key.includes('zzcss_p')),
			'cache evicted',
		);
		await set_element_css('zzcss_p', { '.wrapper_component:before': { content: 'P' } });
		await flush();
		assert.equal(rules_with('zzcss_p').length, 1, 're-inserted after prune');
	});

	it('literal colours get a dark-theme counterpart, nested at-rules included', async () => {
		await set_element_css('zzcss_d', {
			'.wrapper_component': {
				'background-color': palette_colour(),
				'@media (max-width: 600px)': { color: palette_colour() },
			},
		});
		await flush();
		const dark = rules_with('zzcss_d').filter((rule) => rule.selectorText.startsWith(':root'));
		assert.equal(dark.length, 1);
		assert.include(dark[0].cssText, 'hsl(from');
		assert.include(dark[0].cssText, '@media');
	});

	it('dark counterpart of a comma-list fragment scopes every branch to the dark theme', async () => {
		await set_element_css('zzcss_k', { '.content_data, .label': { color: palette_colour() } });
		await flush();
		const dark = rules_with('zzcss_k').filter((rule) => rule.selectorText.startsWith(':root'));
		assert.equal(dark.length, 1);
		const branches = dark[0].selectorText.split(',');
		assert.equal(branches.length, 2);
		assert.ok(
			branches.every((branch) => branch.trim().startsWith(':root')),
			dark[0].selectorText,
		);
	});

	it('area css applies in the mode the area is opened in (the menu opens areas in list)', async () => {
		const wrapper = ui.area.build_wrapper_edit(
			{
				model: 'area',
				type: 'area',
				tipo: 'zzcss_area',
				section_tipo: 'zzcss_area',
				mode: 'list',
				label: null,
				context: {
					css: {
						'.wrapper_area': { 'padding-top': '3px' },
						add_class: { wrapper: ['zzcss_c1', 'zzcss_c2'] },
					},
				},
			},
			{ content_data: document.createElement('div') },
		);
		document.body.appendChild(wrapper);
		try {
			await flush();
			assert.ok(wrapper.classList.contains('zzcss_c1'), 'add_class array: first class');
			assert.ok(wrapper.classList.contains('zzcss_c2'), 'add_class array: second class');
			const [rule] = rules_with('zzcss_area');
			assert.ok(rule, 'area rule inserted');
			assert.ok(
				wrapper.matches(rule.selectorText),
				`rule ${rule.selectorText} matches the list wrapper`,
			);
			assert.equal(getComputedStyle(wrapper).paddingTop, '3px');
		} finally {
			wrapper.remove();
		}
	});
});

// @license-end
