/**
 * `sources` and `legend` through the component's OWN save path — the database
 * half of WC-2026-11-06-geolocation-map-sources-legend (the pure half is
 * geo_entry_gate_native.test.ts).
 *
 * There is no tool-only writer: these keys are part of the component_geolocation
 * value, so every door that saves the component meets the one gate
 * (section/record/item_gates.ts, the `itemGate` facet). What this file proves,
 * against the real chokepoint on scratch records:
 *  - a save numbers new sources from the component's item counter and echoes the
 *    ids; a second save of the whole entry keeps them and numbers only what is new;
 *  - an id deleted once is NEVER handed out again — resending the removed source
 *    (an undo, a copy) stores it under a fresh, higher id;
 *  - REPLACE semantics: a value sent without the keys stores without them;
 *  - the caller's value objects are never written by the gate: ONE value object saved
 *    into several records (tool_propagate_component_data's shape) settles each record
 *    exactly as a fresh copy would, whatever ids the earlier records issued;
 *  - a refused save (private-literal template) leaves value, counter and Time
 *    Machine exactly as they were, through the engine AND the wire door;
 *  - the Time Machine row carries the keys, a duplicate carries them and does not
 *    hand out an id its copied sources already hold, a set_data from another
 *    record gets fresh ids, and the section read returns them;
 *  - CSV append is layers-only: incoming sources never touch a stored host.
 *
 * Scratch surface: test3 records created at runtime (test100 is the playground
 * geolocation), swept with their TM rows in afterAll. No installation data.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type ApiRequestContext, dispatchRqo } from '../../src/core/api/dispatch.ts';
import type { Rqo } from '../../src/core/concepts/rqo.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { DedaloError } from '../../src/core/errors/dedalo_error.ts';
import { getMatrixTableFromTipo } from '../../src/core/ontology/resolver.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import { duplicateSectionRecord } from '../../src/core/section/record/duplicate_record.ts';
import { saveComponentData } from '../../src/core/section/record/save_component.ts';
import { type Principal, resolvePrincipal } from '../../src/core/security/permissions.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { conformImportData, unwrapDedaloData } from '../../src/core/tools/import_data.ts';
import type { ToolActionContext, ToolResponse } from '../../src/core/tools/module.ts';
import { toolExportGetExportGrid } from '../../tools/tool_export/server/tool_export.ts';
import { applyPropagation } from '../../tools/tool_propagate_component_data/server/propagate.ts';
import { cleanScratchRecord } from '../helpers/test_data.ts';

const SECTION = 'test3';
const TABLE = 'matrix_test';
const GEO = 'test100'; // component_geolocation (not translatable, monovalue)
const USER_ID = -1;
const ROOT: Principal = { userId: USER_ID, isGlobalAdmin: true, isDeveloper: true };

const created: number[] = [];

const XYZ = (over: Record<string, unknown> = {}) => ({
	type: 'xyz',
	url: 'https://tiles.example.org/{z}/{x}/{y}.png',
	params: { max_zoom: 18 },
	attribution: 'Example Org',
	...over,
});
const WMS = (over: Record<string, unknown> = {}) => ({
	type: 'wms',
	url: 'https://wms.example.org/service',
	params: { version: '1.3.0', layers: 'base', format: 'image/png', crs: 'EPSG:3857' },
	attribution: 'Example WMS',
	...over,
});
/** A real 1x1 PNG. */
const PNG_URI =
	'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const LEGEND = {
	title: 'Roman roads',
	groups: [{ name: 'Surface', symbols: [{ label: 'Paved', icon: PNG_URI }, { label: 'Track' }] }],
};

const entry = (over: Record<string, unknown> = {}) => ({
	lat: 41.38,
	lon: 2.17,
	zoom: 12,
	alt: 16,
	...over,
});

async function newRecord(): Promise<number> {
	const id = await createSectionRecord(SECTION, USER_ID);
	created.push(id);
	return id;
}

/**
 * A dd800 bulk-run record, swept in afterAll. A save made under its id is part of
 * the run's UNDO LOG (db/time_machine.ts recordBulkPair): there, and only there,
 * "a save that changed nothing writes nothing" — an ordinary save always leaves
 * its visible Time Machine row.
 */
const bulkRuns: number[] = [];
async function newBulkRun(): Promise<number> {
	const id = await createSectionRecord('dd800', USER_ID);
	bulkRuns.push(id);
	return id;
}

async function stored(sectionId: number): Promise<Record<string, unknown>[]> {
	const rows = (await sql.unsafe(
		`SELECT geo->$3 AS value FROM ${TABLE} WHERE section_tipo = $1 AND section_id = $2`,
		[SECTION, sectionId, GEO],
	)) as { value: Record<string, unknown>[] | null }[];
	return rows[0]?.value ?? [];
}

async function counterOf(sectionId: number): Promise<number> {
	const rows = (await sql.unsafe(
		`SELECT (meta->$3->0->>'count')::int AS n FROM ${TABLE} WHERE section_tipo = $1 AND section_id = $2`,
		[SECTION, sectionId, GEO],
	)) as { n: number | null }[];
	return rows[0]?.n ?? 0;
}

async function tmRows(sectionId: number): Promise<{ data: unknown }[]> {
	return (await sql.unsafe(
		'SELECT data FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2 AND tipo = $3 ORDER BY id',
		[SECTION, sectionId, GEO],
	)) as { data: unknown }[];
}

type Change = { action: string; id?: number | null; key?: number; value?: unknown };

function save(sectionId: number, changedData: Change[], extra: Record<string, unknown> = {}) {
	return saveComponentData({
		componentTipo: GEO,
		sectionTipo: SECTION,
		sectionId,
		lang: 'lg-nolan',
		userId: USER_ID,
		principal: ROOT,
		changedData: changedData as never,
		...extra,
	});
}

/** The id-less monovalue update every first save sends. */
const update = (value: unknown, id: number | null = null): Change => ({
	action: 'update',
	key: 0,
	id,
	value,
});

const idsOf = (item: Record<string, unknown> | undefined): number[] =>
	((item?.sources as { id: number }[] | undefined) ?? []).map((source) => source.id);

async function expectInvalidData(work: Promise<unknown>, pattern: RegExp): Promise<void> {
	let caught: unknown = null;
	try {
		await work;
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(DedaloError);
	expect((caught as DedaloError).code).toBe('request.invalid_data');
	expect((caught as DedaloError).message).toMatch(pattern);
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
	await assertTestDatabase('geo_sources_legend_save_native');
}, 30000);

afterAll(async () => {
	for (const id of created) await cleanScratchRecord(SECTION, id, TABLE);
	const bulkTable = await getMatrixTableFromTipo('dd800');
	for (const id of bulkRuns) await cleanScratchRecord('dd800', id, bulkTable ?? undefined);
});

describe('ids are issued by the save and survive the next one', () => {
	let host = 0;
	let firstIds: number[] = [];

	test('new sources are numbered, the legend is stored, the echo carries both', async () => {
		host = await newRecord();
		const result = await save(host, [update(entry({ sources: [XYZ(), WMS()], legend: LEGEND }))]);
		expect(result.ok).toBe(true);

		const items = await stored(host);
		expect(items).toHaveLength(1);
		firstIds = idsOf(items[0]);
		expect(firstIds).toHaveLength(2);
		expect(new Set(firstIds).size).toBe(2);
		for (const id of firstIds) expect(Number.isSafeInteger(id) && id >= 1).toBe(true);

		const sources = items[0]?.sources as Record<string, unknown>[];
		expect(sources[0]).toMatchObject({ type: 'xyz', url: XYZ().url, attribution: 'Example Org' });
		expect(sources[1]).toMatchObject({ type: 'wms', url: WMS().url });
		expect((sources[1] as { params: unknown }).params).toEqual({
			version: '1.3.0',
			layers: 'base',
			styles: '',
			format: 'image/png',
			transparent: false,
			crs: 'EPSG:3857',
		});
		expect(items[0]?.legend).toEqual(LEGEND);
		// the view and the item id are the generic path's, untouched
		expect(items[0]).toMatchObject({ lat: 41.38, lon: 2.17, zoom: 12, alt: 16 });
		// the echo is the stored value, the minted ids included
		expect(result.data).toEqual(items);
	}, 30000);

	test('every source id is above the counter state before the save and the counter is level with them', async () => {
		const items = await stored(host);
		const counter = await counterOf(host);
		const maxId = Math.max(...firstIds, Number(items[0]?.id));
		expect(counter).toBeGreaterThanOrEqual(maxId);
	}, 30000);

	test('saving the whole entry again keeps the ids; only the new source is numbered', async () => {
		const before = await stored(host);
		const itemId = before[0]?.id as number;
		const next = XYZ({ url: 'https://other.example.org/{z}/{x}/{y}.jpg' });
		const result = await save(host, [
			update(
				{ ...before[0], zoom: 13, sources: [...(before[0]?.sources as unknown[]), next] },
				itemId,
			),
		]);
		expect(result.ok).toBe(true);

		const after = await stored(host);
		expect(after).toHaveLength(1);
		const ids = idsOf(after[0]);
		expect(ids.slice(0, 2)).toEqual(firstIds);
		expect(ids).toHaveLength(3);
		expect(ids[2]).toBeGreaterThan(Math.max(...firstIds));
		expect(after[0]?.zoom).toBe(13);
		expect(after[0]?.legend).toEqual(LEGEND);
	}, 30000);

	test('a deleted id is never handed out again: resending the removed source stores a fresh one', async () => {
		const before = await stored(host);
		const itemId = before[0]?.id as number;
		const all = before[0]?.sources as { id: number }[];
		const removed = all[0] as { id: number };
		const survivors = all.slice(1);

		await save(host, [update({ ...before[0], sources: survivors }, itemId)]);
		const afterDelete = await stored(host);
		expect(idsOf(afterDelete[0])).not.toContain(removed.id);

		// an undo / a copy / a re-import resends the source WITH its old id
		const counterBefore = await counterOf(host);
		await save(host, [update({ ...afterDelete[0], sources: [...survivors, removed] }, itemId)]);
		const afterResend = await stored(host);
		const ids = idsOf(afterResend[0]);
		expect(ids).toHaveLength(survivors.length + 1);
		expect(ids).not.toContain(removed.id);
		const issued = ids[ids.length - 1] as number;
		expect(issued).toBeGreaterThan(counterBefore);
		expect(issued).toBeGreaterThan(Math.max(...all.map((source) => source.id)));
		expect(new Set(ids).size).toBe(ids.length);
	}, 30000);

	test('REPLACE semantics: a value sent without the keys stores without them', async () => {
		const before = await stored(host);
		const itemId = before[0]?.id as number;
		await save(host, [update(entry({ zoom: 5 }), itemId)]);
		const after = await stored(host);
		expect(after).toHaveLength(1);
		expect(after[0]).not.toHaveProperty('sources');
		expect(after[0]).not.toHaveProperty('legend');
		expect(after[0]?.zoom).toBe(5);
	}, 30000);

	test('`sources: []` and an empty legend store as no keys at all', async () => {
		const before = await stored(host);
		const itemId = before[0]?.id as number;
		await save(host, [update(entry({ sources: [], legend: { title: '', groups: [] } }), itemId)]);
		const after = await stored(host);
		expect(after[0]).not.toHaveProperty('sources');
		expect(after[0]).not.toHaveProperty('legend');
	}, 30000);
});

describe('a refused save leaves value, counter and history untouched', () => {
	let host = 0;

	test('a private-literal template is refused by the engine; nothing moves', async () => {
		host = await newRecord();
		await save(host, [update(entry({ sources: [XYZ()] }))]);
		const before = await stored(host);
		const counterBefore = await counterOf(host);
		const historyBefore = (await tmRows(host)).length;

		const secret = 'tok_SECRET_4711';
		await expectInvalidData(
			save(host, [
				update(
					{
						...before[0],
						sources: [
							...(before[0]?.sources as unknown[]),
							XYZ({ url: `http://169.254.169.254/{z}/{x}/{y}?key=${secret}` }),
						],
					},
					before[0]?.id as number,
				),
			]),
			/sources\[1\]\.url: the host is a private or loopback address/,
		);
		await expectInvalidData(
			save(host, [
				update(
					entry({
						legend: {
							title: 'x',
							groups: [{ name: 'g', symbols: [{ label: 'l', icon: 'https://example.org/i.png' }] }],
						},
					}),
					before[0]?.id as number,
				),
			]),
			/legend\.groups\[0\]\.symbols\[0\]\.icon/,
		);

		expect(await stored(host)).toEqual(before);
		expect(await counterOf(host)).toBe(counterBefore);
		expect((await tmRows(host)).length).toBe(historyBefore);
	}, 30000);

	test('the refusal never carries the template to the log message', async () => {
		const secret = 'tok_SECRET_0815';
		let message = '';
		try {
			await save(host, [
				update(
					entry({ sources: [XYZ({ url: `ftp://tiles.example.org/{z}/{x}/{y}?key=${secret}` })] }),
				),
			]);
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).not.toBe('');
		expect(message).not.toContain(secret);
	}, 30000);

	test('the WIRE door (dd_core_api save) meets the same gate: typed refusal, then a valid save', async () => {
		const wireRqo = (sources: unknown[]) =>
			({
				action: 'save',
				dd_api: 'dd_core_api',
				source: {
					type: 'component',
					tipo: GEO,
					section_tipo: SECTION,
					section_id: host,
					lang: 'lg-nolan',
				},
				data: { changed_data: [{ action: 'update', key: 0, id: null, value: entry({ sources }) }] },
			}) as unknown as Rqo;

		const before = await stored(host);
		const refused = await dispatchRqo(
			wireRqo([XYZ({ url: 'http://127.0.0.1/{z}/{x}/{y}.png' })]),
			wireContext,
		);
		expect(refused.status).toBe(400);
		const body = refused.body as { ok: boolean; error?: { code?: string } };
		expect(body.ok).toBe(false);
		expect(body.error?.code).toBe('request.invalid_data');
		expect(JSON.stringify(refused.body)).not.toContain('127.0.0.1');
		// `request.invalid_data` is operator-disclosure: the `message` a client receives is the
		// registry's generic one. The failing path and rule are in the log, and under `debug.exception`
		// only when the API-error debug flag is on (WC-2026-11-06-geolocation-map-sources-legend, "The save").
		const envelope = refused.body as { error: { message: string; details?: unknown } };
		expect(envelope.error.message).toBe('Invalid or incomplete request data');
		expect(envelope.error.details).toBeUndefined();
		expect(await stored(host)).toEqual(before);

		const accepted = await dispatchRqo(wireRqo([WMS()]), wireContext);
		expect(accepted.status).toBe(200);
		const after = await stored(host);
		expect(after).toHaveLength(1);
		expect(idsOf(after[0])).toHaveLength(1);
	}, 30000);
});

describe('ONE value object saved into many records (the bulk door) is settled per record', () => {
	const U = XYZ({ url: 'https://u.example.org/{z}/{x}/{y}.png', attribution: 'U' });
	const S = XYZ({ url: 'https://s.example.org/{z}/{x}/{y}.png', attribution: 'S' });

	/** A record that already stores `sources` (saved the ordinary way, so it numbered them). */
	async function recordHolding(sources: unknown[]): Promise<number> {
		const host = await newRecord();
		if (sources.length > 0) await save(host, [update(entry({ sources }))]);
		return host;
	}

	/**
	 * The propagate executor's value: `applyPropagation` hands the SAME array of the SAME
	 * entry objects to every target (propagate.ts normalizeToArray), and each target saves it
	 * as a `set_data`.
	 */
	function propagated(value: unknown[]): unknown[] {
		return applyPropagation([], 'replace', value, false).final;
	}

	test('the premise: the bulk door shares ONE object across its targets', () => {
		const value = [entry({ sources: [S] })];
		const final = propagated(value);
		expect(final[0]).toBe(value[0]);
	});

	// Three target states, each built twice: one twin receives the SHARED object, the other a
	// fresh clone of it. Both twins are born identical, so the engine must settle them
	// identically — to the byte, ids and counter included.
	const STATES: [string, () => unknown[]][] = [
		['empty', () => []],
		['holds a source whose number the first target also issued', () => [U]],
		['already holds the propagated source under its own number (a re-run)', () => [U, S]],
	];

	for (const [name, sourcesOfState] of STATES) {
		test(`target ${name}: shared object = fresh clone`, async () => {
			const shared = propagated([entry({ sources: [S] })]);
			const snapshot = structuredClone(shared);

			// the first target takes the shared object and issues ITS numbers (a young record: 1)
			const first = await recordHolding([]);
			expect((await save(first, [{ action: 'set_data', value: shared }])).ok).toBe(true);
			expect(idsOf((await stored(first))[0])).toHaveLength(1);
			// ...and the shared object did not hear about them
			expect(shared).toEqual(snapshot);

			const viaShared = await recordHolding(sourcesOfState());
			const viaClone = await recordHolding(sourcesOfState());
			expect((await save(viaShared, [{ action: 'set_data', value: shared }])).ok).toBe(true);
			expect(shared).toEqual(snapshot);
			expect(
				(await save(viaClone, [{ action: 'set_data', value: structuredClone(snapshot) }])).ok,
			).toBe(true);

			const [got] = await stored(viaShared);
			const [control] = await stored(viaClone);
			expect(got).toEqual(control);
			expect(await counterOf(viaShared)).toBe(await counterOf(viaClone));
			// the control is not vacuous: whatever the target held, S ends up as the only source
			const sources = got?.sources as Record<string, unknown>[];
			expect(sources.map((source) => source.attribution)).toEqual(['S']);
		}, 60000);
	}

	test('a number the first target issued never overwrites the source another target holds under it', async () => {
		const shared = propagated([entry({ sources: [S] })]);
		const first = await recordHolding([]);
		await save(first, [{ action: 'set_data', value: shared }]);
		const issuedThere = idsOf((await stored(first))[0])[0] as number;

		// this target's own source U holds exactly that number
		const target = await recordHolding([U]);
		const uId = idsOf((await stored(target))[0])[0] as number;
		expect(uId).toBe(issuedThere); // the collision the shared object used to turn into an overwrite

		await save(target, [{ action: 'set_data', value: shared }]);
		const after = (await stored(target))[0];
		// S is a NEW source of this record: a fresh number, above everything the record has issued
		expect(idsOf(after)).toHaveLength(1);
		expect(idsOf(after)[0]).toBeGreaterThan(uId);
	}, 60000);

	test('an ordinary save never writes the sources or the legend of the value it was given', async () => {
		const host = await newRecord();
		const value: Record<string, unknown> = entry({ sources: [XYZ(), WMS()], legend: LEGEND });
		const snapshot = structuredClone(value);
		await save(host, [update(value)]);
		expect(value.sources).toEqual(snapshot.sources);
		expect(value.legend).toEqual(snapshot.legend);
		expect(idsOf((await stored(host))[0])).toHaveLength(2);

		const bulk = [entry({ sources: [XYZ()], legend: LEGEND })];
		const bulkSnapshot = structuredClone(bulk);
		await save(await newRecord(), [{ action: 'set_data', value: bulk }]);
		expect(bulk).toEqual(bulkSnapshot);
	}, 60000);
});

describe('re-importing an UNCHANGED cell writes nothing', () => {
	/** The cell as a hand-written CSV/JSON file has it: no ids anywhere (they are server-issued). */
	const cell = () => ({
		lat: 41.38,
		lon: 2.17,
		zoom: 12,
		alt: 16,
		sources: [XYZ(), WMS()],
		legend: LEGEND,
	});

	/** An import run's save of one cell: a replace under a bulk run id (the undo-log lane). */
	async function importCell(host: number, value: unknown[], run: number) {
		const result = await save(host, [{ action: 'set_data', value }], { bulkProcessId: run });
		expect(result.ok).toBe(true);
	}

	/** Everything a second run must leave exactly as the first left it. */
	async function footprint(host: number) {
		return {
			value: await stored(host),
			counter: await counterOf(host),
			history: (await tmRows(host)).length,
		};
	}

	test('the same id-less cell set twice: bytes, counter and Time Machine are exactly as after the first run', async () => {
		const host = await newRecord();
		const run = await newBulkRun();
		await importCell(host, [cell()], run);
		const afterFirst = await footprint(host);
		expect(idsOf(afterFirst.value[0])).toHaveLength(2);
		expect(afterFirst.history).toBeGreaterThan(0);

		await importCell(host, [cell()], run);
		expect(await footprint(host)).toEqual(afterFirst);

		// and a third, to be sure it is stable and not merely "once"
		await importCell(host, [cell()], run);
		expect(await footprint(host)).toEqual(afterFirst);
	}, 60000);

	test('the cell of a RAW EXPORT (ids and all) re-imported unchanged is the same no-op', async () => {
		const host = await newRecord();
		const run = await newBulkRun();
		await importCell(host, [cell()], run);
		const afterFirst = await footprint(host);
		await importCell(host, structuredClone(afterFirst.value), run);
		expect(await footprint(host)).toEqual(afterFirst);
	}, 60000);

	test('through the import conform: the conformed cell, saved twice, is a no-op the second time', async () => {
		const host = await newRecord();
		const run = await newBulkRun();
		const conform = async () => {
			const conformed = await conformImportData({
				model: 'component_geolocation',
				importValue: JSON.stringify([cell()]),
				columnName: GEO,
				sectionTipo: SECTION,
				sectionId: host,
				componentTipo: GEO,
				lang: 'lg-nolan',
			});
			expect(conformed.errors).toEqual([]);
			return conformed.result as unknown[];
		};
		await importCell(host, await conform(), run);
		const afterFirst = await footprint(host);

		await importCell(host, await conform(), run);
		expect(await footprint(host)).toEqual(afterFirst);
	}, 60000);

	test("an ordinary (non-bulk) re-save keeps the SAME bytes and counter; only its visible history row is the generic engine's", async () => {
		const host = await newRecord();
		await save(host, [{ action: 'set_data', value: [cell()] }]);
		const afterFirst = await footprint(host);
		await save(host, [{ action: 'set_data', value: [cell()] }]);
		const afterSecond = await footprint(host);
		expect(afterSecond.value).toEqual(afterFirst.value);
		expect(afterSecond.counter).toBe(afterFirst.counter);
	}, 60000);

	test('a changed cell is still a change: one edited source is renumbered, the untouched one keeps its id', async () => {
		const host = await newRecord();
		const run = await newBulkRun();
		await importCell(host, [cell()], run);
		const [before] = await stored(host);
		const edited = cell();
		(edited.sources[0] as Record<string, unknown>).attribution = 'edited';
		await importCell(host, [edited], run);
		const [after] = await stored(host);
		const [firstId, secondId] = idsOf(before) as [number, number];
		const ids = idsOf(after);
		expect(ids[1]).toBe(secondId);
		expect(ids[0]).not.toBe(firstId);
		expect((after?.sources as { attribution: string }[])[0]?.attribution).toBe('edited');
	}, 60000);
});

describe('history, duplicate, propagate and read carry the keys', () => {
	let source = 0;
	let copy = 0;

	test('the Time Machine row carries sources and legend', async () => {
		source = await newRecord();
		await save(source, [update(entry({ sources: [XYZ(), WMS()], legend: LEGEND }))]);
		const rows = await tmRows(source);
		expect(rows.length).toBeGreaterThan(0);
		const last = JSON.stringify(rows[rows.length - 1]?.data);
		expect(last).toContain('"sources"');
		expect(last).toContain(XYZ().url.replace(/[{}]/g, (c) => c));
		expect(last).toContain('"legend"');
	}, 30000);

	test('a duplicate carries the keys, and its counter never re-issues a copied source id', async () => {
		copy = await duplicateSectionRecord(SECTION, source, USER_ID);
		created.push(copy);
		const original = await stored(source);
		const duplicated = await stored(copy);
		expect(duplicated).toHaveLength(1);
		expect(duplicated[0]?.sources).toEqual(original[0]?.sources);
		expect(duplicated[0]?.legend).toEqual(original[0]?.legend);

		const taken = idsOf(duplicated[0]);
		const addition = XYZ({ url: 'https://third.example.org/{z}/{x}/{y}.png' });
		await save(copy, [
			update(
				{ ...duplicated[0], sources: [...(duplicated[0]?.sources as unknown[]), addition] },
				duplicated[0]?.id as number,
			),
		]);
		const ids = idsOf((await stored(copy))[0]);
		expect(ids.slice(0, taken.length)).toEqual(taken);
		expect(ids).toHaveLength(taken.length + 1);
		expect(ids[ids.length - 1]).toBeGreaterThan(Math.max(...taken));
		expect(new Set(ids).size).toBe(ids.length);
	}, 60000);

	test('a set_data from ANOTHER record (propagate "replace"): a number the target holds is an EDIT of that source, the rest are numbered', async () => {
		const target = await newRecord();
		await save(target, [update(entry({ sources: [XYZ({ attribution: 'target own' })] }))]);
		const own = await stored(target);
		const ownIds = idsOf(own[0]);

		// the other record's entry, ids and all (they mean nothing in this record)
		const foreign = structuredClone((await stored(source))[0]) as Record<string, unknown>;
		const foreignSources = foreign.sources as Record<string, unknown>[];
		const foreignIds = idsOf(foreign);
		const result = await save(target, [{ action: 'set_data', value: [foreign] }]);
		expect(result.ok).toBe(true);

		const after = await stored(target);
		expect(after).toHaveLength(1);
		const ids = idsOf(after[0]);
		expect(ids).toHaveLength(foreignIds.length);
		expect(new Set(ids).size).toBe(ids.length);
		const finalSources = after[0]?.sources as Record<string, unknown>[];
		for (const [index, id] of ids.entries()) {
			const wanted = foreignIds[index] as number;
			if (ownIds.includes(wanted)) {
				// the id the target holds: honoured by NUMBER, so the foreign content replaced it
				expect(id).toBe(wanted);
			} else {
				// an id the target did not store is replaced by a number from ITS counter
				expect(id).not.toBe(wanted);
			}
			// whichever it is, the CONTENT is the foreign source's
			const { id: _final, ...finalContent } = finalSources[index] as Record<string, unknown>;
			const { id: _sent, ...sentContent } = foreignSources[index] as Record<string, unknown>;
			expect(finalContent).toEqual(sentContent);
		}
		expect(after[0]?.legend).toEqual(LEGEND);
	}, 30000);

	test('a propagate "add" (stored entry + a foreign one) whose small ids COLLIDE saves; the foreign sources are numbered copies', async () => {
		const target = await newRecord();
		await save(target, [update(entry({ sources: [XYZ({ attribution: 'target own' })] }))]);
		const [own] = await stored(target);
		const ownIds = idsOf(own);
		const foreign = structuredClone((await stored(source))[0]) as Record<string, unknown>;
		// the premise of the finding: ids restart on every young record, so they coincide
		expect(idsOf(foreign).some((id) => ownIds.includes(id))).toBe(true);

		const { final, changed } = applyPropagation([own], 'add', [foreign], false);
		expect(changed).toBe(true);
		const result = await save(target, [{ action: 'set_data', value: final }]);
		expect(result.ok).toBe(true);

		const after = await stored(target);
		expect(after).toHaveLength(2);
		// the stored entry keeps its source, id and content
		expect(after[0]?.sources).toEqual(own?.sources);
		// every source id of the component is unique, and the foreign ones are fresh numbers
		const all = after.flatMap((item) => idsOf(item));
		expect(new Set(all).size).toBe(all.length);
		for (const id of idsOf(after[1])) expect(ownIds).not.toContain(id);
		expect(
			(after[1]?.sources as Record<string, unknown>[]).map((candidate) => candidate.url),
		).toEqual((foreign.sources as Record<string, unknown>[]).map((candidate) => candidate.url));
	}, 30000);

	test('the section read: edit returns the keys with the value, list carries the view only', async () => {
		for (const mode of ['list', 'edit'] as const) {
			const response = await dispatchRqo(
				{
					action: 'read',
					dd_api: 'dd_core_api',
					prevent_lock: true,
					options: {},
					source: {
						typo: 'source',
						model: 'section',
						tipo: SECTION,
						section_tipo: SECTION,
						action: 'search',
						mode,
						lang: 'lg-spa',
					},
					sqo: {
						section_tipo: [SECTION],
						limit: 1,
						offset: 0,
						filter_by_locators: [{ section_tipo: SECTION, section_id: String(source) }],
					},
					show: { ddo_map: [{ tipo: GEO, section_tipo: SECTION, parent: SECTION, mode }] },
				} as unknown as Rqo,
				wireContext,
			);
			expect(response.status, mode).toBe(200);
			const text = JSON.stringify(response.body);
			if (mode === 'edit') {
				expect(text, mode).toContain('"sources"');
				expect(text, mode).toContain(XYZ().url);
				expect(text, mode).toContain('"legend"');
			} else {
				// a grid row reads lat/lon: no map definition rides a list page (geo_contract_guards_native)
				expect(text, mode).toContain('"lat"');
				expect(text, mode).not.toContain('"sources"');
				expect(text, mode).not.toContain('"legend"');
				expect(text, mode).not.toContain(XYZ().url);
			}
		}
	}, 30000);
});

describe('the dedalo_raw export carries the keys and re-imports them', () => {
	test('export cell -> unwrap -> conform reproduces sources (ids too) and legend', async () => {
		const host = await newRecord();
		await save(host, [update(entry({ sources: [XYZ(), WMS()], legend: LEGEND }))]);
		const live = (await stored(host))[0] as Record<string, unknown>;

		const principal = await resolvePrincipal(USER_ID);
		const response: ToolResponse = await toolExportGetExportGrid({
			principal,
			userId: USER_ID,
			background: false,
			options: {
				section_tipo: SECTION,
				model: 'section',
				data_format: 'dedalo_raw',
				breakdown: 'default',
				ar_ddo_to_export: [{ path: [{ section_tipo: SECTION, component_tipo: GEO, name: GEO }] }],
				sqo: {
					section_tipo: [SECTION],
					limit: 0,
					offset: 0,
					filter_by_locators: [{ section_tipo: SECTION, section_id: String(host) }],
				},
			},
		} as unknown as ToolActionContext);
		const grid = response.data as {
			columns: { key?: string; i?: number }[];
			rows: { rec?: unknown; c?: Record<string, string> }[];
		};
		const column = grid.columns.find((candidate) => candidate.key === `${SECTION}_${GEO}`);
		expect(column, 'the geolocation column was not minted').toBeDefined();
		const row = grid.rows.find((candidate) => String(candidate.rec) === String(host));
		const cell = row?.c?.[String(column?.i)];
		expect(cell).toBeDefined();
		// the stored bytes, wrapped once — the keys ride verbatim
		expect(JSON.parse(cell as string)).toEqual({ dedalo_data: [live] });

		const unwrapped = unwrapDedaloData(cell as string);
		const conformed = await conformImportData({
			model: 'component_geolocation',
			importValue: unwrapped.value,
			columnName: GEO,
			sectionTipo: SECTION,
			sectionId: host,
			componentTipo: GEO,
			lang: 'lg-nolan',
			wrapped: unwrapped.wrapped,
		});
		expect(conformed.errors).toEqual([]);
		const [item] = conformed.result as Record<string, unknown>[];
		// only the item id is dropped by the conform (as before); the siblings return whole
		expect(item?.sources).toEqual(live.sources);
		expect(item?.legend).toEqual(live.legend);
		expect(item).toMatchObject({ lat: 41.38, lon: 2.17, zoom: 12, alt: 16 });
	}, 30000);
});

describe('a record may store source ids its counter has never counted', () => {
	test('the save raises the counter past them first, so a new id never collides', async () => {
		// A restored or hand-seeded record: sources 50 and 51 stored, counter at 3.
		const host = await newRecord();
		const seededSources = [
			{ id: 50, ...XYZ() },
			{ id: 51, ...WMS() },
		];
		const seeded = entry({ id: 1, sources: seededSources });
		await sql.unsafe(
			`UPDATE ${TABLE}
			 SET geo = jsonb_build_object($3::text, $4::text::jsonb),
			     meta = COALESCE(meta, '{}'::jsonb) || jsonb_build_object($3::text, '[{"count": 3}]'::jsonb)
			 WHERE section_tipo = $1 AND section_id = $2`,
			[SECTION, host, GEO, JSON.stringify([seeded])],
		);
		expect(await counterOf(host)).toBe(3);

		const addition = XYZ({ url: 'https://third.example.org/{z}/{x}/{y}.png' });
		const result = await save(host, [
			update({ ...seeded, sources: [...seededSources, addition] }, 1),
		]);
		expect(result.ok).toBe(true);
		const ids = idsOf((await stored(host))[0]);
		expect(ids.slice(0, 2)).toEqual([50, 51]);
		expect(ids).toHaveLength(3);
		expect(ids[2]).toBeGreaterThan(51);
		expect(await counterOf(host)).toBeGreaterThanOrEqual(ids[2] as number);
	}, 30000);
});

describe('CSV append is layers-only', () => {
	test('onto a stored host, incoming sources and legend never touch the stored ones', async () => {
		const host = await newRecord();
		await save(host, [update(entry({ sources: [XYZ()], legend: LEGEND }))]);
		const before = await stored(host);

		const result = await save(
			host,
			[
				{
					action: 'set_data',
					value: [
						{
							lat: 40.4168,
							lon: -3.7038,
							sources: [WMS()],
							legend: { title: 'incoming', groups: [] },
						},
					],
				},
			],
			{ appendImport: true },
		);
		expect(result.ok).toBe(true);

		const after = await stored(host);
		expect(after).toHaveLength(1);
		// the point became a layer; the sibling keys are exactly as stored
		expect((after[0]?.lib_data as unknown[]) ?? []).toHaveLength(1);
		expect(after[0]?.sources).toEqual(before[0]?.sources);
		expect(after[0]?.legend).toEqual(before[0]?.legend);
		expect(after[0]).toMatchObject({ lat: 41.38, lon: 2.17, zoom: 12 });
	}, 30000);

	test('onto an empty record the first incoming item is stored as is, its sources numbered', async () => {
		const host = await newRecord();
		const result = await save(
			host,
			[{ action: 'set_data', value: [entry({ sources: [WMS()], legend: LEGEND })] }],
			{ appendImport: true },
		);
		expect(result.ok).toBe(true);
		const after = await stored(host);
		expect(after).toHaveLength(1);
		expect(idsOf(after[0])).toHaveLength(1);
		expect(after[0]?.legend).toEqual(LEGEND);
	}, 30000);
});
