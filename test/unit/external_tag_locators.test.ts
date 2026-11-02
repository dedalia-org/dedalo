/**
 * TAG LOCATORS — the pure halves of the observed-data law
 * (component_text_area/tag_grammar.ts extractTagLocators +
 * section/record/external_laws/observed_data.ts orderTextLangs /
 * tagLocatorsAcrossLangs).
 *
 * Pins the owner rulings (2026-10-30): DOCUMENT order inside a text (across
 * tag types too), the lang union in a fixed order (lg-nolan, the main data
 * lang, the rest sorted), first occurrence wins; plus the critique-2 shape:
 * every payload key survives (a legend's svg tag carries component_tipo) and
 * section_id leaves canonical ('86' → 86). The payload shape is the live one
 * (a live coin legend: {'section_tipo':'<symbols>','section_id':'86',
 * 'component_tipo':'hierarchy95'}), spelled on generic zz tipos.
 */

import { describe, expect, test } from 'bun:test';
import {
	extractTagLocators,
	LOCATOR_TAG_TYPES,
} from '../../src/core/components/component_text_area/tag_grammar.ts';
import {
	orderTextLangs,
	tagLocatorsAcrossLangs,
} from '../../src/core/section/record/external_laws/observed_data.ts';

const svg = (id: number, sectionId: string | number, extra = '') =>
	`[svg-n-${id}--data:{'section_tipo':'zzxtlsym1','section_id':'${sectionId}','component_tipo':'zzxtlimg1'${extra}}:data]`;

describe('extractTagLocators', () => {
	test('a legend svg tag → its locator, every key kept, section_id canonical', () => {
		expect(extractTagLocators(`<p>Legend ${svg(1, '86')} text</p>`, ['svg'])).toEqual([
			{ section_tipo: 'zzxtlsym1', section_id: 86, component_tipo: 'zzxtlimg1' },
		]);
	});

	test('DOCUMENT order, across tag types (not per-type passes)', () => {
		const text = `${svg(1, '5')} a [note-n-2--data:{'section_tipo':'zzxtlnote1','section_id':'9'}:data] b ${svg(3, '4')}`;
		expect(
			extractTagLocators(text, ['svg', 'note']).map(
				(locator) => `${locator.section_tipo}/${locator.section_id}`,
			),
		).toEqual(['zzxtlsym1/5', 'zzxtlnote1/9', 'zzxtlsym1/4']);
	});

	test('only the requested types are read', () => {
		const text = `${svg(1, '5')} [note-n-2--data:{'section_tipo':'zzxtlnote1','section_id':'9'}:data]`;
		expect(extractTagLocators(text, ['svg']).map((locator) => locator.section_tipo)).toEqual([
			'zzxtlsym1',
		]);
		expect(extractTagLocators(text, ['note']).map((locator) => locator.section_tipo)).toEqual([
			'zzxtlnote1',
		]);
	});

	test('first occurrence wins (PHP in_array): the same payload twice, or with ids in both spellings', () => {
		const text = `${svg(1, '86')} ${svg(2, '86')} [svg-n-3--data:{'section_id':86,'section_tipo':'zzxtlsym1','component_tipo':'zzxtlimg1'}:data]`;
		expect(extractTagLocators(text, ['svg'])).toHaveLength(1);
	});

	test('a different component_tipo is a different payload (the merge decides by address later)', () => {
		const text = `${svg(1, '86')} [svg-n-2--data:{'section_tipo':'zzxtlsym1','section_id':'86','component_tipo':'zzxtlimg2'}:data]`;
		expect(extractTagLocators(text, ['svg'])).toHaveLength(2);
	});

	test('non-locator payloads (draw paper data, a lang code, garbage) are skipped', () => {
		const text = [
			`[draw-n-1--data:{'type':'paper','layers':[]}:data]`,
			`[lang-n-2-spa-data:"lg-spa":data]`,
			'[svg-n-3--data:not json:data]',
			`[svg-n-4--data:{'section_tipo':'zzxtlsym1','section_id':{'x':1}}:data]`,
			svg(5, '7'),
		].join(' ');
		expect(extractTagLocators(text, ['svg', 'draw', 'lang'])).toEqual([
			{ section_tipo: 'zzxtlsym1', section_id: 7, component_tipo: 'zzxtlimg1' },
		]);
	});

	test('HTML-escaped quotes (&#39;) parse like plain single quotes', () => {
		const text =
			'[svg-n-1--data:{&#39;section_tipo&#39;:&#39;zzxtlsym1&#39;,&#39;section_id&#39;:&#39;3&#39;}:data]';
		expect(extractTagLocators(text, ['svg'])).toEqual([
			{ section_tipo: 'zzxtlsym1', section_id: 3 },
		]);
	});

	test('page tags need their label when they carry data (PHP pattern)', () => {
		expect(
			extractTagLocators(`[page-n-1-p1-data:{'section_tipo':'zzxtlp1','section_id':'2'}:data]`, [
				'page',
			]),
		).toHaveLength(1);
		expect(
			extractTagLocators(`[page-n-1-data:{'section_tipo':'zzxtlp1','section_id':'2'}:data]`, [
				'page',
			]),
		).toEqual([]);
	});

	test('empty text, no tags, an unknown tag type in the list → []', () => {
		expect(extractTagLocators('', ['svg'])).toEqual([]);
		expect(extractTagLocators('<p>no tags</p>', ['svg'])).toEqual([]);
		expect(extractTagLocators(svg(1, '5'), ['person'])).toEqual([]);
	});

	test('the closed tag set is the PHP capture-7 set', () => {
		expect([...LOCATOR_TAG_TYPES]).toEqual(['svg', 'draw', 'geo', 'page', 'note', 'lang']);
	});
});

describe('orderTextLangs', () => {
	test('lg-nolan, then the main data lang, then the rest sorted; deduped', () => {
		expect(orderTextLangs(['lg-spa', 'lg-cat', 'lg-eng', 'lg-nolan', 'lg-cat'], 'lg-eng')).toEqual([
			'lg-nolan',
			'lg-eng',
			'lg-cat',
			'lg-spa',
		]);
	});

	test('absent heads are not invented', () => {
		expect(orderTextLangs(['lg-spa', 'lg-cat'], 'lg-eng')).toEqual(['lg-cat', 'lg-spa']);
		expect(orderTextLangs([], 'lg-eng')).toEqual([]);
	});
});

describe('tagLocatorsAcrossLangs', () => {
	test('the lang UNION in lang order, document order inside each, first occurrence wins', () => {
		const items = [
			{ id: 1, lang: 'lg-spa', value: `${svg(1, '30')} ${svg(2, '10')}` },
			{ id: 1, lang: 'lg-eng', value: `${svg(1, '20')} ${svg(2, '10')}` },
			{ id: 1, lang: 'lg-nolan', value: svg(1, '10') },
			{ id: 1, lang: 'lg-cat', value: svg(1, '40') },
		];
		expect(
			tagLocatorsAcrossLangs(items, ['svg'], 'lg-eng').map((locator) => locator.section_id),
		).toEqual([10, 20, 40, 30]);
	});

	test('a lang-less item reads as lg-nolan; non-string values and non-objects hold nothing', () => {
		const items = [
			{ lang: 'lg-spa', value: svg(1, '2') },
			{ value: svg(1, '1') },
			{ lang: 'lg-spa', value: 7 },
			null as unknown as { lang?: unknown; value?: unknown },
		];
		expect(
			tagLocatorsAcrossLangs(items, ['svg'], 'lg-eng').map((locator) => locator.section_id),
		).toEqual([1, 2]);
	});

	test('no items → []', () => {
		expect(tagLocatorsAcrossLangs([], ['svg'], 'lg-eng')).toEqual([]);
	});
});
