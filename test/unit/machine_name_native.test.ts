/**
 * G2 — THE PARSER DERIVES THE MACHINE-NAME COLUMNS FROM SOURCE RECORDS
 * (WC-2026-11-04-ontology-machine-names, plan §10 G2; the pure kernel is
 * machine_name_kernel.test.ts, the consumers are G1 machine_name_outcome_native).
 *
 * THE SITUATION IS BUILT: raw `matrix_ontology` records of a `zzmp` scratch
 * section (test/helpers/machine_name_scratch.ts) plus two `localontology0`
 * overrides minted by the engine's id allocator, then `rebuildOntology('zzmp')`
 * — the real parse → model fixpoint → upsert path. One record per rung:
 *
 *   zzmp1   table  {lg-spa}                       legacy_lang  (+ override: lg-spa REPLACES)
 *   zzmp2   table  {lg-eng} only                  single_value
 *   zzmp3   table  two distinct lg-spa items      collision → NULL, never a guess
 *   zzmp4   table  {lg-spa:'', lg-eng}            '' is absent → single_value
 *   zzmp5   table  no term                        missing → NULL
 *   zzmp6   table  {lg-eus stray, lg-spa}         lg-spa wins; the stray stays a LABEL
 *   zzmp7   component_input_text (label class)    flag no, no name
 *   zzmp8   table  ontology43 + flag yes + lg-spa the component wins over lg-spa
 *   zzmp9   table  flag NO                        a label + flag_mismatch
 *   zzmp10  model → zzmp11                        model = zzmp11's MACHINE NAME
 *   zzmp11  table  {lg-eng} only                  a model whose name has no lg-spa at all
 *   zzmp12  table  {lg-spa}                       (+ override: lg-eng only → never renames)
 *   zzmp13  table  converted (43 + flag yes)      (+ override: LEGACY lg-spa rename → it wins)
 *   zzmp14  table  flag yes, NO 43, {lg-eus}      converted: missing — the stray never names it
 *   zzmp15  table  converted, 43 only, NO term    D16 (lg-spa moved out): named by 43 alone
 *   zzmp16  model → zzmp15                        model = zzmp15's name, read from 43 alone
 *
 * ontology43/44 ARE READ EVEN WHERE THE RELEASE DOES NOT DEFINE THEM (parser.ts
 * MACHINE_NAME_CONTRACT_MODELS): the update that FIRST brings them also brings
 * converted records, parsed before ontology43's own row exists. zzmp15/16 are that
 * first arrival on scratch — without the contract-model read both derive NULL and
 * the model chain dies (the S0 circle). A record carrying no such key reads empty,
 * so a legacy release still degrades to the rungs.
 *
 * MUTATION PROOF: the expected names differ from what the deleted readers
 * picked (`term['lg-spa'] ?? first non-empty`) on zzmp3/zzmp4/zzmp10/zzmp14 —
 * reading term instead of the column, or guessing a collision, turns a leg red.
 * Measured 2026-11-04: a kernel that picks the first of several candidates
 * reddens 3 legs; a model fixpoint reading `term['lg-spa']` reddens 2.
 *
 * Needs the suite DB (assertTestDatabase before the first write; everything
 * zzmp and the minted override ids swept before and after, zero residue).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { insertMatrixRecordWithCounter } from '../../src/core/db/matrix_write.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { clearOntologyDerivedCaches } from '../../src/core/ontology/cache_invalidation.ts';
import { labelByTipo, termByTipo } from '../../src/core/ontology/labels.ts';
import {
	inspectOntology,
	type OntologyWriteResult,
	rebuildOntology,
} from '../../src/core/ontology/ontology_state.ts';
import { getModelByTipo } from '../../src/core/ontology/resolver.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import {
	modelTipoNamed,
	type ScratchRecord,
	seedMachineNameScratch,
	sweepMachineNameScratch,
} from '../helpers/machine_name_scratch.ts';

const TLD = 'zzmp';
const SECTION = `${TLD}0`;
const LOCAL = 'localontology0';
/** The localontology0 ids this run minted (allocator-issued) — the only ones swept by id. */
const LOCAL_IDS: number[] = [];

const item = (id: number, lang: string, value: string) => ({ id, lang, value });

const locator = (sectionTipo: string, sectionId: number, from: string) => ({
	id: 1,
	type: 'dd151',
	section_id: String(sectionId),
	section_tipo: sectionTipo,
	from_component_tipo: from,
});

/** One raw source record per rung (see the header table). */
async function records(): Promise<ScratchRecord[]> {
	const table = await modelTipoNamed('table');
	const inputText = await modelTipoNamed('component_input_text');
	return [
		{ sectionId: 1, modelTipo: table, term: [item(1, 'lg-spa', 'zzmp_spa')] },
		{ sectionId: 2, modelTipo: table, term: [item(1, 'lg-eng', 'zzmp_eng')] },
		{
			sectionId: 3,
			modelTipo: table,
			term: [item(1, 'lg-spa', 'zzmp_a'), item(2, 'lg-spa', 'zzmp_b')],
		},
		{
			sectionId: 4,
			modelTipo: table,
			term: [item(1, 'lg-spa', ''), item(2, 'lg-eng', 'zzmp_after_empty')],
		},
		{ sectionId: 5, modelTipo: table },
		{
			sectionId: 6,
			modelTipo: table,
			term: [item(1, 'lg-eus', 'Berria'), item(2, 'lg-spa', 'zzmp_body')],
		},
		{
			sectionId: 7,
			modelTipo: inputText,
			term: [item(1, 'lg-eng', 'A label'), item(2, 'lg-spa', 'Una etiqueta')],
		},
		{
			sectionId: 8,
			modelTipo: table,
			term: [item(1, 'lg-spa', 'zzmp_legacy')],
			machineName: 'zzmp_component',
			flag: true,
		},
		{ sectionId: 9, modelTipo: table, term: [item(1, 'lg-spa', 'zzmp_flag_no')], flag: false },
		{ sectionId: 10, modelTipo: `${TLD}11`, term: [item(1, 'lg-eng', 'Typed by zzmp11')] },
		{ sectionId: 11, modelTipo: table, term: [item(1, 'lg-eng', 'zzmp_model_name')] },
		{ sectionId: 12, modelTipo: table, term: [item(1, 'lg-spa', 'zzmp_keep')] },
		{ sectionId: 13, modelTipo: table, machineName: 'zzmp_canon', flag: true },
		{ sectionId: 14, modelTipo: table, term: [item(1, 'lg-eus', 'Berria')], flag: true },
		{ sectionId: 15, modelTipo: table, machineName: 'zzmp_d16_model', flag: true },
		{ sectionId: 16, modelTipo: `${TLD}15`, term: [item(1, 'lg-eng', 'Typed by zzmp15')] },
	];
}

/** A localontology0 override of `zzmp0/<target>`, at an allocator-minted id. */
async function seedOverride(
	target: number,
	string: Record<string, unknown>,
	relation: Record<string, unknown> = {},
): Promise<void> {
	await assertTestDatabase('machine_name_native seedOverride');
	const localId = await insertMatrixRecordWithCounter('matrix_ontology', LOCAL, {
		data: { section_tipo: LOCAL },
		relation: {
			ontology42: [locator(SECTION, target, 'ontology42')],
			ontology8: [locator('dd64', 1, 'ontology8')],
			ontology30: [locator('dd64', 2, 'ontology30')],
			...relation,
		},
		string: { ontology7: [item(1, 'lg-nolan', 'localontology')], ...string },
	});
	LOCAL_IDS.push(localId);
}

/** zzmp's scratch records, its projection, and every override of a zzmp0 node. */
async function sweep(): Promise<void> {
	await assertTestDatabase('machine_name_native sweep');
	await sql.unsafe(
		`DELETE FROM matrix_ontology WHERE section_tipo = $1
		   AND (section_id = ANY($2::int[]) OR relation->'ontology42' @> $3::text::jsonb)`,
		[LOCAL, `{${LOCAL_IDS.join(',')}}`, JSON.stringify([{ section_tipo: SECTION }])],
	);
	await sql.unsafe(
		`DELETE FROM matrix_ontology_main WHERE section_tipo = 'ontology35' AND string @> $1::text::jsonb`,
		[JSON.stringify({ hierarchy6: [{ value: TLD }] })],
	);
	await sweepMachineNameScratch(TLD);
}

interface StoredPair {
	machine_name: string | null;
	use_machine_name: boolean | null;
	model: string | null;
}

async function stored(): Promise<Record<string, StoredPair>> {
	const rows = (await sql.unsafe(
		`SELECT tipo, machine_name, use_machine_name, model FROM dd_ontology
		  WHERE tld = $1 AND tipo <> $2`,
		[TLD, SECTION],
	)) as ({ tipo: string } & StoredPair)[];
	return Object.fromEntries(rows.map(({ tipo, ...pair }) => [tipo, pair]));
}

/** The deleted readers' rule (lg-spa, else first non-empty) over a record's term items. */
function legacyReading(term: ScratchRecord['term']): string | null {
	const items = term ?? [];
	return (
		items.find((entry) => entry.lang === 'lg-spa')?.value ??
		items.find((entry) => entry.value !== '')?.value ??
		null
	);
}

let armed = false;
let seeded: ScratchRecord[] = [];
let outcome: OntologyWriteResult;
let pairs: Record<string, StoredPair> = {};

beforeAll(async () => {
	armed =
		(await getModelByTipo('ontology43')) !== null && (await getModelByTipo('ontology44')) !== null;
	await sweep();
	seeded = await records();
	await seedMachineNameScratch(TLD, seeded);
	// an lg-spa override REPLACES the name (+ a flag flip and, armed, its own ontology43)
	await seedOverride(
		1,
		{
			ontology5: [item(1, 'lg-spa', 'zzmp_override_spa')],
			ontology43: [item(1, 'lg-nolan', 'zzmp_override_component')],
		},
		{ ontology44: [locator('dd64', 2, 'ontology44')] },
	);
	// a non-spa override is a label: it never renames
	await seedOverride(12, { ontology5: [item(1, 'lg-eng', 'zzmp_override_eng')] });
	// an UNCONVERTED override (lg-spa, no ontology43) of a converted node still renames it
	await seedOverride(13, { ontology5: [item(1, 'lg-spa', 'zzmp_override_legacy')] });
	await clearOntologyDerivedCaches();
	outcome = await rebuildOntology(TLD, -1);
	pairs = await stored();
}, 60000);

afterAll(async () => {
	await sweep();
	const left = (await sql.unsafe(
		`SELECT (SELECT count(*)::int FROM dd_ontology WHERE tld = $1)
		      + (SELECT count(*)::int FROM matrix_ontology WHERE section_tipo = $2)
		      + (SELECT count(*)::int FROM matrix_ontology WHERE section_tipo = $3
		           AND section_id = ANY($4::int[])) AS n`,
		[TLD, SECTION, LOCAL, `{${LOCAL_IDS.join(',')}}`],
	)) as { n: number }[];
	expect(left[0]?.n).toBe(0);
}, 60000);

describe('machine-name derivation from source records (G2)', () => {
	test('the rebuild converges: one bad node never refuses its tld', () => {
		expect(seeded.length).toBeGreaterThan(10);
		expect(outcome.errors).toEqual([]);
		expect(outcome.ok).toBe(true);
		expect(outcome.state.matrixNodes).toBe(seeded.length);
	});

	test('floor: on the discriminating records the deleted readers picked something else', () => {
		const byId = new Map(seeded.map((record) => [record.sectionId, record]));
		expect(legacyReading(byId.get(3)?.term)).toBe('zzmp_a'); // expected: NULL (collision)
		expect(legacyReading(byId.get(4)?.term)).toBe(''); // expected: zzmp_after_empty
		expect(legacyReading(byId.get(14)?.term)).toBe('Berria'); // expected: NULL (missing)
		// zzmp10's model: the old fixpoint read the model row's lg-spa — zzmp11 has none
		expect(byId.get(11)?.term?.some((entry) => entry.lang === 'lg-spa')).toBe(false);
	});

	test('the name rungs: lg-spa, single value, `` absent, collision and missing → NULL', () => {
		expect(pairs.zzmp2).toMatchObject({ machine_name: 'zzmp_eng', use_machine_name: true });
		expect(pairs.zzmp3).toMatchObject({ machine_name: null, use_machine_name: true });
		expect(pairs.zzmp4).toMatchObject({ machine_name: 'zzmp_after_empty', use_machine_name: true });
		expect(pairs.zzmp5).toMatchObject({ machine_name: null, use_machine_name: true });
		expect(pairs.zzmp6).toMatchObject({ machine_name: 'zzmp_body', use_machine_name: true });
	});

	test('a label-class node carries no name; its labels stay translations', async () => {
		expect(pairs.zzmp7).toMatchObject({
			machine_name: null,
			use_machine_name: false,
			model: 'component_input_text',
		});
		expect(await labelByTipo('zzmp7', 'lg-eng')).toBe('A label');
		expect(await labelByTipo('zzmp7', 'lg-spa')).toBe('Una etiqueta');
	});

	test('a stray translation on a name node is a LABEL, never the name', async () => {
		expect(await termByTipo('zzmp6', 'lg-eus')).toBe('Berria');
		expect(pairs.zzmp6?.machine_name).toBe('zzmp_body');
	});

	test("`model` is the model node's MACHINE NAME — through the fixpoint, even with no lg-spa", () => {
		expect(pairs.zzmp11).toMatchObject({ machine_name: 'zzmp_model_name', model: 'table' });
		expect(pairs.zzmp10?.model).toBe('zzmp_model_name');
		// a model the closed list does not name: the instance is a label
		expect(pairs.zzmp10?.use_machine_name).toBe(false);
	});

	test('ontology43 / ontology44 are read — also where the release does not define them yet', () => {
		// recorded so the day the release arms them is visible; the parser reads either way
		expect(typeof armed).toBe('boolean');
		expect(pairs.zzmp8).toMatchObject({ machine_name: 'zzmp_component', use_machine_name: true });
		expect(pairs.zzmp9).toMatchObject({ machine_name: null, use_machine_name: false });
	});

	test('first arrival (D16): a converted node with NO ontology5 is named, and its instances typed, by 43 alone', () => {
		expect(pairs.zzmp15).toMatchObject({ machine_name: 'zzmp_d16_model', use_machine_name: true });
		expect(pairs.zzmp16?.model).toBe('zzmp_d16_model');
	});

	test('a converted node is named by ontology43 alone: a stray label never fills an empty one', () => {
		expect(pairs.zzmp14).toMatchObject({ machine_name: null, use_machine_name: true });
	});

	test('an override REPLACES the name; a non-spa override never renames; the flag never flips', async () => {
		expect(pairs.zzmp1).toMatchObject({
			machine_name: 'zzmp_override_component',
			use_machine_name: true,
		});
		expect(pairs.zzmp12).toMatchObject({ machine_name: 'zzmp_keep', use_machine_name: true });
		expect(await termByTipo('zzmp12', 'lg-eng')).toBe('zzmp_override_eng');
	});

	test("an unconverted override's lg-spa rename wins over the converted canonical ontology43", () => {
		expect(pairs.zzmp13).toMatchObject({
			machine_name: 'zzmp_override_legacy',
			use_machine_name: true,
		});
	});

	test('the defects are reported by source record, on their own channel', () => {
		const kinds = outcome.state.machineNameDefects
			.map((defect) => `${defect.tipo}:${defect.kind}`)
			.sort();
		const expected = [
			'zzmp3:collision',
			'zzmp5:missing',
			'zzmp14:missing',
			'zzmp1:override_flag_flip',
			'zzmp9:flag_mismatch',
		];
		expect(kinds).toEqual(expected.sort());
		const collision = outcome.state.machineNameDefects.find((defect) => defect.tipo === 'zzmp3');
		expect(collision?.source).toBe(`${SECTION}/3`);
		expect(collision?.values).toEqual(['zzmp_a', 'zzmp_b']);
	});

	test('the legacy rungs are tallied per node (the G6 bridge measure)', () => {
		const tally = outcome.state.machineNameLegacyRungs;
		// every record that states no ontology44 derives it (zzmp8/9/13/14/15 state it)
		expect(tally.derived_flag).toBe(seeded.length - 5);
		// lg-spa named: zzmp6, zzmp12, and zzmp13 through its unconverted override
		expect(tally.legacy_lang).toBe(3);
		// single value: zzmp2, zzmp4, zzmp11
		expect(tally.single_value).toBe(3);
	});

	test('inspect after the rebuild: in sync, and the same findings', async () => {
		const state = await inspectOntology(TLD);
		expect(state.drift).toEqual([]);
		expect(state.machineNameDefects.length).toBe(outcome.state.machineNameDefects.length);
	});
});
