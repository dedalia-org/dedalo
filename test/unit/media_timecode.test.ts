/**
 * Phase E tail gate: tool_tc timecode offset (pure transform) + module load.
 * The transform clamps at zero and applies positive offsets in reverse order to
 * avoid collisions (PHP replace_tc_codes).
 */
// MIGRATED TO THE GENERIC `test` TLD, 2026-08-19: every install tipo this gate
// spelled is now its generic twin (sections on the `test` TLD, storing in
// matrix_test). A pure rename — the tipo is an identifier in a path, a filename
// or a locator here, so no corpus and no DB round-trip were added.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from '../../src/core/db/postgres.ts';
import { replaceTimecodes } from '../../src/core/media/tools/timecode.ts';
import type { Principal } from '../../src/core/security/permissions.ts';
import { getLoadedTool } from '../../src/core/tools/loader.ts';
import type { ToolResponse } from '../../src/core/tools/module.ts';
import { refusalOf } from '../helpers/refusal.ts';
import { cleanScratchRecord, createScratchRecord } from '../helpers/test_data.ts';

describe('replaceTimecodes (PHP replace_tc_codes)', () => {
	test('positive offset shifts every mark', () => {
		const text = 'a [TC_00:00:10.000_TC] b [TC_00:00:20.000_TC] c';
		const { text: out, changes } = replaceTimecodes(text, 5);
		expect(out).toContain('[TC_00:00:15.000_TC]');
		expect(out).toContain('[TC_00:00:25.000_TC]');
		expect(changes['00:00:10.000']).toBe('00:00:15.000');
	});

	test('negative offset clamps at zero', () => {
		const { text } = replaceTimecodes('x [TC_00:00:03.000_TC] y', -10);
		expect(text).toContain('[TC_00:00:00.000_TC]');
	});

	test('positive offset that would collide is applied in reverse (no double-shift)', () => {
		// If applied forward, shifting 10→20 first would then re-match the original 20.
		const text = '[TC_00:00:10.000_TC] [TC_00:00:20.000_TC]';
		const { text: out } = replaceTimecodes(text, 10);
		// 10→20, 20→30 — each mark shifted exactly once.
		expect(out).toBe('[TC_00:00:20.000_TC] [TC_00:00:30.000_TC]');
	});

	test('no marks / empty / non-finite → unchanged', () => {
		expect(replaceTimecodes('no timecodes here', 5).text).toBe('no timecodes here');
		expect(replaceTimecodes('', 5).text).toBe('');
		expect(replaceTimecodes('[TC_00:00:10.000_TC]', Number.NaN).text).toBe('[TC_00:00:10.000_TC]');
	});
});

describe('tool_tc module', () => {
	test('loads with a record-scope write gate', async () => {
		const loaded = await getLoadedTool('tool_tc');
		expect(loaded?.module.apiActions.change_all_timecodes?.permission).toBe('record_tipo');
		expect(loaded?.module.apiActions.change_all_timecodes?.minLevel).toBe(2);
		// A bulk rewrite of a whole transcription is not offered as a background
		// job — nothing may be background-runnable that the gate above does not
		// already cover (TOOLS_SPEC gate 7 runs BEFORE the fork).
		expect(loaded?.module.backgroundRunnable).toBeUndefined();
	});
});

/**
 * change_all_timecodes ARGUMENT VALIDATION (audit 2026-07-28). Every case here
 * returns before the save loop, so the drive is read-only — the point is that a
 * malformed bulk-rewrite request can never reach saveComponentData.
 */
describe('tool_tc change_all_timecodes validation', () => {
	const principal: Principal = { userId: -1, isGlobalAdmin: true, isDeveloper: true };

	async function drive(options: Record<string, unknown>): Promise<ToolResponse> {
		const loaded = await getLoadedTool('tool_tc');
		return loaded!.module.apiActions.change_all_timecodes!.handler({
			principal,
			userId: -1,
			options,
			background: false,
		});
	}

	/** The refusal's PUBLIC sentence (request.invalid_options has public disclosure). */
	async function refusalMessage(options: Record<string, unknown>): Promise<string | undefined> {
		return (await refusalOf(drive(options))).publicMessage;
	}

	test('the locator triple AND lang are required', async () => {
		const expected = 'component_tipo, section_tipo, a positive section_id and lang are required';
		expect(await refusalMessage({})).toBe(expected);
		expect(await refusalMessage({ component_tipo: 'test17', section_tipo: 'test3' })).toBe(
			expected,
		);
		expect(
			await refusalMessage({ component_tipo: 'test17', section_tipo: 'test3', section_id: 0 }),
		).toBe(expected);
		expect(
			await refusalMessage({ component_tipo: 'test17', section_tipo: 'test3', section_id: -3 }),
		).toBe(expected);
		// PHP `empty($lang)` — a missing/blank lang is a MALFORMED request, never a
		// silent lg-nolan default (which would address a slice the caller never named).
		expect(
			await refusalMessage({ component_tipo: 'test17', section_tipo: 'test3', section_id: 3 }),
		).toBe(expected);
		expect(
			await refusalMessage({
				component_tipo: 'test17',
				section_tipo: 'test3',
				section_id: 3,
				lang: '',
			}),
		).toBe(expected);
	});

	test('T2-S05-b: tipo and component_tipo naming DIFFERENT components is refused by the handler itself', async () => {
		// The record_tipo gate refuses this too; the handler must not pick one alias
		// when called without it (the pair written is the pair authorized).
		expect(
			await refusalMessage({
				tipo: 'test17',
				component_tipo: 'test52',
				section_tipo: 'test3',
				section_id: 1,
				lang: 'lg-spa',
			}),
		).toBe('tipo and component_tipo name different components');
		// The SAME tipo under both keys is one target, not a conflict: past the
		// alias check (refused further down only because the record does not exist).
		const agreed = await refusalOf(
			drive({
				tipo: 'test17',
				component_tipo: 'test17',
				section_tipo: 'test3',
				section_id: 99999999,
				lang: 'lg-spa',
			}),
		);
		expect(agreed.publicMessage).not.toBe('tipo and component_tipo name different components');
	});

	test("T2-S05-b: a non-positive section_id is refused by the handler's own write door (lang present)", async () => {
		for (const sectionId of [0, -3]) {
			const refusal = await refusalOf(
				drive({
					component_tipo: 'test17',
					section_tipo: 'test3',
					section_id: sectionId,
					lang: 'lg-spa',
				}),
			);
			expect({
				sectionId,
				door: refusal.code.startsWith('perm.') || refusal.code.startsWith('request.invalid'),
			}).toEqual({
				sectionId,
				door: true,
			});
		}
	});

	test('a non-numeric offset is refused', async () => {
		expect(
			await refusalMessage({
				component_tipo: 'test17',
				section_tipo: 'test3',
				section_id: 1,
				lang: 'lg-spa',
				offset_seconds: 'later',
			}),
		).toBe('offset_seconds must be a number');
	});

	test('an unknown component / missing record fails cleanly (no save)', async () => {
		// An unknown component is an invalid TIPO; a missing record is not-found —
		// two different registered codes where the legacy body had two sentences.
		const unknownTipo = await refusalOf(
			Promise.resolve(
				drive({
					component_tipo: 'nope999',
					section_tipo: 'test3',
					section_id: 1,
					lang: 'lg-spa',
				}),
			),
		);
		expect(unknownTipo.code).toBe('request.invalid_tipo');
		const missingRecord = await refusalOf(
			Promise.resolve(
				drive({
					component_tipo: 'test17',
					section_tipo: 'test3',
					section_id: 99999999,
					lang: 'lg-spa',
				}),
			),
		);
		expect(missingRecord.code).toBe('tool.target_not_found');
	});
});

/**
 * change_all_timecodes THE WRITE (audit 2026-07-28, group B) — driven on a real
 * scratch record (test2 → matrix_test, reserved high ids), because the three
 * defects closed here are only observable against stored data:
 *
 *  1. ATOMICITY: PHP did ONE set_data_lang() + save() for the whole item set; the
 *     port saved once PER ITEM, so a mid-loop failure left the transcription
 *     HALF-OFFSET. The mechanical proof is the Time Machine row count: one
 *     invocation must append exactly ONE audit row however many items it rewrites.
 *  2. The `key` filter indexes the LANG SLICE (PHP get_data_lang runs
 *     array_values, so $raw_key is 0..n-1 WITHIN the slice), not the full stored
 *     array — and the returned map is keyed by that same slice index.
 *  3. `result` is the audit map whenever the request was well-formed, even when
 *     nothing moved (PHP returns $ar_replaced unconditionally); `false` is
 *     reserved for an actual failure.
 *
 * The seed deliberately puts the OTHER language FIRST, so slice index 0 and full
 * array index 0 are different items — a port that indexes the wrong array cannot
 * pass by coincidence.
 */
describe('tool_tc change_all_timecodes — the write', () => {
	const SECTION_TIPO = 'test2';
	const TABLE = 'matrix_test';
	const COMPONENT_TIPO = 'dd1005'; // component_text_area, ontology-translatable, string column
	const SECTION_ID = 906101;
	const principal: Principal = { userId: -1, isGlobalAdmin: true, isDeveloper: true };

	type Item = { id: number; lang: string; value: string };
	const SEED: Item[] = [
		{ id: 1, lang: 'lg-eng', value: 'EN [TC_00:00:10.000_TC]' },
		{ id: 2, lang: 'lg-spa', value: 'ES-A [TC_00:01:00.000_TC]' },
		{ id: 3, lang: 'lg-spa', value: 'ES-B [TC_00:02:00.000_TC]' },
		{ id: 4, lang: 'lg-fra', value: 'FR without marks' },
	];

	async function seed(): Promise<void> {
		await createScratchRecord(SECTION_TIPO, SECTION_ID, {
			string: { [COMPONENT_TIPO]: SEED },
		});
	}

	async function storedItems(): Promise<Item[]> {
		const rows = (await sql.unsafe(
			`SELECT string->'${COMPONENT_TIPO}' AS items FROM "${TABLE}"
			 WHERE section_tipo = $1 AND section_id = $2`,
			[SECTION_TIPO, SECTION_ID],
		)) as { items: Item[] | null }[];
		return rows[0]?.items ?? [];
	}

	function itemValue(items: Item[], id: number): string | undefined {
		return items.find((item) => item.id === id)?.value;
	}

	async function tmCount(): Promise<number> {
		const rows = (await sql`
			SELECT count(*)::int AS n FROM matrix_time_machine
			WHERE section_tipo = ${SECTION_TIPO} AND section_id = ${SECTION_ID}
		`) as { n: number }[];
		return rows[0]?.n ?? 0;
	}

	async function drive(options: Record<string, unknown>): Promise<ToolResponse> {
		const loaded = await getLoadedTool('tool_tc');
		return loaded!.module.apiActions.change_all_timecodes!.handler({
			principal,
			userId: -1,
			options,
			background: false,
		});
	}

	function optionsFor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
		return {
			component_tipo: COMPONENT_TIPO,
			section_tipo: SECTION_TIPO,
			section_id: SECTION_ID,
			lang: 'lg-spa',
			offset_seconds: 5,
			key: null,
			...overrides,
		};
	}

	beforeAll(seed);
	afterAll(() => cleanScratchRecord(SECTION_TIPO, SECTION_ID, TABLE));

	test('the whole lang slice is offset in ONE save (one TM row) and keyed by slice index', async () => {
		await seed();
		await sql`DELETE FROM matrix_time_machine
			WHERE section_tipo = ${SECTION_TIPO} AND section_id = ${SECTION_ID}`;

		const response = await drive(optionsFor());

		// The audit map is keyed by the LANG-SLICE index (0,1), not by the stored
		// array index (1,2) — the lg-eng item at position 0 is not in the slice.
		expect((response.data as { changes: unknown }).changes).toEqual({
			'0': { '00:01:00.000': '00:01:05.000' },
			'1': { '00:02:00.000': '00:02:05.000' },
		});

		const items = await storedItems();
		expect(itemValue(items, 2)).toBe('ES-A [TC_00:01:05.000_TC]');
		expect(itemValue(items, 3)).toBe('ES-B [TC_00:02:05.000_TC]');
		// Sibling languages are untouched by a lang-sliced write.
		expect(itemValue(items, 1)).toBe('EN [TC_00:00:10.000_TC]');
		expect(itemValue(items, 4)).toBe('FR without marks');

		// ATOMICITY: two items rewritten, ONE save → exactly ONE audit row, after
		// the save-before row of the RAW-seeded spa slice (re-pinned 2026-11-12,
		// T1-21) — two rows, never one per item.
		expect(await tmCount()).toBe(2);
	});

	test("the 'key' filter selects within the lang slice (key 0 = the FIRST lg-spa item)", async () => {
		await seed();
		const response = await drive(optionsFor({ key: 0 }));

		expect((response.data as { changes: unknown }).changes).toEqual({
			'0': { '00:01:00.000': '00:01:05.000' },
		});

		const items = await storedItems();
		expect(itemValue(items, 2)).toBe('ES-A [TC_00:01:05.000_TC]');
		// key 0 addressed slice[0]; slice[1] and the other langs are untouched.
		expect(itemValue(items, 3)).toBe('ES-B [TC_00:02:00.000_TC]');
		expect(itemValue(items, 1)).toBe('EN [TC_00:00:10.000_TC]');
	});

	test('a well-formed request that moves nothing returns the MAP, not false', async () => {
		await seed();
		await sql`DELETE FROM matrix_time_machine
			WHERE section_tipo = ${SECTION_TIPO} AND section_id = ${SECTION_ID}`;
		const before = await storedItems();

		// lg-fra holds a single mark-free item: PHP still returns $ar_replaced
		// (one empty entry per processed key).
		const response = await drive(optionsFor({ lang: 'lg-fra' }));
		expect((response.data as { changes: unknown }).changes).toEqual({ '0': {} });

		// …and, unlike PHP, a no-op does NOT rewrite the record: no audit row, no
		// falsified modified stamp (documented divergence, WC-061).
		expect(await storedItems()).toEqual(before);
		expect(await tmCount()).toBe(0);
	});

	test('an empty lang slice is a well-formed no-op, not an error', async () => {
		await seed();
		const before = await storedItems();
		const response = await drive(optionsFor({ lang: 'lg-deu' }));
		expect((response.data as { changes: unknown }).changes).toEqual({});
		expect(await storedItems()).toEqual(before);
	});
});
