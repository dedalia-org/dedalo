/**
 * P1 parser-registry gates (DIFFUSION_PLAN D3-P1, DIFFUSION_SPEC §5).
 *
 * Two responsibilities:
 * 1. CLASSIFICATION — every fn name the OLD engine registered (enumerated
 *    from oracle diffusion/api/v1/lib/parsers/index.ts:36-68) is classified
 *    runtime|rewriter with no gaps, and unknown names classify 'unknown'
 *    (a loud compile error at plan validation — never a silent skip).
 * 2. RUNTIME PARITY — table-driven cases for each ported runtime parser,
 *    derived from the oracle's own tests (test/parsers.test.ts) and the
 *    oracle bodies' documented examples, adapted from data_item to ValueIR.
 *    Two oracle test expectations were STALE against its current code
 *    (merge grew a standalone no-columns mode that returns collapsed items,
 *    not null — verified by running the oracle suite); the cases here pin
 *    the current oracle CODE behavior.
 */
// Migrated to the generic `test` TLD 2026-08-19. This suite is PURE — the atoms
// are hand-built ValueIRs and no tipo is ever resolved — so the tipos are only
// labels: the install names became their `test`-TLD twins
// (src/core/test_data/test_tld_tipo_map.json) or, where the source had no twin,
// generic test-TLD names.

import { describe, expect, test } from 'bun:test';
import { cleanupFormatting, replace } from '../../src/diffusion/parsers/parser_helper.ts';
import {
	classifyParserFn,
	PARSER_CLASSIFICATION,
	RUNTIME_PARSERS,
} from '../../src/diffusion/parsers/registry.ts';
import type { MetaValueIR, ParserContext, ValueMeta } from '../../src/diffusion/parsers/types.ts';
import type { ResolvedLink, ValueIR } from '../../src/diffusion/resolve/record_ir.ts';

// ---------------------------------------------------------------------------
// Test helpers — atom builders and a comparable projection
// ---------------------------------------------------------------------------

const NO_LANGS: ParserContext = { langs: [], mainLang: null };

function scalar(
	value: string | number | boolean | null,
	lang: string | null = null,
	meta?: ValueMeta,
): ValueIR {
	const atom: MetaValueIR = { kind: 'scalar', value, lang };
	if (meta) atom.meta = meta;
	return atom;
}

function json(value: unknown, lang: string | null = null, meta?: ValueMeta): ValueIR {
	const atom: MetaValueIR = { kind: 'json', value, lang };
	if (meta) atom.meta = meta;
	return atom;
}

function ddate(value: unknown, meta?: ValueMeta): ValueIR {
	const atom: MetaValueIR = { kind: 'date', value, lang: null };
	if (meta) atom.meta = meta;
	return atom;
}

function chain(links: ResolvedLink[], meta?: ValueMeta): ValueIR {
	const atom: MetaValueIR = { kind: 'chain', links, lang: null };
	if (meta) atom.meta = meta;
	return atom;
}

function link(sectionTipo: string, sectionId: number | string): ResolvedLink {
	return { sectionTipo, sectionId };
}

/** Run a registered runtime parser by its community fn name. */
function run(
	fn: string,
	values: ValueIR[],
	options: Record<string, unknown> = {},
	ctx: ParserContext = NO_LANGS,
): ValueIR[] {
	const parser = RUNTIME_PARSERS.get(fn);
	if (!parser) throw new Error(`not a runtime parser: ${fn}`);
	return parser(values, options, ctx);
}

/** First resolved row of a parser_map::custom result (json atom of object rows). */
function firstRow(out: ValueIR[]): Record<string, string | null> {
	const rows = (out[0] as { value: unknown }).value as Record<string, string | null>[];
	return rows[0] as Record<string, string | null>;
}

/** Project atoms to their comparable core (drop provenance meta). */
function strip(values: ValueIR[]): Array<{ kind: string; value: unknown; lang: string | null }> {
	return values.map((v) => ({
		kind: v.kind,
		value: v.kind === 'chain' ? v.links : v.value,
		lang: v.lang,
	}));
}

// ---------------------------------------------------------------------------
// Classification — the full oracle surface, no gaps
// ---------------------------------------------------------------------------

/** EVERY fn name registered by the old engine (oracle lib/parsers/index.ts:36-68). */
const ORACLE_REGISTERED_FNS = [
	'parser_helper::get_first',
	'parser_helper::get_tail',
	'parser_helper::count',
	'parser_helper::merge',
	'parser_text::default_join',
	'parser_text::text_format',
	'parser_text::map_value',
	'parser_text::v5_html',
	'parser_locator::get_section_id',
	'parser_locator::get_section_tipo',
	'parser_locator::get_term_id',
	'parser_locator::get_section_id_grouped',
	'parser_locator::get_locator',
	'parser_locator::filter_parents_by_term_id',
	'parser_locator::parents',
	'parser_locator::truncate_by_term_id',
	'parser_locator::truncate_by_model',
	'parser_locator::filter_by_section_tipo',
	'parser_locator::slice_chain',
	'parser_locator::map_section_tipo_to_name',
	'parser_date::select_properties',
	'parser_date::select_keys',
	'parser_date::format_string_date',
	'parser_date::string_date',
	'parser_date::unix_timestamp',
	'parser_date::default',
	'parser_info::widget',
	'parser_info::default',
	'parser_iri::flat',
	'parser_geo::geojson',
	'parser_global::merge_columns',
	'parser_global::publication_unix_timestamp',
	'parser_map::custom',
] as const;

/**
 * Fns NEW in v7 — absent from the oracle lib/parsers/index.ts surface.
 * get_v6_section_id: v6-compat string projection of section_id (a migrated
 * column publishes ["1"] where the v7-native get_section_id publishes [1]).
 */
const V7_NATIVE_FNS = ['parser_locator::get_v6_section_id'] as const;

describe('parser classification (spec §5)', () => {
	test('every oracle-registered fn is classified — no gaps, no extras', () => {
		expect([...PARSER_CLASSIFICATION.keys()].sort()).toEqual(
			[...ORACLE_REGISTERED_FNS, ...V7_NATIVE_FNS].sort(),
		);
		for (const fn of [...ORACLE_REGISTERED_FNS, ...V7_NATIVE_FNS]) {
			expect(classifyParserFn(fn)).not.toBe('unknown');
		}
	});

	test('runtime classification and implementation agree exactly', () => {
		for (const fn of [...ORACLE_REGISTERED_FNS, ...V7_NATIVE_FNS]) {
			expect(RUNTIME_PARSERS.has(fn)).toBe(classifyParserFn(fn) === 'runtime');
		}
	});

	test('unknown fn names classify as unknown (compile-error trigger)', () => {
		expect(classifyParserFn('nonexistent::x')).toBe('unknown');
		expect(classifyParserFn('parser_text::nonexistent')).toBe('unknown');
		expect(classifyParserFn('')).toBe('unknown');
	});
});

// ---------------------------------------------------------------------------
// Pattern replacer (oracle test/parsers.test.ts:19-70)
// ---------------------------------------------------------------------------

describe('pattern replacer (parser_helper replace)', () => {
	// [pattern, values, expected] — verbatim oracle cases
	const cases: Array<[string, (string | null | undefined)[], string]> = [
		['${a}, ${b}, ${c}', ['Juan', 'Perez', '2025'], 'Juan, Perez, 2025'],
		['${a}, ${b}, ${c} /${d}', ['Juan', 'Perez', null, '2025'], 'Juan, Perez /2025'],
		['${a}, ${b}, ${c}', [null, 'Perez', '2025'], 'Perez, 2025'],
		['${a}, ${b}, ${c}', ['Juan', 'Perez', null], 'Juan, Perez'],
		['${a}, ${b}, ${c} /${d}', ['', 'Perez', '', '2025'], 'Perez /2025'],
		['${a}, ${b}', [null, null], ''],
		['Just plain text', ['Unused'], 'Just plain text'],
		['', ['value'], ''],
		['${a} - ${b}', ['Hello', null], 'Hello'],
		['${a} | ${b}', [null, 'World'], 'World'],
		// a value's own edge characters are content, not separators (media paths)
		['${a}', ['/dedalo/media/image/x.jpg'], '/dedalo/media/image/x.jpg'],
		['${a} - ${b}', ['/x.jpg', null], '/x.jpg'],
		['${a}, ${b}', [null, '1936-'], '1936-'],
	];

	test.each(cases)('replace(%p, %p) → %p', (pattern, values, expected) => {
		expect(replace(pattern, values)).toBe(expected);
	});

	test('cleanupFormatting trims stray boundary separators', () => {
		expect(cleanupFormatting(', middle ,')).toBe('middle');
	});
});

// ---------------------------------------------------------------------------
// parser_text
// ---------------------------------------------------------------------------

describe('parser_text::default_join', () => {
	const columns = [{ tipo: 'dd1', model: 'field_text' }];

	test('joins simple string values (column-aware)', () => {
		const out = run(
			'parser_text::default_join',
			[scalar('Hello', null, { tipo: 'dd1' }), scalar('World', null, { tipo: 'dd1' })],
			{ columns },
		);
		expect(strip(out)).toEqual([{ kind: 'scalar', value: 'Hello | World', lang: null }]);
	});

	test('joins with custom separator', () => {
		const out = run(
			'parser_text::default_join',
			[
				scalar('A', null, { tipo: 'dd1' }),
				scalar('B', null, { tipo: 'dd1' }),
				scalar('C', null, { tipo: 'dd1' }),
			],
			{ columns, records_separator: ', ' },
		);
		expect(strip(out)).toEqual([{ kind: 'scalar', value: 'A, B, C', lang: null }]);
	});

	test('empty input → empty output', () => {
		expect(run('parser_text::default_join', [], { columns })).toEqual([]);
	});

	test('skips null values', () => {
		const out = run(
			'parser_text::default_join',
			[
				scalar('Hello', null, { tipo: 'dd1' }),
				scalar(null, null, { tipo: 'dd1' }),
				scalar('World', null, { tipo: 'dd1' }),
			],
			{ columns },
		);
		expect(strip(out)).toEqual([{ kind: 'scalar', value: 'Hello | World', lang: null }]);
	});

	test('standalone mode (no columns): per-lang value list', () => {
		// current oracle merge behavior (its own older test expecting null is stale)
		const out = run('parser_text::default_join', [scalar('Hello'), scalar('World')]);
		expect(strip(out)).toEqual([{ kind: 'json', value: ['Hello', 'World'], lang: null }]);
	});
});

describe('parser_text::text_format', () => {
	test('applies pattern with ids', () => {
		const out = run(
			'parser_text::text_format',
			[
				scalar('John', null, { sourceId: 'firstName' }),
				scalar('Doe', null, { sourceId: 'lastName' }),
				scalar('London', null, { sourceId: 'city' }),
			],
			{ pattern: '${firstName} ${lastName} from ${city}' },
		);
		expect(strip(out)).toEqual([{ kind: 'json', value: ['John Doe from London'], lang: null }]);
	});

	test('cleans separators around null values', () => {
		const out = run(
			'parser_text::text_format',
			[
				scalar('Title', null, { sourceId: 'a' }),
				scalar(null, null, { sourceId: 'b' }),
				scalar('Code', null, { sourceId: 'c' }),
			],
			{ pattern: '${a}, ${b}/${c}' },
		);
		expect(strip(out)).toEqual([{ kind: 'json', value: ['Title/Code'], lang: null }]);
	});

	test('zips multi-value ids positionally (one output per row)', () => {
		const out = run(
			'parser_text::text_format',
			[
				json(['Ana', 'Ger'], null, { sourceId: 'a' }),
				json(['Hero', 'Del'], null, { sourceId: 'b' }),
			],
			{ pattern: '${a} ${b}' },
		);
		expect(strip(out)).toEqual([
			{ kind: 'json', value: ['Ana Hero'], lang: null },
			{ kind: 'json', value: ['Ger Del'], lang: null },
		]);
	});

	test('broadcasts single values across zip rows', () => {
		const out = run(
			'parser_text::text_format',
			[scalar('lg', null, { sourceId: 'a' }), json(['spa', 'eng'], null, { sourceId: 'b' })],
			{ pattern: '${a}-${b}' },
		);
		expect(strip(out)).toEqual([
			{ kind: 'json', value: ['lg-spa'], lang: null },
			{ kind: 'json', value: ['lg-eng'], lang: null },
		]);
	});

	test('group_by_section_id formats each section as a coherent unit', () => {
		// oracle parser_text.ts:132-141 example
		const out = run(
			'parser_text::text_format',
			[
				scalar('Cabeza', null, { sourceId: 'a', sectionId: '1' }),
				scalar('izquierda', null, { sourceId: 'a', sectionId: '1' }),
				scalar('Diadema', null, { sourceId: 'a', sectionId: '1125' }),
			],
			{
				pattern: '${a}',
				group_by_section_id: true,
				fields_separator: ', ',
				records_separator: ' | ',
			},
		);
		expect(out).toHaveLength(1);
		expect((out[0] as { value: unknown }).value).toEqual(['Cabeza, izquierda | Diadema']);
	});

	test('formats each language group independently', () => {
		const out = run(
			'parser_text::text_format',
			[scalar('Hola', 'lg-spa', { sourceId: 'a' }), scalar('Hello', 'lg-eng', { sourceId: 'a' })],
			{ pattern: 'v: ${a}' },
		);
		expect(strip(out)).toEqual([
			{ kind: 'json', value: ['v: Hola'], lang: 'lg-spa' },
			{ kind: 'json', value: ['v: Hello'], lang: 'lg-eng' },
		]);
	});

	test('empty input → empty output', () => {
		expect(run('parser_text::text_format', [], { pattern: '${a}' })).toEqual([]);
	});
});

describe('parser_text::map_value', () => {
	const map = [{ a: { '1': 'yes', '2': 'no' } }];

	test('maps values through the dictionary', () => {
		const out = run('parser_text::map_value', [scalar('1', null, { sourceId: 'a' })], { map });
		expect(strip(out)).toEqual([{ kind: 'scalar', value: 'yes', lang: null }]);
	});

	test('unmapped values pass through unchanged', () => {
		const out = run('parser_text::map_value', [scalar('3', null, { sourceId: 'a' })], { map });
		expect(strip(out)).toEqual([{ kind: 'scalar', value: '3', lang: null }]);
	});

	test('generic mapping applies when item id does not match', () => {
		const out = run('parser_text::map_value', [scalar('2', null, { sourceId: 'z' })], { map });
		expect(strip(out)).toEqual([{ kind: 'scalar', value: 'no', lang: null }]);
	});
});

describe('parser_text::v5_html', () => {
	// [input, expected] — the 8-step v5 normalization
	const cases: Array<[string, string]> = [
		['<p>Hello</p><p>World</p>', 'Hello<br>World'],
		['<p style="text-align:left">A</p><p>B</p>', 'A<br>B'],
		['<br />Hello<br />', 'Hello'],
		['<p>&nbsp;Hola</p>', 'Hola'],
	];

	test.each(cases)('cleans %p → %p', (input, expected) => {
		const out = run('parser_text::v5_html', [scalar(input, 'lg-spa')]);
		expect(strip(out)).toEqual([{ kind: 'scalar', value: expected, lang: 'lg-spa' }]);
	});

	test('empty paragraph → no data', () => {
		expect(run('parser_text::v5_html', [scalar('<p></p>')])).toEqual([]);
	});

	test('preserves each item lang (no cross-lang collapse)', () => {
		const out = run('parser_text::v5_html', [
			scalar('<p>Hola</p>', 'lg-spa'),
			scalar('<p>Hello</p>', 'lg-eng'),
		]);
		expect(strip(out)).toEqual([
			{ kind: 'scalar', value: 'Hola', lang: 'lg-spa' },
			{ kind: 'scalar', value: 'Hello', lang: 'lg-eng' },
		]);
	});
});

// ---------------------------------------------------------------------------
// parser_date
// ---------------------------------------------------------------------------

describe('parser_date', () => {
	test('string_date formats a simple date (oracle case)', () => {
		const out = run(
			'parser_date::string_date',
			[ddate([{ start: { year: 2024, month: 3, day: 15 } }])],
			{ pattern: 'Y-m-d' },
		);
		expect(strip(out)).toEqual([{ kind: 'scalar', value: '2024-03-15', lang: null }]);
	});

	test('string_date defaults to keys:[0] — only the first date survives (oracle case)', () => {
		const multi = [
			ddate([
				{ start: { year: 2020, month: 1, day: 1 } },
				{ start: { year: 2021, month: 6, day: 15 } },
			]),
		];
		expect(strip(run('parser_date::string_date', multi, { pattern: 'Y-m-d' }))).toEqual([
			{ kind: 'scalar', value: '2020-01-01', lang: null },
		]);
		// explicit keys keep both, joined by fields_separator
		expect(
			strip(run('parser_date::string_date', multi, { pattern: 'Y-m-d', keys: [0, 1] })),
		).toEqual([{ kind: 'scalar', value: '2020-01-01, 2021-06-15', lang: null }]);
	});

	test('select_properties extracts requested parts in order', () => {
		const start = { year: 2020, month: 1, day: 1 };
		const end = { year: 2024, month: 12, day: 31 };
		const out = run('parser_date::select_properties', [ddate([{ start, end }])], {
			select: ['start', 'end'],
		});
		expect(strip(out)).toEqual([{ kind: 'json', value: [start, end], lang: null }]);
	});

	test('select_keys pads missing month/day with 0 — without mutating input', () => {
		const part = { year: 2024 };
		const out = run('parser_date::select_keys', [json([part])], { keys: [0] });
		expect(strip(out)).toEqual([
			{ kind: 'json', value: [{ year: 2024, month: 0, day: 0 }], lang: null },
		]);
		expect(part).toEqual({ year: 2024 }); // input IR untouched
	});

	test('format_string_date pads negative years for Y, raw for y', () => {
		const items = [json([{ year: -94, month: 5, day: 2 }])];
		expect(strip(run('parser_date::format_string_date', items, { pattern: 'Y-m-d' }))).toEqual([
			{ kind: 'scalar', value: '-094-05-02', lang: null },
		]);
		expect(strip(run('parser_date::format_string_date', items, { pattern: 'y' }))).toEqual([
			{ kind: 'scalar', value: '-94', lang: null },
		]);
	});

	test('format_string_date collapses multiple items with records_separator', () => {
		const out = run(
			'parser_date::format_string_date',
			[json([{ year: 2020, month: 1, day: 1 }]), json([{ year: 2021, month: 6, day: 15 }])],
			{ pattern: 'Y-m-d', records_separator: ' ; ' },
		);
		expect(strip(out)).toEqual([{ kind: 'scalar', value: '2020-01-01 ; 2021-06-15', lang: null }]);
	});

	test('unix_timestamp converts the start part to epoch seconds', () => {
		const out = run('parser_date::unix_timestamp', [
			ddate([{ start: { year: 2024, month: 3, day: 15 } }]),
		]);
		const expected = Math.floor(Date.UTC(2024, 2, 15, 0, 0, 0) / 1000);
		expect(strip(out)).toEqual([{ kind: 'scalar', value: expected, lang: null }]);
	});

	test("default 'range' emits start,end with bare-comma join (v6)", () => {
		const out = run(
			'parser_date::default',
			[
				ddate([
					{
						start: { year: 2020, month: 1, day: 1 },
						end: { year: 2024, month: 12, day: 31 },
					},
				]),
			],
			{ date_mode: 'range' },
		);
		expect(strip(out)).toEqual([
			{ kind: 'json', value: ['2020-01-01 00:00:00,2024-12-31 00:00:00'], lang: null },
		]);
	});

	test("default 'date' emits the start timestamp string", () => {
		const out = run('parser_date::default', [
			ddate([{ start: { year: 2024, month: 3, day: 15 } }]),
		]);
		expect(strip(out)).toEqual([{ kind: 'json', value: ['2024-03-15 00:00:00'], lang: null }]);
	});

	test("default 'period' emits one localized item per ctx lang", () => {
		const ctx: ParserContext = { langs: ['lg-eng', 'lg-spa'], mainLang: 'lg-eng' };
		const out = run(
			'parser_date::default',
			[ddate([{ period: { year: 5, month: 3, day: 10 } }])],
			{ date_mode: 'period' },
			ctx,
		);
		expect(strip(out)).toEqual([
			{ kind: 'json', value: ['5 years 3 months 10 days'], lang: 'lg-eng' },
			{ kind: 'json', value: ['5 años 3 meses 10 días'], lang: 'lg-spa' },
		]);
	});

	test('empty input → empty output', () => {
		expect(run('parser_date::string_date', [])).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// parser_helper
// ---------------------------------------------------------------------------

describe('parser_helper::get_first', () => {
	test('keeps the first item PER language', () => {
		const out = run('parser_helper::get_first', [
			scalar('A', 'lg-spa'),
			scalar('B', 'lg-spa'),
			scalar('X', 'lg-eng'),
		]);
		expect(strip(out)).toEqual([
			{ kind: 'scalar', value: 'A', lang: 'lg-spa' },
			{ kind: 'scalar', value: 'X', lang: 'lg-eng' },
		]);
	});

	test('array values collapse to their first element', () => {
		const out = run('parser_helper::get_first', [json(['A', 'B'])]);
		expect(strip(out)).toEqual([{ kind: 'scalar', value: 'A', lang: null }]);
	});

	test('unwraps a diffusion_data_object wrapper to its scalar value', () => {
		const out = run('parser_helper::get_first', [
			json({ errors: [], tipo: 'test6123', value: 7, id: 'norder' }),
		]);
		expect(strip(out)).toEqual([{ kind: 'scalar', value: 7, lang: null }]);
	});
});

describe('parser_helper::get_tail', () => {
	test('drops the first item PER language', () => {
		const out = run('parser_helper::get_tail', [
			scalar('A', 'lg-spa'),
			scalar('B', 'lg-spa'),
			scalar('X', 'lg-eng'),
		]);
		expect(strip(out)).toEqual([{ kind: 'scalar', value: 'B', lang: 'lg-spa' }]);
	});

	test('single item per lang → empty output', () => {
		expect(run('parser_helper::get_tail', [scalar('A', 'lg-spa')])).toEqual([]);
	});
});

describe('parser_helper::count', () => {
	test('counts array lengths, non-empty scalars and chain links', () => {
		const out = run('parser_helper::count', [
			json(['a', 'b']), // 2
			scalar('x'), // 1
			scalar(''), // 0
			chain([link('testgeoa1', 5), link('testgeoa1', 6)]), // 2 (one per resolved link)
		]);
		expect(strip(out)).toEqual([{ kind: 'scalar', value: 5, lang: null }]);
	});

	test('a bare locator item (null value, section provenance) counts 1', () => {
		const out = run('parser_helper::count', [
			scalar(null, null, { sectionId: '9', sectionTipo: 'test6097' }),
		]);
		expect(strip(out)).toEqual([{ kind: 'scalar', value: 1, lang: null }]);
	});
});

describe('parser_helper::merge (column-aware)', () => {
	const columns = [
		{ tipo: 'city', model: 'component_input_text' },
		{ tipo: 'country', model: 'component_input_text' },
	];
	const cityCountry = [
		scalar('Madrid', null, { tipo: 'city', sectionId: '1' }),
		scalar('Spain', null, { tipo: 'country', sectionId: '1' }),
		scalar('Paris', null, { tipo: 'city', sectionId: '2' }),
		scalar('France', null, { tipo: 'country', sectionId: '2' }),
	];

	// [merge style, expected value] — oracle parser_helper.ts:120-134 doc table
	const styleCases: Array<[string | undefined, unknown, 'scalar' | 'json']> = [
		[undefined, ['Madrid', 'Spain', 'Paris', 'France'], 'json'],
		['string', 'Madrid, Spain | Paris, France', 'scalar'],
		[
			'nested',
			[
				['Madrid', 'Spain'],
				['Paris', 'France'],
			],
			'json',
		],
		['flat', ['Madrid, Spain', 'Paris, France'], 'json'],
		['pipe', '["Madrid","Spain"] | ["Paris","France"]', 'scalar'],
	];

	test.each(styleCases)('merge style %p', (mergeStyle, expected, kind) => {
		const options: Record<string, unknown> = { columns };
		if (mergeStyle !== undefined) options.merge = mergeStyle;
		const out = run('parser_helper::merge', cityCountry, options);
		expect(strip(out)).toEqual([{ kind, value: expected, lang: null }]);
	});

	test("'unique' deduplicates across sections", () => {
		const out = run(
			'parser_helper::merge',
			[
				...cityCountry,
				scalar('Madrid', null, { tipo: 'city', sectionId: '3' }),
				scalar('Spain', null, { tipo: 'country', sectionId: '3' }),
			],
			{ columns, merge: 'unique' },
		);
		expect(strip(out)).toEqual([
			{ kind: 'json', value: ['Madrid', 'Spain', 'Paris', 'France'], lang: null },
		]);
	});

	test("'pipe' coerces pure-integer strings to JSON numbers (v6)", () => {
		const out = run(
			'parser_helper::merge',
			[
				scalar('1', null, { tipo: 'city', sectionId: '1' }),
				scalar('007', null, { tipo: 'country', sectionId: '1' }),
			],
			{ columns, merge: 'pipe' },
		);
		expect(strip(out)).toEqual([{ kind: 'scalar', value: '[1,"007"]', lang: null }]);
	});

	test('per-slot lang fallback: exact → nolan → main_lang → any', () => {
		const ctx: ParserContext = { langs: ['lg-spa', 'lg-eng'], mainLang: 'lg-eng' };
		const out = run(
			'parser_helper::merge',
			[
				scalar('Hola', 'lg-spa', { tipo: 'city', sectionId: '1' }),
				scalar('World', 'lg-eng', { tipo: 'country', sectionId: '1' }),
			],
			{ columns, merge: 'string' },
			ctx,
		);
		// spa row: country falls back to main_lang; eng row: city falls back to any
		expect(strip(out)).toEqual([
			{ kind: 'scalar', value: 'Hola, World', lang: 'lg-spa' },
			{ kind: 'scalar', value: 'Hola, World', lang: 'lg-eng' },
		]);
	});
});

describe('parser_helper::merge (standalone, no columns)', () => {
	test("merge:'unique' dedupes values (v6 merged_unique)", () => {
		const out = run(
			'parser_helper::merge',
			[scalar('14809', null, { sectionId: '1' }), scalar('14809', null, { sectionId: '2' })],
			{ merge: 'unique' },
		);
		expect(strip(out)).toEqual([{ kind: 'json', value: ['14809'], lang: null }]);
	});

	test('implode:true joins into one string (v6 merged_unique_implode)', () => {
		const out = run(
			'parser_helper::merge',
			[scalar('Murtili'), scalar('Mirtilis'), scalar('Myrtilis')],
			{ merge: 'unique', implode: true },
		);
		expect(strip(out)).toEqual([
			{ kind: 'scalar', value: 'Murtili | Mirtilis | Myrtilis', lang: null },
		]);
	});
});

// ---------------------------------------------------------------------------
// parser_locator survivors — operate on resolved chains
// ---------------------------------------------------------------------------

describe('parser_locator::get_section_id', () => {
	test('projects each chain to its section_id list', () => {
		const out = run('parser_locator::get_section_id', [
			chain([link('test6103', '2062')]),
			chain([link('test6103', '2063')]),
		]);
		expect(strip(out)).toEqual([
			{ kind: 'json', value: ['2062'], lang: null },
			{ kind: 'json', value: ['2063'], lang: null },
		]);
	});

	test('split:true emits one atom per id with synthetic section provenance', () => {
		const out = run(
			'parser_locator::get_section_id',
			[chain([link('testgeoa1', '5'), link('testgeoa1', '7')])],
			{ split: true },
		) as MetaValueIR[];
		expect(strip(out)).toEqual([
			{ kind: 'scalar', value: '5', lang: null },
			{ kind: 'scalar', value: '7', lang: null },
		]);
		expect(out.map((v) => v.meta?.sectionId)).toEqual(['__split__0', '__split__1']);
	});
});

describe('parser_locator::get_section_tipo', () => {
	test('projects each chain to its section_tipo list', () => {
		const out = run('parser_locator::get_section_tipo', [
			chain([link('test1026', '42'), link('ts1', '7')]),
		]);
		expect(strip(out)).toEqual([{ kind: 'json', value: ['test1026', 'ts1'], lang: null }]);
	});
});

describe('parser_locator::get_term_id', () => {
	test('builds "{section_tipo}_{section_id}" per link', () => {
		const out = run('parser_locator::get_term_id', [chain([link('test6813', '25')])]);
		expect(strip(out)).toEqual([{ kind: 'json', value: ['test6813_25'], lang: null }]);
	});

	test('coerce_non_locator maps non-locator values to the "_" marker (v6)', () => {
		const out = run('parser_locator::get_term_id', [scalar('#f78a1c')], {
			coerce_non_locator: true,
		});
		expect(strip(out)).toEqual([{ kind: 'json', value: ['_'], lang: null }]);
	});

	test('coerce_non_locator with empty value → no data (v6 None, not "[]")', () => {
		expect(run('parser_locator::get_term_id', [scalar('')], { coerce_non_locator: true })).toEqual(
			[],
		);
		expect(
			run('parser_locator::get_term_id', [scalar(null)], { coerce_non_locator: true }),
		).toEqual([]);
	});
});

describe('parser_locator::get_section_id_grouped', () => {
	test('groups by dataframe-id resets and emits JSON arrays joined by separator', () => {
		const out = run('parser_locator::get_section_id_grouped', [
			chain([link('test6100', '99927')], { sourceId: 1 }),
			chain([link('test6100', '128187')], { sourceId: 1 }), // id reset → new group
			chain([link('test6100', '133934')], { sourceId: 2 }),
		]);
		expect(strip(out)).toEqual([
			{ kind: 'scalar', value: '["99927"] | ["128187","133934"]', lang: null },
		]);
	});
});

// ---------------------------------------------------------------------------
// parser_iri / parser_geo / parser_info / parser_map
// ---------------------------------------------------------------------------

describe('parser_iri::flat', () => {
	test('formats title, iri pairs joined by records_separator (oracle example)', () => {
		const out = run('parser_iri::flat', [
			json([
				{ iri: 'https://dedalo.dev', title: 'Official Dédalo web' },
				{ iri: 'https://other.es', title: 'other' },
			]),
		]);
		expect(strip(out)).toEqual([
			{
				kind: 'scalar',
				value: 'Official Dédalo web, https://dedalo.dev | other, https://other.es',
				lang: null,
			},
		]);
	});

	test('title-less entries emit the bare iri; empty entries stay as slots (v6)', () => {
		const out = run('parser_iri::flat', [
			json([{ iri: 'https://dedalo.dev' }, { iri: '', title: '' }]),
		]);
		expect(strip(out)).toEqual([{ kind: 'scalar', value: 'https://dedalo.dev | ', lang: null }]);
	});
});

describe('parser_geo::geojson', () => {
	test('builds a Point FeatureCollection from lat/lon (comma decimals normalized)', () => {
		const out = run('parser_geo::geojson', [json([{ lat: '41.5', lon: '2,1' }])]);
		expect(strip(out)).toEqual([
			{
				kind: 'json',
				value: [
					{
						layer_id: 1,
						text: '',
						layer_data: {
							type: 'FeatureCollection',
							features: [
								{
									type: 'Feature',
									properties: {},
									geometry: { type: 'Point', coordinates: [2.1, 41.5] },
								},
							],
						},
					},
				],
				lang: null,
			},
		]);
	});

	test('the STUDIO DEFAULT never publishes — it is fabricated, not a position', () => {
		// 39.462571/-0.376295 is the Dédalo facilities' own coordinates, shipped as
		// the client's factory map position and written on save by the v6 client
		// whether or not anyone touched the map. Refused here and in the other two
		// publication paths; an ordinary coordinate everywhere else.
		expect(run('parser_geo::geojson', [json([{ lat: '39.462571', lon: '-0.376295' }])])).toEqual(
			[],
		);
		expect(run('parser_geo::geojson', [json([{ lat: 39.462571, lon: -0.376295 }])])).toEqual([]);
		// one axis off is a real coordinate and publishes
		const real = run('parser_geo::geojson', [json([{ lat: '39.462571', lon: '2.173403' }])]);
		expect(JSON.stringify(strip(real))).toContain('"coordinates":[2.173403,39.462571]');
	});

	test('0 is a legal coordinate: [0,0], the equator and the prime meridian publish', () => {
		const nullIsland = run('parser_geo::geojson', [json([{ lat: 0, lon: 0 }])]);
		expect(JSON.stringify(strip(nullIsland))).toContain('"coordinates":[0,0]');

		const equator = run('parser_geo::geojson', [json([{ lat: 0, lon: 37.9 }])]);
		expect(JSON.stringify(strip(equator))).toContain('"coordinates":[37.9,0]');

		const greenwich = run('parser_geo::geojson', [json([{ lat: 5.6, lon: 0 }])]);
		expect(JSON.stringify(strip(greenwich))).toContain('"coordinates":[0,5.6]');

		// …and as the strings the matrix actually stores ('0' is not absence).
		const asStrings = run('parser_geo::geojson', [json([{ lat: '0', lon: '0' }])]);
		expect(JSON.stringify(strip(asStrings))).toContain('"coordinates":[0,0]');
	});

	test('string and number coordinates behave IDENTICALLY (mixed storage: 607/1803 strings)', () => {
		const asString = run('parser_geo::geojson', [json([{ lat: '39.5', lon: '2.1' }])]);
		const asNumber = run('parser_geo::geojson', [json([{ lat: 39.5, lon: 2.1 }])]);
		expect(strip(asString)).toEqual(strip(asNumber));
		expect(JSON.stringify(strip(asString))).toContain('"coordinates":[2.1,39.5]');
	});

	test('comma-decimal locales still normalize on both axes', () => {
		const out = run('parser_geo::geojson', [json([{ lat: '39,5', lon: '-0,376295' }])]);
		expect(JSON.stringify(strip(out))).toContain('"coordinates":[-0.376295,39.5]');
	});

	test('absence is structural: null/undefined/"" coordinates publish NOTHING', () => {
		expect(run('parser_geo::geojson', [json([{ lat: '', lon: '' }])])).toEqual([]);
		expect(run('parser_geo::geojson', [json([{ lat: null, lon: null }])])).toEqual([]);
		expect(run('parser_geo::geojson', [json([{ lat: '41.5', lon: '' }])])).toEqual([]);
		expect(run('parser_geo::geojson', [json([{ lat: null, lon: 2.1 }])])).toEqual([]);
		expect(run('parser_geo::geojson', [json([{ zoom: 12, alt: 16 }])])).toEqual([]);
	});

	test('lib_data with real features passes through as-is', () => {
		const libData = [{ layer_id: 3, text: 't', layer_data: { features: [{ id: 1 }] } }];
		const out = run('parser_geo::geojson', [json([{ lat: '1', lon: '2', lib_data: libData }])]);
		expect(strip(out)).toEqual([{ kind: 'json', value: libData, lang: null }]);
	});
});

describe('parser_info::widget', () => {
	const dato = [
		{ widget: 'get_archive_weights', widget_id: 'media_diameter', value: 12 },
		{ widget: 'get_archive_weights', widget_id: 'media_weight', value: 3.4 },
		{ widget: 'other_widget', widget_id: 'media_diameter', value: 99 },
	];

	test('collects values matching widget_name/select pairs', () => {
		const out = run('parser_info::widget', [json(dato)], {
			widget_name: ['get_archive_weights'],
			select: ['media_diameter'],
		});
		expect(strip(out)).toEqual([{ kind: 'scalar', value: 12, lang: null }]);
	});

	test('keys picks positional entries from the collected list', () => {
		const out = run('parser_info::widget', [json(dato)], {
			widget_name: ['get_archive_weights', 'get_archive_weights'],
			select: ['media_diameter', 'media_weight'],
			keys: [1],
		});
		expect(strip(out)).toEqual([{ kind: 'scalar', value: 3.4, lang: null }]);
	});

	test('no match → no data', () => {
		expect(
			run('parser_info::widget', [json(dato)], { widget_name: ['missing'], select: ['x'] }),
		).toEqual([]);
	});
});

describe('parser_info::default', () => {
	test('strips <mark> tags and applies keys slicing', () => {
		const out = run('parser_info::default', [scalar('<mark>one</mark>, two, three')], {
			keys: [0, 2],
		});
		expect(strip(out)).toEqual([{ kind: 'scalar', value: 'one, three', lang: null }]);
	});

	test('empty values drop out', () => {
		expect(run('parser_info::default', [scalar(''), scalar('<mark></mark>')])).toEqual([]);
	});
});

describe('parser_map::custom', () => {
	const template = [
		{
			table: 'publications',
			title: '${a}',
			author: '${b}, ${c}',
			section_tipo: '${section_tipo}',
		},
	];

	test('resolves grouped items against the map template (oracle example)', () => {
		const out = run(
			'parser_map::custom',
			[
				scalar('bbb', null, {
					sourceId: 'a',
					sectionId: '1',
					sectionTipo: 'test6099',
					tipo: 'test6140',
				}),
				scalar('jo jo', null, {
					sourceId: 'b',
					sectionId: '1',
					sectionTipo: 'test6099',
					tipo: 'test6086',
				}),
				scalar('la 11', null, {
					sourceId: 'c',
					sectionId: '1',
					sectionTipo: 'test6099',
					tipo: 'test6085',
				}),
			],
			{ map: template },
		);
		expect(strip(out)).toEqual([
			{
				kind: 'json',
				value: [
					{
						section_tipo: 'test6099',
						section_id: '1',
						table: 'publications',
						title: 'bbb',
						author: 'jo jo, la 11',
					},
				],
				lang: null,
			},
		]);
	});

	test('repeated ids interpolate per index (v6 multi-author pairing)', () => {
		const out = run(
			'parser_map::custom',
			[
				scalar('T', null, { sourceId: 'a', sectionId: '1', sectionTipo: 'test6099' }),
				scalar('Gomez', null, { sourceId: 'b', sectionId: '1', sectionTipo: 'test6099' }),
				scalar('Ugolini', null, { sourceId: 'b', sectionId: '1', sectionTipo: 'test6099' }),
				scalar('Élian', null, { sourceId: 'c', sectionId: '1', sectionTipo: 'test6099' }),
				scalar('Daniela', null, { sourceId: 'c', sectionId: '1', sectionTipo: 'test6099' }),
			],
			{ map: template },
		);
		expect(firstRow(out).author).toBe('Gomez, Élian, Ugolini, Daniela');
	});

	test('a field whose placeholders all resolve empty emits null (v6)', () => {
		const out = run(
			'parser_map::custom',
			[scalar('T', null, { sourceId: 'a', sectionId: '1', sectionTipo: 'test6099' })],
			{ map: template },
		);
		const row = firstRow(out);
		expect(row.title).toBe('T');
		expect(row.author).toBeNull();
	});

	test('values are strip_tags(trim())-normalized like v6 get_locator_value', () => {
		const out = run(
			'parser_map::custom',
			[
				scalar(' <em>Las guerras</em> ', null, {
					sourceId: 'a',
					sectionId: '1',
					sectionTipo: 'test6099',
				}),
			],
			{ map: template },
		);
		expect(firstRow(out).title).toBe('Las guerras');
	});
});
