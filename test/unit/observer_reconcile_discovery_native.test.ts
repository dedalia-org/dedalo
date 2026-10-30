/**
 * Observer reconcile — the CLASSIFIER and the DISCOVERY halves, gated pure.
 *
 * Sibling files, different subjects: `observer_reconcile_native.test.ts` gates
 * the kernel's one-record law against the suite DB, and
 * `observer_reconcile_sweep_native.test.ts` gates a real scratch sweep. This
 * file gates the two decision surfaces the sweep is built out of — which
 * declared edges become tuples, and what ONE kernel outcome does to the
 * census/counters/report — with a fully stubbed `ReconcileIO`: no DB, no
 * ontology, no writes (scratch namespace: none needed).
 *
 * It also SOURCE-ASSERTS the rewire: the extracted logic must exist exactly
 * once, above the orchestrator, and the orchestrator must call it. A revert
 * that re-inlines the classifier turns this RED even if every behaviour
 * expectation is still satisfiable by the inline copy.
 */
// Migrated to the generic `test` TLD 2026-08-20 (AGENTS.md hard rule). Every tipo in
// this file is an OPAQUE IDENTIFIER in a hand-built tuple or a mocked registry — the
// gate never reads a record — so install tipos became their twins
// (src/core/test_data/test_tld_tipo_map.json) and the seed-shipped ones are spelled
// through `seed()`.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getCounters } from '../../src/core/api/counters.ts';

/** Seed-shipped tipo, spelled so the census sees a reference, not a binding. */
const seed = <T extends string, N extends number>(tld: T, id: N): `${T}${N}` => `${tld}${id}`;

import type { ExternalLaw } from '../../src/core/section/record/external_laws/types.ts';
import {
	classifyReconcileOutcome,
	type ExternalRecomputeOutcome,
	expandTuplesByHostSections,
	expandTuplesByIndexSections,
	isCoveredReconcileEdge,
	type ReconcileIO,
	type ReconcileRecord,
	type ReconcileTuple,
	reconcileObserverMirrors,
	selectReconcileTuples,
} from '../../src/core/section/record/observer_reconcile.ts';
import type {
	ObserveEntry,
	ObserverSubscription,
	SubscriptionIndex,
} from '../../src/core/section/record/observer_subscriptions.ts';

const REPO_ROOT = join(import.meta.dir, '../..');
const RECONCILE_SOURCE = readFileSync(
	join(REPO_ROOT, 'src/core/section/record/observer_reconcile.ts'),
	'utf-8',
);

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

/** The ONE covered server shape: use_observable_dato + set_dato_external. */
function coveredEntry(): ObserveEntry {
	return {
		component_tipo: 'obs1',
		server: {
			config: { use_observable_dato: true },
			perform: { function: 'set_dato_external' },
		},
	};
}

function edge(over: Partial<ObserverSubscription> = {}): ObserverSubscription {
	return {
		observedTipo: 'observed1',
		observerTipo: 'observer1',
		declaration: 'reverse-only',
		viaWildcard: false,
		entry: coveredEntry(),
		hostSection: 'host1',
		...over,
	};
}

/** Law (c) over component `C` — the default tuple law. */
function inverseLaw(componentToSearch = 'C', observerTipo = 'observer1'): ExternalLaw {
	return {
		kind: 'inverse_search',
		observerTipo,
		componentToSearch,
		sectionToSearch: 'all',
		dataFromField: undefined,
	};
}

function tuple(over: Partial<ReconcileTuple> = {}): ReconcileTuple {
	return {
		observedTipo: 'observed1',
		observerTipo: 'observer1',
		hostSection: 'host1',
		law: inverseLaw(),
		host: true,
		...over,
	};
}

function outcome(over: Partial<ExternalRecomputeOutcome> = {}): ExternalRecomputeOutcome {
	return { changed: true, before: 0, after: 0, ...over };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. classifyReconcileOutcome — the per-candidate adjudication
// ─────────────────────────────────────────────────────────────────────────────

describe('classifyReconcileOutcome', () => {
	test('unchanged outcome: nothing drifted, nothing counted, nothing logged', () => {
		const verdict = classifyReconcileOutcome(
			outcome({ changed: false, before: 7, after: 7 }),
			tuple(),
			5,
			true,
		);
		expect(verdict.drifted).toBe(false);
		expect(verdict.record).toBeNull();
		expect(verdict.log).toBeNull();
		expect(verdict.counted).toEqual({
			droppedRecords: 0,
			droppedLocators: 0,
			degradedSeedRecords: 0,
			bigResultRefused: 0,
			shrinksSkipped: 0,
			repaired: 0,
			reindexed: 0,
		});
	});

	test('>2000-reference FREEZE is drifted, counted as refused, and NEVER repaired', () => {
		// The PHP freeze: the kernel computed the diff and persisted nothing.
		const verdict = classifyReconcileOutcome(
			outcome({ before: 4547, after: 4600, dropped: 0, added: 53, refusedBigResult: true }),
			tuple({ hostSection: seed('rsc', 167), observerTipo: seed('rsc', 387) }),
			91,
			true,
		);
		expect(verdict.drifted).toBe(true);
		expect(verdict.counted.bigResultRefused).toBe(1);
		expect(verdict.counted.repaired).toBe(0);
		expect(verdict.counted.droppedRecords).toBe(0);
		expect(verdict.counted.droppedLocators).toBe(0);
		expect(verdict.record?.refusal).toBe('big_result');
		expect(verdict.record?.added).toBe(53);
		expect(verdict.log).toContain('>2000-reference FREEZE');
		expect(verdict.log).toContain('not written');
	});

	test('freeze in DRY RUN says "an apply would refuse", not "not written"', () => {
		const verdict = classifyReconcileOutcome(
			outcome({ before: 4547, after: 4600, dropped: 0, added: 53, refusedBigResult: true }),
			tuple(),
			91,
			false,
		);
		expect(verdict.log).toContain('an apply would refuse');
		expect(verdict.log).not.toContain('not written');
	});

	test('DEGRADED SEED: shrink held, drops still counted, nothing repaired', () => {
		// Corrected input — observers.ts only sets skippedShrink when it actually
		// withheld drops (`withheld = dropped > 0 && defects.length > 0`), so a
		// `dropped:0` degraded-seed outcome is unreachable. The drop counters are
		// what the shrink budget adjudicates, so they MUST move here too.
		const verdict = classifyReconcileOutcome(
			outcome({
				before: 1077,
				after: 960,
				dropped: 117,
				added: 0,
				skippedShrink: true,
				seedDefects: ['peer_node_missing:test6119'],
			}),
			tuple({ hostSection: seed('rsc', 205), observerTipo: seed('rsc', 387) }),
			91098,
			true,
		);
		expect(verdict.drifted).toBe(true);
		expect(verdict.counted.shrinksSkipped).toBe(1);
		expect(verdict.counted.repaired).toBe(0);
		expect(verdict.counted.degradedSeedRecords).toBe(1);
		expect(verdict.counted.droppedRecords).toBe(1);
		expect(verdict.counted.droppedLocators).toBe(117);
		expect(verdict.counted.bigResultRefused).toBe(0);
		expect(verdict.record?.refusal).toBe('degraded_seed');
		expect(verdict.record?.seedDefects).toEqual(['peer_node_missing:test6119']);
		expect(verdict.log).toContain('SHRINK held — DEGRADED SEED: peer_node_missing:test6119');
		expect(verdict.log).toContain('grows applied');
	});

	test('MASKED SWAP: equal length, membership counts still report the 2 drops', () => {
		// The exact regression shape the budget exists to catch — `before - after`
		// is 0 here, so a length-delta census would sail straight through.
		const verdict = classifyReconcileOutcome(
			outcome({ before: 3, after: 3, dropped: 2, added: 2 }),
			tuple(),
			1,
			true,
		);
		expect(verdict.counted.droppedLocators).toBe(2);
		expect(verdict.counted.droppedRecords).toBe(1);
		expect(verdict.record?.dropped).toBe(2);
		expect(verdict.record?.added).toBe(2);
		expect(verdict.counted.repaired).toBe(1);
		expect(verdict.log).not.toContain('[shrink]');
		expect(verdict.log).toContain('[repaired]');
	});

	test('LEGACY outcome without membership counts falls back to the length delta', () => {
		const verdict = classifyReconcileOutcome(outcome({ before: 5, after: 2 }), tuple(), 1, false);
		expect(verdict.record?.dropped).toBe(3);
		expect(verdict.record?.added).toBe(0);
		expect(verdict.counted.droppedRecords).toBe(1);
		expect(verdict.counted.droppedLocators).toBe(3);
		// Dry run: never repaired, and the shrink marker is on the line.
		expect(verdict.counted.repaired).toBe(0);
		expect(verdict.log).toContain('[shrink]');
		expect(verdict.log).not.toContain('[repaired]');
	});

	test('legacy GROW-only fallback clamps at 0 — Math.max, not a negative drop', () => {
		const verdict = classifyReconcileOutcome(outcome({ before: 2, after: 5 }), tuple(), 1, false);
		expect(verdict.record?.dropped).toBe(0);
		expect(verdict.record?.added).toBe(3);
		expect(verdict.counted.droppedRecords).toBe(0);
	});

	test('clean apply: repaired 1; the same outcome dry-run: repaired 0', () => {
		const clean = outcome({ before: 1, after: 2, dropped: 0, added: 1 });
		expect(classifyReconcileOutcome(clean, tuple(), 1, true).counted.repaired).toBe(1);
		expect(classifyReconcileOutcome(clean, tuple(), 1, false).counted.repaired).toBe(0);
	});

	test('refusal precedence: big_result wins over a simultaneous skippedShrink', () => {
		const verdict = classifyReconcileOutcome(
			outcome({
				before: 10,
				after: 4,
				dropped: 6,
				added: 0,
				refusedBigResult: true,
				skippedShrink: true,
				seedDefects: ['x'],
			}),
			tuple(),
			1,
			true,
		);
		expect(verdict.record?.refusal).toBe('big_result');
		expect(verdict.counted.bigResultRefused).toBe(1);
		expect(verdict.counted.shrinksSkipped).toBe(0);
	});

	test('no seedDefects key at all when the kernel reported none', () => {
		const verdict = classifyReconcileOutcome(outcome({ before: 1, after: 2 }), tuple(), 1, false);
		expect(Object.hasOwn(verdict.record as ReconcileRecord, 'seedDefects')).toBe(false);
		expect(Object.hasOwn(verdict.record as ReconcileRecord, 'refusal')).toBe(false);
	});

	test('the report line carries the tuple/record identity verbatim', () => {
		const verdict = classifyReconcileOutcome(
			outcome({ before: 1, after: 2 }),
			tuple({ hostSection: 'test1026', observerTipo: seed('hierarchy', 93) }),
			58,
			false,
		);
		expect(verdict.log).toBe('  test1026 §58 hierarchy93: 1 → 2 entrie(s)');
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. selectReconcileTuples — the pure edge → tuple law
// ─────────────────────────────────────────────────────────────────────────────

const SOURCE_WITH_C = (): unknown => ({ component_to_search: ['C'] });

describe('selectReconcileTuples', () => {
	test('only a COVERED server shape reconciles (the shapes differ ONLY in `server`)', () => {
		// Every other field is identical on purpose: same hostSection, same
		// observerTipo family, same source. If the shape filter were removed,
		// (c)/(d)/(e) would survive — they cannot die at the law classifier,
		// because they all carry a component_to_search. The covered set is the
		// LIVE DISPATCH's resolver table (classifyObserverServerShape): (b)
		// `use_observable_dato:false` + set_dato_external is the 'self' resolver
		// (the S7 legend shape) and reconciles since 2026-10-30.
		const edges: ObserverSubscription[] = [
			edge({ observerTipo: 'a' }),
			edge({
				observerTipo: 'b',
				entry: {
					component_tipo: 'obs1',
					server: {
						config: { use_observable_dato: false },
						perform: { function: 'set_dato_external' },
					},
				},
			}),
			edge({
				observerTipo: 'c',
				entry: {
					component_tipo: 'obs1',
					server: { config: { use_observable_dato: true }, perform: { function: 'relay' } },
				},
			}),
			edge({ observerTipo: 'd', entry: { component_tipo: 'obs1' } }),
			edge({
				// An SQO filter next to `self` is not a shape the table runs.
				observerTipo: 'e',
				entry: {
					component_tipo: 'obs1',
					server: {
						config: { use_observable_dato: false },
						filter: { $and: [] },
						perform: { function: 'set_dato_external' },
					},
				} as ObserveEntry,
			}),
		];
		const { tuples } = selectReconcileTuples(edges, SOURCE_WITH_C, null);
		expect(tuples.map((t) => t.observerTipo)).toEqual(['a', 'b']);
		expect(tuples[0]?.law).toEqual(inverseLaw('C', 'a'));
	});

	test('a LAW-DERIVED inverse edge (registry pass 3) is a covered reconcile edge', () => {
		// The entry shape observer_subscriptions.ts mints for a source_overwrite
		// observer's data_from_field dependency: use_inverse_relations +
		// set_dato_external, no params. It must reconcile exactly as it dispatches.
		const derived = edge({
			observerTipo: 'derived',
			declaration: 'law-derived',
			origin: 'law',
			via: 'P',
			entry: {
				component_tipo: 'observed1',
				server: {
					config: { use_inverse_relations: true },
					perform: { function: 'set_dato_external' },
				},
			},
		});
		expect(isCoveredReconcileEdge(derived)).toBe(true);
		const { tuples } = selectReconcileTuples(
			[derived],
			() => ({ source_overwrite: { data_from_field: 'observed1' }, component_to_search: ['P'] }),
			null,
		);
		expect(tuples.map((t) => t.law.kind)).toEqual(['source_overwrite']);
	});

	test('the classifier decides the tuple law: ported sub-laws are POSITIVE, ambiguous/malformed ones surface REFUSED', () => {
		const overwrite = selectReconcileTuples(
			[edge()],
			() => ({ source_overwrite: { data_from_field: 'test6157' }, component_to_search: ['P'] }),
			null,
		);
		expect(overwrite.tuples[0]?.law).toEqual({
			kind: 'source_overwrite',
			observerTipo: 'observer1',
			pointerTipo: 'P',
			dataFromField: 'test6157',
		});

		const observed = selectReconcileTuples(
			[edge()],
			() => ({
				set_observed_data: [
					{
						tipo: 'test6263',
						perform: { function: 'get_locators_of_tags', params: { ar_tags: ['svg'] } },
					},
				],
			}),
			null,
		);
		expect(observed.tuples[0]?.law.kind).toBe('observed_data');

		// Malformed sub-laws are refused tuples (reported, never swept) — the
		// refusal runs BEFORE component_to_search, so a present pointer does not
		// turn a malformed sub-law node into law (c).
		const malformedOverwrite = selectReconcileTuples(
			[edge()],
			() => ({ source_overwrite: true, component_to_search: ['C'] }),
			null,
		);
		expect(malformedOverwrite.tuples.length).toBe(1);
		expect(malformedOverwrite.tuples[0]?.law).toMatchObject({
			kind: 'refused',
			reason: 'source_overwrite_malformed',
		});
		const malformedObserved = selectReconcileTuples(
			[edge()],
			() => ({ set_observed_data: {}, component_to_search: ['test6230'] }),
			null,
		);
		expect(malformedObserved.tuples[0]?.law).toMatchObject({
			kind: 'refused',
			reason: 'observed_data_malformed',
		});
	});

	test('BOTH sub-laws on one node is refused as ambiguous (PHP silently took set_observed_data)', () => {
		const { tuples } = selectReconcileTuples(
			[edge()],
			() => ({ source_overwrite: true, set_observed_data: {} }),
			null,
		);
		expect(tuples[0]?.law).toMatchObject({ kind: 'refused', reason: 'both_sublaws' });
	});

	test('a LAW-LESS node (no component_to_search) yields no tuple at all — not a refused one', () => {
		const { tuples } = selectReconcileTuples([edge()], () => ({ section_to_search: ['s'] }), null);
		expect(tuples).toEqual([]);
	});

	test('MALFORMED scalar source: no sub-law, no tuple, no throw', () => {
		for (const bad of ['some string', 42, null, undefined, true]) {
			const { tuples, hostUnresolved } = selectReconcileTuples([edge()], () => bad, null);
			expect(tuples).toEqual([]);
			expect(hostUnresolved).toEqual([]);
		}
	});

	test('an ARRAY source is an object but carries neither sub-law key nor a component', () => {
		const { tuples } = selectReconcileTuples([edge()], () => ['set_observed_data'], null);
		expect(tuples).toEqual([]);
	});

	test('component_to_search as a bare STRING is accepted (not only the array form)', () => {
		const { tuples } = selectReconcileTuples(
			[edge()],
			() => ({ component_to_search: 'C', section_to_search: ['s1', 's2'] }),
			null,
		);
		expect(tuples[0]?.law).toMatchObject({
			kind: 'inverse_search',
			componentToSearch: 'C',
			sectionToSearch: ['s1', 's2'],
		});
	});

	test('UNRESOLVED host: no tuple, but returned loudly as `observed->observer`', () => {
		const { tuples, hostUnresolved } = selectReconcileTuples(
			[
				edge({
					hostSection: undefined,
					observedTipo: 'test6318',
					observerTipo: 'testplace1022',
				}),
			],
			SOURCE_WITH_C,
			null,
		);
		expect(tuples).toEqual([]);
		expect(hostUnresolved).toEqual(['test6318->testplace1022']);
	});

	test('dedup on observerTipo|hostSection — the FIRST edge wins', () => {
		const { tuples } = selectReconcileTuples(
			[
				edge({ observedTipo: 'first' }),
				edge({ observedTipo: 'second' }),
				edge({ observedTipo: 'third', hostSection: 'host2' }),
			],
			SOURCE_WITH_C,
			null,
		);
		expect(tuples.map((t) => `${t.observedTipo}@${t.hostSection}`)).toEqual([
			'first@host1',
			'third@host2',
		]);
	});

	test('onlyObserver filters by observer tipo', () => {
		const edges = [edge({ observerTipo: 'keep' }), edge({ observerTipo: 'drop' })];
		const { tuples } = selectReconcileTuples(edges, SOURCE_WITH_C, 'keep');
		expect(tuples.map((t) => t.observerTipo)).toEqual(['keep']);
	});

	test('an unresolved host is reported even when onlyObserver would exclude it', () => {
		// Order matters: the never-narrow signal fires BEFORE the --observer
		// filter, so an operator narrowing a run still sees the broken edge.
		const { tuples, hostUnresolved } = selectReconcileTuples(
			[edge({ observerTipo: 'other', hostSection: undefined })],
			SOURCE_WITH_C,
			'keep',
		);
		expect(tuples).toEqual([]);
		expect(hostUnresolved).toEqual(['observed1->other']);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. expandTuplesByIndexSections — the index-truth fan-out
// ─────────────────────────────────────────────────────────────────────────────

describe('expandTuplesByIndexSections', () => {
	test('index faces are unioned in, originals kept, already-seen keys skipped', async () => {
		const seed = [tuple({ hostSection: 'testplace1', law: inverseLaw('C') })];
		const out = await expandTuplesByIndexSections(seed, async () => [
			'testplace1', // already seen — must not duplicate
			'test6101',
			'testimmovable1',
			'test6101', // duplicate inside one result set
		]);
		expect(out.map((t) => t.hostSection)).toEqual(['testplace1', 'test6101', 'testimmovable1']);
		// The fan-out clones every other field verbatim.
		expect(out[1]?.law).toEqual(inverseLaw('C'));
		expect(out[1]?.observedTipo).toBe('observed1');
	});

	test('ONLY law (c) tuples fan out by the index — copy-law and refused tuples never do', async () => {
		// The index is keyed by what a record POINTS AT; only law (c)'s targets
		// are "where the referenced records live". A copy law's records are the
		// sections that declare the observer (expandTuplesByHostSections), and a
		// refused tuple is reported once, never swept. Deleting the kind guard
		// therefore ADDS tuples here.
		const calls: string[] = [];
		const out = await expandTuplesByIndexSections(
			[
				tuple({
					observerTipo: 'so',
					law: {
						kind: 'source_overwrite',
						observerTipo: 'so',
						pointerTipo: 'test6230',
						dataFromField: 'X',
					},
				}),
				tuple({
					observerTipo: 'od',
					law: {
						kind: 'observed_data',
						observerTipo: 'od',
						ddoTipo: 'test6263',
						fn: 'get_locators_of_tags',
						tags: ['svg'],
					},
				}),
				tuple({
					observerTipo: 'rf',
					law: {
						kind: 'refused',
						observerTipo: 'rf',
						reason: 'both_sublaws',
						detail: '',
						counters: [],
					},
				}),
			],
			async (component) => {
				calls.push(component);
				return ['test6101', 'testimmovable1'];
			},
		);
		expect(out.map((t) => `${t.observerTipo}@${t.hostSection}`)).toEqual([
			'so@host1',
			'od@host1',
			'rf@host1',
		]);
		expect(calls).toEqual([]);
	});

	test('an index-seeded tuple is NOT re-expanded (only the input list is walked)', async () => {
		const seen: string[] = [];
		await expandTuplesByIndexSections([tuple({ law: inverseLaw('C') })], async (component) => {
			seen.push(component);
			return ['s1', 's2'];
		});
		// One lookup for the ONE input tuple — not three.
		expect(seen).toEqual(['C']);
	});

	test('two tuples sharing an observer dedupe against each other', async () => {
		const out = await expandTuplesByIndexSections(
			[tuple({ hostSection: 'h1' }), tuple({ hostSection: 'h2' })],
			async () => ['h3'],
		);
		expect(out.map((t) => t.hostSection)).toEqual(['h1', 'h2', 'h3']);
	});
});

describe('expandTuplesByHostSections', () => {
	const copyLaw: ExternalLaw = {
		kind: 'source_overwrite',
		observerTipo: 'observer1',
		pointerTipo: 'P',
		dataFromField: 'X',
	};

	test('a copy-law tuple fans out to EVERY section that declares the observer (the virtual faces)', async () => {
		const asked: string[] = [];
		const out = await expandTuplesByHostSections(
			[tuple({ hostSection: 'real1', law: copyLaw })],
			async (observerTipo) => {
				asked.push(observerTipo);
				return ['real1', 'virtual1', 'virtual2', 'virtual1'];
			},
		);
		expect(asked).toEqual(['observer1']);
		expect(out.map((t) => t.hostSection)).toEqual(['real1', 'virtual1', 'virtual2']);
		expect(out[2]?.law).toEqual(copyLaw);
	});

	test('law (c) and refused tuples are NOT fanned out by declaration', async () => {
		const asked: string[] = [];
		const out = await expandTuplesByHostSections(
			[
				tuple(),
				tuple({
					observerTipo: 'rf',
					law: {
						kind: 'refused',
						observerTipo: 'rf',
						reason: 'both_sublaws',
						detail: '',
						counters: [],
					},
				}),
			],
			async (observerTipo) => {
				asked.push(observerTipo);
				return ['elsewhere'];
			},
		);
		expect(asked).toEqual([]);
		expect(out.length).toBe(2);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. reconcileObserverMirrors — the orchestrator, over a stubbed IO
// ─────────────────────────────────────────────────────────────────────────────

interface Spy {
	candidateIdsCalls: number;
	recomputeCalls: { id: number; opts: { write: boolean; repairIndex?: true }; userId: number }[];
}

function stubIO(
	over: Partial<ReconcileIO>,
	spy: Spy,
	edges: ObserverSubscription[],
	source: unknown = SOURCE_WITH_C(),
): ReconcileIO {
	return {
		getRegistry: async (): Promise<SubscriptionIndex> => ({
			byObserved: new Map(),
			edges,
			diagnostics: {
				mirroredServer: [],
				reverseOnly: [],
				forwardOnly: [],
				deadWildcards: [],
				wildcardCompiled: new Map(),
				hostUnresolved: [],
				cycles: [],
				malformedSpecs: [],
				malformedServerEntries: [],
				lawDerived: [],
				lawShadowed: [],
			},
		}),
		getNodeProperties: async () => ({ source }) as Record<string, unknown>,
		indexSectionsFor: async () => [],
		hostSectionsFor: async () => [],
		isHostSection: async () => true,
		matrixTableFor: async () => 'matrix_test',
		candidateIds: async () => {
			spy.candidateIdsCalls++;
			return [1];
		},
		recompute: async (_observer, _host, id, userId, _at, opts) => {
			spy.recomputeCalls.push({ id, opts, userId });
			return outcome({ changed: false });
		},
		...over,
	};
}

function freshSpy(): Spy {
	return { candidateIdsCalls: 0, recomputeCalls: [] };
}

describe('reconcileObserverMirrors (stubbed IO)', () => {
	test('REFUSED-LAW tuple: refused wholesale — never swept, never reported clean', async () => {
		const spy = freshSpy();
		const lines: string[] = [];
		const summary = await reconcileObserverMirrors(
			{ log: (line) => lines.push(line) },
			stubIO({}, spy, [edge()], { set_observed_data: {}, component_to_search: ['test6230'] }),
		);
		expect(summary.tuples).toBe(1);
		expect(summary.sublawRefused).toBe(1);
		expect(summary.candidates).toBe(0);
		expect(summary.drifted).toBe(0);
		expect(spy.candidateIdsCalls).toBe(0);
		expect(spy.recomputeCalls.length).toBe(0);
		expect(lines.join('\n')).toContain('REFUSED');
		expect(lines.join('\n')).toContain('set_observed_data');
	});

	test('UNPROVISIONED host: the tuple exists but is skipped loudly, nothing recomputed', async () => {
		const spy = freshSpy();
		const lines: string[] = [];
		const summary = await reconcileObserverMirrors(
			{ log: (line) => lines.push(line) },
			stubIO({ matrixTableFor: async () => null }, spy, [edge()]),
		);
		// tuples === 1 as well as candidates === 0: a stub that discovered
		// nothing at all cannot pass this.
		expect(summary.tuples).toBe(1);
		expect(summary.candidates).toBe(0);
		expect(spy.recomputeCalls.length).toBe(0);
		expect(lines.join('\n')).toContain('SKIP (no matrix table');
	});

	test('DRY RUN IS THE DEFAULT: recompute is called with { write: false }', async () => {
		const spy = freshSpy();
		await reconcileObserverMirrors({}, stubIO({}, spy, [edge()]));
		expect(spy.recomputeCalls.length).toBe(1);
		expect(spy.recomputeCalls[0]?.opts).toEqual({ write: false, repairIndex: true });
		// The sweep always acts as the SYSTEM user.
		expect(spy.recomputeCalls[0]?.userId).toBe(-1);
	});

	test('apply:true threads { write: true }; any other truthy-ish value does NOT', async () => {
		const applied = freshSpy();
		await reconcileObserverMirrors({ apply: true }, stubIO({}, applied, [edge()]));
		expect(applied.recomputeCalls[0]?.opts).toEqual({ write: true, repairIndex: true });

		const coerced = freshSpy();
		await reconcileObserverMirrors(
			{ apply: 1 as unknown as boolean },
			stubIO({}, coerced, [edge()]),
		);
		expect(coerced.recomputeCalls[0]?.opts).toEqual({ write: false, repairIndex: true });
	});

	test('onlySection matches a face reachable ONLY through the index fan-out', async () => {
		// The registry never yields `test6101`; only indexSectionsFor does. A
		// filter applied before the fan-out would return 0 tuples here — the exact
		// regression the "--section filters LAST" comment describes.
		const spy = freshSpy();
		const summary = await reconcileObserverMirrors(
			{ onlySection: 'test6101' },
			stubIO({ indexSectionsFor: async () => ['test6101', 'testimmovable1'] }, spy, [
				edge({ hostSection: 'testplace1' }),
			]),
		);
		expect(summary.tuples).toBe(1);
		expect(spy.recomputeCalls.length).toBe(1);
	});

	test('census + counters aggregate across candidates, and onRecord fires per drifted record', async () => {
		const spy = freshSpy();
		const records: ReconcileRecord[] = [];
		const lines: string[] = [];
		const outcomes: Record<number, ExternalRecomputeOutcome> = {
			1: outcome({ changed: false }),
			2: outcome({ before: 3, after: 3, dropped: 2, added: 2 }),
			3: outcome({
				before: 1077,
				after: 960,
				dropped: 117,
				added: 0,
				skippedShrink: true,
				seedDefects: ['peer_node_missing:test6119'],
			}),
			4: outcome({ before: 4547, after: 4600, dropped: 0, added: 53, refusedBigResult: true }),
			5: outcome({ before: 1, after: 2, dropped: 0, added: 1 }),
		};
		const summary = await reconcileObserverMirrors(
			{ apply: true, log: (line) => lines.push(line), onRecord: (r) => records.push(r) },
			stubIO(
				{
					candidateIds: async () => [1, 2, 3, 4, 5],
					recompute: async (_o, _h, id, _u, _a, opts) => {
						spy.recomputeCalls.push({ id, opts, userId: _u });
						const found = outcomes[id];
						if (found === undefined) throw new Error(`no fixture outcome for id ${id}`);
						return found;
					},
				},
				spy,
				[edge()],
			),
		);
		expect(summary.candidates).toBe(5);
		expect(summary.drifted).toBe(4);
		expect(summary.repaired).toBe(2); // the swap + the clean grow
		expect(summary.shrinksSkipped).toBe(1);
		expect(summary.bigResultRefused).toBe(1);
		expect(summary.degradedSeedRecords).toBe(1);
		expect(summary.droppedRecords).toBe(2); // the swap (2) + the held shrink (117)
		expect(summary.droppedLocators).toBe(119);
		expect(records.map((r) => r.sectionId)).toEqual([2, 3, 4, 5]);
		expect(records.map((r) => r.refusal)).toEqual([
			undefined,
			'degraded_seed',
			'big_result',
			undefined,
		]);
		// The per-tuple tail line reports the skipped shrink count.
		expect(lines.at(-1)).toBe(
			'- observer1 @ host1 (← observed1): 5 candidate(s), 4 drifted (1 shrink(s) skipped), repaired',
		);
	});

	test('an UNRESOLVED host bumps observers_host_section_unresolved', async () => {
		const before = getCounters().observers_host_section_unresolved ?? 0;
		const summary = await reconcileObserverMirrors(
			{},
			stubIO({}, freshSpy(), [edge({ hostSection: undefined })]),
		);
		expect(summary.tuples).toBe(0);
		// Delta, never a global absolute — other suites share this counter.
		expect((getCounters().observers_host_section_unresolved ?? 0) - before).toBe(1);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. THE REWIRE (static) — the extraction must be the code that RUNS
// ─────────────────────────────────────────────────────────────────────────────

describe('observer reconcile extraction is rewired (static)', () => {
	const orchestratorAt = RECONCILE_SOURCE.indexOf('export async function reconcileObserverMirrors');
	const discoveryAt = RECONCILE_SOURCE.indexOf('async function discoverTuples');

	test('the orchestrator CALLS the extracted functions', () => {
		expect(orchestratorAt).toBeGreaterThan(-1);
		const orchestrator = RECONCILE_SOURCE.slice(orchestratorAt);
		expect(orchestrator).toContain('classifyReconcileOutcome(outcome, tuple, id, apply)');
		const discovery = RECONCILE_SOURCE.slice(discoveryAt, orchestratorAt);
		expect(discovery).toContain('selectReconcileTuples(');
		expect(discovery).toContain('expandTuplesByIndexSections(');
		expect(discovery).toContain('expandTuplesByHostSections(');
		expect(discovery).toContain('io.isHostSection(');
	});

	for (const marker of [
		// classifier internals
		'outcome.dropped ??',
		'outcome.added ??',
		"refusal: 'big_result'",
		'>2000-reference FREEZE',
		'SHRINK held — DEGRADED SEED',
		// discovery internals — the covered edge shape is the dispatch's resolver
		// table, the tuple law is THE classifier's, a host tuple's candidates are
		// its law's, and only law (c) fans out by the index
		'classifyObserverServerShape(server)',
		'resolveExternalLaw(',
		'LAWLESS_REASONS.has(law.reason)',
		'externalValueLawOf(law).candidateIds(',
		"if (tuple.law.kind !== 'inverse_search') continue;",
		'SELECT DISTINCT target_section_tipo',
	]) {
		test(`inline copy of \`${marker}\` is GONE — it exists once, above the orchestrator`, () => {
			const occurrences = RECONCILE_SOURCE.split(marker).length - 1;
			expect(
				occurrences,
				`\`${marker}\` must appear exactly once (inside the extracted function), found ${occurrences}`,
			).toBe(1);
			expect(
				RECONCILE_SOURCE.indexOf(marker),
				`\`${marker}\` is still inline in the orchestrator — the extraction is not wired`,
			).toBeLessThan(orchestratorAt);
		});
	}

	test('the orchestrator no longer calls the kernel/registry/DB directly — only the IO', () => {
		const orchestrator = RECONCILE_SOURCE.slice(orchestratorAt);
		expect(orchestrator).toContain('io.recompute(');
		expect(orchestrator).toContain('io.candidateIds(');
		expect(orchestrator).toContain('io.matrixTableFor(');
		expect(orchestrator).not.toContain('recomputeExternalRelation(');
		expect(orchestrator).not.toContain('getMatrixTableFromTipo(');
		expect(orchestrator).not.toContain('sql.unsafe(');
	});

	test('the injected IO defaults to the real one — callers stay unchanged', () => {
		expect(RECONCILE_SOURCE).toContain('io: ReconcileIO = defaultReconcileIO');
		// Both production callers still pass options only.
		const cli = readFileSync(join(REPO_ROOT, 'scripts/observer_reconcile.ts'), 'utf-8');
		expect(cli).toContain('reconcileObserverMirrors({');
		const updater = readFileSync(join(REPO_ROOT, 'src/core/update/engine.ts'), 'utf-8');
		expect(updater).toContain('reconcileObserverMirrors({');
	});
});
