/**
 * EXTERNAL-LAW CLASSIFIER + TARGET-RESOLVER TABLE — pure gates
 * (src/core/section/record/external_laws/{classify,resolvers}.ts).
 *
 * The classifier is the one place that decides which value law a mirror
 * obeys; running the wrong law is the measured 118k-locator wipe
 * (the live catalog copy mirrors under law (c)). So every shape is pinned by OUTCOME:
 * the repo-owned fixture twins (testcoincatalog1013/1019 = the catalog copy mirrors,
 * test6380 = the S7 legend mirror, test6157 = the coins-of-a-type mirror), every named
 * refusal (mixed, malformed, the string/number scalar sources), and the PHP
 * update_observer_data config switch row by row (S5 test199 ← test188, S7 no
 * config, S10 refresh_data). The fixture-wide sweep at the end names the
 * EXACT refused set, so a classifier that silently refused everything (or
 * nothing) fails here.
 *
 * Pure: the fixture ontology is read from the repo file, never from a DB.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	isStoredExternalLaw,
	resolveExternalLaw,
} from '../../src/core/section/record/external_laws/classify.ts';
import {
	classifyObserverServerShape,
	externalLawDependencies,
	externalLawPointer,
	isCoveredExternalObserverNode,
	type ObserveServerBlock,
	SERVER_SHAPE_EXEMPTIONS,
} from '../../src/core/section/record/external_laws/resolvers.ts';
import type { StoredExternalLaw } from '../../src/core/section/record/external_laws/types.ts';

interface FixtureNode {
	tipo: string;
	model: string | null;
	properties: unknown;
}

const FIXTURE = JSON.parse(
	readFileSync(join(import.meta.dir, '../../src/core/test_data/test_tld_ontology.json'), 'utf8'),
) as { nodes: FixtureNode[] };
const BY_TIPO = new Map(FIXTURE.nodes.map((node) => [node.tipo, node]));

function fixture(tipo: string): FixtureNode {
	const node = BY_TIPO.get(tipo);
	if (node === undefined)
		throw new Error(`fixture node ${tipo} missing from test_tld_ontology.json`);
	return node;
}

const node = (source: unknown, extra: Record<string, unknown> = {}) => ({
	tipo: 'zzxlcobs1',
	properties: { source, ...extra },
});

const REFUSED_ALIASES = ['observers_law_refused', 'observers_unported_sublaw_refused'];

describe('resolveExternalLaw — the fixture twins', () => {
	test('testcoincatalog1013 (catalog coins twin) → source_overwrite copying test6157 through 1004', () => {
		expect(resolveExternalLaw(fixture('testcoincatalog1013'))).toEqual({
			kind: 'source_overwrite',
			observerTipo: 'testcoincatalog1013',
			pointerTipo: 'testcoincatalog1004',
			dataFromField: 'test6157',
		});
	});

	test('testcoincatalog1019 (catalog ordered-coins twin) → source_overwrite copying test6105', () => {
		expect(resolveExternalLaw(fixture('testcoincatalog1019'))).toEqual({
			kind: 'source_overwrite',
			observerTipo: 'testcoincatalog1019',
			pointerTipo: 'testcoincatalog1004',
			dataFromField: 'test6105',
		});
	});

	test('test6380 (S7 legend mirror) → observed_data get_locators_of_tags over test6263 svg tags', () => {
		expect(resolveExternalLaw(fixture('test6380'))).toEqual({
			kind: 'observed_data',
			observerTipo: 'test6380',
			ddoTipo: 'test6263',
			fn: 'get_locators_of_tags',
			tags: ['svg'],
		});
	});

	test('test6157 (coins-of-a-type twin) → law (c) with its data_from_field seed peers', () => {
		expect(resolveExternalLaw(fixture('test6157'))).toEqual({
			kind: 'inverse_search',
			observerTipo: 'test6157',
			componentToSearch: 'test6230',
			sectionToSearch: ['test6100'],
			dataFromField: ['test6119'],
		});
	});
});

describe('resolveExternalLaw — closed refusals (no law falls back to another)', () => {
	const refusalOf = (source: unknown, extra?: Record<string, unknown>) => {
		const law = resolveExternalLaw(node(source, extra));
		if (law.kind !== 'refused') throw new Error(`expected a refusal, got ${law.kind}`);
		return law;
	};

	test('both sub-laws → both_sublaws (PHP silently took set_observed_data)', () => {
		const law = refusalOf({
			set_observed_data: [{ tipo: 'zzxlctext1' }],
			source_overwrite: { data_from_field: 'zzxlcsrc1' },
			component_to_search: ['zzxlcptr1'],
		});
		expect(law.reason).toBe('both_sublaws');
		expect(law.counters).toEqual(REFUSED_ALIASES);
	});

	test('a sub-law next to a top-level data_from_field → sublaw_with_data_from_field', () => {
		expect(
			refusalOf({
				source_overwrite: { data_from_field: 'zzxlcsrc1' },
				component_to_search: ['zzxlcptr1'],
				data_from_field: ['zzxlcpeer1'],
			}).reason,
		).toBe('sublaw_with_data_from_field');
		expect(
			refusalOf({ set_observed_data: [{ tipo: 'zzxlctext1' }], data_from_field: ['zzxlcpeer1'] })
				.reason,
		).toBe('sublaw_with_data_from_field');
	});

	test('source_overwrite without component_to_search → refused, NOT law (c) (PHP fell through)', () => {
		expect(refusalOf({ source_overwrite: { data_from_field: 'zzxlcsrc1' } }).reason).toBe(
			'source_overwrite_without_component_to_search',
		);
	});

	test('source_overwrite with a non-string data_from_field → source_overwrite_malformed', () => {
		for (const overwrite of [
			{ data_from_field: ['zzxlcsrc1'] },
			{ data_from_field: '' },
			'zzxlcsrc1',
			null,
		]) {
			expect(
				refusalOf({ source_overwrite: overwrite, component_to_search: ['zzxlcptr1'] }).reason,
			).toBe('source_overwrite_malformed');
		}
	});

	test('malformed scalar sources (a string, a number) and an absent source refuse under the historical counter', () => {
		for (const source of ['zz-string-source', 90, [], undefined, null]) {
			const law = refusalOf(source);
			expect(law.reason).toBe('source_not_object');
			expect(law.counters).toEqual(['observers_component_to_search_missing']);
		}
	});

	test('law (c) shape with no string component_to_search → component_to_search_missing', () => {
		for (const source of [{}, { component_to_search: [] }, { component_to_search: [7] }]) {
			const law = refusalOf(source);
			expect(law.reason).toBe('component_to_search_missing');
			expect(law.counters).toEqual(['observers_component_to_search_missing']);
		}
	});

	test('a missing node refuses as node_missing, counted like an absent source', () => {
		const law = resolveExternalLaw(null, 'zzxlcgone1');
		expect(law).toMatchObject({
			kind: 'refused',
			observerTipo: 'zzxlcgone1',
			reason: 'node_missing',
			counters: ['observers_component_to_search_missing'],
		});
	});

	test('set_observed_data malformed (empty, no tipo, not an array) → observed_data_malformed', () => {
		for (const raw of [[], [{}], [{ tipo: '' }], { tipo: 'zzxlctext1' }, 'zzxlctext1']) {
			expect(refusalOf({ set_observed_data: raw }).reason).toBe('observed_data_malformed');
		}
	});

	test('a perform.function outside the closed set is refused, never called by name', () => {
		for (const perform of [{ function: 'get_dato' }, { function: 7 }, {}, 'get_locators_of_tags']) {
			expect(refusalOf({ set_observed_data: [{ tipo: 'zzxlctext1', perform }] }).reason).toBe(
				'observed_data_function_unknown',
			);
		}
	});

	test('a tag type outside the closed tag set (or an empty list) → observed_data_tags_invalid', () => {
		for (const params of [
			{ ar_tags: ['person'] },
			{ ar_tags: [] },
			{ ar_tags: 'svg' },
			{ ar_mark_tag: [1] },
		]) {
			expect(
				refusalOf({
					set_observed_data: [
						{ tipo: 'zzxlctext1', perform: { function: 'get_locators_of_tags', params } },
					],
				}).reason,
			).toBe('observed_data_tags_invalid');
		}
	});
});

describe('resolveExternalLaw — set_observed_data spellings', () => {
	const tagsOf = (perform: unknown) => {
		const law = resolveExternalLaw(node({ set_observed_data: [{ tipo: 'zzxlctext1', perform }] }));
		if (law.kind !== 'observed_data') throw new Error(`expected observed_data, got ${law.kind}`);
		return law;
	};

	test('ar_mark_tag (PHP key) wins over ar_tags; ar_tags honoured; default svg; deduped', () => {
		const fn = 'get_locators_of_tags';
		expect(
			tagsOf({ function: fn, params: { ar_mark_tag: ['note'], ar_tags: ['svg'] } }).tags,
		).toEqual(['note']);
		expect(tagsOf({ function: fn, params: { ar_tags: ['svg', 'note', 'svg'] } }).tags).toEqual([
			'svg',
			'note',
		]);
		expect(tagsOf({ function: fn }).tags).toEqual(['svg']);
		// PHP spreads an array params as the argument list: params[0] is the options.
		expect(tagsOf({ function: fn, params: [{ ar_tags: ['geo'] }] }).tags).toEqual(['geo']);
	});

	test('no perform → the ported copy branch (PHP get_data of the same-record ddo)', () => {
		expect(resolveExternalLaw(node({ set_observed_data: [{ tipo: 'zzxlcrel1' }] }))).toEqual({
			kind: 'observed_data',
			observerTipo: 'zzxlcobs1',
			ddoTipo: 'zzxlcrel1',
			fn: 'copy',
			tags: [],
		});
	});

	test('only the FIRST ddo is read (PHP returns after it)', () => {
		const law = resolveExternalLaw(
			node({ set_observed_data: [{ tipo: 'zzxlcfirst1' }, { tipo: 'zzxlcsecond1' }] }),
		);
		expect(law).toMatchObject({ kind: 'observed_data', ddoTipo: 'zzxlcfirst1' });
	});
});

describe('law dependencies + pointer (critique 11: only source_overwrite derives an edge)', () => {
	test('source_overwrite → {observed: dataFromField, via: pointer}', () => {
		expect(externalLawDependencies(resolveExternalLaw(fixture('testcoincatalog1013')))).toEqual([
			{ observed: 'test6157', resolver: 'inverse', via: 'testcoincatalog1004' },
		]);
		expect(
			externalLawPointer(resolveExternalLaw(fixture('testcoincatalog1019')) as StoredExternalLaw),
		).toBe('testcoincatalog1004');
	});

	test('law (c), observed_data and refusals derive nothing (no edge for every data_from_field node)', () => {
		for (const tipo of ['test6157', 'test6380']) {
			const law = resolveExternalLaw(fixture(tipo));
			expect(externalLawDependencies(law)).toEqual([]);
			expect(externalLawPointer(law as StoredExternalLaw)).toBeUndefined();
		}
		expect(externalLawDependencies(resolveExternalLaw(null, 'zzxlcgone1'))).toEqual([]);
	});
});

describe('classifyObserverServerShape — PHP update_observer_data switch, closed', () => {
	const sde = (config?: unknown, filter?: unknown): ObserveServerBlock => ({
		...(config !== undefined ? { config: config as ObserveServerBlock['config'] } : {}),
		...(filter !== undefined ? { filter } : {}),
		perform: { function: 'set_dato_external' },
	});
	const sqo = {
		$and: [{ q: null, path: [{ section_tipo: 'zzxlcsec1', component_tipo: 'zzxlccomp1' }] }],
	};

	test('use_observable_dato + use_self_section:true → self_and_observable', () => {
		expect(
			classifyObserverServerShape(sde({ use_observable_dato: true, use_self_section: true })),
		).toEqual({
			resolver: 'self_and_observable',
		});
	});

	test('use_observable_dato + use_self_section:false → observable, a filter REPLACED (S5 test199 ← test188)', () => {
		const entry = (
			fixture('test199').properties as {
				observe: { component_tipo: string; server: ObserveServerBlock }[];
			}
		).observe.find((candidate) => candidate.component_tipo === 'test188');
		expect(entry?.server.filter).toBeDefined();
		expect(classifyObserverServerShape(entry?.server as ObserveServerBlock)).toEqual({
			resolver: 'observable',
		});
	});

	test('use_inverse_relations:true → inverse (testcoincatalog1019 ← test6105)', () => {
		expect(classifyObserverServerShape(sde({ use_inverse_relations: true }))).toEqual({
			resolver: 'inverse',
		});
		expect(classifyObserverServerShape(sde({ use_inverse_relations: true }, sqo))).toEqual({
			resolver: 'inverse',
		});
	});

	test('no config (S7) and use_observable_dato without use_self_section fall through to self', () => {
		expect(classifyObserverServerShape(sde())).toEqual({ resolver: 'self' });
		expect(classifyObserverServerShape(sde({ use_observable_dato: true }))).toEqual({
			resolver: 'self',
		});
		expect(classifyObserverServerShape(sde(null))).toEqual({ resolver: 'self' });
	});

	test('PHP case order: an observable config wins over use_inverse_relations', () => {
		expect(
			classifyObserverServerShape(
				sde({ use_observable_dato: true, use_self_section: false, use_inverse_relations: true }),
			),
		).toEqual({ resolver: 'observable' });
	});

	test('an SQO filter next to an ADDING resolver is refused; filter:false is not a filter', () => {
		expect(classifyObserverServerShape(sde(undefined, sqo))).toMatchObject({
			refused: true,
			reason: 'filter_not_covered',
		});
		expect(
			classifyObserverServerShape(sde({ use_observable_dato: true, use_self_section: true }, sqo)),
		).toMatchObject({ refused: true, reason: 'filter_not_covered' });
		expect(classifyObserverServerShape(sde(undefined, false))).toEqual({ resolver: 'self' });
	});

	test('S10 refresh_data is a NAMED exemption with a reason; any other perform is not covered', () => {
		expect(Object.keys(SERVER_SHAPE_EXEMPTIONS)).toEqual(['refresh_data']);
		expect(classifyObserverServerShape({ perform: { function: 'refresh_data' } })).toMatchObject({
			refused: true,
			reason: 'named_exemption',
			exemption: 'refresh_data',
		});
		for (const perform of [{ function: 'get_dato' }, {}, null, undefined]) {
			expect(classifyObserverServerShape({ perform } as ObserveServerBlock)).toMatchObject({
				refused: true,
				reason: 'perform_not_covered',
			});
		}
	});
});

describe('isCoveredExternalObserverNode — stored law AND a resolvable set_dato_external edge', () => {
	test('the copy-law twins and the S7 legend mirror are now derived state', () => {
		for (const tipo of ['testcoincatalog1013', 'testcoincatalog1019', 'test6380', 'test6157']) {
			expect(isCoveredExternalObserverNode(fixture(tipo))).toBe(true);
		}
	});

	test('a refused law, a refresh_data-only edge and a client-only node are not covered', () => {
		expect(isCoveredExternalObserverNode(fixture('testimmovable1000'))).toBe(false);
		expect(
			isCoveredExternalObserverNode(
				node(
					{ component_to_search: ['zzxlcptr1'] },
					{ observe: [{ server: { perform: { function: 'refresh_data' } } }] },
				),
			),
		).toBe(false);
		expect(
			isCoveredExternalObserverNode(
				node(
					{ component_to_search: ['zzxlcptr1'] },
					{ observe: [{ client: { event: 'update_value' } }] },
				),
			),
		).toBe(false);
		expect(isCoveredExternalObserverNode(null)).toBe(false);
	});
});

describe('fixture-wide sweep (the suite ontology, every set_dato_external edge)', () => {
	const edges: { tipo: string; server: ObserveServerBlock }[] = [];
	for (const fixtureNode of FIXTURE.nodes) {
		const observe = (fixtureNode.properties as { observe?: unknown } | null)?.observe;
		if (!Array.isArray(observe)) continue;
		for (const entry of observe as { server?: ObserveServerBlock }[]) {
			if (entry?.server?.perform?.function === 'set_dato_external') {
				edges.push({ tipo: fixtureNode.tipo, server: entry.server });
			}
		}
	}
	const observers = [...new Set(edges.map((edge) => edge.tipo))];

	test('the sweep is not vacuous', () => {
		expect(observers.length).toBeGreaterThan(30);
	});

	test('every set_dato_external server shape resolves to a resolver', () => {
		const unresolved = edges.filter(
			(edge) => 'refused' in classifyObserverServerShape(edge.server),
		);
		expect(unresolved.map((edge) => edge.tipo)).toEqual([]);
	});

	test('every observer classifies to a stored law except the EXACT named refusals', () => {
		const refusedTipos = observers
			.filter((tipo) => !isStoredExternalLaw(resolveExternalLaw(fixture(tipo))))
			.sort();
		// testimmovable1000-1002 declare a covered observe edge but no
		// component_to_search: law (c) is undefined for them (counted skip today).
		expect(refusedTipos).toEqual(['testimmovable1000', 'testimmovable1001', 'testimmovable1002']);
		const kinds = new Set(observers.map((tipo) => resolveExternalLaw(fixture(tipo)).kind));
		expect([...kinds].sort()).toEqual([
			'inverse_search',
			'observed_data',
			'refused',
			'source_overwrite',
		]);
	});
});
