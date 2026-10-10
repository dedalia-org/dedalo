/**
 * install_hierarchies ACTIVATES what it imports — TS-NATIVE install contract.
 *
 * The wizard's hierarchy step used to COPY the `<tld>1.copy.gz` term rows into
 * matrix_hierarchy and stop there (its own header called full activation "a
 * documented follow-up"). The result was an install whose thesaurus looked empty
 * and whose hierarchy portals resolved nothing: `<tld>1` is not a section the
 * engine knows until its ONTOLOGY exists, and the hierarchy1 registry record was
 * never flagged ACTIVE — so the `field_value` active filter behind every portal's
 * target_sections matched zero hierarchies. Live symptom (2026-07-14): 69,889 Spain-hierarchy
 * terms in the database, zero `es` dd_ontology nodes, and Spain's General term
 * portal unable to resolve its target.
 *
 * PHP calls activate_hierarchy() for every selected tld right after its import
 * (installer_hierarchy_manager :1073-79). This pins the TS equivalent:
 *   - the registry record exists and is flagged ACTIVE (hierarchy4 → dd64/1) with a
 *     FULL locator (from_component_tipo present — a bare one is invisible to the @>
 *     containment the portals run);
 *   - hierarchy109 (source section) is set, or generateVirtualSection refuses;
 *   - the ONTOLOGY is provisioned: `<tld>0`/1 + `<tld>0`/2 node records and the
 *     `<tld>0`/`<tld>1`/`<tld>2` dd_ontology nodes;
 *   - hierarchy53/58 name the virtual sections, and the General Term roots point at
 *     the IMPORTED roots (`<tld>1`/1) rather than minting duplicates;
 *   - re-activation is idempotent (the wizard may be re-run).
 *
 * THE ENTRY DESCRIBES THE NEW ROW (2026-10-10, WC-2026-10-10-hierarchy-json-manifest).
 * The seed ships no optional registry row any more: activation CREATES it from the
 * hierarchy.json entry — hierarchy6, hierarchy5 (every name item), hierarchy9,
 * hierarchy8 = lg1/<lang.section_id> (int), hierarchy109, hierarchy61, misc.hierarchy60.
 * Pinned here, plus the refusals: an entry whose lg1 record does not exist writes
 * NOTHING (no row, no fallback language), and through installHierarchies (a scratch
 * manifest dir) an EMPTY thesaurus (no data files) is activated with no import, a
 * checksum mismatch refuses the tld before any write, an unlisted tld is refused.
 * A chosen thesaurus's OWN declarations (2026-10-10 owner decision): a declared
 * thesaurus is never forced in and never blocks (a mandatory one left out is a
 * warning); a declared mandatory ONTOLOGY the install lacks refuses the batch.
 *
 * Scratch: tlds 'zz' / 'zzhb' / 'zzhe' / 'zzhm' — not real Dédalo tlds, so the sweep
 * can be tld-scoped. The .copy.gz IMPORT itself is pinned by
 * hierarchy_import_atomic_native; here a mismatched file must never reach psql.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { encodeForJsonb } from '../../src/core/db/json_codec.ts';
import { MATRIX_COPY_COLUMNS } from '../../src/core/db/matrix_write.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { activateHierarchy } from '../../src/core/install/hierarchy_activate.ts';
import {
	importHierarchyRows,
	installHierarchies,
} from '../../src/core/install/hierarchy_import.ts';
import { hierarchyMetaByTld } from '../../src/core/install/hierarchy_meta.ts';
import { connFromConfig, runPsql } from '../../src/core/install/pg_exec.ts';
import { clearOntologyDerivedCaches } from '../../src/core/ontology/cache_invalidation.ts';
import {
	type HierarchyDataFile,
	type HierarchyManifestEntry,
	serializeHierarchyManifest,
	sha256Hex,
} from '../../src/core/ontology/hierarchy_manifest_format.ts';
import { deleteOntologyByTld } from '../../src/core/ontology/ontology_delete.ts';
import { resolveRegistryLangId } from '../../src/core/ontology/ontology_write.ts';
import { getMatrixTableFromTipo } from '../../src/core/ontology/resolver.ts';
import { deleteSectionRecord } from '../../src/core/section/record/delete_record.ts';
import { scratchHierarchyEntry } from '../../src/core/test_data/hierarchy_entry_fixture.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';

const TLD = 'zz';
/** An entry whose language is not a record of this installation. */
const BAD_LANG_TLD = 'zzhb';
/** An EMPTY thesaurus by design (no data files), installed through installHierarchies. */
const EMPTY_TLD = 'zzhe';
/** An entry whose data file does not hash to its listed sha256. */
const MISMATCH_TLD = 'zzhm';
/** A NON-default real section (test3, model `section`), not active in the thesaurus, multilingual. */
const REAL_TLD = 'zzhrl';
/** Data-bearing entries the PREFLIGHT must refuse before a term is copied. */
const PRE_LANG_TLD = 'zzhl';
const PRE_TYPOLOGY_TLD = 'zzhty';
const PRE_SOURCE_TLD = 'zzhs';
/** Terms already imported, no registry row (an interrupted run): the next run converges. */
const CONVERGE_TLD = 'zzhc';
/**
 * DECLARING thesauri: zzda needs zzdab (mandatory); zzdc needs a thesaurus with
 * no entry; zzdo needs an ONTOLOGY this installation does not have (mandatory).
 */
const DECLARER_TLD = 'zzda';
const DECLARED_TLD = 'zzdab';
const UNSATISFIABLE_TLD = 'zzdc';
const ONTOLOGY_DECLARER_TLD = 'zzdo';
const SCRATCH_TLDS = [
	DECLARER_TLD,
	DECLARED_TLD,
	UNSATISFIABLE_TLD,
	ONTOLOGY_DECLARER_TLD,
	TLD,
	BAD_LANG_TLD,
	EMPTY_TLD,
	MISMATCH_TLD,
	REAL_TLD,
	PRE_LANG_TLD,
	PRE_TYPOLOGY_TLD,
	PRE_SOURCE_TLD,
	CONVERGE_TLD,
];
/** A hierarchy13 id no installation has (the reader admits it: the manifest lists it). */
const MISSING_TYPOLOGY = 999;
/** The real section REAL_TLD names: a `section` of the suite ontology that is not hierarchy20. */
const REAL_SECTION = 'test3';
const HIERARCHY_SECTION = 'hierarchy1';
const HIERARCHY_TABLE = 'matrix_hierarchy_main';
const USER_ID = -1;

/** The lg1 id of lg-eng in THIS installation (resolved, never typed). */
let langSectionId = 0;
let META: HierarchyManifestEntry;
let sectionId: number | null = null;
let manifestDir = '';
/** A second manifest of a later release: EMPTY_TLD now ships data. */
let laterReleaseDir = '';
/** An lg1 id with no record in this installation. */
let missingLangId = 0;
/** The COPY text of two terms, by section tipo (built through psql in beforeAll). */
const copyTexts = new Map<string, string>();

interface RegistryRow {
	relation: Record<string, unknown[]>;
	string: Record<string, unknown[]>;
	misc: Record<string, unknown[]> | null;
}

async function registryRowById(id: number | null): Promise<RegistryRow | null> {
	if (id === null) return null;
	const rows = (await sql.unsafe(
		`SELECT relation, string, misc FROM "${HIERARCHY_TABLE}" WHERE section_tipo = $1 AND section_id = $2`,
		[HIERARCHY_SECTION, id],
	)) as RegistryRow[];
	return rows[0] ?? null;
}

async function registryRow(): Promise<RegistryRow | null> {
	return registryRowById(sectionId);
}

/** The registry row ids claiming `tld`. */
async function registryIdsOf(tld: string): Promise<number[]> {
	const rows = (await sql.unsafe(
		`SELECT section_id FROM "${HIERARCHY_TABLE}" WHERE section_tipo = $1
		   AND lower(string->'hierarchy6'->0->>'value') = $2 ORDER BY section_id`,
		[HIERARCHY_SECTION, tld],
	)) as { section_id: number }[];
	return rows.map((row) => Number(row.section_id));
}

async function nodeRecordIds(): Promise<number[]> {
	const rows = (await sql.unsafe(
		'SELECT section_id FROM matrix_ontology WHERE section_tipo = $1 ORDER BY section_id',
		[`${TLD}0`],
	)) as { section_id: number }[];
	return rows.map((row) => Number(row.section_id));
}

async function ddOntologyTipos(): Promise<string[]> {
	const rows = (await sql.unsafe('SELECT tipo FROM dd_ontology WHERE tld = $1 ORDER BY tipo', [
		TLD,
	])) as { tipo: string }[];
	return rows.map((row) => row.tipo);
}

/** The rows `sectionTipo` holds in whatever table it resolves to (0 when it resolves none). */
async function sectionRowCount(sectionTipo: string): Promise<number> {
	const rows = (await sql.unsafe(
		'SELECT count(*)::int AS n FROM matrix_hierarchy WHERE section_tipo = $1',
		[sectionTipo],
	)) as { n: number }[];
	return Number(rows[0]?.n ?? 0);
}

async function sweepTld(tld: string): Promise<void> {
	const ids = await registryIdsOf(tld);
	// A thesaurus provisioned on a non-hierarchy real section keeps its records in THAT
	// section's table (REAL_TLD → test3 → matrix_test): resolved before the ontology goes.
	for (const sectionTipo of [`${tld}1`, `${tld}2`]) {
		const table = await getMatrixTableFromTipo(sectionTipo);
		if (table !== null && table !== 'matrix_hierarchy') {
			await sql.unsafe(`DELETE FROM "${table}" WHERE section_tipo = $1`, [sectionTipo]);
		}
	}
	await deleteOntologyByTld(tld, (st, sid) => deleteSectionRecord(st, sid, USER_ID));
	await sql.unsafe('DELETE FROM dd_ontology WHERE tld = $1', [tld]);
	await sql.unsafe(
		`DELETE FROM "${HIERARCHY_TABLE}" WHERE section_tipo = $1
		   AND lower(string->'hierarchy6'->0->>'value') = $2`,
		[HIERARCHY_SECTION, tld],
	);
	// The provisioned thesaurus sections + every audit row the activation wrote.
	await sql.unsafe('DELETE FROM matrix_hierarchy WHERE section_tipo IN ($1, $2)', [
		`${tld}1`,
		`${tld}2`,
	]);
	await sql.unsafe(
		`DELETE FROM matrix_time_machine WHERE section_tipo IN ($1, $2, $3)
		   OR (section_tipo = $4 AND section_id = ANY(string_to_array($5, ',')::int[]))`,
		[`${tld}0`, `${tld}1`, `${tld}2`, HIERARCHY_SECTION, ids.join(',')],
	);
	await sql.unsafe('DELETE FROM matrix_counter WHERE tipo IN ($1, $2, $3)', [
		`${tld}0`,
		`${tld}1`,
		`${tld}2`,
	]);
}

/**
 * Two terms of `sectionTipo` as COPY text (MATRIX_COPY_COLUMNS order), rendered by
 * psql itself from rows inserted and removed here — the shape a vendored dump has.
 */
async function twoTermsCopyText(sectionTipo: string): Promise<string> {
	const conn = connFromConfig();
	for (const id of [1, 2]) {
		await sql.unsafe(
			'INSERT INTO matrix_hierarchy (section_id, section_tipo, data) VALUES ($1, $2, $3::text::jsonb)',
			[id, sectionTipo, encodeForJsonb({ marker: 'release' })],
		);
	}
	const res = await runPsql(conn, [
		'-v',
		'ON_ERROR_STOP=1',
		'-c',
		`\\copy (SELECT ${MATRIX_COPY_COLUMNS.join(', ')} FROM matrix_hierarchy WHERE section_tipo = '${sectionTipo}' ORDER BY section_id) TO STDOUT`,
	]);
	await sql.unsafe('DELETE FROM matrix_hierarchy WHERE section_tipo = $1', [sectionTipo]);
	expect(res.exitCode, res.stderr).toBe(0);
	return `${res.stdout}\n`;
}

/** Write `<sectionTipo>.copy.gz` (two terms) into `dir`; its manifest data_files item. */
function writeDataFile(dir: string, sectionTipo: string): HierarchyDataFile {
	const bytes = gzipSync(Buffer.from(copyTexts.get(sectionTipo) as string));
	writeFileSync(join(dir, `${sectionTipo}.copy.gz`), bytes);
	return { file: `${sectionTipo}.copy.gz`, sha256: sha256Hex(bytes) };
}

/** A manifest file of `entries` (typology 2 + the missing one listed) in `dir`. */
function writeManifest(dir: string, entries: HierarchyManifestEntry[]): void {
	const manifest = {
		version: 'scratch',
		date: '2026-10-10T00:00:00+02:00',
		entity_id: null,
		entity: null,
		entity_label: null,
		host: null,
		typologies: [
			{ typology_id: 2, name: 'Toponymy', name_data: [] },
			{ typology_id: MISSING_TYPOLOGY, name: 'Elsewhere', name_data: [] },
		],
		active_hierarchies: entries,
	};
	writeFileSync(join(dir, 'hierarchy.json'), serializeHierarchyManifest(manifest));
}

async function sweep(): Promise<void> {
	for (const tld of SCRATCH_TLDS) await sweepTld(tld);
	await clearOntologyDerivedCaches();
}

/**
 * The scratch manifest dir: the EMPTY entry (no real section named — the
 * provisioning default applies), the MISMATCH entry with its (altered) file, the
 * three PREFLIGHT entries (each with a VALID data file, so only the preflight
 * can keep its terms out) and the CONVERGE entry.
 */
function writeScratchManifest(): string {
	const dir = mkdtempSync(join(tmpdir(), 'dedalo-hierarchy-activate-'));
	const bytes = gzipSync(Buffer.from('not imported: the digest refuses it first\n'));
	writeFileSync(join(dir, `${MISMATCH_TLD}1.copy.gz`), bytes);
	const wrongDigest = sha256Hex(Buffer.from('some other bytes'));
	const withData = (tld: string) => [writeDataFile(dir, `${tld}1`)];
	writeManifest(dir, [
		scratchHierarchyEntry({
			tld: EMPTY_TLD,
			name: 'ZZ Empty Land',
			langSectionId,
			realSectionTipo: null,
		}),
		scratchHierarchyEntry({
			tld: MISMATCH_TLD,
			name: 'ZZ Tampered Land',
			langSectionId,
			dataFiles: [{ file: `${MISMATCH_TLD}1.copy.gz`, sha256: wrongDigest }],
		}),
		scratchHierarchyEntry({
			tld: PRE_LANG_TLD,
			name: 'ZZ Foreign Language',
			langSectionId: missingLangId,
			dataFiles: withData(PRE_LANG_TLD),
		}),
		{
			...scratchHierarchyEntry({
				tld: PRE_TYPOLOGY_TLD,
				name: 'ZZ Foreign Typology',
				langSectionId,
				dataFiles: withData(PRE_TYPOLOGY_TLD),
			}),
			typology_id: MISSING_TYPOLOGY,
		},
		scratchHierarchyEntry({
			tld: PRE_SOURCE_TLD,
			name: 'ZZ Misspelt Source',
			langSectionId,
			// The 2026-10-09 master typo: tipo-shaped, names no section.
			realSectionTipo: 'hiearachy20',
			dataFiles: withData(PRE_SOURCE_TLD),
		}),
		scratchHierarchyEntry({
			tld: CONVERGE_TLD,
			name: 'ZZ Interrupted',
			langSectionId,
			dataFiles: withData(CONVERGE_TLD),
		}),
		scratchHierarchyEntry({
			tld: DECLARER_TLD,
			name: 'ZZ Declarer',
			langSectionId,
			dependencies: [{ tld: DECLARED_TLD, main: 'hierarchy1', mandatory: true }],
		}),
		scratchHierarchyEntry({ tld: DECLARED_TLD, name: 'ZZ Declared', langSectionId }),
		scratchHierarchyEntry({
			tld: UNSATISFIABLE_TLD,
			name: 'ZZ Unsatisfiable',
			langSectionId,
			dependencies: [{ tld: 'zzdnone', main: 'hierarchy1', mandatory: true }],
		}),
		scratchHierarchyEntry({
			tld: ONTOLOGY_DECLARER_TLD,
			name: 'ZZ Ontology Declarer',
			langSectionId,
			dependencies: [{ tld: 'zzdonto', main: 'ontology35', mandatory: true }],
		}),
	]);
	return dir;
}

/** A LATER release's manifest: the thesaurus installed empty now ships its terms. */
function writeLaterReleaseManifest(): string {
	const dir = mkdtempSync(join(tmpdir(), 'dedalo-hierarchy-activate-later-'));
	writeManifest(dir, [
		scratchHierarchyEntry({
			tld: EMPTY_TLD,
			name: 'ZZ Empty Land',
			langSectionId,
			realSectionTipo: null,
			dataFiles: [writeDataFile(dir, `${EMPTY_TLD}1`)],
		}),
	]);
	return dir;
}

beforeAll(async () => {
	await assertTestDatabase('install_hierarchy_activate_native');
	langSectionId = await resolveRegistryLangId('lg-eng');
	META = scratchHierarchyEntry({
		tld: TLD,
		name: 'ZZ Scratch Land',
		langSectionId,
		scopeNote: 'A scratch thesaurus of the activation gate',
		dependencies: [{ tld: 'test', main: 'ontology35', mandatory: false }],
	});
	const missing = (await sql.unsafe(
		"SELECT coalesce(max(section_id), 0) + 1000 AS id FROM matrix_langs WHERE section_tipo = 'lg1'",
		[],
	)) as { id: number }[];
	missingLangId = Number(missing[0]?.id);
	await sweep();
	for (const tld of [PRE_LANG_TLD, PRE_TYPOLOGY_TLD, PRE_SOURCE_TLD, CONVERGE_TLD, EMPTY_TLD]) {
		copyTexts.set(`${tld}1`, await twoTermsCopyText(`${tld}1`));
	}
	manifestDir = writeScratchManifest();
	laterReleaseDir = writeLaterReleaseManifest();
});

afterAll(async () => {
	await sweep();
	for (const dir of [manifestDir, laterReleaseDir]) {
		if (dir !== '') rmSync(dir, { recursive: true, force: true });
	}
});

describe('install: activate an imported hierarchy', () => {
	test('registers, flags ACTIVE and provisions the ontology', async () => {
		const outcome = await activateHierarchy(META, USER_ID);
		sectionId = outcome.sectionId;

		expect(outcome.ok).toBe(true);
		expect(outcome.sectionId).not.toBeNull();

		const row = await registryRow();
		expect(row).not.toBeNull();

		// ACTIVE, with a FULL locator — a bare one is invisible to the portals' @> filter.
		expect(row?.relation.hierarchy4?.[0]).toMatchObject({
			type: 'dd151',
			section_tipo: 'dd64',
			section_id: 1, // YES — int-canonical (WC-2026-08-10-section-id-int-canonical)
			from_component_tipo: 'hierarchy4',
		});
		expect(row?.relation.hierarchy125?.[0]).toMatchObject({
			// int-canonical (WC-2026-08-10-section-id-int-canonical)
			section_id: 1,
			from_component_tipo: 'hierarchy125',
		});
		// The template generateVirtualSection clones — without it, provisioning refuses.
		expect(row?.string.hierarchy109?.[0]).toMatchObject({ value: 'hierarchy20' });

		// THE ENTRY DESCRIBED THE ROW: tld, every name item, typology, the language
		// as an INT lg1 address, the scope note and the declared dependencies.
		expect(outcome.created).toBe(true);
		expect(row?.string.hierarchy6).toEqual([{ id: 1, lang: 'lg-nolan', value: TLD }]);
		expect(row?.string.hierarchy5).toEqual([{ id: 1, lang: 'lg-eng', value: 'ZZ Scratch Land' }]);
		expect(row?.relation.hierarchy9).toEqual([
			{
				id: 1,
				type: 'dd151',
				section_id: 2,
				section_tipo: 'hierarchy13',
				from_component_tipo: 'hierarchy9',
			},
		]);
		expect(langSectionId).toBeGreaterThan(0);
		expect(row?.relation.hierarchy8).toEqual([
			{
				id: 1,
				type: 'dd151',
				section_id: langSectionId,
				section_tipo: 'lg1',
				from_component_tipo: 'hierarchy8',
			},
		]);
		expect(row?.string.hierarchy61).toEqual([
			{ id: 1, lang: 'lg-eng', value: 'A scratch thesaurus of the activation gate' },
		]);
		expect(row?.misc?.hierarchy60).toEqual([
			{ id: 1, value: [{ tld: 'test', main: 'ontology35', mandatory: false }] },
		]);

		// THE missing step: the ontology now exists.
		expect(await nodeRecordIds()).toEqual([1, 2]);
		expect(await ddOntologyTipos()).toEqual(['zz0', 'zz1', 'zz2']);

		// The virtual sections are named on the registry record...
		expect(row?.string.hierarchy53?.[0]).toMatchObject({ value: 'zz1' });
		expect(row?.string.hierarchy58?.[0]).toMatchObject({ value: 'zz2' });
		// ...and the General Term root points at a record that EXISTS.
		// NOT at a hard-coded `zz1/1`: this assertion USED to pin section_id '1', which was
		// the bug — PHP hard-codes `<tld>1`/1 and `<tld>2`/2, and those ids exist in almost
		// no install (`es2` has no records at all). The id is now whatever the counter
		// allocated; what MATTERS is that the target is real.
		const rootLocator = row?.relation.hierarchy45?.[0] as Record<string, unknown>;
		expect(rootLocator).toMatchObject({
			type: 'dd48',
			section_tipo: 'zz1',
			from_component_tipo: 'hierarchy45',
		});
		const rootId = Number(rootLocator.section_id);
		const rootRows = (await sql.unsafe(
			'SELECT section_id FROM matrix_hierarchy WHERE section_tipo = $1 AND section_id = $2',
			['zz1', rootId],
		)) as unknown[];
		expect(rootRows).toHaveLength(1); // the root the locator names is really there
	});

	test('the activated hierarchy is visible to the portals’ active filter', async () => {
		// The exact containment relations/request_config/explicit.ts runs to resolve a
		// portal's target_sections from the ACTIVE hierarchies.
		const rows = (await sql.unsafe(
			`SELECT count(*)::int AS n FROM "${HIERARCHY_TABLE}" t
			 WHERE t.section_tipo = $1 AND t.section_id = $2
			   AND t.relation @> '{"hierarchy4":[{"section_tipo":"dd64","section_id":1,"from_component_tipo":"hierarchy4"}]}'::jsonb`,
			[HIERARCHY_SECTION, sectionId],
		)) as { n: number }[];
		expect(Number(rows[0]?.n)).toBe(1);
	});

	test('re-activating is idempotent (the wizard may be re-run)', async () => {
		const outcome = await activateHierarchy(META, USER_ID);

		expect(outcome.ok).toBe(true);
		expect(outcome.sectionId).toBe(sectionId); // the SAME record, not a second one
		expect(await nodeRecordIds()).toEqual([1, 2]); // no duplicate node records
	});

	test('an entry whose language is not a record of this installation writes NOTHING', async () => {
		// An lg1 id no installation reaches (the reader admits any positive int).
		const bad = scratchHierarchyEntry({
			tld: BAD_LANG_TLD,
			name: 'ZZ Nowhere',
			langSectionId: missingLangId,
		});
		const outcome = await activateHierarchy(bad, USER_ID);
		expect(outcome.ok).toBe(false);
		expect(outcome.created).toBe(false);
		expect(outcome.errors).toHaveLength(1);
		expect(outcome.errors[0]).toContain(`lg1/${bad.lang.section_id}`);
		expect(outcome.errors[0]).toContain('activation refused');
		expect(await registryIdsOf(BAD_LANG_TLD)).toEqual([]); // no row, no fallback language
	});

	test('EVERY entry value reaches the new row: a non-default real section, active_in_thesaurus false, every name and scope-note item', async () => {
		// Values that differ from every default the activation or ensureHierarchy would
		// write on their own — so each assertion can only pass because the ENTRY's value
		// was written (hierarchy109 test3 ≠ the hierarchy20 default; hierarchy125 No ≠ the
		// Yes default; a Spanish item ≠ the lg-eng pick).
		const nameData = [
			{ id: 1, lang: 'lg-eng', value: 'ZZ Real Land' },
			{ id: 1, lang: 'lg-spa', value: 'Tierra ZZ' },
		];
		const scopeNoteData = [
			{ id: 1, lang: 'lg-eng', value: 'Scope' },
			{ id: 1, lang: 'lg-spa', value: 'Alcance' },
		];
		const entry = scratchHierarchyEntry({
			tld: REAL_TLD,
			name: 'ZZ Real Land',
			langSectionId,
			realSectionTipo: REAL_SECTION,
			activeInThesaurus: false,
			nameData,
			scopeNoteData,
		});
		const outcome = await activateHierarchy(entry, USER_ID);
		expect(outcome.errors).toEqual([]);
		expect(outcome.ok).toBe(true);
		expect(outcome.created).toBe(true);
		const row = await registryRowById(outcome.sectionId);
		expect(row?.string.hierarchy109).toEqual([{ id: 1, lang: 'lg-nolan', value: REAL_SECTION }]);
		expect(row?.string.hierarchy5).toEqual(nameData);
		expect(row?.string.hierarchy61).toEqual(scopeNoteData);
		// ACTIVE as a hierarchy, NOT active in the thesaurus (dd64/2 = No).
		expect(row?.relation.hierarchy4?.[0]).toMatchObject({ section_tipo: 'dd64', section_id: 1 });
		expect(row?.relation.hierarchy125?.[0]).toMatchObject({
			section_tipo: 'dd64',
			section_id: 2,
			from_component_tipo: 'hierarchy125',
		});
		// No dependencies declared → none written (absent ≠ []).
		expect(row?.misc?.hierarchy60).toBeUndefined();
	});
});

describe('install: installHierarchies over a manifest entry', () => {
	test('an EMPTY thesaurus (no data files) is activated with no import: hierarchy8 from lang.section_id, hierarchy109', async () => {
		const result = await installHierarchies([EMPTY_TLD], undefined, USER_ID, {
			importDir: manifestDir,
		});
		expect(result.errors).toEqual([]);
		expect(result.ok).toBe(true);
		expect(result.responses).toEqual([
			{
				tld: EMPTY_TLD,
				ok: true,
				msg: 'empty thesaurus (no data files — nothing imported) and activated',
			},
		]);
		const [id] = await registryIdsOf(EMPTY_TLD);
		expect(id).toBeGreaterThan(0);
		const row = await registryRowById(id ?? null);
		expect(row?.relation.hierarchy8?.[0]).toMatchObject({
			section_tipo: 'lg1',
			section_id: langSectionId,
		});
		expect(row?.string.hierarchy109?.[0]).toMatchObject({ value: 'hierarchy20' });
		expect(row?.relation.hierarchy4?.[0]).toMatchObject({ section_tipo: 'dd64', section_id: 1 });
		// Provisioned, and its only terms are the General Term root the activation made.
		expect(row?.string.hierarchy53?.[0]).toMatchObject({ value: `${EMPTY_TLD}1` });
		const terms = (await sql.unsafe(
			'SELECT count(*)::int AS n FROM matrix_hierarchy WHERE section_tipo = $1',
			[`${EMPTY_TLD}1`],
		)) as { n: number }[];
		expect(Number(terms[0]?.n)).toBe(1);

		// A RESET of an empty thesaurus has nothing to reset from: refused.
		const reset = await installHierarchies([EMPTY_TLD], undefined, USER_ID, {
			replace: true,
			importDir: manifestDir,
		});
		expect(reset.ok).toBe(false);
		expect(reset.errors).toEqual([
			`${EMPTY_TLD}: empty thesaurus by design (hierarchy.json lists no data files) — nothing to reset from`,
		]);
	});

	test('a LATER release that ships data for a thesaurus installed empty is refused naming Reset — never "already installed"', async () => {
		// The activation above minted the General Term root in `<tld>1`: one row.
		expect(await sectionRowCount(`${EMPTY_TLD}1`)).toBe(1);
		const result = await installHierarchies([EMPTY_TLD], undefined, USER_ID, {
			importDir: laterReleaseDir,
		});
		expect(result.ok).toBe(false);
		expect(result.responses[0]?.skipped).toBeUndefined();
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toStartWith(
			`${EMPTY_TLD}: data available, not imported: ${EMPTY_TLD}1`,
		);
		expect(result.errors[0]).toContain('Reset to seed');
		expect(await sectionRowCount(`${EMPTY_TLD}1`)).toBe(1); // nothing copied
	});

	test('a CHECKSUM MISMATCH refuses the tld before any write — no rows, no registry row', async () => {
		const result = await installHierarchies([MISMATCH_TLD], undefined, USER_ID, {
			importDir: manifestDir,
		});
		expect(result.ok).toBe(false);
		expect(result.errors).toEqual([
			`${MISMATCH_TLD}: checksum mismatch for ${MISMATCH_TLD}1.copy.gz: its sha256 is not the one hierarchy.json lists — nothing imported`,
		]);
		expect(await registryIdsOf(MISMATCH_TLD)).toEqual([]);
		const rows = (await sql.unsafe(
			'SELECT count(*)::int AS n FROM matrix_hierarchy WHERE section_tipo ~ $1',
			[`^${MISMATCH_TLD}[0-9]+$`],
		)) as { n: number }[];
		expect(Number(rows[0]?.n)).toBe(0);
	});

	test('a tld the manifest does not list is refused, nothing written', async () => {
		const result = await installHierarchies([BAD_LANG_TLD], undefined, USER_ID, {
			importDir: manifestDir,
		});
		expect(result.ok).toBe(false);
		expect(result.errors).toEqual([
			`${BAD_LANG_TLD}: not listed in hierarchy.json — nothing imported, not activated`,
		]);
		expect(await registryIdsOf(BAD_LANG_TLD)).toEqual([]);
	});
});

describe('install: what the entry references is checked BEFORE a term is copied', () => {
	const cases: [string, string][] = [
		[PRE_LANG_TLD, `its language lg1/`],
		[PRE_TYPOLOGY_TLD, `its typology hierarchy13/${MISSING_TYPOLOGY}`],
		[PRE_SOURCE_TLD, `the source section 'hiearachy20' (hierarchy109) is not a section`],
	];
	for (const [tld, reason] of cases) {
		test(`${tld}: refused with nothing written — no term, no registry row — and a re-run refuses again (never "already installed")`, async () => {
			for (const run of [1, 2]) {
				const result = await installHierarchies([tld], undefined, USER_ID, {
					importDir: manifestDir,
				});
				expect(result.ok, `run ${run}`).toBe(false);
				expect(result.responses[0]?.skipped, `run ${run}`).toBeUndefined();
				expect(result.errors, `run ${run}`).toHaveLength(1);
				expect(result.errors[0], `run ${run}`).toContain(reason);
				expect(result.errors[0], `run ${run}`).toEndWith('activation refused; nothing imported');
				expect(await sectionRowCount(`${tld}1`), `run ${run}`).toBe(0);
				expect(await registryIdsOf(tld), `run ${run}`).toEqual([]);
			}
		});
	}

	test('terms imported by an INTERRUPTED run (no registry row) are activated by the next run, not skipped as installed', async () => {
		// The interrupted run: the import landed, the activation never ran.
		const listed = hierarchyMetaByTld(CONVERGE_TLD, manifestDir)?.data_files ?? [];
		expect(listed).toHaveLength(1);
		const imported = await importHierarchyRows(connFromConfig(), CONVERGE_TLD, {
			importDir: manifestDir,
			dataFiles: listed,
		});
		expect(imported).toEqual({ ok: true, msg: 'copied' });
		expect(await registryIdsOf(CONVERGE_TLD)).toEqual([]);
		for (const run of [1, 2]) {
			const result = await installHierarchies([CONVERGE_TLD], undefined, USER_ID, {
				importDir: manifestDir,
			});
			expect(result.errors, `run ${run}`).toEqual([]);
			expect(result.responses, `run ${run}`).toEqual([
				{
					tld: CONVERGE_TLD,
					ok: true,
					msg: 'already installed — import skipped and activated',
					skipped: true,
				},
			]);
			const ids = await registryIdsOf(CONVERGE_TLD);
			expect(ids, `run ${run}`).toHaveLength(1); // created once, then converged
			const row = await registryRowById(ids[0] ?? null);
			expect(row?.relation.hierarchy4?.[0], `run ${run}`).toMatchObject({
				section_tipo: 'dd64',
				section_id: 1,
			});
			expect(await sectionRowCount(`${CONVERGE_TLD}1`), `run ${run}`).toBe(2); // never re-copied
		}
	});
});

describe("install: a chosen thesaurus's OWN declared dependencies (hierarchy.json hierarchy60)", () => {
	// OWNER DECISION 2026-10-10: a THESAURUS dependency never blocks and is never
	// forced — the batch is the selection (the front ends pre-tick declared
	// thesauri); a MANDATORY one left out is a warning (strongly recommended,
	// installable later). A declared mandatory ONTOLOGY keeps the ontology law.
	test('choosing the declarer alone installs ONLY it — its mandatory thesaurus is warned, never forced in', async () => {
		const result = await installHierarchies([DECLARER_TLD], undefined, USER_ID, {
			importDir: manifestDir,
		});
		expect(result.errors).toEqual([]);
		expect(result.ok).toBe(true);
		expect(result.responses.map((item) => [item.tld, item.ok])).toEqual([[DECLARER_TLD, true]]);
		expect(result.msg).toContain(
			`the thesaurus '${DECLARED_TLD}' (declared mandatory by '${DECLARER_TLD}') is declined — not installed; it is strongly recommended and can be installed later from Maintenance › Install hierarchies`,
		);
		expect(await registryIdsOf(DECLARED_TLD)).toEqual([]);
		// The declaration itself travelled onto the declarer's new registry row.
		const [id] = await registryIdsOf(DECLARER_TLD);
		const row = await registryRowById(id ?? null);
		expect(row?.misc?.hierarchy60).toEqual([
			{ id: 1, value: [{ tld: DECLARED_TLD, main: 'hierarchy1', mandatory: true }] },
		]);
	});

	test('the declared thesaurus ticked too (what the front ends pre-tick): both installed, no warning', async () => {
		const result = await installHierarchies([DECLARER_TLD, DECLARED_TLD], undefined, USER_ID, {
			importDir: manifestDir,
		});
		expect(result.errors).toEqual([]);
		expect(result.responses.map((item) => [item.tld, item.ok])).toEqual([
			[DECLARER_TLD, true],
			[DECLARED_TLD, true],
		]);
		expect(result.msg).not.toContain('strongly recommended');
		expect(await registryIdsOf(DECLARED_TLD)).toHaveLength(1);
	});

	test('a mandatory thesaurus with NO ENTRY never refuses the batch — a warning, the rest installs', async () => {
		const result = await installHierarchies([UNSATISFIABLE_TLD], undefined, USER_ID, {
			importDir: manifestDir,
		});
		expect(result.ok).toBe(true);
		expect(result.errors).toEqual([]);
		expect(result.responses.map((item) => [item.tld, item.ok])).toEqual([
			[UNSATISFIABLE_TLD, true],
		]);
		expect(result.msg).toContain(
			`the thesaurus 'zzdnone' (declared mandatory by '${UNSATISFIABLE_TLD}') has no entry in hierarchy.json — skipped; it is strongly recommended`,
		);
		expect(await registryIdsOf(UNSATISFIABLE_TLD)).toHaveLength(1);
	});

	test('a declared MANDATORY ONTOLOGY this installation lacks still refuses the WHOLE batch (the ontology law)', async () => {
		const result = await installHierarchies([ONTOLOGY_DECLARER_TLD], undefined, USER_ID, {
			importDir: manifestDir,
		});
		expect(result.ok).toBe(false);
		expect(result.responses).toEqual([]);
		expect(result.errors).toEqual([
			`the ontology 'zzdonto', a mandatory dependency of the thesaurus '${ONTOLOGY_DECLARER_TLD}', is not part of this install — add it to the ontologies`,
		]);
		expect(result.msg).toBe(
			'Nothing installed: a selected thesaurus declares an ontology this installation does not have',
		);
		expect(await registryIdsOf(ONTOLOGY_DECLARER_TLD)).toEqual([]);
	});
});
