/**
 * T1-7 native gate: tool_import_zotero imports a Zotero CSL-JSON export
 * (owner ruling 2026-11-11: PORT). Drives the REAL tool action on the suite
 * database's test3 playground with a scratch Tools configuration (dd996,
 * test/helpers/tool_config_fixture.ts) mapping CSL variables onto generic test3
 * components, and posts the client's real shape (`tool_config: {ddo_map}`).
 * Every record the runs write is tagged with this file's RUN token and swept
 * (records, Time Machine rows, the dd800 runs), as are the staged files.
 *
 * RED on 4a672825ce: the door read an RDF/XML file and a `{predicate,
 * component_tipo}` map out of the CLIENT tool_config, so every run refused
 * "Missing Zotero field-map".
 *
 * Situation (models verified against src/core/test_data/test_tld_ontology.json):
 *   test162 input_text (code) · test52 input_text (title; also the Series name)
 *   test166 input_text (authors) · test172 date range · test145 date
 *   test91 select→dd64 (typology) · test88 check_box→dd64 (number kind)
 *   test17 text_area (ISBN/ISSN) · test140 iri (DOI) · test80 portal→test3 (Series link)
 *   test85 pdf · test99 image.
 *
 * The `field_to_section_id` variable (`call-number`) is an IDENTIFIER looked up
 * through the component the map binds it to (owner C18, 2026-11-13): found →
 * that record, absent → created, held by two records → the ITEM is refused.
 * WC-2026-11-12-zotero-csl-json-import (+ addendum 2026-11-13).
 */

import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import {
	closeSync,
	copyFileSync,
	existsSync,
	ftruncateSync,
	mkdirSync,
	openSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config } from '../../src/config/config.ts';
import { getComponentModel } from '../../src/core/components/registry.ts';
import { sql, withTransaction } from '../../src/core/db/postgres.ts';
import { ghostscriptAvailable } from '../../src/core/media/engine/ghostscript.ts';
import { buildMediaLocation } from '../../src/core/media/path.ts';
import { resolveMediaToolContext } from '../../src/core/media/tool_support.ts';
import { getMatrixTableFromTipo, getModelByTipo } from '../../src/core/ontology/resolver.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import { saveComponentData } from '../../src/core/section/record/save_component.ts';
import { resolvePrincipal } from '../../src/core/security/permissions.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { CSV_INGEST_MAX_BYTES } from '../../src/core/tools/import_csv.ts';
import { lockLinkNames } from '../../src/core/tools/import_link.ts';
import { getLoadedTool } from '../../src/core/tools/loader.ts';
import type { ToolResponse } from '../../src/core/tools/module.ts';
import { readZoteroConfig } from '../../src/core/tools/zotero_map.ts';
import { toolTimeMachineBulkRevert } from '../../tools/tool_time_machine/server/bulk_revert.ts';
import { mustGet } from '../helpers/assert.ts';
import { refusalOf } from '../helpers/refusal.ts';
import { installScratchToolConfig } from '../helpers/tool_config_fixture.ts';

const SCRATCH_USER = 987671;
const KEY_DIR = 'zotero_native';
const RUN = `zt${Date.now().toString(36)}`;
const TABLE = 'matrix_test';
const PDF_KIT = resolve(import.meta.dir, '../../src/core/test_data/media_kit/pdf.pdf');
const HAVE_GS = ghostscriptAvailable();
const IMAGE_KIT = resolve(import.meta.dir, '../../src/core/test_data/media_kit/image.jpg');
/** A word-processor original stand-in: not a PDF rendition, so no derivative is rebuilt. */
const ODT_BYTES = Buffer.from('PK\u0003\u0004 not a pdf: authored document stand-in\n');

const stagingRoot = resolve(
	config.media.rootPath ?? '',
	config.media.upload.tmpSubdir,
	String(SCRATCH_USER),
);
const stagedDir = resolve(stagingRoot, KEY_DIR);

const SERVER_CONFIG = {
	map: [
		{ name: 'id', ddo_map: [{ tipo: 'test162', section_tipo: 'test3' }] },
		{ name: 'title', ddo_map: [{ tipo: 'test52', section_tipo: 'test3' }] },
		{ name: 'author', ddo_map: [{ tipo: 'test166', section_tipo: 'test3' }] },
		{ name: 'issued', ddo_map: [{ tipo: 'test172', section_tipo: 'test3' }] },
		{ name: 'accessed', ddo_map: [{ tipo: 'test145', section_tipo: 'test3' }] },
		{ name: 'type', ddo_map: [{ tipo: 'test91', section_tipo: 'test3' }] },
		{ name: 'ISBN', ddo_map: [{ tipo: 'test17', section_tipo: 'test3' }] },
		{ name: 'ISSN', ddo_map: [{ tipo: 'test17', section_tipo: 'test3' }] },
		{ name: 'DOI', ddo_map: [{ tipo: 'test140', section_tipo: 'test3' }] },
		{ name: 'archive', ddo_map: [{ tipo: 'test85', section_tipo: 'test3' }] },
		{ name: 'call-number', ddo_map: [{ tipo: 'test162', section_tipo: 'test3' }] },
		{
			name: 'container-title',
			ddo_map: [
				{ tipo: 'test80', section_tipo: 'test3' },
				{ tipo: 'test52', section_tipo: 'test3', parent: 'test80' },
			],
		},
	],
	main: [
		{ name: 'section', tipo: 'test3' },
		{ name: 'pdf', tipo: 'test85' },
		{ name: 'identifying_image', tipo: 'test99' },
		{ name: 'field_standard_number', tipo: 'test88' },
		{ name: 'field_to_section_id', value: 'call-number' },
	],
	typology: [
		{ name: 'book', value: [{ section_id: 1, section_tipo: 'dd64' }] },
		{ name: 'article-journal', value: [{ section_id: 2, section_tipo: 'dd64' }] },
	],
	standard_type: [
		{ name: 'ISBN', value: [{ section_id: 1, section_tipo: 'dd64' }] },
		{ name: 'ISSN', value: [{ section_id: 2, section_tipo: 'dd64' }] },
	],
};

interface Report {
	summary: string;
	created: number;
	updated: number;
	failed: { section_id: number; component_tipo: string; msg: string }[];
	errors: string[];
	notices: string[];
	attachments: string[];
	bulk_process_id: number | null;
}

const runs: number[] = [];
let teardownConfig: () => Promise<void> = async () => {};

/** Stage one export (and optional attachments); answers its files_data entries. */
function stage(name: string, items: unknown, extra: { name: string; from?: string }[] = []) {
	mkdirSync(stagedDir, { recursive: true });
	writeFileSync(
		resolve(stagedDir, name),
		typeof items === 'string' ? items : JSON.stringify(items),
	);
	for (const file of extra)
		if (file.from !== undefined) copyFileSync(file.from, resolve(stagedDir, file.name));
	return [
		{ name, tmp_name: name },
		...extra.map((file) => ({ name: file.name, tmp_name: file.name })),
	];
}

async function runRaw(options: Record<string, unknown>): Promise<ToolResponse> {
	const loaded = await getLoadedTool('tool_import_zotero');
	return mustGet(loaded!.module.apiActions.import_files, 'import_files').handler({
		principal: await resolvePrincipal(-1),
		userId: SCRATCH_USER,
		background: false,
		options: {
			section_tipo: 'test3',
			tipo: 'test52',
			section_id: 1,
			tool_config: { ddo_map: [] },
			key_dir: KEY_DIR,
			...options,
		},
	});
}

async function run(options: Record<string, unknown>): Promise<Report> {
	const res = (await runRaw(options)) as { ok: boolean; data: Report };
	expect(res.ok).toBe(true);
	if (res.data.bulk_process_id !== null) runs.push(res.data.bulk_process_id);
	return res.data;
}

/** A test3 component's stored items on one record. */
async function itemsOf(
	sectionId: number,
	column: string,
	tipo: string,
): Promise<Record<string, unknown>[]> {
	const rows = (await sql.unsafe(
		`SELECT ${column} -> $1::text AS items FROM ${TABLE} WHERE section_tipo = 'test3' AND section_id = $2`,
		[tipo, sectionId],
	)) as { items: Record<string, unknown>[] | null }[];
	return rows[0]?.items ?? [];
}

/** Every test3 record whose code (test162) is `code`. */
async function recordsWithCode(code: string): Promise<number[]> {
	const rows = (await sql.unsafe(
		`SELECT section_id FROM ${TABLE} WHERE section_tipo = 'test3' AND string -> 'test162' @> $1::text::jsonb`,
		[JSON.stringify([{ value: code }])],
	)) as { section_id: number }[];
	return rows.map((row) => Number(row.section_id));
}

/** Every test3 record whose test52 (title / Series name) holds `name`. */
async function recordsNamed(name: string): Promise<number[]> {
	const rows = (await sql.unsafe(
		`SELECT section_id FROM ${TABLE} WHERE section_tipo = 'test3' AND string -> 'test52' @> $1::text::jsonb`,
		[JSON.stringify([{ value: name }])],
	)) as { section_id: number }[];
	return rows.map((row) => Number(row.section_id));
}

const key = (k: string) => `${RUN}${k}`;
const uri = (k: string) => `http://zotero.org/users/1/items/${key(k)}`;
/** A call-number (the `field_to_section_id` identifier) of this run. */
const cn = (k: string) => `${RUN}-cn-${k}`;

beforeAll(async () => {
	await assertTestDatabase('tool_import_zotero_native');
	teardownConfig = await installScratchToolConfig('tool_import_zotero', SERVER_CONFIG);
});

afterAll(async () => {
	await teardownConfig();
	rmSync(stagingRoot, { recursive: true, force: true });
	const tagged = (await sql.unsafe(
		`SELECT section_id FROM ${TABLE} WHERE section_tipo = 'test3' AND string::text LIKE $1`,
		[`%${RUN}%`],
	)) as { section_id: number }[];
	const ids = tagged.map((row) => Number(row.section_id));
	if (ids.length > 0) {
		await sql.unsafe(
			`DELETE FROM ${TABLE} WHERE section_tipo = 'test3' AND section_id = ANY($1::int[])`,
			[ids],
		);
		await sql.unsafe(
			`DELETE FROM matrix_time_machine WHERE section_tipo = 'test3' AND section_id = ANY($1::int[])`,
			[ids],
		);
	}
	const bulkTable = await getMatrixTableFromTipo('dd800');
	if (bulkTable !== null && runs.length > 0) {
		await sql.unsafe(
			`DELETE FROM ${bulkTable} WHERE section_tipo = 'dd800' AND section_id = ANY($1::int[])`,
			[runs],
		);
		await sql.unsafe(`DELETE FROM matrix_time_machine WHERE bulk_process_id = ANY($1::int[])`, [
			runs,
		]);
	}
});

describe('tool_import_zotero: a CSL-JSON export through the server map', () => {
	const exportItems = [
		{
			id: uri('A'),
			type: 'book',
			title: `${RUN} The first book`,
			author: [{ given: 'Jane', family: 'Smith' }, { literal: `${RUN} Museum` }],
			issued: { 'date-parts': [[2014, 12, 30]] },
			DOI: '10.1000/xyz',
			'call-number': cn('A'),
			publisher: 'Unmapped House',
		},
		{
			id: uri('B'),
			type: 'article-journal',
			title: `${RUN} An article`,
			issued: { 'date-parts': [[2010], [2012]] },
			accessed: { 'date-parts': [[2020], [2021]] },
			ISBN: '978-0',
			ISSN: '1234-5678',
		},
	];

	test('creates one record per item: code, title, authors, date, typology locator, DOI iri, one dd800 run', async () => {
		const report = await run({ files_data: stage('library.json', exportItems) });
		expect(report.errors).toEqual([]);
		expect(report.failed).toEqual([]);
		expect(report.created).toBe(2);
		expect(report.updated).toBe(0);
		expect(report.bulk_process_id).not.toBeNull();

		const [a] = await recordsWithCode(key('A'));
		expect(a).toBeDefined();
		const id = a as number;
		expect((await itemsOf(id, 'string', 'test52')).map((i) => i.value)).toEqual([
			`${RUN} The first book`,
		]);
		expect((await itemsOf(id, 'string', 'test166')).map((i) => i.value)).toEqual([
			'Jane Smith',
			`${RUN} Museum`,
		]);
		const [date] = await itemsOf(id, 'date', 'test172');
		expect(date?.start).toMatchObject({ year: 2014, month: 12, day: 30 });
		const [typology] = await itemsOf(id, 'relation', 'test91');
		expect(typology).toMatchObject({
			section_tipo: 'dd64',
			section_id: 1,
			from_component_tipo: 'test91',
		});
		const [doi] = await itemsOf(id, 'iri', 'test140');
		expect(doi?.iri).toBe('https://www.doi.org/10.1000/xyz');
		// One run: every TM row of the record carries it.
		const tm = (await sql.unsafe(
			`SELECT DISTINCT bulk_process_id FROM matrix_time_machine WHERE section_tipo = 'test3' AND section_id = $1`,
			[id],
		)) as { bulk_process_id: number | null }[];
		expect(tm.map((row) => row.bulk_process_id)).toEqual([report.bulk_process_id]);
		// The consumed export is gone (PHP unlink).
		expect(existsSync(resolve(stagedDir, 'library.json'))).toBe(false);
	});

	test('notices: unmapped variables once, a range end on a single date; the call-number is a VALUE of its component', async () => {
		const report = await run({ files_data: stage('library.json', exportItems) });
		expect(report.notices.filter((n) => n.includes('call-number'))).toEqual([]);
		expect(report.notices.filter((n) => n.includes('Not in the Zotero map'))).toHaveLength(1);
		expect(report.notices.some((n) => n.includes('publisher'))).toBe(true);
		expect(report.notices.some((n) => n.startsWith(`${key('B')}: accessed:`))).toBe(true);
		// C18: the call-number is written into the component the map binds it to
		// (the same record the key names) — never cast to a record number.
		const byKey = await recordsWithCode(key('A'));
		expect(byKey).toHaveLength(1);
		expect(await recordsWithCode(cn('A'))).toEqual(byKey);
		expect(await recordsWithCode('42')).toEqual([]);
	});

	test('C18 found: a call-number held by ONE record resolves the item to it; the key is written there too', async () => {
		// A record known only by its call-number (an item without a Zotero id).
		const seeded = await run({
			files_data: stage('cn-f0.json', [{ 'call-number': cn('F'), title: `${RUN} F0` }]),
		});
		expect(seeded.created).toBe(1);
		const [found] = await recordsWithCode(cn('F'));
		expect(found).toBeDefined();
		const report = await run({
			files_data: stage('cn-f1.json', [
				{ id: uri('IF'), 'call-number': cn('F'), title: `${RUN} F1` },
			]),
		});
		expect(report.errors).toEqual([]);
		expect(report.created).toBe(0);
		expect(report.updated).toBe(1);
		expect(await recordsWithCode(key('IF'))).toEqual([found as number]);
		expect(await recordsWithCode(cn('F'))).toEqual([found as number]);
		expect((await itemsOf(found as number, 'string', 'test52')).map((i) => i.value)).toEqual([
			`${RUN} F1`,
		]);
	});

	test('C18 two: a call-number held by TWO records refuses THAT item; the other items are written', async () => {
		// Two records, then both made to hold the same call-number (a duplicate in
		// the data: an import cannot produce it — the second item resolves to the first).
		await run({
			files_data: stage('cn-t1.json', [{ 'call-number': cn('T1'), title: `${RUN} T1` }]),
		});
		await run({
			files_data: stage('cn-t2.json', [{ 'call-number': cn('T2'), title: `${RUN} T2` }]),
		});
		const twins = [...(await recordsWithCode(cn('T1'))), ...(await recordsWithCode(cn('T2')))];
		expect(twins).toHaveLength(2);
		await sql.unsafe(
			`UPDATE ${TABLE} SET string = jsonb_set(string, '{test162}', $1::text::jsonb) WHERE section_tipo = 'test3' AND section_id = ANY($2::int[])`,
			[JSON.stringify([{ id: 1, lang: 'lg-nolan', value: cn('T') }]), twins],
		);
		expect(await recordsWithCode(cn('T'))).toHaveLength(2);
		const report = await run({
			files_data: stage('cn-t3.json', [
				{ id: uri('IT'), 'call-number': cn('T'), title: `${RUN} T3` },
				{ id: uri('IT4'), title: `${RUN} T4` },
			]),
		});
		expect(report.created).toBe(1);
		expect(report.updated).toBe(0);
		expect(report.errors).toHaveLength(1);
		expect(report.errors[0]).toContain(key('IT'));
		expect(report.errors[0]).toContain(cn('T'));
		expect(report.errors[0]).toContain('more than one record');
		expect(await recordsWithCode(key('IT'))).toEqual([]);
		expect(await recordsNamed(`${RUN} T3`)).toEqual([]);
		expect(await recordsWithCode(key('IT4'))).toHaveLength(1);
	});

	test('C18 disagreement: the key names one record and the call-number another — the item is refused', async () => {
		await run({
			files_data: stage('cn-g0.json', [{ 'call-number': cn('G'), title: `${RUN} G0` }]),
		});
		const [a] = await recordsWithCode(key('A'));
		const titleBefore = await itemsOf(a as number, 'string', 'test52');
		const report = await run({
			files_data: stage('cn-g1.json', [
				{ id: uri('A'), 'call-number': cn('G'), title: `${RUN} G1` },
			]),
		});
		expect(report.created + report.updated).toBe(0);
		expect(report.errors).toHaveLength(1);
		expect(report.errors[0]).toContain(cn('G'));
		expect(report.errors[0]).toContain(key('A'));
		expect(await itemsOf(a as number, 'string', 'test52')).toEqual(titleBefore);
		expect(await recordsNamed(`${RUN} G1`)).toEqual([]);
	});

	test('C18 batch: the same call-number on two items of one export — the second item is refused', async () => {
		const report = await run({
			files_data: stage('cn-h.json', [
				{ id: uri('IH1'), 'call-number': cn('H'), title: `${RUN} H1` },
				{ id: uri('IH2'), 'call-number': cn('H'), title: `${RUN} H2` },
			]),
		});
		expect(report.created).toBe(1);
		expect(report.errors).toHaveLength(1);
		expect(report.errors[0]).toContain(key('IH2'));
		expect(await recordsWithCode(key('IH1'))).toHaveLength(1);
		expect(await recordsWithCode(key('IH2'))).toEqual([]);
	});

	test('C51: an export over the 64 MB ingest ceiling is refused at the door — nothing read, the file stays staged', async () => {
		const [entry] = stage('huge.json', '[]');
		const path = resolve(stagedDir, 'huge.json');
		const fd = openSync(path, 'r+');
		ftruncateSync(fd, CSV_INGEST_MAX_BYTES + 1);
		closeSync(fd);
		try {
			const report = await run({ files_data: [entry] });
			expect(report.created + report.updated).toBe(0);
			expect(report.errors).toHaveLength(1);
			expect(report.errors[0]).toContain('huge.json');
			expect(report.errors[0]).toContain('too large');
			expect(report.errors[0]).toContain('64 MB');
			expect(existsSync(path)).toBe(true);
		} finally {
			rmSync(path, { force: true });
		}
	});

	test('re-importing the same export UPDATES the same records (matched by the Zotero key)', async () => {
		const before = [...(await recordsWithCode(key('A'))), ...(await recordsWithCode(key('B')))];
		const report = await run({ files_data: stage('library.json', exportItems) });
		expect(report.created).toBe(0);
		expect(report.updated).toBe(2);
		expect([...(await recordsWithCode(key('A'))), ...(await recordsWithCode(key('B')))]).toEqual(
			before,
		);
	});

	test('a range date keeps its end; ISBN and ISSN both land (no last-wins), with both kinds', async () => {
		const [b] = await recordsWithCode(key('B'));
		const [range] = await itemsOf(b as number, 'date', 'test172');
		expect(range?.start).toMatchObject({ year: 2010 });
		expect(range?.end).toMatchObject({ year: 2012 });
		const [single] = await itemsOf(b as number, 'date', 'test145');
		expect(single?.start).toMatchObject({ year: 2020 });
		expect(single?.end).toBeUndefined();
		expect((await itemsOf(b as number, 'string', 'test17')).map((i) => i.value)).toEqual([
			'<p>978-0</p>',
			'<p>1234-5678</p>',
		]);
		expect((await itemsOf(b as number, 'relation', 'test88')).map((l) => l.section_id)).toEqual([
			1, 2,
		]);
	});

	test('a text date on a re-import is REFUSED and the stored date is left byte-identical', async () => {
		const [a] = await recordsWithCode(key('A'));
		const before = await itemsOf(a as number, 'date', 'test172');
		const report = await run({
			files_data: stage('textdate.json', [{ id: uri('A'), issued: { raw: 'circa 1900' } }]),
		});
		expect(report.updated).toBe(1);
		expect(
			report.failed.some((f) => f.component_tipo === 'test172' && f.msg.includes('circa 1900')),
		).toBe(true);
		expect(await itemsOf(a as number, 'date', 'test172')).toEqual(before);
	});

	test('an unknown CSL type is a refusal line; the other fields are written', async () => {
		const report = await run({
			files_data: stage('type.json', [
				{ id: uri('T'), type: 'manuscript', title: `${RUN} Typeless` },
			]),
		});
		expect(report.created).toBe(1);
		expect(
			report.failed.some((f) => f.component_tipo === 'test91' && f.msg.includes('manuscript')),
		).toBe(true);
		const [t] = await recordsWithCode(key('T'));
		expect((await itemsOf(t as number, 'string', 'test52')).map((i) => i.value)).toEqual([
			`${RUN} Typeless`,
		]);
	});
});

describe('identity: the Zotero key, its full URI, duplicates', () => {
	/** One record whose code (test162) holds `code` verbatim, as an earlier import may have stored it. */
	async function seedCode(seedKey: string, code: string): Promise<number> {
		const seed = await run({
			files_data: stage(`seed${seedKey}.json`, [
				{ id: `seed-${key(seedKey)}`, title: `${RUN} seed` },
			]),
		});
		expect(seed.created).toBe(1);
		const [seeded] = await recordsWithCode(`seed-${key(seedKey)}`);
		await sql.unsafe(
			`UPDATE ${TABLE} SET string = jsonb_set(string, '{test162}', $1::text::jsonb) WHERE section_tipo = 'test3' AND section_id = $2`,
			[JSON.stringify([{ id: 1, lang: 'lg-nolan', value: code }]), seeded],
		);
		return seeded as number;
	}

	test('a code stored as the full URI is matched by that exact URI', async () => {
		const seeded = await seedCode('U', uri('U'));
		const matched = await run({
			files_data: stage('u.json', [{ id: uri('U'), title: `${RUN} U again` }]),
		});
		expect(matched.updated).toBe(1);
		expect(matched.created).toBe(0);
		expect((await itemsOf(seeded, 'string', 'test52')).map((i) => i.value)).toEqual([
			`${RUN} U again`,
		]);
	});

	test('a full-URI code is NOT matched by the same key under another library', async () => {
		// The SAME key (no suffix): only the exact-URI leg could reach this record,
		// and it must not — another library's item is a different item.
		const seeded = await seedCode('L', uri('L'));
		const other = await run({
			files_data: stage('l.json', [
				{ id: `http://zotero.org/groups/9/items/${key('L')}`, title: `${RUN} other library` },
			]),
		});
		expect(other.created).toBe(1);
		expect(other.updated).toBe(0);
		expect((await itemsOf(seeded, 'string', 'test162')).map((i) => i.value)).toEqual([uri('L')]);
		expect((await itemsOf(seeded, 'string', 'test52')).map((i) => i.value)).toEqual([
			`${RUN} seed`,
		]);
	});

	test('a BARE-key code (what this importer stores) is matched by the key from ANY library', async () => {
		// PINNED, not endorsed: the importer writes the bare key (PHP), and the key
		// leg is library-blind (PHP `*/<key>` was too), so a same-key item of another
		// library UPDATES this record. Library-scoped identity is an open owner
		// decision (WC-2026-11-12-zotero-csl-json-import, Identity) — change this
		// gate with that ruling, never silently.
		const first = await run({
			files_data: stage('b1.json', [{ id: uri('BK'), title: `${RUN} B` }]),
		});
		expect(first.created).toBe(1);
		const [stored] = await recordsWithCode(key('BK'));
		expect((await itemsOf(stored as number, 'string', 'test162')).map((i) => i.value)).toEqual([
			key('BK'),
		]);
		const other = await run({
			files_data: stage('b2.json', [
				{ id: `http://zotero.org/groups/9/items/${key('BK')}`, title: `${RUN} B other library` },
			]),
		});
		expect(other.updated).toBe(1);
		expect(other.created).toBe(0);
	});

	test('one Zotero key twice in one batch refuses the run, nothing written', async () => {
		const refusal = await refusalOf(
			runRaw({
				files_data: stage('dup.json', [
					{ id: uri('D'), title: `${RUN} D1` },
					{ id: uri('D'), title: `${RUN} D2` },
				]),
			}),
		);
		expect(refusal.code).toBe('request.invalid_data');
		expect(refusal.publicMessage).toContain('more than one record of this import');
		expect(await recordsWithCode(key('D'))).toEqual([]);
	});

	test('a key held by two records refuses the run (resource.conflict), nothing written', async () => {
		await run({ files_data: stage('c1.json', [{ id: `${key('C')}a`, title: `${RUN} C1` }]) });
		await run({ files_data: stage('c2.json', [{ id: `${key('C')}b`, title: `${RUN} C2` }]) });
		// Two records, then both made to hold the same code (a duplicate in the data).
		const twins = [
			...(await recordsWithCode(`${key('C')}a`)),
			...(await recordsWithCode(`${key('C')}b`)),
		];
		expect(twins).toHaveLength(2);
		await sql.unsafe(
			`UPDATE ${TABLE} SET string = jsonb_set(string, '{test162}', $1::text::jsonb) WHERE section_tipo = 'test3' AND section_id = ANY($2::int[])`,
			[JSON.stringify([{ id: 1, lang: 'lg-nolan', value: key('C') }]), twins],
		);
		const refusal = await refusalOf(
			runRaw({ files_data: stage('c3.json', [{ id: uri('C'), title: `${RUN} C3` }]) }),
		);
		expect(refusal.code).toBe('resource.conflict');
		expect(await recordsNamed(`${RUN} C3`)).toEqual([]);
	});
});

describe('container-title: the Series link (find by exact name, else create once)', () => {
	test('an absent Series is created ONCE and linked from both items; an existing one is reused', async () => {
		const series = `${RUN} Revista de Prueba`;
		const report = await run({
			files_data: stage('series.json', [
				{ id: uri('S1'), title: `${RUN} S1`, 'container-title': series },
				{ id: uri('S2'), title: `${RUN} S2`, 'container-title': series },
			]),
		});
		expect(report.failed).toEqual([]);
		const named = await recordsNamed(series);
		expect(named).toHaveLength(1);
		for (const k of ['S1', 'S2']) {
			const [id] = await recordsWithCode(key(k));
			const links = await itemsOf(id as number, 'relation', 'test80');
			expect(links.map((l) => [l.section_tipo, l.section_id])).toEqual([['test3', named[0]]]);
		}
		// A look-alike (accent-folded) name is a DIFFERENT Series.
		const lookAlike = await run({
			files_data: stage('series2.json', [
				{ id: uri('S3'), 'container-title': `${RUN} Revísta de Prueba` },
			]),
		});
		expect(lookAlike.created).toBe(1);
		expect(await recordsNamed(`${RUN} Revísta de Prueba`)).toHaveLength(1);
		expect(await recordsNamed(series)).toHaveLength(1);
	});

	/**
	 * THE LOCK, deterministically: a transaction holding the Series name's lock
	 * (as a concurrent run's record would) creates the Series and commits only
	 * AFTER the import has started. The import must WAIT on the lock and then find
	 * that Series — without the lock it searches past the uncommitted row, creates
	 * a second Series, and two records share one name.
	 */
	test('a run waits on the Series name lock and reuses the Series a concurrent writer created', async () => {
		const series = `${RUN} Concurrent Series`;
		const files = stage('p1.json', [{ id: uri('P1'), 'container-title': series }]);
		let release: () => void = () => {};
		const gate = new Promise<void>((resolveGate) => {
			release = resolveGate;
		});
		let locked: () => void = () => {};
		const holding = new Promise<void>((resolveHolding) => {
			locked = resolveHolding;
		});
		// The writer's record exists BEFORE it holds the lock (its create would hold
		// the section counter, which serializes the import for another reason).
		const id = await createSectionRecord('test3', -1);
		await sql.unsafe(
			`UPDATE ${TABLE} SET string = jsonb_set(coalesce(string, '{}'::jsonb), '{test162}', $1::text::jsonb) WHERE section_tipo = 'test3' AND section_id = $2`,
			[JSON.stringify([{ id: 1, lang: 'lg-nolan', value: `${RUN}-writer` }]), id],
		);
		const holder = withTransaction(async () => {
			await lockLinkNames([
				{
					component_tipo: 'test80',
					target: { sectionTipo: 'test3', componentTipo: 'test52' },
					text: series,
				},
			]);
			await saveComponentData({
				componentTipo: 'test52',
				sectionTipo: 'test3',
				sectionId: id,
				lang: 'lg-eng',
				changedData: [{ action: 'set_data', id: null, value: [{ value: series }] }],
				userId: -1,
			});
			locked();
			await gate;
		});
		await holding;
		const importing = run({ files_data: files });
		await Bun.sleep(500);
		release();
		await holder;
		const report = await importing;
		expect(report.failed).toEqual([]);
		const named = await recordsNamed(series);
		expect(named).toHaveLength(1);
		const [p1] = await recordsWithCode(key('P1'));
		expect((await itemsOf(p1 as number, 'relation', 'test80')).map((l) => l.section_id)).toEqual(
			named,
		);
	});

	test('a Series name held by two records refuses the LINK only; the record is written', async () => {
		const series = `${RUN} Twin Series`;
		await run({ files_data: stage('t1.json', [{ id: uri('W1'), title: series }]) });
		await run({ files_data: stage('t2.json', [{ id: uri('W2'), title: series }]) });
		const report = await run({
			files_data: stage('t3.json', [
				{ id: uri('W3'), title: `${RUN} W3`, 'container-title': series },
			]),
		});
		expect(report.created).toBe(1);
		expect(
			report.failed.some(
				(f) => f.component_tipo === 'test80' && f.msg.includes('more than one record'),
			),
		).toBe(true);
		const [w3] = await recordsWithCode(key('W3'));
		expect(await itemsOf(w3 as number, 'relation', 'test80')).toEqual([]);
	});

	test('reverting the run removes the Series it created', async () => {
		const series = `${RUN} Revertible Series`;
		const report = await run({
			files_data: stage('rv.json', [{ id: uri('R1'), 'container-title': series }]),
		});
		const [created] = await recordsNamed(series);
		expect(created).toBeDefined();
		const response = await toolTimeMachineBulkRevert({
			principal: await resolvePrincipal(-1),
			userId: -1,
			options: { bulk_process_id: report.bulk_process_id },
			background: false,
		} as never);
		expect(response.ok).toBe(true);
		runs.push((response.data as { bulk_process_id: number }).bulk_process_id);
		expect(await recordsNamed(series)).toEqual([]);
	});
});

describe('the door: server config, sections, form values, files', () => {
	test('the SERVER map wins: a client-posted map is ignored', async () => {
		const report = await run({
			tool_config: {
				ddo_map: [],
				map: [{ name: 'title', ddo_map: [{ tipo: 'test166', section_tipo: 'test3' }] }],
			},
			files_data: stage('client.json', [{ id: uri('M'), title: `${RUN} server map` }]),
		});
		const [m] = await recordsWithCode(key('M'));
		expect(report.created).toBe(1);
		expect((await itemsOf(m as number, 'string', 'test52')).map((i) => i.value)).toEqual([
			`${RUN} server map`,
		]);
		expect(await itemsOf(m as number, 'string', 'test166')).toEqual([]);
	});

	test('a map entry of another section refuses the run before anything is read', async () => {
		const files = stage('foreign.json', [{ id: uri('F'), title: `${RUN} foreign` }]);
		const foreign = {
			...SERVER_CONFIG,
			map: [
				...SERVER_CONFIG.map,
				{ name: 'note', ddo_map: [{ tipo: 'test52', section_tipo: 'test65' }] },
			],
		};
		await installScratchToolConfig('tool_import_zotero', foreign);
		try {
			const refusal = await refusalOf(runRaw({ files_data: files }));
			expect(refusal.code).toBe('request.invalid_options');
			expect(refusal.publicMessage).toContain('test65');
		} finally {
			teardownConfig = await installScratchToolConfig('tool_import_zotero', SERVER_CONFIG);
		}
		expect(await recordsWithCode(key('F'))).toEqual([]);
		expect(existsSync(resolve(stagedDir, 'foreign.json'))).toBe(true);
	});

	test('C18: field_to_section_id bound to a component that holds no text — the item is refused naming it; unbound → the run is refused', async () => {
		// Bound to a number component (test22): no code can be looked up there.
		const numberBound = {
			...SERVER_CONFIG,
			map: SERVER_CONFIG.map.map((entry) =>
				entry.name === 'call-number'
					? { name: 'call-number', ddo_map: [{ tipo: 'test22', section_tipo: 'test3' }] }
					: entry,
			),
		};
		await installScratchToolConfig('tool_import_zotero', numberBound);
		try {
			const report = await run({
				files_data: stage('cn-bound.json', [
					{ id: uri('IN1'), 'call-number': cn('N'), title: `${RUN} N1` },
					{ id: uri('IN2'), title: `${RUN} N2` },
				]),
			});
			expect(report.created).toBe(1);
			expect(report.errors).toHaveLength(1);
			expect(report.errors[0]).toContain(key('IN1'));
			expect(report.errors[0]).toContain('test22');
			expect(report.errors[0]).toContain('not a text component');
			expect(await recordsWithCode(key('IN1'))).toEqual([]);
			expect(await recordsWithCode(key('IN2'))).toHaveLength(1);
			// Not bound at all: there is no component to look the identifier up in.
			await installScratchToolConfig('tool_import_zotero', {
				...SERVER_CONFIG,
				map: SERVER_CONFIG.map.filter((entry) => entry.name !== 'call-number'),
			});
			const files = stage('cn-unbound.json', [{ id: uri('IN3'), title: `${RUN} N3` }]);
			const refusal = await refusalOf(runRaw({ files_data: files }));
			expect(refusal.code).toBe('request.invalid_options');
			expect(refusal.publicMessage).toContain("'call-number'");
			expect(await recordsWithCode(key('IN3'))).toEqual([]);
		} finally {
			teardownConfig = await installScratchToolConfig('tool_import_zotero', SERVER_CONFIG);
		}
	});

	test('the Values form lands on every record; a form field of another section is refused', async () => {
		const report = await run({
			tool_config: {
				ddo_map: [{ role: 'input_component', tipo: 'test166', section_tipo: 'test3' }],
			},
			components_temp_data: [
				{ tipo: 'test166', section_tipo: 'test3', entries: [{ value: `${RUN} form` }] },
			],
			files_data: stage('form.json', [{ id: uri('V1') }, { id: uri('V2') }]),
		});
		expect(report.created).toBe(2);
		for (const k of ['V1', 'V2']) {
			const [id] = await recordsWithCode(key(k));
			expect((await itemsOf(id as number, 'string', 'test166')).map((i) => i.value)).toEqual([
				`${RUN} form`,
			]);
		}
		const refusal = await refusalOf(
			runRaw({
				tool_config: {
					ddo_map: [{ role: 'input_component', tipo: 'test52', section_tipo: 'test65' }],
				},
				components_temp_data: [
					{ tipo: 'test52', section_tipo: 'test65', entries: [{ value: 'x' }] },
				],
				files_data: stage('form2.json', [{ id: uri('V3') }]),
			}),
		);
		expect(refusal.code).toBe('request.invalid_options');
		expect(await recordsWithCode(key('V3'))).toEqual([]);
	});

	test('a BOM-prefixed UTF-8 export parses; a top-level object and invalid JSON are per-file errors', async () => {
		const bom = `﻿${JSON.stringify([{ id: uri('BOM'), title: `${RUN} Ñandú` }])}`;
		const report = await run({
			files_data: [
				...stage('bom.json', bom),
				...stage('object.json', { id: uri('O') }),
				...stage('broken.json', '[{'),
			],
		});
		expect(report.created).toBe(1);
		expect(report.errors).toHaveLength(2);
		expect(report.errors[0]).toContain('object.json: not a CSL-JSON export');
		expect(report.errors[1]).toContain('broken.json: not valid JSON');
		const [bomId] = await recordsWithCode(key('BOM'));
		expect((await itemsOf(bomId as number, 'string', 'test52')).map((i) => i.value)).toEqual([
			`${RUN} Ñandú`,
		]);
	});
});

describe('the SHIPPED default (register dd1633 ≡ sample_config.json) — C18 review gap', () => {
	/** The register's dd1633 default and the sample mirror, without the sample's `info` note. */
	function shippedConfigs(): {
		register: Record<string, unknown>;
		sample: Record<string, unknown>;
	} {
		const root = resolve(import.meta.dir, '..', '..', 'tools', 'tool_import_zotero');
		const register = JSON.parse(readFileSync(resolve(root, 'register.json'), 'utf8')) as {
			misc: { dd1633: { value: Record<string, unknown> }[] };
		};
		const sample = JSON.parse(readFileSync(resolve(root, 'sample_config.json'), 'utf8')) as Record<
			string,
			unknown
		>[];
		const { info: _info, ...mirror } = mustGet(sample[0], 'sample_config.json[0]');
		return { register: mustGet(register.misc.dd1633[0], 'dd1633[0]').value, sample: mirror };
	}

	test('the register default and sample_config.json are the SAME configuration', () => {
		const { register, sample } = shippedConfigs();
		// The register carries the tool's own `client` flag beside the config keys.
		const CONFIG_KEYS = ['map', 'main', 'typology', 'standard_type'];
		expect(Object.keys(sample).sort()).toEqual([...CONFIG_KEYS].sort());
		for (const key of CONFIG_KEYS) expect(register[key], key).toEqual(sample[key]);
	});

	test('every component the shipped map names IS a component of the suite ontology, and an identifier (if any) binds to a component that holds a code — RED before: call-number → dd176, a label', async () => {
		const { register } = shippedConfigs();
		const cfg = readZoteroConfig(register);
		expect(cfg.idTarget).toEqual({ sectionTipo: 'rsc205', componentTipo: 'rsc137' });
		// Every tipo the map writes (and every link target) resolves to a component model.
		const tipos = new Set<string>();
		for (const entry of cfg.entries) {
			tipos.add(entry.tipo);
			if (entry.link !== undefined) tipos.add(entry.link.componentTipo);
		}
		for (const tipo of [cfg.pdfTipo, cfg.imageTipo, cfg.standardNumberTipo]) {
			if (tipo !== undefined) tipos.add(tipo);
		}
		expect(tipos.size).toBeGreaterThan(10);
		const models = new Map<string, string | null>();
		for (const tipo of tipos) models.set(tipo, await getModelByTipo(tipo));
		const notComponents = [...models].filter(([, model]) => !model?.startsWith('component_'));
		expect(notComponents, 'nodes the shipped map writes that are not components').toEqual([]);
		// The second identifier, when the default names one, must be LOOKUPABLE
		// (a string-column component or an IRI): a label or a number component
		// would refuse every item carrying the value (identifierLookupable).
		if (cfg.identifierTarget !== undefined) {
			const model = await getModelByTipo(cfg.identifierTarget.componentTipo);
			const lookupable =
				model === 'component_iri' ||
				(model !== null && getComponentModel(model)?.column === 'string');
			expect(
				lookupable,
				`identifier bound to ${cfg.identifierTarget.componentTipo} (${model})`,
			).toBe(true);
			expect(cfg.identifierTarget.componentTipo).not.toBe(cfg.idTarget?.componentTipo);
		} else {
			// The shipped default names NO second identifier (owner question open:
			// Publications has no call-number component to bind one to).
			expect(cfg.fieldToSectionId).toBeUndefined();
			expect(cfg.entries.find((entry) => entry.name === 'call-number')).toBeUndefined();
		}
	});
});

describe('attachments: the archive PDF and its cover', () => {
	test('an archive not uploaded, or a traversal name, is a line; the record is written', async () => {
		const report = await run({
			files_data: stage('att.json', [
				{ id: uri('N1'), archive: 'missing.pdf' },
				{ id: uri('N2'), archive: '../../etc/passwd' },
			]),
		});
		expect(report.created).toBe(2);
		expect(report.attachments.some((l) => l.startsWith('missing.pdf: not imported'))).toBe(true);
		expect(report.attachments.some((l) => l.startsWith('../../etc/passwd: not imported'))).toBe(
			true,
		);
	});

	test.skipIf(!HAVE_GS)(
		'the archive PDF lands in the pdf component and its cover in the image',
		async () => {
			const report = await run({
				files_data: stage(
					'pdf.json',
					[{ id: uri('PDF'), archive: `${RUN}.pdf` }],
					[{ name: `${RUN}.pdf`, from: PDF_KIT }],
				),
			});
			expect(report.created).toBe(1);
			const [id] = await recordsWithCode(key('PDF'));
			const pdf = await itemsOf(id as number, 'media', 'test85');
			const image = await itemsOf(id as number, 'media', 'test99');
			expect(pdf.length, JSON.stringify(report.attachments)).toBe(1);
			expect(image.length, JSON.stringify(report.attachments)).toBe(1);
			expect(existsSync(resolve(stagedDir, `${RUN}.pdf`))).toBe(false);
		},
	);

	test.skipIf(HAVE_GS)(
		'without Ghostscript the cover is a report line, the PDF still lands',
		async () => {
			const report = await run({
				files_data: stage(
					'pdf2.json',
					[{ id: uri('PDF2'), archive: `${RUN}b.pdf` }],
					[{ name: `${RUN}b.pdf`, from: PDF_KIT }],
				),
			});
			expect(report.attachments.some((l) => l.includes('cover'))).toBe(true);
		},
	);
});

describe("attachments: the cover is THIS import's, and every failure is named where it happened", () => {
	/** The test85 PDF cover path of one record (where a previous document's cover sits). */
	async function coverPathOf(sectionId: number): Promise<string> {
		const media = await resolveMediaToolContext({
			component_tipo: 'test85',
			section_tipo: 'test3',
			section_id: sectionId,
		});
		return buildMediaLocation(
			media.spec,
			media.identity,
			media.spec.defaultQuality,
			mustGet(media.spec.coverExtensions[0], 'cover extension'),
			media.pathOpts,
		).absolutePath;
	}

	test("a re-import whose archive builds no cover never takes the PREVIOUS document's cover", async () => {
		const first = await run({ files_data: stage('stale1.json', [{ id: uri('STALE') }]) });
		expect(first.created).toBe(1);
		const [id] = await recordsWithCode(key('STALE'));
		// The previous PDF's cover, still on disk.
		const cover = await coverPathOf(id as number);
		mkdirSync(dirname(cover), { recursive: true });
		copyFileSync(IMAGE_KIT, cover);
		// The new archive is a non-PDF original: nothing derived is rebuilt.
		mkdirSync(stagedDir, { recursive: true });
		writeFileSync(resolve(stagedDir, `${RUN}.odt`), ODT_BYTES);
		const report = await run({
			files_data: stage(
				'stale2.json',
				[{ id: uri('STALE'), archive: `${RUN}.odt` }],
				[{ name: `${RUN}.odt` }],
			),
		});
		expect(report.updated).toBe(1);
		expect((await itemsOf(id as number, 'media', 'test85')).length).toBe(1);
		expect(
			await itemsOf(id as number, 'media', 'test99'),
			JSON.stringify(report.attachments),
		).toEqual([]);
		expect(report.attachments.some((l) => l.startsWith(`${RUN}.odt: no cover image`))).toBe(true);
		// The non-source notice reaches the operator.
		expect(report.attachments.some((l) => l.includes('stored as the original'))).toBe(true);
	});

	test.skipIf(!HAVE_GS)(
		'a failed cover import is a COVER line: the persisted PDF is not reported missing, no staged copy left',
		async () => {
			await installScratchToolConfig('tool_import_zotero', {
				...SERVER_CONFIG,
				main: SERVER_CONFIG.main.map((m) =>
					m.name === 'identifying_image' ? { ...m, tipo: 'test52' } : m,
				),
			});
			try {
				const report = await run({
					files_data: stage(
						'cfail.json',
						[{ id: uri('CF'), archive: `${RUN}c.pdf` }],
						[{ name: `${RUN}c.pdf`, from: PDF_KIT }],
					),
				});
				const [id] = await recordsWithCode(key('CF'));
				expect((await itemsOf(id as number, 'media', 'test85')).length).toBe(1);
				expect(
					report.attachments.some((l) => l.startsWith(`${RUN}c.pdf cover: not imported`)),
					JSON.stringify(report.attachments),
				).toBe(true);
				expect(report.attachments.some((l) => l.startsWith(`${RUN}c.pdf: not imported`))).toBe(
					false,
				);
				expect(existsSync(resolve(stagedDir, `zotero_cover_${id}.jpg`))).toBe(false);
			} finally {
				// Re-installing replaces the scratch row (one id); its teardown stays the file's.
				teardownConfig = await installScratchToolConfig('tool_import_zotero', SERVER_CONFIG);
			}
		},
	);

	test.skipIf(!HAVE_GS)(
		'an engine fault in the attachment ingest is LOGGED as one and its line names the request',
		async () => {
			const first = await run({ files_data: stage('fault1.json', [{ id: uri('FAULT') }]) });
			expect(first.created).toBe(1);
			const [id] = await recordsWithCode(key('FAULT'));
			// A directory squats the cover's staging name: the copy fails in the fs,
			// below every typed door — an engine fault, not a refusal.
			const squat = resolve(stagedDir, `zotero_cover_${id}.jpg`);
			mkdirSync(resolve(squat, 'occupied'), { recursive: true });
			const logged = spyOn(console, 'error').mockImplementation(() => {});
			let report: Report;
			let calls: unknown[][];
			try {
				report = await run({
					files_data: stage(
						'fault2.json',
						[{ id: uri('FAULT'), archive: `${RUN}d.pdf` }],
						[{ name: `${RUN}d.pdf`, from: PDF_KIT }],
					),
				});
			} finally {
				calls = [...logged.mock.calls];
				logged.mockRestore();
				rmSync(squat, { recursive: true, force: true });
			}
			const line = report.attachments.find((l) => l.startsWith(`${RUN}d.pdf cover`));
			expect(line, JSON.stringify(report.attachments)).toContain('internal error');
			expect(
				calls.some((call) =>
					String(call[0]).startsWith('[tool_import_zotero] internal.unexpected'),
				),
			).toBe(true);
		},
	);
});
