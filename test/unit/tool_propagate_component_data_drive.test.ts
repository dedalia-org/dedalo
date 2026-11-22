/**
 * tool_propagate_component_data — HANDLER drive (the pure replace/delete/add
 * core is gated separately in propagate_component_data.test.ts).
 *
 * What this pins, on real scratch records (test2, matrix_test, high ids):
 *  - the imperative tipo-pair WRITE gate (permission: null on the spec, so the
 *    handler is the ONLY gate — a non-admin must be refused before any write);
 *  - the count-drift ceiling (live result wider than the client total aborts
 *    and touches nothing);
 *  - a real replace across several records: value written through the save
 *    door, one visible TM row + one hidden undo-log BEFORE row per record,
 *    every row carrying the run's bulk_process_id (that id is what makes the
 *    batch revertible through tool_time_machine.bulk_revert_process);
 *  - live PROGRESS frames and cooperative ABORT — a backgroundRunnable action
 *    whose client shows a progress line and offers a Stop button must publish
 *    and must stop. Neither was wired before 2026-07-28.
 *
 * The dd800 bulk-process record the run mints is deleted in afterAll.
 */
// Migrated to the generic `test` TLD 2026-08-19: the propagated component is an opaque
// input_text tipo, so it now names the generic `test52`.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { config } from '../../src/config/config.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { termByTipo } from '../../src/core/ontology/labels.ts';
import { runWithRequestLangs } from '../../src/core/resolve/request_lang.ts';
import type { Principal } from '../../src/core/security/permissions.ts';
import { getLoadedTool } from '../../src/core/tools/loader.ts';
import type { ToolActionContext, ToolResponse } from '../../src/core/tools/module.ts';
import { mustGet } from '../helpers/assert.ts';
import { refusalOf } from '../helpers/refusal.ts';
import { cleanScratchRecord, createScratchRecord } from '../helpers/test_data.ts';

const SECTION_TIPO = 'test2';
const COMPONENT_TIPO = 'test52'; // component_input_text (string column)
const LANG = 'lg-spa';
const IDS = [905101, 905102, 905103];
const SUPERUSER: Principal = { userId: -1, isGlobalAdmin: true, isDeveloper: true };
const NO_ACCESS: Principal = { userId: 999999, isGlobalAdmin: false, isDeveloper: false };

const mintedBulkIds: number[] = [];

async function handler(): Promise<(ctx: ToolActionContext) => Promise<ToolResponse>> {
	const loaded = await getLoadedTool('tool_propagate_component_data');
	expect(loaded).not.toBeNull();
	return mustGet(loaded?.module.apiActions.propagate_component_data, 'propagate_component_data')
		.handler;
}

function contextOf(
	options: Record<string, unknown>,
	extra: Partial<ToolActionContext> = {},
): ToolActionContext {
	return {
		principal: SUPERUSER,
		userId: -1,
		options,
		background: false,
		...extra,
	} as ToolActionContext;
}

function optionsFor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		section_tipo: SECTION_TIPO,
		component_tipo: COMPONENT_TIPO,
		action: 'replace',
		lang: LANG,
		total: IDS.length,
		propagate_data_value: [{ lang: LANG, value: 'PROPAGATED' }],
		sqo: {
			section_tipo: [SECTION_TIPO],
			filter_by_locators: IDS.map((id) => ({
				section_tipo: SECTION_TIPO,
				section_id: String(id),
			})),
		},
		...overrides,
	};
}

async function liveValues(): Promise<Record<number, unknown>> {
	const rows = (await sql.unsafe(
		`SELECT section_id, string->'${COMPONENT_TIPO}' AS items FROM matrix_test
		 WHERE section_tipo = $1 AND section_id IN (${IDS.join(',')})`,
		[SECTION_TIPO],
	)) as { section_id: number; items: unknown }[];
	const out: Record<number, unknown> = {};
	for (const row of rows) out[Number(row.section_id)] = row.items;
	return out;
}

async function seed(): Promise<void> {
	for (const id of IDS) {
		await createScratchRecord(SECTION_TIPO, id, {
			string: { [COMPONENT_TIPO]: [{ id: 1, lang: LANG, value: `ORIGINAL-${id}` }] },
		});
	}
}

/**
 * The propagated value as the SAVE DOOR stores it: one item of the run's
 * language carrying the value, and an item id the door stamped (propagate
 * sends none; `set_data` mints it from the record's counter).
 */
function expectPropagated(items: unknown, value: string): void {
	expect(Array.isArray(items)).toBe(true);
	const list = items as Record<string, unknown>[];
	expect(list).toHaveLength(1);
	expect(list[0]).toMatchObject({ lang: LANG, value });
	expect(Number.isInteger(list[0]?.id) && (list[0]?.id as number) > 0).toBe(true);
}

beforeAll(seed);

afterAll(async () => {
	for (const id of IDS) await cleanScratchRecord(SECTION_TIPO, id);
	for (const bulkId of mintedBulkIds) {
		await sql`DELETE FROM matrix_notes WHERE section_tipo = 'dd800' AND section_id = ${bulkId}`;
	}
});

describe('propagate_component_data — gates', () => {
	test('the imperative tipo-pair gate refuses a non-admin and writes NOTHING', async () => {
		const before = await liveValues();
		const run = await handler();
		const refusal = await refusalOf(
			run(contextOf(optionsFor(), { principal: NO_ACCESS, userId: 999999 })),
		);
		expect(refusal.code).toBe('perm.denied');
		expect(await liveValues()).toEqual(before);
	});

	test('missing/invalid parameters are refused before any search', async () => {
		const run = await handler();
		for (const bad of [
			optionsFor({ action: 'obliterate' }),
			optionsFor({ component_tipo: '' }),
			{ ...optionsFor(), sqo: undefined },
		]) {
			const refusal = await refusalOf(run(contextOf(bad)));
			expect(refusal.code).toBe('request.invalid_options');
		}
	});

	test("'add' is refused on a mono-value model", async () => {
		const run = await handler();
		// component_select declares the `monovalue` facet; test2 has no select child,
		// so use the section's own dd-level select if present — otherwise assert
		// the guard through a model that IS mono-value on this install.
		const monoTipo = (await sql`
			SELECT tipo FROM dd_ontology WHERE model = 'component_text_area' LIMIT 1
		`) as { tipo: string }[];
		const tipo = monoTipo[0]?.tipo;
		expect(typeof tipo).toBe('string');
		const refusal = await refusalOf(
			run(contextOf(optionsFor({ component_tipo: tipo, action: 'add' }))),
		);
		expect(refusal.code).toBe('request.invalid_options');
		expect(refusal.publicMessage).toContain('mono-value');
	});

	test('count drift (live wider than the client total) aborts and writes NOTHING', async () => {
		const before = await liveValues();
		const run = await handler();
		const refusal = await refusalOf(run(contextOf(optionsFor({ total: 1 }))));
		expect(refusal.code).toBe('resource.conflict');
		expect(refusal.message).toContain('count drift');
		expect(await liveValues()).toEqual(before);
	});
});

describe('propagate_component_data — the write', () => {
	test('replace writes every matched record + a bulk-tagged TM row each', async () => {
		const run = await handler();
		const response = await run(contextOf(optionsFor()));
		expect(response.ok).toBe(true);
		const data = response.data as { counter: number; bulk_process_id: number | null };
		expect(data.counter).toBe(IDS.length);
		const bulkId = data.bulk_process_id;
		if (typeof bulkId === 'number') mintedBulkIds.push(bulkId);

		const values = await liveValues();
		for (const id of IDS) expectPropagated(values[id], 'PROPAGATED');

		// Per record: ONE visible TM row (the persisted value) and ONE hidden
		// undo-log BEFORE row (tm_role 1, the seeded slice), both carrying the
		// run's bulk_process_id — the handle bulk_revert_process needs
		// (WC-2026-09-27-bulk-revert-undo-log: propagate saves through the
		// save door, under a lock, one language region per record).
		const tm = (await sql.unsafe(
			`SELECT id, section_id, bulk_process_id, tm_role, data FROM matrix_time_machine
			 WHERE section_tipo = $1 AND tipo = $2 AND section_id IN (${IDS.join(',')})
			 ORDER BY id`,
			[SECTION_TIPO, COMPONENT_TIPO],
		)) as {
			id: number;
			section_id: number;
			bulk_process_id: number | null;
			tm_role: number | null;
			data: unknown;
		}[];
		// + ONE save-before row per record (re-pinned 2026-11-12, T1-21): the seed
		// is RAW (no history), so the writer first records the original value as
		// ordinary visible history — no bulk id, no role — then the run's pair.
		expect(tm.length).toBe(IDS.length * 3);
		for (const id of IDS) {
			const own = tm.filter((row) => Number(row.section_id) === id);
			expect(own.map((row) => [row.tm_role, row.bulk_process_id])).toEqual([
				[null, null],
				[1, bulkId],
				[null, bulkId],
			]);
			expect(own[0]?.data).toEqual([{ id: 1, lang: LANG, value: `ORIGINAL-${id}` }]);
			expect(own[1]?.data).toEqual([{ id: 1, lang: LANG, value: `ORIGINAL-${id}` }]);
			expect(own[2]?.data).toEqual(values[id]);
		}
	});

	test('a second identical run is a NO-OP (changed:false skips the save)', async () => {
		const run = await handler();
		const tmBefore = (await sql.unsafe(
			`SELECT count(*)::int AS c FROM matrix_time_machine
			 WHERE section_tipo = $1 AND tipo = $2 AND section_id IN (${IDS.join(',')})`,
			[SECTION_TIPO, COMPONENT_TIPO],
		)) as { c: number }[];
		const response = await run(contextOf(optionsFor()));
		expect(response.ok).toBe(true);
		const bulkProcessId = (response.data as { bulk_process_id?: unknown }).bulk_process_id;
		if (typeof bulkProcessId === 'number') mintedBulkIds.push(bulkProcessId);
		const tmAfter = (await sql.unsafe(
			`SELECT count(*)::int AS c FROM matrix_time_machine
			 WHERE section_tipo = $1 AND tipo = $2 AND section_id IN (${IDS.join(',')})`,
			[SECTION_TIPO, COMPONENT_TIPO],
		)) as { c: number }[];
		expect(tmAfter[0]?.c).toBe(tmBefore[0]?.c as number);
	});
});

describe('propagate_component_data — background wire', () => {
	test('publishes progress frames the client panel can render', async () => {
		await seed(); // undo the replace above so this run changes something
		const frames: Record<string, unknown>[] = [];
		const run = await handler();
		const response = await run(
			contextOf(optionsFor({ propagate_data_value: [{ lang: LANG, value: 'PROGRESS-RUN' }] }), {
				background: true,
				publishProgress: (data) => {
					frames.push(data as Record<string, unknown>);
				},
			}),
		);
		expect(response.ok).toBe(true);
		const progressBulkId = (response.data as { bulk_process_id?: unknown }).bulk_process_id;
		if (typeof progressBulkId === 'number') mintedBulkIds.push(progressBulkId);
		// The fields render_tool_propagate_component_data.js compound_msg reads.
		expect(frames.length).toBeGreaterThan(1);
		const last = frames[frames.length - 1] as Record<string, unknown>;
		expect(typeof last.msg).toBe('string');
		expect(last.total).toBe(IDS.length);
		expect(last.counter).toBe(IDS.length);
		expect((last.current as { section_id?: number } | undefined)?.section_id).toBe(
			IDS[IDS.length - 1] as number,
		);
	});

	test("'add' over a PHP-era SINGLE-OBJECT stored value keeps it — the value is the one item it is", async () => {
		// The locked read answered [] for a non-array value: 'add' then decided
		// over nothing and set_data REPLACED the stored item. Read the way the
		// save path and every reader read it ([raw]), the item stays.
		const id = IDS[0] as number;
		await cleanScratchRecord(SECTION_TIPO, id);
		await createScratchRecord(SECTION_TIPO, id, {
			string: { [COMPONENT_TIPO]: { id: 1, lang: LANG, value: 'SINGLE' } },
		});
		const run = await handler();
		const response = await run(
			contextOf(
				optionsFor({
					action: 'add',
					total: 1,
					propagate_data_value: [{ lang: LANG, value: 'ADDED' }],
					sqo: {
						section_tipo: [SECTION_TIPO],
						filter_by_locators: [{ section_tipo: SECTION_TIPO, section_id: String(id) }],
					},
				}),
			),
		);
		expect(response.ok).toBe(true);
		const bulkId = (response.data as { bulk_process_id?: unknown }).bulk_process_id;
		if (typeof bulkId === 'number') mintedBulkIds.push(bulkId);
		const stored = (await liveValues())[id] as { value?: unknown }[];
		expect(Array.isArray(stored)).toBe(true);
		expect(stored.map((item) => item.value)).toEqual(['SINGLE', 'ADDED']);
		await cleanScratchRecord(SECTION_TIPO, id);
		await seed();
	});

	test('an aborted signal stops the batch mid-run and leaves the rest untouched', async () => {
		await seed();
		const controller = new AbortController();
		const run = await handler();
		const response = await run(
			contextOf(optionsFor({ propagate_data_value: [{ lang: LANG, value: 'ABORTED-RUN' }] }), {
				background: true,
				signal: controller.signal,
				// Abort as soon as the FIRST record has been processed.
				publishProgress: (data) => {
					if ((data as { counter?: number }).counter === 1) controller.abort();
				},
			}),
		);
		expect(response.ok).toBe(true);
		const stoppedData = response.data as {
			stopped: boolean;
			counter: number;
			bulk_process_id?: unknown;
		};
		expect(stoppedData.stopped).toBe(true);
		expect(stoppedData.counter).toBe(1);
		if (typeof stoppedData.bulk_process_id === 'number') {
			mintedBulkIds.push(stoppedData.bulk_process_id);
		}
		const values = await liveValues();
		expectPropagated(values[IDS[0] as number], 'ABORTED-RUN');
		// The records the abort skipped keep their seeded value.
		expect(values[IDS[2] as number]).toEqual([{ id: 1, lang: LANG, value: `ORIGINAL-${IDS[2]}` }]);
	});
});

describe('T2-OX7-1a: the section label speaks the REQUEST application lang', () => {
	test('section_label is the term in the request lang, not the install DEDALO_APPLICATION_LANG', async () => {
		// The request lang is chosen to DIFFER from the install default and to name
		// the section differently — otherwise the two readings coincide and the
		// case proves nothing.
		const requestLang = config.menu.applicationLang === 'lg-spa' ? 'lg-eng' : 'lg-spa';
		// The LABELLED section is the declared one (test3: named per language);
		// the rows are still this file's scratch records.
		const labelled = 'test3';
		const wanted = await termByTipo(labelled, requestLang);
		const installTerm = await termByTipo(labelled, config.menu.applicationLang);
		expect(wanted).not.toBe(installTerm);
		const run = await handler();
		const response = await runWithRequestLangs(
			{ applicationLang: requestLang, dataLang: LANG },
			() =>
				run(
					contextOf(
						optionsFor({
							section_tipo: labelled,
							action: 'delete',
							propagate_data_value: [{ lang: LANG, value: 'never stored' }],
						}),
					),
				),
		);
		const data = response.data as { section_label: string; bulk_process_id?: unknown };
		if (typeof data.bulk_process_id === 'number') mintedBulkIds.push(data.bulk_process_id);
		expect(data.section_label).toBe(wanted);
	});
});
