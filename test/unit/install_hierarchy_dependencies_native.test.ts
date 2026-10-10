/**
 * THE WIZARD'S MANDATORY THESAURI (src/core/install/hierarchy_dependencies.ts +
 * ontology_choice.ts withMandatoryHierarchies; 2026-10-10,
 * WC-2026-10-10-ontology-dependencies-hierarchy60) — measured on registry rows
 * the engine's own door wrote.
 *
 * install_hierarchies runs in the process restarted after persist_config, with
 * no plan: the thesauri it MUST install are read back from the registry rows
 * (misc.hierarchy60) of the installed ontologies. This gate builds those rows
 * through createMainSection — the creation door every import uses — and reads
 * them with the step's own reader:
 *  - every `main: 'hierarchy1'` item is collected (mandatory and optional; an
 *    ontology35 item never; a core hierarchy never), merged per TLD with
 *    mandatory winning, dependants in order; a TLD with no row declares nothing;
 *  - a malformed stored item is dropped with a warning, never thrown;
 *  - the step's union: a mandatory vendored thesaurus is added to an empty
 *    posted list; a mandatory one that is not vendored refuses (an error line);
 *    an optional one is left to the posted list.
 *
 *  - THE STEP ITSELF (runInstallStep → install_hierarchies, the wizard's
 *    route): with the core `lg` row declaring thesauri (the step reads the
 *    configured ACTIVE set, which always holds core), a posted [] cannot decline
 *    a mandatory one — a vendored mandatory thesaurus is put in the step's own
 *    install list, and a mandatory one that is not vendored refuses
 *    (install.invalid_input). Both legs post [] so that a BROKEN step has
 *    nothing to import: the gate goes red without writing a thesaurus.
 *
 * SCRATCH: registry rows of `zzhda` / `zzhdb` (`zzhdq` never created), swept
 * with their TM + activity rows; residue asserted zero. The step legs plant a
 * declaration on the suite's real `lg` registry row — its `misc` SNAPSHOTTED
 * first and RESTORED in `finally` (asserted equal) — and one stand-in
 * `<tld>1` row in matrix_hierarchy for a vendored thesaurus the suite does not
 * hold, so the importer SKIPS it (nothing imported, nothing activated); the
 * stand-in is deleted after. Suite database only.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { ApiRequestContext } from '../../src/core/api/handler_context.ts';
import type { Rqo } from '../../src/core/concepts/rqo.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { isDedaloError } from '../../src/core/errors/index.ts';
import { runInstallStep } from '../../src/core/install/engine.ts';
import { installedHierarchyDependencies } from '../../src/core/install/hierarchy_dependencies.ts';
import {
	offeredHierarchyTlds,
	withMandatoryHierarchies,
} from '../../src/core/install/ontology_choice.ts';
import { clearOntologyDerivedCaches } from '../../src/core/ontology/cache_invalidation.ts';
import { createMainSection } from '../../src/core/ontology/ontology_write.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';

const DOOR = 'install_hierarchy_dependencies_native';
const TLD_A = 'zzhda';
const TLD_B = 'zzhdb';
const ABSENT = 'zzhdq';
const SCRATCH = [TLD_A, TLD_B];

/** A real VENDORED thesaurus (installer data read at run time, never a record). */
const VENDORED = [...offeredHierarchyTlds()][0] as string;

const scratchIds: number[] = [];

async function rowId(tld: string): Promise<number | null> {
	const rows = (await sql.unsafe(
		`SELECT section_id FROM matrix_ontology_main
		  WHERE section_tipo = 'ontology35' AND string->'hierarchy6' @> $1::text::jsonb`,
		[JSON.stringify([{ value: tld }])],
	)) as { section_id: number }[];
	return rows[0]?.section_id ?? null;
}

async function sweep(): Promise<number> {
	let removed = 0;
	const del = async (query: string, params: unknown[]): Promise<void> => {
		const result = (await sql.unsafe(query, params as never[])) as unknown as { count?: number };
		removed += Number(result.count ?? 0);
	};
	for (const tld of SCRATCH) {
		const id = await rowId(tld);
		if (id !== null && !scratchIds.includes(id)) scratchIds.push(id);
		await del('DELETE FROM dd_ontology WHERE tld = $1', [tld]);
	}
	const ids = JSON.stringify(scratchIds.map(String));
	const inIds = 'section_id::text IN (SELECT jsonb_array_elements_text($1::text::jsonb))';
	await del(`DELETE FROM matrix_ontology_main WHERE section_tipo = 'ontology35' AND ${inIds}`, [
		ids,
	]);
	await del(`DELETE FROM matrix_time_machine WHERE section_tipo = 'ontology35' AND ${inIds}`, [
		ids,
	]);
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
	const rows = (await sql.unsafe(
		`SELECT (SELECT count(*) FROM matrix_ontology_main WHERE section_tipo = 'ontology35'
		           AND section_id::text IN (SELECT jsonb_array_elements_text($1::text::jsonb)))
		      + (SELECT count(*) FROM matrix_time_machine WHERE section_tipo = 'ontology35'
		           AND section_id::text IN (SELECT jsonb_array_elements_text($1::text::jsonb)))
		        AS n`,
		[JSON.stringify(scratchIds.map(String))],
	)) as { n: number }[];
	return Number(rows[0]?.n ?? -1);
}

beforeAll(async () => {
	await assertTestDatabase(DOOR);
	await sweep();
	// zzhda: the vendored thesaurus MANDATORY, zzhdx optional, its own thesaurus,
	// lg (core — never listed) and an ontology35 item (never a thesaurus).
	await createMainSection(
		{
			tld: TLD_A,
			dependencies: [
				{ tld: VENDORED, main: 'hierarchy1', mandatory: true },
				{ tld: 'zzhdx', main: 'hierarchy1', mandatory: false },
				{ tld: TLD_A, main: 'hierarchy1', mandatory: false },
				{ tld: 'lg', main: 'hierarchy1', mandatory: true },
				{ tld: TLD_B, main: 'ontology35', mandatory: true },
			],
		},
		-1,
	);
	// zzhdb: zzhdx MANDATORY (wins over zzhda's optional), the vendored one optional.
	await createMainSection(
		{
			tld: TLD_B,
			dependencies: [
				{ tld: 'zzhdx', main: 'hierarchy1', mandatory: true },
				{ tld: VENDORED, main: 'hierarchy1', mandatory: false },
			],
		},
		-1,
	);
});

afterAll(async () => {
	const removed = await sweep();
	expect(removed).toBeGreaterThan(0); // the run wrote what it claims
	expect(await residue()).toBe(0);
});

describe('installedHierarchyDependencies (the step reads the registry rows)', () => {
	test('hierarchy1 items merged per TLD, mandatory wins, core + ontology35 items excluded', async () => {
		expect(VENDORED).toMatch(/^[a-z]+$/);
		const read = await installedHierarchyDependencies([TLD_A, TLD_B, ABSENT]);
		expect(read.warnings).toEqual([]);
		expect(read.dependencies).toEqual([
			{ tld: VENDORED, mandatory: true, dependants: [TLD_A, TLD_B] },
			{ tld: 'zzhdx', mandatory: true, dependants: [TLD_A, TLD_B] },
			{ tld: TLD_A, mandatory: false, dependants: [TLD_A] },
		]);
	});

	test('the step union: mandatory vendored added, mandatory unvendored refused, optional left alone', async () => {
		const read = await installedHierarchyDependencies([TLD_A]);
		const onlyVendored = read.dependencies.filter((item) => item.tld !== 'zzhdx');
		const added = withMandatoryHierarchies([], onlyVendored);
		expect(added.hierarchies).toEqual([VENDORED]);
		expect(added.errors).toEqual([]);
		expect(added.notes).toEqual([
			`the thesaurus '${VENDORED}' is a mandatory dependency of '${TLD_A}' — installed`,
		]);
		const both = await installedHierarchyDependencies([TLD_A, TLD_B]);
		expect(withMandatoryHierarchies([], both.dependencies).errors).toEqual([
			`the thesaurus 'zzhdx', a mandatory dependency of '${TLD_A}', '${TLD_B}', is not vendored (no zzhdx1.copy.gz) — it cannot be installed`,
		]);
	});

	test('a malformed stored item is dropped with a warning, never thrown', async () => {
		const id = await rowId(TLD_B);
		expect(id).not.toBeNull();
		await sql.unsafe(
			`UPDATE matrix_ontology_main SET misc = jsonb_set(misc, '{hierarchy60,0,value}', $2::text::jsonb)
			  WHERE section_tipo = 'ontology35' AND section_id = $1`,
			[id, JSON.stringify([{ tld: 'zzhdx', main: 'hierarchy1', mandatory: 'yes' }])],
		);
		const read = await installedHierarchyDependencies([TLD_B]);
		expect(read.dependencies).toEqual([]);
		expect(read.warnings).toHaveLength(1);
		expect(read.warnings[0]).toContain('whose mandatory is not a boolean');
	});
});

// ── the install_hierarchies STEP (the wizard's route) ────────────────────────

/** A logged-in wizard context: the step reads only the session's userId. */
function sessionContext(): ApiRequestContext {
	return {
		requestId: 'zzhd-install-step',
		clientIp: '127.0.0.1',
		session: { userId: -1 } as unknown as NonNullable<ApiRequestContext['session']>,
		csrfCandidate: null,
	};
}

function stepRqo(hierarchies: string[]): Rqo {
	return { action: 'install', options: { action: 'install_hierarchies', hierarchies } } as Rqo;
}

/** The suite's core `lg` registry row id + its `misc`, as stored. */
async function lgRow(): Promise<{ section_id: number; misc: unknown }> {
	const rows = (await sql.unsafe(
		`SELECT section_id, misc FROM matrix_ontology_main
		  WHERE section_tipo = 'ontology35' AND string->'hierarchy6' @> $1::text::jsonb`,
		[JSON.stringify([{ value: 'lg' }])],
	)) as { section_id: number; misc: unknown }[];
	if (rows.length !== 1) throw new Error(`expected one lg registry row, got ${rows.length}`);
	return rows[0] as { section_id: number; misc: unknown };
}

async function setLgMisc(sectionId: number, misc: unknown): Promise<void> {
	await sql.unsafe(
		`UPDATE matrix_ontology_main SET misc = $2::text::jsonb
		  WHERE section_tipo = 'ontology35' AND section_id = $1`,
		[sectionId, misc === null ? null : JSON.stringify(misc)],
	);
}

async function hierarchyRowCount(tld: string): Promise<number> {
	const rows = (await sql.unsafe(
		'SELECT count(*) AS n FROM matrix_hierarchy WHERE section_tipo = $1',
		[`${tld}1`],
	)) as { n: number }[];
	return Number(rows[0]?.n ?? -1);
}

/** A vendored thesaurus the suite database does not hold (no `<tld>1` row). */
async function absentVendored(): Promise<string> {
	for (const tld of [...offeredHierarchyTlds()].sort()) {
		if ((await hierarchyRowCount(tld)) === 0) return tld;
	}
	throw new Error('every vendored thesaurus is installed in the suite database');
}

/** Run `body` with the lg row declaring `dependencies`; lg's misc is restored and checked. */
async function withLgDeclaring(dependencies: unknown[], body: () => Promise<void>): Promise<void> {
	const snapshot = await lgRow();
	try {
		await setLgMisc(snapshot.section_id, {
			...((snapshot.misc as Record<string, unknown> | null) ?? {}),
			hierarchy60: [{ id: 1, value: dependencies }],
		});
		await body();
	} finally {
		await setLgMisc(snapshot.section_id, snapshot.misc);
	}
	expect(await lgRow()).toEqual(snapshot);
}

describe('the install_hierarchies STEP adds the declared mandatory thesauri itself', () => {
	test("a posted [] still installs a vendored MANDATORY thesaurus (the step's own list)", async () => {
		const fresh = await absentVendored();
		// Stand-in row: the importer finds `<fresh>1` present and SKIPS it, so the
		// step's install list is measured without importing a real thesaurus.
		await sql.unsafe(
			`INSERT INTO matrix_hierarchy (section_id, section_tipo, data) VALUES (1, $1, '{}'::jsonb)`,
			[`${fresh}1`],
		);
		try {
			await withLgDeclaring([{ tld: fresh, main: 'hierarchy1', mandatory: true }], async () => {
				const result = await runInstallStep(stepRqo([]), sessionContext());
				const body = result.body as unknown as {
					data: unknown;
					msg: string;
					responses: { tld: string; skipped?: boolean }[];
				};
				expect(body.responses.map((item) => [item.tld, item.skipped === true])).toEqual([
					[fresh, true],
				]);
				expect(body.msg).toContain(
					`the thesaurus '${fresh}' is a mandatory dependency of 'lg' — installed`,
				);
			});
		} finally {
			await sql.unsafe('DELETE FROM matrix_hierarchy WHERE section_tipo = $1', [`${fresh}1`]);
		}
		expect(await hierarchyRowCount(fresh)).toBe(0);
	});

	test('a MANDATORY thesaurus that is not vendored refuses a posted []', async () => {
		// Posted [] on purpose: a step that dropped the refusal would then have
		// nothing to import either — a broken door fails this gate WITHOUT
		// writing a real thesaurus into the suite database.
		const fresh = await absentVendored();
		await withLgDeclaring([{ tld: 'zzhdx', main: 'hierarchy1', mandatory: true }], async () => {
			let refusal: { code: string; message: string } | null = null;
			try {
				await runInstallStep(stepRqo([]), sessionContext());
			} catch (error) {
				if (isDedaloError(error)) refusal = { code: error.code, message: error.message };
			}
			expect(refusal?.code).toBe('install.invalid_input');
			expect(refusal?.message).toContain(
				"the thesaurus 'zzhdx', a mandatory dependency of 'lg', is not vendored",
			);
		});
		expect(await hierarchyRowCount(fresh)).toBe(0);
	});
});
