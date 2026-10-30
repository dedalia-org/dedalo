/**
 * OBSERVER SUBSCRIPTION REGISTRY — the DEC-12 gates
 * (src/core/section/record/observer_subscriptions.ts).
 *
 * THE DISPATCH RULE UNDER TEST (owner ruling 2026-08-02): an edge dispatches
 * iff the OBSERVER declares it in `properties.observe` with a `server` block
 * — plus wildcard edges compiled from forward specs. The ontology decides;
 * NO code table gates it (the transitional hand-written activation list was
 * removed the day it landed — it converted an ontology decision into a code
 * decision).
 *
 * What is pinned here, and why each pin exists:
 *
 * 1. SINGLE-DECLARATION MODEL — a REVERSE-ONLY declaration with a server
 *    block DISPATCHES (the defect that started the investigation: rsc19 ->
 *    oh28 was authored reverse-only and never fired under forward-only
 *    discovery). Proven on a hermetic fixture AND against the live ontology
 *    (rsc19->oh28 resolved + a real end-to-end reverse-only recompute).
 * 2. 'all' COMPILATION — the wildcard is a MATCHING rule compiled into
 *    exactly the forward specs naming the observer (pass 1 only; pass 2
 *    `continue`s on 'all'); it must NEVER subscribe the observer to every
 *    save in the system, and a wildcard with zero forward-declarers is RED.
 *    This is the SOLE residual dependency on the forward `observers` array
 *    (besides reused-component host targeting): 'all' has no intrinsic
 *    scope, so the forward specs are the only thing bounding it.
 * 3. HOST-SECTION RESOLUTION — the 4-step rule: observe-entry scope →
 *    forward-spec section (reused components are NEVER silently retargeted
 *    to the observer's own section) → the observer's own section with
 *    VIRTUAL↔REAL equivalence (numisdata5 ≡ numisdata276 through
 *    relations[0].tipo) → loud refusal (RED + runtime refusal, never a
 *    guessed fallback).
 * 4. DEAD CONFIG IS RED — a forward spec whose observer has no matching
 *    observe entry dispatches nothing on either side; it stays RED until the
 *    ontology is fixed (no code pin can hide it).
 * 5. ACYCLICITY — the declared (non-scratch) observer graph has zero cycles
 *    (measured depth 2 today); a cycle is an authoring error.
 * 6. IMMUTABILITY + LIFECYCLE — deep-frozen index, runtime-hardened Maps,
 *    rebuild-never-patch, S1-14 in-tx memoization.
 *
 * The suite-DB ontology is a strict subset of the app ontology (the tch555/
 * tch557 nodes are absent here) — DB-backed gates are written as
 * subset/equality over WHAT IS DECLARED IN THIS ONTOLOGY.
 *
 * Scratch namespace: edges touching `test999…` tipos are the observer
 * behavioural suites' per-run seeds (deliberate cycles included) — excluded
 * from diagnostics by the carve-out in observer_subscriptions.ts, so
 * crashed-run residue cannot flip these gates red.
 */
// BINDS INSTALL TLDs: dc, numisdata, oh, on, rsc, tch — install-specific fixtures, grandfathered in
// engineering/generic_tld_baseline.json (generic_tld_tripwire, shrink-only). This test
// is meaningful only on a database holding those installs' records. Migrate it to a
// built situation (src/core/test_data/situations) or the generic `test` TLD, then
// regenerate the baseline (`bun run scripts/generic_tld_baseline.ts`).

import { afterAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql, withTransaction } from '../../src/core/db/postgres.ts';
import type { NodeWithProperties } from '../../src/core/ontology/resolver.ts';
import {
	buildSubscriptionIndex,
	clearObserverSubscriptionRegistry,
	entryServerBlock,
	getSubscriptionRegistry,
	type HostSectionContext,
	validateSubscriptionContract,
} from '../../src/core/section/record/observer_subscriptions.ts';
import { propagateToObservers } from '../../src/core/section/record/observers.ts';
import cloneMapJson from '../../src/core/test_data/test_tld_tipo_map.json';
import installCensusJson from './fixtures/observer_subscriptions/install_census.json';

/** Seed-shipped tipo, spelled so the census sees a reference, not a binding. */
const seed = <T extends string, N extends number>(tld: T, id: N): `${T}${N}` => `${tld}${id}`;

// ---------------------------------------------------------------------------
// Fixture helpers (hermetic half — the laws over synthetic ontologies)
// ---------------------------------------------------------------------------

function node(tipo: string, properties: Record<string, unknown>): NodeWithProperties {
	return { tipo, properties };
}

const EXTERNAL_SERVER = {
	config: { use_observable_dato: true },
	perform: { function: 'set_dato_external' },
};

/** An SQO server.filter whose first path step names `sectionTipo` (the
 * oh28/numisdata1478 shape). */
function sqoServer(sectionTipo: string): Record<string, unknown> {
	return {
		filter: {
			$and: [{ q: null, path: [{ section_tipo: sectionTipo, component_tipo: 'p1' }] }],
		},
	};
}

function hostCtx(
	own: Record<string, string>,
	real: Record<string, string> = {},
): HostSectionContext {
	return {
		ownSectionByTipo: new Map(Object.entries(own)),
		realSectionByTipo: new Map(Object.entries(real)),
	};
}

describe('single-declaration model (the defect generator closing — gate a)', () => {
	test('a REVERSE-ONLY observe+server declaration is a dispatchable subscription, no table needed', () => {
		// obs1 subscribes itself to src1 — the observed node declares NOTHING.
		const index = buildSubscriptionIndex([
			node('obs1', { observe: [{ component_tipo: 'src1', server: { filter: false } }] }),
		]);
		expect(index.diagnostics.reverseOnly).toEqual(['src1->obs1']);
		const sub = index.byObserved.get('src1')?.[0];
		expect(sub?.declaration).toBe('reverse-only');
		expect(sub?.observerTipo).toBe('obs1');
		expect(sub?.entry?.server).toBeDefined(); // dispatchability IS server presence
		// The ontology's declaration is legal as-is: NO contract violation.
		expect(validateSubscriptionContract(index)).toEqual([]);
	});

	test('a reverse-only SQO edge resolves its host from the observer own section', () => {
		const index = buildSubscriptionIndex(
			[node('obs2', { observe: [{ component_tipo: 'src2', server: sqoServer('sec1') }] })],
			hostCtx({ obs2: 'sec1' }),
		);
		expect(index.byObserved.get('src2')?.[0]?.hostSection).toBe('sec1');
		expect(index.diagnostics.hostUnresolved).toEqual([]);
		expect(validateSubscriptionContract(index)).toEqual([]);
	});

	test('client-only observe entries register no server edge', () => {
		const index = buildSubscriptionIndex([
			node('obs3', { observe: [{ component_tipo: 'src3', client: { event: 'x' } }] }),
		]);
		expect(index.edges).toHaveLength(0);
		expect(index.diagnostics.reverseOnly).toEqual([]);
	});
});

describe("'all' wildcard compilation (merge-blocker law — gate b)", () => {
	const nodes = [
		node('wcobs1', { observe: [{ component_tipo: 'all', server: EXTERNAL_SERVER }] }),
		node('fwd1', { observers: [{ component_tipo: 'wcobs1' }] }),
		node('fwd2', { observers: [{ component_tipo: 'wcobs1' }] }),
		// A node that observes/declares NOTHING towards wcobs1 — the naive
		// "subscribe to every save" reading would give wcobs1 an edge here too.
		node('bystander1', { observers: [{ component_tipo: 'elsewhere1' }] }),
	];

	test('the wildcard compiles to EXACTLY its forward-declarers, never the universe', () => {
		const index = buildSubscriptionIndex(nodes);
		expect(index.diagnostics.wildcardCompiled.get('wcobs1')).toEqual([
			'fwd1->wcobs1',
			'fwd2->wcobs1',
		]);
		const wcEdges = index.edges.filter((sub) => sub.observerTipo === 'wcobs1');
		expect(wcEdges.map((sub) => sub.observedTipo).sort()).toEqual(['fwd1', 'fwd2']);
		for (const sub of wcEdges) {
			expect(sub.declaration).toBe('mirrored');
			expect(sub.viaWildcard).toBe(true);
			expect(sub.entry?.server).toBeDefined();
		}
		// The bystander gained NO subscription to the wildcard observer — and
		// pass 2 minted NO reverse edge from the 'all' entry itself.
		expect(
			(index.byObserved.get('bystander1') ?? []).some((sub) => sub.observerTipo === 'wcobs1'),
		).toBe(false);
		expect(index.diagnostics.reverseOnly).toEqual([]);
	});

	test('a server wildcard nobody forward-declares admits ZERO edges and is RED', () => {
		const index = buildSubscriptionIndex([
			node('lonelywc1', { observe: [{ component_tipo: 'all', server: EXTERNAL_SERVER }] }),
		]);
		expect(index.edges).toHaveLength(0);
		expect(index.diagnostics.deadWildcards).toEqual(['lonelywc1']);
		const errors = validateSubscriptionContract(index);
		expect(errors.some((e) => e.includes("dead 'all' wildcard") && e.includes('lonelywc1'))).toBe(
			true,
		);
	});

	test('a wildcard SHADOWED by an earlier exact sibling (compiled to zero edges) is RED too', () => {
		// shadowwc1 declares [exact x, 'all'] and x forward-declares it: the
		// first-match law routes the edge through the EXACT entry, so the
		// wildcard compiles to nothing — dead config.
		const index = buildSubscriptionIndex([
			node('shadowsrc1', { observers: [{ component_tipo: 'shadowwc1' }] }),
			node('shadowwc1', {
				observe: [
					{ component_tipo: 'shadowsrc1', server: EXTERNAL_SERVER },
					{ component_tipo: 'all', server: EXTERNAL_SERVER },
				],
			}),
		]);
		// The exact entry mirrors the edge (dispatch unaffected)…
		expect(index.diagnostics.mirroredServer).toEqual(['shadowsrc1->shadowwc1']);
		expect(index.edges[0]?.viaWildcard).toBe(false);
		// …but the wildcard itself compiled to zero edges and must be flagged.
		expect(index.diagnostics.wildcardCompiled.get('shadowwc1')).toBeUndefined();
		expect(index.diagnostics.deadWildcards).toEqual(['shadowwc1']);
		const errors = validateSubscriptionContract(index);
		expect(errors.some((e) => e.includes("dead 'all' wildcard") && e.includes('shadowwc1'))).toBe(
			true,
		);
	});

	test('a reverse-only sibling entry does NOT count as a wildcard declarer (order-independent)', () => {
		// revwc1 observes an exact tipo (reverse-only) AND declares 'all'; no
		// forward spec names revwc1 at all — the wildcard is dead even though
		// the exact sibling dispatches.
		const index = buildSubscriptionIndex([
			node('revwc1', {
				observe: [
					{ component_tipo: 'revsrc1', server: EXTERNAL_SERVER },
					{ component_tipo: 'all', server: EXTERNAL_SERVER },
				],
			}),
		]);
		expect(index.diagnostics.deadWildcards).toEqual(['revwc1']);
		expect(index.diagnostics.reverseOnly).toEqual(['revsrc1->revwc1']);
	});
});

describe('pass-2 first-match law + malformed server declarations (review 2026-08-02)', () => {
	test('duplicate same-tipo observe entries: the FIRST in array order owns the tipo (client-only first → no dispatch)', () => {
		// The same law as pass 1 (the PHP dispatch first-match). Without it,
		// [client-only A, server A] would dispatch reverse-only yet STOP
		// dispatching the day a forward spec on A appears (pass-1 first-match
		// picks the client-only entry) — the same declaration pair behaving
		// differently depending on the legacy forward array. Zero live
		// instances of the mixed shape on either ontology (census 2026-08-02).
		const index = buildSubscriptionIndex([
			node('dupobs1', {
				observe: [
					{ component_tipo: 'dupsrc1', client: { event: 'x' } },
					{ component_tipo: 'dupsrc1', server: EXTERNAL_SERVER },
				],
			}),
		]);
		expect(index.edges).toHaveLength(0);
		expect(index.diagnostics.reverseOnly).toEqual([]);
	});

	test('duplicate same-tipo observe entries: server first → ONE subscription from the first entry (the hi-family shape)', () => {
		const index = buildSubscriptionIndex([
			node('dupobs2', {
				observe: [
					{ component_tipo: 'dupsrc2', server: { filter: false } },
					{ component_tipo: 'dupsrc2', server: EXTERNAL_SERVER },
				],
			}),
		]);
		expect(index.diagnostics.reverseOnly).toEqual(['dupsrc2->dupobs2']);
		const subs = index.byObserved.get('dupsrc2') ?? [];
		expect(subs).toHaveLength(1);
		// The FIRST entry's server block dispatches (filter:false), never the
		// later duplicate's.
		expect(subs[0]?.entry?.server?.filter).toBe(false);
	});

	test('a non-object server value (server:null) is MALFORMED — not dispatchable, RED', () => {
		const index = buildSubscriptionIndex([
			node('malobs1', { observe: [{ component_tipo: 'malsrc1', server: null }] }),
		]);
		expect(index.edges).toHaveLength(0);
		expect(index.diagnostics.reverseOnly).toEqual([]);
		expect(index.diagnostics.malformedServerEntries).toEqual([
			{ observerTipo: 'malobs1', componentTipo: 'malsrc1' },
		]);
		const errors = validateSubscriptionContract(index);
		expect(errors.some((e) => e.includes('malformed declaration') && e.includes("'malobs1'"))).toBe(
			true,
		);
	});

	test('a MIRRORED edge with a malformed server is excluded from dispatchability too (entryServerBlock is the one predicate)', () => {
		const index = buildSubscriptionIndex([
			node('malsrc2', { observers: [{ component_tipo: 'malobs2' }] }),
			node('malobs2', { observe: [{ component_tipo: 'malsrc2', server: 'yes' }] }),
		]);
		// The declaration pair exists (mirrored, not dead-forward)…
		expect(index.diagnostics.forwardOnly).toEqual([]);
		// …but it is NOT a dispatchable server edge, and the malformed value is RED.
		expect(index.diagnostics.mirroredServer).toEqual([]);
		expect(index.diagnostics.malformedServerEntries).toEqual([
			{ observerTipo: 'malobs2', componentTipo: 'malsrc2' },
		]);
		expect(entryServerBlock(index.byObserved.get('malsrc2')?.[0]?.entry)).toBeUndefined();
	});
});

describe('host-section resolution (the 4-step rule — gates c/d)', () => {
	test("step 1: the observe entry's own section_tipo wins over everything", () => {
		const index = buildSubscriptionIndex(
			[
				node('hsrc1', { observers: [{ component_tipo: 'hobs1', section_tipo: 'spec1' }] }),
				node('hobs1', {
					observe: [
						{ component_tipo: 'hsrc1', section_tipo: 'entryscope1', server: sqoServer('own1') },
					],
				}),
			],
			hostCtx({ hobs1: 'own1' }),
		);
		expect(index.byObserved.get('hsrc1')?.[0]?.hostSection).toBe('entryscope1');
	});

	test('step 2: a REUSED component keeps each forward spec host — never retargeted to its own section (hierarchy93 shape)', () => {
		// One observer declared ONCE, forward-declared by one observed component
		// three times with different section scopes, while the observer's own
		// section is a different one entirely.
		const index = buildSubscriptionIndex(
			[
				node('rsrc1', {
					observers: [
						{ component_tipo: 'robs1', section_tipo: 'secA' },
						{ component_tipo: 'robs1', section_tipo: 'secB' },
						{ component_tipo: 'robs1', section_tipo: 'secC' },
					],
				}),
				node('robs1', { observe: [{ component_tipo: 'rsrc1', server: EXTERNAL_SERVER }] }),
			],
			hostCtx({ robs1: 'ownHier1' }),
		);
		const hosts = (index.byObserved.get('rsrc1') ?? []).map((sub) => sub.hostSection);
		expect(hosts).toEqual(['secA', 'secB', 'secC']);
		expect(hosts).not.toContain('ownHier1');
	});

	test("step 2→3: the literal 'self' spec section falls through to the observer's own section", () => {
		const index = buildSubscriptionIndex(
			[
				node('ssrc1', { observers: [{ component_tipo: 'sobs1', section_tipo: 'self' }] }),
				node('sobs1', { observe: [{ component_tipo: 'ssrc1', server: EXTERNAL_SERVER }] }),
			],
			hostCtx({ sobs1: 'ownsec1' }),
		);
		expect(index.byObserved.get('ssrc1')?.[0]?.hostSection).toBe('ownsec1');
	});

	test('step 3 VIRTUAL↔REAL: a filter path naming the VIRTUAL face of the observer own REAL section resolves to the path face', () => {
		// vobs1's own ontology section is real276; its SQO filter path names
		// virt5, whose relations[0].tipo is real276 — same section, and the
		// PATH's face is the one the stored records carry, so it wins.
		const index = buildSubscriptionIndex(
			[node('vobs1', { observe: [{ component_tipo: 'vsrc1', server: sqoServer('virt5') }] })],
			hostCtx({ vobs1: 'real276' }, { virt5: 'real276', real276: 'real276' }),
		);
		expect(index.byObserved.get('vsrc1')?.[0]?.hostSection).toBe('virt5');
		expect(index.diagnostics.hostUnresolved).toEqual([]);
		expect(validateSubscriptionContract(index)).toEqual([]);
	});

	test('step 3 without a filter path: the observer own section is the host', () => {
		const index = buildSubscriptionIndex(
			[node('oobs1', { observe: [{ component_tipo: 'osrc1', server: EXTERNAL_SERVER }] })],
			hostCtx({ oobs1: 'ownsec2' }),
		);
		expect(index.byObserved.get('osrc1')?.[0]?.hostSection).toBe('ownsec2');
	});

	test('step 4: a NON-equivalent filter-path section resolves to NOTHING and is RED (never a silent retarget)', () => {
		const index = buildSubscriptionIndex(
			[node('xobs1', { observe: [{ component_tipo: 'xsrc1', server: sqoServer('othersec1') }] })],
			hostCtx({ xobs1: 'ownsec3' }, { othersec1: 'otherreal1', ownsec3: 'ownsec3' }),
		);
		expect(index.byObserved.get('xsrc1')?.[0]?.hostSection).toBeUndefined();
		expect(index.diagnostics.hostUnresolved).toEqual(['xsrc1->xobs1']);
		const errors = validateSubscriptionContract(index);
		expect(
			errors.some((e) => e.includes('unresolved host section') && e.includes("'xsrc1->xobs1'")),
		).toBe(true);
	});

	test('step 4: an SQO edge with no section facts at all is RED', () => {
		// No entry scope, no forward spec, no own-section knowledge, no path…
		const bare = buildSubscriptionIndex([
			node('bobs1', { observe: [{ component_tipo: 'bsrc1', server: { filter: { $and: [] } } }] }),
		]);
		expect(bare.diagnostics.hostUnresolved).toEqual(['bsrc1->bobs1']);
		// …while a non-SQO shape (filter:false / set_dato_external) needs no
		// host and stays clean.
		const nonSqo = buildSubscriptionIndex([
			node('bobs2', { observe: [{ component_tipo: 'bsrc2', server: { filter: false } }] }),
		]);
		expect(nonSqo.diagnostics.hostUnresolved).toEqual([]);
	});
});

describe('dead config is RED (no code pin can hide it)', () => {
	test('a forward spec with no observe entry at all is RED naming the edge', () => {
		const index = buildSubscriptionIndex([
			node('src2', { observers: [{ component_tipo: 'obs2' }] }),
			node('obs2', { observe: [{ component_tipo: 'unrelated1', server: { filter: false } }] }),
		]);
		expect(index.diagnostics.forwardOnly).toEqual(['src2->obs2']);
		const errors = validateSubscriptionContract(index);
		expect(errors.some((e) => e.includes("'src2->obs2'") && e.includes('dead config'))).toBe(true);
		// The observer's own reverse-only entry towards a THIRD tipo dispatches
		// fine — it is not the dead half.
		expect(index.diagnostics.reverseOnly).toEqual(['unrelated1->obs2']);
	});
});

describe('acyclicity of the declared graph', () => {
	test('a declared cycle is detected and RED', () => {
		const index = buildSubscriptionIndex([
			node('x1', {
				observers: [{ component_tipo: 'y1' }],
				observe: [{ component_tipo: 'y1', server: EXTERNAL_SERVER }],
			}),
			node('y1', {
				observers: [{ component_tipo: 'x1' }],
				observe: [{ component_tipo: 'x1', server: EXTERNAL_SERVER }],
			}),
		]);
		expect(index.diagnostics.cycles.length).toBeGreaterThan(0);
		const errors = validateSubscriptionContract(index);
		expect(errors.some((e) => e.includes('CYCLE'))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Law-derived edges (pass 3 — owner ruling 2026-10-30, Q1)
// ---------------------------------------------------------------------------

/** A covered source_overwrite observer: copies `dff` off the record `ptr` names. */
function overwriteObserver(
	tipo: string,
	dff: string,
	ptr: string,
	extra: Record<string, unknown> = {},
): NodeWithProperties {
	return node(tipo, {
		observe: [
			{
				component_tipo: ptr,
				server: {
					config: { use_observable_dato: true, use_self_section: true },
					perform: { function: 'set_dato_external' },
				},
			},
			...((extra.observe as unknown[] | undefined) ?? []),
		],
		source: { source_overwrite: { data_from_field: dff }, component_to_search: [ptr] },
	});
}

describe('law-derived edges (pass 3)', () => {
	test('a covered source_overwrite observer DERIVES an inverse edge from its data_from_field, through its pointer', () => {
		const index = buildSubscriptionIndex([overwriteObserver('so1', 'dff1', 'ptr1')]);
		const derived = index.byObserved.get('dff1') ?? [];
		expect(derived.length).toBe(1);
		expect(derived[0]).toMatchObject({
			observedTipo: 'dff1',
			observerTipo: 'so1',
			declaration: 'law-derived',
			origin: 'law',
			via: 'ptr1',
			viaWildcard: false,
		});
		// The inverse resolver, set_dato_external, and NO params: the kernel
		// needs none on this path (no references_limit, no save flag).
		expect(derived[0]?.entry).toEqual({
			component_tipo: 'dff1',
			server: {
				config: { use_inverse_relations: true },
				perform: { function: 'set_dato_external' },
			},
		});
		expect(entryServerBlock(derived[0]?.entry)).toBeDefined(); // dispatchable
		expect(index.diagnostics.lawDerived).toEqual(['dff1->so1']);
		expect(index.diagnostics.lawShadowed).toEqual([]);
		// A derived edge carries no authored observe entry — the observe-entry
		// contract checks do not apply, so the build is contract-clean.
		expect(validateSubscriptionContract(index)).toEqual([]);
		// The declared pointer edge is still there, unchanged.
		expect(index.byObserved.get('ptr1')?.[0]?.declaration).toBe('reverse-only');
		expect(index.byObserved.get('ptr1')?.[0]?.origin).toBe('declared');
	});

	test('a DECLARED server edge on the same key wins — the derived one is shadowed, never doubled', () => {
		const index = buildSubscriptionIndex([
			overwriteObserver('so2', 'dff2', 'ptr2', {
				observe: [
					{
						component_tipo: 'dff2',
						server: {
							config: { use_inverse_relations: true },
							perform: { function: 'set_dato_external' },
						},
					},
				],
			}),
		]);
		const edges = index.byObserved.get('dff2') ?? [];
		expect(edges.length).toBe(1);
		expect(edges[0]?.declaration).toBe('reverse-only');
		expect(edges[0]?.origin).toBe('declared');
		expect(index.diagnostics.lawDerived).toEqual([]);
		expect(index.diagnostics.lawShadowed).toEqual(['dff2->so2']);
	});

	test('a CLIENT-ONLY observe entry on the dependency is the per-edge kill switch (no server edge at all)', () => {
		const index = buildSubscriptionIndex([
			overwriteObserver('so3', 'dff3', 'ptr3', {
				observe: [{ component_tipo: 'dff3', client: { event: 'update_value' } }],
			}),
		]);
		expect(index.byObserved.get('dff3') ?? []).toEqual([]);
		expect(index.diagnostics.lawShadowed).toEqual(['dff3->so3']);
		expect(index.diagnostics.lawDerived).toEqual([]);
	});

	test('a FORWARD spec on the same key also wins (any declaration shadows the derivation)', () => {
		const index = buildSubscriptionIndex([
			node('dff4', { observers: [{ component_tipo: 'so4' }] }),
			overwriteObserver('so4', 'dff4', 'ptr4'),
		]);
		expect((index.byObserved.get('dff4') ?? []).some((sub) => sub.origin === 'law')).toBe(false);
		expect(index.diagnostics.lawShadowed).toEqual(['dff4->so4']);
	});

	test('one derived edge per key — a node listed twice does not mint two', () => {
		const observer = overwriteObserver('so5', 'dff5', 'ptr5');
		const index = buildSubscriptionIndex([observer, observer]);
		expect((index.byObserved.get('dff5') ?? []).filter((sub) => sub.origin === 'law').length).toBe(
			1,
		);
		expect(index.diagnostics.lawDerived).toEqual(['dff5->so5']);
	});

	test('law (c) and observed_data declare NO dependencies — pass 3 never mints an edge per data_from_field node', () => {
		const index = buildSubscriptionIndex([
			node('lawc1', {
				observe: [{ component_tipo: 'ptrc', server: EXTERNAL_SERVER }],
				source: { component_to_search: ['refc'], data_from_field: ['dffc'] },
			}),
			node('od1', {
				observe: [
					{ component_tipo: 'txt1', server: { perform: { function: 'set_dato_external' } } },
				],
				source: {
					set_observed_data: [
						{
							tipo: 'txt1',
							perform: { function: 'get_locators_of_tags', params: { ar_tags: ['svg'] } },
						},
					],
				},
			}),
		]);
		expect(index.byObserved.get('dffc') ?? []).toEqual([]);
		expect(index.edges.every((sub) => sub.origin !== 'law')).toBe(true);
		expect(index.diagnostics.lawDerived).toEqual([]);
	});

	test('a law the author never wired to the kernel (no set_dato_external server entry) derives nothing', () => {
		const index = buildSubscriptionIndex([
			node('so6', {
				observe: [{ component_tipo: 'ptr6', client: { event: 'update_value' } }],
				source: { source_overwrite: { data_from_field: 'dff6' }, component_to_search: ['ptr6'] },
			}),
			// and a refused (malformed) sub-law next to a covered entry
			node('so7', {
				observe: [{ component_tipo: 'ptr7', server: EXTERNAL_SERVER }],
				source: { source_overwrite: { data_from_field: 42 }, component_to_search: ['ptr7'] },
			}),
		]);
		expect(index.byObserved.get('dff6') ?? []).toEqual([]);
		expect(index.edges.every((sub) => sub.origin !== 'law')).toBe(true);
		expect(index.diagnostics.lawDerived).toEqual([]);
	});

	test('derived edges take part in the cycle scan (a derived cycle is a real runtime cycle)', () => {
		const index = buildSubscriptionIndex([
			overwriteObserver('so8', 'dff8', 'ptr8'),
			// dff8 observes so8: so8 → dff8 declared, dff8 → so8 derived.
			node('dff8', { observe: [{ component_tipo: 'so8', server: EXTERNAL_SERVER }] }),
		]);
		expect(index.diagnostics.lawDerived).toEqual(['dff8->so8']);
		expect(index.diagnostics.cycles.length).toBeGreaterThan(0);
		expect(validateSubscriptionContract(index).some((error) => error.includes('CYCLE'))).toBe(true);
	});
});

describe('index immutability', () => {
	test('the built index is deep-frozen (rebuild on invalidation, never patch)', () => {
		const index = buildSubscriptionIndex([
			node('fsrc1', { observers: [{ component_tipo: 'fobs1' }] }),
			node('fobs1', { observe: [{ component_tipo: 'fsrc1', server: { filter: false } }] }),
		]);
		expect(Object.isFrozen(index)).toBe(true);
		expect(Object.isFrozen(index.edges)).toBe(true);
		expect(Object.isFrozen(index.edges[0])).toBe(true);
		expect(Object.isFrozen(index.edges[0]?.entry)).toBe(true);
		expect(Object.isFrozen(index.diagnostics)).toBe(true);
		// Maps are RUNTIME-hardened, not just ReadonlyMap-typed: Object.freeze
		// does not seal Map internals, so the mutators are shadowed to throw
		// (a consumer casting past the types could otherwise patch the
		// process-shared index in place).
		const patchable = index.byObserved as unknown as Map<string, unknown>;
		expect(() => patchable.set('x', [])).toThrow(/immutable/);
		expect(() => patchable.delete('fsrc1')).toThrow(/immutable/);
		expect(() => patchable.clear()).toThrow(/immutable/);
		const wc = index.diagnostics.wildcardCompiled as unknown as Map<string, unknown>;
		expect(() => wc.set('x', [])).toThrow(/immutable/);
		// Reads keep their prototype behaviour.
		expect(index.byObserved.get('fsrc1')?.length).toBe(1);
	});
});

describe('wiring tripwires (DEC-12: header claims are gated, not prose)', () => {
	const read = (relativePath: string): string =>
		readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');

	test('server.ts warms the registry at boot and registers the observers_registry gauge', () => {
		// The boot probe is the PRODUCTION coverage locus ("read once at bun
		// start"): edges authored only in a production ontology surface there,
		// never in CI. Deleting the block or renaming the gauge must turn RED.
		const src = read('../../src/server.ts');
		expect(src).toContain("registerOpsGauge('observers_registry'");
		expect(src).toContain('await getSubscriptionRegistry(); // warm');
	});

	test('the seed-race build token is planted BEFORE the ontology reads and gates the cache seed', () => {
		// The header's seed-race law (a dd_ontology COMMIT between the builder's
		// reads and its cache write must prevent seeding) is carried by three
		// source facts, in this order: token plant → ontology reads → seed
		// guarded by token survival. A mid-build interposition cannot be staged
		// without cross-file mock leakage, so the ORDER is the mechanical gate.
		const src = read('../../src/core/section/record/observer_subscriptions.ts');
		const plant = src.indexOf('buildTokenCache.set(BUILD_TOKEN_KEY, buildToken)');
		const firstOntologyRead = src.indexOf("await getNodesWithProperty('observers')");
		const survivalGuard = src.indexOf('buildTokenCache.get(BUILD_TOKEN_KEY) === buildToken');
		const cacheSeed = src.indexOf('registryCache.set(REGISTRY_KEY, index)');
		expect(plant).toBeGreaterThan(-1);
		expect(firstOntologyRead).toBeGreaterThan(plant);
		expect(survivalGuard).toBeGreaterThan(firstOntologyRead);
		expect(cacheSeed).toBeGreaterThan(survivalGuard);
	});
});

// ---------------------------------------------------------------------------
// DB-backed half — the LIVE ontology of the suite DB.
// ---------------------------------------------------------------------------

/** The dead-forward census (measured 2026-08-02; rsc1531 exists only in the
 * suite-DB ontology snapshot, the rsc19 four in both DBs). A NEW dead forward
 * spec — one not in this census — fails the live-contract gate the day it is
 * authored. Fixing these means an ONTOLOGY edit (add the observe half or
 * delete the stale spec), never a code pin. */
/**
 * The INSTALL ontology's censuses, READ FROM DATA
 * (fixtures/observer_subscriptions/install_census.json). They used to be typed
 * here, which bound this gate to one installation two ways: the census counted
 * the tipos as bindings, and the assertions demanded that ontology be PRESENT —
 * an exact-set equality that fails on any other database, including a fresh
 * install. The pins are still enforced, but as "present ⇒ pinned", never
 * "pinned ⇒ present".
 */
const INSTALL_CENSUS = installCensusJson as {
	reverse_only: string[];
	dead_forward: string[];
	wildcards_install: Record<string, string[]>;
	single_declaration_install: { observed: string; observer: string; host: string };
	reused_component_install: {
		observed: string;
		observer: string;
		hosts: string[];
		not_host: string;
	};
	runtime_dispatch_install: { observed: string; host_section: string; observer: string };
	virtual_real_pair_install: {
		observed: string;
		observers: string[];
		host: string;
		own_real_section: string;
	};
};
const KNOWN_DEAD_FORWARD = new Set(INSTALL_CENSUS.dead_forward);

/** The install half of the reverse-only census (data — see INSTALL_CENSUS). */
const KNOWN_REVERSE_ONLY = INSTALL_CENSUS.reverse_only;

/**
 * The reverse-only declarations the GENERIC `test` TLD ontology adds (measured
 * 2026-08-19, generic-`test`-TLD migration phase 2). Every one of them is a
 * verbatim CLONE of an install declaration — `test6840` is `oh28`, the
 * `test*1036` twenty-two are the `hierarchy93` autocomplete of each cloned
 * thesaurus — which is why they are pinned SEPARATELY from the install census
 * above instead of being folded into it: the two halves have different owners.
 * A new entry here means the clone map grew (it is append-only), and the
 * provenance test below refuses an entry whose observer is not actually a
 * clone, so this list cannot be padded by hand to silence a real new edge.
 */
const KNOWN_REVERSE_ONLY_TEST_TLD = [
	`${seed('rsc', 19)}->test2850`,
	`${seed('rsc', 19)}->test6840`,
	`${seed('rsc', 387)}->testaa1036`,
	`${seed('rsc', 387)}->testcont1036`,
	`${seed('rsc', 387)}->testcult1036`,
	`${seed('rsc', 387)}->testculture1036`,
	`${seed('rsc', 387)}->testeventype1036`,
	`${seed('rsc', 387)}->testgrup1036`,
	`${seed('rsc', 387)}->testicon1036`,
	`${seed('rsc', 387)}->testperi1036`,
	`${seed('rsc', 387)}->testrespathology1036`,
	`${seed('rsc', 387)}->testsccmk1036`,
	`${seed('rsc', 387)}->testscell1036`,
	`${seed('rsc', 387)}->testsclat1036`,
	`${seed('rsc', 387)}->testscsym1036`,
	`${seed('rsc', 387)}->testsctxr1036`,
	`${seed('rsc', 387)}->testscxibm1036`,
	`${seed('rsc', 387)}->testscxibo1036`,
	`${seed('rsc', 387)}->testscxpu1036`,
	`${seed('rsc', 387)}->testseri1036`,
	`${seed('rsc', 387)}->testtema1036`,
	`${seed('rsc', 387)}->testterr1036`,
	`${seed('rsc', 387)}->testuncertainty1036`,
	`${seed('rsc', 387)}->testunit1036`,
	`${seed('rsc', 860)}->test6883`,
	'test1222->test1229',
	'test1222->test1230',
	'test1224->test1225',
	'test1226->test1225',
	'test1227->test1229',
	'test1228->test1230',
	'test3030->test2850',
	'test4345->test4346',
	'test4346->test4822',
	'test4471->test4473',
	'test4472->test4473',
	'test4821->test4822',
	'test6318->testplace1022',
	'test6669->testplace1065',
	'test6669->testplace1066',
	'test6889->test6840',
	'test7310->test7339',
	'test7311->test7340',
];

/** Scratch id for the end-to-end reverse-only recompute (oh1 record that does
 * not exist — the same-record recompute writes ONE TM row, swept below). */
const SCRATCH_OH1_ID = 999_999_955;

afterAll(async () => {
	await sql.unsafe(
		`DELETE FROM matrix_time_machine WHERE section_tipo = $2 AND section_id = $1 AND tipo = ($3::text)`,
		[
			SCRATCH_OH1_ID,
			INSTALL_CENSUS.runtime_dispatch_install.host_section,
			INSTALL_CENSUS.runtime_dispatch_install.observer,
		],
	);
});

describe('live-ontology gates (suite DB)', () => {
	test('the contract holds: the ONLY violations are the known dead-forward specs (ontology bugs, loud until fixed)', async () => {
		const registry = await getSubscriptionRegistry();
		const errors = validateSubscriptionContract(registry);
		// Every violation is a dead-config one naming a censused edge…
		for (const error of errors) {
			expect(error).toContain('dead config');
			expect([...KNOWN_DEAD_FORWARD].some((key) => error.includes(`'${key}'`))).toBe(true);
		}
		// …and the census covers exactly what this ontology declares dead.
		const declaredDead = registry.diagnostics.forwardOnly;
		expect(declaredDead.every((key) => KNOWN_DEAD_FORWARD.has(key))).toBe(true);
		expect(errors.length).toBe(declaredDead.length);
		// Nothing else is wrong on the live ontology.
		expect(registry.diagnostics.deadWildcards).toEqual([]);
		expect(registry.diagnostics.hostUnresolved).toEqual([]);
		expect(registry.diagnostics.cycles).toEqual([]);
	});

	test('LAW-DERIVED (pass 3, live): the catalog term copy observer derives its type-side edge; the declared one shadows', async () => {
		// The suite twins of the reported bug: the catalog term's two
		// source_overwrite copies of its coin type (pointer testcoincatalog1004).
		// testcoincatalog1013 copies test6157 and declares NO edge on it — derived;
		// testcoincatalog1019 copies test6105 and DECLARES the inverse edge — the
		// declaration wins (no second edge).
		const registry = await getSubscriptionRegistry();
		expect(registry.diagnostics.lawDerived).toContain('test6157->testcoincatalog1013');
		expect(registry.diagnostics.lawShadowed).toContain('test6105->testcoincatalog1019');
		const derived = (registry.byObserved.get('test6157') ?? []).filter(
			(sub) => sub.observerTipo === 'testcoincatalog1013',
		);
		expect(derived.length).toBe(1);
		expect(derived[0]).toMatchObject({
			declaration: 'law-derived',
			origin: 'law',
			via: 'testcoincatalog1004',
		});
		expect(
			(registry.byObserved.get('test6105') ?? []).filter(
				(sub) => sub.observerTipo === 'testcoincatalog1019' && sub.origin === 'law',
			),
		).toEqual([]);
		// The consumers that read getObserverSubscriptions see the derived edge
		// with no change on their side (critique 11): the write ledger's
		// observed-tipo gate and the cascade's leaf pre-gate both count it.
		const { getObserverSubscriptions } = await import(
			'../../src/core/section/record/observer_subscriptions.ts'
		);
		expect(
			(await getObserverSubscriptions('test6157')).some(
				(sub) => sub.observerTipo === 'testcoincatalog1013' && sub.origin === 'law',
			),
		).toBe(true);
		const { isObservedTipo } = await import('../../src/core/section_record/obligation_ledger.ts');
		expect(await isObservedTipo('test6157')).toBe(true);
	});

	test('SINGLE-DECLARATION (gate a, live): the reported bug edge is dispatchable, host = the observer own section', async () => {
		const registry = await getSubscriptionRegistry();
		// THE GENERIC TWIN IS THE SUBJECT: `test6840` is the phase-2 clone of the
		// install component this bug was reported on, hosted by the clone of its
		// section. It is present wherever the suite runs, so the 4-step host
		// resolution is asserted unconditionally here.
		const twin = (registry.byObserved.get(seed('rsc', 19)) ?? []).find(
			(candidate) => candidate.observerTipo === 'test6840',
		);
		expect(twin, 'the cloned reverse-only edge must be registered').toBeDefined();
		expect(twin?.hostSection).toBe('test6813');
		// The INSTALL edge is checked only where that ontology exists: a database
		// carrying a different installation is not a regression.
		const install = INSTALL_CENSUS.single_declaration_install;
		const sub = (registry.byObserved.get(install.observed) ?? []).find(
			(candidate) => candidate.observerTipo === install.observer,
		);
		expect(sub).toBeDefined();
		expect(sub?.declaration).toBe('reverse-only');
		expect(sub?.entry?.server).toBeDefined(); // dispatches — no table gates it
		// 4-step resolution: no entry scope, no forward spec → the observer's own
		// section, agreeing with the filter path.
		if (sub !== undefined) expect(sub.hostSection).toBe(install.host);
	});

	test('the reverse-only census: every measured one-sided declaration is registered (and dispatches)', async () => {
		const registry = await getSubscriptionRegistry();
		const measured = [...registry.diagnostics.reverseOnly].sort();
		// THE GENERIC HALF IS EXACT: those nodes come from the repo-owned `test`
		// ontology, so they are present wherever the suite runs and a new one must
		// be pinned.
		// The OBSERVER side decides: a generic declaration is one the repo-owned
		// `test` ontology adds, and several of them are `<seed observed>-><test
		// observer>` clones (rsc387 -> test*1036), so splitting on the left-hand
		// side would file them under the install.
		const observerOf = (key: string): string => key.split('->')[1] ?? '';
		const generic = measured.filter((key) => observerOf(key).startsWith('test'));
		expect(generic).toEqual([...KNOWN_REVERSE_ONLY_TEST_TLD].sort());
		// THE INSTALL HALF IS "PRESENT ⇒ PINNED": whatever installation this
		// database carries, every one-sided declaration it declares must be in the
		// census — but carrying NONE of them is a different install, not a
		// regression. (Exact-set equality here made the gate pass on one machine
		// and fail everywhere else.)
		const ambient = measured.filter((key) => !observerOf(key).startsWith('test'));
		const pinned = new Set(KNOWN_REVERSE_ONLY);
		expect(ambient.filter((key) => !pinned.has(key))).toEqual([]);
		// And the virtual↔real pair resolved: the observers' own section is the
		// REAL one while the filter path names the VIRTUAL face — equivalent, and
		// the path face wins (that is where the records live). Install data, so
		// asserted only where that ontology is present; the LAW itself is pinned
		// unit-side in the "step 3 VIRTUAL↔REAL" case above, on a built fixture.
		const pair = INSTALL_CENSUS.virtual_real_pair_install;
		for (const observer of pair.observers) {
			const sub = (registry.byObserved.get(pair.observed) ?? []).find(
				(candidate) => candidate.observerTipo === observer,
			);
			if (sub !== undefined) expect(sub.hostSection).toBe(pair.host);
		}
	});

	test('REUSED COMPONENT (gate d, live): a reused observer keeps each forward-spec host, never its own section', async () => {
		const registry = await getSubscriptionRegistry();
		// GENERIC: the cloned thesauri each declare the same reused autocomplete,
		// so the reuse law is asserted on nodes the repo owns. Every host is a
		// cloned thesaurus, and none is the observer's own section.
		const clonedHosts = (registry.byObserved.get(seed('rsc', 387)) ?? [])
			.filter((sub) => sub.observerTipo.startsWith('test'))
			.map((sub) => sub.hostSection);
		expect(clonedHosts.length).toBeGreaterThan(1);
		expect(clonedHosts.every((host) => (host ?? '').startsWith('test'))).toBe(true);
		expect(clonedHosts).not.toContain(seed('hierarchy', 20));
		// INSTALL: same law, asserted only where that ontology is present.
		const install = INSTALL_CENSUS.reused_component_install;
		const hosts = (registry.byObserved.get(install.observed) ?? [])
			.filter((sub) => sub.observerTipo === install.observer)
			.map((sub) => sub.hostSection);
		if (hosts.length > 0) {
			expect([...hosts].sort()).toEqual([...install.hosts].sort());
			expect(hosts).not.toContain(install.not_host);
		}
	});

	test("'all' wildcards compile to their forward-declarers only (gate b, live)", async () => {
		const registry = await getSubscriptionRegistry();
		// The GENERIC wildcards — repo-owned, present wherever the suite runs, so
		// these are the ones that must be there. Each is the phase-2 clone of an
		// install wildcard; `testimmovable1002` is the twin of a wildcard the
		// suite database never carried at all, which is now exercised for the
		// first time BECAUSE it was cloned.
		const expectedGeneric: Record<string, string[]> = {
			testimmovable1000: ['test6318->testimmovable1000'],
			testimmovable1001: ['testplace1049->testimmovable1001'],
			testimmovable1002: ['testheritagecatalog1110->testimmovable1002'],
		};
		// The INSTALL wildcards are DATA and OPTIONAL: whichever installation this
		// database carries, a wildcard it declares must match the census — but
		// carrying none of them is a different install, not a regression.
		const expected: Record<string, string[]> = {
			...expectedGeneric,
			...INSTALL_CENSUS.wildcards_install,
		};
		const mirrored = new Set(registry.diagnostics.mirroredServer);
		for (const [observer, compiled] of registry.diagnostics.wildcardCompiled) {
			// Every compiled wildcard edge is a MIRRORED edge (forward-declared) —
			// the wildcard never invents subscriptions.
			for (const key of compiled) expect(mirrored.has(key)).toBe(true);
			// And the compiled set matches the pinned census exactly.
			expect(expected[observer]).toBeDefined();
			expect([...compiled].sort()).toEqual([...(expected[observer] ?? [])].sort());
		}
		// Every GENERIC wildcard must be present — that is the anti-vacuity floor,
		// and it no longer depends on which installation the database holds.
		for (const observer of Object.keys(expectedGeneric)) {
			expect(
				registry.diagnostics.wildcardCompiled.has(observer),
				`${observer}: the cloned wildcard must compile`,
			).toBe(true);
		}
	});

	test('the test-TLD census is CLONE-DERIVED: every pinned entry observes a phase-2 clone', () => {
		// The guard that keeps KNOWN_REVERSE_ONLY_TEST_TLD from becoming a
		// dumping ground: an entry is admissible only when its OBSERVER tipo is
		// a target of the committed, append-only clone map. An invented edge —
		// or a real new install edge typed into the wrong list — has no source
		// and fails here.
		const cloneTargets = new Set(
			Object.values((cloneMapJson as { map: Record<string, { target: string }> }).map).map(
				(entry) => entry.target,
			),
		);
		const notClones = KNOWN_REVERSE_ONLY_TEST_TLD.filter(
			(key) => !cloneTargets.has(key.split('->')[1] as string),
		);
		expect(notClones).toEqual([]);
	});

	test('lifecycle: in-tx builds memoize per TRANSACTION and never seed the shared cache (S1-14 + import fix)', async () => {
		clearObserverSubscriptionRegistry();
		let first: unknown;
		let second: unknown;
		await withTransaction(async () => {
			// Read-only: the transaction only READS dd_ontology through the
			// registry build; nothing is written.
			first = await getSubscriptionRegistry();
			second = await getSubscriptionRegistry();
		});
		// One build per transaction span (the cold-cache import pathology fix:
		// pre-remediation every in-tx call rebuilt the whole index).
		expect(second).toBe(first);
		// The in-tx build never seeded the process-wide cache (S1-14)…
		const outside = await getSubscriptionRegistry();
		expect(outside).not.toBe(first);
		// …and the out-of-tx build-of-record did.
		expect(await getSubscriptionRegistry()).toBe(outside);
	});

	test('runtime (gate a, end-to-end): a reverse-only edge DISPATCHES and writes its TM row', async () => {
		// The observed declares NO forward observers; the observer subscribes
		// reverse-only with server:{filter:false} (component_state = component_info
		// alias → the same-record recompute). Under forward-only discovery this
		// edge was invisible; under the ontology-decided rule the save response
		// carries the recomputed widget item and ONE TM row is written (scratch id,
		// swept in afterAll).
		//
		// Driven on the INSTALL edge when that ontology is present, and SKIPPED —
		// loudly, never silently — when it is not: the generic twin of this pair
		// has no records section of its own to save into, so there is nothing to
		// dispatch on. The registry-level twin is asserted by the
		// SINGLE-DECLARATION case above; what is install-only here is the runtime
		// leg.
		const install = INSTALL_CENSUS.runtime_dispatch_install;
		const registry = await getSubscriptionRegistry();
		const declared = (registry.byObserved.get(install.observed) ?? []).some(
			(candidate) => candidate.observerTipo === install.observer,
		);
		if (!declared) {
			console.warn(
				`observer_subscriptions_native: runtime dispatch NOT RUN — this database declares no '${install.observed}' → '${install.observer}' edge (a different installation).`,
			);
			return;
		}
		const result = await propagateToObservers(
			install.observed,
			install.host_section,
			SCRATCH_OH1_ID,
			{ saved: [], removed: [] },
			-1,
		);
		expect(result).toHaveLength(1);
		const item = result[0] as {
			tipo?: string;
			section_tipo?: string;
			section_id?: string | number;
		};
		expect(item.tipo).toBe(install.observer);
		expect(item.section_tipo).toBe(install.host_section);
		// WC-2026-08-10-section-id-int-canonical: the recomputed item's address
		// is emitted int (observers.ts canonicalizeStoredSectionId).
		expect(item.section_id).toBe(SCRATCH_OH1_ID);
		const tmRows = (await sql.unsafe(
			`SELECT 1 FROM matrix_time_machine WHERE section_tipo = $2 AND section_id = $1 AND tipo = ($3::text)`,
			[SCRATCH_OH1_ID, install.host_section, install.observer],
		)) as unknown[];
		expect(tmRows.length).toBeGreaterThan(0);
	});

	test('runtime: the hi-family reverse-only filter:false edges dispatch into the terminal no-op (nothing written)', async () => {
		// The hi-family pair (autocomplete_hi, filter:false): dispatch
		// reaches the entries (no skip filter exists any more) and lands on the
		// oracle-pinned terminal no-op — the response stays empty and no error
		// is thrown.
		const result = await propagateToObservers(
			seed('rsc', 36),
			seed('rsc', 1),
			999_999_991,
			{ saved: [], removed: [] },
			-1,
		);
		expect(result).toEqual([]);
	});
});
