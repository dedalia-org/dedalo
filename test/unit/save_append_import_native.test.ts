/**
 * `SaveRequest.appendImport` — the engine half of the CSV-import APPEND mode
 * (plan §4), TS-NATIVE write-path contract.
 *
 * An append save's one `set_data` change is MERGED onto the stored items under
 * the save's row lock (section/record/append_merge.ts), instead of replacing
 * them. What this gate pins, at the engine chokepoint (saveComponentData):
 *  - portal: stored locators survive BYTE-IDENTICAL (never replayed through
 *    the set_data re-validation — a stored duplicate pair is not collapsed, a
 *    string section_id is not re-canonicalized), the new locator is appended
 *    normalized with a fresh id, a duplicate is skipped and mapped to the
 *    existing item's id (the internal appendedIdMap / appendSkipped outputs);
 *  - geolocation: a flat point becomes layer 2, layer 1 and the centre stay
 *    byte-identical; re-importing the same point adds nothing;
 *  - a NO-OP append (every value already present) writes nothing: no key
 *    rewrite, no dd201 bump, no Time Machine row;
 *  - the insert law's CAP binds an append: a net-new locator sharing a stored
 *    target record (a different tag_id) is not a re-persist — past data_limit
 *    it throws relation.insert_refused and the row rolls back;
 *  - the BACKSTOP: a refusing model (media, single-choice) throws even when
 *    the tool is bypassed, and nothing is written;
 *  - the WIRE DOOR (dd_core_api save) cannot set it: a client rqo carrying
 *    `appendImport` anywhere still REPLACES.
 *
 * Scratch surface: test3 records created at runtime (the generic `test` TLD
 * bench: test80 portal, test100 geolocation, test99 image, test91 select),
 * plus one scratch capped portal node (zz TLD, data_limit 1, targets test3),
 * rows + TM + the node swept after.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { type ApiRequestContext, dispatchRqo } from '../../src/core/api/dispatch.ts';
import type { Rqo } from '../../src/core/concepts/rqo.ts';
import { deleteTldNodes, upsertDdOntologyNode } from '../../src/core/db/dd_ontology.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { DedaloError } from '../../src/core/errors/dedalo_error.ts';
import { clearOntologyDerivedCaches } from '../../src/core/ontology/cache_invalidation.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import { saveComponentData } from '../../src/core/section/record/save_component.ts';
import type { Principal } from '../../src/core/security/permissions.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { cleanScratchRecord } from '../helpers/test_data.ts';

const SECTION = 'test3';
const TABLE = 'matrix_test';
const PORTAL = 'test80'; // component_portal
const GEO = 'test100'; // component_geolocation (not translatable)
const IMAGE = 'test99'; // component_image — media, refuses append
const SELECT = 'test91'; // component_select — single choice, refuses append
/** Scratch TLD of the capped portal node (orphan parent: no section walk reaches it). */
const CAP_TLD = 'zzapx';
const CAPPED = `${CAP_TLD}1`; // component_portal, data_limit 1, targets test3
const USER_ID = -1;
const ROOT: Principal = { userId: USER_ID, isGlobalAdmin: true, isDeveloper: true };

const created: number[] = [];
let hostId = 0;
let targetA = 0;
let targetB = 0;
let targetC = 0;
let geoHostId = 0;
let wireHostId = 0;
let multiHostId = 0;
let imageHostId = 0;
let selectHostId = 0;
let cappedHostId = 0;

async function newRecord(): Promise<number> {
	const id = await createSectionRecord(SECTION, USER_ID);
	created.push(id);
	return id;
}

async function seed(
	sectionId: number,
	column: string,
	tipo: string,
	items: unknown[],
): Promise<void> {
	await sql.unsafe(
		`UPDATE ${TABLE}
		 SET ${column} = COALESCE(${column}, '{}'::jsonb) || jsonb_build_object($2::text, $3::text::jsonb)
		 WHERE section_tipo = $1 AND section_id = $4`,
		[SECTION, tipo, JSON.stringify(items), sectionId],
	);
}

async function stored(sectionId: number, column: string, tipo: string): Promise<unknown[]> {
	const rows = (await sql.unsafe(
		`SELECT ${column}->$3 AS value FROM ${TABLE} WHERE section_tipo = $1 AND section_id = $2`,
		[SECTION, sectionId, tipo],
	)) as { value: unknown[] | null }[];
	return rows[0]?.value ?? [];
}

const locator = (id: number, sectionId: unknown): Record<string, unknown> => ({
	id,
	type: 'dd151',
	section_id: sectionId,
	section_tipo: SECTION,
	from_component_tipo: PORTAL,
});

/** The stored bag: a STRING section_id and a stored DUPLICATE pair (ids 2, 3). */
function seededBag(): Record<string, unknown>[] {
	return [locator(1, String(targetA)), locator(2, targetB), locator(3, targetB)];
}

const LAYER_1 = {
	layer_id: 1,
	layer_data: {
		type: 'FeatureCollection',
		features: [
			{
				type: 'Feature',
				properties: { layer_id: 1 },
				geometry: {
					type: 'Polygon',
					coordinates: [
						[
							[2.1, 41.3],
							[2.2, 41.3],
							[2.2, 41.4],
							[2.1, 41.3],
						],
					],
				},
			},
		],
	},
	user_layer_name: 'layer_1',
};
/** A stored image value — the backstop must leave it byte-identical. */
const IMAGE_STORED = {
	id: 1,
	lib_data: null,
	files_info: [],
	original_file_name: 'seeded.jpg',
};
const SELECT_STORED = () => ({
	id: 1,
	type: 'dd151',
	section_id: targetB,
	section_tipo: SECTION,
	from_component_tipo: SELECT,
});
/** The capped portal's one stored locator: target A, tag_id 1. */
const CAPPED_STORED = () => ({
	id: 1,
	type: 'dd151',
	section_id: targetA,
	section_tipo: SECTION,
	tag_id: '1',
	from_component_tipo: CAPPED,
});

const GEO_STORED = { id: 1, lat: 41.38, lon: 2.17, zoom: 12, alt: 16, lib_data: [LAYER_1] };

/**
 * The save threw `code` with a message matching `pattern` — the append
 * refusal specifically, not any other invalid_data the save can throw (an
 * unimplemented action, a non-object insert).
 */
async function expectRefusal(
	work: Promise<unknown>,
	code: DedaloError['code'],
	pattern: RegExp,
): Promise<void> {
	let caught: unknown = null;
	try {
		await work;
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(DedaloError);
	expect((caught as DedaloError).code).toBe(code);
	expect((caught as DedaloError).message).toMatch(pattern);
}

/** THE append backstop's refusal (save_component.ts appendRefusal). */
const APPEND_REFUSED = /saveComponentData: append refused for/;

async function tmRowCount(sectionId: number, tipo: string): Promise<number> {
	const rows = (await sql.unsafe(
		'SELECT count(*)::int AS n FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2 AND tipo = $3',
		[SECTION, sectionId, tipo],
	)) as { n: number }[];
	return rows[0]?.n ?? 0;
}

/** The record's modified-date stamp (dd201, the `date` column). */
async function modifiedStamp(sectionId: number): Promise<unknown> {
	const rows = (await sql.unsafe(
		`SELECT date->'dd201' AS stamp FROM ${TABLE} WHERE section_tipo = $1 AND section_id = $2`,
		[SECTION, sectionId],
	)) as { stamp: unknown }[];
	return rows[0]?.stamp ?? null;
}

const wireContext: ApiRequestContext = {
	requestId: 'test',
	clientIp: '127.0.0.1',
	session: {
		userId: USER_ID,
		username: 'root',
		isGlobalAdmin: true,
		csrfToken: 'tok',
		applicationLang: null,
		dataLang: null,
	},
	csrfCandidate: 'tok',
	principal: ROOT,
};

beforeAll(async () => {
	await assertTestDatabase('save_append_import_native');
	targetA = await newRecord();
	targetB = await newRecord();
	targetC = await newRecord();
	hostId = await newRecord();
	geoHostId = await newRecord();
	wireHostId = await newRecord();
	multiHostId = await newRecord();
	imageHostId = await newRecord();
	selectHostId = await newRecord();
	cappedHostId = await newRecord();
	await seed(hostId, 'relation', PORTAL, seededBag());
	await seed(multiHostId, 'relation', PORTAL, [locator(1, targetA)]);
	await seed(imageHostId, 'media', IMAGE, [IMAGE_STORED]);
	await seed(selectHostId, 'relation', SELECT, [SELECT_STORED()]);
	await deleteTldNodes(CAP_TLD);
	await upsertDdOntologyNode({
		tipo: CAPPED,
		parent: `${CAP_TLD}999999`, // orphan: a valid tipo no node carries (SURF-1 grammar)
		model: 'component_portal',
		tld: CAP_TLD,
		term: { 'lg-spa': 'scratch append cap portal' },
		is_model: false,
		is_translatable: false,
		is_main: false,
		properties: {
			data_limit: 1,
			source: {
				request_config: [{ sqo: { section_tipo: [{ value: [SECTION], source: 'section' }] } }],
			},
		},
	});
	await seed(cappedHostId, 'relation', CAPPED, [CAPPED_STORED()]);
	await seed(geoHostId, 'geo', GEO, [GEO_STORED]);
	await seed(wireHostId, 'relation', PORTAL, [locator(1, targetA)]);
}, 30000);

afterAll(async () => {
	await deleteTldNodes(CAP_TLD);
	await clearOntologyDerivedCaches();
	for (const id of created) await cleanScratchRecord(SECTION, id, TABLE);
	const rows = (await sql.unsafe(
		`SELECT count(*)::int AS n FROM ${TABLE} WHERE section_tipo = $1 AND section_id = ANY(string_to_array($2, ',')::int[])`,
		[SECTION, created.join(',')],
	)) as { n: number }[];
	expect(rows[0]?.n).toBe(0);
});

describe('appendImport — portal (relation items)', () => {
	test('stored locators byte-identical, new one appended, duplicate skipped + mapped', async () => {
		const result = await saveComponentData({
			componentTipo: PORTAL,
			sectionTipo: SECTION,
			sectionId: hostId,
			lang: 'lg-nolan',
			userId: USER_ID,
			principal: ROOT,
			appendImport: true,
			changedData: [
				{
					action: 'set_data',
					value: [
						{ id: 10, section_tipo: SECTION, section_id: targetC }, // new
						{ id: 11, section_tipo: SECTION, section_id: targetA }, // already stored (as a string)
					],
				},
			],
		});
		expect(result.ok).toBe(true);

		const bag = (await stored(hostId, 'relation', PORTAL)) as Record<string, unknown>[];
		expect(bag).toHaveLength(4);
		// THE LAW: the stored prefix is the seed, byte for byte — the string
		// section_id kept, the stored duplicate pair NOT collapsed.
		expect(bag.slice(0, 3)).toEqual(seededBag());
		expect(bag[3]).toMatchObject({
			type: 'dd151',
			section_tipo: SECTION,
			section_id: targetC,
			from_component_tipo: PORTAL,
		});
		const newId = bag[3]?.id;
		expect(typeof newId).toBe('number');
		expect([1, 2, 3]).not.toContain(newId as number);

		expect(result.appendSkipped).toBe(1);
		expect(result.appendedIdMap).toBeInstanceOf(Map);
		expect(result.appendedIdMap?.get('10')).toBe(newId);
		expect(result.appendedIdMap?.get('11')).toBe(1);
	}, 30000);

	test('re-importing the same values changes nothing — no write, no dd201 bump, no TM row', async () => {
		const before = await stored(hostId, 'relation', PORTAL);
		const stampBefore = await modifiedStamp(hostId);
		const tmBefore = await tmRowCount(hostId, PORTAL);
		// the first append over the raw (history-less) seed wrote, like a replace,
		// its save-before row (the seed as it stood — re-pinned 2026-11-12, T1-21)
		// and its ONE normal row (and the count is live)
		expect(tmBefore).toBe(2);
		const result = await saveComponentData({
			componentTipo: PORTAL,
			sectionTipo: SECTION,
			sectionId: hostId,
			lang: 'lg-nolan',
			userId: USER_ID,
			principal: ROOT,
			appendImport: true,
			changedData: [
				{
					action: 'set_data',
					value: [
						{ id: 10, section_tipo: SECTION, section_id: targetC },
						{ id: 11, section_tipo: SECTION, section_id: targetA },
					],
				},
			],
		});
		expect(result.ok).toBe(true);
		expect(result.appendSkipped).toBe(2);
		expect(result.appendedIdMap?.get('11')).toBe(1);
		expect(await stored(hostId, 'relation', PORTAL)).toEqual(before);
		expect(await modifiedStamp(hostId)).toEqual(stampBefore);
		expect(await tmRowCount(hostId, PORTAL)).toBe(tmBefore);
	}, 30000);

	test('CONTRAST: a REPLACE save of the unchanged value still writes a TM row (docs/core/system/tm_record.md)', async () => {
		// The no-op short-circuit is append-only. The TM doc states a replace
		// save versions even when nothing changed — pinned here so the doc and
		// the engine cannot drift apart silently.
		const replaceHostId = await newRecord();
		await seed(replaceHostId, 'relation', PORTAL, [locator(1, targetA)]);
		const save = () =>
			saveComponentData({
				componentTipo: PORTAL,
				sectionTipo: SECTION,
				sectionId: replaceHostId,
				lang: 'lg-nolan',
				userId: USER_ID,
				principal: ROOT,
				changedData: [{ action: 'set_data', value: [locator(1, targetA)] }],
			});
		expect((await save()).ok).toBe(true);
		const value = await stored(replaceHostId, 'relation', PORTAL);
		const tmBefore = await tmRowCount(replaceHostId, PORTAL);
		expect(tmBefore).toBeGreaterThan(0);
		expect((await save()).ok).toBe(true);
		expect(await stored(replaceHostId, 'relation', PORTAL)).toEqual(value);
		expect(await tmRowCount(replaceHostId, PORTAL)).toBe(tmBefore + 1);
	}, 30000);

	test('an append save with anything but ONE set_data change is refused', async () => {
		// targetC is NOT stored on this host: had the backstop not refused, the
		// insert would visibly grow the bag.
		const before = await stored(multiHostId, 'relation', PORTAL);
		expect(before).toHaveLength(1);
		await expectRefusal(
			saveComponentData({
				componentTipo: PORTAL,
				sectionTipo: SECTION,
				sectionId: multiHostId,
				lang: 'lg-nolan',
				userId: USER_ID,
				principal: ROOT,
				appendImport: true,
				changedData: [
					{ action: 'insert', id: null, value: { section_tipo: SECTION, section_id: targetC } },
				],
			}),
			'request.invalid_data',
			/exactly one set_data change/,
		);
		expect(await stored(multiHostId, 'relation', PORTAL)).toEqual(before);
	}, 30000);

	test('a net-new locator sharing a stored target (other tag_id) meets the cap — refused, rolled back', async () => {
		const before = await stored(cappedHostId, 'relation', CAPPED);
		expect(before).toEqual([CAPPED_STORED()]);
		await expectRefusal(
			saveComponentData({
				componentTipo: CAPPED,
				sectionTipo: SECTION,
				sectionId: cappedHostId,
				lang: 'lg-nolan',
				userId: USER_ID,
				principal: ROOT,
				appendImport: true,
				changedData: [
					{
						action: 'set_data',
						value: [{ section_tipo: SECTION, section_id: targetA, tag_id: '2' }],
					},
				],
			}),
			'relation.insert_refused',
			/selection_limit/,
		);
		expect(await stored(cappedHostId, 'relation', CAPPED)).toEqual(before);
	}, 30000);
});

describe('appendImport — geolocation (geo_layer)', () => {
	test('a flat point becomes layer 2; layer 1 and the centre stay byte-identical', async () => {
		const result = await saveComponentData({
			componentTipo: GEO,
			sectionTipo: SECTION,
			sectionId: geoHostId,
			lang: 'lg-nolan',
			userId: USER_ID,
			principal: ROOT,
			appendImport: true,
			changedData: [{ action: 'set_data', value: [{ lat: 40.4168, lon: -3.7038 }] }],
		});
		expect(result.ok).toBe(true);

		const items = (await stored(geoHostId, 'geo', GEO)) as Record<string, unknown>[];
		expect(items).toHaveLength(1);
		const { lib_data: libData, ...centre } = items[0] as { lib_data: unknown[] };
		const { lib_data: _storedLayers, ...storedCentre } = GEO_STORED;
		expect(centre).toEqual(storedCentre);
		expect(libData).toHaveLength(2);
		expect(libData[0]).toEqual(LAYER_1);
		expect(libData[1]).toEqual({
			layer_id: 2,
			user_layer_name: 'layer_2',
			layer_data: {
				type: 'FeatureCollection',
				features: [
					{
						type: 'Feature',
						properties: { layer_id: 2 },
						geometry: { type: 'Point', coordinates: [-3.7038, 40.4168] },
					},
				],
			},
		});
	}, 30000);

	test('re-importing the same point adds no layer', async () => {
		const before = await stored(geoHostId, 'geo', GEO);
		const result = await saveComponentData({
			componentTipo: GEO,
			sectionTipo: SECTION,
			sectionId: geoHostId,
			lang: 'lg-nolan',
			userId: USER_ID,
			principal: ROOT,
			appendImport: true,
			changedData: [{ action: 'set_data', value: [{ lat: 40.4168, lon: -3.7038 }] }],
		});
		expect(result.ok).toBe(true);
		expect(result.appendSkipped).toBe(1);
		expect(await stored(geoHostId, 'geo', GEO)).toEqual(before);
	}, 30000);
});

describe('appendImport — the engine backstop refuses a refusing model', () => {
	test('media (component_image) throws; the stored value stays byte-identical', async () => {
		const before = await stored(imageHostId, 'media', IMAGE);
		expect(before).toEqual([IMAGE_STORED]);
		await expectRefusal(
			saveComponentData({
				componentTipo: IMAGE,
				sectionTipo: SECTION,
				sectionId: imageHostId,
				lang: 'lg-nolan',
				userId: USER_ID,
				principal: ROOT,
				appendImport: true,
				changedData: [{ action: 'set_data', value: [{ original_file_name: 'x.jpg' }] }],
			}),
			'request.invalid_data',
			APPEND_REFUSED,
		);
		expect(await stored(imageHostId, 'media', IMAGE)).toEqual(before);
	}, 30000);

	test('single choice (component_select) throws; the stored value stays byte-identical', async () => {
		const before = await stored(selectHostId, 'relation', SELECT);
		expect(before).toEqual([SELECT_STORED()]);
		await expectRefusal(
			saveComponentData({
				componentTipo: SELECT,
				sectionTipo: SECTION,
				sectionId: selectHostId,
				lang: 'lg-nolan',
				userId: USER_ID,
				principal: ROOT,
				appendImport: { preallocatedIds: [] },
				changedData: [
					{ action: 'set_data', value: [{ section_tipo: SECTION, section_id: targetA }] },
				],
			}),
			'request.invalid_data',
			APPEND_REFUSED,
		);
		expect(await stored(selectHostId, 'relation', SELECT)).toEqual(before);
	}, 30000);
});

/**
 * THE SERVER-SIDE CALLERS, CENSUSED (2026-10-01). `appendImport` is not a wire
 * field (the case below), so who may set it is decided in-repo — and that set is
 * pinned here by a scan, not by a sentence: a new door that starts appending
 * reddens this list and must be added on purpose.
 *   - the CSV import executor (core/tools/import_csv_execute.ts) — the mode's
 *     origin (plan §4);
 *   - tool_import_rdf's ontology-driven executor
 *     (tools/tool_import_rdf/server/rdf_import_execute.ts) — the v6 "never
 *     overwrite" law: IRIs and locators appended deduplicated, a literal written
 *     only into an empty slice (gate: rdf_import_execute_native).
 */
const APPEND_IMPORT_CALLERS = [
	'src/core/tools/import_csv_execute.ts',
	'tools/tool_import_rdf/server/rdf_import_execute.ts',
];

describe('appendImport — the server-side callers', () => {
	test('only the censused executors set appendImport', async () => {
		const setter = /\bappendImport\s*:/;
		const found: string[] = [];
		const repoRoot = join(import.meta.dir, '..', '..');
		for (const root of ['src', 'tools', 'scripts']) {
			for await (const file of new Bun.Glob(`${root}/**/*.ts`).scan({ cwd: repoRoot })) {
				if (file.endsWith('.test.ts') || file.endsWith('.d.ts')) continue;
				if (setter.test(await Bun.file(join(repoRoot, file)).text())) found.push(file);
			}
		}
		expect(found.sort()).toEqual([...APPEND_IMPORT_CALLERS].sort());
	});
});

describe('appendImport — NOT A WIRE FIELD', () => {
	test('a dd_core_api save carrying appendImport anywhere still REPLACES', async () => {
		const response = await dispatchRqo(
			{
				action: 'save',
				dd_api: 'dd_core_api',
				appendImport: true,
				source: {
					type: 'component',
					tipo: PORTAL,
					section_tipo: SECTION,
					section_id: wireHostId,
					lang: 'lg-nolan',
					appendImport: true,
				},
				data: {
					appendImport: true,
					changed_data: [
						{
							action: 'set_data',
							appendImport: true,
							value: [{ section_tipo: SECTION, section_id: targetB }],
						},
					],
				},
			} as unknown as Rqo,
			wireContext,
		);
		expect(response.status).toBe(200);
		const bag = (await stored(wireHostId, 'relation', PORTAL)) as Record<string, unknown>[];
		// Replace semantics: the stored targetA locator is gone, only targetB remains.
		expect(bag).toHaveLength(1);
		expect(bag[0]).toMatchObject({ section_tipo: SECTION, section_id: targetB });
		// ...and no internal append output leaked into the response body.
		const body = JSON.stringify(response.body);
		expect(body).not.toContain('appendedIdMap');
		expect(body).not.toContain('appendSkipped');
	}, 30000);
});
