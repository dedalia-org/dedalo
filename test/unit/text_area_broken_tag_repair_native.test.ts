/**
 * T1-41 / O06 — the edit-read TAG INTEGRITY repair of a transcription (PHP
 * component_text_area::fix_broken_index_tags, run by component_text_area_json
 * on every EDIT item of a text_area declaring `tags_index` / `tags_draw`;
 * WC-2026-11-13-text-area-broken-tag-repair). Before this gate the TS engine
 * served the stored text verbatim: an unpaired index mark or an indexation
 * whose mark was lost never surfaced, so the user could not see — let alone
 * re-place — what the indexation portal still pointed at.
 *
 * P* — the pure repair (tag_integrity.ts), expected strings HAND-WRITTEN from
 *      the PHP algorithm + the WC's deliberate divergences.
 * S* — the real read through readSection on the `zztags` scratch situation
 *      (test/helpers/zztags_situation.ts: zztags2 declares tags_index → zztags3
 *      and tags_draw → zztags11), records written to the marked suite DB at
 *      explicit ids, purged before/after with their TM tail, residue asserted.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { textAreaEmitHook } from '../../src/core/components/component_text_area/emit.ts';
import {
	buildDrawTag,
	buildIndexTag,
	repairBrokenTags,
} from '../../src/core/components/component_text_area/tag_integrity.ts';
import { readMatrixRecord } from '../../src/core/db/matrix.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { getMatrixTableFromTipo } from '../../src/core/ontology/resolver.ts';
import { EmissionContext } from '../../src/core/resolve/component_data.ts';
import { readSection } from '../../src/core/section/read.ts';
import { dropSituation, ensureSituation } from '../../src/core/test_data/situations/situation.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { mustGet } from '../helpers/assert.ts';
import {
	ZZTAGS_DRAW_PORTAL,
	ZZTAGS_NOTE_BODY,
	ZZTAGS_NOTE_SECTION,
	ZZTAGS_SECTION,
	ZZTAGS_SITUATION,
	ZZTAGS_TAGS_INDEX,
	ZZTAGS_TEXT_AREA,
} from '../helpers/zztags_situation.ts';

// ---------------------------------------------------------------------------
// P* — the pure repair
// ---------------------------------------------------------------------------

describe('repairBrokenTags — unpaired marks (PHP missing-in / missing-out loops)', () => {
	test('P1 an out mark with no open gets a blue open RIGHT BEFORE it, label + data copied', () => {
		const repair = repairBrokenTags('a [/index-n-3-x-data:a:data] b', [], []);
		expect(repair.text).toBe('a [index-d-3-x-data:a:data][/index-n-3-x-data:a:data] b');
		expect(repair.changedTags).toBe(1);
		expect(repair.addedTags).toBe(0);
	});

	test('P2 an open mark with no close gets a blue close RIGHT AFTER it', () => {
		expect(repairBrokenTags('[index-n-4--data::data] x', [], []).text).toBe(
			'[index-n-4--data::data][/index-d-4--data::data] x',
		);
	});

	test('P2b a bare mark (no tail) is a mark too: its partner carries empty label/data', () => {
		expect(repairBrokenTags('x [/index-r-12] y', [], []).text).toBe(
			'x [index-d-12--data::data][/index-r-12] y',
		);
	});

	test('P2c pairing is by id, not state; ids compare by value (PHP loose ==)', () => {
		const text = '[index-n-7]a[/index-r-07]';
		const repair = repairBrokenTags(text, ['7'], []);
		expect(repair).toEqual({ text, changedTags: 0, addedTags: 0 });
	});

	test('P2d at a shared position the synthetic CLOSE comes before the synthetic OPEN (PHP loop order)', () => {
		expect(repairBrokenTags('[index-n-1][/index-n-2]', [], []).text).toBe(
			'[index-n-1][/index-d-1--data::data][index-d-2--data::data][/index-n-2]',
		);
	});

	test('P5 the same unpaired mark twice: ONE partner before EACH occurrence (divergence 1)', () => {
		const repair = repairBrokenTags('[/index-n-3] mid [/index-n-3]', [], []);
		expect(repair.text).toBe(
			'[index-d-3--data::data][/index-n-3] mid [index-d-3--data::data][/index-n-3]',
		);
		expect(repair.changedTags).toBe(2);
	});

	test('P5b each FAMILY scans on its own (PHP: one preg_match_all per family), partners go at MATCHED positions only', () => {
		// The out-9 inside the OPEN tag's data IS an indexOut match (the in and
		// out scans do not see each other's spans) and gets its partner there;
		// the second `[/index-n-9]` lies inside the out-1 MATCH, so it is not a
		// match of its own and is left alone (PHP's str_replace rewrote every
		// occurrence of the string — divergence 1).
		const text =
			"[index-n-1-l-data:{'x':'[/index-n-9]'}:data]t[/index-n-1-l-data:{'x':'[/index-n-9]'}:data]";
		expect(repairBrokenTags(text, [], []).text).toBe(
			"[index-n-1-l-data:{'x':'[index-d-9--data::data][/index-n-9]'}:data]t[/index-n-1-l-data:{'x':'[/index-n-9]'}:data]",
		);
	});

	test('P5c a tail broken by a newline falls back to no match (PCRE `.` excludes \\n)', () => {
		const text = '[/index-n-5-l-data:a\nb:data]';
		expect(repairBrokenTags(text, [], []).text).toBe(text);
	});

	test('P5d data `"` becomes `\'` in a synthetic tag (TR::build_tag)', () => {
		expect(buildIndexTag('out', 'd', '3', 'l', '{"a":1}')).toBe("[/index-d-3-l-data:{'a':1}:data]");
		expect(buildDrawTag('d', '9', '9:', '')).toBe('[draw-d-9-9:-data::data]');
	});
});

describe('repairBrokenTags — orphan locators (PHP get_component_tags_data loops)', () => {
	test('P3 index orphans are PREPENDED one pair per id, so the last one ends up first', () => {
		const repair = repairBrokenTags('<p>t</p>', ['7', '8'], []);
		expect(repair.text).toBe(
			'[index-d-8--data::data][/index-d-8--data::data][index-d-7--data::data][/index-d-7--data::data]<p>t</p>',
		);
		expect(repair.addedTags).toBe(2);
	});

	test('P3b a locator id present as an open OR a close mark is not an orphan', () => {
		const text = '[index-n-7]a[/index-n-7] [/index-n-8]';
		expect(repairBrokenTags(text, ['7', '8'], []).text).toBe(
			'[index-n-7]a[/index-n-7] [index-d-8--data::data][/index-n-8]',
		);
	});

	test('P4 a draw orphan is prepended as [draw-d-<id>-<id>:-data::data]; one in the text is not', () => {
		expect(repairBrokenTags('x', [], ['9']).text).toBe('[draw-d-9-9:-data::data]x');
		const present = "x[draw-n-9-9:-data:{'a':1}:data]";
		expect(repairBrokenTags(present, [], ['9']).text).toBe(present);
	});

	test('P4b draws go in front of index pairs (PHP prepends draws last)', () => {
		expect(repairBrokenTags('x', ['1'], ['2']).text).toBe(
			'[draw-d-2-2:-data::data][index-d-1--data::data][/index-d-1--data::data]x',
		);
	});

	test('P6 a tag_id without the grammar id shape never reaches the text (divergence 2); 7 / 07 dedupe', () => {
		const repair = repairBrokenTags(
			'x',
			['1]<img src=x onerror=alert(1)>', '', 'abc', '1234567', '7', '07'],
			['<b>'],
		);
		expect(repair.text).toBe('[index-d-7--data::data][/index-d-7--data::data]x');
		expect(repair.addedTags).toBe(1);
	});

	test('P7 a healthy text with every locator present comes back as the SAME string, counts 0', () => {
		const text =
			"<p>[index-n-1-a-data:x:data]t[/index-n-1-a-data:x:data][draw-n-2-2:-data:{'p':1}:data]</p>";
		const repair = repairBrokenTags(text, ['1'], ['2']);
		expect(repair).toEqual({ text, changedTags: 0, addedTags: 0 });
	});

	test('P8 1 MB of adversarial unterminated heads repairs in linear-ish time (the tail regex is quadratic)', () => {
		const text = '[index-n-1-a-data:'.repeat(Math.ceil(1_000_000 / 18));
		const started = performance.now();
		const repair = repairBrokenTags(text, ['5'], ['6']);
		const elapsed = performance.now() - started;
		// None of the heads resolves a tail, so only the orphans are added.
		expect(repair.addedTags).toBe(2);
		expect(repair.changedTags).toBe(0);
		expect(elapsed).toBeLessThan(300);
	});
});

// ---------------------------------------------------------------------------
// S* — the real edit read on the scratch situation
// ---------------------------------------------------------------------------

const HOST_ID = 934120;
const NOTE_ID = 934121;
let HOST_TABLE = 'matrix_test';
let NOTE_TABLE = 'matrix_test';

const STORED_TEXT =
	'<p>A [/index-n-3-x-data:a:data] B [index-n-4--data::data] C ' +
	'[index-n-5--data::data]paired[/index-n-5--data::data]</p>';

/** Index locators: 3/4 have a (broken) mark, 7 twice (int + string), 8 orphan, bad ids. */
const INDEX_LOCATORS = [
	{ tag_id: '3', section_tipo: 'test3', section_id: 1 },
	{ tag_id: 4, section_tipo: 'test3', section_id: 1 },
	{ tag_id: 7, section_tipo: 'test3', section_id: 2 },
	{ tag_id: '7', section_tipo: 'test3', section_id: 3 },
	{ tag_id: '8', section_tipo: 'test3', section_id: 1 },
	{ tag_id: '1]<img src=x onerror=alert(1)>', section_tipo: 'test3', section_id: 1 },
	{ tag_id: null, section_tipo: 'test3', section_id: 1 },
	{ section_tipo: 'test3', section_id: 1 },
].map((locator, index) => ({
	id: index + 1,
	type: 'dd96',
	from_component_tipo: ZZTAGS_TAGS_INDEX,
	tag_component_tipo: ZZTAGS_TEXT_AREA,
	...locator,
}));

const DRAW_LOCATORS = [
	{
		id: 1,
		type: 'dd96',
		tag_id: '9',
		section_tipo: 'test3',
		section_id: 1,
		from_component_tipo: ZZTAGS_DRAW_PORTAL,
	},
];

/** Hand-written: PHP order — draws, then index pairs (last orphan first), then the text. */
const REPAIRED_TEXT =
	'[draw-d-9-9:-data::data]' +
	'[index-d-8--data::data][/index-d-8--data::data]' +
	'[index-d-7--data::data][/index-d-7--data::data]' +
	'<p>A [index-d-3-x-data:a:data][/index-n-3-x-data:a:data] B ' +
	'[index-n-4--data::data][/index-d-4--data::data] C ' +
	'[index-n-5--data::data]paired[/index-n-5--data::data]</p>';

/** The note-section text_area declares NO tag properties: its broken mark must pass through. */
const UNDECLARED_TEXT = '<p>[/index-n-3] orphan close</p>';

async function purge(): Promise<void> {
	for (const [table, tipo, id] of [
		[HOST_TABLE, ZZTAGS_SECTION, HOST_ID],
		[NOTE_TABLE, ZZTAGS_NOTE_SECTION, NOTE_ID],
	] as const) {
		await sql.unsafe(`DELETE FROM ${table} WHERE section_tipo = $1 AND section_id = $2`, [
			tipo,
			id,
		]);
		await sql.unsafe(
			'DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2',
			[tipo, id],
		);
	}
}

async function residue(): Promise<number> {
	let rows = 0;
	for (const [table, tipo, id] of [
		[HOST_TABLE, ZZTAGS_SECTION, HOST_ID],
		[NOTE_TABLE, ZZTAGS_NOTE_SECTION, NOTE_ID],
	] as const) {
		rows += (
			(await sql.unsafe(`SELECT id FROM ${table} WHERE section_tipo = $1 AND section_id = $2`, [
				tipo,
				id,
			])) as unknown[]
		).length;
		rows += (
			(await sql.unsafe(
				'SELECT id FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2',
				[tipo, id],
			)) as unknown[]
		).length;
	}
	return rows;
}

beforeAll(async () => {
	await assertTestDatabase('text_area_broken_tag_repair_native');
	await ensureSituation(ZZTAGS_SITUATION);
	HOST_TABLE = (await getMatrixTableFromTipo(ZZTAGS_SECTION)) ?? 'matrix_test';
	NOTE_TABLE = (await getMatrixTableFromTipo(ZZTAGS_NOTE_SECTION)) ?? 'matrix_test';
	await purge(); // a crashed earlier run
	await sql.unsafe(
		`INSERT INTO ${HOST_TABLE} (section_id, section_tipo, string, relation) VALUES ($1, $2, $3::text::jsonb, $4::text::jsonb)`,
		[
			HOST_ID,
			ZZTAGS_SECTION,
			JSON.stringify({ [ZZTAGS_TEXT_AREA]: [{ id: 1, lang: 'lg-spa', value: STORED_TEXT }] }),
			JSON.stringify({ [ZZTAGS_TAGS_INDEX]: INDEX_LOCATORS, [ZZTAGS_DRAW_PORTAL]: DRAW_LOCATORS }),
		],
	);
	await sql.unsafe(
		`INSERT INTO ${NOTE_TABLE} (section_id, section_tipo, string) VALUES ($1, $2, $3::text::jsonb)`,
		[
			NOTE_ID,
			ZZTAGS_NOTE_SECTION,
			JSON.stringify({
				[ZZTAGS_NOTE_BODY]: [{ id: 1, lang: 'lg-nolan', value: UNDECLARED_TEXT }],
			}),
		],
	);
});

afterAll(async () => {
	await purge();
	const left = await residue();
	expect(await dropSituation(ZZTAGS_SITUATION)).toBe(0);
	if (left > 0) throw new Error(`scratch residue: ${left} matrix/TM row(s) for zztags1/zztags4`);
});

/** One component item through the real section read. */
async function readItem(
	sectionTipo: string,
	sectionId: number,
	tipo: string,
	mode: 'edit' | 'list',
): Promise<Record<string, unknown>> {
	const result = await readSection({
		dd_api: 'dd_core_api',
		action: 'read',
		source: {
			tipo: sectionTipo,
			section_tipo: sectionTipo,
			model: 'section',
			mode,
			lang: 'lg-spa',
		},
		sqo: {
			section_tipo: [sectionTipo],
			limit: 1,
			offset: 0,
			filter_by_locators: [{ section_tipo: sectionTipo, section_id: String(sectionId) }],
		},
		show: { ddo_map: [{ tipo, section_tipo: sectionTipo, parent: sectionTipo, mode }] },
	} as never);
	const item = ((result.data ?? []) as Record<string, unknown>[]).find(
		(candidate) => candidate.tipo === tipo,
	);
	return mustGet(item, `${tipo} item of ${sectionTipo}/${sectionId}`);
}

const servedText = (item: Record<string, unknown>): unknown =>
	((item.entries as { value?: unknown }[] | null) ?? [])[0]?.value;

describe('edit read — the repair reaches the wire', () => {
	test('S1 the served edit value is the repaired text (unpaired + orphan index + orphan draw)', async () => {
		const item = await readItem(ZZTAGS_SECTION, HOST_ID, ZZTAGS_TEXT_AREA, 'edit');
		expect(servedText(item)).toBe(REPAIRED_TEXT);
		expect(item.fallback_value).toBeNull();
	});

	test('S2 the read wrote nothing: the stored text is byte-unchanged', async () => {
		const record = mustGet(
			await readMatrixRecord(HOST_TABLE, ZZTAGS_SECTION, HOST_ID),
			'scratch host record',
		);
		const stored = (record.columns.string as Record<string, { value: string }[]>)[ZZTAGS_TEXT_AREA];
		expect(stored?.[0]?.value).toBe(STORED_TEXT);
	});

	test('S3 a LIST read does not repair (PHP: the list branch has no repair)', async () => {
		const item = await readItem(ZZTAGS_SECTION, HOST_ID, ZZTAGS_TEXT_AREA, 'list');
		const value = String(servedText(item) ?? '');
		expect(value).not.toBe('');
		for (const orphan of ['-d-7', '-d-8', '-d-9', 'index-d-3', 'index-d-4']) {
			expect(value).not.toContain(orphan);
		}
	});

	test('S4 a text_area declaring no tags_index / tags_draw serves its broken mark unchanged', async () => {
		const item = await readItem(ZZTAGS_NOTE_SECTION, NOTE_ID, ZZTAGS_NOTE_BODY, 'edit');
		expect(servedText(item)).toBe(UNDECLARED_TEXT);
	});

	test('S5 the SAVE ECHO decoration repairs too (it replaces the client data; PHP echo ran the same controller)', async () => {
		const record = mustGet(
			await readMatrixRecord(HOST_TABLE, ZZTAGS_SECTION, HOST_ID),
			'scratch host record',
		);
		const item = {
			section_id: HOST_ID,
			section_tipo: ZZTAGS_SECTION,
			tipo: ZZTAGS_TEXT_AREA,
			mode: 'edit',
			lang: 'lg-spa',
			from_component_tipo: ZZTAGS_TEXT_AREA,
			entries: [{ id: 1, lang: 'lg-spa', value: STORED_TEXT }],
		};
		const decorate = mustGet(textAreaEmitHook.decorateItem, 'text_area decorateItem');
		await decorate(item, {
			ddo: { tipo: ZZTAGS_TEXT_AREA, section_tipo: ZZTAGS_SECTION, mode: 'edit' } as never,
			record,
			row: { section_tipo: ZZTAGS_SECTION, section_id: HOST_ID },
			model: 'component_text_area',
			ddoMode: 'edit',
			ddoLang: 'lg-spa',
			defaultMode: 'edit',
			defaultLang: 'lg-spa',
			callerTipo: ZZTAGS_SECTION,
			emission: new EmissionContext([item as never]),
			door: 'save_echo',
		});
		expect(item.entries[0]?.value).toBe(REPAIRED_TEXT);
	});
});
