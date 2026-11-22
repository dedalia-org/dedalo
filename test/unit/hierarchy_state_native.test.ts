/**
 * hierarchy_state — inspect / ensure / rebuild. TS-NATIVE write-path contract.
 *
 * The four situations the PHP-inherited flows got wrong, each pinned here:
 *
 *  1. DANGLING ROOT (the Albania bug). The seed presets a hierarchy45 locator pointing at
 *     `<tld>1`/1 on 158 of 269 registry records — a record that does not exist until that
 *     tld's thesaurus is imported. The old check asked "is the locator SET?", said yes, and
 *     never created the root, so the tree had nothing to hang children on and the hierarchy
 *     could not be activated at all. `ensure` asks whether the TARGET EXISTS, treats a
 *     dangling locator as ABSENT, and creates the root.
 *
 *  2. HARD-CODED IDS. PHP pinned the model root to `<tld>2`/2 — an id that exists in almost
 *     no install (live: `es2` has no records at all, so Spain's General-term-model dangled
 *     from the day it was installed). `ensure` RESOLVES the root (lowest id) or creates one;
 *     it never hard-codes.
 *
 *  3. IMPORTED THESAURUS. When the terms ARE there, the root must be the imported one —
 *     linking blindly would be wrong, and minting a new one (what tool_hierarchy's
 *     createThesaurusGeneralTerm did) would bury the real root under a duplicate.
 *
 *  4. IDEMPOTENCE. The wizard re-runs, the operator presses the button twice. The second
 *     ensure must be a no-op (`applied: []`), not a second root.
 *
 * Scratch: tld 'zz' (not a real Dédalo tld → the sweep can be tld-scoped). The registry
 * twin is created directly so each test starts from a known, hostile shape.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { sql } from '../../src/core/db/postgres.ts';
import { clearOntologyDerivedCaches } from '../../src/core/ontology/cache_invalidation.ts';
import {
	ensureHierarchy,
	inspectHierarchy,
	rebuildHierarchy,
} from '../../src/core/ontology/hierarchy_state.ts';
import { deleteOntologyByTld } from '../../src/core/ontology/ontology_delete.ts';
import { getSectionMapValue } from '../../src/core/ontology/section_map.ts';
import { deleteSectionRecord } from '../../src/core/section/record/delete_record.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';

const TLD = 'zz';
const SECTION = 'hierarchy1';
const TABLE = 'matrix_hierarchy_main';
const SCRATCH_ID = 900010;
const USER_ID = -1;

const check = (state: Awaited<ReturnType<typeof inspectHierarchy>>, id: string) =>
	state.checks.find((entry) => entry.id === id);

async function terms(sectionTipo: string): Promise<number[]> {
	const rows = (await sql.unsafe(
		'SELECT section_id FROM matrix_hierarchy WHERE section_tipo = $1 ORDER BY section_id',
		[sectionTipo],
	)) as { section_id: number }[];
	return rows.map((row) => Number(row.section_id));
}

async function rootLocator(componentTipo: string): Promise<Record<string, unknown> | null> {
	const rows = (await sql.unsafe(
		`SELECT relation->$3->0 AS loc FROM "${TABLE}" WHERE section_tipo = $1 AND section_id = $2`,
		[SECTION, SCRATCH_ID, componentTipo],
	)) as { loc: Record<string, unknown> | null }[];
	return rows[0]?.loc ?? null;
}

/**
 * Insert terms straight into a hierarchy section: [section_id, parent id | null].
 * The parent link is the hierarchy20 component_relation_parent (hierarchy36) —
 * what makes a record "parentless" (a root candidate) or not.
 */
async function insertTerms(sectionTipo: string, terms: [number, number | null][]): Promise<void> {
	for (const [id, parent] of terms) {
		const relation =
			parent === null
				? {}
				: {
						hierarchy36: [
							{
								id: 1,
								type: 'dd47',
								section_id: parent,
								section_tipo: sectionTipo,
								from_component_tipo: 'hierarchy36',
							},
						],
					};
		await sql.unsafe(
			`INSERT INTO matrix_hierarchy (section_id, section_tipo, string, relation)
			 VALUES ($1, $2, '{}'::jsonb, $3::text::jsonb)`,
			[id, sectionTipo, JSON.stringify(relation)],
		);
	}
}

/** Overwrite one registry relation key (an operator edit / a damaged row). */
async function setRegistryRelation(componentTipo: string, items: unknown[] | null): Promise<void> {
	await sql.unsafe(
		items === null
			? `UPDATE "${TABLE}" SET relation = relation - $3 WHERE section_tipo = $1 AND section_id = $2`
			: `UPDATE "${TABLE}" SET relation = relation || jsonb_build_object($3::text, $4::text::jsonb)
			   WHERE section_tipo = $1 AND section_id = $2`,
		items === null
			? [SECTION, SCRATCH_ID, componentTipo]
			: [SECTION, SCRATCH_ID, componentTipo, JSON.stringify(items)],
	);
	await clearOntologyDerivedCaches();
}

async function rootLocators(componentTipo: string): Promise<Record<string, unknown>[]> {
	const rows = (await sql.unsafe(
		`SELECT relation->$3 AS items FROM "${TABLE}" WHERE section_tipo = $1 AND section_id = $2`,
		[SECTION, SCRATCH_ID, componentTipo],
	)) as { items: Record<string, unknown>[] | null }[];
	return rows[0]?.items ?? [];
}

/** Seed the registry twin. `presetRoot` reproduces the seed's DANGLING hierarchy45. */
async function seedRegistry(presetRoot: boolean): Promise<void> {
	const relation: Record<string, unknown[]> = {
		hierarchy9: [
			{
				id: 1,
				type: 'dd151',
				section_id: '2', // toponymy
				section_tipo: 'hierarchy13',
				from_component_tipo: 'hierarchy9',
			},
		],
	};
	if (presetRoot) {
		// EXACTLY what the seed ships: a Link locator at <tld>1/1, whose target does not exist.
		relation.hierarchy45 = [
			{
				id: 1,
				type: 'dd151',
				section_id: '1',
				section_tipo: `${TLD}1`,
				from_component_tipo: 'hierarchy45',
			},
		];
	}
	await sql.unsafe(
		`INSERT INTO "${TABLE}" (section_id, section_tipo, string, relation)
		 VALUES ($1, $2, $3::text::jsonb, $4::text::jsonb)`,
		[
			SCRATCH_ID,
			SECTION,
			JSON.stringify({
				hierarchy5: [{ id: 1, lang: 'lg-eng', value: 'ZZ Scratch' }],
				hierarchy6: [{ id: 1, lang: 'lg-nolan', value: 'ZZ' }],
			}),
			JSON.stringify(relation),
		],
	);
	await clearOntologyDerivedCaches();
}

async function sweep(): Promise<void> {
	await deleteOntologyByTld(TLD, (st, sid) => deleteSectionRecord(st, sid, USER_ID));
	await sql.unsafe('DELETE FROM dd_ontology WHERE tld = $1', [TLD]);
	await sql.unsafe(`DELETE FROM "${TABLE}" WHERE section_tipo = $1 AND section_id = $2`, [
		SECTION,
		SCRATCH_ID,
	]);
	await sql.unsafe('DELETE FROM matrix_hierarchy WHERE section_tipo IN ($1, $2)', [
		`${TLD}1`,
		`${TLD}2`,
	]);
	await sql.unsafe(
		`DELETE FROM matrix_time_machine WHERE section_tipo IN ($1, $2, $3)
		   OR (section_tipo = $4 AND section_id = $5)`,
		[`${TLD}0`, `${TLD}1`, `${TLD}2`, SECTION, SCRATCH_ID],
	);
	await clearOntologyDerivedCaches();
}

beforeEach(sweep);
afterAll(sweep);

describe('inspectHierarchy', () => {
	test('reports a DANGLING root as broken, naming the missing target', async () => {
		await seedRegistry(true); // the seed's preset hierarchy45 → zz1/1, which does not exist

		const state = await inspectHierarchy(SCRATCH_ID);

		expect(state.usable).toBe(false);
		const root = check(state, 'root_term');
		expect(root?.ok).toBe(false);
		expect(root?.detail).toContain('DANGLING');
		expect(root?.detail).toContain('zz1/1');
		// and it is a pure read — nothing was created
		expect(await terms(`${TLD}1`)).toEqual([]);
	});

	test('flags a BARE active locator (invisible to the portals) as not ok', async () => {
		await seedRegistry(false);
		await sql.unsafe(
			`UPDATE "${TABLE}" SET relation = relation || $3::text::jsonb
			 WHERE section_tipo = $1 AND section_id = $2`,
			[
				SECTION,
				SCRATCH_ID,
				JSON.stringify({ hierarchy4: [{ id: 1, section_id: '1', section_tipo: 'dd64' }] }),
			],
		);

		const active = check(await inspectHierarchy(SCRATCH_ID), 'active');

		expect(active?.ok).toBe(false);
		expect(active?.detail).toContain('BARE');
	});
});

describe('ensureHierarchy', () => {
	test('repairs the dangling root by CREATING it, and the hierarchy becomes usable', async () => {
		await seedRegistry(true);

		const outcome = await ensureHierarchy(SCRATCH_ID, USER_ID);

		expect(outcome.ok).toBe(true);
		expect(outcome.state.usable).toBe(true);
		// the root was created (the section was empty), not linked to a phantom
		expect(await terms(`${TLD}1`)).toHaveLength(1);
		const locator = await rootLocator('hierarchy45');
		expect(locator).toMatchObject({
			type: 'dd48', // Child — the canonical shape, replacing the seed's dd151
			section_tipo: `${TLD}1`,
			from_component_tipo: 'hierarchy45',
		});
		// and it points at the record that now EXISTS
		expect(await terms(`${TLD}1`)).toContain(Number(locator?.section_id));
	});

	test('LINKS the imported root instead of minting a duplicate', async () => {
		await seedRegistry(true);
		await ensureHierarchy(SCRATCH_ID, USER_ID); // provision the ontology first
		// Simulate an imported thesaurus whose root is NOT id 1 (hard-coded ids are the disease).
		// 9 hangs under 7, so 7 is the ONLY parentless record — the root (Q7 (b)).
		await sql.unsafe('DELETE FROM matrix_hierarchy WHERE section_tipo = $1', [`${TLD}1`]);
		await insertTerms(`${TLD}1`, [
			[7, null],
			[9, 7],
		]);
		await sql.unsafe(
			`UPDATE "${TABLE}" SET relation = relation - 'hierarchy45'
			 WHERE section_tipo = $1 AND section_id = $2`,
			[SECTION, SCRATCH_ID],
		);

		const outcome = await ensureHierarchy(SCRATCH_ID, USER_ID);

		expect(outcome.ok).toBe(true);
		// the EXISTING root (the parentless one) is linked; no third record is minted
		expect(await terms(`${TLD}1`)).toEqual([7, 9]);
		// int-canonical stored address (WC-2026-08-10-section-id-int-canonical)
		expect(await rootLocator('hierarchy45')).toMatchObject({ section_id: 7 });
	});

	// A root term is the node the whole tree descends from. An unnamed one renders as an
	// empty row at the top of the thesaurus — the tool used to leave exactly that.
	test('NAMES a created root after the hierarchy, via the section_map term component', async () => {
		await seedRegistry(true);

		await ensureHierarchy(SCRATCH_ID, USER_ID);

		// The term component is resolved from the section_map (hierarchy52 →
		// {thesaurus:{term:'hierarchy25'}}), NOT hard-coded — a hierarchy on another real
		// section names a different component.
		const termTipo = await getSectionMapValue(`${TLD}1`, 'thesaurus', 'term');
		expect(termTipo).toBe('hierarchy25');

		const rootId = Number((await rootLocator('hierarchy45'))?.section_id);
		const rows = (await sql.unsafe(
			'SELECT string->$3 AS term FROM matrix_hierarchy WHERE section_tipo = $1 AND section_id = $2',
			[`${TLD}1`, rootId, String(termTipo)],
		)) as { term: { id?: number; lang?: string; value?: unknown }[] | null }[];

		// Copied verbatim from the hierarchy's own name (hierarchy5) — every language item.
		expect(rows[0]?.term).toEqual([{ id: 1, lang: 'lg-eng', value: 'ZZ Scratch' }]);

		// ...and the MODEL root is named too.
		const modelRootId = Number((await rootLocator('hierarchy59'))?.section_id);
		const modelRows = (await sql.unsafe(
			'SELECT string->$3 AS term FROM matrix_hierarchy WHERE section_tipo = $1 AND section_id = $2',
			[`${TLD}2`, modelRootId, String(termTipo)],
		)) as { term: { value?: unknown }[] | null }[];
		expect(modelRows[0]?.term?.[0]?.value).toBe('ZZ Scratch');
	});

	// Fill-only: an imported root, or one an operator renamed, is not ours to clobber.
	test('never OVERWRITES a root term that already has a name', async () => {
		await seedRegistry(true);
		await ensureHierarchy(SCRATCH_ID, USER_ID);
		const rootId = Number((await rootLocator('hierarchy45'))?.section_id);
		await sql.unsafe(
			`UPDATE matrix_hierarchy SET string = $3::text::jsonb
			 WHERE section_tipo = $1 AND section_id = $2`,
			[
				`${TLD}1`,
				rootId,
				JSON.stringify({ hierarchy25: [{ id: 1, lang: 'lg-eng', value: 'Renamed by hand' }] }),
			],
		);

		const outcome = await ensureHierarchy(SCRATCH_ID, USER_ID);

		expect(outcome.ok).toBe(true);
		const rows = (await sql.unsafe(
			"SELECT string->'hierarchy25'->0->>'value' AS value FROM matrix_hierarchy WHERE section_tipo = $1 AND section_id = $2",
			[`${TLD}1`, rootId],
		)) as { value: string }[];
		expect(rows[0]?.value).toBe('Renamed by hand'); // untouched
	});

	test('is idempotent — the second run changes nothing', async () => {
		await seedRegistry(true);
		const first = await ensureHierarchy(SCRATCH_ID, USER_ID);
		expect(first.applied.length).toBeGreaterThan(0);
		const rootsAfterFirst = await terms(`${TLD}1`);

		const second = await ensureHierarchy(SCRATCH_ID, USER_ID);

		expect(second.ok).toBe(true);
		expect(second.applied).toEqual([]); // nothing left to do
		expect(second.msg).toContain('Already consistent');
		expect(await terms(`${TLD}1`)).toEqual(rootsAfterFirst); // no duplicate root
	});

	test('refuses (without writing) when the hierarchy has no typology', async () => {
		await sql.unsafe(
			`INSERT INTO "${TABLE}" (section_id, section_tipo, string, relation)
			 VALUES ($1, $2, $3::text::jsonb, '{}'::jsonb)`,
			[
				SCRATCH_ID,
				SECTION,
				JSON.stringify({ hierarchy6: [{ id: 1, lang: 'lg-nolan', value: 'ZZ' }] }),
			],
		);
		await clearOntologyDerivedCaches();

		const outcome = await ensureHierarchy(SCRATCH_ID, USER_ID);

		expect(outcome.ok).toBe(false);
		expect(outcome.msg).toContain('typology');
		expect(await terms(`${TLD}1`)).toEqual([]); // no ontology, no root, no half-built state
	});
});

describe('rebuildHierarchy', () => {
	test('rebuilds the ontology and PRESERVES the terms', async () => {
		await seedRegistry(true);
		await ensureHierarchy(SCRATCH_ID, USER_ID);
		// Add a term the operator would have entered — a rebuild must never eat it.
		await sql.unsafe(
			`INSERT INTO matrix_hierarchy (section_id, section_tipo, string, relation)
			 VALUES (42, $1, '{}'::jsonb, '{}'::jsonb)`,
			[`${TLD}1`],
		);
		const before = await terms(`${TLD}1`);
		expect(before).toContain(42);

		const outcome = await rebuildHierarchy(SCRATCH_ID, USER_ID, (st, sid) =>
			deleteSectionRecord(st, sid, USER_ID),
		);

		expect(outcome.ok).toBe(true);
		expect(outcome.state.usable).toBe(true);
		expect(await terms(`${TLD}1`)).toEqual(before); // the TERMS survived the teardown
		expect(outcome.applied[0]).toContain('tore down');
	});
});

/**
 * 5. FOREIGN TARGET SECTIONS — the hierarchy declares where its terms live, and
 *    the engine must believe it.
 *
 * hierarchy53 (terms section) and hierarchy58 (model section) are OPERATOR DATA:
 * a hierarchy may legitimately pair sections that are not its own `<tld>1` /
 * `<tld>2` (live: 'WW' declares hierarchy53 `mht72`). The `targets` check always
 * read the row correctly — and then every other consumer re-derived
 * `<tld>1`/`<tld>2` from the TLD NAME and contradicted it:
 *
 *   - `inspect` reported a perfectly good root as `points at mht72/…` — the
 *     check announcing the declared value as the defect (a LIVE bug: WW reads
 *     broken in the maintenance panel and cannot be activated);
 *   - `ensure` would then "repair" it by minting a SECOND root inside `<tld>1`,
 *     a section the operator never pointed at, leaving the declared one empty;
 *   - `ontologyPresent` asserted the `<tld>0/1/2` triad, so a hierarchy whose
 *     declared target was foreign reported its ontology broken while nothing was.
 *
 * Reproduced here by SWAPPING the pair — hierarchy53 → `zz2`, hierarchy58 →
 * `zz1` — which is the same shape as WW (declared ≠ conventional) while staying
 * inside the scratch tld this file already sweeps.
 */
describe('foreign target sections (hierarchy53 / hierarchy58)', () => {
	/** Point the registry row at the SWAPPED pair, as an operator would. */
	async function declareSwappedTargets(): Promise<void> {
		await sql.unsafe(
			`UPDATE "${TABLE}" SET string = string || $3::text::jsonb
			 WHERE section_tipo = $1 AND section_id = $2`,
			[
				SECTION,
				SCRATCH_ID,
				JSON.stringify({
					hierarchy53: [{ id: 1, lang: 'lg-nolan', value: `${TLD}2` }],
					hierarchy58: [{ id: 1, lang: 'lg-nolan', value: `${TLD}1` }],
				}),
			],
		);
		await clearOntologyDerivedCaches();
	}

	test('ensure creates each root in the DECLARED section, not in `<tld>1`/`<tld>2`', async () => {
		await seedRegistry(false);
		await declareSwappedTargets();

		const outcome = await ensureHierarchy(SCRATCH_ID, USER_ID);

		expect(outcome.ok).toBe(true);
		expect(outcome.state.usable).toBe(true);
		// The term root went where the row says (zz2), and the MODEL root to zz1.
		// Before the fix both went to the tld-derived pair and this was reversed.
		expect(await rootLocator('hierarchy45')).toMatchObject({ section_tipo: `${TLD}2` });
		expect(await rootLocator('hierarchy59')).toMatchObject({ section_tipo: `${TLD}1` });
		// Exactly one root apiece — no phantom second root in the conventional
		// section, which is the damage `ensure` used to do.
		expect(await terms(`${TLD}2`)).toHaveLength(1);
		expect(await terms(`${TLD}1`)).toHaveLength(1);
	});

	test('inspect reports the declared pairing as OK (it used to name it as the defect)', async () => {
		await seedRegistry(false);
		await declareSwappedTargets();
		await ensureHierarchy(SCRATCH_ID, USER_ID);

		const state = await inspectHierarchy(SCRATCH_ID);

		expect(check(state, 'root_term')?.ok).toBe(true);
		expect(check(state, 'root_term')?.detail).toContain(`${TLD}2/`);
		expect(check(state, 'root_model')?.ok).toBe(true);
		expect(check(state, 'root_model')?.detail).toContain(`${TLD}1/`);
		// The ontology check asks about the DECLARED sections now, so it is green
		// on the same row that used to fail the `<tld>0/1/2` triad assertion.
		expect(check(state, 'ontology')?.ok).toBe(true);
		expect(check(state, 'targets')?.ok).toBe(true);
		expect(state.usable).toBe(true);
	});

	test('IDEMPOTENT on the declared pairing — a second ensure changes nothing', async () => {
		await seedRegistry(false);
		await declareSwappedTargets();
		await ensureHierarchy(SCRATCH_ID, USER_ID);

		const second = await ensureHierarchy(SCRATCH_ID, USER_ID);

		expect(second.applied).toEqual([]);
		expect(await terms(`${TLD}2`)).toHaveLength(1);
		expect(await terms(`${TLD}1`)).toHaveLength(1);
	});
});

/**
 * 6. THE ROOT LINK RULE (T2 OX4-02, owner Q7 (b), 2026-11-19;
 *    WC-2026-11-22-hierarchy-root-link-rule). A missing or dangling general-term
 *    link in a section that ALREADY holds terms links the ONLY record without a
 *    parent; several such records, or none, change nothing and are reported as
 *    "root ambiguous" for the operator to choose. The old rule linked the lowest
 *    section_id — any imported term, a child as easily as the root.
 */
describe('root link rule — the only parentless record (Q7 (b))', () => {
	async function provisionedWithoutRootLink(): Promise<void> {
		await seedRegistry(true);
		await ensureHierarchy(SCRATCH_ID, USER_ID); // provision zz0/zz1/zz2
		await sql.unsafe('DELETE FROM matrix_hierarchy WHERE section_tipo = $1', [`${TLD}1`]);
		await setRegistryRelation('hierarchy45', null);
	}

	test('ONE parentless record → linked, even when it is not the lowest id', async () => {
		await provisionedWithoutRootLink();
		await insertTerms(`${TLD}1`, [
			[7, 9], // a child of 9 — lowest id, NOT the root
			[9, null],
		]);

		const outcome = await ensureHierarchy(SCRATCH_ID, USER_ID);

		expect(outcome.ok).toBe(true);
		expect(await rootLocators('hierarchy45')).toEqual([
			{
				id: 1,
				type: 'dd48',
				section_id: 9,
				section_tipo: `${TLD}1`,
				from_component_tipo: 'hierarchy45',
			},
		]);
		expect(await terms(`${TLD}1`)).toEqual([7, 9]); // nothing minted
	});

	test('SEVERAL parentless records → nothing written, "root ambiguous" reported', async () => {
		await provisionedWithoutRootLink();
		await insertTerms(`${TLD}1`, [
			[7, null],
			[9, null],
		]);

		const outcome = await ensureHierarchy(SCRATCH_ID, USER_ID);

		expect(outcome.ok).toBe(false);
		expect(outcome.errors.join(' ')).toContain('root ambiguous');
		expect(await rootLocators('hierarchy45')).toEqual([]); // no link written
		expect(await terms(`${TLD}1`)).toEqual([7, 9]); // nothing minted
		const root = check(outcome.state, 'root_term');
		expect(root?.ok).toBe(false);
		expect(root?.detail).toContain('root ambiguous');
		// inspect (the status panel) reports it too, as a pure read
		expect(check(await inspectHierarchy(SCRATCH_ID), 'root_term')?.detail).toContain(
			'root ambiguous',
		);
	});

	test('NO parentless record (a parent cycle) → nothing written, "root ambiguous"', async () => {
		await provisionedWithoutRootLink();
		await insertTerms(`${TLD}1`, [
			[7, 9],
			[9, 7],
		]);

		const outcome = await ensureHierarchy(SCRATCH_ID, USER_ID);

		expect(outcome.ok).toBe(false);
		expect(outcome.errors.join(' ')).toContain('root ambiguous');
		expect(await rootLocators('hierarchy45')).toEqual([]);
		expect(await terms(`${TLD}1`)).toEqual([7, 9]);
	});

	test('a DANGLING link over an ambiguous section is left as it is (change nothing)', async () => {
		await provisionedWithoutRootLink();
		await insertTerms(`${TLD}1`, [
			[7, null],
			[9, null],
		]);
		const dangling = {
			id: 1,
			type: 'dd151',
			section_id: 999,
			section_tipo: `${TLD}1`,
			from_component_tipo: 'hierarchy45',
		};
		await setRegistryRelation('hierarchy45', [dangling]);

		const outcome = await ensureHierarchy(SCRATCH_ID, USER_ID);

		expect(outcome.ok).toBe(false);
		expect(await rootLocators('hierarchy45')).toEqual([dangling]);
	});
});

/**
 * 7. EVERY VALID ROOT LOCATOR SURVIVES (T2 OX4-03). The registry's general-term
 *    component may hold several root locators; ensure used to read the FIRST
 *    and rewrite the key with one — a bare-but-valid first locator cost every
 *    other root its link, and a dangling first one made ensure link the lowest
 *    record over a perfectly valid second locator. Now each valid locator is
 *    kept (re-stamped to the canonical shape) and only the dangling ones are
 *    dropped, each named in `applied`.
 */
describe('several root locators (OX4-03)', () => {
	async function provisionedWithTwoRecords(): Promise<number> {
		await seedRegistry(true);
		await ensureHierarchy(SCRATCH_ID, USER_ID);
		const first = Number((await rootLocator('hierarchy45'))?.section_id);
		await insertTerms(`${TLD}1`, [[first + 6, null]]);
		return first;
	}

	test('two valid roots, the first BARE → both survive, both re-stamped', async () => {
		const first = await provisionedWithTwoRecords();
		const second = first + 6;
		await setRegistryRelation('hierarchy45', [
			{ section_id: first, section_tipo: `${TLD}1` }, // bare: no id/type/from_component_tipo
			{
				id: 2,
				type: 'dd48',
				section_id: second,
				section_tipo: `${TLD}1`,
				from_component_tipo: 'hierarchy45',
			},
		]);

		const outcome = await ensureHierarchy(SCRATCH_ID, USER_ID);

		expect(outcome.ok).toBe(true);
		expect(check(outcome.state, 'root_term')?.ok).toBe(true);
		const stored = await rootLocators('hierarchy45');
		expect(stored.map((item) => Number(item.section_id))).toEqual([first, second]);
		for (const item of stored) {
			expect(item).toMatchObject({
				type: 'dd48',
				section_tipo: `${TLD}1`,
				from_component_tipo: 'hierarchy45',
			});
		}
		// distinct item ids (the bare one got a fresh id, the second kept its own)
		expect(new Set(stored.map((item) => item.id)).size).toBe(2);
		expect(stored[1]?.id).toBe(2);
	});

	test('a DANGLING first locator is dropped and named; the valid second one is kept', async () => {
		const first = await provisionedWithTwoRecords();
		const second = first + 6;
		const valid = {
			id: 2,
			type: 'dd48',
			section_id: second,
			section_tipo: `${TLD}1`,
			from_component_tipo: 'hierarchy45',
		};
		await setRegistryRelation('hierarchy45', [
			{
				id: 1,
				type: 'dd48',
				section_id: 999,
				section_tipo: `${TLD}1`,
				from_component_tipo: 'hierarchy45',
			},
			valid,
		]);
		// before ensure the check is not ok: one locator dangles
		expect(check(await inspectHierarchy(SCRATCH_ID), 'root_term')?.ok).toBe(false);

		const outcome = await ensureHierarchy(SCRATCH_ID, USER_ID);

		expect(outcome.ok).toBe(true);
		// the VALID root (not the lowest record, `first`) is the one kept
		expect(await rootLocators('hierarchy45')).toEqual([valid]);
		expect(outcome.applied.join(' ')).toContain(`${TLD}1/999`);
		expect(check(outcome.state, 'root_term')?.ok).toBe(true);
	});
});

/**
 * 8. THE ROOT IS NAMED THROUGH THE FIRST TERM TIPO (T2 OX4-01). A section_map
 *    `term` may be a LIST of tipos (`["hierarchy25","hierarchy90"]`); naming read
 *    it as one string, found none, and left every such root unnamed. And only a
 *    literal STRING-column component can carry the hierarchy's name (hierarchy5
 *    items are `{id, lang, value}` strings): a term naming e.g. a number component
 *    used to receive those string items in its `number` column.
 *
 * Root-only hierarchies (hierarchy53 → a defined `zzhst` section), so the term
 * map is the scratch section's own, not hierarchy20's.
 */
const NAMING = situation({
	tld: 'zzhst',
	name: 'hierarchy_state root naming',
	nodes: [
		{ tipo: 'zzhst1', parent: 'test1', model: 'section', term: { 'lg-eng': 'zz names' } },
		{
			tipo: 'zzhst2',
			parent: 'zzhst1',
			model: 'section_map',
			properties: { thesaurus: { term: ['zzhst3', 'zzhst4'] } },
		},
		{
			tipo: 'zzhst3',
			parent: 'zzhst1',
			model: 'component_input_text',
			term: { 'lg-eng': 'zz name a' },
			is_translatable: true,
		},
		{
			tipo: 'zzhst4',
			parent: 'zzhst1',
			model: 'component_input_text',
			term: { 'lg-eng': 'zz name b' },
			is_translatable: true,
		},
		// a New button: the root-only mint asks the acting user's create rule (F2)
		{ tipo: 'zzhst8', parent: 'zzhst1', model: 'button_new', term: { 'lg-eng': 'zz new' } },
		{ tipo: 'zzhst5', parent: 'test1', model: 'section', term: { 'lg-eng': 'zz numbers' } },
		{ tipo: 'zzhst9', parent: 'zzhst5', model: 'button_new', term: { 'lg-eng': 'zz new' } },
		{
			tipo: 'zzhst6',
			parent: 'zzhst5',
			model: 'section_map',
			properties: { thesaurus: { term: 'zzhst7' } },
		},
		{
			tipo: 'zzhst7',
			parent: 'zzhst5',
			model: 'component_number',
			term: { 'lg-eng': 'zz number' },
		},
	],
});

describe('root naming through the section_map term (OX4-01)', () => {
	beforeAll(() => ensureSituation(NAMING));
	afterAll(async () => {
		expect(await dropSituation(NAMING)).toBe(0);
	});

	async function rootOnlyOn(sectionTipo: string): Promise<void> {
		await seedRegistry(false);
		await sql.unsafe(
			`UPDATE "${TABLE}" SET string = string || $3::text::jsonb
			 WHERE section_tipo = $1 AND section_id = $2`,
			[
				SECTION,
				SCRATCH_ID,
				JSON.stringify({ hierarchy53: [{ id: 1, lang: 'lg-nolan', value: sectionTipo }] }),
			],
		);
		await clearOntologyDerivedCaches();
	}

	async function columnOf(sectionTipo: string, id: number, column: string, tipo: string) {
		const rows = (await sql.unsafe(
			`SELECT "${column}"->$3 AS value FROM matrix_test WHERE section_tipo = $1 AND section_id = $2`,
			[sectionTipo, id, tipo],
		)) as { value: unknown }[];
		return rows[0]?.value ?? null;
	}

	test('an ARRAY term → the root is named through its FIRST tipo', async () => {
		await rootOnlyOn('zzhst1');
		try {
			const outcome = await ensureHierarchy(SCRATCH_ID, USER_ID);

			expect(outcome.ok).toBe(true);
			const rootId = Number((await rootLocator('hierarchy45'))?.section_id);
			expect(rootId).toBeGreaterThan(0);
			expect(await columnOf('zzhst1', rootId, 'string', 'zzhst3')).toEqual([
				{ id: 1, lang: 'lg-eng', value: 'ZZ Scratch' },
			]);
			expect(await columnOf('zzhst1', rootId, 'string', 'zzhst4')).toBeNull();
			expect(outcome.applied.join(' ')).not.toContain('unnamed');
		} finally {
			await sql.unsafe('DELETE FROM matrix_test WHERE section_tipo = $1', ['zzhst1']);
		}
	});

	test('a term naming a NON-string component → root left unnamed, nothing written there', async () => {
		await rootOnlyOn('zzhst5');
		try {
			const outcome = await ensureHierarchy(SCRATCH_ID, USER_ID);

			const rootId = Number((await rootLocator('hierarchy45'))?.section_id);
			expect(rootId).toBeGreaterThan(0); // the root exists — naming is non-fatal
			expect(await columnOf('zzhst5', rootId, 'number', 'zzhst7')).toBeNull();
			expect(await columnOf('zzhst5', rootId, 'string', 'zzhst7')).toBeNull();
			const unnamed = outcome.applied.find((line) => line.includes('unnamed'));
			expect(unnamed).toContain('zzhst7');
		} finally {
			await sql.unsafe('DELETE FROM matrix_test WHERE section_tipo = $1', ['zzhst5']);
		}
	});
});
