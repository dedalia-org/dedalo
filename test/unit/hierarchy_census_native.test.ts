/**
 * THE THESAURUS CENSUS — TS-native gate of hierarchy_census.ts
 * buildHierarchyManifest, the DB half of hierarchy.json
 * (WC-2026-10-10-hierarchy-json-manifest).
 *
 * The census is what a master exports and every installer then trusts, so
 * each field is asserted as an OUTCOME of a registry row this gate BUILDS on
 * the suite database (zz* scratch TLDs, inserted through the counter
 * allocator, swept before and after):
 *   - a fully declared active row → every entry field: tld lowercased, name /
 *     name_data, typology (seed-style STRING section_id coerced to int),
 *     lang {section_id INT, label = the lg1 record's hierarchy25 term},
 *     real_section_tipo, active_in_thesaurus, scope_note_data, dependencies
 *     through the shared normalizer, data_files with the real sha256;
 *   - a bare active row → dependencies ABSENT (not declared ≠ []),
 *     real_section_tipo null, scope_note_data [], data_files [] (empty
 *     thesaurus), and an lg1 id that does not exist → label null + an error;
 *   - an INACTIVE row is not exported; a row without an int lang id and a
 *     second row claiming a seen tld are SKIPPED into `errors`, never exported
 *     with an invented value;
 *   - the CORE `lg` entry never lists a data file, even when an `lg1.copy.gz`
 *     sits in the export directory;
 *   - a row whose STORED values break a format rule (hierarchy109
 *     'Hierarchy20', a name item with lang 'lg-ES') or whose real section names
 *     no `section` here is ITS OWN error line: the export of every other row
 *     still succeeds (2026-10-10 review — one bad row used to fail the export).
 * The census's own output is validated by the format reader inside
 * buildHierarchyManifest, so a green run also proves the export is readable.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	deleteMatrixRecord,
	insertMatrixRecordWithCounter,
} from '../../src/core/db/matrix_write.ts';
import { sql } from '../../src/core/db/postgres.ts';
import {
	buildHierarchyManifest,
	type HierarchyCensus,
} from '../../src/core/ontology/hierarchy_census.ts';
import { sha256Hex } from '../../src/core/ontology/hierarchy_manifest_format.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';

const TABLE = 'matrix_hierarchy_main';
const REGISTRY = 'hierarchy1';
const FULL = 'zzcensus';
const BARE = 'zzcensusb';
const INACTIVE = 'zzcensusc';
const BAD_LANG = 'zzcensusd';
/** hierarchy109 stored with a capital — breaks the format's tipo rule. */
const BAD_SOURCE_CASE = 'zzcensuse';
/** A hierarchy5 item whose lang is not a data lang — breaks the format's lang rule. */
const BAD_NAME_ITEM = 'zzcensusf';
/** hierarchy109 shaped like a tipo but naming no section (the 2026-10-09 master typo). */
const NOT_A_SECTION = 'zzcensusg';
/** lg-spa's lg1 record — shipped by the seed's matrix_langs (the hierarchy8 most seed rows carry). */
const SPANISH_LG1 = 17344;

const yes = (tipo: string) => [
	{ id: 1, type: 'dd151', section_id: 1, section_tipo: 'dd64', from_component_tipo: tipo },
];
const no = (tipo: string) => [
	{ id: 1, type: 'dd151', section_id: 2, section_tipo: 'dd64', from_component_tipo: tipo },
];
/** Seed-style locators: section_id stored as a STRING. */
const locator = (tipo: string, sectionTipo: string, sectionId: string) => [
	{
		id: 1,
		type: 'dd151',
		section_id: sectionId,
		section_tipo: sectionTipo,
		from_component_tipo: tipo,
	},
];
const text = (value: string, lang = 'lg-nolan') => [{ id: 1, lang, value }];

const insertedIds: number[] = [];
let dataDir = '';
let missingLangId = 0;
let census: HierarchyCensus;

async function insertRow(columns: {
	string: Record<string, unknown>;
	relation: Record<string, unknown>;
	misc?: Record<string, unknown>;
}): Promise<number> {
	const id = await insertMatrixRecordWithCounter(TABLE, REGISTRY, columns);
	insertedIds.push(id);
	return id;
}

async function sweep(): Promise<void> {
	await sql.unsafe(
		`DELETE FROM "${TABLE}" WHERE section_tipo = $1
		   AND lower(string->'hierarchy6'->0->>'value') LIKE 'zzcensus%'`,
		[REGISTRY],
	);
	for (const id of insertedIds.splice(0)) await deleteMatrixRecord(TABLE, REGISTRY, id);
}

function entry(tld: string) {
	return census.manifest.active_hierarchies.find((item) => item.tld === tld);
}

beforeAll(async () => {
	await assertTestDatabase('hierarchy_census_native');
	await sweep();
	const max = (await sql.unsafe(
		`SELECT COALESCE(MAX(section_id), 0)::int AS max FROM matrix_langs WHERE section_tipo = 'lg1'`,
	)) as { max: number }[];
	missingLangId = Number(max[0]?.max ?? 0) + 1000;

	// FULL — every field declared; tld stored uppercase like the seed rows.
	await insertRow({
		string: {
			hierarchy5: [
				{ id: 1, lang: 'lg-eng', value: 'Census land' },
				{ id: 1, lang: 'lg-spa', value: 'Tierra del censo' },
			],
			hierarchy6: text(FULL.toUpperCase()),
			hierarchy109: text('hierarchy20'),
			hierarchy61: text('A scope note', 'lg-eng'),
		},
		relation: {
			hierarchy4: yes('hierarchy4'),
			hierarchy125: yes('hierarchy125'),
			hierarchy8: locator('hierarchy8', 'lg1', String(SPANISH_LG1)),
			hierarchy9: locator('hierarchy9', 'hierarchy13', '2'),
		},
		misc: {
			hierarchy60: [
				{
					id: 1,
					value: [
						{ tld: 'TEST', main: 'hierarchy1', mandatory: true },
						{ tld: BARE, main: 'hierarchy1', mandatory: false },
					],
				},
			],
		},
	});
	// BARE — nothing optional declared; its lg1 record does not exist.
	await insertRow({
		string: { hierarchy5: text('Bare'), hierarchy6: text(BARE) },
		relation: {
			hierarchy4: yes('hierarchy4'),
			hierarchy125: no('hierarchy125'),
			hierarchy8: locator('hierarchy8', 'lg1', String(missingLangId)),
			hierarchy9: locator('hierarchy9', 'hierarchy13', '1'),
		},
	});
	// INACTIVE — must not be exported.
	await insertRow({
		string: { hierarchy6: text(INACTIVE) },
		relation: {
			hierarchy4: no('hierarchy4'),
			hierarchy8: locator('hierarchy8', 'lg1', String(SPANISH_LG1)),
			hierarchy9: locator('hierarchy9', 'hierarchy13', '1'),
		},
	});
	// BAD_LANG — lang section_id is not an int: skipped, never exported.
	await insertRow({
		string: { hierarchy6: text(BAD_LANG) },
		relation: {
			hierarchy4: yes('hierarchy4'),
			hierarchy8: locator('hierarchy8', 'lg1', 'abc'),
			hierarchy9: locator('hierarchy9', 'hierarchy13', '1'),
		},
	});
	// DUPLICATE of FULL (later section_id) — skipped, the first row wins.
	await insertRow({
		string: { hierarchy5: text('Impostor'), hierarchy6: text(FULL) },
		relation: {
			hierarchy4: yes('hierarchy4'),
			hierarchy8: locator('hierarchy8', 'lg1', String(SPANISH_LG1)),
			hierarchy9: locator('hierarchy9', 'hierarchy13', '1'),
		},
	});

	// Three rows whose STORED values break a format / provisioning rule: each must
	// be ITS OWN error line, while every other row is still exported.
	const valid = {
		hierarchy4: yes('hierarchy4'),
		hierarchy8: locator('hierarchy8', 'lg1', String(SPANISH_LG1)),
		hierarchy9: locator('hierarchy9', 'hierarchy13', '1'),
	};
	await insertRow({
		string: { hierarchy6: text(BAD_SOURCE_CASE), hierarchy109: text('Hierarchy20') },
		relation: valid,
	});
	await insertRow({
		string: {
			hierarchy6: text(BAD_NAME_ITEM),
			hierarchy5: [{ id: 1, lang: 'lg-ES', value: 'Malformed' }],
		},
		relation: valid,
	});
	await insertRow({
		string: { hierarchy6: text(NOT_A_SECTION), hierarchy109: text('hiearachy20') },
		relation: valid,
	});

	dataDir = mkdtempSync(join(tmpdir(), 'hierarchy-census-'));
	writeFileSync(join(dataDir, `${FULL}1.copy.gz`), 'terms');
	writeFileSync(join(dataDir, `${FULL}2.copy.gz`), 'models');
	// A CORE data file in the dir must still never be listed.
	writeFileSync(join(dataDir, 'lg1.copy.gz'), 'langs');

	census = await buildHierarchyManifest({ dataDir });
});

afterAll(async () => {
	await sweep();
	if (dataDir !== '') rmSync(dataDir, { recursive: true, force: true });
});

describe('hierarchy census — a fully declared active row', () => {
	test('exports every field from the registry row', async () => {
		const labels = (await sql.unsafe(
			`SELECT jsonb_path_query_array(string->'hierarchy25', '$[*].value') AS v
			   FROM matrix_langs WHERE section_tipo = 'lg1' AND section_id = $1`,
			[SPANISH_LG1],
		)) as { v: string[] }[];
		const full = entry(FULL);
		expect(full).toBeDefined();
		expect(full).toMatchObject({
			tld: FULL,
			name_data: [
				{ id: 1, lang: 'lg-eng', value: 'Census land' },
				{ id: 1, lang: 'lg-spa', value: 'Tierra del censo' },
			],
			typology_id: 2,
			real_section_tipo: 'hierarchy20',
			active_in_thesaurus: true,
			scope_note_data: [{ id: 1, lang: 'lg-eng', value: 'A scope note' }],
		});
		expect(['Census land', 'Tierra del censo']).toContain(full?.name as string);
		// The STRING section_id the seed stores is coerced to an int.
		expect(full?.lang.section_id).toBe(SPANISH_LG1);
		expect(labels[0]?.v ?? []).toContain(full?.lang.label as string);
		const typology = census.manifest.typologies.find((item) => item.typology_id === 2);
		expect(typology?.name).not.toBeNull();
		expect(full?.typology_name).toBe(typology?.name as string);
	});

	test('dependencies come through the shared normalizer (tld lowercased)', () => {
		expect(entry(FULL)?.dependencies).toEqual([
			{ tld: 'test', main: 'hierarchy1', mandatory: true },
			{ tld: BARE, main: 'hierarchy1', mandatory: false },
		]);
	});

	test('data_files list the dumps present now, with the sha256 of their bytes', () => {
		expect(entry(FULL)?.data_files).toEqual([
			{ file: `${FULL}1.copy.gz`, sha256: sha256Hex(new TextEncoder().encode('terms')) },
			{ file: `${FULL}2.copy.gz`, sha256: sha256Hex(new TextEncoder().encode('models')) },
		]);
	});
});

describe('hierarchy census — a bare active row', () => {
	test('not declared stays ABSENT; empty values are null / []', () => {
		const bare = entry(BARE);
		expect(bare).toBeDefined();
		expect('dependencies' in (bare as object)).toBe(false);
		expect(bare?.real_section_tipo).toBeNull();
		expect(bare?.scope_note_data).toEqual([]);
		expect(bare?.active_in_thesaurus).toBe(false);
		// No dump in the dir → an empty thesaurus by design, not an error.
		expect(bare?.data_files).toEqual([]);
	});

	test('an lg1 id with no record exports label null AND reports it', () => {
		expect(entry(BARE)?.lang).toEqual({ section_id: missingLangId, label: null });
		expect(census.errors.some((line) => line.includes(`lg1/${missingLangId} does not exist`))).toBe(
			true,
		);
	});
});

describe('hierarchy census — what is never exported', () => {
	test('an inactive row is not offered', () => {
		expect(entry(INACTIVE)).toBeUndefined();
	});

	test('a row without an int lang section_id is skipped into errors', () => {
		expect(entry(BAD_LANG)).toBeUndefined();
		expect(
			census.errors.some((line) => line.includes(`'${BAD_LANG}': no int lg1 section_id`)),
		).toBe(true);
	});

	test('a second row claiming a seen tld is skipped; the first row wins', () => {
		expect(census.manifest.active_hierarchies.filter((item) => item.tld === FULL)).toHaveLength(1);
		expect(entry(FULL)?.name).not.toBe('Impostor');
		expect(census.errors.some((line) => line.includes(`tld '${FULL}' is already exported`))).toBe(
			true,
		);
	});

	test('a row whose stored values break a format rule is ITS OWN error line — the export still succeeds', () => {
		// buildHierarchyManifest returned (beforeAll), so no single row aborted it.
		expect(entry(FULL)).toBeDefined();
		for (const [tld, rule] of [
			[BAD_SOURCE_CASE, 'entry.real_section_tipo: '],
			[BAD_NAME_ITEM, 'entry.name_data.0.lang: '],
		] as const) {
			expect(entry(tld)).toBeUndefined();
			const lines = census.errors.filter((line) => line.includes(`'${tld}'`));
			expect(lines).toHaveLength(1);
			expect(lines[0]).toStartWith('Skipped hierarchy1/');
			expect(lines[0]).toContain(rule);
		}
	});

	test('a real section that names no section of this installation is skipped (provisioning would refuse it)', () => {
		expect(entry(NOT_A_SECTION)).toBeUndefined();
		expect(
			census.errors.filter((line) =>
				line.includes(
					`'${NOT_A_SECTION}': real section 'hiearachy20' (hierarchy109) is not a section`,
				),
			),
		).toHaveLength(1);
	});

	test('the CORE lg entry never lists a data file', () => {
		const lg = entry('lg');
		// The seed activates lg on every install, the suite DB included.
		expect(lg).toBeDefined();
		expect(lg?.data_files).toEqual([]);
	});
});

describe('hierarchy census — the envelope and the order', () => {
	test('opens with the shared ontology.json envelope', () => {
		const { manifest } = census;
		for (const key of ['version', 'date', 'entity_id', 'entity', 'entity_label', 'host']) {
			expect(key in manifest).toBe(true);
		}
		expect(Object.keys(manifest).slice(0, 6)).toEqual([
			'version',
			'date',
			'entity_id',
			'entity',
			'entity_label',
			'host',
		]);
	});

	test('entries are sorted by tld (a stable vendored diff)', () => {
		const tlds = census.manifest.active_hierarchies.map((item) => item.tld);
		expect(tlds).toEqual([...tlds].sort((a, b) => a.localeCompare(b)));
	});
});
