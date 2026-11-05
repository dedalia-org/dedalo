/**
 * CANONICAL JSON — the ONE structural-equality / digest form
 * (src/core/concepts/canonical_json.ts).
 *
 * Pins the output, not the spelling: three private copies (append_merge,
 * ai/agent/change_plan, archive/manifest) were consolidated into it on
 * 2026-09-27, and two of them feed PERSISTED digests (the archive
 * `ontology.digest`, the change-plan hash). A change to this text for any JSON
 * value breaks the verification of every artefact already written — so the
 * exact text of a representative value is pinned here, byte for byte.
 *
 * HERMETIC: pure functions, no DB.
 */

import { describe, expect, test } from 'bun:test';
import { type ChangePlan, hashChangePlan } from '../../src/ai/agent/change_plan.ts';
import { ontologyDigest, ontologyRowsEqual } from '../../src/core/archive/manifest.ts';
import { canonicalEquals, canonicalJson } from '../../src/core/concepts/canonical_json.ts';
import { sameItemValue } from '../../src/core/concepts/item_value.ts';
import type { DdOntologyRow } from '../../src/core/db/dd_ontology.ts';
import { literalDuplicateIds } from '../../src/core/section/record/append_merge.ts';

/**
 * The archive digest's ORIGINAL implementation (manifest.ts before the
 * consolidation), kept verbatim as the reference the shared one must equal on
 * every JSON-derived value — the only kind the archive ever digests.
 */
function legacyArchiveCanonical(value: unknown): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(legacyArchiveCanonical).join(',')}]`;
	const keys = Object.keys(value as Record<string, unknown>).sort();
	return `{${keys
		.map(
			(k) =>
				`${JSON.stringify(k)}:${legacyArchiveCanonical((value as Record<string, unknown>)[k])}`,
		)
		.join(',')}}`;
}

const SAMPLE = {
	zeta: [3, { b: 'x', a: null }, 'ñ'],
	alpha: { nested: { y: 1.5, x: true }, empty: {}, list: [] },
	é: 'accent key',
	B: 'upper sorts before lower',
};

describe('canonicalJson', () => {
	test('exact text: keys sorted at every depth, no whitespace', () => {
		expect(canonicalJson(SAMPLE)).toBe(
			'{"B":"upper sorts before lower","alpha":{"empty":{},"list":[],"nested":{"x":true,"y":1.5}},' +
				'"zeta":[3,{"a":null,"b":"x"},"ñ"],"é":"accent key"}',
		);
	});

	test('equals the archive digest’s original form on JSON values (a persisted format)', () => {
		const values: unknown[] = [
			SAMPLE,
			null,
			0,
			'text',
			[],
			{},
			[[{ c: [1, { e: 2, d: 1 }] }]],
			JSON.parse('{"__proto__": {"k": 1}, "a": 2}'),
			// Integer-like keys: a JS object enumerates them FIRST in numeric
			// order, so a re-materialized "sorted" object cannot hold this order.
			JSON.parse('{"10":1,"9":2,"$and":3,"a":4}'),
			JSON.parse('[{"b":{"2":"x","10":"y","-x":0}}]'),
		];
		for (const value of values) expect(canonicalJson(value)).toBe(legacyArchiveCanonical(value));
		const row: DdOntologyRow = {
			tipo: 'test3',
			parent: 'test1',
			term: { 'lg-spa': 'Prueba', 'lg-eng': 'Test' },
			model: 'section',
			order_number: 1,
			relations: [{ tipo: 'test24' }],
			tld: 'test',
			properties: { z: 1, a: { d: [2, 1], c: null }, map: JSON.parse('{"10":1,"9":2,"$and":3}') },
			model_tipo: 'dd6',
			is_model: false,
			is_translatable: false,
			is_main: false,
			propiedades: null,
			machine_name: null,
			use_machine_name: false,
		};
		const expected = new Bun.CryptoHasher('sha256')
			.update(legacyArchiveCanonical([row]))
			.digest('hex');
		expect(ontologyDigest([row])).toBe(expected);
	});

	test('integer-like keys emit in code-unit order, not JS enumeration order', () => {
		expect(canonicalJson(JSON.parse('{"10":1,"9":2,"$and":3,"a":4}'))).toBe(
			'{"$and":3,"10":1,"9":2,"a":4}',
		);
	});

	test('a key named __proto__ stays a KEY (never a prototype swap)', () => {
		expect(canonicalJson(JSON.parse('{"__proto__": {"k": 1}}'))).toBe('{"__proto__":{"k":1}}');
	});

	test('JSON.stringify semantics: toJSON honoured, undefined property omitted, undefined slot null', () => {
		expect(canonicalJson({ when: new Date('2026-09-27T10:00:00.000Z') })).toBe(
			'{"when":"2026-09-27T10:00:00.000Z"}',
		);
		expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
		expect(canonicalJson([undefined, 1])).toBe('[null,1]');
	});

	test('absence is distinct: top-level undefined is never null nor []', () => {
		expect(canonicalJson(undefined)).toBe('undefined');
		expect(canonicalEquals(undefined, null)).toBe(false);
		expect(canonicalEquals(undefined, [])).toBe(false);
		expect(canonicalEquals(null, [])).toBe(false);
	});

	test('key order never matters; array order always does', () => {
		expect(canonicalEquals({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBe(true);
		expect(canonicalEquals([1, 2], [2, 1])).toBe(false);
	});
});

/**
 * THE CONSUMERS, DRIVEN (F6, 2026-09-30): each consumer the module header names
 * is run in-process on a value whose keys are REORDERED and that holds an
 * `undefined` property and a `Date` — the three edges where a private
 * serializer diverges — and must answer what `canonicalJson` implies. A
 * consumer that inlined its own serializer (say one keeping `undefined` as
 * `null`, or ignoring `toJSON`) goes red here, whatever it is called.
 */
describe('canonicalJson consumers answer what the canonical form implies', () => {
	const WHEN = new Date('2026-09-30T08:00:00.000Z');
	/** A value, and its key-reordered twin that differs only by an extra `undefined` property. */
	const value = () => ({ b: [1, { y: 2, x: 1 }], when: WHEN, a: 'x' });
	const twin = () => ({ a: 'x', gone: undefined, when: new Date(WHEN), b: [1, { x: 1, y: 2 }] });
	const sha = (text: string) => new Bun.CryptoHasher('sha256').update(text).digest('hex');

	test('the twin IS the same canonical value (the premise of every case below)', () => {
		expect(canonicalJson(twin())).toBe(canonicalJson(value()));
		expect(canonicalJson(value())).toBe(
			'{"a":"x","b":[1,{"x":1,"y":2}],"when":"2026-09-30T08:00:00.000Z"}',
		);
	});

	const row = (properties: unknown): DdOntologyRow => ({
		tipo: 'test3',
		parent: 'test1',
		term: { 'lg-eng': 'Test' },
		model: 'section',
		order_number: 1,
		relations: null,
		tld: 'test',
		properties: properties as DdOntologyRow['properties'],
		model_tipo: 'dd6',
		is_model: false,
		is_translatable: false,
		is_main: false,
		propiedades: null,
		machine_name: null,
		use_machine_name: false,
	});

	test('archive/manifest.ts: ontologyDigest is sha256(canonicalJson(rows)); ontologyRowsEqual is canonical equality', () => {
		expect(ontologyDigest([row(value())])).toBe(sha(canonicalJson([row(value())])));
		expect(ontologyDigest([row(twin())])).toBe(ontologyDigest([row(value())]));
		expect(ontologyRowsEqual(row(value()), row(twin()))).toBe(true);
		expect(ontologyRowsEqual(row(value()), row({ ...value(), a: 'y' }))).toBe(false);
	});

	test('ai/agent/change_plan.ts: hashChangePlan is sha256(canonicalJson({plan_version, summary, ops}))', () => {
		const plan = (op: unknown): ChangePlan =>
			({ plan_version: 1, summary: 'probe', ops: [op] }) as unknown as ChangePlan;
		expect(hashChangePlan(plan(value()))).toBe(
			sha(canonicalJson({ plan_version: 1, summary: 'probe', ops: [value()] })),
		);
		expect(hashChangePlan(plan(twin()))).toBe(hashChangePlan(plan(value())));
	});

	test('concepts/item_value.ts: sameItemValue is canonical equality (id-blind when the candidate names none)', () => {
		expect(sameItemValue({ id: 7, value: value() }, { value: twin() })).toBe(true);
		expect(sameItemValue({ value: value() }, { value: twin() })).toBe(true);
		expect(sameItemValue({ value: value() }, { value: { ...value(), a: 'y' } })).toBe(false);
	});

	test('section/record/append_merge.ts: a string-family duplicate is canonical equality of `value`', () => {
		const stored = [{ id: 5, lang: 'lg-spa', value: value() }];
		expect(
			literalDuplicateIds(stored, { lang: 'lg-spa', value: twin() }, 'string', 'lg-spa'),
		).toEqual([5]);
		expect(
			literalDuplicateIds(
				stored,
				{ lang: 'lg-spa', value: { ...value(), a: 'y' } },
				'string',
				'lg-spa',
			),
		).toEqual([]);
	});
});
