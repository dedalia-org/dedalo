/**
 * CALLER-CHILDREN INJECTION — the semantics table of the two pure primitives
 * (src/core/relations/request_config/caller_injection.ts), PHP get_subdatum
 * :2297-2310 (collect) + :2603-2681 (inject).
 *
 * Abstract tipos on purpose (`N` the element, `X`/`Y` intermediate parents, `A`
 * a shared grandchild): the primitives are pure and key on `parent` alone, so
 * no ontology is involved. The live shape they model is the nested-ddo_map
 * plan's E1/E4: a portal's show map declares an autocomplete's children
 * [surname, name] while the autocomplete's own map says [name, surname], and
 * the same two children hang under a second autocomplete (the diamond).
 */

import { describe, expect, test } from 'bun:test';
import { DedaloError } from '../../src/core/errors/index.ts';
import {
	type CallerEngineChildren,
	collectCallerChildren,
	collectDdoMapDescendants,
	type InjectableConfigItem,
	injectCallerChildren,
	MAX_COLLECTED_DESCENDANTS,
} from '../../src/core/relations/request_config/caller_injection.ts';

interface TestDdo {
	tipo: string;
	parent: string;
	section_tipo?: string;
	label?: string;
}

const ddo = (tipo: string, parent: string, extra: Partial<TestDdo> = {}): TestDdo => ({
	tipo,
	parent,
	...extra,
});
const tipos = (list: readonly { tipo: string }[]): string[] => list.map((entry) => entry.tipo);

describe('collectDdoMapDescendants — parent-only, depth-first, duplicates kept', () => {
	test('diamond [X<N, A<X, Y<N, A<Y] → [X, A, Y, A] (both A kept — the retired seen-set lost the second)', () => {
		const map = [ddo('X', 'N'), ddo('A', 'X'), ddo('Y', 'N'), ddo('A', 'Y')];
		expect(tipos(collectDdoMapDescendants(map, 'N', 'ontology'))).toEqual(['X', 'A', 'Y', 'A']);
		// A CLIENT map walks the same primitive (the read.ts wrapper retired in W3).
		expect(tipos(collectDdoMapDescendants(map, 'N', 'client'))).toEqual(['X', 'A', 'Y', 'A']);
	});

	test('the same tipo declared under N with two section_tipos → both kept, in caller order', () => {
		const map = [ddo('A', 'N', { section_tipo: 's1' }), ddo('A', 'N', { section_tipo: 's2' })];
		const collected = collectDdoMapDescendants(map, 'N', 'ontology');
		expect(collected).toHaveLength(2);
		expect(collected.map((entry) => entry.section_tipo)).toEqual(['s1', 's2']);
	});

	test('depth-first: a child is followed by its own descendants before the next sibling', () => {
		const map = [
			ddo('c1', 'N'),
			ddo('c2', 'N'),
			ddo('g1', 'c1'),
			ddo('gg1', 'g1'),
			ddo('other', 'Z'),
		];
		expect(tipos(collectDdoMapDescendants(map, 'N', 'ontology'))).toEqual([
			'c1',
			'g1',
			'gg1',
			'c2',
		]);
	});

	test('a → b → a cycle is cut at the repeat on the ancestor path → [a, b]', () => {
		const map = [ddo('a', 'p'), ddo('b', 'a'), ddo('a', 'b')];
		expect(tipos(collectDdoMapDescendants(map, 'p', 'ontology'))).toEqual(['a', 'b']);
	});

	test('a ddo naming the element itself as a child is a cycle, not a child', () => {
		const map = [ddo('N', 'N'), ddo('c', 'N')];
		expect(tipos(collectDdoMapDescendants(map, 'N', 'ontology'))).toEqual(['c']);
	});

	test('no descendants → []', () => {
		expect(collectDdoMapDescendants([ddo('X', 'other')], 'N', 'ontology')).toEqual([]);
	});

	test('the collected entries are the caller objects themselves (verbatim, not re-processed)', () => {
		const child = ddo('A', 'N', { label: 'caller-processed' });
		expect(collectDdoMapDescendants([child], 'N', 'ontology')[0]).toBe(child);
	});
});

describe('collectDdoMapDescendants — bounded on a client-sent map', () => {
	/** Each tipo declared TWICE under the previous one: 2^k paths from k*2 ddos. */
	const fanOutMap = (levels: number): TestDdo[] => {
		const map: TestDdo[] = [];
		for (let level = 1; level <= levels; level++) {
			const parent = level === 1 ? 'N' : `T${level - 1}`;
			map.push(ddo(`T${level}`, parent), ddo(`T${level}`, parent));
		}
		return map;
	};

	const refusalOf = (origin: 'client' | 'ontology'): unknown => {
		try {
			collectDdoMapDescendants(fanOutMap(20), 'N', origin);
		} catch (error) {
			return error;
		}
		return null;
	};

	test('a CLIENT 2^k fan-out (40 ddos) is REFUSED with a typed request.invalid_rqo, never a RangeError', () => {
		const thrown = refusalOf('client');
		expect(thrown).toBeInstanceOf(DedaloError);
		expect((thrown as DedaloError).code).toBe('request.invalid_rqo');
	});

	test('an ONTOLOGY (server-derived) fan-out blames the definition: ontology.invalid_node naming the element', () => {
		// e.g. a section_list whose properties declare each column twice under the
		// previous one — the request was well formed, the definition is not.
		const thrown = refusalOf('ontology');
		expect(thrown).toBeInstanceOf(DedaloError);
		expect((thrown as DedaloError).code).toBe('ontology.invalid_node');
		expect((thrown as DedaloError).coordinates).toEqual({ tipo: 'N' });
		// the shared caller-config walk carries the origin through
		let viaCaller: unknown = null;
		try {
			collectCallerChildren(
				[{ api_engine: 'dedalo', show: { ddo_map: fanOutMap(20) } }],
				'N',
				'ontology',
			);
		} catch (error) {
			viaCaller = error;
		}
		expect((viaCaller as DedaloError).code).toBe('ontology.invalid_node');
	});

	test('the same fan-out under the bound still keeps every duplicate path', () => {
		// 3 levels → 2 + 4 + 8 = 14 entries
		expect(collectDdoMapDescendants(fanOutMap(3), 'N', 'ontology')).toHaveLength(14);
		// exactly at the bound passes; one over is refused
		expect(collectDdoMapDescendants(fanOutMap(3), 'N', 'client', 14)).toHaveLength(14);
		expect(() => collectDdoMapDescendants(fanOutMap(3), 'N', 'client', 13)).toThrow(DedaloError);
	});

	test('a deep linear chain (2048 levels) walks without a stack overflow, in order', () => {
		const chain = Array.from({ length: MAX_COLLECTED_DESCENDANTS }, (_, index) =>
			ddo(`C${index + 1}`, index === 0 ? 'N' : `C${index}`),
		);
		const collected = collectDdoMapDescendants(chain, 'N', 'ontology');
		expect(collected).toHaveLength(MAX_COLLECTED_DESCENDANTS);
		expect(collected[0]?.tipo).toBe('C1');
		expect(collected.at(-1)?.tipo).toBe(`C${MAX_COLLECTED_DESCENDANTS}`);
	});

	test('a per-ddo loop over a 2048-level client chain stays bounded (O(1) per walk step)', () => {
		// A caller walking collectDdoMapDescendants once per ddo of the client map:
		// a chain [C1<self, C2<C1, …, C2048<C2047] emits n(n-1)/2 ≈ 2.1M entries
		// in all. A per-frame copy of the ancestor path made each walk quadratic
		// (≈34 s for the loop); one mutable path set keeps it linear.
		const chain = Array.from({ length: MAX_COLLECTED_DESCENDANTS }, (_, index) =>
			ddo(`C${index + 1}`, index === 0 ? 'self' : `C${index}`),
		);
		const started = performance.now();
		let emitted = 0;
		for (const entry of chain) {
			emitted += collectDdoMapDescendants(chain, entry.tipo, 'client').length;
		}
		const elapsed = performance.now() - started;
		const n = MAX_COLLECTED_DESCENDANTS;
		expect(emitted).toBe((n * (n - 1)) / 2);
		expect(elapsed).toBeLessThan(2000);
	});

	test('the diamond under the bound is unchanged → [X, A, Y, A]', () => {
		const map = [ddo('X', 'N'), ddo('A', 'X'), ddo('Y', 'N'), ddo('A', 'Y')];
		expect(tipos(collectDdoMapDescendants(map, 'N', 'ontology'))).toEqual(['X', 'A', 'Y', 'A']);
	});
});

describe('collectCallerChildren — per engine, first caller item, four slots', () => {
	const caller: InjectableConfigItem[] = [
		{
			api_engine: 'dedalo',
			show: { ddo_map: [ddo('N', 'self'), ddo('B', 'N'), ddo('C', 'N')] },
			search: { ddo_map: [ddo('S', 'N')] },
			hide: { ddo_map: [ddo('H', 'N')] },
		},
		// A SECOND dedalo item: the first one counts, this one is never read.
		{ api_engine: 'dedalo', show: { ddo_map: [ddo('LATE', 'N')] } },
		{ api_engine: 'zenon', show: { ddo_map: [ddo('Z', 'N')] } },
		// An item without api_engine is the implicit 'dedalo' — already taken.
		{ show: { ddo_map: [ddo('IMPLICIT', 'N')] } },
	];

	test('one entry per engine in caller order; the first item of an engine supplies the children', () => {
		const children = collectCallerChildren(caller, 'N', 'ontology');
		expect(children.map((entry) => entry.api_engine)).toEqual(['dedalo', 'zenon']);
		const dedalo = children[0] as CallerEngineChildren;
		expect(tipos(dedalo.slots.show)).toEqual(['B', 'C']);
		expect(tipos(dedalo.slots.search)).toEqual(['S']);
		expect(tipos(dedalo.slots.choose)).toEqual([]);
		expect(tipos(dedalo.slots.hide)).toEqual(['H']);
		expect(tipos((children[1] as CallerEngineChildren).slots.show)).toEqual(['Z']);
	});

	test('absent / malformed caller config → []', () => {
		expect(collectCallerChildren(null, 'N', 'ontology')).toEqual([]);
		expect(collectCallerChildren(undefined, 'N', 'ontology')).toEqual([]);
		expect(
			collectCallerChildren(
				[{ api_engine: 'dedalo', show: { ddo_map: 'nope' } }],
				'N',
				'ontology',
			)[0]?.slots.show,
		).toEqual([]);
	});
});

describe('injectCallerChildren — per-slot replacement onto the first element item per engine', () => {
	const ownShow = [ddo('A', 'N'), ddo('B', 'N')];
	const ownHide = [ddo('DF', 'N')];
	const base = (): InjectableConfigItem[] => [
		{
			api_engine: 'dedalo',
			type: 'main',
			sqo: { section_tipo: ['T'], limit: 7 },
			show: { ddo_map: ownShow, sqo_config: { limit: 7 } },
			hide: { ddo_map: ownHide },
		},
		{ api_engine: 'dedalo', type: 'secondary', show: { ddo_map: [ddo('SECOND', 'N')] } },
	];
	const callerWith = (slots: Partial<Record<'show' | 'search' | 'choose' | 'hide', TestDdo[]>>) =>
		collectCallerChildren(
			[
				{
					api_engine: 'dedalo',
					show: slots.show === undefined ? undefined : { ddo_map: slots.show },
					search: slots.search === undefined ? undefined : { ddo_map: slots.search },
					choose: slots.choose === undefined ? undefined : { ddo_map: slots.choose },
					hide: slots.hide === undefined ? undefined : { ddo_map: slots.hide },
				},
			],
			'N',
			'ontology',
		);

	test('caller show [B, C] replaces own show [A, B]: A absent, C present, own sqo + sqo_config kept', () => {
		const result = injectCallerChildren(
			base(),
			callerWith({ show: [ddo('B', 'N'), ddo('C', 'N')] }),
		);
		const first = result[0] as InjectableConfigItem;
		expect(first.show?.ddo_map).toBeDefined();
		expect(tipos(first.show?.ddo_map as TestDdo[])).toEqual(['B', 'C']);
		expect(first.show?.sqo_config).toEqual({ limit: 7 });
		expect(first.sqo).toEqual({ section_tipo: ['T'], limit: 7 });
		// show-only caller: the element's own hide (a dataframe) stands.
		expect(tipos(first.hide?.ddo_map as TestDdo[])).toEqual(['DF']);
	});

	test('only the FIRST element item of the engine is injected', () => {
		const result = injectCallerChildren(base(), callerWith({ show: [ddo('C', 'N')] }));
		expect(tipos((result[1] as InjectableConfigItem).show?.ddo_map as TestDdo[])).toEqual([
			'SECOND',
		]);
	});

	test('an empty caller slot leaves the element map untouched (hide-only caller keeps own show)', () => {
		const result = injectCallerChildren(base(), callerWith({ show: [], hide: [ddo('H2', 'N')] }));
		const first = result[0] as InjectableConfigItem;
		expect(tipos(first.show?.ddo_map as TestDdo[])).toEqual(['A', 'B']);
		expect(tipos(first.hide?.ddo_map as TestDdo[])).toEqual(['H2']);
	});

	test('a search / choose slot the element lacks is created as {ddo_map}', () => {
		const result = injectCallerChildren(
			base(),
			callerWith({ search: [ddo('S', 'N')], choose: [ddo('CH', 'N')] }),
		);
		const first = result[0] as InjectableConfigItem;
		expect(first.search).toEqual({ ddo_map: [ddo('S', 'N')] });
		expect(first.choose).toEqual({ ddo_map: [ddo('CH', 'N')] });
		expect(tipos(first.show?.ddo_map as TestDdo[])).toEqual(['A', 'B']);
	});

	test('caller ddos are injected VERBATIM (same objects, caller-processed fields intact)', () => {
		const processed = ddo('C', 'N', { label: 'from the caller build' });
		const result = injectCallerChildren(base(), callerWith({ show: [processed] }));
		expect(((result[0] as InjectableConfigItem).show?.ddo_map as TestDdo[])[0]).toBe(processed);
	});

	test('an external-only element under a dedalo caller is unchanged, no throw', () => {
		const external: InjectableConfigItem[] = [
			{ api_engine: 'zenon', show: { ddo_map: [ddo('R', 'N')] } },
		];
		const result = injectCallerChildren(external, callerWith({ show: [ddo('C', 'N')] }));
		expect(result).toEqual(external);
	});

	test('a multi-engine element gets each engine from its own caller engine', () => {
		const element: InjectableConfigItem[] = [
			{ api_engine: 'zenon', show: { ddo_map: [ddo('R1', 'N')] } },
			{ api_engine: 'dedalo', show: { ddo_map: [ddo('A', 'N')] } },
		];
		const caller = collectCallerChildren(
			[
				{ api_engine: 'dedalo', show: { ddo_map: [ddo('D', 'N')] } },
				{ api_engine: 'zenon', show: { ddo_map: [ddo('R2', 'N')] } },
			],
			'N',
			'ontology',
		);
		const result = injectCallerChildren(element, caller);
		expect(tipos((result[0] as InjectableConfigItem).show?.ddo_map as TestDdo[])).toEqual(['R2']);
		expect(tipos((result[1] as InjectableConfigItem).show?.ddo_map as TestDdo[])).toEqual(['D']);
	});

	test('inputs are never mutated; the result is a fresh array of fresh injected items', () => {
		const element = base();
		const elementSnapshot = structuredClone(element);
		const callerConfig: InjectableConfigItem[] = [
			{
				api_engine: 'dedalo',
				show: { ddo_map: [ddo('C', 'N')] },
				search: { ddo_map: [ddo('S', 'N')] },
			},
		];
		const callerSnapshot = structuredClone(callerConfig);
		const children = collectCallerChildren(callerConfig, 'N', 'ontology');
		const result = injectCallerChildren(element, children);
		expect(element).toEqual(elementSnapshot);
		expect(callerConfig).toEqual(callerSnapshot);
		expect(result).not.toBe(element);
		expect(result[0]).not.toBe(element[0]);
		expect((result[0] as InjectableConfigItem).show).not.toBe(
			(element[0] as InjectableConfigItem).show,
		);
		// an untouched item is shared by reference (no needless copy)
		expect(result[1]).toBe(element[1]);
	});

	test('no caller children at all → an equal config (own map is the fallback)', () => {
		const element = base();
		expect(injectCallerChildren(element, callerWith({}))).toEqual(element);
		expect(injectCallerChildren(null, [])).toEqual([]);
	});
});
