/**
 * tool_export COVERAGE residue (T1-39 / OX1) — the columns that exported
 * BLANK or RAW after T0-9.
 *
 * Wire: WC-2026-11-12-export-json-geolocation-cells,
 *       WC-2026-11-12-export-text-cell-clean.
 *
 * THE CONTRACT pinned here (every expected cell written out in full):
 *   C1 json         value AND grid_value cell = JSON.stringify of each stored
 *                   item (PHP component_common::get_export_value base:
 *                   json_encode($item), one atom per item); no `unresolved`
 *                   note for the model. Before: no cell + an unresolved note.
 *   C2 geolocation  the same, of the entry AS A LIST ROW SERVES IT
 *                   (geo/entry_siblings.ts servedGeoEntry 'list'): the stored
 *                   `sources` / `legend` (TS-only map definition) never reach a
 *                   value cell; dedalo_raw still carries them (control).
 *   C3 interactive  the request-path flat reader (relation_list.ts
 *                   resolveCellValue) answers the same strings, neither model
 *                   ledgered unresolved.
 *   C4 text_area    PHP export_tabulator::clean_text_value at the tabulator:
 *                   value, grid_value, the preview row and the CSV file show
 *                   `a & b\nc &lt; d` (one-pass entity map); dedalo_raw keeps
 *                   the stored markup (control).
 *   C5 input_text   a plain value passes through unchanged (short-circuit).
 *   C6 ACL models   component_security_access / component_filter_records are
 *                   EXPORTABLE like any component (owner C44 2026-11-13,
 *                   WC-2026-11-13-export-acl-components-exportable; before:
 *                   exempt, no cell, "ACL matrix is not heritage data"): value
 *                   AND grid_value cell = each stored item as JSON (the `json`
 *                   family), under the ORDINARY export column gate — a persona
 *                   without a grant on the column is refused (perm.denied, the
 *                   component ACL every column crosses), granted it exports.
 *                   Own situation (`zzsax`, dropped to zero residue) + the
 *                   export-frontier identity (scoped / admin).
 *
 * THE SITUATION IS BUILT: test3 records created through createSectionRecord
 * (allocated ids) and written through saveComponentData; swept above the run's
 * counter mark in afterAll (records + TM + activity). Export artifacts in a
 * scratch root this file declares (markExportArtifactsRoot), removed after.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeForJsonb } from '../../src/core/db/json_codec.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { resolveCellValue } from '../../src/core/resolve/relation_list.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import { saveComponentData } from '../../src/core/section/record/save_component.ts';
import { type Principal, resolvePrincipal } from '../../src/core/security/permissions.ts';
import {
	runCounterMark,
	sweepRecordsCreatedSince,
} from '../../src/core/test_data/run_created_records.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import type { ToolActionContext, ToolResponse } from '../../src/core/tools/module.ts';
import { clearTermCache } from '../../src/core/ts_object/term_resolver.ts';
import {
	type ArtifactStore,
	openArtifactStore,
} from '../../tools/tool_export/server/artifact_store.ts';
import {
	runBuildExportFile,
	runExportArtifact,
} from '../../tools/tool_export/server/export_job.ts';
import { readExportPreview } from '../../tools/tool_export/server/preview.ts';
import { toolExportGetExportGrid } from '../../tools/tool_export/server/tool_export.ts';
import { DB_READY } from '../helpers/db_ready.ts';
import {
	clearFrontierIdentityCaches,
	exportFrontierIdentity,
	type FrontierGrant,
} from '../helpers/export_frontier_identity.ts';
import { markExportArtifactsRoot } from '../helpers/media_scratch_root.ts';

const SECTION = 'test3';
const JSON_TIPO = 'test18'; // component_json (misc, monovalue, not translatable)
const GEO = 'test100'; // component_geolocation (geo, monovalue, not translatable)
const TEXT_AREA = 'test17'; // component_text_area (translatable)
const INPUT = 'test52'; // component_input_text (translatable)
const LANG = 'lg-eng';
const USER_ID = -1;
const ROOT: Principal = { userId: USER_ID, isGlobalAdmin: true, isDeveloper: true };

// the stored strings hold what the text cleanup rewrites (`</p><p>`, entities, a
// `/`): a JSON cell must survive it byte-for-byte as JSON (T1-39 review)
const JSON_VALUE = {
	a: 'b',
	n: [1, 2],
	html: '<p>a</p><p>b &amp; c</p>',
	quote: 'say &quot;hi&quot;',
	url: 'https://example.org/x',
};
const PNG_URI =
	'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const GEO_ENTRY = {
	lat: 41.38,
	lon: 2.17,
	zoom: 12,
	alt: 16,
	lib_data: [
		{
			type: 'FeatureCollection',
			features: [
				{
					type: 'Feature',
					geometry: { type: 'Point', coordinates: [2.17, 41.38] },
					properties: { popup: '<p>x</p><p>y &quot;z&quot;</p>' },
				},
			],
		},
	],
	sources: [
		{
			type: 'xyz',
			url: 'https://tiles.example.org/{z}/{x}/{y}.png',
			params: { max_zoom: 18 },
			attribution: 'Example Org',
		},
	],
	legend: {
		title: 'Roads',
		groups: [{ name: 'Surface', symbols: [{ label: 'Paved', icon: PNG_URI }] }],
	},
};
const TEXT_STORED = '<p>a &amp; b</p><p>c &amp;lt; d</p>';
const TEXT_CLEAN = 'a & b\nc &lt; d';

let principal!: Principal;
let mark = 0;
let recordId = 0;
const scratchDirs: string[] = [];

async function save(componentTipo: string, lang: string, value: unknown): Promise<void> {
	const outcome = await saveComponentData({
		componentTipo,
		sectionTipo: SECTION,
		sectionId: recordId,
		lang,
		userId: USER_ID,
		principal: ROOT,
		changedData: [{ action: 'update', key: 0, id: null, value }] as never,
	});
	expect(outcome.ok, `save ${componentTipo}: ${outcome.message ?? ''}`).toBe(true);
}

/** The stored items of one component on the scratch record (raw, alias-free). */
async function storedItems(column: string, componentTipo: string): Promise<unknown[]> {
	const { sql } = await import('../../src/core/db/postgres.ts');
	const rows = (await sql.unsafe(
		`SELECT ${column}->$3 AS value FROM matrix_test WHERE section_tipo = $1 AND section_id = $2`,
		[SECTION, recordId, componentTipo],
	)) as { value: unknown[] | null }[];
	return rows[0]?.value ?? [];
}

beforeAll(async () => {
	await assertTestDatabase('tool_export_coverage_native');
	principal = await resolvePrincipal(USER_ID);
	mark = await runCounterMark(SECTION);
	recordId = await createSectionRecord(SECTION, USER_ID);
	await save(JSON_TIPO, 'lg-nolan', { value: JSON_VALUE });
	await save(GEO, 'lg-nolan', GEO_ENTRY);
	await save(TEXT_AREA, LANG, { lang: LANG, value: TEXT_STORED });
	await save(INPUT, LANG, { lang: LANG, value: 'x' });
}, 30000);

afterAll(async () => {
	await sweepRecordsCreatedSince(mark, SECTION);
	for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

const step = (component_tipo: string, name: string) => ({
	section_tipo: SECTION,
	component_tipo,
	name,
});

const options = (dataFormat: string): Record<string, unknown> => ({
	section_tipo: SECTION,
	model: 'section',
	data_format: dataFormat,
	breakdown: 'default',
	lang: LANG,
	ar_ddo_to_export: [JSON_TIPO, GEO, TEXT_AREA, INPUT].map((tipo) => ({
		path: [step(tipo, tipo)],
	})),
	sqo: {
		section_tipo: [SECTION],
		limit: 0,
		offset: 0,
		filter_by_locators: [{ section_tipo: SECTION, section_id: String(recordId) }],
	},
});

type Grid = {
	meta?: Record<string, unknown>;
	columns?: { key?: string; i?: number }[];
	rows?: { rec?: unknown; c?: Record<string, unknown> }[];
};

async function gridOf(dataFormat: string): Promise<Grid> {
	const response: ToolResponse = await toolExportGetExportGrid({
		principal,
		userId: USER_ID,
		options: options(dataFormat),
		background: false,
	} as unknown as ToolActionContext);
	return (response.data ?? {}) as Grid;
}

/** The record's cell of the column whose key is `<section>_<tipo>`: first row. */
function cellOf(grid: Grid, componentTipo: string): unknown {
	const column = (grid.columns ?? []).find((c) => c.key === `${SECTION}_${componentTipo}`);
	expect(column, `column ${componentTipo} not minted`).toBeDefined();
	const row = (grid.rows ?? []).find((r) => String(r.rec) === String(recordId));
	return row?.c?.[String(column?.i)];
}

function unresolvedOf(grid: Grid): unknown {
	return grid.meta?.unresolved ?? [];
}

/**
 * An exported json/geolocation cell (T1-39 review): the item's JSON with `/` →
 * `\/` (PHP json_encode's default) and `&` → `\u0026`, so the tabulator's
 * text cleanup (`</p><p>` → newline, entity decode) finds nothing to rewrite —
 * and it PARSES back to the stored item exactly.
 */
function expectJsonCell(cell: unknown, item: unknown): void {
	expect(cell).toBe(JSON.stringify(item).replaceAll('/', '\\/').replaceAll('&', '\\u0026'));
	expect(JSON.parse(String(cell))).toEqual(item);
}

describe.if(DB_READY)('tool_export coverage residue (T1-39)', () => {
	test('situation: the stored items are what the cases assume (non-vacuity)', async () => {
		const json = await storedItems('misc', JSON_TIPO);
		expect(json).toHaveLength(1);
		expect((json[0] as { value?: unknown }).value).toEqual(JSON_VALUE);
		const geo = (await storedItems('geo', GEO)) as Record<string, unknown>[];
		expect(geo).toHaveLength(1);
		expect(geo[0]?.sources).toBeDefined();
		expect(geo[0]?.legend).toBeDefined();
	});

	test('C1/C2/C4/C5 value format: json + geolocation cells are JSON, text cells are cleaned', async () => {
		const json = await storedItems('misc', JSON_TIPO);
		const geo = (await storedItems('geo', GEO)) as Record<string, unknown>[];
		const { sources: _s, legend: _l, ...geoServed } = geo[0] as Record<string, unknown>;
		const grid = await gridOf('value');
		expectJsonCell(cellOf(grid, JSON_TIPO), json[0]);
		expectJsonCell(cellOf(grid, GEO), geoServed);
		expect(cellOf(grid, TEXT_AREA)).toBe(TEXT_CLEAN);
		expect(cellOf(grid, INPUT)).toBe('x');
		expect(JSON.stringify(unresolvedOf(grid))).not.toContain('component_json');
		expect(JSON.stringify(unresolvedOf(grid))).not.toContain('component_geolocation');
	});

	test('C1/C2/C4/C5 grid_value format: the same cells', async () => {
		const json = await storedItems('misc', JSON_TIPO);
		const geo = (await storedItems('geo', GEO)) as Record<string, unknown>[];
		const { sources: _s, legend: _l, ...geoServed } = geo[0] as Record<string, unknown>;
		const grid = await gridOf('grid_value');
		expectJsonCell(cellOf(grid, JSON_TIPO), json[0]);
		expectJsonCell(cellOf(grid, GEO), geoServed);
		expect(cellOf(grid, TEXT_AREA)).toBe(TEXT_CLEAN);
		expect(cellOf(grid, INPUT)).toBe('x');
		expect(JSON.stringify(unresolvedOf(grid))).not.toContain('component_json');
		expect(JSON.stringify(unresolvedOf(grid))).not.toContain('component_geolocation');
	});

	test('controls: dedalo_raw keeps the stored geolocation map definition and the text markup', async () => {
		const grid = await gridOf('dedalo_raw');
		const geoRaw = JSON.parse(String(cellOf(grid, GEO))) as {
			dedalo_data: Record<string, unknown>[];
		};
		expect(geoRaw.dedalo_data[0]?.sources).toBeDefined();
		expect(geoRaw.dedalo_data[0]?.legend).toBeDefined();
		expect(String(cellOf(grid, TEXT_AREA))).toContain('&amp;lt;');
	});

	test('C3 interactive flat reader: the same JSON strings, nothing unresolved', async () => {
		const json = await storedItems('misc', JSON_TIPO);
		const geo = (await storedItems('geo', GEO)) as Record<string, unknown>[];
		const { sources: _s, legend: _l, ...geoServed } = geo[0] as Record<string, unknown>;
		const unresolved: string[] = [];
		expect(await resolveCellValue(SECTION, recordId, JSON_TIPO, LANG, unresolved)).toBe(
			JSON.stringify(json[0]),
		);
		expect(await resolveCellValue(SECTION, recordId, GEO, LANG, unresolved)).toBe(
			JSON.stringify(geoServed),
		);
		// neither model is ledgered any more (before T1-39 both were, value null)
		expect(unresolved).not.toContain('component_json');
		expect(unresolved).not.toContain('component_geolocation');
	});

	test('C4 the preview row and the CSV file carry the cleaned text', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'dedalo_export_coverage_'));
		scratchDirs.push(dir);
		const store: ArtifactStore = openArtifactStore({
			root: markExportArtifactsRoot(join(dir, 'artifacts')),
			quotaBytes: 0,
			ttlHours: 24,
		});
		const summary = await runExportArtifact({
			store,
			principal,
			userId: USER_ID,
			options: options('value'),
			applicationLang: LANG,
		});
		const preview = await readExportPreview({
			store,
			principal,
			userId: USER_ID,
			sectionTipo: SECTION,
			jobId: summary.job_id,
			page: 0,
			pageSize: 10,
		});
		const textCol = preview.cols.find((col) => col.key === `${SECTION}_${TEXT_AREA}`);
		expect(textCol).toBeDefined();
		const previewRow = preview.rows.find((row) => String(row.rec) === String(recordId));
		expect(previewRow?.c?.[String(textCol?.i)]).toBe(TEXT_CLEAN);
		// the json cell crosses the same cleanup and still parses to the stored item
		const jsonCol = preview.cols.find((col) => col.key === `${SECTION}_${JSON_TIPO}`);
		expect(jsonCol).toBeDefined();
		expect(JSON.parse(String(previewRow?.c?.[String(jsonCol?.i)]))).toEqual(
			(await storedItems('misc', JSON_TIPO))[0],
		);

		const file = await runBuildExportFile({
			store,
			principal,
			userId: USER_ID,
			options: { section_tipo: SECTION, job_id: summary.job_id, format: 'csv' },
			signal: new AbortController().signal,
		});
		const job = store.jobRef(USER_ID, summary.job_id);
		const csv = readFileSync(join(job.dir, file.basename), 'utf8');
		// the CSV quotes a field holding a newline: the cleaned text, verbatim
		expect(csv).toContain(`"${TEXT_CLEAN}"`);
		expect(csv).not.toContain('&amp;');
		expect(csv).not.toContain('&quot;');
		// the stored markup never reaches the file (the json cell's own `<p>` does,
		// inside its JSON string — asserted by parse above)
		expect(csv).not.toContain(TEXT_STORED);
		expect(csv).not.toContain('<p>a &');
	});
});

// --- C6: the ACL models export as JSON cells under the ordinary gate (C44) ------

const ACL_SECTION = 'zzsax1';
const ACL_FILTER = 'zzsax2';
const SECURITY_ACCESS = 'zzsax3';
const FILTER_RECORDS = 'zzsax4';
const ACL_LANG = 'lg-eng';
const ACL_TERM = { SA: 'zz sax permissions', FR: 'zz sax record filter' };
const ACL_RECORD = 1;
/** The stored items, as the two editors write them (dd774 / dd478 shapes). */
const SA_VALUE = { id: 1, tipo: 'test3', section_tipo: 'test3', value: 2 };
const FR_VALUE = { id: 1, tipo: 'test3', value: [10, 27] };

/** The stored item AS jsonb hands it back (its key order) — the cell's oracle. */
async function aclStoredItem(componentTipo: string): Promise<unknown> {
	const rows = (await sql.unsafe(
		'SELECT misc->$3->0 AS item FROM matrix_test WHERE section_tipo = $1 AND section_id = $2',
		[ACL_SECTION, ACL_RECORD, componentTipo],
	)) as { item: unknown }[];
	expect(rows[0]?.item, `no stored ${componentTipo} item`).toBeDefined();
	return rows[0]?.item;
}

const ACL = situation({
	name: 'tool_export ACL components (C44)',
	tld: 'zzsax',
	nodes: [
		{
			tipo: ACL_SECTION,
			parent: 'test1',
			model: 'section',
			term: { [ACL_LANG]: 'zz sax host' },
			relations: [{ tipo: 'test24' }],
		},
		{
			tipo: ACL_FILTER,
			parent: ACL_SECTION,
			model: 'component_filter',
			term: { [ACL_LANG]: 'zz sax projects' },
		},
		{
			tipo: SECURITY_ACCESS,
			parent: ACL_SECTION,
			model: 'component_security_access',
			term: { [ACL_LANG]: ACL_TERM.SA },
		},
		{
			tipo: FILTER_RECORDS,
			parent: ACL_SECTION,
			model: 'component_filter_records',
			term: { [ACL_LANG]: ACL_TERM.FR },
		},
	],
});

const aclIdentity = exportFrontierIdentity('tool_export_coverage_acl', 935400);
/** The scoped persona may export the SECTION but holds NO grant on either ACL column. */
const ACL_SCOPED_GRANTS: FrontierGrant[] = [
	{ sectionTipo: ACL_SECTION, tipo: ACL_SECTION, level: 2 },
];
const ACL_ADMIN_GRANTS: FrontierGrant[] = ACL.nodes.map((node) => ({
	sectionTipo: node.model === 'section' ? node.tipo : (node.parent as string),
	tipo: node.tipo,
	level: 3,
}));

const aclOptions = (
	dataFormat: 'value' | 'grid_value',
	componentTipo: string,
): Record<string, unknown> => ({
	section_tipo: ACL_SECTION,
	model: 'section',
	lang: ACL_LANG,
	data_format: dataFormat,
	breakdown: 'default',
	fill_the_gaps: false,
	ar_ddo_to_export: [{ path: [{ section_tipo: ACL_SECTION, component_tipo: componentTipo }] }],
	sqo: {
		section_tipo: [ACL_SECTION],
		limit: 10,
		offset: 0,
		filter_by_locators: [{ section_tipo: ACL_SECTION, section_id: String(ACL_RECORD) }],
	},
});

async function aclAnswer(who: Principal, options: Record<string, unknown>): Promise<string> {
	clearFrontierIdentityCaches();
	try {
		const response: ToolResponse = await toolExportGetExportGrid({
			principal: who,
			userId: who.userId,
			options,
			background: false,
		} as unknown as ToolActionContext);
		return `OK:${JSON.stringify(response.data)}`;
	} catch (error) {
		const code = (error as { code?: string }).code ?? 'unknown';
		const details = (error as { details?: unknown }).details;
		return `REFUSED:${code}:${JSON.stringify(details ?? null)}`;
	}
}

/** The one cell of the one record of an OK answer (floor: a row was walked). */
async function aclCell(who: Principal, options: Record<string, unknown>): Promise<unknown> {
	const answer = await aclAnswer(who, options);
	expect(answer.startsWith('OK:'), answer).toBe(true);
	const grid = JSON.parse(answer.slice(3)) as Grid;
	expect((grid.rows ?? []).length).toBe(1);
	expect((grid.columns ?? []).length).toBe(1);
	expect(JSON.stringify(unresolvedOf(grid))).not.toContain('component_security_access');
	expect(JSON.stringify(unresolvedOf(grid))).not.toContain('component_filter_records');
	return grid.rows?.[0]?.c?.[String(grid.columns?.[0]?.i)];
}

describe.if(DB_READY)(
	'tool_export exports the ACL components as JSON cells (C44, 2026-11-13)',
	() => {
		beforeAll(async () => {
			await assertTestDatabase('tool_export_coverage_native C6');
			await ensureSituation(ACL);
			await aclIdentity.install(ACL_SCOPED_GRANTS, ACL_ADMIN_GRANTS);
			await sql.unsafe('DELETE FROM matrix_test WHERE section_tipo = $1', [ACL_SECTION]);
			await sql.unsafe(
				`INSERT INTO matrix_test (section_tipo, section_id, relation, misc, data)
			 VALUES ($1, $2, $3::text::jsonb, $4::text::jsonb, $5::text::jsonb)`,
				[
					ACL_SECTION,
					ACL_RECORD,
					encodeForJsonb({
						[ACL_FILTER]: [aclIdentity.filterLocator(ACL_FILTER, aclIdentity.myProject)],
					}),
					encodeForJsonb({ [SECURITY_ACCESS]: [SA_VALUE], [FILTER_RECORDS]: [FR_VALUE] }),
					encodeForJsonb({ section_tipo: ACL_SECTION, section_id: ACL_RECORD }),
				],
			);
			clearTermCache();
		}, 60000);

		afterAll(async () => {
			await sql.unsafe('DELETE FROM matrix_test WHERE section_tipo = $1', [ACL_SECTION]);
			await aclIdentity.remove(true);
			expect(await dropSituation(ACL)).toBe(0);
		});

		for (const [name, tipo, item] of [
			['component_security_access', SECURITY_ACCESS, SA_VALUE],
			['component_filter_records', FILTER_RECORDS, FR_VALUE],
		] as const) {
			test(`${name}: value AND grid_value cell = the stored item as JSON (admin)`, async () => {
				const stored = await aclStoredItem(tipo);
				expect(stored).toEqual(item); // non-vacuity: the oracle IS the planted item
				for (const format of ['value', 'grid_value'] as const) {
					expectJsonCell(await aclCell(aclIdentity.admin, aclOptions(format, tipo)), stored);
				}
			});

			test(`${name}: no grant on the column → the ORDINARY export gate refuses; granted → exported`, async () => {
				await aclIdentity.setScopedGrants(ACL_SCOPED_GRANTS);
				// no grant on the component: the tool's per-column ACL (perm.denied) —
				// the SAME gate every other column crosses, nothing ACL-model-specific
				for (const format of ['value', 'grid_value'] as const) {
					expect(await aclAnswer(aclIdentity.scoped, aclOptions(format, tipo))).toBe(
						'REFUSED:perm.denied:null',
					);
				}
				await aclIdentity.setScopedGrants([
					...ACL_SCOPED_GRANTS,
					{ sectionTipo: ACL_SECTION, tipo, level: 1 },
				]);
				expectJsonCell(
					await aclCell(aclIdentity.scoped, aclOptions('value', tipo)),
					await aclStoredItem(tipo),
				);
			});
		}
	},
);
