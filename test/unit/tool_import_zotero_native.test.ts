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
 * The `field_to_section_id` variable (`call-number`) is the record's ADDRESS
 * (owner ruling 2026-11-17 — the named exception to the DATA-08 code-lookup
 * law, this door only): a canonical positive int4 is the section_id — the
 * record there is updated (its key adopted, a DIFFERENT key refused), an absent
 * one (never there, or deleted) is created AT it; anything else refuses THAT
 * item. No call-number → the Zotero key decides. The config binds NO component
 * to the variable, as the shipped default (dd1633) does not.
 * WC-2026-11-12-zotero-csl-json-import (+ addendum 2026-11-18).
 *
 * Owner rulings 2026-11-18 (the addendum "the limit and the whole section"):
 * (a) the section_id limit (int4) IS the import limit — a call-number above it
 * refuses the item under its OWN code and the run warns the user with a
 * labelled envelope notice naming the value and the limit; (b) the Zotero KEY is
 * looked up in the WHOLE section, not the importer's scope, and a record the
 * importer may not change refuses the item and is NAMED to them (a `perm.*`
 * refused entry + a labelled notice). (b) runs as real non-admin identities
 * (test/helpers/authz_door_fixture.ts: CONTROL in project P, records in Q).
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
import { INT4_MAX } from '../../src/core/concepts/section_id.ts';
import { sql, withTransaction } from '../../src/core/db/postgres.ts';
import { ensureRecordGenerationTable } from '../../src/core/db/record_generation.ts';
import type { ApiNotice } from '../../src/core/errors/index.ts';
import { getLabels } from '../../src/core/labels/catalog.ts';
import { ghostscriptAvailable } from '../../src/core/media/engine/ghostscript.ts';
import { buildMediaLocation } from '../../src/core/media/path.ts';
import { resolveMediaToolContext } from '../../src/core/media/tool_support.ts';
import { getMatrixTableFromTipo, getModelByTipo } from '../../src/core/ontology/resolver.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import { deleteSectionRecord } from '../../src/core/section/record/delete_record.ts';
import { saveComponentData } from '../../src/core/section/record/save_component.ts';
import {
	getPermissions,
	type Principal,
	resolvePrincipal,
} from '../../src/core/security/permissions.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { CSV_INGEST_MAX_BYTES } from '../../src/core/tools/import_csv.ts';
import { lockLinkNames } from '../../src/core/tools/import_link.ts';
import { getLoadedTool } from '../../src/core/tools/loader.ts';
import type { ToolResponse } from '../../src/core/tools/module.ts';
import { readZoteroConfig } from '../../src/core/tools/zotero_map.ts';
import {
	type AddressedItem,
	addressOutcome,
	refusalLedger,
	refusalNotices,
	screenAddresses,
} from '../../tools/tool_import_zotero/server/call_number_address.ts';
import { toolTimeMachineBulkRevert } from '../../tools/tool_time_machine/server/bulk_revert.ts';
import { mustGet } from '../helpers/assert.ts';
import {
	AUTHZ_CONTROL_USER_ID,
	AUTHZ_PROJECT_P,
	AUTHZ_PROJECT_Q,
	AUTHZ_TEXT_ONLY_USER_ID,
	type AuthzIdentities,
	assertAuthzDoorContrast,
	createDoorRecord,
	installAuthzDoorFixture,
	removeAuthzDoorFixture,
	resolveAuthzIdentities,
} from '../helpers/authz_door_fixture.ts';
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

/** One user's staging root (the door rebuilds it from the CURRENT user id). */
const stagingRootOf = (userId: number) =>
	resolve(config.media.rootPath ?? '', config.media.upload.tmpSubdir, String(userId));
const stagingRoot = stagingRootOf(SCRATCH_USER);
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
	/** Records created AT their call-number id. */
	created_at_id: number[];
	/** Records updated at their call-number id. */
	updated_at_id: number[];
	/** How many records were TAKEN OVER (never also counted in `updated`). */
	taken_over: number;
	/** Records taken over at their call-number id: they had no Zotero key and hold the item's now. */
	taken_over_at_id: number[];
	/** Items the run refused, typed: the item, the refusal's code, its sentence. */
	refused: { item: string; code: string; message: string }[];
}

const runs: number[] = [];
let teardownConfig: () => Promise<void> = async () => {};

/** Stage one export (and optional attachments) for `userId`; answers its files_data entries. */
function stage(
	name: string,
	items: unknown,
	extra: { name: string; from?: string }[] = [],
	userId: number = SCRATCH_USER,
) {
	const dir = resolve(stagingRootOf(userId), KEY_DIR);
	mkdirSync(dir, { recursive: true });
	writeFileSync(resolve(dir, name), typeof items === 'string' ? items : JSON.stringify(items));
	for (const file of extra)
		if (file.from !== undefined) copyFileSync(file.from, resolve(dir, file.name));
	return [
		{ name, tmp_name: name },
		...extra.map((file) => ({ name: file.name, tmp_name: file.name })),
	];
}

/** Who runs the import: the principal the doors ask, and the user whose staging dir is read. */
interface Importer {
	principal: Principal;
	userId: number;
}

async function runRaw(
	options: Record<string, unknown>,
	importer?: Importer,
): Promise<ToolResponse> {
	const loaded = await getLoadedTool('tool_import_zotero');
	return mustGet(loaded!.module.apiActions.import_files, 'import_files').handler({
		principal: importer?.principal ?? (await resolvePrincipal(-1)),
		userId: importer?.userId ?? SCRATCH_USER,
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

/** The whole success envelope: the report (`data`) and the run's labelled `notices`. */
async function runEnvelope(
	options: Record<string, unknown>,
	importer?: Importer,
): Promise<{ report: Report; notices: ApiNotice[] }> {
	const res = (await runRaw(options, importer)) as {
		ok: boolean;
		data: Report;
		notices?: ApiNotice[];
	};
	expect(res.ok).toBe(true);
	if (res.data.bulk_process_id !== null) runs.push(res.data.bulk_process_id);
	return { report: res.data, notices: res.notices ?? [] };
}

async function run(options: Record<string, unknown>): Promise<Report> {
	return (await runEnvelope(options)).report;
}

/** A notice as the user reads it: its label (lg-eng) with its details filled in. */
async function noticeText(notice: ApiNotice): Promise<string> {
	const template = (await getLabels('lg-eng'))[notice.label_key] ?? '';
	return template.replace(/\$\{(\w+)\}/g, (_match, name: string) =>
		String(notice.details?.[name] ?? `\${${name}}`),
	);
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

/** test3 ids this file ADDRESSED by call-number — swept with their history, whatever they hold. */
const addressedIds = new Set<number>();

/** Remove one test3 record and its Time Machine rows (this file's own scratch). */
async function sweepRecord(sectionId: number): Promise<void> {
	await sql.unsafe(`DELETE FROM ${TABLE} WHERE section_tipo = 'test3' AND section_id = $1`, [
		sectionId,
	]);
	await sql.unsafe(
		`DELETE FROM matrix_time_machine WHERE section_tipo = 'test3' AND section_id = $1`,
		[sectionId],
	);
	// A record born where a deleted one lived opened a generation epoch there.
	await ensureRecordGenerationTable();
	await sql.unsafe(
		`DELETE FROM dedalo_ts_record_generation WHERE section_tipo = 'test3' AND section_id = $1`,
		[sectionId],
	);
}

/**
 * An id NO test3 record holds: a counter allocation whose row is removed again.
 * The counter is a high-water mark and stays AT it, so no later allocation of
 * this suite lands there — the id is free until a call-number names it. (No id
 * band: the address is whatever the suite database's counter says is next.)
 */
async function freeId(): Promise<number> {
	const sectionId = await createSectionRecord('test3', -1);
	await sweepRecord(sectionId);
	addressedIds.add(sectionId);
	return sectionId;
}

/**
 * Poll until some backend waits on a lock HELD BY `pid` — identity, not a sleep
 * (import_create_door_native's idiom): `pg_blocking_pids` names the blocker.
 */
async function waitUntilBlockedBy(pid: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const rows = (await sql.unsafe(
			`SELECT count(*)::int AS n FROM pg_stat_activity
			 WHERE wait_event_type = 'Lock' AND $1::int = ANY(pg_blocking_pids(pid))`,
			[String(pid)],
		)) as { n: number }[];
		if ((rows[0]?.n ?? 0) > 0) return true;
		await Bun.sleep(25);
	}
	return false;
}

/** Does a test3 record live at this id? */
async function recordExists(sectionId: number): Promise<boolean> {
	const rows = (await sql.unsafe(
		`SELECT 1 AS found FROM ${TABLE} WHERE section_tipo = 'test3' AND section_id = $1`,
		[sectionId],
	)) as unknown[];
	return rows.length > 0;
}

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
	for (const sectionId of addressedIds) await sweepRecord(sectionId);
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

	test('notices: unmapped variables once, a range end on a single date', async () => {
		const report = await run({ files_data: stage('library.json', exportItems) });
		expect(report.notices.filter((n) => n.includes('Not in the Zotero map'))).toHaveLength(1);
		expect(report.notices.some((n) => n.includes('publisher'))).toBe(true);
		expect(report.notices.some((n) => n.startsWith(`${key('B')}: accessed:`))).toBe(true);
		// Rule 4: no call-number on the items — the key decided, no address was used.
		expect(report.created_at_id).toEqual([]);
		expect(report.updated_at_id).toEqual([]);
		expect(report.refused).toEqual([]);
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

describe('call-number: the operator-chosen record ADDRESS (owner ruling 2026-11-17)', () => {
	/** The record rule 3 creates at its call-number; rules 2, 4 and 5 are judged against it. */
	let createdAt = 0;

	/** One refused item of a report, by its Zotero key. */
	function refusedItem(report: Report, k: string) {
		return report.refused.find((entry) => entry.item === key(k));
	}

	test('rule 1: only a canonical positive int4 is an address — anything else refuses THAT item, naming the value', async () => {
		// PHP cast the value (`(int)'12abc'` = 12, '007' = 7) or skipped the item in
		// silence. Nothing but a whole number written with digits reaches a record.
		const notNumbers: unknown[] = [
			'007',
			'12abc',
			'0',
			'-5',
			'1.0',
			'1e3',
			12.5,
			{ shelf: 1 },
			true,
		];
		const report = await run({
			files_data: stage('cn-bad.json', [
				...notNumbers.map((value, index) => ({
					id: uri(`BAD${index}`),
					'call-number': value,
					title: `${RUN} bad ${index}`,
				})),
				{ id: uri('SIB'), title: `${RUN} sibling` },
			]),
		});
		// The rest of the export is imported.
		expect(report.created).toBe(1);
		expect(await recordsWithCode(key('SIB'))).toHaveLength(1);
		expect(report.errors).toEqual([]);
		expect(report.created_at_id).toEqual([]);
		expect(report.refused).toHaveLength(notNumbers.length);
		for (const [index, value] of notNumbers.entries()) {
			const refused = refusedItem(report, `BAD${index}`);
			expect(refused?.code, String(value)).toBe('request.invalid_data');
			const shown = typeof value === 'string' ? value : JSON.stringify(value);
			expect(refused?.message, String(value)).toContain(`'${shown}'`);
			expect(refused?.message).toContain('call-number');
			expect(await recordsWithCode(key(`BAD${index}`))).toEqual([]);
			expect(await recordsNamed(`${RUN} bad ${index}`)).toEqual([]);
		}
		expect(report.summary).toContain(`${notNumbers.length} refused`);
	});

	test('the section_id limit IS the import limit (owner ruling 2026-11-18): a call-number above 2147483647 refuses THAT item under its own code, and the run WARNS the user — a labelled notice naming the values and the limit', async () => {
		// RED before: such a value was one more "is not a record number" line under
		// request.invalid_data — nothing said it WAS a number, past the limit — and
		// the envelope carried no notice at all.
		const above: unknown[] = ['2147483648', 2147483648, '99999999999999999999999'];
		const { report, notices } = await runEnvelope({
			files_data: stage('cn-limit.json', [
				...above.map((value, index) => ({
					id: uri(`LIM${index}`),
					'call-number': value,
					title: `${RUN} limit ${index}`,
				})),
				// Not a whole number at all: rule 1's own refusal, and no part of the warning.
				{ id: uri('LIMX'), 'call-number': '12abc', title: `${RUN} limit x` },
				{ id: uri('LIMS'), title: `${RUN} limit sibling` },
			]),
		});
		// The rest of the export is imported.
		expect(report.created).toBe(1);
		expect(await recordsWithCode(key('LIMS'))).toHaveLength(1);
		expect(report.created_at_id).toEqual([]);
		expect(report.refused).toHaveLength(above.length + 1);
		for (const [index, value] of above.entries()) {
			const refused = refusedItem(report, `LIM${index}`);
			expect(refused?.code, String(value)).toBe('tool.zotero_call_number_above_limit');
			expect(refused?.message, String(value)).toContain(`'${String(value)}'`);
			expect(refused?.message).toContain(String(INT4_MAX));
			expect(refused?.message).toContain('call-number');
			expect(await recordsWithCode(key(`LIM${index}`))).toEqual([]);
			expect(await recordsNamed(`${RUN} limit ${index}`)).toEqual([]);
		}
		expect(refusedItem(report, 'LIMX')?.code).toBe('request.invalid_data');
		// THE WARNING: one envelope notice for the run, typed and labelled.
		expect(notices).toEqual([
			{
				code: 'tool.zotero_call_number_above_limit',
				label_key: 'error_tool_zotero_call_number_above_limit',
				retryable: false,
				details: {
					count: above.length,
					limit: INT4_MAX,
					values: '2147483648, 2147483648, 99999999999999999999999',
					variable: 'call-number',
				},
			},
		]);
		// …and what the user reads names every value and the limit (the label, filled).
		const text = await noticeText(notices[0] as ApiNotice);
		expect(text).not.toContain('${');
		expect(text).toContain('2147483647');
		expect(text).toContain('99999999999999999999999');
		expect(text).toContain('call-number');
		expect(text).toContain(String(above.length));
	});

	test('a run with nothing to warn about carries NO notice (the warning is not ambient)', async () => {
		const { report, notices } = await runEnvelope({
			files_data: stage('cn-quiet.json', [
				{ id: uri('QT1'), 'call-number': 'shelf 9', title: `${RUN} quiet 1` },
				{ id: uri('QT2'), title: `${RUN} quiet 2` },
			]),
		});
		expect(report.refused.map((entry) => entry.code)).toEqual(['request.invalid_data']);
		expect(report.created).toBe(1);
		expect(notices).toEqual([]);
	});

	test('rule 3: an absent id is CREATED at that id, attributed to the run, and the counter never re-mints it', async () => {
		createdAt = await freeId();
		expect(await recordExists(createdAt)).toBe(false);
		const report = await run({
			files_data: stage('cn-create.json', [
				// Padding is transmission noise, not part of the number.
				{ id: uri('AD1'), 'call-number': ` ${createdAt} `, title: `${RUN} AD1` },
			]),
		});
		expect(report.refused).toEqual([]);
		expect(report.failed).toEqual([]);
		expect(report.created).toBe(1);
		expect(report.updated).toBe(0);
		expect(report.created_at_id).toEqual([createdAt]);
		expect(report.updated_at_id).toEqual([]);
		expect(await recordsWithCode(key('AD1'))).toEqual([createdAt]);
		expect((await itemsOf(createdAt, 'string', 'test52')).map((i) => i.value)).toEqual([
			`${RUN} AD1`,
		]);
		// The call-number is not an unmapped variable, and no component holds it.
		expect(report.notices.filter((n) => n.includes('call-number'))).toEqual([]);
		const tm = (await sql.unsafe(
			`SELECT DISTINCT bulk_process_id FROM matrix_time_machine WHERE section_tipo = 'test3' AND section_id = $1`,
			[createdAt],
		)) as { bulk_process_id: number | null }[];
		expect(tm.map((row) => row.bulk_process_id)).toEqual([report.bulk_process_id]);
		// The counter stands at or above the chosen id: the next allocation is beyond it.
		const next = await createSectionRecord('test3', -1);
		addressedIds.add(next);
		expect(next).toBeGreaterThan(createdAt);
	});

	test('rule 2 + ruling (c): an existing record with NO key ADOPTS the key and is reported TAKEN OVER — its own list and count, never "updated" (a JSON-number call-number too)', async () => {
		const existing = await createSectionRecord('test3', -1);
		addressedIds.add(existing);
		expect(await itemsOf(existing, 'string', 'test162')).toEqual([]);
		const report = await run({
			files_data: stage('cn-adopt.json', [
				{ id: uri('AD2'), 'call-number': existing, title: `${RUN} AD2` },
			]),
		});
		expect(report.refused).toEqual([]);
		expect(report.failed).toEqual([]);
		// Adopted as ruled: the record holds the item's key and its values.
		expect(await recordsWithCode(key('AD2'))).toEqual([existing]);
		expect((await itemsOf(existing, 'string', 'test52')).map((i) => i.value)).toEqual([
			`${RUN} AD2`,
		]);
		// …and REPORTED APART (RED before ruling c: it was one more `updated_at_id`).
		expect(report.taken_over_at_id).toEqual([existing]);
		expect(report.updated_at_id).toEqual([]);
		expect(report.created_at_id).toEqual([]);
		expect({
			created: report.created,
			updated: report.updated,
			taken_over: report.taken_over,
		}).toEqual({ created: 0, updated: 0, taken_over: 1 });
		expect(report.summary).toBe('Zotero import done. Created 0, updated 0, 1 taken over.');

		// The SAME reference again: the record holds its key now — a plain update.
		const again = await run({
			files_data: stage('cn-adopt-again.json', [
				{ id: uri('AD2'), 'call-number': existing, title: `${RUN} AD2 again` },
			]),
		});
		expect(again.taken_over_at_id).toEqual([]);
		expect(again.updated_at_id).toEqual([existing]);
		expect({ updated: again.updated, taken_over: again.taken_over }).toEqual({
			updated: 1,
			taken_over: 0,
		});
		expect(again.summary).toBe('Zotero import done. Created 0, updated 1.');
	});

	test('ruling (c): a key-less item on a key-less record takes nothing over — no key is left there, it is an update', async () => {
		const existing = await createSectionRecord('test3', -1);
		addressedIds.add(existing);
		const report = await run({
			files_data: stage('cn-nokey-nokey.json', [
				{ 'call-number': String(existing), title: `${RUN} NN1` },
			]),
		});
		expect(report.refused).toEqual([]);
		expect(report.taken_over_at_id).toEqual([]);
		expect(report.updated_at_id).toEqual([existing]);
		expect(report.taken_over).toBe(0);
		expect(await itemsOf(existing, 'string', 'test162')).toEqual([]);
		expect((await itemsOf(existing, 'string', 'test52')).map((i) => i.value)).toEqual([
			`${RUN} NN1`,
		]);
	});

	test('ruling (c): a taken-over record whose write ROLLS BACK is not listed taken over (the finding counts only for what was committed)', () => {
		const item = (who: string, found?: 'keyless_record' | 'item_without_key') =>
			({ who, address: 50, mapped: { code: who }, found: found ?? null }) as never;
		const ledger = refusalLedger();
		const outcome = addressOutcome(
			[item('ROLLED', 'keyless_record'), item('TAKEN', 'keyless_record'), item('SAME')],
			{
				records: [
					{ index: 0, sectionId: null, created: false },
					{ index: 1, sectionId: 51, created: false },
					{ index: 2, sectionId: 52, created: false },
				],
				failed: [],
			},
			{ variable: 'call-number', idTarget: undefined },
			ledger,
		);
		expect(outcome).toEqual({ createdAtId: [], updatedAtId: [52], takenOverAtId: [51] });
		expect(ledger.refused).toEqual([]);
	});

	test('ruling (c): a key-less record whose KEY FIELD was not written (a failed line on the key component) took nothing over — updated; a failed line on another field, or on another record, changes nothing', () => {
		const item = (who: string) =>
			({ who, address: 50, mapped: { code: who }, found: 'keyless_record' }) as never;
		const line = (section_id: number, component_tipo: string) => ({
			section_id,
			component_tipo,
			data: '',
			msg: 'IGNORED',
		});
		const outcome = addressOutcome(
			[item('NOKEY'), item('OTHERFIELD'), item('CLEAN')],
			{
				records: [
					{ index: 0, sectionId: 61, created: false },
					{ index: 1, sectionId: 62, created: false },
					{ index: 2, sectionId: 63, created: false },
				],
				// 61: its key field failed. 62: another field failed. 999: not of this run's addresses.
				failed: [line(61, 'test162'), line(62, 'test52'), line(999, 'test162')],
			},
			{ variable: 'call-number', idTarget: { componentTipo: 'test162' } as never },
			refusalLedger(),
		);
		expect(outcome).toEqual({ createdAtId: [], updatedAtId: [61], takenOverAtId: [62, 63] });
	});

	test('ruling (d): an item with NO Zotero key whose call-number names a record that HOLDS one is refused under its own code, with the explanation — why, and what to do — in its line and in a labelled notice; the record number only, the record untouched', async () => {
		const codeBefore = await itemsOf(createdAt, 'string', 'test162');
		const titleBefore = await itemsOf(createdAt, 'string', 'test52');
		expect(codeBefore.map((i) => i.value)).toEqual([key('AD1')]);
		const { report, notices } = await runEnvelope({
			files_data: stage('cn-nokey-keyed.json', [
				// No `id`: Zotero exported the item without its key.
				{ 'call-number': String(createdAt), title: `${RUN} NOKEY` },
				{ id: uri('NK9'), title: `${RUN} NK9` },
			]),
		});
		// Still refused, as ruled; the rest of the export is imported.
		expect(report.created).toBe(1);
		expect(report.updated).toBe(0);
		expect(report.updated_at_id).toEqual([]);
		expect(report.taken_over_at_id).toEqual([]);
		expect(report.failed).toEqual([]);
		expect(report.refused).toHaveLength(1);
		const refused = report.refused[0];
		expect(refused?.item).toBe('item #1');
		// Its OWN code (RED before ruling d: the generic `resource.conflict`).
		expect(refused?.code).toBe('tool.zotero_item_without_key');
		// WHY…
		expect(refused?.message).toContain(`call-number '${createdAt}' names record ${createdAt}`);
		expect(refused?.message).toContain('already belongs to a Zotero reference');
		expect(refused?.message).toContain('this item carries no Zotero key');
		expect(refused?.message).toContain('cannot tell whether it is the same reference');
		// …and WHAT TO DO: both ways out.
		expect(refused?.message).toContain('Export the reference from Zotero again');
		expect(refused?.message).toContain('remove its call-number to create a new record');
		// The record number only — never the key it holds, nor its title.
		expect(refused?.message).not.toContain(key('AD1'));
		expect(refused?.message).not.toContain(String(titleBefore[0]?.value));

		// The notice: coded, labelled, the user's language.
		expect(notices).toEqual([
			{
				code: 'tool.zotero_item_without_key',
				label_key: 'error_tool_zotero_item_without_key',
				retryable: false,
				details: { count: 1, section_ids: String(createdAt), variable: 'call-number' },
			},
		]);
		const text = await noticeText(notices[0] as ApiNotice);
		expect(text).toContain('1 reference(s) without a Zotero key');
		expect(text).toContain(`section_id ${createdAt}`);
		expect(text).toContain('cannot tell whether it is the same reference');
		expect(text).toContain('Export the reference from Zotero again');
		expect(text).toContain('remove its call-number to create a new record');
		expect(text).not.toContain('${');
		expect(text).not.toContain(key('AD1'));
		// Translated where the sibling warnings are.
		for (const lang of ['lg-spa', 'lg-cat']) {
			const translated = (await getLabels(lang)).error_tool_zotero_item_without_key ?? '';
			expect(translated).not.toBe((await getLabels('lg-eng')).error_tool_zotero_item_without_key);
			for (const name of ['count', 'section_ids', 'variable'])
				expect(translated).toContain(`\${${name}}`);
		}

		// Untouched.
		expect(await itemsOf(createdAt, 'string', 'test162')).toEqual(codeBefore);
		expect(await itemsOf(createdAt, 'string', 'test52')).toEqual(titleBefore);
		expect(await recordsNamed(`${RUN} NOKEY`)).toEqual([]);
	});

	test("ruling (d) is the key-less item's only: an item WITH a key against another key stays `resource.conflict`, and raises no key-less notice", async () => {
		const { report, notices } = await runEnvelope({
			files_data: stage('cn-rekey-notice.json', [
				{ id: uri('AD11'), 'call-number': String(createdAt), title: `${RUN} AD11` },
			]),
		});
		expect(report.refused.map((entry) => entry.code)).toEqual(['resource.conflict']);
		expect(report.refused[0]?.message).not.toContain('carries no Zotero key');
		expect(notices).toEqual([]);
	});

	test('rule 2: a record holding the SAME key is updated at its call-number', async () => {
		const report = await run({
			files_data: stage('cn-same.json', [
				{ id: uri('AD1'), 'call-number': String(createdAt), title: `${RUN} AD1 again` },
			]),
		});
		expect(report.refused).toEqual([]);
		expect(report.updated).toBe(1);
		expect(report.updated_at_id).toEqual([createdAt]);
		expect((await itemsOf(createdAt, 'string', 'test52')).map((i) => i.value)).toEqual([
			`${RUN} AD1 again`,
		]);
	});

	test('rule 2: a record holding a DIFFERENT key refuses the item (resource.conflict) — the record untouched, the rest imported', async () => {
		const codeBefore = await itemsOf(createdAt, 'string', 'test162');
		const titleBefore = await itemsOf(createdAt, 'string', 'test52');
		const report = await run({
			files_data: stage('cn-rekey.json', [
				{ id: uri('AD9'), 'call-number': String(createdAt), title: `${RUN} AD9` },
				{ id: uri('AD10'), title: `${RUN} AD10` },
			]),
		});
		expect(report.created).toBe(1);
		expect(report.updated).toBe(0);
		expect(report.updated_at_id).toEqual([]);
		expect(report.refused).toHaveLength(1);
		const refused = refusedItem(report, 'AD9');
		expect(refused?.code).toBe('resource.conflict');
		expect(refused?.message).toContain(`'${createdAt}'`);
		expect(refused?.message).toContain('Zotero key');
		// Refused ONCE: the item is not also a `failed` line.
		expect(report.failed).toEqual([]);
		expect(await itemsOf(createdAt, 'string', 'test162')).toEqual(codeBefore);
		expect(await itemsOf(createdAt, 'string', 'test52')).toEqual(titleBefore);
		expect(await recordsWithCode(key('AD9'))).toEqual([]);
		expect(await recordsWithCode(key('AD10'))).toHaveLength(1);
	});

	test('rule 4: no call-number on the item — the Zotero key finds the record created at an id', async () => {
		const report = await run({
			files_data: stage('cn-bykey.json', [{ id: uri('AD1'), title: `${RUN} AD1 by key` }]),
		});
		expect(report.created).toBe(0);
		expect(report.updated).toBe(1);
		expect(report.created_at_id).toEqual([]);
		expect(report.updated_at_id).toEqual([]);
		expect((await itemsOf(createdAt, 'string', 'test52')).map((i) => i.value)).toEqual([
			`${RUN} AD1 by key`,
		]);
	});

	test('rule 5: the key names record A and the call-number names B — refused (resource.conflict), A untouched, B not created', async () => {
		const other = await freeId();
		const titleBefore = await itemsOf(createdAt, 'string', 'test52');
		const report = await run({
			files_data: stage('cn-disagree.json', [
				{ id: uri('AD1'), 'call-number': String(other), title: `${RUN} disagree` },
			]),
		});
		expect(report.created + report.updated).toBe(0);
		expect(report.refused).toHaveLength(1);
		const refused = refusedItem(report, 'AD1');
		expect(refused?.code).toBe('resource.conflict');
		expect(refused?.message).toContain(`'${other}'`);
		expect(refused?.message).toContain(`record ${createdAt}`);
		expect(await recordExists(other)).toBe(false);
		expect(await itemsOf(createdAt, 'string', 'test52')).toEqual(titleBefore);
		expect(await recordsNamed(`${RUN} disagree`)).toEqual([]);
	});

	test('rule 3: an id absent because its record was DELETED is created again at that id', async () => {
		const sectionId = await freeId();
		const item = { id: uri('DL1'), 'call-number': String(sectionId), title: `${RUN} DL1` };
		const first = await run({ files_data: stage('cn-del1.json', [item]) });
		expect(first.created_at_id).toEqual([sectionId]);
		const deleted = await deleteSectionRecord('test3', sectionId, -1);
		expect(deleted.removed).toBe(true);
		expect(await recordExists(sectionId)).toBe(false);
		// The re-import after a detected error: the same address, no refusal.
		const again = await run({ files_data: stage('cn-del2.json', [item]) });
		expect(again.refused).toEqual([]);
		expect(again.failed).toEqual([]);
		expect(again.created).toBe(1);
		expect(again.created_at_id).toEqual([sectionId]);
		expect(await recordsWithCode(key('DL1'))).toEqual([sectionId]);
		expect((await itemsOf(sectionId, 'string', 'test52')).map((i) => i.value)).toEqual([
			`${RUN} DL1`,
		]);
	});

	test('one call-number on two items of one run: the SECOND is refused, the first is written at the id', async () => {
		const sectionId = await freeId();
		const report = await run({
			files_data: stage('cn-twice.json', [
				{ id: uri('BT1'), 'call-number': String(sectionId), title: `${RUN} BT1` },
				{ id: uri('BT2'), 'call-number': String(sectionId), title: `${RUN} BT2` },
			]),
		});
		expect(report.created).toBe(1);
		expect(report.created_at_id).toEqual([sectionId]);
		expect(report.refused).toHaveLength(1);
		expect(refusedItem(report, 'BT2')?.code).toBe('request.invalid_data');
		expect(refusedItem(report, 'BT2')?.message).toContain(`'${sectionId}'`);
		expect(await recordsWithCode(key('BT1'))).toEqual([sectionId]);
		expect(await recordsWithCode(key('BT2'))).toEqual([]);
	});

	/** The id the NEXT counter allocation of test3 would take, when the counter stands at `base`. */
	async function nextAllocationAfter(base: number): Promise<number> {
		const rows = (await sql.unsafe(`SELECT value FROM matrix_counter WHERE tipo = 'test3'`)) as {
			value: number;
		}[];
		// The situation is the one the gates below claim: the counter stands AT `base`.
		expect(rows.map((row) => Number(row.value))).toEqual([base]);
		return base + 1;
	}

	test("the run's OWN allocations never take an address the export names: the item is created AT its call-number, the key-less sibling elsewhere", async () => {
		// The counter stands at `base`: the first item — no call-number — would be
		// born at base + 1, the very id the second item names. Written in file order
		// (RED before the addressed-first order) the second item found "a record
		// there": a keyed sibling refused it, a key-less one was ADOPTED — two
		// references merged into one record, reported as an update.
		const named = await nextAllocationAfter(await freeId());
		addressedIds.add(named);
		const report = await run({
			files_data: stage('cn-own.json', [
				// No `id`: the item has no Zotero key, so it leaves no key on its record.
				{ title: `${RUN} NK1` },
				{ id: uri('NK2'), 'call-number': String(named), title: `${RUN} NK2` },
			]),
		});
		expect(report.refused).toEqual([]);
		expect(report.failed).toEqual([]);
		expect({ created: report.created, updated: report.updated }).toEqual({
			created: 2,
			updated: 0,
		});
		expect(report.created_at_id).toEqual([named]);
		expect(report.updated_at_id).toEqual([]);
		// Two references, two records: the addressed one AT its id, alone there.
		expect(await recordsWithCode(key('NK2'))).toEqual([named]);
		expect((await itemsOf(named, 'string', 'test52')).map((i) => i.value)).toEqual([`${RUN} NK2`]);
		const sibling = await recordsNamed(`${RUN} NK1`);
		expect(sibling).toHaveLength(1);
		expect(sibling[0]).toBeGreaterThan(named);
		expect(await itemsOf(sibling[0] as number, 'string', 'test162')).toEqual([]);
	});

	test("the run's OWN allocations never take an address the export names: a KEYED sibling first in the file does not refuse it (rule 3)", async () => {
		const named = await nextAllocationAfter(await freeId());
		addressedIds.add(named);
		const report = await run({
			files_data: stage('cn-own-keyed.json', [
				{ id: uri('RC1'), title: `${RUN} RC1` },
				{ id: uri('RC2'), 'call-number': String(named), title: `${RUN} RC2` },
			]),
		});
		expect(report.refused).toEqual([]);
		expect(report.created).toBe(2);
		expect(report.created_at_id).toEqual([named]);
		expect(await recordsWithCode(key('RC2'))).toEqual([named]);
		const [first] = await recordsWithCode(key('RC1'));
		expect(first).toBeGreaterThan(named);
	});

	test("the run's OWN allocations never take an address the export names: a record a LINK creates in the same section (the Series) lands beyond every call-number", async () => {
		// This configuration links the Series INTO test3 — the section imported
		// into — so the Series record takes test3's next counter id. With the
		// addressed items written in file order the first one's Series was born at
		// the second one's call-number, and the second item ADOPTED the Series
		// record (it holds no key). Written highest address first, the counter
		// stands past every call-number before anything else is allocated.
		const base = await freeId();
		const low = await nextAllocationAfter(base);
		const high = low + 1;
		addressedIds.add(low);
		addressedIds.add(high);
		const series = `${RUN} Own Series`;
		const report = await run({
			files_data: stage('cn-own-link.json', [
				{
					id: uri('LK1'),
					'call-number': String(low),
					title: `${RUN} LK1`,
					'container-title': series,
				},
				{ id: uri('LK2'), 'call-number': String(high), title: `${RUN} LK2` },
			]),
		});
		expect(report.refused).toEqual([]);
		expect(report.failed).toEqual([]);
		// In FILE order, whatever order they were written in.
		expect(report.created_at_id).toEqual([low, high]);
		expect(report.updated_at_id).toEqual([]);
		expect(await recordsWithCode(key('LK2'))).toEqual([high]);
		expect((await itemsOf(high, 'string', 'test52')).map((i) => i.value)).toEqual([`${RUN} LK2`]);
		// The Series is its own record, beyond both call-numbers, linked from LK1.
		const named = await recordsNamed(series);
		expect(named).toHaveLength(1);
		expect(named[0]).toBeGreaterThan(high);
		expect((await itemsOf(low, 'relation', 'test80')).map((l) => l.section_id)).toEqual(named);
	});

	test('the report keeps the FILE order whatever the write order: failed lines and the per-item outcome', async () => {
		const named = await nextAllocationAfter(await freeId());
		addressedIds.add(named);
		const report = await run({
			files_data: stage('cn-order.json', [
				// An unknown CSL type is a `failed` line on each record; the first item
				// of the file carries no call-number, so it is WRITTEN last.
				{ id: uri('OR1'), title: `${RUN} OR1`, type: 'no-such-type' },
				{ id: uri('OR2'), 'call-number': String(named), title: `${RUN} OR2`, type: 'nor-this' },
			]),
		});
		expect(report.created_at_id).toEqual([named]);
		const [first] = await recordsWithCode(key('OR1'));
		expect(report.failed.map((line) => line.section_id)).toEqual([first as number, named]);
	});

	test('an id TAKEN by another writer after the run looked (its create commits while the item waits on it) is judged when it is written: its key differs → refused', async () => {
		const sectionId = await freeId();
		let releaseCreator: () => void = () => {};
		const creatorHold = new Promise<void>((resolveHold) => {
			releaseCreator = resolveHold;
		});
		let creatorWrote: () => void = () => {};
		const written = new Promise<void>((resolveWritten) => {
			creatorWrote = resolveWritten;
		});
		let creatorPid = 0;
		// Another writer's record AT the id, keyed, written but NOT committed when the
		// import starts: the key lookup and the existence read both miss it.
		const creator = withTransaction(async () => {
			const pidRows = (await sql.unsafe('SELECT pg_backend_pid() AS pid')) as { pid: number }[];
			creatorPid = Number(pidRows[0]?.pid ?? 0);
			await createSectionRecord('test3', -1, new Date(), sectionId);
			const saved = await saveComponentData({
				componentTipo: 'test162',
				sectionTipo: 'test3',
				sectionId,
				lang: 'lg-nolan',
				changedData: [{ action: 'set_data', id: null, value: [{ value: `${RUN}-other-writer` }] }],
				userId: -1,
			});
			expect(saved.ok).toBe(true);
			creatorWrote();
			await creatorHold;
		});
		await written;
		expect(creatorPid).toBeGreaterThan(0);
		const importing = run({
			files_data: stage('cn-race.json', [
				{ id: uri('RA1'), 'call-number': String(sectionId), title: `${RUN} RA1` },
			]),
		});
		// Identity, not a sleep: the import really waits on the uncommitted create.
		const blocked = await waitUntilBlockedBy(creatorPid, 15_000);
		releaseCreator();
		await creator;
		const report = await importing;
		expect(blocked).toBe(true);
		expect(report.created + report.updated).toBe(0);
		expect(report.created_at_id).toEqual([]);
		expect(refusedItem(report, 'RA1')?.code).toBe('resource.conflict');
		expect(await recordsWithCode(key('RA1'))).toEqual([]);
		expect(await recordsWithCode(`${RUN}-other-writer`)).toEqual([sectionId]);
		expect(await itemsOf(sectionId, 'string', 'test52')).toEqual([]);
	});

	test("rule 7: a record the importer may NOT change — at the call-number, or holding the item's key — is a REFUSED item (the record door's code), never listed updated; its line names the record and nothing it holds, and the run's alert names it too", () => {
		// The executor's half is gated on real identities in import_create_door_native
		// (1c: out of scope → `refusal: perm.out_of_scope`, the guard never asked; the
		// unscoped match). This is the door's half: how that outcome reaches the report.
		const item = (who: string, address: number | null): AddressedItem => ({
			who,
			address,
			found: null,
			mapped: { code: who, url: null, address: null, fields: [], links: [] } as never,
		});
		const ledger = refusalLedger();
		const denied = (sectionId: number) => ({
			code: 'perm.out_of_scope' as const,
			message: `record ${sectionId} exists and is not writable`,
			sectionId,
		});
		const outcome = addressOutcome(
			[item('FOREIGN', 41), item('MINE', 42), item('BYKEY', null), item('PLAIN', null)],
			{
				records: [
					{ index: 0, sectionId: null, created: false, refusal: denied(41) },
					{ index: 1, sectionId: 42, created: false },
					// No call-number: the item's KEY is held by record 7, not hers.
					{ index: 2, sectionId: null, created: false, refusal: denied(7) },
					{ index: 3, sectionId: 43, created: true },
				],
				failed: [],
			},
			{ variable: 'call-number', idTarget: undefined },
			ledger,
		);
		expect(outcome).toEqual({ createdAtId: [], updatedAtId: [42], takenOverAtId: [] });
		expect(ledger.refused).toEqual([
			{
				item: 'FOREIGN',
				code: 'perm.out_of_scope',
				message: expect.stringContaining(
					"call-number '41' names record 41, which you may not change",
				),
			},
			{
				item: 'BYKEY',
				code: 'perm.out_of_scope',
				message: expect.stringContaining(
					"this item's Zotero key is held by record 7, which you may not change",
				),
			},
		]);
		expect(ledger.refused[0]?.message).not.toContain('Zotero key');
		// The alert: both references, the records ascending — ids only.
		expect(refusalNotices(ledger, 'call-number')).toEqual([
			{
				code: 'tool.zotero_record_not_writable',
				label_key: 'error_tool_zotero_record_not_writable',
				retryable: false,
				details: { count: 2, section_ids: '7, 41' },
			},
		]);
	});

	test('the limit is int4, exactly: 2147483647 is an address, 2147483648 is refused past it; a notice lists at most twenty values, each cut', () => {
		// Pure (no record is ever created AT the limit here: the counter would follow it).
		const mapped = (address: string) =>
			({
				code: `K${address.length}-${address.slice(0, 12)}`,
				address,
				fields: [],
				links: [],
			}) as never;
		const atLimit = refusalLedger();
		const kept = screenAddresses([mapped(String(INT4_MAX))], 'call-number', atLimit);
		expect(kept.map((item) => item.address)).toEqual([INT4_MAX]);
		expect(atLimit).toEqual({ refused: [], aboveLimit: [], notWritable: [], withoutKey: [] });
		expect(refusalNotices(atLimit, 'call-number')).toEqual([]);

		const past = refusalLedger();
		const huge = '9'.repeat(200);
		const many = Array.from({ length: 25 }, (_unused, index) => String(INT4_MAX + 1 + index));
		expect(screenAddresses([huge, ...many].map(mapped), 'call-number', past)).toEqual([]);
		expect(past.refused.map((entry) => entry.code)).toEqual(
			Array.from({ length: 26 }, () => 'tool.zotero_call_number_above_limit'),
		);
		const [notice] = refusalNotices(past, 'call-number');
		expect(notice?.details?.count).toBe(26);
		expect(notice?.details?.limit).toBe(2147483647);
		const values = String(notice?.details?.values).split(', ');
		// Twenty values and the ellipsis; the 200-digit one cut at 80 characters.
		expect(values).toHaveLength(21);
		expect(values[0]).toBe(`${'9'.repeat(80)}…`);
		expect(values[1]).toBe('2147483648');
		expect(values.at(-1)).toBe('…');
	});

	test('rule 7: one run reports created-at-id, updated, taken over and refused SEPARATELY', async () => {
		const fresh = await freeId();
		const keyless = await createSectionRecord('test3', -1);
		addressedIds.add(keyless);
		const report = await run({
			files_data: stage('cn-report.json', [
				{ id: uri('RP1'), 'call-number': String(fresh), title: `${RUN} RP1` },
				{ id: uri('AD1'), 'call-number': String(createdAt), title: `${RUN} AD1 report` },
				{ id: uri('RP3'), 'call-number': 'shelf 3', title: `${RUN} RP3` },
				{ id: uri('RP4'), title: `${RUN} RP4` },
				{ id: uri('RP5'), 'call-number': String(keyless), title: `${RUN} RP5` },
			]),
		});
		expect(report.created).toBe(2);
		expect(report.updated).toBe(1);
		expect(report.taken_over).toBe(1);
		expect(report.created_at_id).toEqual([fresh]);
		expect(report.updated_at_id).toEqual([createdAt]);
		expect(report.taken_over_at_id).toEqual([keyless]);
		expect(report.refused.map((entry) => entry.item)).toEqual([key('RP3')]);
		expect(report.summary).toBe(
			'Zotero import done. Created 2, updated 1, 1 taken over, 1 refused.',
		);
	});
});

describe('the Zotero key is checked in the WHOLE section; a record the importer may not change is NAMED (owner ruling 2026-11-18)', () => {
	let ids: AuthzIdentities;
	let control: Importer;
	/** A keyed record of project Q — outside CONTROL's scope (she holds project P). */
	let foreign = 0;
	const FOREIGN_TITLE = `${RUN} foreign title`;

	/** One refused item of a report, by its Zotero key. */
	function refusedItem(report: Report, k: string) {
		return report.refused.find((entry) => entry.item === key(k));
	}

	const code = (value: string) => ({ tipo: 'test162', lang: 'lg-nolan', value: [{ value }] });
	const title = (value: string) => ({ tipo: 'test52', lang: 'lg-nolan', value: [{ value }] });
	const titlesOf = async (sectionId: number) =>
		(await itemsOf(sectionId, 'string', 'test52')).map((item) => item.value);

	beforeAll(async () => {
		await installAuthzDoorFixture();
		ids = await resolveAuthzIdentities();
		await assertAuthzDoorContrast(ids);
		control = { principal: ids.control, userId: AUTHZ_CONTROL_USER_ID };
		foreign = await createDoorRecord('test3', AUTHZ_PROJECT_Q, [
			code(key('GK1')),
			title(FOREIGN_TITLE),
		]);
	});

	afterAll(async () => {
		rmSync(stagingRootOf(AUTHZ_CONTROL_USER_ID), { recursive: true, force: true });
		rmSync(stagingRootOf(AUTHZ_TEXT_ONLY_USER_ID), { recursive: true, force: true });
		await removeAuthzDoorFixture();
	});

	test('the fixture is what the gate needs: CONTROL is no admin, and the keyed record is one she may not see', async () => {
		expect(ids.control.isGlobalAdmin).toBe(false);
		expect(await recordsWithCode(key('GK1'))).toEqual([foreign]);
	});

	test("rule 5 sees a key held OUTSIDE the importer's scope: the call-number names B, the key lives on A (not hers) — refused (resource.conflict), B not written, the key on ONE record", async () => {
		// RED before: the key lookup was the importer's (project P), so it found no
		// holder — the item was written AT its call-number, the key adopted there,
		// and one Zotero key then lived on two records.
		const mine = await createDoorRecord('test3', AUTHZ_PROJECT_P, [title(`${RUN} mine`)]);
		const { report, notices } = await runEnvelope(
			{
				files_data: stage(
					'gk-conflict.json',
					[{ id: uri('GK1'), 'call-number': String(mine), title: `${RUN} GK1 at mine` }],
					[],
					control.userId,
				),
			},
			control,
		);
		expect(report.created + report.updated).toBe(0);
		expect(report.updated_at_id).toEqual([]);
		expect(report.refused).toHaveLength(1);
		const refused = refusedItem(report, 'GK1');
		expect(refused?.code).toBe('resource.conflict');
		// The alert names the two records by section_id…
		expect(refused?.message).toContain(`'${mine}'`);
		expect(refused?.message).toContain(`record ${foreign}`);
		// …and nothing the foreign record HOLDS.
		expect(JSON.stringify({ report, notices })).not.toContain(FOREIGN_TITLE);
		expect(report.failed).toEqual([]);
		// A conflict is not a permission alert.
		expect(notices).toEqual([]);
		expect(await recordsWithCode(key('GK1'))).toEqual([foreign]);
		expect(await itemsOf(mine, 'string', 'test162')).toEqual([]);
		expect(await titlesOf(mine)).toEqual([`${RUN} mine`]);
		expect(await titlesOf(foreign)).toEqual([FOREIGN_TITLE]);
		expect(await recordsNamed(`${RUN} GK1 at mine`)).toEqual([]);
	});

	test('no call-number: the key is held by a record she may not change — the ITEM is refused (perm.out_of_scope) and the user is ALERTED naming that record; no second record takes the key', async () => {
		// RED before: the scoped lookup found no holder, so the item was CREATED — a
		// second record with the same Zotero key.
		const { report, notices } = await runEnvelope(
			{
				files_data: stage(
					'gk-bykey.json',
					[{ id: uri('GK1'), title: `${RUN} GK1 by key` }],
					[],
					control.userId,
				),
			},
			control,
		);
		expect({ created: report.created, updated: report.updated }).toEqual({
			created: 0,
			updated: 0,
		});
		expect(report.refused).toEqual([
			{
				item: key('GK1'),
				code: 'perm.out_of_scope',
				message: expect.stringContaining(`record ${foreign}, which you may not change`),
			},
		]);
		// Refused ONCE, as the item: never "updated" with every field ignored.
		expect(report.failed).toEqual([]);
		expect(notices).toEqual([
			{
				code: 'tool.zotero_record_not_writable',
				label_key: 'error_tool_zotero_record_not_writable',
				retryable: false,
				details: { count: 1, section_ids: String(foreign) },
			},
		]);
		const text = await noticeText(notices[0] as ApiNotice);
		expect(text).not.toContain('${');
		expect(text).toContain(String(foreign));
		expect(JSON.stringify({ report, notices })).not.toContain(FOREIGN_TITLE);
		expect(await recordsWithCode(key('GK1'))).toEqual([foreign]);
		expect(await recordsNamed(`${RUN} GK1 by key`)).toEqual([]);
		expect(await titlesOf(foreign)).toEqual([FOREIGN_TITLE]);
	});

	test('a call-number naming a record she may not change: refused (perm.out_of_scope) and ALERTED naming the record — its key never read, nothing written', async () => {
		// RED before: the refused line was there, the alert was not.
		const keyless = await createDoorRecord('test3', AUTHZ_PROJECT_Q, [
			title(`${RUN} keyless foreign`),
		]);
		const { report, notices } = await runEnvelope(
			{
				files_data: stage(
					'gk-address.json',
					[
						{ id: uri('GK2'), 'call-number': String(keyless), title: `${RUN} GK2` },
						// The same run, a second record she may not change: ONE alert names both.
						{ id: uri('GK3'), 'call-number': String(foreign), title: `${RUN} GK3` },
					],
					[],
					control.userId,
				),
			},
			control,
		);
		expect(report.created + report.updated).toBe(0);
		expect(report.updated_at_id).toEqual([]);
		expect(report.refused).toEqual([
			{
				item: key('GK2'),
				code: 'perm.out_of_scope',
				message: expect.stringContaining(
					`call-number '${keyless}' names record ${keyless}, which you may not change`,
				),
			},
			{
				item: key('GK3'),
				code: 'perm.out_of_scope',
				message: expect.stringContaining(
					`call-number '${foreign}' names record ${foreign}, which you may not change`,
				),
			},
		]);
		// The line says nothing of what either record holds — not even whether it has a key.
		for (const entry of report.refused) expect(entry.message).not.toContain('Zotero key');
		expect(notices).toEqual([
			{
				code: 'tool.zotero_record_not_writable',
				label_key: 'error_tool_zotero_record_not_writable',
				retryable: false,
				details: { count: 2, section_ids: [keyless, foreign].sort((a, b) => a - b).join(', ') },
			},
		]);
		expect(await recordsWithCode(key('GK2'))).toEqual([]);
		expect(await recordsWithCode(key('GK3'))).toEqual([]);
		expect(await titlesOf(keyless)).toEqual([`${RUN} keyless foreign`]);
		expect(await itemsOf(keyless, 'string', 'test162')).toEqual([]);
	});

	test('ruling (c), HOLDS is what was written: an importer who may write the record but NOT the key component leaves no key there — the record is listed UPDATED with the key field failed, never taken over', async () => {
		// RED before (dc35ce349f): the guard's finding alone decided, so the record
		// was listed `taken_over_at_id` — "holds the reference's key from now on" —
		// while its key field was a `failed` line and the record held no key.
		// TEXT_ONLY: test3 at 2, the text area (test17, the ISBN) at 2, the key
		// component (test162) not granted — project P, as the record.
		const textOnly = { principal: ids.textOnly, userId: AUTHZ_TEXT_ONLY_USER_ID };
		expect(await getPermissions(ids.textOnly, 'test3', 'test3')).toBe(2);
		expect(await getPermissions(ids.textOnly, 'test3', 'test17')).toBe(2);
		expect(await getPermissions(ids.textOnly, 'test3', 'test162')).toBeLessThan(2);
		const mine = await createDoorRecord('test3', AUTHZ_PROJECT_P, [title(`${RUN} TK1 before`)]);
		const { report } = await runEnvelope(
			{
				files_data: stage(
					'tk-nokeywrite.json',
					[{ id: uri('TK1'), 'call-number': String(mine), ISBN: '978-84-0000-001-1' }],
					[],
					textOnly.userId,
				),
			},
			textOnly,
		);
		expect(report.refused).toEqual([]);
		// The record WAS written (the field she may write)…
		expect(JSON.stringify(await itemsOf(mine, 'string', 'test17'))).toContain('978-84-0000-001-1');
		// …the key was NOT: its field is a failed line, and the record holds none.
		expect(
			report.failed.filter((line) => line.component_tipo === 'test162' && line.section_id === mine),
		).toHaveLength(1);
		expect(await itemsOf(mine, 'string', 'test162')).toEqual([]);
		expect(await recordsWithCode(key('TK1'))).toEqual([]);
		// So nothing was taken over: an update, counted as one.
		expect(report.taken_over_at_id).toEqual([]);
		expect(report.updated_at_id).toEqual([mine]);
		expect({
			created: report.created,
			updated: report.updated,
			taken_over: report.taken_over,
		}).toEqual({ created: 0, updated: 1, taken_over: 0 });
		expect(report.summary).not.toContain('taken over');

		// The served twin: CONTROL may write the key — the SAME record is taken over.
		const served = await runEnvelope(
			{
				files_data: stage(
					'tk-keywrite.json',
					[{ id: uri('TK1'), 'call-number': String(mine), title: `${RUN} TK1 after` }],
					[],
					control.userId,
				),
			},
			control,
		);
		expect(served.report.failed).toEqual([]);
		expect(served.report.taken_over_at_id).toEqual([mine]);
		expect(served.report.updated_at_id).toEqual([]);
		expect(await recordsWithCode(key('TK1'))).toEqual([mine]);
	});

	test('the served twins: a key held by a record IN her scope is updated; a global admin updates the record of ANY project — no refusal, no alert', async () => {
		const mine = await createDoorRecord('test3', AUTHZ_PROJECT_P, [
			code(key('GK4')),
			title(`${RUN} GK4 before`),
		]);
		const served = await runEnvelope(
			{
				files_data: stage(
					'gk-served.json',
					[{ id: uri('GK4'), title: `${RUN} GK4 after` }],
					[],
					control.userId,
				),
			},
			control,
		);
		expect(served.report.refused).toEqual([]);
		expect(served.report.failed).toEqual([]);
		expect({ created: served.report.created, updated: served.report.updated }).toEqual({
			created: 0,
			updated: 1,
		});
		expect(served.notices).toEqual([]);
		expect(await recordsNamed(`${RUN} GK4 after`)).toEqual([mine]);
		// The admin (root): the same global lookup, and the record door admits them.
		const admin = await runEnvelope({
			files_data: stage('gk-admin.json', [{ id: uri('GK1'), title: `${RUN} GK1 by admin` }]),
		});
		expect(admin.report.refused).toEqual([]);
		expect({ created: admin.report.created, updated: admin.report.updated }).toEqual({
			created: 0,
			updated: 1,
		});
		expect(admin.notices).toEqual([]);
		expect(await recordsNamed(`${RUN} GK1 by admin`)).toEqual([foreign]);
		expect(await recordsWithCode(key('GK1'))).toEqual([foreign]);
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

	test("field_to_section_id naming 'id' refuses the run: the Zotero key is looked up, never a record number", async () => {
		await installScratchToolConfig('tool_import_zotero', {
			...SERVER_CONFIG,
			main: SERVER_CONFIG.main.map((entry) =>
				entry.name === 'field_to_section_id' ? { ...entry, value: 'id' } : entry,
			),
		});
		try {
			const files = stage('cn-id.json', [{ id: uri('IN3'), title: `${RUN} N3` }]);
			const refusal = await refusalOf(runRaw({ files_data: files }));
			expect(refusal.code).toBe('request.invalid_options');
			expect(refusal.publicMessage).toContain('field_to_section_id');
			expect(await recordsWithCode(key('IN3'))).toEqual([]);
		} finally {
			teardownConfig = await installScratchToolConfig('tool_import_zotero', SERVER_CONFIG);
		}
	});

	test('a call-number the map ALSO binds to a component is written there as text, and is still the address', async () => {
		// test166 (input_text): the map may store the call-number; nothing requires it.
		await installScratchToolConfig('tool_import_zotero', {
			...SERVER_CONFIG,
			map: [
				...SERVER_CONFIG.map.filter((entry) => entry.name !== 'author'),
				{ name: 'call-number', ddo_map: [{ tipo: 'test166', section_tipo: 'test3' }] },
			],
		});
		try {
			const sectionId = await freeId();
			const report = await run({
				files_data: stage('cn-bound.json', [
					{ id: uri('BND'), 'call-number': String(sectionId), title: `${RUN} bound` },
				]),
			});
			expect(report.created_at_id).toEqual([sectionId]);
			expect((await itemsOf(sectionId, 'string', 'test166')).map((i) => i.value)).toEqual([
				String(sectionId),
			]);
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

describe('the SHIPPED default (register dd1633 ≡ sample_config.json)', () => {
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

	test('every component the shipped map names IS a component of the suite ontology — RED before 3f043906b8: call-number → dd176, a label', async () => {
		const { register } = shippedConfigs();
		const cfg = readZoteroConfig(register);
		// The key's component is in the imported section (named by the config, not by this gate —
		// the generic-TLD law: the shipped default's install tipos are read, never spelled here).
		expect(cfg.idTarget).toBeDefined();
		expect(cfg.idTarget?.sectionTipo).toBe(cfg.mainSectionTipo);
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
	});

	test("rule 6: the shipped default names 'call-number' as the record ADDRESS and binds it to NO component", () => {
		const { register, sample } = shippedConfigs();
		for (const shipped of [register, sample]) {
			const cfg = readZoteroConfig(shipped);
			expect(cfg.fieldToSectionId).toBe('call-number');
			// The variable names a Zotero field; no component holds it (the label
			// binding 3f043906b8 removed stays gone).
			expect(cfg.entries.find((entry) => entry.name === 'call-number')).toBeUndefined();
		}
	});

	test('rule 6: the help texts (dd612 every language, dd1362) say a numeric call-number is the section_id', () => {
		const root = resolve(import.meta.dir, '..', '..', 'tools', 'tool_import_zotero');
		const register = JSON.parse(readFileSync(resolve(root, 'register.json'), 'utf8')) as {
			string: Record<string, { lang: string; value: string }[]>;
		};
		const help = mustGet(register.string.dd612, 'dd612');
		expect(help.map((entry) => entry.lang).sort()).toEqual([
			'lg-cat',
			'lg-deu',
			'lg-ell',
			'lg-eng',
			'lg-nep',
			'lg-spa',
		]);
		for (const entry of help) {
			expect(entry.value, entry.lang).toContain("'call-number'");
			expect(entry.value, entry.lang).toContain('section_id');
			// 3f043906b8's identifier wording is gone: the field is no lookup binding.
			expect(entry.value, entry.lang).not.toContain('field_to_section_id');
		}
		const [developer] = mustGet(register.string.dd1362, 'dd1362');
		expect(developer?.value).toContain("'call-number'");
		expect(developer?.value).toContain('section_id of the record');
		expect(developer?.value).toContain('2147483647');
		expect(developer?.value).not.toContain('never a record number');
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
