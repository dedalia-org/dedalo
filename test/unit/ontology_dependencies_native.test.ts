/**
 * DECLARED ONTOLOGY DEPENDENCIES, server side
 * (WC-2026-10-10-ontology-dependencies-hierarchy60) — from the registry row's
 * `misc.hierarchy60` to the field the installer reads in the manifest, and the
 * update's report of what this server lacks.
 *
 *   the import door (syncMainSectionFromDefinition) stores a declaration on the
 *   ontology35 registry row as `misc.hierarchy60 = [{id:1, value:[…]}]`
 *       → getActiveOntologies emits `dependencies` as `{tld, main, mandatory}`
 *         objects through THE shared normalizer (declared order, `(tld, main)`
 *         deduplicated, an ontology35 self-reference dropped, a hierarchy1 one
 *         kept); PRESENT ONLY WHEN DECLARED (a stored `[]` is declared); an
 *         invalid stored item is a census error line, never fatal
 *       → activeOntologiesInfo (what updateOntologyInfo persists into
 *         ontology.json) copies it only when defined
 *       → buildOntologyUpdateInfo (the master's manifest builder) carries it
 *         verbatim, and the client parser reads the same objects back
 *       → reportMissingDependencies (the update's report-only check) names each
 *         declared dependency this server does not provide, with its reason —
 *         mandatory ones as warnings, optional ones as notes; it writes nothing.
 *
 * SCRATCH SURFACE (this file owns it, on the SUITE database — asserted first):
 * registry rows of the scratch TLDs zzka/zzkb/zzkc/zzke, created by the
 * engine's own registry door (createMainSection). `zzkd` is NEVER created: it
 * is the guaranteed-absent dependency. zzke's declaration is planted RAW
 * (malformed items the door itself would refuse) through the key writer, to
 * prove the census drops them loudly. Swept in afterAll with their TM and
 * activity rows, and the residue asserted zero. The real section ids come from
 * the counter — no id band (test isolation is the database, not an id range).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateMatrixKeyData } from '../../src/core/db/matrix_write.ts';
import { sql } from '../../src/core/db/postgres.ts';
import {
	activeOntologiesInfo,
	getActiveOntologies,
	type OntologyCensusEntry,
} from '../../src/core/ontology/data_io.ts';
import { buildOntologyUpdateInfo } from '../../src/core/ontology/data_io_import.ts';
import { reportMissingDependencies } from '../../src/core/ontology/dependency_report.ts';
import {
	HIERARCHY_DEPENDENCIES,
	type OntologyDependency,
} from '../../src/core/ontology/ontology_dependencies.ts';
import { parseOntologyManifest } from '../../src/core/ontology/ontology_manifest.ts';
import { HIERARCHY_TLD, ONTOLOGY_MAIN_SECTION } from '../../src/core/ontology/ontology_tipos.ts';
import {
	createMainSection,
	syncMainSectionFromDefinition,
} from '../../src/core/ontology/ontology_write.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';

const DOOR = 'ontology_dependencies_native';
const SCRATCH = ['zzka', 'zzkb', 'zzkc', 'zzke'] as const;
type ScratchTld = (typeof SCRATCH)[number];

const ids = {} as Record<ScratchTld, number>;

/** zzka's declaration (already normalized: the door refuses anything else). */
const ZZKA_DECLARED: OntologyDependency[] = [
	{ tld: 'zzkb', main: 'ontology35', mandatory: true },
	{ tld: 'dd', main: 'ontology35', mandatory: true },
	// its OWN thesaurus — a valid self-reference
	{ tld: 'zzka', main: 'hierarchy1', mandatory: false },
	// never installed anywhere: the guaranteed-absent dependency, both kinds
	{ tld: 'zzkd', main: 'ontology35', mandatory: true },
	{ tld: 'zzkd', main: 'hierarchy1', mandatory: false },
	// the core lg thesaurus — installed and active on every install
	{ tld: 'lg', main: 'hierarchy1', mandatory: true },
];

/** zzke's planted RAW value: one valid item among malformed ones. */
const ZZKE_PLANTED: unknown[] = [
	{ tld: ' ZZKB ', main: 'ontology35', mandatory: false },
	{ tld: 'zzkb', main: 'ontology35', mandatory: true }, // duplicate (tld, main): first wins
	{ tld: 'zzke', main: 'ontology35', mandatory: true }, // ontology35 self-reference
	{ tld: 'dd', main: 'section', mandatory: true }, // bad main
	{ tld: 'dd', main: 'hierarchy1', mandatory: 'yes' }, // non-boolean mandatory
	'dd', // the retired string shape
];

async function registryIdOf(tld: string): Promise<number | null> {
	const rows = (await sql.unsafe(
		`SELECT section_id FROM matrix_ontology_main
		  WHERE section_tipo = $1 AND string->$2 @> $3::text::jsonb`,
		[ONTOLOGY_MAIN_SECTION, HIERARCHY_TLD, JSON.stringify([{ value: tld }])],
	)) as { section_id: number }[];
	return rows.length === 1 ? Number(rows[0]?.section_id) : null;
}

async function storedMisc(tld: ScratchTld): Promise<Record<string, unknown> | null> {
	const rows = (await sql.unsafe(
		`SELECT misc FROM matrix_ontology_main WHERE section_tipo = $1 AND section_id = $2`,
		[ONTOLOGY_MAIN_SECTION, ids[tld]],
	)) as { misc: Record<string, unknown> | null }[];
	return rows[0]?.misc ?? null;
}

async function sweep(): Promise<number> {
	const scratchIds = JSON.stringify(Object.values(ids).map(String));
	let removed = 0;
	const del = async (query: string, params: unknown[]): Promise<void> => {
		const result = (await sql.unsafe(query, params as never[])) as unknown as { count?: number };
		removed += Number(result.count ?? 0);
	};
	await del(
		`DELETE FROM matrix_ontology_main WHERE section_tipo = $1 AND section_id::text IN (SELECT jsonb_array_elements_text($2::text::jsonb))`,
		[ONTOLOGY_MAIN_SECTION, scratchIds],
	);
	await del(
		`DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id::text IN (SELECT jsonb_array_elements_text($2::text::jsonb))`,
		[ONTOLOGY_MAIN_SECTION, scratchIds],
	);
	// Activity rows address their record in misc->'dd551' (never data->>'section_tipo').
	await del(
		`DELETE FROM matrix_activity WHERE section_tipo = 'dd542'
		    AND misc->'dd551'->0->'value'->>'section_tipo' = $1
		    AND misc->'dd551'->0->'value'->>'section_id' IN (SELECT jsonb_array_elements_text($2::text::jsonb))`,
		[ONTOLOGY_MAIN_SECTION, scratchIds],
	);
	return removed;
}

async function residue(): Promise<number> {
	const scratchIds = JSON.stringify(Object.values(ids).map(String));
	const rows = (await sql.unsafe(
		`SELECT (SELECT count(*) FROM matrix_ontology_main WHERE section_tipo = $1 AND section_id::text IN (SELECT jsonb_array_elements_text($2::text::jsonb)))
		      + (SELECT count(*) FROM matrix_time_machine WHERE section_tipo = $1 AND section_id::text IN (SELECT jsonb_array_elements_text($2::text::jsonb)))
		        AS n`,
		[ONTOLOGY_MAIN_SECTION, scratchIds],
	)) as { n: number }[];
	return Number(rows[0]?.n ?? -1);
}

let census: Awaited<ReturnType<typeof getActiveOntologies>>;
const entry = (tld: string): OntologyCensusEntry | undefined =>
	census.ontologies.find((candidate) => candidate.tld === tld);

beforeAll(async () => {
	await assertTestDatabase(DOOR);
	for (const tld of SCRATCH) {
		if ((await registryIdOf(tld)) !== null)
			throw new Error(`a '${tld}' registry row pre-exists — sweep it first`);
		ids[tld] = await createMainSection({
			tld,
			typology_id: 15,
			name_data: [{ id: 1, lang: 'lg-spa', value: `${tld} scratch` }],
		});
	}
	if ((await registryIdOf('zzkd')) !== null) throw new Error("'zzkd' must never have a row");
	// zzka: declared through the IMPORT door (an existing row: only the definition keys change)
	await syncMainSectionFromDefinition({ tld: 'zzka', dependencies: ZZKA_DECLARED });
	// zzkb: declared EMPTY — "needs nothing", which is not "not declared"
	await syncMainSectionFromDefinition({ tld: 'zzkb', dependencies: [] });
	// zzkc: never declared → no key
	// zzke: a malformed stored value, planted raw (the door would refuse it)
	await updateMatrixKeyData(
		'matrix_ontology_main',
		ONTOLOGY_MAIN_SECTION,
		ids.zzke,
		'misc',
		HIERARCHY_DEPENDENCIES,
		[{ id: 1, value: ZZKE_PLANTED }],
	);
	census = await getActiveOntologies({ activeOnly: true });
}, 60_000);

afterAll(async () => {
	const removed = await sweep();
	expect(removed).toBeGreaterThan(0); // the run wrote what it claims
	expect(await residue()).toBe(0);
});

describe('the stored declaration (misc.hierarchy60, written by the import door)', () => {
	test('a declaration is stored as the component_json shape [{id:1, value:[…]}]', async () => {
		expect((await storedMisc('zzka'))?.[HIERARCHY_DEPENDENCIES]).toEqual([
			{ id: 1, value: ZZKA_DECLARED },
		]);
		expect((await storedMisc('zzkb'))?.[HIERARCHY_DEPENDENCIES]).toEqual([{ id: 1, value: [] }]);
		expect(Object.hasOwn((await storedMisc('zzkc')) ?? {}, HIERARCHY_DEPENDENCIES)).toBe(false);
	});
});

describe('the export census (getActiveOntologies → activeOntologiesInfo → manifest)', () => {
	test('objects in declared order; a TLD twice (one per main) and a hierarchy1 self-reference kept', () => {
		expect(entry('zzka')?.dependencies).toEqual(ZZKA_DECLARED);
	});

	test('a declared [] is PRESENT and empty', () => {
		expect(entry('zzkb')?.dependencies).toEqual([]);
	});

	test('NOT declared is an ABSENT key', () => {
		const found = entry('zzkc');
		expect(found, 'zzkc is in the census').toBeDefined();
		expect(Object.hasOwn(found as object, 'dependencies')).toBe(false);
	});

	test('invalid stored items are dropped into census error lines (normalized like the import), never fatal', () => {
		expect(entry('zzke')?.dependencies).toEqual([
			{ tld: 'zzkb', main: 'ontology35', mandatory: false },
		]);
		const lines = census.errors.filter((line) =>
			line.startsWith(`${ONTOLOGY_MAIN_SECTION}/${ids.zzke}: `),
		);
		expect(lines).toHaveLength(5); // duplicate, self, bad main, bad mandatory, string
		expect(lines.some((line) => line.includes('more than once'))).toBe(true);
		expect(lines.some((line) => line.includes('its own ontology'))).toBe(true);
		expect(lines.some((line) => line.includes('whose main is not one of'))).toBe(true);
		expect(lines.some((line) => line.includes('whose mandatory is not a boolean'))).toBe(true);
		expect(lines.some((line) => line.includes('that is not an object'))).toBe(true);
		// the well-declared rows produce none
		for (const tld of ['zzka', 'zzkb', 'zzkc'] as const) {
			expect(
				census.errors.filter((line) => line.startsWith(`${ONTOLOGY_MAIN_SECTION}/${ids[tld]}:`)),
			).toEqual([]);
		}
	});

	test('activeOntologiesInfo copies dependencies ONLY when declared', () => {
		const info = activeOntologiesInfo(census.ontologies.filter((el) => el.tld.startsWith('zzk')));
		const byTld = new Map(info.map((item) => [item.tld, item]));
		expect(byTld.get('zzka')).toMatchObject({ tld: 'zzka', dependencies: ZZKA_DECLARED });
		expect(byTld.get('zzkb')).toMatchObject({ tld: 'zzkb', dependencies: [] });
		expect(Object.hasOwn(byTld.get('zzkc') as object, 'dependencies')).toBe(false);
	});

	test('the master manifest carries it verbatim, and the client parser reads the same objects back', () => {
		const dir = mkdtempSync(join(tmpdir(), 'zzk_manifest_'));
		try {
			const active = activeOntologiesInfo(
				census.ontologies.filter((el) => el.tld.startsWith('zzk')),
			);
			writeFileSync(
				join(dir, 'ontology.json'),
				JSON.stringify({ version: '7.0.0', active_ontologies: active }),
			);
			for (const tld of ['zzka', 'zzkb', 'zzkc']) writeFileSync(join(dir, `${tld}.copy.gz`), '');
			const manifest = buildOntologyUpdateInfo(dir, 'https://zz.invalid/io/7.0');
			const served = (
				manifest.data.info as { active_ontologies: { tld: string; dependencies?: unknown }[] }
			).active_ontologies;
			expect(served.find((item) => item.tld === 'zzka')?.dependencies).toEqual(ZZKA_DECLARED);
			const parsed = parseOntologyManifest(manifest.data);
			if (!parsed.ok) throw new Error(parsed.reason);
			expect(parsed.warnings).toEqual([]);
			expect(parsed.ontologies.map((item) => [item.tld, item.dependencies])).toEqual([
				['zzka', ZZKA_DECLARED],
				['zzkb', []],
				['zzkc', null],
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('the update report (reportMissingDependencies — report only)', () => {
	test('names each missing dependency with its reason; present ones are silent', async () => {
		const before = JSON.stringify(await storedMisc('zzka'));
		const report = await reportMissingDependencies(['zzka', 'zzkb', 'zzkc']);
		expect(report.invalid).toEqual([]);
		expect(report.missing).toEqual([
			// a registry row, but not in ACTIVE_ONTOLOGY_TLDS (not updated with the others)
			{ dependant: 'zzka', tld: 'zzkb', main: 'ontology35', mandatory: true, reason: 'not_active' },
			// its own thesaurus: there is no zzka hierarchy
			{
				dependant: 'zzka',
				tld: 'zzka',
				main: 'hierarchy1',
				mandatory: false,
				reason: 'no_active_hierarchy',
			},
			{
				dependant: 'zzka',
				tld: 'zzkd',
				main: 'ontology35',
				mandatory: true,
				reason: 'not_installed',
			},
			{
				dependant: 'zzka',
				tld: 'zzkd',
				main: 'hierarchy1',
				mandatory: false,
				reason: 'no_active_hierarchy',
			},
		]); // dd (core ontology) and lg (active core thesaurus) are present
		// mandatory → warnings, optional → notes; each line names both TLDs
		expect(report.warnings).toHaveLength(2);
		expect(report.notes).toHaveLength(2);
		for (const line of [...report.warnings, ...report.notes]) expect(line).toContain("'zzka'");
		expect(report.warnings[1]).toContain("'zzkd' ontology, which is not installed");
		expect(report.notes[1]).toContain("'zzkd' thesaurus");
		// it wrote nothing
		expect(JSON.stringify(await storedMisc('zzka'))).toBe(before);
	});

	test('a malformed stored declaration is reported as invalid, never fatal', async () => {
		const report = await reportMissingDependencies(['zzke']);
		expect(report.invalid).toHaveLength(5);
		// the one valid item (zzkb, optional) is checked like any other
		expect(report.missing.map((item) => [item.tld, item.mandatory, item.reason])).toEqual([
			['zzkb', false, 'not_active'],
		]);
	});
});
