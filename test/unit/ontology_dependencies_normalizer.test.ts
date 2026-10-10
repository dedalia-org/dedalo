/**
 * THE declared-dependency normalizer (src/core/ontology/ontology_dependencies.ts)
 * — the one function every reader and writer of `hierarchy60` shares
 * (WC-2026-10-10-ontology-dependencies-hierarchy60). Pure: no DB.
 *
 * Contract pinned here, one case per rule: not declared vs declared-empty, the
 * not-a-list warning, the per-item shape (tld / main / mandatory), the
 * `(tld, main)` dedupe (first wins — a TLD MAY appear once per main), the
 * self-reference rule (ontology35 dropped, hierarchy1 kept), and the stored
 * component_json round trip (`misc.hierarchy60[0].value`).
 */

import { describe, expect, test } from 'bun:test';
import {
	dependenciesMiscItems,
	HIERARCHY_DEPENDENCIES,
	normalizeOntologyDependencies,
	storedDependenciesValue,
} from '../../src/core/ontology/ontology_dependencies.ts';

function run(raw: unknown, owner = 'zzown'): { out: unknown; warnings: string[] } {
	const warnings: string[] = [];
	return { out: normalizeOntologyDependencies(owner, raw, warnings), warnings };
}

describe('declared vs not declared', () => {
	test('absent / null → null, silently', () => {
		expect(run(undefined)).toEqual({ out: null, warnings: [] });
		expect(run(null)).toEqual({ out: null, warnings: [] });
	});
	test('[] is a declaration (needs nothing), not "not declared"', () => {
		expect(run([])).toEqual({ out: [], warnings: [] });
	});
	test('a non-list → null + a warning', () => {
		for (const raw of ['dd', { tld: 'dd' }, 7, true]) {
			const { out, warnings } = run(raw);
			expect(out).toBeNull();
			expect(warnings.length).toBe(1);
			expect(warnings[0]).toContain('not a list');
		}
	});
});

describe('item shape', () => {
	test('tld trimmed + lowercased; valid items kept in declared order', () => {
		const { out, warnings } = run([
			{ tld: ' DC ', main: 'hierarchy1', mandatory: false },
			{ tld: 'ts', main: 'ontology35', mandatory: true },
		]);
		expect(warnings).toEqual([]);
		expect(out).toEqual([
			{ tld: 'dc', main: 'hierarchy1', mandatory: false },
			{ tld: 'ts', main: 'ontology35', mandatory: true },
		]);
	});
	test('each malformed item is dropped with its own warning', () => {
		const { out, warnings } = run([
			'dd',
			{ tld: 'd1', main: 'ontology35', mandatory: true },
			{ tld: 'dd', main: 'hierarchy20', mandatory: true },
			{ tld: 'dd', main: 'ontology35', mandatory: 'yes' },
			{ tld: 'dd', main: 'ontology35' },
			{ tld: 'rsc', main: 'ontology35', mandatory: true },
		]);
		expect(out).toEqual([{ tld: 'rsc', main: 'ontology35', mandatory: true }]);
		expect(warnings.length).toBe(5);
		expect(warnings.every((line) => line.includes('ignored'))).toBe(true);
	});
	test('extra keys are not carried', () => {
		const { out } = run([{ tld: 'dd', main: 'ontology35', mandatory: true, note: 'x' }]);
		expect(out).toEqual([{ tld: 'dd', main: 'ontology35', mandatory: true }]);
	});
});

describe('dedupe + self-reference', () => {
	test('the same TLD once per main is legitimate (tchi: ontology + thesaurus)', () => {
		const { out, warnings } = run([
			{ tld: 'tchi', main: 'ontology35', mandatory: true },
			{ tld: 'tchi', main: 'hierarchy1', mandatory: false },
		]);
		expect(warnings).toEqual([]);
		expect((out as unknown[]).length).toBe(2);
	});
	test('(tld, main) duplicates: the FIRST wins, the rest warn', () => {
		const { out, warnings } = run([
			{ tld: 'dd', main: 'ontology35', mandatory: false },
			{ tld: 'DD', main: 'ontology35', mandatory: true },
		]);
		expect(out).toEqual([{ tld: 'dd', main: 'ontology35', mandatory: false }]);
		expect(warnings.length).toBe(1);
		expect(warnings[0]).toContain('first declaration wins');
	});
	test('self-reference: ontology35 dropped, hierarchy1 kept', () => {
		const { out, warnings } = run(
			[
				{ tld: 'zzown', main: 'ontology35', mandatory: true },
				{ tld: 'zzown', main: 'hierarchy1', mandatory: true },
			],
			' ZZOWN ',
		);
		expect(out).toEqual([{ tld: 'zzown', main: 'hierarchy1', mandatory: true }]);
		expect(warnings.length).toBe(1);
		expect(warnings[0]).toContain('its own ontology');
	});
});

describe('the stored component_json shape', () => {
	test('misc.hierarchy60[0].value round-trips through the normalizer unchanged', () => {
		const declared = [
			{ tld: 'dc', main: 'hierarchy1' as const, mandatory: false },
			{ tld: 'ts', main: 'ontology35' as const, mandatory: true },
		];
		const misc = { [HIERARCHY_DEPENDENCIES]: dependenciesMiscItems(declared) };
		expect(misc.hierarchy60).toEqual([{ id: 1, value: declared }]);
		expect(run(storedDependenciesValue(misc), 'dc').out).toEqual(declared);
	});
	test('a row without the key (or without misc) declares nothing', () => {
		expect(storedDependenciesValue(null)).toBeUndefined();
		expect(storedDependenciesValue({})).toBeUndefined();
		expect(storedDependenciesValue({ hierarchy60: [] })).toBeUndefined();
		expect(run(storedDependenciesValue({})).out).toBeNull();
	});
});
