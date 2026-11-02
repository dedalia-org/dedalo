/**
 * D1 (TRIGGER RELAY) + D2 (BOUNDED CASCADE) gates — DEC-12 twins of the
 * relay branch and the guarded transitive dispatch in
 * src/core/section/record/observers.ts, plus the W11 lock pin on
 * src/core/relations/save.ts deletePortalLocator.
 *
 * THE LAW (PHP v6 class.component_common.php:1651-1660 → Save() :1306 →
 * propagate_to_observers :1372): the DEFAULT observer branch (no `perform`,
 * observer not an info model) reads the observer's value, sets
 * observable_dato = the value WITH REFERENCES and re-SAVES the observer
 * purely to re-enter propagation — a dependency EDGE (numisdata161 →
 * numisdata36 → numisdata77; tch241 → tch40 → tch33). PHP's recursion is
 * UNGUARDED (no visited set, no depth budget — a cyclic observe graph
 * infinite-loops it). TS: write:'none' relay + an UNCONDITIONAL visited-set/
 * depth-budget dispatch — the DEDALO_OBSERVER_CASCADE rollout flag was
 * RETIRED 2026-08-02 the day the benchmark cleared the cascade (typical
 * external hop p50 1.3ms, worst real case 22ms, measured graph depth ≤ 2,
 * zero cycles): declared observer edges are ontology-declared STORED data
 * and always fire. Hops go post-commit through the W12 commit-only lane,
 * never inside an ambient transaction (B6). Divergence ledger:
 * WC-2026-08-02-observer-relay-writes-nothing,
 * WC-2026-08-02-observer-cascade-bounded-flag.
 *
 * Gates:
 *   1. THE CASCADE FIRES FOR A DECLARED EDGE, unconditionally: the planted
 *      2-hop chain (A saves → relay B → B's observer C recomputes)
 *      CONVERGES — C's mirror lands at the target AND at the relay payload's
 *      equivalent, while the RELAY ITSELF writes NOTHING (B's bag
 *      byte-unchanged, zero TM rows for B);
 *   2. planted CYCLE (X ↔ Y relay ring) terminates LOUDLY —
 *      observers_cascade_cycle_refused counted, no hang;
 *   3. the depth budget (MAX_CASCADE_DEPTH, pinned at 8 — a backstop over
 *      the measured depth-≤2 graph) refuses the over-budget hop LOUDLY —
 *      observers_cascade_depth_exceeded counted, cycle counter untouched;
 *   4. a write inside an ambient transaction propagates after COMMIT, never
 *      inside it (the chokepoint's obligation ledger, CLOSURE_PLAN Step 2):
 *      ROLLBACK discards it (no mirror), COMMIT fires it (mirror lands);
 *   5. runObserverCascadeHop REFUSES an ambient transaction (throw naming
 *      the chain — B6);
 *   6. W11 pins: deletePortalLocator runs its read-modify-write under
 *      withTransaction + FOR UPDATE with the zero-row guard (a lock that
 *      matched no row never proceeds to the read), and two CONCURRENT
 *      removals on one record both survive (no lost update);
 *   7. a CONVERGED DIAMOND (same node via two branches) is deduped as
 *      benign (observers_cascade_converged_skipped), NOT counted a cycle;
 *   8. recompute hops fire ONLY after a REAL persist (wrote:true) — a
 *      converged (no-drift) recompute never re-propagates;
 *   9. the relay payload is the value WITH REFERENCES: a dd621 relay's
 *      transitive closure target receives the mirror too (the payload never
 *      degrades to the stored bag);
 *  10. a leaked continuation (S2-14 class) whose commit lane already closed
 *      DROPS the hop loudly (observers_cascade_hop_dropped) — never silently;
 *  11. propagation REFUSES to run inside a transaction (B6 — the ledger drains
 *      post-commit, so an in-transaction call is a caller bug, thrown before
 *      anything runs); a level-0 failure outside one is swallowed and counted.
 *  12. THE DEFAULT BRANCH, GENERALIZED (portal order model, 2026-10-31 — dated
 *      addendum on WC-2026-08-02-observer-relay-writes-nothing): the relay
 *      re-saves its observer through the observer's OWN save rules and writes
 *      only on a difference — gate 1 is the identity case (still nothing
 *      written); a declared-order portal observer holding an unsorted array is
 *      re-written sorted with exactly one TM row, then the relay hops on; a
 *      no-`perform` `use_inverse_relations` edge reaches the branch (no
 *      observers_server_shape_not_covered) and relays to the inverse hosts; the
 *      re-save is bounded by maxDepth and the visited set (a planted ring with a
 *      declared-order portal terminates, counted, the host written once); a
 *      target section that does not host the observer is skipped; and the
 *      re-save's dedup namespace (`resaved`) is not the mirror recompute's
 *      (`recomputed`) — a declared-order mirror gets BOTH, in either order.
 *
 * Scratch hygiene: ontology nodes in the test9992x band (tld 'test' — swept
 * BEFORE seeding, residue-tolerant); matrix_test rows in the
 * 99999993x/99999994x id bands on the two scratch SECTIONS this file builds;
 * TM rows swept by tipo band + record band. Suite DB only — never the app DB.
 */
// Migrated to the generic `test` TLD 2026-08-20 (AGENTS.md hard rules). The two
// install SECTION carriers are gone: the term section `on1` (matrix_hierarchy,
// seeded by test/helpers/observer_term_seed.ts) and the referencer section
// `rsc205` (matrix) are now TERM_SECTION/REF_SECTION — scratch `section` nodes
// this file builds itself, each carrying the `test24` matrix_table relation so
// every record lands in `matrix_test` (which the relation-index trigger covers,
// verified 2026-08-20). The seed portal `rsc387` the W11 gates drive became the
// scratch component W11_PORTAL. The observer COMPONENT tipos stay in the
// `test999…` band on purpose: it is the scratch namespace
// observer_subscriptions.ts `touchesScratchObserverNamespace` excludes from the
// contract diagnostics, so renaming them would redden the registry gate.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getCounters } from '../../src/core/api/counters.ts';
import { sql, withTransaction } from '../../src/core/db/postgres.ts';
import { recordTimeMachine } from '../../src/core/db/time_machine.ts';
import { dbTimestamp } from '../../src/core/section/record/create_record.ts';
import {
	type CascadeGuard,
	emitCascadeHop,
	MAX_CASCADE_DEPTH,
	propagateToObservers,
	recomputeMirrorAndHop,
	resaveObserverThroughSaveRules,
	runObserverCascadeHop,
} from '../../src/core/section/record/observers.ts';
import { persistRecordKeys } from '../../src/core/section_record/index.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..');

// ---------------------------------------------------------------------------
// The two SCRATCH SECTIONS this file builds (2026-08-20 migration). Both carry
// the `test24` matrix_table relation, so both store in `matrix_test` — the one
// table every scratch record below is written to and read from.
// ---------------------------------------------------------------------------
/** The TERM section — the relay/mirror targets (was the install thesaurus `on1`). */
const TERM_SECTION = 'test999290';
/** The REFERENCER section — the records holding OBSERVED (was the install `rsc205`). */
const REF_SECTION = 'test999291';
/** The portal component the W11 removal door drives (was the seed `rsc387`). */
const W11_PORTAL = 'test999293';
/** Where both scratch sections store — the `test24` matrix_table term. */
const SCRATCH_TABLE = 'matrix_test';

// ---------------------------------------------------------------------------
// Scratch bands (distinct from observer_failsafe test9990x and
// observer_seed test9991x / 9108x / 84000xx).
// ---------------------------------------------------------------------------
const OBSERVED = 'test99920'; // the saved component (REF_SECTION)
const RELAY = 'test99921'; // relay observer (component_relation_related dd621, TERM_SECTION)
const MIRROR = 'test99922'; // set_dato_external observer (TERM_SECTION)
const FOURTH = 'test99923'; // observes MIRROR — no component_to_search (counted skip = hop detector)
const DIAMOND_OBS = 'test99924'; // the diamond's saved component
const CYCLE_X = 'test99925';
const CYCLE_Y = 'test99926';
const RELAY_P = 'test99927'; // diamond branch 1
const RELAY_Q = 'test99928'; // diamond branch 2
const RELAY_R = 'test99929'; // the converged node (reached via P AND Q)
const BROKEN_TABLE_NODE = 'test999298'; // matrix_table term → a nonexistent table
const BROKEN_SECTION = 'test999299'; // section whose matrix table does not exist (deterministic SQL error)

const TERM_A = 999999931; // TERM_SECTION — relay target
const TERM_EQUIV = 999999932; // TERM_SECTION — carried in the relay payload (B's bag)
const CYCLE_TERM = 999999933; // TERM_SECTION — the X ↔ Y ring record
const TERM_TX = 999999934; // TERM_SECTION — the ambient-tx (commit-lane) target
const REF_A = 999999935; // REF_SECTION — references TERM_A through OBSERVED
const REF_EQUIV = 999999936; // REF_SECTION — references TERM_EQUIV through OBSERVED
const REF_TX = 999999937; // REF_SECTION — references TERM_TX through OBSERVED
const TERM_ON = 999999938; // TERM_SECTION — the wrote-gate target
const REF_ON = 999999939; // REF_SECTION — references TERM_ON through OBSERVED
const W11_RECORD = 999999940; // REF_SECTION — the concurrent-delete record
const DIAMOND_TERM = 999999943; // TERM_SECTION — the diamond record (P and Q bags both point here)
const TERM_TRANSITIVE = 999999944; // TERM_SECTION — reachable ONLY through the dd621 closure (TERM_EQUIV's bag)
const REF_TRANSITIVE = 999999945; // REF_SECTION — references TERM_TRANSITIVE through OBSERVED
const REF_NONHOST = 999999946; // REF_SECTION — holds a MIRROR slot REF_SECTION does not declare (8b)

// ---------------------------------------------------------------------------
// Gate 12 — the generalized DEFAULT branch (portal order model). Its own nodes
// (test99927x/test999280, inside the swept test9992% band) and records.
// ---------------------------------------------------------------------------
const REF_LIT = 'test999270'; // component_input_text on REF_SECTION — the ordering column
const ORD_SRC = 'test999271'; // the saved component whose relay reaches ORD_PORTAL
const ORD_PORTAL = 'test999272'; // declared-order portal (TERM_SECTION) — a RELAY observer of ORD_SRC
const ORD_DETECT = 'test999273'; // observes ORD_PORTAL, no component_to_search: its counted skip = the hop detector
const INV_SRC = 'test999274'; // saved on a TERM record; INV_OBS observes it through the inverse resolver
const INV_OBS = 'test999275'; // no-perform use_inverse_relations observer (REF_SECTION)
const INV_DETECT = 'test999276'; // observes INV_OBS — the inverse relay's hop detector
const RING_A = 'test999277'; // declared-order portal in a relay RING with RING_B
const RING_B = 'test999278';
const ORD_MIRROR = 'test999279'; // a set_dato_external MIRROR that ALSO declares an order
const ORD_MIRROR_SRC = 'test999280'; // what ORD_MIRROR observes (never saved: the mirror is driven directly)

// The three ids run AGAINST their value order (Bravo < Charlie < Alpha): a
// declared-order array in VALUE order is never also in section_id order (either
// direction), so a ranking that fell back to id order reds the gate-12 legs.
const REF_L_ALPHA = 999999952; // REF_SECTION — REF_LIT 'Alpha'
const REF_L_BRAVO = 999999950; // REF_SECTION — REF_LIT 'Bravo'
const REF_L_CHARLIE = 999999951; // REF_SECTION — REF_LIT 'Charlie'
const TERM_ORD = 999999953; // TERM_SECTION — ORD_PORTAL holds an UNSORTED array (12b)
const TERM_ORD_DEEP = 999999954; // TERM_SECTION — the same, for the maxDepth leg (12d)
const RING_TERM = 999999955; // TERM_SECTION — the ring record (12e)
const TERM_BOTH = 999999956; // TERM_SECTION — ORD_MIRROR's record (12g): referenced by the three REF_L_*
const TERM_INV = 999999957; // TERM_SECTION — the inverse leg's saved record (12c)
const REF_INV = 999999958; // REF_SECTION — references TERM_INV through OBSERVED (its one inverse host)
const REF_ORD_NONHOST = 999999959; // REF_SECTION — holds an ORD_PORTAL slot its section does not declare (12f)
const TERM_BOTH_2 = 999999960; // TERM_SECTION — ORD_MIRROR's record for the other drain order (12g)

/** A locator of ORD-family portal `portal` to a REF_SECTION record. */
function refLocator(portal: string, refId: number, itemId: number): Record<string, unknown> {
	return {
		id: itemId,
		type: 'dd151',
		section_id: refId,
		section_tipo: REF_SECTION,
		from_component_tipo: portal,
	};
}

/** Stored in the order Charlie, Alpha, Bravo — UNSORTED by REF_LIT. */
function unsortedRefs(portal: string): Record<string, unknown>[] {
	return [
		refLocator(portal, REF_L_CHARLIE, 1),
		refLocator(portal, REF_L_ALPHA, 2),
		refLocator(portal, REF_L_BRAVO, 3),
	];
}

/** A bag as its target ids, in stored order. */
const idsOf = (items: unknown): number[] =>
	(Array.isArray(items) ? items : []).map((item) =>
		Number((item as { section_id?: unknown }).section_id),
	);

/** TM rows of one component on one record. */
async function tmRowsAt(tipo: string, sectionTipo: string, sectionId: number): Promise<number> {
	const rows = (await sql.unsafe(
		'SELECT count(*)::int AS c FROM matrix_time_machine WHERE tipo = $1 AND section_tipo = $2 AND section_id = $3',
		[tipo, sectionTipo, sectionId],
	)) as { c: number }[];
	return rows[0]?.c ?? 0;
}

/** A visible history row, so the write tail adds its SAVE row only (no baseline backfill). */
async function seedHistory(tipo: string, sectionTipo: string, sectionId: number): Promise<void> {
	await recordTimeMachine(
		{ sectionTipo, sectionId, componentTipo: tipo, lang: 'lg-nolan', userId: -1, data: null },
		dbTimestamp(new Date(Date.now() - 3_600_000)),
	);
}

/** The declared order on REF_LIT (asc) — the per-ddo `order` the chokepoint sorts by. */
const ORDER_SOURCE = {
	request_config: [
		{
			sqo: { section_tipo: [{ value: [REF_SECTION], source: 'section' }] },
			show: {
				ddo_map: [{ tipo: REF_LIT, parent: 'self', section_tipo: 'self', order: 'asc' }],
			},
		},
	],
};

function observedReferencer(targetId: number): string {
	return JSON.stringify({
		[OBSERVED]: [
			{
				id: 1,
				type: 'dd151',
				section_id: String(targetId),
				section_tipo: TERM_SECTION,
				from_component_tipo: OBSERVED,
			},
		],
	});
}

/**
 * The exact mirror entry the set_dato_external law appends.
 * WC-2026-08-10-section-id-int-canonical: the referencer address is an INT
 * (the observer writer mints it via canonicalizeStoredSectionId).
 */
function mirrorEntry(itemId: number, referencerId: number): Record<string, unknown> {
	return {
		id: itemId,
		type: 'dd151',
		section_id: referencerId,
		section_tipo: REF_SECTION,
		from_component_tipo: MIRROR,
	};
}

/**
 * A component's stored bag on a scratch record. The table is SCRATCH_TABLE
 * (`matrix_test`, the `test24` term) for both sections — asserted against the
 * ontology in beforeAll rather than assumed, because a section whose records
 * were read from the wrong table reads as an empty bag, not as an error.
 */
async function bagOf(
	tipo: string,
	sectionId: number,
	sectionTipo: string = TERM_SECTION,
): Promise<unknown[] | null> {
	const rows = (await sql.unsafe(
		`SELECT relation->$1 AS bag FROM ${SCRATCH_TABLE} WHERE section_tipo = $2 AND section_id = $3`,
		[tipo, sectionTipo, sectionId],
	)) as { bag: unknown[] | null }[];
	return rows[0]?.bag ?? null;
}

async function tmCount(tipo: string): Promise<number> {
	const rows = (await sql.unsafe(
		'SELECT count(*)::int AS c FROM matrix_time_machine WHERE tipo = $1',
		[tipo],
	)) as { c: number }[];
	return rows[0]?.c ?? 0;
}

const SCRATCH_NODES: {
	tipo: string;
	model: string;
	/** The declaring section; absent = the original rule (beforeAll). */
	parent?: string;
	properties: Record<string, unknown>;
}[] = [
	{
		tipo: OBSERVED,
		model: 'component_autocomplete',
		properties: {
			observers: [{ section_tipo: TERM_SECTION, component_tipo: RELAY }],
		},
	},
	{
		// The RELAY edge — the numisdata36/tch40 shape: config only, NO perform,
		// filter ABSENT (distinct from the filter:false terminal no-op). dd621
		// (multidirectional) like the live flagship: the relay payload must be
		// the value WITH REFERENCES — stored bag ∪ the transitive closure —
		// which is what carries TERM_TRANSITIVE into the cascade (gate 9; a
		// stored-bag-only payload fails it).
		tipo: RELAY,
		model: 'component_relation_related',
		properties: {
			config_relation: { relation_type_rel: 'dd621' },
			observe: [
				{
					component_tipo: OBSERVED,
					server: { config: { use_self_section: false, use_observable_dato: true } },
				},
			],
			observers: [{ section_tipo: TERM_SECTION, component_tipo: MIRROR }],
		},
	},
	{
		// The terminal recompute — the numisdata77 shape. Its own `observers`
		// entry (FOURTH) makes it a NON-leaf so the 'on'-mode wrote:true gate
		// (gate 8) can observe whether a recompute re-propagated.
		tipo: MIRROR,
		model: 'component_portal',
		properties: {
			observe: [
				{
					component_tipo: RELAY,
					server: {
						config: { use_self_section: true, use_observable_dato: true },
						perform: {
							function: 'set_dato_external',
							params: { save: true, changed: false, current_dato: false, references_limit: 0 },
						},
					},
				},
			],
			source: { section_to_search: [REF_SECTION], component_to_search: [OBSERVED] },
			observers: [{ section_tipo: TERM_SECTION, component_tipo: FOURTH }],
		},
	},
	{
		// The wrote-gate DETECTOR: observes MIRROR with the covered recompute
		// shape but NO source.component_to_search — its recompute is the counted
		// skip observers_component_to_search_missing, so a tick of that counter
		// proves the external hop fired without writing anything anywhere.
		tipo: FOURTH,
		model: 'component_portal',
		properties: {
			observe: [
				{
					component_tipo: MIRROR,
					server: {
						config: { use_self_section: false, use_observable_dato: true },
						perform: {
							function: 'set_dato_external',
							params: { save: true, changed: false, current_dato: false, references_limit: 0 },
						},
					},
				},
			],
			source: {},
		},
	},
	{
		// Converged diamond (gate 7): DIAMOND_OBS fires P and Q; both relay into
		// R — the SECOND arrival at R is a converged path, NOT a cycle.
		tipo: DIAMOND_OBS,
		model: 'component_autocomplete',
		properties: {
			observers: [
				{ section_tipo: TERM_SECTION, component_tipo: RELAY_P },
				{ section_tipo: TERM_SECTION, component_tipo: RELAY_Q },
			],
		},
	},
	{
		tipo: RELAY_P,
		model: 'component_relation_related',
		properties: {
			observe: [
				{
					component_tipo: DIAMOND_OBS,
					server: { config: { use_self_section: false, use_observable_dato: true } },
				},
			],
			observers: [{ section_tipo: TERM_SECTION, component_tipo: RELAY_R }],
		},
	},
	{
		tipo: RELAY_Q,
		model: 'component_relation_related',
		properties: {
			observe: [
				{
					component_tipo: DIAMOND_OBS,
					server: { config: { use_self_section: false, use_observable_dato: true } },
				},
			],
			observers: [{ section_tipo: TERM_SECTION, component_tipo: RELAY_R }],
		},
	},
	{
		// R observes BOTH branches; its own observers list points at a
		// component with no `observe` (OBSERVED) so its hop terminates.
		tipo: RELAY_R,
		model: 'component_relation_related',
		properties: {
			observe: [
				{
					component_tipo: RELAY_P,
					server: { config: { use_self_section: false, use_observable_dato: true } },
				},
				{
					component_tipo: RELAY_Q,
					server: { config: { use_self_section: false, use_observable_dato: true } },
				},
			],
			observers: [{ section_tipo: TERM_SECTION, component_tipo: OBSERVED }],
		},
	},
	{
		// X ↔ Y relay ring (a shape PHP would infinite-loop on).
		tipo: CYCLE_X,
		model: 'component_relation_related',
		properties: {
			observers: [{ section_tipo: TERM_SECTION, component_tipo: CYCLE_Y }],
			observe: [
				{
					component_tipo: CYCLE_Y,
					server: { config: { use_self_section: false, use_observable_dato: true } },
				},
			],
		},
	},
	{
		tipo: CYCLE_Y,
		model: 'component_relation_related',
		properties: {
			observers: [{ section_tipo: TERM_SECTION, component_tipo: CYCLE_X }],
			observe: [
				{
					component_tipo: CYCLE_X,
					server: { config: { use_self_section: false, use_observable_dato: true } },
				},
			],
		},
	},
	// --- gate 12 (the generalized default branch) ---------------------------
	{ tipo: REF_LIT, model: 'component_input_text', parent: REF_SECTION, properties: {} },
	{ tipo: ORD_SRC, model: 'component_autocomplete', parent: REF_SECTION, properties: {} },
	{
		// A DECLARED-ORDER portal that is a plain RELAY observer of ORD_SRC
		// (no perform, filter absent, use_observable_dato): its re-save through
		// its own save rules re-sorts the stored array.
		tipo: ORD_PORTAL,
		model: 'component_portal',
		properties: {
			source: ORDER_SOURCE,
			observe: [
				{
					component_tipo: ORD_SRC,
					server: { config: { use_self_section: false, use_observable_dato: true } },
				},
			],
		},
	},
	{
		tipo: ORD_DETECT,
		model: 'component_portal',
		properties: {
			observe: [
				{
					component_tipo: ORD_PORTAL,
					server: {
						config: { use_self_section: true, use_observable_dato: true },
						perform: { function: 'set_dato_external' },
					},
				},
			],
			source: {},
		},
	},
	{ tipo: INV_SRC, model: 'component_autocomplete', properties: {} },
	{
		// An AUTHORED no-perform, filter-absent use_inverse_relations entry: it
		// used to be refused (perform_not_covered); now the default branch relays
		// it to the records referencing the saved one (no `via` → unfiltered).
		tipo: INV_OBS,
		model: 'component_relation_related',
		parent: REF_SECTION,
		properties: {
			observe: [{ component_tipo: INV_SRC, server: { config: { use_inverse_relations: true } } }],
		},
	},
	{
		tipo: INV_DETECT,
		model: 'component_portal',
		parent: REF_SECTION,
		properties: {
			observe: [
				{
					component_tipo: INV_OBS,
					server: {
						config: { use_self_section: true, use_observable_dato: true },
						perform: { function: 'set_dato_external' },
					},
				},
			],
			source: {},
		},
	},
	{
		// The RING: RING_A (declared order) ↔ RING_B, each relaying the other
		// on its own record (use_self_section) — a shape the guard must end.
		tipo: RING_A,
		model: 'component_portal',
		properties: {
			source: ORDER_SOURCE,
			observe: [
				{
					component_tipo: RING_B,
					server: { config: { use_self_section: true, use_observable_dato: true } },
				},
			],
		},
	},
	{
		tipo: RING_B,
		model: 'component_relation_related',
		properties: {
			observe: [
				{
					component_tipo: RING_A,
					server: { config: { use_self_section: true, use_observable_dato: true } },
				},
			],
		},
	},
	{
		// A law (c) MIRROR (referencers of the record through OBSERVED) that ALSO
		// declares an order: the slot both a mirror recompute and a re-save act on.
		tipo: ORD_MIRROR,
		model: 'component_portal',
		properties: {
			source: {
				...ORDER_SOURCE,
				section_to_search: [REF_SECTION],
				component_to_search: [OBSERVED],
			},
			observe: [
				{
					component_tipo: ORD_MIRROR_SRC,
					server: {
						config: { use_self_section: false, use_observable_dato: true },
						perform: { function: 'set_dato_external' },
					},
				},
			],
		},
	},
	{ tipo: ORD_MIRROR_SRC, model: 'component_autocomplete', parent: REF_SECTION, properties: {} },
];

async function clearResolverCaches(): Promise<void> {
	const { clearOntologyDerivedCaches } = await import(
		'../../src/core/ontology/cache_invalidation.ts'
	);
	await clearOntologyDerivedCaches();
}

async function sweepScratch(): Promise<void> {
	// The two scratch SECTION nodes (test999290/291) and the W11 portal
	// (test999293) sit in the same `test9992%` band as the component nodes, so
	// the one ontology sweep takes them all.
	await sql.unsafe(`DELETE FROM dd_ontology WHERE tipo LIKE 'test9992%' AND tld = 'test'`);
	await sql.unsafe(
		`DELETE FROM ${SCRATCH_TABLE} WHERE section_tipo = $1 AND section_id = ANY(string_to_array($2, ',')::int[])`,
		[
			REF_SECTION,
			[
				REF_A,
				REF_EQUIV,
				REF_TX,
				REF_ON,
				W11_RECORD,
				REF_TRANSITIVE,
				REF_NONHOST,
				REF_L_ALPHA,
				REF_L_BRAVO,
				REF_L_CHARLIE,
				REF_INV,
				REF_ORD_NONHOST,
			].join(','),
		],
	);
	await sql.unsafe(
		`DELETE FROM ${SCRATCH_TABLE} WHERE section_tipo = $1 AND section_id = ANY(string_to_array($2, ',')::int[])`,
		[
			TERM_SECTION,
			[
				TERM_A,
				TERM_EQUIV,
				CYCLE_TERM,
				TERM_TX,
				TERM_ON,
				DIAMOND_TERM,
				TERM_TRANSITIVE,
				TERM_ORD,
				TERM_ORD_DEEP,
				RING_TERM,
				TERM_BOTH,
				TERM_INV,
				TERM_BOTH_2,
			].join(','),
		],
	);
	await sql.unsafe(`DELETE FROM matrix_time_machine WHERE tipo LIKE 'test9992%'`, []);
	await sql.unsafe(`DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2`, [
		REF_SECTION,
		W11_RECORD,
	]);
}

/** Gate 12's records (raw scratch rows — the relation index trigger indexes them). */
async function seedGate12Records(): Promise<void> {
	await assertTestDatabase('observer_cascade_native gate 12 seed');
	const insert = (sectionTipo: string, sectionId: number, relation: unknown, string?: unknown) =>
		sql.unsafe(
			`INSERT INTO ${SCRATCH_TABLE} (section_id, section_tipo, relation, string) VALUES ($1, $2, $3::text::jsonb, $4::text::jsonb)`,
			[
				sectionId,
				sectionTipo,
				JSON.stringify(relation),
				string === undefined ? null : JSON.stringify(string),
			],
		);
	// The three ranked REF records: an ordering value each, and a reference to
	// TERM_BOTH through OBSERVED (ORD_MIRROR's law (c) referencers).
	for (const [refId, value] of [
		[REF_L_ALPHA, 'Alpha'],
		[REF_L_BRAVO, 'Bravo'],
		[REF_L_CHARLIE, 'Charlie'],
	] as const) {
		await insert(
			REF_SECTION,
			refId,
			{
				[OBSERVED]: [
					{
						id: 1,
						type: 'dd151',
						section_id: TERM_BOTH,
						section_tipo: TERM_SECTION,
						from_component_tipo: OBSERVED,
					},
					{
						id: 2,
						type: 'dd151',
						section_id: TERM_BOTH_2,
						section_tipo: TERM_SECTION,
						from_component_tipo: OBSERVED,
					},
				],
			},
			// REF_LIT is NOT translatable: its value lives under lg-nolan, the lang the
			// order expression reads (a translatable lang here ranks every row NULL)
			{ [REF_LIT]: [{ id: 1, lang: 'lg-nolan', value }] },
		);
	}
	await insert(TERM_SECTION, TERM_ORD, { [ORD_PORTAL]: unsortedRefs(ORD_PORTAL) });
	await insert(TERM_SECTION, TERM_ORD_DEEP, { [ORD_PORTAL]: unsortedRefs(ORD_PORTAL) });
	await insert(TERM_SECTION, RING_TERM, { [RING_A]: unsortedRefs(RING_A) });
	// ORD_MIRROR's stale mirrors: Bravo, Alpha (UNSORTED) — Charlie missing (the recompute adds it)
	const staleMirror = [
		refLocator(ORD_MIRROR, REF_L_BRAVO, 1),
		refLocator(ORD_MIRROR, REF_L_ALPHA, 2),
	];
	await insert(TERM_SECTION, TERM_BOTH, { [ORD_MIRROR]: staleMirror });
	await insert(TERM_SECTION, TERM_BOTH_2, { [ORD_MIRROR]: staleMirror });
	await insert(TERM_SECTION, TERM_INV, {});
	await insert(REF_SECTION, REF_INV, JSON.parse(observedReferencer(TERM_INV)));
	// a REF record holding an ORD_PORTAL slot REF_SECTION does not declare
	await insert(REF_SECTION, REF_ORD_NONHOST, { [ORD_PORTAL]: unsortedRefs(ORD_PORTAL) });
	for (const [tipo, sectionId] of [
		[ORD_PORTAL, TERM_ORD],
		[ORD_PORTAL, TERM_ORD_DEEP],
		[RING_A, RING_TERM],
		[ORD_MIRROR, TERM_BOTH],
		[ORD_MIRROR, TERM_BOTH_2],
	] as const) {
		await seedHistory(tipo, TERM_SECTION, sectionId);
	}
}

beforeAll(async () => {
	// Residue-tolerant: sweep FIRST, then seed unconditionally (a crashed run
	// must never turn these gates vacuous-green).
	await sweepScratch();
	// Each component is declared BY THE SECTION whose records store it — the
	// external-mirror HOST PRECONDITION (observer ∈ declaredSectionComponents
	// of the target section — external_laws/resolvers.ts isObserverHostSection)
	// refuses a mirror born on a section that does not declare its observer. The two
	// saved components live on the referencer records; every relay/recompute
	// observer lives on the term records.
	for (const node of SCRATCH_NODES) {
		const parent =
			node.parent ??
			(node.tipo === OBSERVED || node.tipo === DIAMOND_OBS ? REF_SECTION : TERM_SECTION);
		await sql.unsafe(
			`INSERT INTO dd_ontology (id, tipo, parent, model, tld, properties)
			 VALUES ((SELECT COALESCE(MAX(id), 0) + 1300 FROM dd_ontology), $1, $2, $3, 'test', $4::text::jsonb)`,
			[node.tipo, parent, node.model, JSON.stringify(node.properties)],
		);
	}
	// The TWO SCRATCH SECTIONS (2026-08-20 migration). Each carries the `test24`
	// matrix_table relation, whose term is `matrix_test` — the one place every
	// record below lands. Named through the ontology, never assumed: the
	// getMatrixTableFromTipo assertions after the seed prove it.
	for (const sectionTipo of [TERM_SECTION, REF_SECTION]) {
		await sql.unsafe(
			`INSERT INTO dd_ontology (id, tipo, parent, model, tld, relations, term)
			 VALUES ((SELECT COALESCE(MAX(id), 0) + 1300 FROM dd_ontology), $1, 'test1', 'section', 'test', $2::text::jsonb, $3::text::jsonb)`,
			[
				sectionTipo,
				JSON.stringify([{ tipo: 'test24' }]),
				JSON.stringify({ 'lg-eng': `observer cascade scratch ${sectionTipo}` }),
			],
		);
	}
	// The relation component the W11 removal door drives (was the seed
	// `rsc387`), copied from it field for field: model `component_autocomplete_hi`
	// (which decides the matrix COLUMN — `relation`) and, load-bearing,
	// `config_relation.relation_type = 'dd96'`. deletePortalLocator's type guard
	// compares the sent locator's `type` against getRelationTypeByTipo, which
	// falls back to the MODEL default ('dd151') when no relation_type is
	// configured — a scratch node without this key turns every dd96 removal
	// below into a silent typeMismatch (removed: 0).
	await sql.unsafe(
		`INSERT INTO dd_ontology (id, tipo, parent, model, tld, properties)
		 VALUES ((SELECT COALESCE(MAX(id), 0) + 1300 FROM dd_ontology), $1, $2, 'component_autocomplete_hi', 'test', $3::text::jsonb)`,
		[W11_PORTAL, REF_SECTION, JSON.stringify({ config_relation: { relation_type: 'dd96' } })],
	);
	// The DETERMINISTIC-SQL-ERROR section (gate 11): a section node whose
	// matrix_table term names a table that does not exist — any recompute
	// targeting it fails with 42P01 inside whatever transaction it runs in. It
	// is a VIRTUAL face of TERM_SECTION (its own matrix_table relation still
	// wins the table lookup), so it HOSTS MIRROR: the kernel's strict host
	// precondition would otherwise answer it with a no-op before any SQL ran.
	await sql.unsafe(
		`INSERT INTO dd_ontology (id, tipo, parent, model, tld, term)
		 VALUES ((SELECT COALESCE(MAX(id), 0) + 1300 FROM dd_ontology), $1, 'test3', 'matrix_table', 'test', $2::text::jsonb)`,
		[BROKEN_TABLE_NODE, JSON.stringify({ 'lg-spa': 'matrix_zz_missing_zz' })],
	);
	await sql.unsafe(
		`INSERT INTO dd_ontology (id, tipo, parent, model, tld, relations)
		 VALUES ((SELECT COALESCE(MAX(id), 0) + 1300 FROM dd_ontology), $1, 'test3', 'section', 'test', $2::text::jsonb)`,
		[BROKEN_SECTION, JSON.stringify([{ tipo: TERM_SECTION }, { tipo: BROKEN_TABLE_NODE }])],
	);
	// Records: the relay target (B's bag names the equivalent term), the
	// equivalent, the ring record (self-pointing bags), the commit-lane target
	// (empty bag) and the referencers.
	await sql.unsafe(
		`INSERT INTO ${SCRATCH_TABLE} (section_id, section_tipo, relation) VALUES ($1, '${TERM_SECTION}', $2::text::jsonb)`,
		[
			TERM_A,
			JSON.stringify({
				[RELAY]: [
					{
						id: 1,
						type: 'dd151',
						section_id: String(TERM_EQUIV),
						section_tipo: TERM_SECTION,
						from_component_tipo: RELAY,
					},
				],
			}),
		],
	);
	// TERM_EQUIV's own RELAY bag points at TERM_TRANSITIVE: reachable from
	// TERM_A ONLY through the dd621 transitive closure (gate 9 — the relay
	// payload must carry it; the stored bag alone never would).
	await sql.unsafe(
		`INSERT INTO ${SCRATCH_TABLE} (section_id, section_tipo, relation) VALUES ($1, '${TERM_SECTION}', $2::text::jsonb)`,
		[
			TERM_EQUIV,
			JSON.stringify({
				[RELAY]: [
					{
						id: 1,
						type: 'dd151',
						section_id: String(TERM_TRANSITIVE),
						section_tipo: TERM_SECTION,
						from_component_tipo: RELAY,
					},
				],
			}),
		],
	);
	await sql.unsafe(
		`INSERT INTO ${SCRATCH_TABLE} (section_id, section_tipo, relation) VALUES ($1, '${TERM_SECTION}', '{}'::jsonb)`,
		[TERM_TRANSITIVE],
	);
	await sql.unsafe(
		`INSERT INTO ${SCRATCH_TABLE} (section_id, section_tipo, relation) VALUES ($1, '${TERM_SECTION}', '{}'::jsonb)`,
		[TERM_ON],
	);
	// The diamond record: P's and Q's bags both point at THIS record, so each
	// branch's relay payload carries it and both branches hop R here.
	await sql.unsafe(
		`INSERT INTO ${SCRATCH_TABLE} (section_id, section_tipo, relation) VALUES ($1, '${TERM_SECTION}', $2::text::jsonb)`,
		[
			DIAMOND_TERM,
			JSON.stringify({
				[RELAY_P]: [
					{
						id: 1,
						type: 'dd151',
						section_id: String(DIAMOND_TERM),
						section_tipo: TERM_SECTION,
						from_component_tipo: RELAY_P,
					},
				],
				[RELAY_Q]: [
					{
						id: 1,
						type: 'dd151',
						section_id: String(DIAMOND_TERM),
						section_tipo: TERM_SECTION,
						from_component_tipo: RELAY_Q,
					},
				],
			}),
		],
	);
	await sql.unsafe(
		`INSERT INTO ${SCRATCH_TABLE} (section_id, section_tipo, relation) VALUES ($1, '${TERM_SECTION}', $2::text::jsonb)`,
		[
			CYCLE_TERM,
			JSON.stringify({
				[CYCLE_X]: [
					{
						id: 1,
						type: 'dd151',
						section_id: String(CYCLE_TERM),
						section_tipo: TERM_SECTION,
						from_component_tipo: CYCLE_X,
					},
				],
				[CYCLE_Y]: [
					{
						id: 1,
						type: 'dd151',
						section_id: String(CYCLE_TERM),
						section_tipo: TERM_SECTION,
						from_component_tipo: CYCLE_Y,
					},
				],
			}),
		],
	);
	await sql.unsafe(
		`INSERT INTO ${SCRATCH_TABLE} (section_id, section_tipo, relation) VALUES ($1, '${TERM_SECTION}', '{}'::jsonb)`,
		[TERM_TX],
	);
	for (const [refId, targetId] of [
		[REF_A, TERM_A],
		[REF_EQUIV, TERM_EQUIV],
		[REF_TX, TERM_TX],
		[REF_ON, TERM_ON],
		[REF_TRANSITIVE, TERM_TRANSITIVE],
	] as const) {
		await sql.unsafe(
			`INSERT INTO ${SCRATCH_TABLE} (section_id, section_tipo, relation) VALUES ($1, '${REF_SECTION}', $2::text::jsonb)`,
			[refId, observedReferencer(targetId)],
		);
	}
	await seedGate12Records();
	await clearResolverCaches();
	// PROVE the storage table rather than assume it: SCRATCH_TABLE is hard-coded
	// in every raw statement above, so a section whose `test24` relation failed
	// to take would leave those rows in a table nothing reads — every bag would
	// come back null and each gate below would pass or fail for the wrong
	// reason. This is the check that was missing when the install sections
	// carried the table implicitly.
	const { getMatrixTableFromTipo } = await import('../../src/core/ontology/resolver.ts');
	expect(await getMatrixTableFromTipo(TERM_SECTION)).toBe(SCRATCH_TABLE);
	expect(await getMatrixTableFromTipo(REF_SECTION)).toBe(SCRATCH_TABLE);
});

afterAll(async () => {
	await sweepScratch();
	await clearResolverCaches();
});

// The saved data of OBSERVED at a REF_SECTION record: one locator to TERM_A.
const SAVED_ITEMS = [{ section_tipo: TERM_SECTION, section_id: TERM_A }];

// ---------------------------------------------------------------------------
// 1. THE CASCADE IS UNCONDITIONAL — a declared edge always fires (this
//    replaced the retired flag's "off = no cascade" byte-identity gate: the
//    same propagation that once had to write NOTHING must now converge the
//    whole declared chain).
// ---------------------------------------------------------------------------

describe('unconditional cascade — the flagship chain shape', () => {
	test('A saves → relay B (write:none) → C recomputes at the target AND at the payload equivalent', async () => {
		const relayBagBefore = JSON.stringify(await bagOf(RELAY, TERM_A));
		await propagateToObservers(
			OBSERVED,
			REF_SECTION,
			REF_A,
			{ saved: SAVED_ITEMS, removed: [] },
			-1,
		);

		// C's mirror landed at the relay TARGET (self, use_self_section:true)…
		expect(await bagOf(MIRROR, TERM_A)).toEqual([mirrorEntry(1, REF_A)]);
		// …AND at the equivalent the relay payload (B's bag WITH REFERENCES)
		// carried — the proof the child event consumed the relay's payload.
		expect(await bagOf(MIRROR, TERM_EQUIV)).toEqual([mirrorEntry(1, REF_EQUIV)]);
		// …AND at the dd621 TRANSITIVE closure target (gate 9): TERM_TRANSITIVE
		// is only in TERM_EQUIV's bag, never TERM_A's — it reaches the cascade
		// exclusively through getStoredWithReferences' recursive closure. If the
		// relay payload ever degrades to the stored bag, THIS line goes red.
		expect(await bagOf(MIRROR, TERM_TRANSITIVE)).toEqual([mirrorEntry(1, REF_TRANSITIVE)]);

		// THE RELAY WROTE NOTHING (WC-2026-08-02-observer-relay-writes-nothing):
		// B's stored bag is byte-identical and B has ZERO TM rows — while the
		// recompute (a real write) audited C normally.
		expect(JSON.stringify(await bagOf(RELAY, TERM_A))).toBe(relayBagBefore);
		expect(await tmCount(RELAY)).toBe(0);
		expect(await tmCount(MIRROR)).toBeGreaterThan(0);
	}, 30000);
});

// ---------------------------------------------------------------------------
// 2 + 3. The X ↔ Y ring terminates via the visited set; the depth budget is
//        the independent backstop (the real ring never reaches it — depth 8
//        sits far above the measured depth-2 graph — so the budget gate
//        plants a guard already AT the ceiling and asserts the refusal).
// ---------------------------------------------------------------------------

describe('bounded dispatch on a planted CYCLE', () => {
	test('the ring terminates LOUDLY via the visited set (no hang)', async () => {
		const cycleBefore = getCounters().observers_cascade_cycle_refused ?? 0;
		await propagateToObservers(
			CYCLE_X,
			TERM_SECTION,
			CYCLE_TERM,
			{ saved: [{ section_tipo: TERM_SECTION, section_id: CYCLE_TERM }], removed: [] },
			-1,
		);
		// X → hop Y → hop X → hop Y REFUSED (already dispatched) — exactly one
		// refusal, and the call RETURNED (a hang would trip the test timeout).
		expect((getCounters().observers_cascade_cycle_refused ?? 0) - cycleBefore).toBe(1);
	}, 20000);
});

describe('depth budget — the backstop refusal', () => {
	test('the production ceiling is pinned at 8 and hop 9 is refused loudly (not a cycle)', async () => {
		expect(MAX_CASCADE_DEPTH).toBe(8); // the 'on' value the flag era shipped
		const depthBefore = getCounters().observers_cascade_depth_exceeded ?? 0;
		const cycleBefore = getCounters().observers_cascade_cycle_refused ?? 0;
		// A guard that already spent the whole budget: the NEXT hop is 9 > 8.
		// RELAY declares `observers`, so the hop passes the leaf pre-gate and
		// reaches the budget check with a fresh visited set (no revisit signal).
		const guard: CascadeGuard = {
			depth: MAX_CASCADE_DEPTH,
			maxDepth: MAX_CASCADE_DEPTH,
			visited: new Set(),
			recomputed: new Set(),
			chain: [`synthetic-deep-chain@${REF_SECTION}/${REF_A}`],
		};
		await emitCascadeHop(guard, RELAY, 'relay', TERM_SECTION, TERM_A, -1, new Date());
		// refused BEFORE dispatch: counted, cycle counter untouched, and the
		// node was never marked visited (the refusal is not an execution).
		expect((getCounters().observers_cascade_depth_exceeded ?? 0) - depthBefore).toBe(1);
		expect((getCounters().observers_cascade_cycle_refused ?? 0) - cycleBefore).toBe(0);
		expect(guard.visited.size).toBe(0);
	}, 20000);
});

// ---------------------------------------------------------------------------
// 7. Converged DIAMOND: benign dedup, NOT a cycle (review 2026-08-02 — the
//    two signals must never share a counter, or operators chase phantom
//    cycles on legitimate diamond-shaped ontologies).
// ---------------------------------------------------------------------------

describe('converged diamond — execute-once dedup', () => {
	test('the second arrival at R is counted converged; the cycle counter stays 0', async () => {
		const convergedBefore = getCounters().observers_cascade_converged_skipped ?? 0;
		const cycleBefore = getCounters().observers_cascade_cycle_refused ?? 0;
		// DIAMOND_OBS fires P and Q; each branch's payload carries DIAMOND_TERM,
		// so both branches hop R@DIAMOND_TERM — the second is a converged path
		// (R is NOT on its own chain).
		await propagateToObservers(
			DIAMOND_OBS,
			TERM_SECTION,
			DIAMOND_TERM,
			{ saved: [{ section_tipo: TERM_SECTION, section_id: DIAMOND_TERM }], removed: [] },
			-1,
		);
		expect((getCounters().observers_cascade_converged_skipped ?? 0) - convergedBefore).toBe(1);
		expect((getCounters().observers_cascade_cycle_refused ?? 0) - cycleBefore).toBe(0);
	}, 20000);
});

// ---------------------------------------------------------------------------
// 8. The wrote:true law: a recompute hop fires ONLY after a REAL persist
//    (PHP: `$changed === false` skips Save() and the propagation).
//    Detector: FOURTH observes MIRROR but has no component_to_search, so its
//    recompute is EXACTLY one tick of observers_component_to_search_missing
//    and writes nothing — the counter is the hop's footprint.
// ---------------------------------------------------------------------------

describe('recompute hops are gated on wrote:true', () => {
	test('a PERSISTING recompute re-propagates (FOURTH is reached)', async () => {
		const missingBefore = getCounters().observers_component_to_search_missing ?? 0;
		await propagateToObservers(
			RELAY,
			TERM_SECTION,
			TERM_ON,
			{ saved: [{ section_tipo: TERM_SECTION, section_id: TERM_ON }], removed: [] },
			-1,
		);
		// the recompute persisted (fresh mirror) …
		expect(await bagOf(MIRROR, TERM_ON)).toEqual([mirrorEntry(1, REF_ON)]);
		// … so the external hop fired and FOURTH's counted skip proves it ran
		// (exactly once: one payload target, use_self_section:false on FOURTH).
		expect((getCounters().observers_component_to_search_missing ?? 0) - missingBefore).toBe(1);
	}, 30000);

	test('a CONVERGED (no-drift) recompute does NOT re-propagate', async () => {
		const missingBefore = getCounters().observers_component_to_search_missing ?? 0;
		// same propagation again: the mirror already holds REF_ON → no drift →
		// no write → `wrote` absent → no hop → FOURTH never runs.
		await propagateToObservers(
			RELAY,
			TERM_SECTION,
			TERM_ON,
			{ saved: [{ section_tipo: TERM_SECTION, section_id: TERM_ON }], removed: [] },
			-1,
		);
		expect(await bagOf(MIRROR, TERM_ON)).toEqual([mirrorEntry(1, REF_ON)]);
		expect((getCounters().observers_component_to_search_missing ?? 0) - missingBefore).toBe(0);
	}, 30000);
});

// ---------------------------------------------------------------------------
// 8b. The 'always' hop (the obligation ledger's covered-slot recompute — a
//     restore / undelete wrote the slot) and the STRICT host precondition
//     (owner ruling 2026-10-30): on a host record a no-drift 'always'
//     recompute still hops (positive control: FOURTH is reached); on a record
//     whose section does NOT declare the observer the kernel is a no-op, and
//     the stored slot is not that record's value — so no hop may carry its
//     bytes (a restored phantom) to the observers as a current-state `saved`.
// ---------------------------------------------------------------------------

describe("the 'always' hop skips a slot the record's section does not declare", () => {
	const freshGuard = (root: string): CascadeGuard => ({
		depth: 0,
		maxDepth: MAX_CASCADE_DEPTH,
		visited: new Set(),
		recomputed: new Set(),
		chain: [root],
	});

	test("POSITIVE CONTROL: a no-drift 'always' recompute on a HOST record hops (FOURTH is reached)", async () => {
		expect(await bagOf(MIRROR, TERM_ON), 'FLOOR: gate 8 left TERM_ON converged').toEqual([
			mirrorEntry(1, REF_ON),
		]);
		const missingBefore = getCounters().observers_component_to_search_missing ?? 0;
		const outcome = await recomputeMirrorAndHop(
			MIRROR,
			TERM_SECTION,
			TERM_ON,
			-1,
			new Date(),
			freshGuard(`${MIRROR}@${TERM_SECTION}/${TERM_ON}`),
			'always',
		);
		expect(outcome?.wrote).not.toBe(true);
		expect((getCounters().observers_component_to_search_missing ?? 0) - missingBefore).toBe(1);
	}, 30000);

	test("a NON-HOST holder: the kernel is a no-op, the slot stands, and the 'always' hop does NOT fire", async () => {
		const phantom = mirrorEntry(1, REF_ON);
		await sql.unsafe(
			`INSERT INTO ${SCRATCH_TABLE} (section_id, section_tipo, relation) VALUES ($1, $2, $3::text::jsonb)`,
			[REF_NONHOST, REF_SECTION, JSON.stringify({ [MIRROR]: [phantom] })],
		);
		const notHostBefore = getCounters().observers_target_not_host ?? 0;
		const missingBefore = getCounters().observers_component_to_search_missing ?? 0;
		const guard = freshGuard(`${MIRROR}@${REF_SECTION}/${REF_NONHOST}`);
		const outcome = await recomputeMirrorAndHop(
			MIRROR,
			REF_SECTION,
			REF_NONHOST,
			-1,
			new Date(),
			guard,
			'always',
		);
		expect(outcome?.targetNotHost, 'REF_SECTION hosts MIRROR — re-read this fixture').toBe(true);
		expect((getCounters().observers_target_not_host ?? 0) - notHostBefore).toBe(1);
		expect(
			(getCounters().observers_component_to_search_missing ?? 0) - missingBefore,
			"the 'always' hop propagated a slot its section does not declare (the restored phantom reached FOURTH)",
		).toBe(0);
		// The dedup branch (a second call on the same guard) holds the same rule.
		await recomputeMirrorAndHop(MIRROR, REF_SECTION, REF_NONHOST, -1, new Date(), guard, 'always');
		expect((getCounters().observers_component_to_search_missing ?? 0) - missingBefore).toBe(0);
		expect(await bagOf(MIRROR, REF_NONHOST, REF_SECTION)).toEqual([phantom]);
	}, 30000);
});

// ---------------------------------------------------------------------------
// 4. Ambient transaction: a WRITE's propagation rides the COMMIT-ONLY lane
//    (B6/W12) — through the record-write chokepoint's obligation ledger, the one
//    door every write takes (the import doors' per-row wrap is this shape).
// ---------------------------------------------------------------------------

describe('ambient transaction — a write propagates after COMMIT', () => {
	/** REF_TX's OBSERVED key rewritten through the chokepoint (its stored value). */
	const writeObserved = (): Promise<void> =>
		persistRecordKeys(
			{ table: SCRATCH_TABLE, sectionTipo: REF_SECTION, sectionId: REF_TX },
			[
				{
					column: 'relation',
					key: OBSERVED,
					value: JSON.parse(observedReferencer(TERM_TX))[OBSERVED],
				},
			],
			false,
			{ actor: -1 },
		);

	test('ROLLBACK discards the write’s propagation: no mirror, no TM', async () => {
		await expect(
			withTransaction(async () => {
				await writeObserved();
				throw new Error('forced rollback');
			}),
		).rejects.toThrow('forced rollback');
		expect(await bagOf(MIRROR, TERM_TX)).toBeNull();
	});

	test('COMMIT fires the propagation: the mirror lands post-commit, never inside', async () => {
		await withTransaction(async () => {
			await writeObserved();
			// still inside the outer tx: nothing has propagated yet
			expect(await bagOf(MIRROR, TERM_TX)).toBeNull();
		});
		// the commit lane drained before withTransaction resolved
		expect(await bagOf(MIRROR, TERM_TX)).toEqual([mirrorEntry(1, REF_TX)]);
	}, 30000);
});

// ---------------------------------------------------------------------------
// 5. B6 assert: a hop refuses to run inside an ambient transaction.
// ---------------------------------------------------------------------------

describe('runObserverCascadeHop ambient-transaction refusal (B6)', () => {
	test('throws naming the chain when called inside withTransaction', async () => {
		const guard: CascadeGuard = {
			depth: 1,
			maxDepth: MAX_CASCADE_DEPTH,
			visited: new Set(),
			recomputed: new Set(),
			chain: [`${OBSERVED}@${REF_SECTION}/${REF_A}`, `${RELAY}@${TERM_SECTION}/${TERM_A}`],
		};
		await expect(
			withTransaction(() =>
				runObserverCascadeHop(RELAY, TERM_SECTION, TERM_A, -1, new Date(), guard),
			),
		).rejects.toThrow(new RegExp(`ambient transaction.*${RELAY}@${TERM_SECTION}/${TERM_A}`, 's'));
	});
});

// ---------------------------------------------------------------------------
// 10. Leaked continuation (S2-14 class): the commit lane is CLOSED but the
//     transaction context still reports active — the hop must be DROPPED
//     loudly (counted), never silently (review 2026-08-02: this was the
//     dispatch's one silent-truncation path).
// ---------------------------------------------------------------------------

describe('leaked continuation — the hop drop is loud', () => {
	test('a hop emitted from a settled transaction context is counted, not silently lost', async () => {
		const { getNode } = await import('../../src/core/ontology/resolver.ts');
		await getNode(RELAY); // prime the ontology cache — the leaked context must not need a query
		const droppedBefore = getCounters().observers_cascade_hop_dropped ?? 0;
		let txSettled = false;
		let leak: Promise<void> = Promise.resolve();
		await withTransaction(async () => {
			// the S2-14 leak class: an UNAWAITED promise started inside the
			// callback that outlives the transaction while keeping its ALS context
			leak = (async () => {
				while (!txSettled) {
					await Bun.sleep(5);
				}
				const guard: CascadeGuard = {
					depth: 0,
					maxDepth: MAX_CASCADE_DEPTH,
					visited: new Set(),
					recomputed: new Set(),
					chain: [`leak@${REF_SECTION}/${REF_A}`],
				};
				await emitCascadeHop(guard, RELAY, 'relay', TERM_SECTION, TERM_A, -1, new Date());
			})();
			await sql.unsafe('SELECT 1', []);
		});
		txSettled = true;
		await leak; // must resolve (no throw) — the drop is counted, not fatal
		expect((getCounters().observers_cascade_hop_dropped ?? 0) - droppedBefore).toBe(1);
	}, 20000);
});

// ---------------------------------------------------------------------------
// 11. B6: propagation never runs inside a transaction. The ledger drains every
//     write's propagation post-commit, so an in-transaction call is a caller
//     bug — refused BEFORE anything runs (it used to run, and on failure
//     rethrow into the caller's transaction). Outside one, a level-0 failure is
//     swallowed and counted. BROKEN_SECTION's matrix table does not exist, so
//     its recompute fails deterministically.
// ---------------------------------------------------------------------------

describe('level-0 propagation — refused inside a transaction, swallowed outside', () => {
	const brokenItems = [{ section_tipo: BROKEN_SECTION, section_id: 1 }];

	test('inside an ambient transaction propagation REFUSES before running (B6)', async () => {
		const failedBefore = getCounters().observers_propagation_failed ?? 0;
		await expect(
			withTransaction(async () => {
				await propagateToObservers(
					RELAY,
					TERM_SECTION,
					TERM_A,
					{ saved: brokenItems, removed: [] },
					-1,
				);
			}),
		).rejects.toThrow(/refusing to run inside a transaction/);
		// refused, not attempted: no recompute ran, so no failure was counted
		expect((getCounters().observers_propagation_failed ?? 0) - failedBefore).toBe(0);
	});

	test('outside a transaction the same failure is swallowed (never throws) and counted', async () => {
		const failedBefore = getCounters().observers_propagation_failed ?? 0;
		const result = await propagateToObservers(
			RELAY,
			TERM_SECTION,
			TERM_A,
			{ saved: brokenItems, removed: [] },
			-1,
		);
		expect(result).toEqual([]);
		expect((getCounters().observers_propagation_failed ?? 0) - failedBefore).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// 6. W11 — deletePortalLocator is locked + transactional.
// ---------------------------------------------------------------------------

describe('W11: deletePortalLocator lock', () => {
	test('static pin: the RMW runs under withTransaction with a FOR UPDATE read, the write through the removal-law chokepoint', () => {
		const source = readFileSync(join(REPO_ROOT, 'src/core/relations/save.ts'), 'utf-8');
		// The EFFECT (SEC-2): deletePortalLocator is the write door; the locked RMW
		// is its private, grant-typed effect.
		const anchor = source.indexOf('async function removePortalLocatorUnderGrant');
		expect(anchor).toBeGreaterThan(-1);
		const body = source.slice(anchor);
		expect(body).toContain('await withTransaction(');
		expect(body).toContain('FOR UPDATE');
		// the lock precedes the read; the write is the chokepoint's removal-law
		// entry, whose ledger fans the observers out after the COMMIT — the door
		// itself propagates nothing (write_obligations_tripwire leg B4 derives it)
		expect(body.indexOf('FOR UPDATE')).toBeLessThan(body.indexOf('readMatrixRecord('));
		expect(body.indexOf('persistRelationRemovalKeys(')).toBeGreaterThan(body.indexOf('FOR UPDATE'));
		// ZERO-ROW GUARD (review 2026-08-02): a FOR UPDATE matching no row locks
		// NOTHING; under READ COMMITTED the later read could then see a freshly
		// committed row and run the whole RMW unlocked. The lock result MUST be
		// inspected and the empty case returned before the read.
		expect(body).toContain('lockedRows.length === 0');
		expect(body.indexOf('lockedRows.length === 0')).toBeLessThan(body.indexOf('readMatrixRecord('));
	});

	test('a record ABSENT under the lock returns the empty-data shape without reading', async () => {
		const { deletePortalLocator } = await import('../../src/core/relations/save.ts');
		const response = await deletePortalLocator(
			{ isGlobalAdmin: true, userId: -1 },
			{ tipo: W11_PORTAL, section_tipo: REF_SECTION, section_id: 999999949 }, // no such row
			{ locator: { type: 'dd96', section_id: '1', section_tipo: TERM_SECTION } },
		);
		// same as the historical missing-record answer: nothing removed, and the
		// narrative says why (it is an outcome, never a refusal).
		expect(response.removed).toBe(0);
		expect(response.msg.join(' ')).toContain('The component data is empty');
	});

	test('two CONCURRENT removals on one record both survive (no lost update)', async () => {
		// W11_PORTAL (dd96) on REF_SECTION — the same door observer_native
		// drives. The two locators point at NONEXISTENT TERM_SECTION targets so
		// the observer
		// recompute the door fires is a no-op (rows.length === 0), keeping this
		// test independent of the mirror machinery above.
		const locator = (id: number, targetId: number) => ({
			id,
			type: 'dd96',
			section_id: String(targetId),
			section_tipo: TERM_SECTION,
			from_component_tipo: W11_PORTAL,
		});
		await sql.unsafe(
			`INSERT INTO ${SCRATCH_TABLE} (section_id, section_tipo, relation) VALUES ($1, '${REF_SECTION}', $2::text::jsonb)`,
			[
				W11_RECORD,
				JSON.stringify({ [W11_PORTAL]: [locator(1, 999999941), locator(2, 999999942)] }),
			],
		);
		const { deletePortalLocator } = await import('../../src/core/relations/save.ts');
		const remove = (targetId: number) =>
			deletePortalLocator(
				{ isGlobalAdmin: true, userId: -1 },
				{ tipo: W11_PORTAL, section_tipo: REF_SECTION, section_id: W11_RECORD },
				{
					locator: {
						type: 'dd96',
						section_id: String(targetId),
						section_tipo: TERM_SECTION,
						from_component_tipo: W11_PORTAL,
					},
					ar_properties: ['section_tipo', 'section_id', 'type', 'from_component_tipo'],
				},
			);
		const [first, second] = await Promise.all([remove(999999941), remove(999999942)]);
		expect(first.removed).toBe(1);
		expect(second.removed).toBe(1);
		const rows = (await sql.unsafe(
			`SELECT relation->'${W11_PORTAL}' AS bag FROM ${SCRATCH_TABLE} WHERE section_tipo = '${REF_SECTION}' AND section_id = $1`,
			[W11_RECORD],
		)) as { bag: unknown[] | null }[];
		// BOTH removals persisted — the unlocked RMW lost one of them.
		expect(rows[0]?.bag).toEqual([]);
	}, 30000);
});

// ---------------------------------------------------------------------------
// 12. THE DEFAULT BRANCH, GENERALIZED (portal order model, 2026-10-31 — addendum
//     on WC-2026-08-02-observer-relay-writes-nothing). Gate 1 above is its
//     IDENTITY case (RELAY declares no order: still nothing written).
// ---------------------------------------------------------------------------

describe('the generalized default branch — re-save through the observer’s own save rules', () => {
	const freshGuard = (root: string, depth = 0, maxDepth = MAX_CASCADE_DEPTH): CascadeGuard => ({
		depth,
		maxDepth,
		visited: new Set(),
		recomputed: new Set(),
		resaved: new Set(),
		chain: [root],
	});

	test('12b. a declared-order RELAY observer holding an unsorted array is re-written sorted, ONE TM row, then the relay hops on', async () => {
		expect(idsOf(await bagOf(ORD_PORTAL, TERM_ORD)), 'FLOOR: seeded unsorted').toEqual([
			REF_L_CHARLIE,
			REF_L_ALPHA,
			REF_L_BRAVO,
		]);
		const tmBefore = await tmRowsAt(ORD_PORTAL, TERM_SECTION, TERM_ORD);
		const hopBefore = getCounters().observers_component_to_search_missing ?? 0;
		await propagateToObservers(
			ORD_SRC,
			REF_SECTION,
			REF_A,
			{ saved: [{ section_tipo: TERM_SECTION, section_id: TERM_ORD }], removed: [] },
			-1,
		);
		expect(idsOf(await bagOf(ORD_PORTAL, TERM_ORD))).toEqual([
			REF_L_ALPHA,
			REF_L_BRAVO,
			REF_L_CHARLIE,
		]);
		expect(await tmRowsAt(ORD_PORTAL, TERM_SECTION, TERM_ORD)).toBe(tmBefore + 1);
		// the relay hopped ORD_PORTAL on: its detector's counted skip ticked once
		expect((getCounters().observers_component_to_search_missing ?? 0) - hopBefore).toBe(1);

		// the SAME propagation again: the array is in order → no write, no TM row
		await propagateToObservers(
			ORD_SRC,
			REF_SECTION,
			REF_A,
			{ saved: [{ section_tipo: TERM_SECTION, section_id: TERM_ORD }], removed: [] },
			-1,
		);
		expect(await tmRowsAt(ORD_PORTAL, TERM_SECTION, TERM_ORD)).toBe(tmBefore + 1);
	}, 30000);

	test('12c. a no-perform use_inverse_relations edge reaches the default branch and relays to the inverse hosts', async () => {
		const refusedBefore = getCounters().observers_server_shape_not_covered ?? 0;
		const hopBefore = getCounters().observers_component_to_search_missing ?? 0;
		const relayBagBefore = JSON.stringify(await bagOf(INV_OBS, REF_INV, REF_SECTION));
		await propagateToObservers(INV_SRC, TERM_SECTION, TERM_INV, { saved: [], removed: [] }, -1);
		// no longer the classifier's perform_not_covered refusal…
		expect((getCounters().observers_server_shape_not_covered ?? 0) - refusedBefore).toBe(0);
		// …but a relay to the ONE record referencing TERM_INV (REF_INV), whose hop
		// reached INV_OBS's own observer
		expect((getCounters().observers_component_to_search_missing ?? 0) - hopBefore).toBe(1);
		// identity save rules: the relay wrote nothing
		expect(JSON.stringify(await bagOf(INV_OBS, REF_INV, REF_SECTION))).toBe(relayBagBefore);
		expect(await tmCount(INV_OBS)).toBe(0);
	}, 30000);

	test('12d. a guard at maxDepth: the first-level re-save lands, the hop past the budget is refused LOUDLY', async () => {
		const depthBefore = getCounters().observers_cascade_depth_exceeded ?? 0;
		const hopBefore = getCounters().observers_component_to_search_missing ?? 0;
		await propagateToObservers(
			ORD_SRC,
			REF_SECTION,
			REF_A,
			{ saved: [{ section_tipo: TERM_SECTION, section_id: TERM_ORD_DEEP }], removed: [] },
			-1,
			new Date(),
			freshGuard(`${ORD_SRC}@${REF_SECTION}/${REF_A}`, MAX_CASCADE_DEPTH),
		);
		expect(idsOf(await bagOf(ORD_PORTAL, TERM_ORD_DEEP))).toEqual([
			REF_L_ALPHA,
			REF_L_BRAVO,
			REF_L_CHARLIE,
		]);
		expect((getCounters().observers_cascade_depth_exceeded ?? 0) - depthBefore).toBe(1);
		expect((getCounters().observers_component_to_search_missing ?? 0) - hopBefore).toBe(0);
	}, 30000);

	test('12e. a planted RING with a declared-order portal terminates, counted, the host written ONCE', async () => {
		const tmBefore = await tmRowsAt(RING_A, TERM_SECTION, RING_TERM);
		const cycleBefore = getCounters().observers_cascade_cycle_refused ?? 0;
		await propagateToObservers(RING_B, TERM_SECTION, RING_TERM, { saved: [], removed: [] }, -1);
		expect(idsOf(await bagOf(RING_A, RING_TERM))).toEqual([
			REF_L_ALPHA,
			REF_L_BRAVO,
			REF_L_CHARLIE,
		]);
		expect(await tmRowsAt(RING_A, TERM_SECTION, RING_TERM)).toBe(tmBefore + 1);
		expect((getCounters().observers_cascade_cycle_refused ?? 0) - cycleBefore).toBeGreaterThan(0);
	}, 30000);

	test('12f. a target whose section does not host the observer is skipped — no read, no write', async () => {
		const guard = freshGuard(`nonhost@${REF_SECTION}/${REF_ORD_NONHOST}`);
		const outcome = await resaveObserverThroughSaveRules(
			ORD_PORTAL,
			{ section_tipo: REF_SECTION, section_id: REF_ORD_NONHOST },
			-1,
			new Date(),
			guard,
		);
		expect(outcome).toBe('not_host');
		expect(idsOf(await bagOf(ORD_PORTAL, REF_ORD_NONHOST, REF_SECTION))).toEqual([
			REF_L_CHARLIE,
			REF_L_ALPHA,
			REF_L_BRAVO,
		]);
		expect(await tmRowsAt(ORD_PORTAL, REF_SECTION, REF_ORD_NONHOST)).toBe(0);
		// the visited/resaved set: a second call on the same guard is a dedup
		expect(
			await resaveObserverThroughSaveRules(
				ORD_PORTAL,
				{ section_tipo: REF_SECTION, section_id: REF_ORD_NONHOST },
				-1,
				new Date(),
				guard,
			),
		).toBe('deduped');
	});

	test('12g. resaved ≠ recomputed: a declared-order MIRROR gets BOTH the re-sort and the recompute, in either order', async () => {
		const sorted = [REF_L_ALPHA, REF_L_BRAVO, REF_L_CHARLIE];
		// Order 1 — the re-save first, then the mirror recompute, ONE guard.
		const first = freshGuard(`both@${TERM_SECTION}/${TERM_BOTH}`);
		expect(
			await resaveObserverThroughSaveRules(
				ORD_MIRROR,
				{ section_tipo: TERM_SECTION, section_id: TERM_BOTH },
				-1,
				new Date(),
				first,
			),
		).toBe('written');
		expect(idsOf(await bagOf(ORD_MIRROR, TERM_BOTH))).toEqual([REF_L_ALPHA, REF_L_BRAVO]);
		const recomputed = await recomputeMirrorAndHop(
			ORD_MIRROR,
			TERM_SECTION,
			TERM_BOTH,
			-1,
			new Date(),
			first,
			'on-write',
		);
		// a shared key would have answered `undefined` (already done) and left Charlie out
		expect(recomputed?.wrote).toBe(true);
		expect(idsOf(await bagOf(ORD_MIRROR, TERM_BOTH))).toEqual(sorted);

		// Order 2 — the mirror recompute first (its chokepoint write sorts),
		// then the re-save: it RUNS (finds the array in order), never a dedup.
		const second = freshGuard(`both@${TERM_SECTION}/${TERM_BOTH_2}`);
		const outcome = await recomputeMirrorAndHop(
			ORD_MIRROR,
			TERM_SECTION,
			TERM_BOTH_2,
			-1,
			new Date(),
			second,
			'on-write',
		);
		expect(outcome?.wrote).toBe(true);
		expect(idsOf(await bagOf(ORD_MIRROR, TERM_BOTH_2))).toEqual(sorted);
		expect(
			await resaveObserverThroughSaveRules(
				ORD_MIRROR,
				{ section_tipo: TERM_SECTION, section_id: TERM_BOTH_2 },
				-1,
				new Date(),
				second,
			),
		).toBe('unchanged');
	}, 30000);
});
