/**
 * Observer mirror RECONCILE law — TS-native gate for the exported
 * recomputeExternalRelation (the one law both the live save cascade and
 * scripts/observer_reconcile.ts replay).
 *
 * Scenario pinned = the reported production drift (dc1 §2, 2026-07-24): a
 * referencing record written WITHOUT the save chokepoint (raw INSERT — the
 * bulk-import/migration shape; the matrix_relation_index trigger still
 * indexes it) leaves the term's hierarchy93 mirror missing. The gate drives
 * the reconcile law through its full life cycle:
 *   dry-run detects the drift without writing → repair writes the exact
 *   mirror byte-shape + the TM audit pair → second run is a no-op
 *   (idempotent) → a masked swap (one referencer bypass-deleted, another
 *   bypass-inserted) proves the adjudication is MEMBERSHIP-based, not
 *   length-based, and that BOTH halves now persist → a pure bypass DELETE
 *   makes the recompute a shrink, and THE SHRINK APPLIES → duplicating the
 *   term proves covered-observer mirror slots are STRIPPED at copy (empty by
 *   construction — never the source's byte-copied referencer bag).
 *
 * 2026-08-06: the blanket GROW-ONLY fail-safe and its `allowShrink` opt-in are
 * RETIRED (see observer_failsafe_native.test.ts's header for why). The two
 * shrink tests here used to assert that a legitimate removal was WITHHELD;
 * they now assert it is applied, which is the regression guard for the
 * reported numisdata36 equivalence bug. The only remaining withholder is a
 * DEGRADED SEED, gated in the failsafe file.
 *
 * Environment: suite DB. Every section, component and record is built by this
 * file — a reserved `zzobs` scratch ontology (situations/situation.ts) whose
 * records land in whatever table the section's own `matrix_table` resolves to —
 * and `dropSituation` sweeps it whole in afterAll, with the residue ASSERTED 0.
 */
// Migrated to the generic `test` TLD 2026-08-20 (AGENTS.md hard rules). The
// shipped edge this drove — hierarchy93 ← rsc387, hosted at the install section
// `on1` (matrix_hierarchy, planted by test/helpers/observer_term_seed.ts) with
// referencers on `rsc205` (matrix) — is rebuilt here as MIRROR ← INDEXER on two
// scratch sections carrying the `test24` matrix_table relation, so every record
// lands in `matrix_test`. The observer properties are copied field for field
// from the shipped pair (component_autocomplete_hi + config_relation dd96 on
// one side; component_autocomplete + use_observable_dato + set_dato_external on
// the other).
//
// The `--section` narrowing case needed a MULTI-HOST observer, which it took
// from hierarchy93's three shipped forward specs (on1/ts1/dc1) — a fact of one
// install's ontology. INDEXER now declares TWO forward specs of its own
// (TERM_SECTION and TERM_SECTION_B), so the multi-tuple/one-tuple contrast is
// built rather than borrowed.
//
// The `planted` guard and skipUnlessPlanted() went with the migration. They
// existed because on a restored live snapshot `on1/58` is a REAL record whose
// mirror a repair write would silently rewrite; the sections here exist because
// this file created them, so there is no such record and no case may skip.
// skipUnlessSuiteDb() below is UNCHANGED — it guards dd_ontology writes, which
// is a different hazard.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../../src/config/config.ts';
import { getCounters } from '../../src/core/api/counters.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { getMatrixTableFromTipo } from '../../src/core/ontology/resolver.ts';
import { recomputeExternalRelation } from '../../src/core/section/record/observers.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';

// --- the situation this file BUILDS (reserved scratch TLD `zzobs`) ---------
// `situation()` refuses a tld that is not `zz*` (src/core/test_data/situations/
// situation.ts RESERVED_TLD): a scratch ontology must be unmistakably scratch,
// so it can be dropped whole. The observer PROPERTIES below are copied field
// for field from the shipped pair this gate used to drive (hierarchy93 ←
// rsc387), which is what keeps the law under test the shipped one.
/** The observer's HOST section — the term whose mirror is reconciled. */
const TERM_SECTION = 'zzobs1';
/** A SECOND host, so INDEXER is a genuinely multi-host observer (--section). */
const TERM_SECTION_B = 'zzobs2';
/** The referencing section (the `rsc205` role). */
const REF_SECTION = 'zzobs3';
/** component_autocomplete_hi, dd96 — the observed (the `rsc387` role). */
const INDEXER = 'zzobs4';
/** component_autocomplete, set_dato_external — the observer (`hierarchy93`). */
const MIRROR = 'zzobs5';

/** The term whose mirror every case below reconciles. */
const SEED_TERM = { section_tipo: TERM_SECTION, section_id: 58 };

const REFERENCER_ID = 91070; // scratch REF_SECTION rows, clear of every other band
const REFERENCER_ID2 = 91071;

/**
 * Where the scratch sections store. RESOLVED, never assumed: the engine places
 * a record by the section's own `matrix_table` relation, and a gate that
 * hard-codes the wrong table writes somewhere the engine would never look.
 */
let SCRATCH_TABLE = 'matrix';

const SITUATION = situation({
	tld: 'zzobs',
	name: 'observer mirror reconcile law',
	nodes: [
		{ tipo: TERM_SECTION, model: 'section', parent: 'dd14' },
		{ tipo: TERM_SECTION_B, model: 'section', parent: 'dd14' },
		{ tipo: REF_SECTION, model: 'section', parent: 'dd14' },
		{
			// The OBSERVED side: an indexer whose relation type is dd96 and which
			// declares its forward observer specs. TWO hosts, so the `--section`
			// narrowing case has a real multi-tuple set to narrow (the shipped
			// rsc387 took its three from on1/ts1/dc1 — one install's ontology).
			tipo: INDEXER,
			model: 'component_autocomplete_hi',
			parent: REF_SECTION,
			properties: {
				config_relation: { relation_type: 'dd96' },
				observers: [
					{ section_tipo: TERM_SECTION, component_tipo: MIRROR },
					{ section_tipo: TERM_SECTION_B, component_tipo: MIRROR },
				],
			},
		},
		{
			// The OBSERVER side: the mirror slot, fed from the referencing
			// section. `use_observable_dato` + `set_dato_external` are the two
			// fields the reconcile law reads.
			tipo: MIRROR,
			model: 'component_autocomplete',
			parent: TERM_SECTION,
			properties: {
				source: {
					mode: 'external',
					request_config: [
						{
							sqo: { section_tipo: [{ value: [REF_SECTION], source: 'section' }] },
							show: { sqo_config: { limit: 10 } },
						},
					],
					section_to_search: [REF_SECTION],
					component_to_search: [INDEXER],
				},
				observe: [
					{
						component_tipo: INDEXER,
						server: {
							config: { use_self_section: false, use_observable_dato: true },
							perform: {
								function: 'set_dato_external',
								params: { save: true, changed: false, current_dato: false, references_limit: 0 },
							},
						},
					},
				],
			},
		},
	],
	records: [
		{ section_tipo: TERM_SECTION, section_id: SEED_TERM.section_id },
		{ section_tipo: TERM_SECTION_B, section_id: SEED_TERM.section_id },
	],
});

async function mirrorBag(): Promise<unknown[] | null> {
	const rows = (await sql.unsafe(
		`SELECT relation->($3::text) AS bag FROM ${SCRATCH_TABLE}
		 WHERE section_tipo = $1 AND section_id = $2`,
		[SEED_TERM.section_tipo, SEED_TERM.section_id, MIRROR],
	)) as { bag: unknown[] | null }[];
	return rows[0]?.bag ?? null;
}

async function sweepScratch(): Promise<void> {
	for (const id of [REFERENCER_ID, REFERENCER_ID2]) {
		await sql.unsafe(`DELETE FROM ${SCRATCH_TABLE} WHERE section_tipo = $1 AND section_id = $2`, [
			REF_SECTION,
			id,
		]);
		await sql.unsafe(
			`DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2`,
			[REF_SECTION, id],
		);
	}
}

/** The bypass write: a raw referencer INSERT (import/migration shape). */
async function insertReferencer(id: number): Promise<void> {
	await sql.unsafe(
		`INSERT INTO ${SCRATCH_TABLE} (section_id, section_tipo, relation) VALUES ($1, '${REF_SECTION}', $2::text::jsonb)`,
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
		],
	);
}

/** The exact mirror entry shape the law appends (PHP-oracle byte shape). */
// WC-2026-08-10-section-id-int-canonical: the mirror writer mints the
// referencer address as an INT (canonicalizeStoredSectionId), so every
// recomputed bag asserted below carries ints.
function mirrorEntry(itemId: number, referencerId: number): Record<string, unknown> {
	return {
		id: itemId,
		type: 'dd151',
		section_id: referencerId,
		section_tipo: REF_SECTION,
		from_component_tipo: MIRROR,
	};
}

beforeAll(async () => {
	await ensureSituation(SITUATION);
	SCRATCH_TABLE = (await getMatrixTableFromTipo(TERM_SECTION)) ?? 'matrix';
	await sweepScratch();
	// Bypass write: indexed by the matrix_relation_index trigger, invisible to
	// the cascade.
	await insertReferencer(REFERENCER_ID);
});

afterAll(async () => {
	await sweepScratch();
	// Residue asserted, not trusted: a situation that half-tore-down would leave
	// scratch ontology behind for the next run to trip over.
	expect(await dropSituation(SITUATION)).toBe(0);
});

describe('observer mirror reconcile law (recomputeExternalRelation)', () => {
	test('dry-run detects the bypass drift WITHOUT writing', async () => {
		const diff = await recomputeExternalRelation(
			MIRROR,
			SEED_TERM.section_tipo,
			SEED_TERM.section_id,
			-1,
			new Date(),
			{ write: false },
		);
		expect(diff.changed).toBe(true);
		expect(diff.before).toBe(0);
		expect(diff.after).toBe(1);
		expect(await mirrorBag()).toBeNull(); // nothing persisted
	});

	test('repair writes the exact mirror shape + the TM audit pair, then converges', async () => {
		const tmCountBefore = async (): Promise<number> => {
			const rows = (await sql.unsafe(
				`SELECT count(*)::int AS n FROM matrix_time_machine
				 WHERE section_tipo = $1 AND section_id = $2 AND tipo = ($3::text)`,
				[SEED_TERM.section_tipo, SEED_TERM.section_id, MIRROR],
			)) as { n: number }[];
			return rows[0]?.n ?? 0;
		};
		const tmBefore = await tmCountBefore();
		const outcome = await recomputeExternalRelation(
			MIRROR,
			SEED_TERM.section_tipo,
			SEED_TERM.section_id,
			-1,
			new Date(),
			{}, // grow — no shrink intent needed
		);
		expect(outcome.changed).toBe(true);
		expect(await mirrorBag()).toEqual([mirrorEntry(1, REFERENCER_ID)]);
		// The repair row, plus the history backfill when the slot had none
		// (leftover TM rows from prior runs make this a DELTA assertion).
		const tmDelta = (await tmCountBefore()) - tmBefore;
		expect(tmDelta === 1 || tmDelta === 2).toBe(true);

		// Idempotent: truth already mirrored → no further change, no TM noise.
		const again = await recomputeExternalRelation(
			MIRROR,
			SEED_TERM.section_tipo,
			SEED_TERM.section_id,
			-1,
			new Date(),
			{},
		);
		expect(again.changed).toBe(false);
	});

	test('a MASKED SWAP (1 stale drop + 1 new add) applies BOTH halves — membership, not length', async () => {
		// Bypass-delete referencer 1 (its mirror entry goes stale) and
		// bypass-insert referencer 2: the law wants to drop one entry and add
		// one — EQUAL length before/after. The adjudication is MEMBERSHIP-based
		// (the historic length-only guard could not even see this), and since
		// 2026-08-06 the full law persists: BOTH halves land in one write.
		await sql.unsafe(`DELETE FROM ${SCRATCH_TABLE} WHERE section_tipo = $1 AND section_id = $2`, [
			REF_SECTION,
			REFERENCER_ID,
		]);
		await insertReferencer(REFERENCER_ID2);
		const refusedBefore = getCounters().observers_shrink_refused ?? 0;
		const outcome = await recomputeExternalRelation(
			MIRROR,
			SEED_TERM.section_tipo,
			SEED_TERM.section_id,
			-1,
			new Date(),
			{},
		);
		expect(outcome.changed).toBe(true);
		// No refusal: the seed was clean, so nothing withholds the drop.
		expect(outcome.skippedShrink).toBeUndefined();
		expect(outcome.seedDefects).toBeUndefined();
		expect((getCounters().observers_shrink_refused ?? 0) - refusedBefore).toBe(0);
		// The stale entry is GONE and the survivor keeps its stored id.
		expect(await mirrorBag()).toEqual([mirrorEntry(2, REFERENCER_ID2)]);
		// Idempotent: a second pass finds no drift.
		const again = await recomputeExternalRelation(
			MIRROR,
			SEED_TERM.section_tipo,
			SEED_TERM.section_id,
			-1,
			new Date(),
			{},
		);
		expect(again.changed).toBe(false);
	});

	test('a bypass DELETE makes the recompute a pure shrink, and the shrink APPLIES', async () => {
		// THE REGRESSION GUARD for the reported bug. Until 2026-08-06 a pure
		// shrink was withheld unconditionally, so an unlinked reference stayed
		// mirrored forever and only an operator flag could clear it.
		await sql.unsafe(`DELETE FROM ${SCRATCH_TABLE} WHERE section_tipo = $1 AND section_id = $2`, [
			REF_SECTION,
			REFERENCER_ID2,
		]);
		const diff = await recomputeExternalRelation(
			MIRROR,
			SEED_TERM.section_tipo,
			SEED_TERM.section_id,
			-1,
			new Date(),
			{ write: false },
		);
		expect(diff.changed).toBe(true);
		expect(diff.before).toBe(1);
		expect(diff.after).toBe(0);
		// A clean seed means the dry run promises a real write, not a refusal.
		expect(diff.skippedShrink).toBeUndefined();

		const applied = await recomputeExternalRelation(
			MIRROR,
			SEED_TERM.section_tipo,
			SEED_TERM.section_id,
			-1,
			new Date(),
			{},
		);
		expect(applied.changed).toBe(true);
		expect(applied.wrote).toBe(true);
		expect(applied.skippedShrink).toBeUndefined();
		expect(await mirrorBag()).toEqual([]);
	});

	test('the census reports drop volume and the budget predicate adjudicates it', async () => {
		// PURE — no DB. The budget turns "we eyeballed a dry run once" into a
		// re-runnable pre-deploy check: a future value-law change that would
		// mass-delete must fail HERE, not at the next save.
		const { exceedsShrinkBudget } = await import(
			'../../src/core/section/record/observer_reconcile.ts'
		);
		const base = {
			tuples: 1,
			candidates: 10,
			drifted: 3,
			repaired: 0,
			shrinksSkipped: 0,
			sublawRefused: 0,
			bigResultRefused: 0,
			droppedRecords: 3,
			droppedLocators: 1673,
			degradedSeedRecords: 0,
			reindexed: 0,
			notHostSlots: 0,
		};
		expect(exceedsShrinkBudget(base, { maxDroppedLocators: 2000, maxDroppedRecords: 40 })).toEqual(
			[],
		);
		expect(
			exceedsShrinkBudget(base, { maxDroppedLocators: 100, maxDroppedRecords: 40 }).length,
		).toBe(1);
		expect(
			exceedsShrinkBudget(base, { maxDroppedLocators: 2000, maxDroppedRecords: 2 }).length,
		).toBe(1);
		// A degraded seed is NEVER within budget — the ontology is broken in a way
		// that makes the value law unanswerable for that record.
		const degraded = { ...base, degradedSeedRecords: 1 };
		expect(
			exceedsShrinkBudget(degraded, { maxDroppedLocators: 2000, maxDroppedRecords: 40 }),
		).toHaveLength(1);
	});

	test('the drop census counts MEMBERSHIP, never a length delta (executed sweep)', async () => {
		// A regression that drops N genuine locators and appends N wrong ones has
		// an equal length. `before - after` reports 0 and sails through the
		// budget — which is the exact shape the budget exists to catch. The
		// kernel adjudicates membership (that is why a masked swap commits both
		// halves), so the census must read the kernel's own numbers.
		//
		// 2026-08-08: this used to be a SOURCE GREP for `outcome.dropped ??` —
		// it executed none of the census fold and would have stayed green against
		// a reconciler that returned an empty summary. It now DRIVES the sweep
		// over a planted masked swap and asserts the reported numbers.
		const { reconcileObserverMirrors } = await import(
			'../../src/core/section/record/observer_reconcile.ts'
		);
		const recompute = async (): Promise<void> => {
			await recomputeExternalRelation(
				MIRROR,
				SEED_TERM.section_tipo,
				SEED_TERM.section_id,
				-1,
				new Date(),
				{},
			);
		};
		try {
			// Rebuild a known one-entry mirror from scratch (the preceding tests
			// leave their own state; this case must not inherit it).
			await sweepScratch();
			await recompute();
			await insertReferencer(REFERENCER_ID);
			await recompute();
			expect((await mirrorBag())?.length).toBe(1);
			// THE MASKED SWAP: one referencer bypass-deleted, one bypass-inserted,
			// so the law drops exactly one entry and appends exactly one — before
			// === after, and a length-delta census would report ZERO drops.
			await sql.unsafe(`DELETE FROM ${SCRATCH_TABLE} WHERE section_tipo = $1 AND section_id = $2`, [
				REF_SECTION,
				REFERENCER_ID,
			]);
			await insertReferencer(REFERENCER_ID2);

			const records: unknown[] = [];
			const summary = await reconcileObserverMirrors({
				// dry run (the default): the census must be readable WITHOUT writing.
				onlyObserver: MIRROR,
				onlySection: SEED_TERM.section_tipo,
				onlyId: SEED_TERM.section_id,
				onRecord: (record) => records.push(record),
			});
			expect(summary.drifted).toBe(1);
			expect(records).toEqual([
				{
					observerTipo: MIRROR,
					hostSection: SEED_TERM.section_tipo,
					sectionId: SEED_TERM.section_id,
					before: 1,
					after: 1, // ← the length delta is 0; membership says 1 out, 1 in
					dropped: 1,
					added: 1,
				},
			]);
			// The summary fold reads the same membership numbers, so the budget sees
			// the swap it exists to catch.
			expect(summary.droppedRecords).toBe(1);
			expect(summary.droppedLocators).toBe(1);
			// A dry run persisted nothing: the stale entry is still stored.
			expect(await mirrorBag()).toEqual([mirrorEntry(1, REFERENCER_ID)]);
			// …and the drop volume it reported busts a budget of zero — the
			// predicate and the census are wired to the same numbers.
			const { exceedsShrinkBudget } = await import(
				'../../src/core/section/record/observer_reconcile.ts'
			);
			expect(
				exceedsShrinkBudget(summary, { maxDroppedLocators: 0, maxDroppedRecords: 0 }),
			).toHaveLength(2);
		} finally {
			// Hand the next test the state the pure-shrink test left: no
			// referencers, empty mirror. In `finally` on purpose — this case plants
			// its own fixture, and a FAILING assertion must not cascade into a
			// duplicate-key crash in the duplicate-record gate below.
			await sweepScratch();
			await recompute();
		}
		expect(await mirrorBag()).toEqual([]);
	}, 30000);

	test('the committed shrink budget parses and the predicate ADJUDICATES with it', async () => {
		// The budget is a committed artefact the CLI reads at runtime; a typo or
		// a missing key would surface as a crash during an ops sweep, which is
		// the worst moment to find out. Executed, not grepped: the parsed values
		// are fed to the real predicate at both sides of their own boundary, so a
		// string-typed or absent ceiling fails here instead of at 3am.
		const { readFileSync } = await import('node:fs');
		const { join } = await import('node:path');
		const root = join(import.meta.dir, '..', '..');
		const budget = JSON.parse(
			readFileSync(join(root, 'engineering/observer_shrink_budget.json'), 'utf-8'),
		) as Record<string, unknown>;
		expect(typeof budget.maxDroppedLocators).toBe('number');
		expect(typeof budget.maxDroppedRecords).toBe('number');
		// It must carry its own provenance — a bare number nobody can re-derive
		// is a number nobody dares change.
		expect(String(budget._ ?? '').length).toBeGreaterThan(120);

		const { exceedsShrinkBudget } = await import(
			'../../src/core/section/record/observer_reconcile.ts'
		);
		const limits = budget as unknown as {
			maxDroppedLocators: number;
			maxDroppedRecords: number;
		};
		const base: Parameters<typeof exceedsShrinkBudget>[0] = {
			tuples: 1,
			candidates: 1,
			drifted: 1,
			repaired: 0,
			shrinksSkipped: 0,
			sublawRefused: 0,
			bigResultRefused: 0,
			droppedRecords: limits.maxDroppedRecords,
			droppedLocators: limits.maxDroppedLocators,
			degradedSeedRecords: 0,
			reindexed: 0,
			notHostSlots: 0,
		};
		// THE CEILING MUST BE A CEILING (P2-18 / GATE-21).
		//
		// Everything below builds `base` FROM `limits`, so it asserts a property of
		// the `>` operator and nothing about the committed numbers: `{1e12, 1e12}`
		// passes it byte-identically. This budget is the bound on how many observer
		// locators an ops sweep may delete over HERITAGE RELATION DATA, so a
		// ceiling nothing bounds is the whole guard gone.
		//
		// SHRINK-ONLY, frozen at the values committed 2026-08-31. They may go DOWN
		// freely; raising either one is a deliberate act that edits this line too,
		// and the file's own `_` demands a --json census proving every additional
		// drop is genuine.
		const FROZEN_CEILING = { maxDroppedLocators: 2000, maxDroppedRecords: 40 };
		expect(
			limits.maxDroppedLocators,
			'the locator ceiling ROSE. This bounds deletions over heritage relation data: raise ' +
				'it only with a --json census proving every additional drop is genuine, and lower ' +
				'FROZEN_CEILING here in the same commit.',
		).toBeLessThanOrEqual(FROZEN_CEILING.maxDroppedLocators);
		expect(limits.maxDroppedRecords, 'the record ceiling ROSE — same rule').toBeLessThanOrEqual(
			FROZEN_CEILING.maxDroppedRecords,
		);
		// ...and it must still be tethered to the measurement its own `_` cites
		// (22 records / 1673 locators, 2026-08-06): headroom is deliberate, but a
		// ceiling orders of magnitude above what was ever observed is not a budget.
		expect(limits.maxDroppedLocators).toBeLessThan(1673 * 4);
		expect(limits.maxDroppedRecords).toBeLessThan(22 * 4);

		// Exactly AT the committed ceiling is within budget…
		expect(exceedsShrinkBudget(base, limits)).toEqual([]);
		// …one locator / one record over it is not.
		expect(
			exceedsShrinkBudget({ ...base, droppedLocators: limits.maxDroppedLocators + 1 }, limits),
		).toHaveLength(1);
		expect(
			exceedsShrinkBudget({ ...base, droppedRecords: limits.maxDroppedRecords + 1 }, limits),
		).toHaveLength(1);
	});

	test('SOURCE-SHAPE GUARD (executes nothing): the CLI consults the budget file', () => {
		// HONEST LABEL (2026-08-08). This is a TEXT SCAN of scripts/
		// observer_reconcile.ts, not a behaviour gate. It proves only that the
		// three tokens appear in the file; it proves NOTHING about whether the
		// CLI actually reads the budget, adjudicates it, or exits non-zero.
		// It cannot be executed here because the script is a top-level CLI (it
		// runs the whole sweep and calls process.exit on import). Replacing it
		// with a real gate needs a production seam — extracting the argv parse +
		// budget adjudication into an importable `runReconcileCli(argv)` — which
		// is a production change, out of scope for this repair. Scheduled as
		// such; until then, this guard is a typo tripwire and nothing more.
		const root = join(import.meta.dir, '..', '..');
		const cli = readFileSync(join(root, 'scripts/observer_reconcile.ts'), 'utf-8');
		expect(cli).toContain('observer_shrink_budget.json');
		expect(cli).toContain('exceedsShrinkBudget');
		expect(cli).toContain('process.exit(1)');
	});

	test('duplicate STRIPS the covered-observer mirror slot from the copy (empty by construction)', async () => {
		// Re-grow the term's mirror so there is a non-empty bag to (not) copy —
		// the pre-fix byte-copy would have handed it to the duplicate wholesale
		// (for the then-unported sub-law nodes: ~1,000 phantom locators with no
		// repair path — review 2026-08-02).
		await insertReferencer(REFERENCER_ID2);
		await recomputeExternalRelation(
			MIRROR,
			SEED_TERM.section_tipo,
			SEED_TERM.section_id,
			-1,
			new Date(),
			{},
		);
		expect((await mirrorBag())?.length).toBe(1);
		const counterExisted =
			(
				(await sql.unsafe('SELECT 1 FROM matrix_counter WHERE tipo = $1', [
					SEED_TERM.section_tipo,
				])) as unknown[]
			).length > 0;
		const { duplicateSectionRecord } = await import(
			'../../src/core/section/record/duplicate_record.ts'
		);
		let copyId = 0;
		try {
			copyId = await duplicateSectionRecord(SEED_TERM.section_tipo, SEED_TERM.section_id, -1);
			const rows = (await sql.unsafe(
				`SELECT (relation ? $3) AS has_mirror FROM ${SCRATCH_TABLE}
				 WHERE section_tipo = $1 AND section_id = $2`,
				[SEED_TERM.section_tipo, copyId, MIRROR],
			)) as { has_mirror: boolean }[];
			expect(rows.length).toBe(1);
			expect(rows[0]?.has_mirror).toBe(false); // the mirror slot was STRIPPED
			// the SOURCE's own bag is untouched by the duplication
			expect((await mirrorBag())?.length).toBe(1);
		} finally {
			if (copyId !== 0) {
				await sql.unsafe(
					`DELETE FROM ${SCRATCH_TABLE} WHERE section_tipo = $1 AND section_id = $2`,
					[SEED_TERM.section_tipo, copyId],
				);
				await sql.unsafe(
					'DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2',
					[SEED_TERM.section_tipo, copyId],
				);
			}
			// the counter-allocating insert creates the section counter row when
			// absent — leave the DB as found (referencer 2 + the regrown mirror
			// are swept by afterAll).
			if (!counterExisted) {
				await sql.unsafe('DELETE FROM matrix_counter WHERE tipo = $1', [SEED_TERM.section_tipo]);
			}
		}
	}, 30000);
});

/**
 * THE SWEEP'S OWN NARROWING + CENSUS FOLD (2026-08-08 mutation-repair pass).
 *
 * The gates above drive the reconciler only through ONE fully-specified
 * (--observer + --section + --id) call, so three of its own laws were never
 * entered and survived mutation:
 *   1. `--section` narrowing (discoverTuples' LAST line — the filter whose
 *      comment records the tchi1 starvation bug from filtering too early);
 *   2. `--id` MEMBERSHIP (candidateIds: an id that is neither a referenced
 *      target nor a stored mirror holder must yield NO candidate — otherwise
 *      `--id N --apply` recomputes and WRITES an arbitrary record outside the
 *      tuple's candidate set);
 *   3. the degraded-seed census FOLD (`summary.degradedSeedRecords`) — the
 *      number the shrink budget adjudicates. It was only ever fed to
 *      exceedsShrinkBudget as a hand-built literal; nothing proved the sweep
 *      ever produces it.
 *
 * Fixture: a scratch REVERSE-ONLY observer edge (test999… namespace, the
 * registry's suite-DB diagnostics carve-out) whose `data_from_field` names a
 * peer with no ontology node — the measured degraded-seed shape — plus one
 * scratch REF_SECTION record holding a stale mirror entry nothing references. That
 * makes the sweep's answer deterministic (1 tuple, 1 candidate, 1 withheld
 * drop) instead of hostage to whatever the suite ontology happens to carry.
 * Every call here is a DRY RUN: the fold and the narrowing are readable
 * without writing, and a mutant that writes is the thing we are guarding.
 */
const SCRATCH_OBSERVER = 'test99935'; // own band — the failsafe gate owns test9990x
const SCRATCH_MISSING_PEER = 'test99939_no_such_node';
const SCRATCH_HOST = REF_SECTION;
const SCRATCH_HOLDER_ID = 91098; // clear of REFERENCER_ID/2 above and of the failsafe band
/** The id the stale entry POINTS AT: a real-looking neighbour that is neither a
 * referenced target nor a mirror holder — exactly the record an `--id` filter
 * that skipped the membership check would go and recompute. */
const SCRATCH_NON_CANDIDATE_ID = 91099;

/** Suite DB only: this fixture writes dd_ontology, and `test` is a REAL tld in
 * production ontologies (the scratch-namespace carve-out is itself suite-DB
 * gated — observer_subscriptions.ts touchesScratchObserverNamespace). */
const onSuiteDb = config.db.database.endsWith('_test');

function skipUnlessSuiteDb(caseName: string): boolean {
	if (onSuiteDb) return false;
	console.warn(
		`observer_reconcile_native: NOT RUN — "${caseName}" (not the *_test suite DB: seeding a test999… ontology node would pollute a real ontology)`,
	);
	return true;
}

async function sweepScratchObserverFixture(): Promise<void> {
	await sql.unsafe(`DELETE FROM dd_ontology WHERE tipo = $1 AND tld = 'test'`, [SCRATCH_OBSERVER]);
	await sql.unsafe(`DELETE FROM ${SCRATCH_TABLE} WHERE section_tipo = $1 AND section_id = $2`, [
		SCRATCH_HOST,
		SCRATCH_HOLDER_ID,
	]);
	await sql.unsafe(`DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2`, [
		SCRATCH_HOST,
		SCRATCH_HOLDER_ID,
	]);
	const { clearOntologyDerivedCaches } = await import(
		'../../src/core/ontology/cache_invalidation.ts'
	);
	await clearOntologyDerivedCaches();
}

describe('reconcile sweep: --section / --id narrowing and the degraded-seed census', () => {
	beforeAll(async () => {
		if (!onSuiteDb) return;
		// Residue-tolerant (the observer suites' convention): sweep first, then
		// seed unconditionally — a crashed run's leftovers must never make these
		// gates vacuously green.
		await sweepScratchObserverFixture();
		await sql.unsafe(
			`INSERT INTO dd_ontology (id, tipo, parent, model, tld, properties)
			 VALUES ((SELECT COALESCE(MAX(id), 0) + 1300 FROM dd_ontology), $1, $3, 'component_autocomplete_hi', 'test', $2::text::jsonb)`,
			[
				SCRATCH_OBSERVER,
				JSON.stringify({
					// The reconciler's covered shape: use_observable_dato +
					// set_dato_external, host pinned by the observe entry's own scope
					// (resolution step 1), so the tuple is deterministic.
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
						data_from_field: [SCRATCH_MISSING_PEER], // ← degrades the seed
						section_to_search: [SCRATCH_HOST],
						component_to_search: [INDEXER],
					},
				}),
				// Parented under its host (the strict host precondition: the kernel
				// computes only where the section DECLARES the observer).
				SCRATCH_HOST,
			],
		);
		const { clearOntologyDerivedCaches } = await import(
			'../../src/core/ontology/cache_invalidation.ts'
		);
		await clearOntologyDerivedCaches();
		// The holder: one stale mirror entry, nothing references it → the law
		// wants to drop it, and the degraded seed withholds exactly that drop.
		await sql.unsafe(
			`INSERT INTO ${SCRATCH_TABLE} (section_id, section_tipo, relation) VALUES ($1, $2, $3::text::jsonb)`,
			[
				SCRATCH_HOLDER_ID,
				SCRATCH_HOST,
				JSON.stringify({
					[SCRATCH_OBSERVER]: [
						{
							id: 1,
							type: 'dd151',
							section_id: String(SCRATCH_NON_CANDIDATE_ID),
							section_tipo: SCRATCH_HOST,
							from_component_tipo: SCRATCH_OBSERVER,
						},
					],
				}),
			],
		);
	});

	afterAll(async () => {
		if (!onSuiteDb) return;
		await sweepScratchObserverFixture();
	});

	test('the degraded-seed census FOLD reports the number the budget adjudicates', async () => {
		if (
			skipUnlessSuiteDb('the degraded-seed census FOLD reports the number the budget adjudicates')
		)
			return;
		const { exceedsShrinkBudget, reconcileObserverMirrors } = await import(
			'../../src/core/section/record/observer_reconcile.ts'
		);
		const records: unknown[] = [];
		const lines: string[] = [];
		const summary = await reconcileObserverMirrors({
			onlyObserver: SCRATCH_OBSERVER,
			onlySection: SCRATCH_HOST,
			onlyId: SCRATCH_HOLDER_ID,
			onRecord: (record) => records.push(record),
			log: (line) => lines.push(line),
		});
		expect(summary.tuples).toBe(1);
		expect(summary.candidates).toBe(1);
		expect(summary.drifted).toBe(1);
		// THE FOLD: the withheld record is counted as degraded AND as a wanted
		// drop. Nothing was repaired (dry run) and no OTHER refusal fired.
		expect(summary.degradedSeedRecords).toBe(1);
		expect(summary.shrinksSkipped).toBe(1);
		expect(summary.droppedRecords).toBe(1);
		expect(summary.droppedLocators).toBe(1);
		expect(summary.repaired).toBe(0);
		expect(summary.bigResultRefused).toBe(0);
		expect(summary.sublawRefused).toBe(0);
		// The census channel names the cause, so a budget can be adjudicated by
		// cause instead of by one total.
		expect(records).toEqual([
			{
				observerTipo: SCRATCH_OBSERVER,
				hostSection: SCRATCH_HOST,
				sectionId: SCRATCH_HOLDER_ID,
				before: 1,
				after: 0,
				dropped: 1,
				added: 0,
				seedDefects: [`peer_node_missing:${SCRATCH_MISSING_PEER}`],
				refusal: 'degraded_seed',
			},
		]);
		// The operator line names the defect too — a held shrink an operator
		// cannot attribute is a held shrink nobody fixes.
		expect(lines.some((line) => line.includes('DEGRADED SEED'))).toBe(true);
		// …and the number the fold produced is the one the budget refuses: a
		// degraded seed is never within budget, however generous the ceilings.
		expect(
			exceedsShrinkBudget(summary, {
				maxDroppedLocators: 1_000_000,
				maxDroppedRecords: 1_000_000,
			}),
		).toHaveLength(1);
		// A dry run persisted nothing: the stale entry is still stored.
		const rows = (await sql.unsafe(
			`SELECT relation->($3::text) AS bag FROM ${SCRATCH_TABLE} WHERE section_tipo = $1 AND section_id = $2`,
			[SCRATCH_HOST, SCRATCH_HOLDER_ID, SCRATCH_OBSERVER],
		)) as { bag: unknown[] | null }[];
		expect(rows[0]?.bag).toHaveLength(1);

		// HONEST GAP (do not delete): the kernel sets `seedDefects` and
		// `skippedShrink` together and only together (observers.ts — both return
		// sites spread the same `wouldWithhold`/`withheld` object), so a mutant
		// that folds on `outcome.skippedShrink === true` instead of
		// `outcome.seedDefects !== undefined` is EQUIVALENT against the real
		// kernel and cannot be turned red from here. Distinguishing them needs a
		// fake kernel outcome — an injection seam (or a mock.module of
		// observers.ts, which leaks process-wide across the observer suites).
		// What this case does prove: the fold RUNS, counts the right record, and
		// feeds the budget.
	}, 30000);

	test('--id NARROWS BY MEMBERSHIP: a non-candidate id yields no candidate at all', async () => {
		if (skipUnlessSuiteDb('--id NARROWS BY MEMBERSHIP: a non-candidate id yields no candidate'))
			return;
		const { reconcileObserverMirrors } = await import(
			'../../src/core/section/record/observer_reconcile.ts'
		);
		// SCRATCH_NON_CANDIDATE_ID is the id the stale mirror entry points at: it
		// holds no mirror and is referenced by nothing, so it is NOT in the
		// tuple's candidate set. An `--id` that trusted its argument would
		// recompute it — and under `--apply` WRITE it — from a candidate list it
		// was never in.
		const records: unknown[] = [];
		const summary = await reconcileObserverMirrors({
			onlyObserver: SCRATCH_OBSERVER,
			onlySection: SCRATCH_HOST,
			onlyId: SCRATCH_NON_CANDIDATE_ID,
			onRecord: (record) => records.push(record),
		});
		expect(summary.tuples).toBe(1); // the tuple IS discovered — not a vacuous pass
		expect(summary.candidates).toBe(0);
		expect(summary.drifted).toBe(0);
		expect(records).toEqual([]);
		// Positive control on the same tuple: the holder IS a member (its id
		// comes from the stored-mirror half of the union, not the index half).
		const hit = await reconcileObserverMirrors({
			onlyObserver: SCRATCH_OBSERVER,
			onlySection: SCRATCH_HOST,
			onlyId: SCRATCH_HOLDER_ID,
		});
		expect(hit.candidates).toBe(1);
	}, 30000);

	test('--section NARROWS the tuple set (filtered LAST, after the index fan-out)', async () => {
		if (skipUnlessSuiteDb('--section NARROWS the tuple set')) return;
		const { reconcileObserverMirrors } = await import(
			'../../src/core/section/record/observer_reconcile.ts'
		);
		// Every call passes a non-candidate --id so no candidate is ever swept:
		// this case is about DISCOVERY, and it must not cost a corpus recompute.
		const noSweep = 999_999_901;
		// The scratch edge is DECLARED at REF_SECTION, and the index fan-out
		// seeds it at every section INDEXER actually points into (TERM_SECTION,
		// where the tests above plant referencers) — so unfiltered it is a
		// multi-tuple observer, and --section REF_SECTION must cut it to the
		// declared one. (Measured correction 2026-08-08: an earlier draft asserted
		// `--section on1` finds 0 tuples for this edge; it finds 1, because the
		// fan-out is the point — the filter narrows the UNION, it does not
		// replace it.)
		const unfiltered = await reconcileObserverMirrors({
			onlyObserver: SCRATCH_OBSERVER,
			onlyId: noSweep,
		});
		expect(unfiltered.tuples).toBeGreaterThan(1);
		const home = await reconcileObserverMirrors({
			onlyObserver: SCRATCH_OBSERVER,
			onlySection: SCRATCH_HOST,
			onlyId: noSweep,
		});
		expect(home.tuples).toBe(1);
		// A section NO tuple hosts at yields none — an operator's scope is a
		// scope, not a hint (a pass-through filter would return the whole union).
		const elsewhere = await reconcileObserverMirrors({
			onlyObserver: SCRATCH_OBSERVER,
			onlySection: 'zzz-no-such-section',
			onlyId: noSweep,
		});
		expect(elsewhere.tuples).toBe(0);

		// …and on a REAL multi-host observer (hierarchy93 is declared at on1/ts1/
		// dc1 — measured 3 tuples on the suite ontology), --section must cut the
		// set down, not pass it through. This is the shape the tchi1 starvation
		// bug lived in: the filter has to run AFTER the index fan-out, but it
		// does have to run.
		const allHosts = await reconcileObserverMirrors({
			onlyObserver: MIRROR,
			onlyId: noSweep,
		});
		const oneHost = await reconcileObserverMirrors({
			onlyObserver: MIRROR,
			onlySection: SEED_TERM.section_tipo,
			onlyId: noSweep,
		});
		expect(allHosts.tuples).toBeGreaterThan(1);
		expect(oneHost.tuples).toBe(1);
	}, 30000);
});
