/**
 * EQUIVALENCE-CLASS REMOVAL GATES (2026-08-06) — the reported numisdata36 bug,
 * reduced to its mechanism and pinned.
 *
 * THE BUG. `numisdata77` (a coin-type's "coins of this type" mirror) observes
 * `numisdata36` (dd621 equivalents) through `set_dato_external` with
 * `source.data_from_field:[numisdata36]`, so the mirror lists records
 * referencing this type OR ANY OF ITS EQUIVALENTS. Assigning an equivalence
 * updated both types' mirrors; REMOVING it updated neither, and the portal
 * kept showing both types' coins as if they were still equivalent. Measured on
 * the live DB: the removal produced ZERO mirror writes on either record.
 *
 * Three independent causes, one gate each below:
 *
 *  1. THE REMOVED LOCATOR WAS NEVER A TARGET. Propagation derived its whole
 *     target set from the POST-save value, so the record the save stopped
 *     pointing at was not visited at all. (ObservedChange.removed)
 *  2. THE SHRINK WAS REFUSED. The saved record itself WAS visited, but the
 *     Phase-0 grow-only fail-safe withheld every drop unconditionally.
 *     (retired — the kernel's degraded-seed refusal replaced it)
 *  3. THE CLASS WAS IGNORED. dd621 is TRANSITIVE, so one edge change
 *     re-partitions a whole class: in A—B—C, changing B—C also changes A's
 *     class. The saved bag names only the direct endpoints. This is wrong in
 *     BOTH directions — the reported 2-member case appeared to work on ADD
 *     purely because a 2-member class has no third member.
 *     (targets = closure(saved) ∪ ⋃ closure(removed))
 *
 * Topology (a 3-member chain, deliberately stored ASYMMETRICALLY so the
 * closure has to work in both directions — X stores Y, Y stores Z, and X
 * reaches Z only transitively):
 *
 *     TERM_X --stores--> TERM_Y --stores--> TERM_Z
 *       ^                  ^                  ^
 *     REF_X              REF_Y              REF_Z      (REF_SECTION, via EQ_REF)
 *
 * With all three in one class every mirror holds all three referencers.
 * Removing the Y—Z edge splits it into {X,Y} and {Z} — and TERM_X, which the
 * save never mentions, must recompute.
 *
 * Environment: suite DB. Scratch band test9994x / 9999999 5x (distinct from
 * observer_failsafe test9990x, observer_seed test9991x, observer_cascade
 * test9992x).
 */
// Migrated to the generic `test` TLD 2026-08-20 (AGENTS.md hard rules). The two
// install SECTION carriers are gone: the term section `on1` (matrix_hierarchy,
// seeded by test/helpers/observer_term_seed.ts) and the referencer section
// `rsc205` (matrix) are now TERM_SECTION/REF_SECTION — scratch `section` nodes
// this file builds itself, each carrying the `test24` matrix_table relation so
// every record lands in `matrix_test`. The observer COMPONENT tipos stay in the
// `test999…` band on purpose: it is the scratch namespace
// observer_subscriptions.ts `touchesScratchObserverNamespace` excludes from the
// contract diagnostics.
//
// The `planted` guard went with it. It existed because the shared helper would
// not seed `on1` on a restored live snapshot, and EVERY case in this file then
// returned early — a whole suite that could report green having asserted
// nothing. The sections this file now builds exist because it built them, so
// there is no such state and no case may skip.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getCounters } from '../../src/core/api/counters.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { recomputeExternalRelation } from '../../src/core/section/record/observers.ts';
import { saveComponentData } from '../../src/core/section/record/save_component.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const KERNEL_FILE = 'src/core/section/record/observers.ts';
const kernelSource = readFileSync(join(REPO_ROOT, KERNEL_FILE), 'utf-8');
// The expansion and the lock-order sort moved out of the kernel (2026-10-30
// external-value law registry): law (c)'s equivalence walk lives with the law,
// the sort with the target resolvers the dispatch calls.
const LAW_C_FILE = 'src/core/section/record/external_laws/inverse_search.ts';
const lawCSource = readFileSync(join(REPO_ROOT, LAW_C_FILE), 'utf-8');
const RESOLVERS_FILE = 'src/core/section/record/external_laws/resolvers.ts';
const resolversSource = readFileSync(join(REPO_ROOT, RESOLVERS_FILE), 'utf-8');

// --- the two SCRATCH SECTIONS this file builds (2026-08-20 migration) --------
/** The TERM section holding the equivalence class (was the install `on1`). */
const TERM_SECTION = 'test999490';
/** The REFERENCER section (was the install `rsc205`). */
const REF_SECTION = 'test999491';
/** Where both store — the `test24` matrix_table term. */
const SCRATCH_TABLE = 'matrix_test';

// --- scratch band -----------------------------------------------------------
const EQ_PEER = 'test99940'; // dd621 equivalents (the numisdata36 shape)
const EQ_MIRROR = 'test99941'; // set_dato_external observer (the numisdata77 shape)
const EQ_REF = 'test99942'; // the referencing component in REF_SECTION (numisdata161 shape)

const TERM_X = 999999951;
const TERM_Y = 999999952;
const TERM_Z = 999999953;
const REF_X = 999999954;
const REF_Y = 999999955;
const REF_Z = 999999956;

const TERMS = [TERM_X, TERM_Y, TERM_Z];
const REFS = [REF_X, REF_Y, REF_Z];

const SCRATCH_NODES: { tipo: string; model: string; properties: Record<string, unknown> }[] = [
	{
		// The observed component. dd621 = MULTIDIRECTIONAL, so its references are
		// the full transitive closure in both walk directions — the property the
		// whole class expansion rests on.
		tipo: EQ_PEER,
		model: 'component_relation_related',
		properties: {
			config_relation: { relation_type_rel: 'dd621' },
			observers: [{ section_tipo: TERM_SECTION, component_tipo: EQ_MIRROR }],
		},
	},
	{
		// The mirror. data_from_field names EQ_PEER — that is what makes a save on
		// EQ_PEER a CLASS event rather than a link event.
		tipo: EQ_MIRROR,
		model: 'component_portal',
		properties: {
			observe: [
				{
					component_tipo: EQ_PEER,
					server: {
						config: { use_self_section: true, use_observable_dato: true },
						perform: {
							function: 'set_dato_external',
							params: { save: true, changed: false, current_dato: false, references_limit: 0 },
						},
					},
				},
			],
			source: {
				data_from_field: [EQ_PEER],
				section_to_search: [REF_SECTION],
				component_to_search: [EQ_REF],
			},
		},
	},
	{ tipo: EQ_REF, model: 'component_autocomplete', properties: {} },
];

/**
 * Referencer ids listed in a term's mirror, sorted. Item ids and positions are
 * deliberately NOT asserted here: the byte shape of an appended entry is
 * pinned by observer_reconcile_native.test.ts, and these gates are about WHICH
 * records get recomputed.
 */
async function mirrorRefs(termId: number): Promise<number[]> {
	const rows = (await sql.unsafe(
		`SELECT relation->$1 AS bag FROM ${SCRATCH_TABLE} WHERE section_tipo = $2 AND section_id = $3`,
		[EQ_MIRROR, TERM_SECTION, termId],
	)) as { bag: { section_id?: string }[] | null }[];
	return (rows[0]?.bag ?? []).map((entry) => Number(entry.section_id)).sort((a, b) => a - b);
}

/** Point `termId`'s equivalence bag at `peerIds` (raw — the stored half). */
async function setEquivalents(termId: number, peerIds: number[]): Promise<void> {
	await sql.unsafe(
		`UPDATE ${SCRATCH_TABLE} SET relation = jsonb_set(COALESCE(relation, '{}'::jsonb), $1::text[], $2::text::jsonb)
		 WHERE section_tipo = '${TERM_SECTION}' AND section_id = $3`,
		[
			`{${EQ_PEER}}`,
			JSON.stringify(
				peerIds.map((peerId, index) => ({
					id: index + 1,
					type: 'dd47',
					type_rel: 'dd621',
					section_id: String(peerId),
					section_tipo: TERM_SECTION,
					from_component_tipo: EQ_PEER,
				})),
			),
			termId,
		],
	);
}

/** Recompute every term's mirror so the class starts converged. */
async function converge(): Promise<void> {
	for (const termId of TERMS) {
		await recomputeExternalRelation(EQ_MIRROR, TERM_SECTION, termId, -1, new Date(), {});
	}
}

async function sweepScratch(): Promise<void> {
	await sql.unsafe(`DELETE FROM dd_ontology WHERE tipo LIKE 'test9994%' AND tld = 'test'`);
	await sql.unsafe(
		`DELETE FROM ${SCRATCH_TABLE} WHERE section_tipo = $1 AND section_id = ANY(string_to_array($2, ',')::int[])`,
		[TERM_SECTION, TERMS.join(',')],
	);
	await sql.unsafe(
		`DELETE FROM ${SCRATCH_TABLE} WHERE section_tipo = $1 AND section_id = ANY(string_to_array($2, ',')::int[])`,
		[REF_SECTION, REFS.join(',')],
	);
	await sql.unsafe(`DELETE FROM matrix_time_machine WHERE tipo LIKE 'test9994%'`, []);
	await sql.unsafe(
		`DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = ANY(string_to_array($2, ',')::int[])`,
		[TERM_SECTION, TERMS.join(',')],
	);
}

async function clearResolverCaches(): Promise<void> {
	const { clearOntologyDerivedCaches } = await import(
		'../../src/core/ontology/cache_invalidation.ts'
	);
	await clearOntologyDerivedCaches();
}

/** X—Y and Y—Z stored, mirrors converged: one class of three. */
async function resetToFullChain(): Promise<void> {
	await setEquivalents(TERM_X, [TERM_Y]);
	await setEquivalents(TERM_Y, [TERM_Z]);
	await setEquivalents(TERM_Z, []);
	for (const termId of TERMS) {
		await sql.unsafe(
			`UPDATE ${SCRATCH_TABLE} SET relation = relation - $1 WHERE section_tipo = '${TERM_SECTION}' AND section_id = $2`,
			[EQ_MIRROR, termId],
		);
	}
	await converge();
}

beforeAll(async () => {
	await sweepScratch();
	// The two scratch SECTIONS. `test24` is the matrix_table node whose term is
	// `matrix_test`, so every record below lands there.
	for (const sectionTipo of [TERM_SECTION, REF_SECTION]) {
		await sql.unsafe(
			`INSERT INTO dd_ontology (id, tipo, parent, model, tld, relations, term)
			 VALUES ((SELECT COALESCE(MAX(id), 0) + 1400 FROM dd_ontology), $1, 'test1', 'section', 'test', $2::text::jsonb, $3::text::jsonb)`,
			[
				sectionTipo,
				JSON.stringify([{ tipo: 'test24' }]),
				JSON.stringify({ 'lg-eng': `observer equivalence scratch ${sectionTipo}` }),
			],
		);
	}
	// Each component is declared BY THE SECTION whose records store it: the
	// mirror's HOST PRECONDITION (observer ∈ declaredSectionComponents of the
	// target section — external_laws/resolvers.ts isObserverHostSection)
	// refuses a mirror born on a section that does not declare its observer.
	for (const node of SCRATCH_NODES) {
		const parent = node.tipo === EQ_REF ? REF_SECTION : TERM_SECTION;
		await sql.unsafe(
			`INSERT INTO dd_ontology (id, tipo, parent, model, tld, properties)
			 VALUES ((SELECT COALESCE(MAX(id), 0) + 1400 FROM dd_ontology), $1, $2, $3, 'test', $4::text::jsonb)`,
			[node.tipo, parent, node.model, JSON.stringify(node.properties)],
		);
	}
	await clearResolverCaches();
	// PROVEN, not assumed: SCRATCH_TABLE is hard-coded in every raw statement
	// here, so a section that failed to pick up `test24` would leave its rows
	// where nothing reads them and every mirror would read back empty.
	const { getMatrixTableFromTipo } = await import('../../src/core/ontology/resolver.ts');
	expect(await getMatrixTableFromTipo(TERM_SECTION)).toBe(SCRATCH_TABLE);
	expect(await getMatrixTableFromTipo(REF_SECTION)).toBe(SCRATCH_TABLE);
	// The three class members …
	for (const termId of TERMS) {
		await sql.unsafe(
			`INSERT INTO ${SCRATCH_TABLE} (section_id, section_tipo, relation) VALUES ($1, '${TERM_SECTION}', '{}'::jsonb)`,
			[termId],
		);
	}
	// … and one referencer each (raw INSERT = the bypass shape; the
	// matrix_relation_index trigger still indexes it, which is what the value
	// law searches).
	for (const [index, refId] of REFS.entries()) {
		await sql.unsafe(
			`INSERT INTO ${SCRATCH_TABLE} (section_id, section_tipo, relation) VALUES ($1, '${REF_SECTION}', $2::text::jsonb)`,
			[
				refId,
				JSON.stringify({
					[EQ_REF]: [
						{
							id: 1,
							type: 'dd151',
							section_id: String(TERMS[index]),
							section_tipo: TERM_SECTION,
							from_component_tipo: EQ_REF,
						},
					],
				}),
			],
		);
	}
});

afterAll(async () => {
	await sweepScratch();
	await clearResolverCaches();
});

describe('equivalence-class targets (dd621 closure)', () => {
	test('the chain starts as ONE class: every member mirrors all three referencers', async () => {
		await resetToFullChain();
		// X reaches Z only TRANSITIVELY (X stores Y, Y stores Z) — if the seed
		// were one hop this would be [REF_X, REF_Y].
		expect(await mirrorRefs(TERM_X)).toEqual([REF_X, REF_Y, REF_Z]);
		expect(await mirrorRefs(TERM_Y)).toEqual([REF_X, REF_Y, REF_Z]);
		expect(await mirrorRefs(TERM_Z)).toEqual([REF_X, REF_Y, REF_Z]);
	}, 30000);

	test('a chain SPLIT recomputes the THIRD record, which the save never mentions', async () => {
		await resetToFullChain();
		// Remove Y—Z at Y through the ORDINARY save door. This is the reported
		// user action, and it is the only path that exercises the pre-save
		// snapshot in save_component.ts — a direct propagateToObservers call
		// would not.
		const result = await saveComponentData({
			componentTipo: EQ_PEER,
			sectionTipo: TERM_SECTION,
			sectionId: TERM_Y,
			lang: 'lg-nolan',
			changedData: [{ action: 'set_data', key: 0, value: [] }],
			userId: -1,
		});
		expect(result.ok).toBe(true);
		// The save states what it removed — cause (1).
		expect((result.removedItems as { section_id?: string }[] | undefined)?.length).toBe(1);

		// Y is the saved record (self) and Z is the removed target …
		expect(await mirrorRefs(TERM_Y)).toEqual([REF_X, REF_Y]);
		expect(await mirrorRefs(TERM_Z)).toEqual([REF_Z]);
		// … and X — named NOWHERE in the save, reachable only through the
		// closure of the saved record — recomputed too. THE cause-(3) gate.
		expect(await mirrorRefs(TERM_X)).toEqual([REF_X, REF_Y]);
	}, 30000);

	test('a chain MERGE also recomputes the third record (the expansion is not remove-only)', async () => {
		// Start SPLIT: {X,Y} and {Z}.
		await setEquivalents(TERM_X, [TERM_Y]);
		await setEquivalents(TERM_Y, []);
		await setEquivalents(TERM_Z, []);
		for (const termId of TERMS) {
			await sql.unsafe(
				`UPDATE ${SCRATCH_TABLE} SET relation = relation - $1 WHERE section_tipo = '${TERM_SECTION}' AND section_id = $2`,
				[EQ_MIRROR, termId],
			);
		}
		await converge();
		expect(await mirrorRefs(TERM_X)).toEqual([REF_X, REF_Y]);
		expect(await mirrorRefs(TERM_Z)).toEqual([REF_Z]);

		// Add Y—Z at Y: the two classes merge into one.
		const result = await saveComponentData({
			componentTipo: EQ_PEER,
			sectionTipo: TERM_SECTION,
			sectionId: TERM_Y,
			lang: 'lg-nolan',
			changedData: [
				{
					action: 'set_data',
					key: 0,
					value: [
						{
							id: 1,
							type: 'dd47',
							type_rel: 'dd621',
							section_id: String(TERM_Z),
							section_tipo: TERM_SECTION,
							from_component_tipo: EQ_PEER,
						},
					],
				},
			],
			userId: -1,
		});
		expect(result.ok).toBe(true);
		// X is not in the saved bag either — only in the closure. Without the
		// expansion it keeps the stale 2-member view.
		expect(await mirrorRefs(TERM_X)).toEqual([REF_X, REF_Y, REF_Z]);
		expect(await mirrorRefs(TERM_Y)).toEqual([REF_X, REF_Y, REF_Z]);
		expect(await mirrorRefs(TERM_Z)).toEqual([REF_X, REF_Y, REF_Z]);
	}, 30000);

	test('a legitimate removal is mirrored WITHOUT any shrink refusal', async () => {
		await resetToFullChain();
		const refusedBefore = getCounters().observers_shrink_refused_degraded_seed ?? 0;
		await saveComponentData({
			componentTipo: EQ_PEER,
			sectionTipo: TERM_SECTION,
			sectionId: TERM_Y,
			lang: 'lg-nolan',
			changedData: [{ action: 'set_data', key: 0, value: [] }],
			userId: -1,
		});
		// The seed is clean, so nothing withholds the drop — cause (2).
		expect((getCounters().observers_shrink_refused_degraded_seed ?? 0) - refusedBefore).toBe(0);
		expect(await mirrorRefs(TERM_X)).toEqual([REF_X, REF_Y]);
	}, 30000);

	test('the removal is AUDITED: every recomputed member gets a TM row', async () => {
		await resetToFullChain();
		const before = (await sql.unsafe(
			`SELECT count(*)::int AS c FROM matrix_time_machine WHERE tipo = $1`,
			[EQ_MIRROR],
		)) as { c: number }[];
		await saveComponentData({
			componentTipo: EQ_PEER,
			sectionTipo: TERM_SECTION,
			sectionId: TERM_Y,
			lang: 'lg-nolan',
			changedData: [{ action: 'set_data', key: 0, value: [] }],
			userId: -1,
		});
		const after = (await sql.unsafe(
			`SELECT DISTINCT section_id FROM matrix_time_machine WHERE tipo = $1`,
			[EQ_MIRROR],
		)) as { section_id: number }[];
		// A silent recompute is not acceptable on a value users read.
		expect((before[0]?.c ?? 0) > 0 || after.length > 0).toBe(true);
		expect(after.map((row) => Number(row.section_id)).sort((a, b) => a - b)).toEqual(TERMS);
	}, 30000);
});

// ---------------------------------------------------------------------------
// Static pins — the guard order and the lock order cannot silently regress.
// ---------------------------------------------------------------------------

describe('equivalence expansion (static pins)', () => {
	test('the cheapest test gates the walk: data_from_field BEFORE model/typeRel resolution', () => {
		// An edge with no data_from_field (hierarchy93 ← rsc387 is the live
		// example) must pay NOTHING — not "resolve the model, then find an empty
		// closure". Ordering is the whole cost story: this branch runs on every
		// covered save in the install.
		const dffTest = lawCSource.indexOf('dataFromField.includes(observedTipo)');
		const modelResolve = lawCSource.indexOf('const observedModel = await getModelByTipo(');
		expect(dffTest).toBeGreaterThan(0);
		expect(modelResolve).toBeGreaterThan(dffTest);
		// And the walk itself is gated on the SAME dispatch getStoredWithReferences
		// uses, so a dd620 or non-related peer skips it instead of computing empty.
		expect(lawCSource).toContain("observedModel !== 'component_relation_related'");
		expect(lawCSource).toContain('RELATED_MULTIDIRECTIONAL');
		// The expansion runs for law (c) only, on the observable resolvers.
		expect(resolversSource).toContain("if (input.law.kind === 'inverse_search') {");
		expect(resolversSource).toContain('await expandEquivalenceTargets(');
	});

	test('targets are sorted before the recompute loop, with a total comparator', () => {
		// Each recompute takes the target row's FOR UPDATE lock, and
		// withTransaction JOINS an ambient tx, so the locks accumulate to the
		// outer COMMIT. With class expansion one save can lock every member, so
		// the order it takes them in matters.
		//
		// This pins the ordering of the EXPANDED SET only — it is deliberately
		// NOT a claim of global lock order: the saving record's own FOR UPDATE is
		// taken earlier, outside this set, and a residual window remains (see the
		// kernel comment's HONEST LIMIT note). Do not "strengthen" this test into
		// asserting something the code does not do.
		//
		// The sort is the resolver's (every resolver returns sortTargets(...));
		// the kernel loops over the resolved list and never re-orders it.
		const sortAt = resolversSource.indexOf('function sortTargets(');
		const sortEnd = resolversSource.indexOf('\n}\n', sortAt);
		expect(sortAt).toBeGreaterThan(0);
		expect(resolversSource.slice(sortAt, sortEnd)).toContain('Number.isFinite(left)');
		expect(resolversSource).toContain("return { resolver: 'inverse', targets: sortTargets(");
		expect(resolversSource).toContain(
			'return { resolver: shape.resolver, targets: sortTargets(targets) };',
		);
		const resolveAt = kernelSource.indexOf('const resolved = await resolveObserverTargets(');
		const loopAt = kernelSource.indexOf('for (const target of resolved.targets)');
		expect(resolveAt).toBeGreaterThan(0);
		expect(loopAt).toBeGreaterThan(resolveAt);
		expect(kernelSource.slice(resolveAt, loopAt)).not.toContain('.sort(');
	});

	test('a degenerate class is reported but never refused', () => {
		// Refusing a wide class would re-create exactly the staleness the
		// expansion exists to remove — it is a signal, not a gate.
		expect(lawCSource).toContain("incrementCounter('observers_equivalence_class_wide')");
		expect(lawCSource).toContain('EQUIVALENCE_CLASS_WIDE');
	});
});
