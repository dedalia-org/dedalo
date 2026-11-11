/**
 * SHALLOW BYTE-IDENTITY + CLASSIFIER TOTALITY — the deep-search rebuild's
 * builder gate (WC-2026-09-29-search-deep-leaf-mixed-rule).
 *
 * 1. Every shallow builder case (test/helpers/builder_shallow_cases.ts) renders
 *    EXACTLY what the builders rendered before the classifiers landed
 *    (test/fixtures/builder_shallow_snapshot.json, captured from the
 *    unmodified builders 2026-09-24) — sentence bytes, token values, compound
 *    structure, and thrown errors alike. The ONE exemption is number '!='
 *    (WC-2026-09-29-number-not-equal), asserted by its own leg below. The
 *    string '=' / '!=' plain comparison became case-insensitive (WC-014
 *    amendment 2026-11-11): those cases must equal the snapshot with exactly
 *    that one expression rewritten — nothing else may drift.
 * 2. Every classifier's twin/has is POSITIVE (classifies 'pos'), renders a
 *    real clause, and every internal mode is reachable only through the
 *    structured opts argument — no q string classifies into one.
 *
 * Rendered on the suite database (the relation_children/index builders read
 * the ontology + index coverage); nothing is written.
 */

import { describe, expect, test } from 'bun:test';
import { sql } from '../../src/core/db/postgres.ts';
import { classifyDate } from '../../src/core/search/builders/builder_date.ts';
import { buildIriFragment, classifyIri } from '../../src/core/search/builders/builder_iri.ts';
import { buildJsonFragment, classifyJson } from '../../src/core/search/builders/builder_json.ts';
import {
	buildNumberFragment,
	classifyNumber,
} from '../../src/core/search/builders/builder_number.ts';
import { classifyRelation } from '../../src/core/search/builders/builder_relation.ts';
import { classifyRelationChildren } from '../../src/core/search/builders/builder_relation_children.ts';
import { classifyRelationIndex } from '../../src/core/search/builders/builder_relation_index.ts';
import { classifySectionId } from '../../src/core/search/builders/builder_section_id.ts';
import {
	buildStringFragment,
	classifyString,
} from '../../src/core/search/builders/builder_string.ts';
import type {
	BuilderContext,
	BuilderTwin,
	LeafPolarity,
} from '../../src/core/search/builders/types.ts';
import { asSqlTipo } from '../../src/core/search/identifier_gate.ts';
import { ParamsCollector } from '../../src/core/search/params.ts';
import {
	isNumberNotEqualCase,
	renderShallowBuilderCases,
} from '../helpers/builder_shallow_cases.ts';

const SNAPSHOT_PATH = new URL('../fixtures/builder_shallow_snapshot.json', import.meta.url);

// WC-014 amendment 2026-11-11: '=' and '!=' compare lower(f_unaccent(..)) on both sides.
const CASE_SENSITIVE_EQ = "f_unaccent(elem->>'value') = f_unaccent(_Q1_)";
const CASE_FOLDED_EQ = "lower(f_unaccent(elem->>'value')) = lower(f_unaccent(_Q1_))";

/** A string case whose effective q is the single '=' or '!=' (key: string|lang|op|q|flag). */
function isStringCaseFoldCase(key: string): boolean {
	if (!key.startsWith('string|')) return false;
	const [, , op, q] = key.split('|');
	try {
		const kind = classifyString(q ?? '', op === 'null' ? null : (op ?? null)).op;
		return kind === 'equal' || kind === 'different';
	} catch {
		return false;
	}
}

describe('shallow builder SQL is byte-identical across the classifier refactor', () => {
	test('every case except number != matches the pre-change snapshot', async () => {
		const before = (await Bun.file(SNAPSHOT_PATH).json()) as Record<string, unknown>;
		const after = await renderShallowBuilderCases();
		expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
		const drift: string[] = [];
		let exempt = 0;
		let caseFolded = 0;
		for (const [key, value] of Object.entries(after)) {
			if (isNumberNotEqualCase(key)) {
				exempt++;
				continue;
			}
			let expected = JSON.stringify(before[key]);
			if (isStringCaseFoldCase(key)) {
				const rewritten = expected.replaceAll(CASE_SENSITIVE_EQ, CASE_FOLDED_EQ);
				if (rewritten !== expected) caseFolded++;
				expected = rewritten;
			}
			if (JSON.stringify(value) !== expected) drift.push(key);
		}
		expect(drift).toEqual([]);
		// the case-fold rewrite really happened (not a vacuous pass)
		expect(caseFolded).toBeGreaterThan(0);
		// The exemption is a named, bounded set — not a hole.
		expect(exempt).toBeGreaterThan(0);
		expect(exempt).toBeLessThan(20);
	}, 120000);
});

const numberCtx: BuilderContext = {
	alias: 'te3',
	column: 'number',
	tipo: asSqlTipo('test211', 'test context'),
	sectionTipo: 'test3',
	table: 'matrix_test',
	lang: 'lg-nolan',
	translatable: false,
	model: 'component_number',
};

describe("number '!=' is inequality (WC-2026-09-29-number-not-equal)", () => {
	test("'!=5' is has-value AND NOT (= 5), never '= 0'", () => {
		for (const [q, op] of [
			['!=5', null],
			['5', '!='],
		] as const) {
			const result = buildNumberFragment(q, op, numberCtx);
			if (result === false || result.kind !== 'fragment') throw new Error('expected a fragment');
			expect(result.sentence).toStartWith(
				`(te3.number @? '$.test211[*].value ? (@ != null)') AND NOT (`,
			);
			expect(result.sentence).toContain(`(elem->>'value')::numeric = (_Q1_)::numeric`);
			expect(result.tokenValues).toEqual({ _Q1_: '5' });
		}
	});
	test("'!=5' on real rows: 0 and 7 match; 5, no value, NULL do not (was: only 0)", async () => {
		const result = buildNumberFragment('!=5', null, numberCtx);
		if (result === false || result.kind !== 'fragment') throw new Error('expected a fragment');
		const collector = new ParamsCollector();
		const where = collector.substitute(result.sentence, result.tokenValues);
		const rows = (await sql.unsafe(
			`SELECT k FROM (VALUES (1, '{"test211":[{"value":5}]}'::jsonb), (2, '{"test211":[{"value":0}]}'::jsonb), ` +
				`(3, '{"test211":[{"value":7}]}'::jsonb), (4, '{"test211":[{"value":7},{"value":5}]}'::jsonb), ` +
				`(5, '{}'::jsonb), (6, NULL::jsonb)) AS te3(k, number) WHERE ${where} ORDER BY k`,
			collector.toArray(),
		)) as { k: number }[];
		expect(rows.map((row) => row.k)).toEqual([2, 3]);
	});
	test("'!=' with no value drops the clause", () => {
		expect(buildNumberFragment('', '!=', numberCtx)).toBe(false);
	});
});

/** A classifier's positive-ness, asked through the same family's classifier. */
type Family = {
	name: string;
	classify: (
		q: unknown,
		op: string | null,
		opts?: BuilderTwin['opts'],
	) => LeafPolarity & { op: string };
	cases: [unknown, string | null, LeafPolarity['kind']][];
};

const LOC = { section_tipo: 'test3', section_id: '5' };

const FAMILIES: Family[] = [
	{
		name: 'string',
		classify: classifyString,
		cases: [
			['', null, 'pos'],
			['!*', null, 'neg'],
			['*', null, 'pos'],
			['!!', null, 'pos'],
			['!=x', null, 'neq'],
			['x', '!=', 'neq'],
			['==x', null, 'pos'],
			['=x', null, 'pos'],
			['-x', null, 'neg'],
			["'x'", null, 'pos'],
			['x*', null, 'pos'],
			['x', null, 'pos'],
		],
	},
	{
		name: 'iri',
		classify: classifyIri,
		cases: [
			['!*', null, 'neg'],
			['*', null, 'pos'],
			['!=x', null, 'neq'],
			['-x', null, 'neg'],
			['==x', null, 'pos'],
			['x', null, 'pos'],
			['!!', null, 'pos'],
		],
	},
	{
		name: 'json',
		classify: classifyJson,
		cases: [
			['!*', null, 'neg'],
			['*', null, 'pos'],
			['!=x', null, 'neq'],
			['-x', null, 'neg'],
			['==x', null, 'pos'],
			['x', null, 'pos'],
			['!!', null, 'pos'],
		],
	},
	{
		name: 'number',
		classify: (q, op) => classifyNumber(q, op),
		cases: [
			['!*', null, 'neg'],
			['*', null, 'pos'],
			['!=5', null, 'neq'],
			['!=', null, 'pos'],
			['1...5', null, 'pos'],
			['>5', null, 'pos'],
			['5', null, 'pos'],
		],
	},
	{
		name: 'date',
		classify: (q, op) => classifyDate(q, op),
		cases: [
			[null, '!*', 'neg'],
			[null, '*', 'pos'],
			['2020', null, 'pos'],
			['2020', '>', 'pos'],
		],
	},
	{
		name: 'section_id',
		classify: (q, op) => classifySectionId(q, op),
		cases: [
			['!=5', null, 'neg'],
			['5', '!=', 'neg'],
			['!=', null, 'pos'],
			['!=1,2', null, 'pos'],
			['1...5', null, 'pos'],
			['>5', null, 'pos'],
			['5', null, 'pos'],
		],
	},
	{
		name: 'relation',
		classify: (q, op) => classifyRelation(q, op),
		cases: [
			[null, '!*', 'neg'],
			[null, '*', 'pos'],
			[LOC, '!=', 'neq'],
			[LOC, '!==', 'neg'],
			[null, '!=', 'pos'],
			[LOC, null, 'pos'],
			[LOC, '==', 'pos'],
		],
	},
	{
		name: 'relation_children',
		classify: (q, op) => classifyRelationChildren(q, op),
		cases: [
			[null, '!*', 'neg'],
			[null, '*', 'pos'],
			[LOC, '!=', 'neq'],
			[LOC, '!==', 'neg'],
			[LOC, null, 'pos'],
		],
	},
	{
		name: 'relation_index',
		classify: (q, op) => classifyRelationIndex(q, op),
		cases: [
			[null, '!*', 'neg'],
			[null, '*', 'pos'],
			[null, '!=', 'pos'],
		],
	},
];

describe('classifiers: polarity table + every twin is positive', () => {
	for (const family of FAMILIES) {
		test(`${family.name}: polarity and positive twins`, () => {
			for (const [q, op, kind] of family.cases) {
				const classified = family.classify(q, op);
				expect(`${JSON.stringify(q)}|${op}:${classified.kind}`).toBe(
					`${JSON.stringify(q)}|${op}:${kind}`,
				);
				const twins: BuilderTwin[] =
					classified.kind === 'neg'
						? [classified.twin]
						: classified.kind === 'neq'
							? [classified.has, classified.twin]
							: [];
				for (const twin of twins) {
					expect(family.classify(twin.q, twin.qOperator, twin.opts).kind).toBe('pos');
				}
			}
		});
	}

	test('D2: section_id != n twins = n', () => {
		const classified = classifySectionId('!=7', null);
		expect(classified).toMatchObject({ kind: 'neg', twin: { q: '7', qOperator: null } });
	});

	test('internal modes are unreachable from q: no q string classifies into one', () => {
		const internal = new Set(['nonEmpty', 'containsRaw', 'hasEntries', 'differentTwin']);
		const probes = [
			'nonEmpty',
			'containsRaw',
			'hasEntries',
			'differentTwin',
			'*+',
			'+*',
			'!*+',
			'_deep_form',
			'-',
			'!=',
		];
		for (const q of probes) {
			for (const op of [null, '', '*', '!*', '-', '!=']) {
				expect(internal.has(classifyString(q, op).op)).toBe(false);
				expect(internal.has(classifyIri(q, op).op)).toBe(false);
				expect(internal.has(classifyJson(q, op).op)).toBe(false);
			}
		}
	});
});

const textCtx = (column: string, lang = 'lg-spa'): BuilderContext => ({
	alias: 'e1_1',
	column,
	tipo: asSqlTipo('test52', 'test context'),
	sectionTipo: 'test3',
	table: 'matrix_test',
	lang,
	translatable: true,
	model: 'component_input_text',
});

describe('twins render the exact positive body of the shallow negation', () => {
	test("string '-x': NOT EXISTS(body) shallow, EXISTS(body) twin — same body, same tokens", () => {
		const neg = buildStringFragment('-a.b', null, false, textCtx('string'));
		const classified = classifyString('-a.b', null);
		if (classified.kind !== 'neg') throw new Error('expected neg');
		const twin = buildStringFragment(
			classified.twin.q,
			null,
			false,
			textCtx('string'),
			classified.twin.opts,
		);
		if (neg === false || neg.kind !== 'fragment' || twin === false || twin.kind !== 'fragment') {
			throw new Error('expected fragments');
		}
		expect(neg.sentence).toBe(`NOT ${twin.sentence}`);
		expect(neg.tokenValues).toEqual(twin.tokenValues);
	});

	test("string '!=x*': has AND NOT twin reproduces the shallow sentence", () => {
		for (const q of ['!=Ana', '!=Ana*', '!=*Ana', '!=*Ana*']) {
			const shallow = buildStringFragment(q, null, false, textCtx('string'));
			const classified = classifyString(q, null);
			if (classified.kind !== 'neq') throw new Error('expected neq');
			const has = buildStringFragment('', null, false, textCtx('string'), classified.has.opts);
			const twin = buildStringFragment(
				classified.twin.q,
				null,
				false,
				textCtx('string'),
				classified.twin.opts,
			);
			if ([shallow, has, twin].some((r) => r === false || r.kind !== 'fragment'))
				throw new Error('fragments');
			const s = shallow as { sentence: string; tokenValues: unknown };
			expect(s.sentence).toBe(
				`${(has as { sentence: string }).sentence} AND NOT ${(twin as { sentence: string }).sentence}`,
			);
			expect(s.tokenValues).toEqual((twin as { tokenValues: unknown }).tokenValues);
		}
	});

	test("iri '-x' and json '!*' twins are the positive bodies", () => {
		const iriNeg = buildIriFragment('-x', null, textCtx('iri'));
		const iriClass = classifyIri('-x', null);
		if (iriClass.kind !== 'neg') throw new Error('neg');
		const iriTwin = buildIriFragment(iriClass.twin.q, null, textCtx('iri'), iriClass.twin.opts);
		expect((iriNeg as { sentence: string }).sentence).toBe(
			`NOT ${(iriTwin as { sentence: string }).sentence}`,
		);

		const jsonCtx = textCtx('misc', 'lg-nolan');
		const empty = buildJsonFragment('!*', null, jsonCtx) as { sentence: string };
		const jsonClass = classifyJson('!*', null);
		if (jsonClass.kind !== 'neg') throw new Error('neg');
		const nonEmpty = buildJsonFragment(jsonClass.twin.q, null, jsonCtx, jsonClass.twin.opts) as {
			sentence: string;
		};
		expect(empty.sentence).toBe(`(e1_1.misc IS NULL OR NOT ${nonEmpty.sentence})`);
	});

	test("'!!' aggAcl restricts the aggregate to visible records; absent = shallow bytes", () => {
		const shallow = buildStringFragment('!!', null, false, textCtx('string')) as {
			sentence: string;
		};
		const deep = buildStringFragment('!!', null, false, textCtx('string'), {
			aggTable: 'matrix_test',
			aggAcl: (alias) => `${alias}.section_id > 0`,
		}) as { sentence: string };
		expect(shallow.sentence).not.toContain('m2.section_id > 0');
		expect(deep.sentence).toContain(
			`WHERE m2_elem->>'value' IS NOT NULL AND (m2.section_id > 0)) dv`,
		);
		const json = buildJsonFragment('!!', null, textCtx('misc'), { aggAcl: (a) => `${a}.x` }) as {
			sentence: string;
		};
		expect(json.sentence).toContain('AND (m2.x)) dv');
	});
});
