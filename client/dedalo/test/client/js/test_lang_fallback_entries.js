// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global it, describe, assert */
/*eslint no-undef: "error"*/

/**
 * TEST_LANG_FALLBACK_ENTRIES
 * A CLEARED translation shows the other-language text (T1-34 / O14, review).
 *
 * A cleared translation is persisted as an ITEM ({id, lang, value:''}); since
 * T1-34 the server sends `fallback_value` beside it (wire:
 * test/unit/lang_fallback_empty_slice_native.test.ts R8/R9). The client used to
 * judge the ITEM's truthiness (`if (entries[i])`), so the cleared object won
 * and the cell rendered blank — the O14 symptom, untouched by a wire-only gate.
 *
 * WHY THESE ASSERTIONS. Each case drives the SHIPPED renderer (the merge
 * helpers and the real list/mini/text views of component_input_text and the
 * text_area list view) with the exact payload the server emits and asserts the
 * DOM text: the fallback text, marked. Controls: a filled entry wins over a
 * fallback; '0' is a value; no fallback sent → blank (never invented); the
 * fallback is escaped (markup in it stays text).
 * Backend-free: stub instances, no request leaves the page.
 */

import { get_fallback_value } from '../../../core/common/js/common.js';
import {
	is_empty_entry,
	render_fallback_value,
} from '../../../core/common/js/utils/render_escape.js';
import { view_default_list_input_text } from '../../../core/component_input_text/js/view_default_list_input_text.js';
import { view_mini_input_text } from '../../../core/component_input_text/js/view_mini_input_text.js';
import { view_text_input_text } from '../../../core/component_input_text/js/view_text_input_text.js';
import { view_default_list_text_area } from '../../../core/component_text_area/js/view_default_list_text_area.js';

const CLEARED = [{ id: 1, lang: 'lg-spa', value: '' }];
const FALLBACK = [{ value: 'Hello' }];

/** A stub list instance carrying the server's payload. */
const make_self = (model, entries, fallback_value) => ({
	id: `${model}_fb_${Math.random()}`,
	model: model,
	type: 'component',
	tipo: 'test52',
	section_tipo: 'test3',
	mode: 'list',
	lang: 'lg-spa',
	permissions: 1,
	events_tokens: [],
	context: { properties: {}, render_class: 'text', css: {}, fields_separator: ' | ' },
	data: { entries, fallback_value, lang: 'lg-spa' },
});

const mark_text = (node) => {
	const mark = node.querySelector('mark');
	return mark ? mark.textContent : null;
};

describe('LANG FALLBACK: a cleared translation shows the other-language text', () => {
	it('is_empty_entry judges the VALUE, not the item', () => {
		for (const value of [
			'',
			'   ',
			null,
			undefined,
			false,
			[],
			'<p></p>',
			' <p> </p> ',
			'<br data-mce-bogus="1">',
		]) {
			assert.strictEqual(is_empty_entry({ id: 1, value }), true, `empty: ${JSON.stringify(value)}`);
		}
		assert.strictEqual(is_empty_entry(null), true);
		assert.strictEqual(is_empty_entry(undefined), true);
		for (const value of ['0', 0, 'Hola', '<b></b>', ['x']]) {
			assert.strictEqual(
				is_empty_entry({ id: 1, value }),
				false,
				`value: ${JSON.stringify(value)}`,
			);
		}
	});

	it('render_fallback_value: a cleared entry → the marked fallback; controls hold', () => {
		assert.deepEqual(render_fallback_value(CLEARED, FALLBACK, 'text'), ['<mark>Hello</mark>']);
		// rich-text ghost markup left by the editor
		assert.deepEqual(render_fallback_value([{ id: 1, value: '<p></p>' }], FALLBACK, 'text'), [
			'<mark>Hello</mark>',
		]);
		// controls
		assert.deepEqual(
			render_fallback_value([{ id: 1, value: 'Hola' }], FALLBACK, 'text'),
			['Hola'],
			'filled entry wins',
		);
		assert.deepEqual(
			render_fallback_value([{ id: 1, value: '0' }], FALLBACK, 'text'),
			['0'],
			"'0' is a value",
		);
		assert.deepEqual(
			render_fallback_value(CLEARED, null, 'text'),
			[''],
			'no fallback sent → blank, never invented',
		);
		assert.deepEqual(
			render_fallback_value([], FALLBACK, 'text'),
			['<mark>Hello</mark>'],
			'absent slice (unchanged)',
		);
		// the fallback is escaped before the wrap
		assert.deepEqual(render_fallback_value(CLEARED, [{ value: '<img src=x>' }], 'text'), [
			'<mark>&lt;img src=x&gt;</mark>',
		]);
	});

	it('get_fallback_value (common.js): a cleared entry → the marked fallback', () => {
		assert.deepEqual(get_fallback_value(CLEARED, FALLBACK), ['<mark>Hello</mark>']);
		assert.deepEqual(get_fallback_value([{ id: 1, value: 'Hola' }], FALLBACK), ['Hola']);
		assert.deepEqual(get_fallback_value(CLEARED, null), ['']);
	});

	it('component_input_text LIST cell shows the fallback (the O14 list symptom)', async () => {
		const node = await view_default_list_input_text.render(
			make_self('component_input_text', CLEARED, FALLBACK),
			{},
		);
		assert.strictEqual(mark_text(node), 'Hello');
		assert.strictEqual(node.textContent.trim(), 'Hello');
		// control: a filled translation is shown unmarked
		const filled = await view_default_list_input_text.render(
			make_self('component_input_text', [{ id: 1, value: 'Hola' }], FALLBACK),
			{},
		);
		assert.strictEqual(mark_text(filled), null);
		assert.strictEqual(filled.textContent.trim(), 'Hola');
	});

	it('component_input_text MINI and TEXT views show the fallback', async () => {
		const mini = await view_mini_input_text.render(
			make_self('component_input_text', CLEARED, FALLBACK),
			{},
		);
		assert.strictEqual(mark_text(mini), 'Hello');
		const text = await view_text_input_text.render(
			make_self('component_input_text', CLEARED, FALLBACK),
			{},
		);
		assert.strictEqual(mark_text(text), 'Hello');
	});

	it('component_text_area LIST shows the fallback when the server sent one', async () => {
		// The text_area LIST wire keeps the PHP count trigger (open owner decision
		// D1): for a cleared slice the server sends NO fallback in list → blank.
		// The client only decides which face a position shows when one is sent.
		const node = await view_default_list_text_area.render(
			make_self('component_text_area', [{ id: 1, value: '<p></p>' }], FALLBACK),
			{},
		);
		assert.strictEqual(mark_text(node), 'Hello');
		const none = await view_default_list_text_area.render(
			make_self('component_text_area', [{ id: 1, value: '<p></p>' }], null),
			{},
		);
		assert.strictEqual(mark_text(none), null);
	});
});

// @license-end
