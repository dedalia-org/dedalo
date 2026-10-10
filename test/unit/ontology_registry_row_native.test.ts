/**
 * THE REGISTRY-ROW LAW (src/core/ontology/ontology_write.ts; owner-approved
 * 2026-10-10, WC-2026-10-10-ontology-dependencies-hierarchy60) — measured by
 * running the doors and reading the `matrix_ontology_main` row back.
 *
 *  - createMainSection mints the whole contract: hierarchy4 YES, hierarchy125
 *    no (not 'dd'), hierarchy8 = the lg1 record of STRUCTURE_LANG (resolved,
 *    never a hard-coded id), hierarchy54 dd153/1, name/tld/target/typology,
 *    hierarchy60 in `misc` when declared. An existing row is refused.
 *  - syncMainSectionFromDefinition (the import door) on an EXISTING row writes
 *    only hierarchy5/9/60 from the definition (each only when stated), keeps a
 *    switched-off DOMAIN TLD off, switches a CORE TLD back on, re-applies the
 *    hierarchy125 + hierarchy8 rules, and leaves hierarchy54 and every other
 *    key alone. Absent `dependencies` = not declared = local value kept; `[]`
 *    is written. Unnormalized dependencies are refused before any write.
 *  - rebuildOntology (ensureMainNode) and ensureMainSection never write an
 *    existing row; `<tld>0` is rebuilt from what the row holds.
 *  - an unresolvable structure language is refused, typed (ontology.invalid_node).
 *
 * THE CORE BRANCH, HONESTLY: isCoreOntologyTld is decided by the TLD name, so
 * no scratch TLD can take it. The gate uses the suite's real core `lg` row:
 * every column is SNAPSHOTTED first, the row switched off, the import door run
 * with the row's own name/typology, and the snapshot RESTORED in `finally`
 * (asserted equal). Suite database only (asserted first).
 *
 * SCRATCH: registry rows of `zzrra` / `zzrrb` (+ the `zzrrb0` dd_ontology root
 * node the rebuild mints), swept with their TM and activity rows; residue
 * asserted zero.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from '../../src/core/db/postgres.ts';
import { DedaloError } from '../../src/core/errors/dedalo_error.ts';
import { clearOntologyDerivedCaches } from '../../src/core/ontology/cache_invalidation.ts';
import { rebuildOntology } from '../../src/core/ontology/ontology_state.ts';
import { STRUCTURE_LANG } from '../../src/core/ontology/ontology_tipos.ts';
import {
	createMainSection,
	ensureMainSection,
	getMainNameData,
	getMainTypologyId,
	resolveRegistryLangId,
	syncMainSectionFromDefinition,
} from '../../src/core/ontology/ontology_write.ts';
import { getLangSectionIdByCode } from '../../src/core/relations/select_lang.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';

const DOOR = 'ontology_registry_row_native';
const TLD_A = 'zzrra';
const TLD_B = 'zzrrb';
const SCRATCH = [TLD_A, TLD_B];

type Json = Record<string, unknown[]>;
interface Row {
	section_id: number;
	data: unknown;
	relation: Json | null;
	string: Json | null;
	misc: Json | null;
}

async function rowOf(tld: string): Promise<Row | null> {
	const rows = (await sql.unsafe(
		`SELECT section_id, data, relation, string, misc FROM matrix_ontology_main
		  WHERE section_tipo = 'ontology35' AND string->'hierarchy6' @> $1::text::jsonb`,
		[JSON.stringify([{ value: tld }])],
	)) as Row[];
	if (rows.length > 1) throw new Error(`'${tld}' has ${rows.length} registry rows`);
	return rows[0] ?? null;
}

async function mustRow(tld: string): Promise<Row> {
	const row = await rowOf(tld);
	if (row === null) throw new Error(`no registry row for '${tld}'`);
	return row;
}

/** First locator's section_tipo/section_id of a relation key (numbers compared as numbers). */
function link(row: Row, tipo: string): { section_tipo: unknown; section_id: number } | null {
	const first = row.relation?.[tipo]?.[0] as
		| { section_tipo?: unknown; section_id?: unknown }
		| undefined;
	return first === undefined
		? null
		: { section_tipo: first.section_tipo, section_id: Number(first.section_id) };
}

/** Merge raw keys into one column — the "operator edited the row" step. */
async function operatorSets(
	sectionId: number,
	column: 'relation' | 'string' | 'misc',
	value: Record<string, unknown>,
): Promise<void> {
	await sql.unsafe(
		`UPDATE matrix_ontology_main SET "${column}" = COALESCE("${column}", '{}'::jsonb) || $2::text::jsonb
		  WHERE section_tipo = 'ontology35' AND section_id = $1`,
		[sectionId, JSON.stringify(value)],
	);
}

const OFF = [
	{ id: 1, type: 'dd151', section_id: 2, section_tipo: 'dd64', from_component_tipo: 'hierarchy4' },
];
const CUSTOM_FILTER = [
	{
		id: 1,
		type: 'dd675',
		section_id: 7,
		section_tipo: 'dd153',
		from_component_tipo: 'hierarchy54',
	},
];
const YES_IN_THESAURUS = [
	{
		id: 1,
		type: 'dd151',
		section_id: 1,
		section_tipo: 'dd64',
		from_component_tipo: 'hierarchy125',
	},
];
const BOGUS_LANG = [
	{ id: 1, type: 'dd151', section_id: 1, section_tipo: 'lg1', from_component_tipo: 'hierarchy8' },
];

const scratchIds: number[] = [];

async function sweep(): Promise<number> {
	let removed = 0;
	const del = async (query: string, params: unknown[]): Promise<void> => {
		const result = (await sql.unsafe(query, params as never[])) as unknown as { count?: number };
		removed += Number(result.count ?? 0);
	};
	for (const tld of SCRATCH) {
		const row = await rowOf(tld);
		if (row !== null && !scratchIds.includes(row.section_id)) scratchIds.push(row.section_id);
		await del('DELETE FROM dd_ontology WHERE tld = $1', [tld]);
	}
	const ids = JSON.stringify(scratchIds.map(String));
	await del(
		`DELETE FROM matrix_ontology_main WHERE section_tipo = 'ontology35' AND section_id::text IN (SELECT jsonb_array_elements_text($1::text::jsonb))`,
		[ids],
	);
	await del(
		`DELETE FROM matrix_time_machine WHERE section_tipo = 'ontology35' AND section_id::text IN (SELECT jsonb_array_elements_text($1::text::jsonb))`,
		[ids],
	);
	// Activity rows address their record in misc->'dd551' (never data->>'section_tipo').
	await del(
		`DELETE FROM matrix_activity WHERE section_tipo = 'dd542'
		    AND misc->'dd551'->0->'value'->>'section_tipo' = 'ontology35'
		    AND misc->'dd551'->0->'value'->>'section_id' IN (SELECT jsonb_array_elements_text($1::text::jsonb))`,
		[ids],
	);
	await clearOntologyDerivedCaches();
	return removed;
}

async function residue(): Promise<number> {
	const ids = JSON.stringify(scratchIds.map(String));
	const rows = (await sql.unsafe(
		`SELECT (SELECT count(*) FROM matrix_ontology_main WHERE section_tipo = 'ontology35' AND section_id::text IN (SELECT jsonb_array_elements_text($1::text::jsonb)))
		      + (SELECT count(*) FROM matrix_time_machine WHERE section_tipo = 'ontology35' AND section_id::text IN (SELECT jsonb_array_elements_text($1::text::jsonb)))
		      + (SELECT count(*) FROM dd_ontology WHERE tld IN (SELECT jsonb_array_elements_text($2::text::jsonb)))
		        AS n`,
		[ids, JSON.stringify(SCRATCH)],
	)) as { n: number }[];
	return Number(rows[0]?.n ?? -1);
}

let structureLangId = 0;

beforeAll(async () => {
	await assertTestDatabase(DOOR);
	await sweep();
	const resolved = await getLangSectionIdByCode(STRUCTURE_LANG);
	if (resolved === null) throw new Error(`the suite DB has no lg1 record for ${STRUCTURE_LANG}`);
	structureLangId = resolved;
});

afterAll(async () => {
	const removed = await sweep();
	expect(removed).toBeGreaterThan(0); // the run wrote what it claims
	expect(await residue()).toBe(0);
});

describe('createMainSection — the whole contract, only for a TLD without a row', () => {
	test('a new domain TLD is born ACTIVE, filed under STRUCTURE_LANG, with its declaration', async () => {
		const sectionId = await createMainSection({
			tld: TLD_A,
			typology_id: 14,
			name_data: [{ lang: 'lg-eng', value: 'Registry probe A' }],
			dependencies: [{ tld: TLD_B, main: 'ontology35', mandatory: true }],
		});
		scratchIds.push(sectionId);
		const row = await mustRow(TLD_A);
		expect(row.section_id).toBe(sectionId);
		expect(link(row, 'hierarchy4')).toEqual({ section_tipo: 'dd64', section_id: 1 });
		expect(link(row, 'hierarchy125')).toEqual({ section_tipo: 'dd64', section_id: 2 });
		expect(link(row, 'hierarchy8')).toEqual({ section_tipo: 'lg1', section_id: structureLangId });
		expect(link(row, 'hierarchy54')).toEqual({ section_tipo: 'dd153', section_id: 1 });
		expect(link(row, 'hierarchy9')).toEqual({ section_tipo: 'hierarchy13', section_id: 14 });
		expect(row.string?.hierarchy5).toEqual([{ id: 1, lang: 'lg-eng', value: 'Registry probe A' }]);
		expect(row.string?.hierarchy6).toEqual([{ id: 1, lang: 'lg-nolan', value: TLD_A }]);
		expect(row.string?.hierarchy53).toEqual([{ id: 1, lang: 'lg-nolan', value: `${TLD_A}0` }]);
		expect(row.misc?.hierarchy60).toEqual([
			{ id: 1, value: [{ tld: TLD_B, main: 'ontology35', mandatory: true }] },
		]);
		expect(row.relation?.hierarchy45).toBeUndefined(); // general-term children: 'dd' only
	});

	test('a TLD that already has a row is refused (and nothing changes)', async () => {
		const before = await mustRow(TLD_A);
		await expect(createMainSection({ tld: TLD_A })).rejects.toThrow('already has');
		expect(await mustRow(TLD_A)).toEqual(before);
	});
});

describe('syncMainSectionFromDefinition — the import door on an EXISTING row', () => {
	test('replaces name/typology/dependencies; keeps a switched-off domain TLD off and the operator keys', async () => {
		const { section_id } = await mustRow(TLD_A);
		await operatorSets(section_id, 'relation', {
			hierarchy4: OFF,
			hierarchy54: CUSTOM_FILTER,
			hierarchy8: BOGUS_LANG,
		});
		await operatorSets(section_id, 'string', {
			hierarchy53: [{ id: 1, lang: 'lg-nolan', value: 'zzrraoperator1' }],
		});

		const returned = await syncMainSectionFromDefinition({
			tld: TLD_A,
			typology_id: 15,
			name_data: [{ lang: 'lg-spa', value: 'Sonda B' }],
			dependencies: [
				{ tld: 'dd', main: 'hierarchy1', mandatory: false },
				{ tld: TLD_A, main: 'hierarchy1', mandatory: true },
			],
		});
		expect(returned).toBe(section_id);
		const row = await mustRow(TLD_A);
		// the installation's keys
		expect(row.relation?.hierarchy4).toEqual(OFF);
		expect(row.relation?.hierarchy54).toEqual(CUSTOM_FILTER);
		expect(row.string?.hierarchy53).toEqual([{ id: 1, lang: 'lg-nolan', value: 'zzrraoperator1' }]);
		// the definition's keys
		expect(row.string?.hierarchy5).toEqual([{ id: 1, lang: 'lg-spa', value: 'Sonda B' }]);
		expect(link(row, 'hierarchy9')).toEqual({ section_tipo: 'hierarchy13', section_id: 15 });
		expect(row.misc?.hierarchy60).toEqual([
			{
				id: 1,
				value: [
					{ tld: 'dd', main: 'hierarchy1', mandatory: false },
					{ tld: TLD_A, main: 'hierarchy1', mandatory: true },
				],
			},
		]);
		// the rules
		expect(link(row, 'hierarchy8')).toEqual({ section_tipo: 'lg1', section_id: structureLangId });
		expect(link(row, 'hierarchy125')).toEqual({ section_tipo: 'dd64', section_id: 2 });
	});

	test('a definition that states nothing leaves name, typology and dependencies alone', async () => {
		const before = await mustRow(TLD_A);
		await syncMainSectionFromDefinition({ tld: TLD_A });
		const after = await mustRow(TLD_A);
		expect(after.string?.hierarchy5).toEqual(before.string?.hierarchy5);
		expect(after.relation?.hierarchy9).toEqual(before.relation?.hierarchy9);
		expect(after.misc?.hierarchy60).toEqual(before.misc?.hierarchy60);
		expect(after.relation?.hierarchy4).toEqual(OFF);
	});

	test('a declared [] is written (declared, needs nothing)', async () => {
		await syncMainSectionFromDefinition({ tld: TLD_A, dependencies: [] });
		expect((await mustRow(TLD_A)).misc?.hierarchy60).toEqual([{ id: 1, value: [] }]);
	});

	test('unnormalized dependencies are refused before any write', async () => {
		const before = await mustRow(TLD_A);
		const duplicate = { tld: 'dd', main: 'ontology35' as const, mandatory: true };
		await expect(
			syncMainSectionFromDefinition({
				tld: TLD_A,
				name_data: [{ lang: 'lg-spa', value: 'must not land' }],
				dependencies: [duplicate, duplicate],
			}),
		).rejects.toThrow('not normalized');
		expect(await mustRow(TLD_A)).toEqual(before);
	});

	test('a switched-off CORE TLD is switched back on (real lg row, snapshot + restore)', async () => {
		const snapshot = await mustRow('lg');
		try {
			await operatorSets(snapshot.section_id, 'relation', { hierarchy4: OFF });
			await syncMainSectionFromDefinition({
				tld: 'lg',
				typology_id: await getMainTypologyId('lg'),
				name_data: await getMainNameData('lg'),
			});
			expect(link(await mustRow('lg'), 'hierarchy4')).toEqual({
				section_tipo: 'dd64',
				section_id: 1,
			});
		} finally {
			await sql.unsafe(
				`UPDATE matrix_ontology_main SET data = $2::text::jsonb, relation = $3::text::jsonb,
				        string = $4::text::jsonb, misc = $5::text::jsonb
				  WHERE section_tipo = 'ontology35' AND section_id = $1`,
				[
					snapshot.section_id,
					JSON.stringify(snapshot.data),
					JSON.stringify(snapshot.relation),
					JSON.stringify(snapshot.string),
					snapshot.misc === null ? null : JSON.stringify(snapshot.misc),
				],
			);
		}
		expect(await mustRow('lg')).toEqual(snapshot);
	});
});

describe('the rebuild doors never write an existing row', () => {
	test('ensureMainSection on an existing row: no write', async () => {
		const before = await mustRow(TLD_A);
		const outcome = await ensureMainSection({
			tld: TLD_A,
			typology_id: 3,
			name_data: [{ lang: 'lg-eng', value: 'ignored' }],
		});
		expect(outcome).toEqual({ sectionId: before.section_id, created: false });
		expect(await mustRow(TLD_A)).toEqual(before);
	});

	test('rebuildOntology leaves the row untouched and builds <tld>0 from it', async () => {
		const sectionId = await createMainSection({
			tld: TLD_B,
			typology_id: 14,
			name_data: [{ lang: 'lg-eng', value: 'Registry probe B' }],
		});
		scratchIds.push(sectionId);
		// Plant also what the IMPORT door would correct (hierarchy8 → STRUCTURE_LANG,
		// hierarchy125 → the dd-only rule): a rebuild that went through
		// syncMainSectionFromDefinition would rewrite them, so the row would differ.
		await operatorSets(sectionId, 'relation', {
			hierarchy4: OFF,
			hierarchy54: CUSTOM_FILTER,
			hierarchy8: BOGUS_LANG,
			hierarchy125: YES_IN_THESAURUS,
		});
		const before = await mustRow(TLD_B);

		const result = await rebuildOntology(TLD_B);
		expect(result.errors).toEqual([]);
		expect(await mustRow(TLD_B)).toEqual(before);
		const nodes = (await sql.unsafe('SELECT parent, term FROM dd_ontology WHERE tipo = $1', [
			`${TLD_B}0`,
		])) as { parent: string; term: Record<string, string> }[];
		expect(nodes.length).toBe(1);
		expect(nodes[0]?.parent).toBe('ontologytype14');
		expect(nodes[0]?.term['lg-eng']).toBe('Registry probe B');
	});
});

describe('hierarchy8 is resolved, never guessed', () => {
	test('STRUCTURE_LANG resolves to its lg1 record', async () => {
		expect(await resolveRegistryLangId()).toBe(structureLangId);
	});
	test('an unresolvable language is refused, typed', async () => {
		let caught: unknown = null;
		try {
			await resolveRegistryLangId('lg-zzq');
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(DedaloError);
		expect((caught as DedaloError).code).toBe('ontology.invalid_node');
	});
});
