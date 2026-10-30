/**
 * The reconcile SWEEP itself — `reconcileObserverMirrors` end to end.
 *
 * Sibling file, different subject: `observer_reconcile_native.test.ts` gates
 * the value law (`recomputeExternalRelation`) and the pure budget predicate;
 * THIS file drives the SWEEP — discovery → candidate narrowing → the per-record
 * census fold → the apply/dry-run split — because the sweep is the offline door
 * that repairs mirrors the bulk writers bypass (the v6→v7 update and portalize,
 * and any door that states it does not propagate). A regression here is silent by construction: the CLI prints a clean
 * summary and the operator concludes the corpus is healthy.
 *
 * The three laws that only an EXECUTED sweep can gate:
 *   1. the dry-run / apply split — `apply:false` must report the drift and
 *      write NOTHING; `apply:true` must write the exact mirror bag and count it
 *      as repaired; a third run must converge to `drifted === 0`;
 *   2. `--id` narrows by MEMBERSHIP (candidateIds) — an id that is neither a
 *      referenced target nor a stored mirror holder yields NO candidate. A
 *      regression there lets `--id N --apply` recompute and WRITE a record that
 *      was never in the tuple's candidate set;
 *   3. `--section` narrows the DISCOVERED tuple set (discoverTuples' last line,
 *      applied AFTER the relation-index fan-out — filtering earlier starved the
 *      union, the recorded tchi1 bug).
 * Plus the degraded-seed census FOLD driven by a REAL degraded sweep (a
 * fabricated summary literal proves only the predicate), and the REFUSED-LAW
 * wholesale refusal — the branch that exists so a node the external-law
 * classifier refuses (ambiguous or malformed; both sub-laws are ported since
 * 2026-10-30) is never reported as clean.
 * Plus the COPY LAWS through the REAL IO (2026-10-30): source_overwrite
 * (testcoincatalog1019 on the catalog term, real + virtual face) and
 * observed_data (test6380 on the legend) — host-section discovery, the law's
 * candidate query (pointer holders ∪ slot holders / ddo holders ∪ slot
 * holders), the apply repair with ONE TM row, convergence and --id membership;
 * and a NON-HOST tuple (zzot4 @ zzot7) never swept — its stored slots counted
 * and left untouched even on apply (the strict host precondition). The
 * IO is the production one, only SPIED (candidateIds/recompute wrapped).
 *
 * Environment: suite DB. The anchor term comes from the shared fixture helper
 * (observer_term_seed.ts, a BUILT scratch situation); everything else is scratch —
 * referencer rows 91070/91071
 * and two `test9995x` dd_ontology observer nodes, all swept fail-loud in
 * afterAll. Nothing here asserts a table-global count.
 */
// BINDS INSTALL TLDs: on, rsc — install-specific fixtures, grandfathered in
// engineering/generic_tld_baseline.json (generic_tld_tripwire, shrink-only). This test
// is meaningful only on a database holding those installs' records. Migrate it to a
// built situation (src/core/test_data/situations) or the generic `test` TLD, then
// regenerate the baseline (`bun run scripts/generic_tld_baseline.ts`).

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { config } from '../../src/config/config.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { getMatrixTableFromTipo, getSectionRealTipo } from '../../src/core/ontology/resolver.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import { sectionDeclaresComponent } from '../../src/core/section/record/external_laws/resolvers.ts';
import {
	defaultReconcileIO,
	exceedsShrinkBudget,
	type ReconcileIO,
	type ReconcileRecord,
	reconcileObserverMirrors,
} from '../../src/core/section/record/observer_reconcile.ts';
import { saveComponentData } from '../../src/core/section/record/save_component.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import {
	ensureObserverTerm,
	INDEXER,
	MIRROR,
	REF_SECTION,
	SEED_TERM,
	TERM_SECTION,
	TERM_SECTION_B,
} from '../helpers/observer_term_seed.ts';
import { cleanScratchRecord } from '../helpers/test_data.ts';

/** Scratch referencer rows — this item's whole namespace. */
const REFERENCER_ID = 91070; // references the anchor through INDEXER (the bypass write)
const DEGRADED_HOLDER_ID = 91071; // holds one stale mirror entry for the scratch observer
/** Ids nothing references and nothing mirrors — the non-candidate probes. They
 * are never written to; if the membership filter regressed they would be. */
const NON_CANDIDATE_ID = 999_999_701;
const NON_CANDIDATE_TARGET = 999_999_702;

/** Scratch observer nodes (own band: the other observer gates use 9990x/9992x/9994x). */
const DEGRADED_OBSERVER = 'test99950';
const MISSING_PEER = 'test99959_no_such_node';
const SUBLAW_OBSERVER = 'test99951';
const SCRATCH_HOST = REF_SECTION;

/** Resolved once the fixture exists — the scratch sections own their table. */
let TERM_TABLE = 'matrix_test';
let REF_TABLE = 'matrix_test';
let seedHelperRan = false;
let anchorRows = -1;

/** Suite DB only for the ontology fixture: `test` is a REAL tld in production. */
const onSuiteDb = config.db.database.endsWith('_test');

/**
 * The fixture is ASSERTED, never skipped around. The old `skipUnlessPlanted`
 * existed because the anchor might be a REAL install term whose mirror an apply
 * sweep would rewrite; the anchor is now a scratch term this file builds
 * (test/helpers/observer_term_seed.ts), so there is nothing to protect and no
 * case may opt out. A missing fixture is a failure, not a skip.
 */
function requireFixture(): void {
	expect(seedHelperRan).toBe(true);
	expect(anchorRows).toBe(1);
}

function skipUnlessSuiteDb(caseName: string): boolean {
	expect(seedHelperRan).toBe(true);
	if (onSuiteDb) return false;
	console.warn(
		`observer_reconcile_sweep_native: NOT RUN — "${caseName}" (not the *_test suite DB: seeding a test999… ontology node would pollute a real ontology)`,
	);
	return true;
}

async function mirrorBag(): Promise<unknown[] | null> {
	const rows = (await sql.unsafe(
		`SELECT relation->($3::text) AS bag FROM "${TERM_TABLE}"
		 WHERE section_tipo = $1 AND section_id = $2`,
		[SEED_TERM.section_tipo, SEED_TERM.section_id, MIRROR],
	)) as { bag: unknown[] | null }[];
	return rows[0]?.bag ?? null;
}

/** The bypass write the sweep exists to heal: a raw referencer INSERT (the
 * import/migration shape — the relation-index trigger still indexes it, so the
 * reconciler's candidate query sees it while the save cascade never fired). */
async function insertReferencer(id: number): Promise<void> {
	await sql.unsafe(
		`INSERT INTO "${REF_TABLE}" (section_id, section_tipo, relation) VALUES ($1, $3, $2::text::jsonb)`,
		[
			id,
			JSON.stringify({
				[INDEXER]: [
					{
						id: 1,
						type: 'dd96',
						section_id: String(SEED_TERM.section_id),
						section_tipo: SEED_TERM.section_tipo,
						from_component_tipo: INDEXER,
					},
				],
			}),
			REF_SECTION,
		],
	);
}

async function sweepScratchRows(): Promise<void> {
	for (const id of [REFERENCER_ID, DEGRADED_HOLDER_ID]) {
		await sql.unsafe(`DELETE FROM "${REF_TABLE}" WHERE section_tipo = $2 AND section_id = $1`, [
			id,
			REF_SECTION,
		]);
		await sql.unsafe(
			`DELETE FROM matrix_time_machine WHERE section_tipo = $2 AND section_id = $1`,
			[id, REF_SECTION],
		);
	}
}

async function sweepScratchOntology(): Promise<void> {
	await sql.unsafe(`DELETE FROM dd_ontology WHERE tld = 'test' AND tipo = ANY($1::text[])`, [
		`{${DEGRADED_OBSERVER},${SUBLAW_OBSERVER}}`,
	]);
	const { clearOntologyDerivedCaches } = await import(
		'../../src/core/ontology/cache_invalidation.ts'
	);
	await clearOntologyDerivedCaches();
}

async function seedScratchOntology(): Promise<void> {
	// The covered reconcile shape: use_observable_dato + set_dato_external, host
	// pinned by the observe entry's OWN scope (resolution step 1) so the tuple is
	// deterministic. `data_from_field` names a peer with no ontology node — the
	// measured degraded-seed shape (`peer_node_missing:…`).
	await sql.unsafe(
		`INSERT INTO dd_ontology (id, tipo, parent, model, tld, properties)
		 VALUES ((SELECT COALESCE(MAX(id), 0) + 1400 FROM dd_ontology), $1, $3, 'component_autocomplete_hi', 'test', $2::text::jsonb)`,
		[
			DEGRADED_OBSERVER,
			JSON.stringify({
				observe: [
					{
						component_tipo: INDEXER,
						section_tipo: SCRATCH_HOST,
						server: {
							config: { use_observable_dato: true },
							perform: { function: 'set_dato_external' },
						},
					},
				],
				source: {
					data_from_field: [MISSING_PEER],
					section_to_search: [SCRATCH_HOST],
					component_to_search: [INDEXER],
				},
			}),
			// Parented under its host (the strict host precondition: the kernel
			// computes only where the section DECLARES the observer).
			SCRATCH_HOST,
		],
	);
	// Same covered shape, but its source carries a MALFORMED sub-law (a
	// boolean where set_observed_data's ddo list belongs — classifier refusal
	// observed_data_malformed): the tuple must be surfaced and REFUSED
	// wholesale, never swept.
	await sql.unsafe(
		`INSERT INTO dd_ontology (id, tipo, parent, model, tld, properties)
		 VALUES ((SELECT COALESCE(MAX(id), 0) + 1400 FROM dd_ontology), $1, 'test3', 'component_autocomplete_hi', 'test', $2::text::jsonb)`,
		[
			SUBLAW_OBSERVER,
			JSON.stringify({
				observe: [
					{
						component_tipo: INDEXER,
						section_tipo: SCRATCH_HOST,
						server: {
							config: { use_observable_dato: true },
							perform: { function: 'set_dato_external' },
						},
					},
				],
				source: {
					set_observed_data: true,
					section_to_search: [SCRATCH_HOST],
					component_to_search: [INDEXER],
				},
			}),
		],
	);
	const { clearOntologyDerivedCaches } = await import(
		'../../src/core/ontology/cache_invalidation.ts'
	);
	await clearOntologyDerivedCaches();
}

/**
 * The degraded observer's holder: one stale mirror entry pointing at a record
 * nothing references → the law wants to drop exactly 1, and the degraded seed
 * withholds exactly that drop. Seeded LATE (the refusal block's own beforeAll)
 * because the sweep block above spends the same scratch id as a referencer.
 */
async function seedDegradedHolder(): Promise<void> {
	await sql.unsafe(`DELETE FROM matrix WHERE section_tipo = $1 AND section_id = $2`, [
		SCRATCH_HOST,
		DEGRADED_HOLDER_ID,
	]);
	await sql.unsafe(`DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2`, [
		SCRATCH_HOST,
		DEGRADED_HOLDER_ID,
	]);
	// Idempotent: the holder id is reused across cases, and a bare INSERT trips
	// the (section_id, section_tipo) unique key on a re-plant.
	await sql.unsafe(`DELETE FROM "${REF_TABLE}" WHERE section_tipo = $1 AND section_id = $2`, [
		SCRATCH_HOST,
		DEGRADED_HOLDER_ID,
	]);
	await sql.unsafe(
		`INSERT INTO "${REF_TABLE}" (section_id, section_tipo, relation) VALUES ($1, $2, $3::text::jsonb)`,
		[
			DEGRADED_HOLDER_ID,
			SCRATCH_HOST,
			JSON.stringify({
				[DEGRADED_OBSERVER]: [
					{
						id: 1,
						type: 'dd151',
						section_id: String(NON_CANDIDATE_TARGET),
						section_tipo: SCRATCH_HOST,
						from_component_tipo: DEGRADED_OBSERVER,
					},
				],
			}),
		],
	);
}

beforeAll(async () => {
	await ensureObserverTerm();
	seedHelperRan = true;
	TERM_TABLE = (await getMatrixTableFromTipo(TERM_SECTION)) ?? 'matrix_test';
	REF_TABLE = (await getMatrixTableFromTipo(REF_SECTION)) ?? 'matrix_test';
	const anchor = (await sql.unsafe(
		`SELECT count(*)::int AS n FROM "${TERM_TABLE}" WHERE section_tipo = $1 AND section_id = $2`,
		[SEED_TERM.section_tipo, SEED_TERM.section_id],
	)) as { n: number }[];
	anchorRows = anchor[0]?.n ?? 0;
	// Residue tolerance: a crashed observer-gate run leaves scratch referencers
	// of the anchor behind and they inflate every recompute. The section is this
	// fixture's own, so every such row is scratch by construction.
	await sweepScratchRows();
	await insertReferencer(REFERENCER_ID);
	if (onSuiteDb) {
		await sweepScratchOntology();
		await seedScratchOntology();
	}
});

afterAll(async () => {
	await sweepScratchRows();
	if (onSuiteDb) await sweepScratchOntology();
	// FAIL LOUD: a cleanup that did not reach zero is a corrupted shared DB for
	// every other gate, and it must not be discovered by them.
	const leftMatrix = (await sql.unsafe(
		`SELECT count(*)::int AS n FROM "${REF_TABLE}" WHERE section_tipo = $2 AND section_id = ANY(string_to_array($1, ',')::int[])`,
		[`${REFERENCER_ID},${DEGRADED_HOLDER_ID}`, REF_SECTION],
	)) as { n: number }[];
	const leftTm = (await sql.unsafe(
		`SELECT count(*)::int AS n FROM matrix_time_machine WHERE section_tipo = $2 AND section_id = ANY(string_to_array($1, ',')::int[])`,
		[`${REFERENCER_ID},${DEGRADED_HOLDER_ID}`, REF_SECTION],
	)) as { n: number }[];
	const leftOntology = (await sql.unsafe(
		`SELECT count(*)::int AS n FROM dd_ontology WHERE tipo = ANY($1::text[])`,
		[`{${DEGRADED_OBSERVER},${SUBLAW_OBSERVER}}`],
	)) as { n: number }[];
	if (
		(leftMatrix[0]?.n ?? 0) !== 0 ||
		(leftTm[0]?.n ?? 0) !== 0 ||
		(leftOntology[0]?.n ?? 0) !== 0
	) {
		throw new Error(
			`observer_reconcile_sweep_native: scratch cleanup INCOMPLETE — matrix=${leftMatrix[0]?.n}, time_machine=${leftTm[0]?.n}, dd_ontology=${leftOntology[0]?.n}`,
		);
	}
});

describe('reconcileObserverMirrors — the dry-run / apply / converge life cycle', () => {
	test('apply:false REPORTS the drift and writes NOTHING', async () => {
		requireFixture();
		const records: ReconcileRecord[] = [];
		const lines: string[] = [];
		const summary = await reconcileObserverMirrors({
			onlyObserver: MIRROR,
			onlySection: SEED_TERM.section_tipo,
			onlyId: SEED_TERM.section_id,
			apply: false,
			onRecord: (record) => records.push(record),
			log: (line) => lines.push(line),
		});
		expect(summary.tuples).toBeGreaterThanOrEqual(1);
		expect(summary.candidates).toBe(1);
		expect(summary.drifted).toBe(1);
		expect(summary.repaired).toBe(0);
		// A pure GROW: nothing is dropped, so no census/budget channel moves.
		expect(summary.droppedRecords).toBe(0);
		expect(summary.droppedLocators).toBe(0);
		expect(summary.degradedSeedRecords).toBe(0);
		expect(summary.shrinksSkipped).toBe(0);
		expect(summary.bigResultRefused).toBe(0);
		expect(summary.sublawRefused).toBe(0);
		expect(records).toEqual([
			{
				observerTipo: MIRROR,
				hostSection: SEED_TERM.section_tipo,
				sectionId: SEED_TERM.section_id,
				before: 0,
				after: 1,
				dropped: 0,
				added: 1,
			},
		]);
		// The operator lines carry the per-record diff and the per-tuple tail, and
		// a dry run must not claim a repair.
		expect(lines.some((line) => line.includes('0 → 1 entrie(s)'))).toBe(true);
		expect(lines.some((line) => line.includes('1 candidate(s), 1 drifted'))).toBe(true);
		expect(lines.some((line) => line.includes('repaired'))).toBe(false);
		// THE ASSERTION THE DRY RUN EXISTS FOR: nothing was persisted.
		expect(await mirrorBag()).toBeNull();
	}, 30000);

	test('apply:true REPAIRS the record and writes the exact mirror bag', async () => {
		requireFixture();
		const lines: string[] = [];
		const summary = await reconcileObserverMirrors({
			onlyObserver: MIRROR,
			onlySection: SEED_TERM.section_tipo,
			onlyId: SEED_TERM.section_id,
			apply: true,
			log: (line) => lines.push(line),
		});
		expect(summary.candidates).toBe(1);
		expect(summary.drifted).toBe(1);
		expect(summary.repaired).toBe(1);
		expect(summary.shrinksSkipped).toBe(0);
		expect(summary.bigResultRefused).toBe(0);
		expect(lines.some((line) => line.includes('[repaired]'))).toBe(true);
		// The byte shape stored — id/type/section_id/section_tipo/
		// from_component_tipo, in that content. WC-2026-08-10-section-id-int-canonical:
		// the address is an INT now (the PHP oracle's string form is repealed).
		expect(await mirrorBag()).toEqual([
			{
				id: 1,
				type: 'dd151',
				section_id: REFERENCER_ID,
				section_tipo: REF_SECTION,
				from_component_tipo: MIRROR,
			},
		]);
	}, 30000);

	test('a third run CONVERGES: drifted 0, repaired 0, the bag untouched', async () => {
		requireFixture();
		const bagBefore = await mirrorBag();
		const records: ReconcileRecord[] = [];
		const summary = await reconcileObserverMirrors({
			onlyObserver: MIRROR,
			onlySection: SEED_TERM.section_tipo,
			onlyId: SEED_TERM.section_id,
			apply: true,
			onRecord: (record) => records.push(record),
		});
		// The candidate is still found (this is convergence, not a lost candidate).
		expect(summary.candidates).toBe(1);
		expect(summary.drifted).toBe(0);
		expect(summary.repaired).toBe(0);
		expect(records).toEqual([]);
		expect(await mirrorBag()).toEqual(bagBefore);
	}, 30000);

	test('a MASKED SWAP is reported by MEMBERSHIP and both halves are applied', async () => {
		requireFixture();
		// One referencer bypass-deleted, one bypass-inserted: the law drops exactly
		// one entry and appends exactly one, so before === after and a census that
		// read `before - after` would report ZERO drops — the corpus drop budget
		// would then sail past the exact shape it exists to catch.
		await sql.unsafe(`DELETE FROM "${REF_TABLE}" WHERE section_tipo = $2 AND section_id = $1`, [
			REFERENCER_ID,
			REF_SECTION,
		]);
		await insertReferencer(DEGRADED_HOLDER_ID);
		const records: ReconcileRecord[] = [];
		const dry = await reconcileObserverMirrors({
			onlyObserver: MIRROR,
			onlySection: SEED_TERM.section_tipo,
			onlyId: SEED_TERM.section_id,
			onRecord: (record) => records.push(record),
		});
		expect(dry.drifted).toBe(1);
		expect(records).toEqual([
			{
				observerTipo: MIRROR,
				hostSection: SEED_TERM.section_tipo,
				sectionId: SEED_TERM.section_id,
				before: 1,
				after: 1, // ← length delta 0; membership says 1 out, 1 in
				dropped: 1,
				added: 1,
			},
		]);
		expect(dry.droppedRecords).toBe(1);
		expect(dry.droppedLocators).toBe(1);
		// The seed is clean, so nothing withholds the drop…
		expect(dry.degradedSeedRecords).toBe(0);
		expect(dry.shrinksSkipped).toBe(0);
		// …and the reported volume busts a zero budget on both axes.
		expect(exceedsShrinkBudget(dry, { maxDroppedLocators: 0, maxDroppedRecords: 0 })).toHaveLength(
			2,
		);
		const applied = await reconcileObserverMirrors({
			onlyObserver: MIRROR,
			onlySection: SEED_TERM.section_tipo,
			onlyId: SEED_TERM.section_id,
			apply: true,
		});
		expect(applied.repaired).toBe(1);
		expect(applied.shrinksSkipped).toBe(0);
		// BOTH halves committed in one write: the stale entry is gone, the new one
		// carries the next item id.
		expect(await mirrorBag()).toEqual([
			{
				id: 2,
				type: 'dd151',
				// WC-2026-08-10-section-id-int-canonical: int address.
				section_id: DEGRADED_HOLDER_ID,
				section_tipo: REF_SECTION,
				from_component_tipo: MIRROR,
			},
		]);
	}, 30000);
});

describe('reconcileObserverMirrors — candidate + tuple narrowing', () => {
	test('--id narrows by MEMBERSHIP: a non-candidate id yields no candidate at all', async () => {
		requireFixture();
		// NON_CANDIDATE_ID holds no mirror and is referenced by nothing, so it is
		// NOT in the tuple's candidate union. An --id that trusted its argument
		// would recompute it — and under --apply WRITE a record outside the set.
		const records: ReconcileRecord[] = [];
		const miss = await reconcileObserverMirrors({
			onlyObserver: MIRROR,
			onlySection: SEED_TERM.section_tipo,
			onlyId: NON_CANDIDATE_ID,
			apply: true,
			onRecord: (record) => records.push(record),
		});
		expect(miss.tuples).toBeGreaterThanOrEqual(1); // the tuple IS discovered — not a vacuous pass
		expect(miss.candidates).toBe(0);
		expect(miss.drifted).toBe(0);
		expect(miss.repaired).toBe(0);
		expect(records).toEqual([]);
		// …and no row was conjured for it.
		const conjured = (await sql.unsafe(
			'SELECT count(*)::int AS n FROM matrix_hierarchy WHERE section_tipo = $1 AND section_id = $2',
			[SEED_TERM.section_tipo, NON_CANDIDATE_ID],
		)) as { n: number }[];
		expect(conjured[0]?.n).toBe(0);
		// Positive control on the SAME tuple: the anchor is a member (through both
		// halves of the union by now — referenced target and mirror holder).
		const hit = await reconcileObserverMirrors({
			onlyObserver: MIRROR,
			onlySection: SEED_TERM.section_tipo,
			onlyId: SEED_TERM.section_id,
		});
		expect(hit.candidates).toBe(1);
	}, 30000);

	test('--section narrows the DISCOVERED tuple set (filtered after the index fan-out)', async () => {
		requireFixture();
		// Every call passes a non-candidate --id: this case is about DISCOVERY and
		// must not cost a corpus-wide recompute.
		const unfiltered = await reconcileObserverMirrors({
			onlyObserver: MIRROR,
			onlyId: NON_CANDIDATE_ID,
		});
		// MIRROR is declared on the term section and the relation-index fan-out
		// adds every section INDEXER actually points into.
		expect(unfiltered.tuples).toBeGreaterThan(1);
		const oneHost = await reconcileObserverMirrors({
			onlyObserver: MIRROR,
			onlySection: SEED_TERM.section_tipo,
			onlyId: NON_CANDIDATE_ID,
		});
		expect(oneHost.tuples).toBe(1);
		// A section no tuple hosts at yields none: an operator's scope is a scope,
		// not a hint (a pass-through filter would hand back the whole union).
		const elsewhere = await reconcileObserverMirrors({
			onlyObserver: MIRROR,
			onlySection: 'zzz-no-such-section',
			onlyId: NON_CANDIDATE_ID,
		});
		expect(elsewhere.tuples).toBe(0);
		expect(elsewhere.candidates).toBe(0);
	}, 30000);
});

describe('reconcileObserverMirrors — the refusal census (scratch ontology fixture)', () => {
	beforeAll(async () => {
		if (onSuiteDb) await seedDegradedHolder();
	});

	test('a REAL degraded seed feeds the degradedSeedRecords fold the budget reads', async () => {
		if (skipUnlessSuiteDb('a REAL degraded seed feeds the degradedSeedRecords fold')) return;
		const records: ReconcileRecord[] = [];
		const lines: string[] = [];
		const summary = await reconcileObserverMirrors({
			onlyObserver: DEGRADED_OBSERVER,
			onlySection: SCRATCH_HOST,
			onlyId: DEGRADED_HOLDER_ID,
			onRecord: (record) => records.push(record),
			log: (line) => lines.push(line),
		});
		expect(summary.tuples).toBe(1);
		expect(summary.candidates).toBe(1);
		expect(summary.drifted).toBe(1);
		// THE FOLD, produced by an EXECUTED sweep rather than a hand-built literal:
		// the withheld record is counted as degraded AND as a wanted drop.
		expect(summary.degradedSeedRecords).toBe(1);
		expect(summary.shrinksSkipped).toBe(1);
		expect(summary.droppedRecords).toBe(1);
		expect(summary.droppedLocators).toBe(1);
		expect(summary.repaired).toBe(0);
		expect(summary.bigResultRefused).toBe(0);
		expect(summary.sublawRefused).toBe(0);
		// The census channel names the CAUSE (a drop budget adjudicated by one
		// total cannot tell a genuine removal from a broken ontology).
		expect(records).toEqual([
			{
				observerTipo: DEGRADED_OBSERVER,
				hostSection: SCRATCH_HOST,
				sectionId: DEGRADED_HOLDER_ID,
				before: 1,
				after: 0,
				dropped: 1,
				added: 0,
				seedDefects: [`peer_node_missing:${MISSING_PEER}`],
				refusal: 'degraded_seed',
			},
		]);
		expect(lines.some((line) => line.includes('SHRINK held — DEGRADED SEED'))).toBe(true);
		// …and the number this sweep produced is the one the budget refuses,
		// however generous the ceilings.
		expect(
			exceedsShrinkBudget(summary, {
				maxDroppedLocators: 1_000_000,
				maxDroppedRecords: 1_000_000,
			}),
		).toHaveLength(1);
		// Withheld ⇒ still stored (and this was a dry run besides).
		const rows = (await sql.unsafe(
			`SELECT relation->($3::text) AS bag FROM "${REF_TABLE}" WHERE section_tipo = $1 AND section_id = $2`,
			[SCRATCH_HOST, DEGRADED_HOLDER_ID, DEGRADED_OBSERVER],
		)) as { bag: unknown[] | null }[];
		expect(rows[0]?.bag).toHaveLength(1);
	}, 30000);

	test('an APPLY over a degraded seed still withholds the drop and repairs NOTHING', async () => {
		if (skipUnlessSuiteDb('an APPLY over a degraded seed still withholds the drop')) return;
		// The withholding is the KERNEL's, not the dry run's: apply mode must reach
		// the same refusal, count it, and leave the stored entry alone. A mutant
		// that counts a withheld record as repaired dies here.
		const summary = await reconcileObserverMirrors({
			onlyObserver: DEGRADED_OBSERVER,
			onlySection: SCRATCH_HOST,
			onlyId: DEGRADED_HOLDER_ID,
			apply: true,
		});
		expect(summary.drifted).toBe(1);
		expect(summary.shrinksSkipped).toBe(1);
		expect(summary.degradedSeedRecords).toBe(1);
		expect(summary.repaired).toBe(0);
		const rows = (await sql.unsafe(
			`SELECT relation->($3::text) AS bag FROM "${REF_TABLE}" WHERE section_tipo = $1 AND section_id = $2`,
			[SCRATCH_HOST, DEGRADED_HOLDER_ID, DEGRADED_OBSERVER],
		)) as { bag: unknown[] | null }[];
		expect(rows[0]?.bag).toEqual([
			{
				id: 1,
				type: 'dd151',
				section_id: String(NON_CANDIDATE_TARGET),
				section_tipo: SCRATCH_HOST,
				from_component_tipo: DEGRADED_OBSERVER,
			},
		]);
	}, 30000);

	test('a REFUSED-LAW (malformed sub-law) tuple is REFUSED wholesale — never swept, never reported clean', async () => {
		if (skipUnlessSuiteDb('a REFUSED-LAW tuple is REFUSED wholesale')) return;
		const records: ReconcileRecord[] = [];
		const lines: string[] = [];
		const summary = await reconcileObserverMirrors({
			onlyObserver: SUBLAW_OBSERVER,
			onlySection: SCRATCH_HOST,
			apply: true,
			onRecord: (record) => records.push(record),
			log: (line) => lines.push(line),
		});
		expect(summary.tuples).toBe(1); // surfaced…
		expect(summary.sublawRefused).toBe(1); // …and refused (the key now counts every refused law)
		// Not swept at all: no candidate query, no recompute, no "0 drifted" that
		// an operator would read as clean.
		expect(summary.candidates).toBe(0);
		expect(summary.drifted).toBe(0);
		expect(summary.repaired).toBe(0);
		expect(records).toEqual([]);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain('REFUSED');
		expect(lines[0]).toContain('set_observed_data');
		expect(lines[0]).toContain('observed_data_malformed');
	}, 30000);
});

// ---------------------------------------------------------------------------
// The COPY LAWS and the NON-HOST branch through the REAL IO (2026-10-30)
// ---------------------------------------------------------------------------

const USER_ID = -1;
const COPY_TERM = 'testcoincatalog1';
/** VIRTUAL face of testcoincatalog1 (test6409 → testcoincatalog1). */
const COPY_TERM_VIRTUAL = 'test6409';
const COPY_POINTER = 'testcoincatalog1004';
const ORDERED_COPY = 'testcoincatalog1019';
const TYPE_SECTION = 'test6099';
const TYPE_ORDERED = 'test6105';
const ORDERED_SECTION = 'test6310';
const LEGEND_SECTION = 'test6124';
const LEGEND_TEXT = 'test6263';
const TAG_SLOT = 'test6380';
const COIN_SECTION = 'test6100';
const PAYLOAD_COMPONENT = 'test6232';

const copyCreated: { sectionTipo: string; sectionId: number }[] = [];
const copyTables = new Map<string, string>();

async function copyTableOf(sectionTipo: string): Promise<string> {
	const known = copyTables.get(sectionTipo);
	if (known !== undefined) return known;
	const table = await getMatrixTableFromTipo(sectionTipo);
	if (table === null) throw new Error(`no matrix table for ${sectionTipo}`);
	copyTables.set(sectionTipo, table);
	return table;
}

async function bornCopy(sectionTipo: string): Promise<number> {
	const sectionId = await createSectionRecord(sectionTipo, USER_ID);
	copyCreated.push({ sectionTipo, sectionId });
	return sectionId;
}

const copyLocator = (from: string, sectionTipo: string, sectionId: number, type = 'dd151') => ({
	type,
	section_tipo: sectionTipo,
	section_id: String(sectionId),
	from_component_tipo: from,
});

async function saveCopyRelation(
	componentTipo: string,
	sectionTipo: string,
	sectionId: number,
	value: unknown[],
): Promise<void> {
	const saved = await saveComponentData({
		componentTipo,
		sectionTipo,
		sectionId,
		lang: 'lg-nolan',
		changedData: [{ action: 'set_data', id: null, value }] as never,
		userId: USER_ID,
	});
	expect(saved.ok, saved.message).toBe(true);
}

type Item = Record<string, unknown>;

async function storedKey(
	sectionTipo: string,
	sectionId: number,
	key: string,
): Promise<Item[] | null> {
	const rows = (await sql.unsafe(
		`SELECT relation->$3 AS value FROM "${await copyTableOf(sectionTipo)}" WHERE section_tipo = $1 AND section_id = $2`,
		[sectionTipo, sectionId, key],
	)) as { value: unknown }[];
	const value = rows[0]?.value;
	return Array.isArray(value) ? (value as Item[]) : null;
}

/** RAW relation-key write (the bypass the sweep heals): no door, no propagation. */
async function plantKey(
	sectionTipo: string,
	sectionId: number,
	key: string,
	value: unknown[],
): Promise<void> {
	await assertTestDatabase('observer_reconcile_sweep_native.plantKey');
	await sql.unsafe(
		`UPDATE "${await copyTableOf(sectionTipo)}" SET relation = jsonb_set(COALESCE(relation, '{}'::jsonb), ARRAY[$3::text], $4::text::jsonb)
		 WHERE section_tipo = $1 AND section_id = $2`,
		[sectionTipo, sectionId, key, JSON.stringify(value)],
	);
}

async function copyTmRows(sectionTipo: string, sectionId: number, tipo: string): Promise<number> {
	const rows = (await sql.unsafe(
		'SELECT count(*)::int AS n FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2 AND tipo = $3',
		[sectionTipo, sectionId, tipo],
	)) as { n: number }[];
	return rows[0]?.n ?? 0;
}

const addressesOf = (items: Item[] | null): string[] =>
	(items ?? []).map((item) => `${String(item.section_tipo)}/${String(Number(item.section_id))}`);

/** The production IO, SPIED: every tuple's candidate set and every visited id are recorded. */
function spiedIO(): {
	io: ReconcileIO;
	tuples: { hostSection: string; host: boolean; law: string; ids: number[] }[];
	visited: string[];
} {
	const tuples: { hostSection: string; host: boolean; law: string; ids: number[] }[] = [];
	const visited: string[] = [];
	const io: ReconcileIO = {
		...defaultReconcileIO,
		async candidateIds(tuple, hostTable, onlyId) {
			const ids = await defaultReconcileIO.candidateIds(tuple, hostTable, onlyId);
			tuples.push({ hostSection: tuple.hostSection, host: tuple.host, law: tuple.law.kind, ids });
			return ids;
		},
		recompute(observerTipo, hostSection, id, userId, at, opts) {
			visited.push(`${hostSection}/${id}`);
			return defaultReconcileIO.recompute(observerTipo, hostSection, id, userId, at, opts);
		},
	};
	return { io, tuples, visited };
}

/** The INDEPENDENT truth of the source_overwrite candidate set at one section:
 * records whose pointer is non-empty ∪ records storing the copy key. */
async function expectedCopyCandidates(sectionTipo: string): Promise<number[]> {
	const rows = (await sql.unsafe(
		`SELECT section_id AS id FROM "${await copyTableOf(sectionTipo)}"
		 WHERE section_tipo = $1
		   AND (relation ? $2
		        OR (jsonb_typeof(relation->$3) = 'array' AND jsonb_array_length(relation->$3) > 0))
		 ORDER BY section_id`,
		[sectionTipo, ORDERED_COPY, COPY_POINTER],
	)) as { id: number }[];
	return rows.map((row) => Number(row.id));
}

const svgTag = (tagId: number, sectionId: number) =>
	`[svg-n-${tagId}--data:{'section_tipo':'${COIN_SECTION}','section_id':'${sectionId}','component_tipo':'${PAYLOAD_COMPONENT}'}:data]`;

let typeA = 0;
let orderedA1 = 0;
let orderedA2 = 0;
let termReal = 0;
let termVirtual = 0;
/** A pointer holder whose slot was never computed (raw pointer write). */
let termPointerOnly = 0;
/** A slot holder with no pointer (raw slot write). */
let termSlotOnly = 0;
/** Neither pointer nor slot — the --id non-candidate. */
let termBare = 0;
let legend = 0;
let legendCoin1 = 0;
let legendCoin2 = 0;
/** zzot7 records: the NON-HOST face of zzot4. */
let nonHostHolder = 0;
let nonHostTarget = 0;
let nonHostReferencer = 0;

describe('reconcileObserverMirrors — the COPY LAWS and the NON-HOST branch, real IO', () => {
	beforeAll(async () => {
		typeA = await bornCopy(TYPE_SECTION);
		orderedA1 = await bornCopy(ORDERED_SECTION);
		orderedA2 = await bornCopy(ORDERED_SECTION);
		await saveCopyRelation(TYPE_ORDERED, TYPE_SECTION, typeA, [
			copyLocator(TYPE_ORDERED, ORDERED_SECTION, orderedA1),
			copyLocator(TYPE_ORDERED, ORDERED_SECTION, orderedA2),
		]);
		termReal = await bornCopy(COPY_TERM);
		termVirtual = await bornCopy(COPY_TERM_VIRTUAL);
		for (const [section, term] of [
			[COPY_TERM, termReal],
			[COPY_TERM_VIRTUAL, termVirtual],
		] as const) {
			await saveCopyRelation(COPY_POINTER, section, term, [
				copyLocator(COPY_POINTER, TYPE_SECTION, typeA),
			]);
			// THE DRIFT: the stored copy lost its second item (a bypass write).
			const bag = (await storedKey(section, term, ORDERED_COPY)) ?? [];
			expect(addressesOf(bag), 'FLOOR: the door filled the copy').toEqual([
				`${ORDERED_SECTION}/${orderedA1}`,
				`${ORDERED_SECTION}/${orderedA2}`,
			]);
			await plantKey(section, term, ORDERED_COPY, bag.slice(0, 1));
		}
		termPointerOnly = await bornCopy(COPY_TERM);
		await plantKey(COPY_TERM, termPointerOnly, COPY_POINTER, [
			{ id: 1, ...copyLocator(COPY_POINTER, TYPE_SECTION, typeA), section_id: typeA },
		]);
		termSlotOnly = await bornCopy(COPY_TERM);
		await plantKey(COPY_TERM, termSlotOnly, ORDERED_COPY, [
			{ id: 1, ...copyLocator(ORDERED_COPY, ORDERED_SECTION, orderedA1), section_id: orderedA1 },
		]);
		termBare = await bornCopy(COPY_TERM);

		legendCoin1 = await bornCopy(COIN_SECTION);
		legendCoin2 = await bornCopy(COIN_SECTION);
		legend = await bornCopy(LEGEND_SECTION);
		const lang = config.lang.dataLangDefault;
		const saved = await saveComponentData({
			componentTipo: LEGEND_TEXT,
			sectionTipo: LEGEND_SECTION,
			sectionId: legend,
			lang,
			changedData: [
				{
					action: 'set_data',
					value: [
						{ id: 1, lang, value: `<p>${svgTag(1, legendCoin1)} ${svgTag(2, legendCoin2)}</p>` },
					],
				},
			] as never,
			userId: USER_ID,
		});
		expect(saved.ok, saved.message).toBe(true);
		expect(
			(await storedKey(LEGEND_SECTION, legend, TAG_SLOT))?.map((item) => Number(item.section_id)),
			'FLOOR: the door filled the tag slot',
		).toEqual([legendCoin1, legendCoin2]);
		// THE DRIFT: the slot key is gone altogether — the legend is a candidate
		// ONLY through its ddo column (the text), not as a slot holder.
		await assertTestDatabase('observer_reconcile_sweep_native.dropKey');
		await sql.unsafe(
			`UPDATE "${await copyTableOf(LEGEND_SECTION)}" SET relation = relation - $3::text WHERE section_tipo = $1 AND section_id = $2`,
			[LEGEND_SECTION, legend, TAG_SLOT],
		);
		expect(await storedKey(LEGEND_SECTION, legend, TAG_SLOT), 'FLOOR: no slot key').toBeNull();

		// The NON-HOST face: zzot7 does not declare zzot4 (its parent is zzot1).
		nonHostHolder = await bornCopy(TERM_SECTION_B);
		nonHostTarget = await bornCopy(TERM_SECTION_B);
		await plantKey(TERM_SECTION_B, nonHostHolder, MIRROR, [
			{
				id: 1,
				type: 'dd151',
				section_tipo: REF_SECTION,
				section_id: 1,
				from_component_tipo: MIRROR,
			},
		]);
		// A referencer pointing at the non-holder: the HOST law would make it a
		// candidate (a referenced target); the non-host branch must not.
		nonHostReferencer = await bornCopy(REF_SECTION);
		await plantKey(REF_SECTION, nonHostReferencer, INDEXER, [
			{
				id: 1,
				type: 'dd96',
				section_tipo: TERM_SECTION_B,
				section_id: String(nonHostTarget),
				from_component_tipo: INDEXER,
			},
		]);
	}, 180_000);

	afterAll(async () => {
		for (const { sectionTipo, sectionId } of copyCreated.reverse()) {
			await cleanScratchRecord(sectionTipo, sectionId, await copyTableOf(sectionTipo));
		}
	}, 120_000);

	test('source_overwrite: the tuple set lists the host sections — the VIRTUAL face included — all adjudicated hosts', async () => {
		const spy = spiedIO();
		const summary = await reconcileObserverMirrors(
			{ onlyObserver: ORDERED_COPY, onlyId: NON_CANDIDATE_ID },
			spy.io,
		);
		expect(summary.sublawRefused).toBe(0);
		const sections = spy.tuples.map((tuple) => tuple.hostSection);
		expect(sections).toContain(COPY_TERM);
		expect(sections).toContain(COPY_TERM_VIRTUAL);
		// EXACT: the real section and its virtual faces — every host's real tipo
		// is the term section. A TLD root `<tld>0` (the fixture parents
		// testcoincatalog1 under testcoincatalog0) is an ontology-record section,
		// never a host of a content mirror (declared_components.ts header).
		for (const section of sections) {
			expect(
				await getSectionRealTipo(section),
				`${section} hosts ${ORDERED_COPY} but is not a face of ${COPY_TERM}`,
			).toBe(COPY_TERM);
		}
		expect(sections.filter((section) => /^[a-z]+0$/.test(section))).toEqual([]);
		expect(await sectionDeclaresComponent(`${COPY_TERM.replace(/1$/, '')}0`, ORDERED_COPY)).toBe(
			false,
		);
		for (const tuple of spy.tuples) {
			expect(tuple.law).toBe('source_overwrite');
			expect(tuple.host, `${tuple.hostSection} declares ${ORDERED_COPY}`).toBe(true);
		}
		// --id membership: a non-candidate id visits nothing anywhere.
		expect(spy.visited).toEqual([]);
	}, 60_000);

	test('source_overwrite: candidates = pointer holders ∪ slot holders (a dry run writes nothing)', async () => {
		const spy = spiedIO();
		const beforeReal = await storedKey(COPY_TERM, termReal, ORDERED_COPY);
		const summary = await reconcileObserverMirrors(
			{ onlyObserver: ORDERED_COPY, onlySection: COPY_TERM, apply: false },
			spy.io,
		);
		expect(summary.tuples).toBe(1);
		const ids = spy.tuples[0]?.ids ?? [];
		expect(ids, 'the law’s candidate query disagrees with the stored truth').toEqual(
			await expectedCopyCandidates(COPY_TERM),
		);
		// …and the truth holds each shape this file planted.
		expect(ids).toContain(termReal); // pointer + stale slot
		expect(ids).toContain(termPointerOnly); // pointer, slot never computed
		expect(ids).toContain(termSlotOnly); // slot, no pointer
		expect(ids).not.toContain(termBare); // neither
		expect(summary.repaired).toBe(0);
		expect(await storedKey(COPY_TERM, termReal, ORDERED_COPY)).toEqual(beforeReal);
		expect(await storedKey(COPY_TERM, termPointerOnly, ORDERED_COPY)).toBeNull();
	}, 120_000);

	for (const [label, section, termOf] of [
		['REAL term', COPY_TERM, () => termReal],
		['VIRTUAL term (test6409)', COPY_TERM_VIRTUAL, () => termVirtual],
	] as const) {
		test(`source_overwrite @ ${label}: apply repairs the drift with ONE TM row; a second run is 0 drifted`, async () => {
			const term = termOf();
			const tmBefore = await copyTmRows(section, term, ORDERED_COPY);
			const lines: string[] = [];
			const applied = await reconcileObserverMirrors({
				onlyObserver: ORDERED_COPY,
				onlySection: section,
				onlyId: term,
				apply: true,
				log: (line) => lines.push(line),
			});
			expect(applied.candidates).toBe(1);
			expect(applied.drifted).toBe(1);
			expect(applied.repaired).toBe(1);
			expect(applied.shrinksSkipped).toBe(0);
			expect(lines.some((line) => line.includes('[repaired]'))).toBe(true);
			expect(addressesOf(await storedKey(section, term, ORDERED_COPY))).toEqual([
				`${ORDERED_SECTION}/${orderedA1}`,
				`${ORDERED_SECTION}/${orderedA2}`,
			]);
			expect(await copyTmRows(section, term, ORDERED_COPY), 'one TM row per repair').toBe(
				tmBefore + 1,
			);
			const again = await reconcileObserverMirrors({
				onlyObserver: ORDERED_COPY,
				onlySection: section,
				onlyId: term,
				apply: true,
			});
			expect(again.candidates).toBe(1);
			expect(again.drifted).toBe(0);
			expect(again.repaired).toBe(0);
			expect(await copyTmRows(section, term, ORDERED_COPY)).toBe(tmBefore + 1);
		}, 120_000);
	}

	test('source_overwrite: --id narrows by MEMBERSHIP — a bare term is no candidate and gets no slot', async () => {
		const miss = await reconcileObserverMirrors({
			onlyObserver: ORDERED_COPY,
			onlySection: COPY_TERM,
			onlyId: termBare,
			apply: true,
		});
		expect(miss.tuples).toBe(1);
		expect(miss.candidates).toBe(0);
		expect(miss.repaired).toBe(0);
		expect(await storedKey(COPY_TERM, termBare, ORDERED_COPY)).toBeNull();
		// Positive control: the pointer-only holder IS a member, and apply fills it.
		const hit = await reconcileObserverMirrors({
			onlyObserver: ORDERED_COPY,
			onlySection: COPY_TERM,
			onlyId: termPointerOnly,
			apply: true,
		});
		expect(hit.candidates).toBe(1);
		expect(hit.repaired).toBe(1);
		expect(addressesOf(await storedKey(COPY_TERM, termPointerOnly, ORDERED_COPY))).toEqual([
			`${ORDERED_SECTION}/${orderedA1}`,
			`${ORDERED_SECTION}/${orderedA2}`,
		]);
	}, 120_000);

	test('observed_data: the legend tuple is a host; apply repairs test6380 with ONE TM row; a second run is 0 drifted', async () => {
		const spy = spiedIO();
		const dry = await reconcileObserverMirrors(
			{ onlyObserver: TAG_SLOT, onlySection: LEGEND_SECTION, onlyId: legend },
			spy.io,
		);
		expect(spy.tuples.map((tuple) => [tuple.hostSection, tuple.host, tuple.law])).toEqual([
			[LEGEND_SECTION, true, 'observed_data'],
		]);
		expect(
			spy.tuples[0]?.ids,
			'the observed_data candidate query missed a record whose ddo column carries the text',
		).toEqual([legend]);
		expect(dry.drifted).toBe(1);
		const tmBefore = await copyTmRows(LEGEND_SECTION, legend, TAG_SLOT);
		const applied = await reconcileObserverMirrors({
			onlyObserver: TAG_SLOT,
			onlySection: LEGEND_SECTION,
			onlyId: legend,
			apply: true,
		});
		expect(applied.repaired).toBe(1);
		expect(
			(await storedKey(LEGEND_SECTION, legend, TAG_SLOT))?.map((item) => Number(item.section_id)),
		).toEqual([legendCoin1, legendCoin2]);
		expect(await copyTmRows(LEGEND_SECTION, legend, TAG_SLOT)).toBe(tmBefore + 1);
		const again = await reconcileObserverMirrors({
			onlyObserver: TAG_SLOT,
			onlySection: LEGEND_SECTION,
			onlyId: legend,
			apply: true,
		});
		expect(again.candidates).toBe(1);
		expect(again.drifted).toBe(0);
		expect(await copyTmRows(LEGEND_SECTION, legend, TAG_SLOT)).toBe(tmBefore + 1);
	}, 120_000);

	test('a NON-HOST tuple (zzot4 @ zzot7) is NEVER swept: its stored slots are COUNTED, left untouched even on apply, and tagged so', async () => {
		const holders = (await sql.unsafe(
			`SELECT section_id AS id FROM "${await copyTableOf(TERM_SECTION_B)}" WHERE section_tipo = $1 AND relation ? $2 ORDER BY section_id`,
			[TERM_SECTION_B, MIRROR],
		)) as { id: number }[];
		const stored = holders.map((row) => Number(row.id));
		expect(stored, 'FLOOR: the non-host holder carries the planted slot').toContain(nonHostHolder);
		const slotBefore = await storedKey(TERM_SECTION_B, nonHostHolder, MIRROR);
		expect(slotBefore, 'FLOOR: the planted slot is stored').not.toBeNull();
		const tmBefore = await copyTmRows(TERM_SECTION_B, nonHostHolder, MIRROR);
		// STRICT host precondition (owner ruling 2026-10-30): the slot is NOT the
		// section's value (zzot7 does not declare zzot4), so even an APPLY must
		// neither recompute nor rewrite it — and must say how many stay.
		for (const apply of [false, true]) {
			const spy = spiedIO();
			const lines: string[] = [];
			const summary = await reconcileObserverMirrors(
				{
					onlyObserver: MIRROR,
					onlySection: TERM_SECTION_B,
					apply,
					log: (line) => lines.push(line),
				},
				spy.io,
			);
			expect(spy.tuples.map((tuple) => [tuple.hostSection, tuple.host])).toEqual([
				[TERM_SECTION_B, false],
			]);
			expect(spy.visited, `a non-host tuple was recomputed (apply=${apply})`).toEqual([]);
			expect(summary.notHostSlots, 'the stored non-host slots were not counted').toBe(
				stored.length,
			);
			expect(summary.candidates).toBe(0);
			expect(summary.drifted).toBe(0);
			expect(summary.repaired).toBe(0);
			expect(
				lines.some(
					(line) =>
						line.startsWith(`- ${MIRROR} @ ${TERM_SECTION_B}`) &&
						line.includes('[not a host]') &&
						line.includes(`${stored.length} stored slot(s) left untouched`),
				),
				'the report does not say the non-host slots stay as stored',
			).toBe(true);
		}
		expect(
			await storedKey(TERM_SECTION_B, nonHostHolder, MIRROR),
			'an apply rewrote a slot its section does not declare',
		).toEqual(slotBefore);
		expect(
			await copyTmRows(TERM_SECTION_B, nonHostHolder, MIRROR),
			'an apply wrote a TM row on a non-host record',
		).toBe(tmBefore);
		// --id narrowing on the non-host branch: the referenced non-holder is no slot.
		const narrowed = spiedIO();
		const narrowedSummary = await reconcileObserverMirrors(
			{ onlyObserver: MIRROR, onlySection: TERM_SECTION_B, onlyId: nonHostTarget },
			narrowed.io,
		);
		expect(narrowed.tuples[0]?.ids).toEqual([]);
		expect(narrowed.visited).toEqual([]);
		expect(narrowedSummary.notHostSlots).toBe(0);
	}, 60_000);
});
