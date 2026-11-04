/**
 * THE TM PREVIEW'S FRAME CHILDREN AS OF THE ROW
 * (WC-2026-09-29-tm-preview-frame-children-as-of) — outcome-first: every
 * expectation is a literal the contract dictates, never the engine's reader
 * recomputed.
 *
 * THE CONTRACT: the tool_time_machine preview of a dataframe main at row R
 * shows its frames as R recorded them AND each frame's CHILDREN (the rating on
 * the frame target, its note, its own locators) as of R — not live. The bound:
 * the main held R's state over [R, N), N the main key's next visible row; a
 * frame target "as of R" is its state at N-1 (the newest state when R is the
 * key's newest). So the newest row previews == live, and a link-then-fill
 * previews the filled value.
 *
 * WHAT IS PROVEN:
 *   (a)   the bound law through door 1 (a PORTAL main's read), and the plain
 *         live read unchanged;
 *   (a-link) link at R1 with the target empty, then fill: R1 previews the fill;
 *   (a')  door 3 (the slot read directly, caller_dataframe) — the same children;
 *   (a'') door 2 (a LITERAL has_dataframe main) — the same children;
 *   (b)   delete_target: the unlink's wipe rows sit ABOVE the unlink row (the
 *         commit-only lane the law relies on), and a pre-unlink row previews
 *         the target's pre-wipe values;
 *   (b')  a DELETED record: its newest main row previews the frame targets
 *         its delete wiped (delete_target, commit lane) as they were — the
 *         delete snapshot row (tipo = section_tipo) closes the bound;
 *   (c)   a SIBLING-anchored frame bag (frames on another section's record at
 *         the same id) previews its frames and children as of the bound — the
 *         filing coordinates asserted FIRST;
 *   (c')  door 3 on the sibling slot is served (it was refused as foreign),
 *         and only for the exact sibling/main pairing;
 *   (d)   every language lane of a translatable child as of the bound; a lane
 *         history never recorded stays live;
 *   (e)   silent history keeps the live value; a key whose rows all lie above
 *         the bound previews EMPTY;
 *   (c-life) the ANCHOR's own whole-record rows: an anchor deleted after the
 *         main's newest row previews == live (no frame resurrected, doors 1
 *         and 3); a whole-record snapshot on a living anchor supersedes its
 *         older frame state;
 *   (c-restore) a frame TARGET's own archive restore (a whole-record
 *         snapshot, no key rows) floors its children: key rows below it are
 *         superseded, key rows above it speak, the newest row == live;
 *   (f)   a target whose living generation did not exist at the bound (epoch
 *         above it, OR the bound between the epoch and the rebirth) previews
 *         EMPTY on a virtual record, never the living stranger's value — the
 *         frame and child item floored present;
 *   (g)   isolation: sequential and concurrent previews, one read where the
 *         same record is a LIVE portal target and an AS-OF frame target, and
 *         the live record objects left unmutated;
 *   (h)   confinement: a nested dataframe of a portal target inside the
 *         preview stays entirely live;
 *   (h'') confinement by the emission ROOT's identity, never an address: the
 *         host's own record met again NESTED stays live, preview == list;
 *   (i-snap) the record-snapshot list's WHOLE-RECORD rows: frames from the
 *         snapshot, addressed by its record (never the dd15 id), children as
 *         of the cell main's bound — a delete ends at its row, a restore at
 *         the main key's next row; a delete RECOVERED by the tool (its own
 *         whole-record row) still ends at the delete row.
 *
 * SITUATION: a `zztwf` scratch TLD on `test1` (→ matrix_test): a host section,
 * a frame-target section (number RATING, portal FREL, translatable NOTE, a
 * nested portal main NMAIN2 with its own slot), a SIBLING section; a portal
 * main PMAIN (slot SLOT), a literal main LMAIN (slot LSLOT), a portal main
 * SMAIN whose slot SSLOT is declared on the SIBLING section. Records are
 * created at runtime; everything is swept, the situation drop asserts zero
 * residue. assertTestDatabase first.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { dbTimestamp } from '../../src/core/db/db_timestamp.ts';
import { updateMatrixKeyData } from '../../src/core/db/matrix_write.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { openEpochIfReborn, recordEpoch } from '../../src/core/db/record_generation.ts';
import { memoizedReadMatrixRecord, runWithRecordMemo } from '../../src/core/db/record_memo.ts';
import { readFrameStateRowAt, recordTimeMachine } from '../../src/core/db/time_machine.ts';
import { getMatrixTableFromTipo } from '../../src/core/ontology/resolver.ts';
import { EmissionContext } from '../../src/core/resolve/component_data.ts';
import { readTimeMachineData } from '../../src/core/resolve/read_tm.ts';
import { runWithRequestLangs } from '../../src/core/resolve/request_lang.ts';
import { readComponentData } from '../../src/core/section/read.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import { deleteSectionRecord } from '../../src/core/section/record/delete_record.ts';
import { saveComponentData } from '../../src/core/section/record/save_component.ts';
import { loadRecordCached } from '../../src/core/section/record_loader.ts';
import { cloneRecord, makeVirtualRecord } from '../../src/core/section_record/virtual_record.ts';
import { SUPERUSER_ID } from '../../src/core/security/permissions.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import {
	frameBagAsOf,
	frameTargetsAsOf,
	isSubjectMain,
	loadFrameTargetAsOf,
	rootedAt,
	subjectRowOf,
} from '../../src/core/tm_record/frame_as_of.ts';
import { componentValueAsOf } from '../../src/core/tm_record/lane_state.ts';
import { restoreSection } from '../../tools/tool_time_machine/server/tool_time_machine.ts';
import { mustGet } from '../helpers/assert.ts';

const TLD = 'zztwf';
const SECTION = `${TLD}1`; // host of the mains
const PMAIN = `${TLD}2`; // component_portal main → TSECTION
const SLOT = `${TLD}3`; // its dataframe slot (delete_target)
const TSECTION = `${TLD}4`; // frame targets
const RATING = `${TLD}5`; // component_number on TSECTION (unsliced)
const NOTE = `${TLD}6`; // component_input_text, translatable, on TSECTION (sliced)
const LMAIN = `${TLD}7`; // component_input_text (non-translatable), has_dataframe
const LSLOT = `${TLD}8`;
const SIBLING = `${TLD}9`; // the section SMAIN's slot is anchored on
const FREL = `${TLD}10`; // component_portal on TSECTION → TSECTION
const SMAIN = `${TLD}11`; // component_portal main whose slot lives on SIBLING
const SSLOT = `${TLD}12`;
const NMAIN2 = `${TLD}13`; // component_portal on TSECTION with its OWN slot (the nested dataframe)
const NSLOT2 = `${TLD}14`;
const SSLOT2 = `${TLD}15`; // SMAIN's SECOND slot, also anchored on SIBLING (the per-slot bag cache)
const QMAIN = `${TLD}16`; // component_portal main → TSECTION whose ddo_map reaches BACK (the subject met again nested)
const QSLOT = `${TLD}17`; // its dataframe slot
const BACK = `${TLD}18`; // component_portal on TSECTION → SECTION, showing QMAIN (+ its slot): points BACK at the host
const ALIAS = `${TLD}19`; // component_alias of PMAIN (isSubjectMain's alias arm)
const SECID = `${TLD}20`; // component_section_id on TSECTION: a frame child with no jsonb column
const TABLE = 'matrix_test';
const USER_ID = SUPERUSER_ID;
const NOLAN = 'lg-nolan';
const SPA = 'lg-spa';
const ENG = 'lg-eng';
const FRA = 'lg-fra';
const ITA = 'lg-ita';

/** A slot's request_config: frames point at TSECTION; children = `children`; several frames per item. */
const slotConfig = (children: string[]) => ({
	source: {
		request_config: [
			{
				sqo: { section_tipo: [{ value: [TSECTION], source: 'section' }] },
				show: {
					ddo_map: children.map((tipo) => ({
						tipo,
						mode: 'edit',
						parent: 'self',
						section_tipo: 'self',
					})),
					sqo_config: { limit: 5 },
				},
			},
		],
	},
});

/** A portal main's request_config: targets TSECTION, declares `ddos`. */
const portalConfig = (ddos: Record<string, unknown>[]) => ({
	source: {
		request_config: [
			{
				sqo: { section_tipo: [{ value: [TSECTION], source: 'section' }] },
				show: { ddo_map: ddos },
			},
		],
	},
});

const FRAME_CHILDREN = [RATING, FREL, NOTE];

const SITUATION = situation({
	tld: TLD,
	name: 'tm_preview_frame_as_of',
	nodes: [
		{ tipo: SECTION, parent: 'test1', model: 'section', term: { 'lg-eng': 'Host' } },
		{ tipo: TSECTION, parent: 'test1', model: 'section', term: { 'lg-eng': 'Frame targets' } },
		{ tipo: SIBLING, parent: 'test1', model: 'section', term: { 'lg-eng': 'Sibling' } },
		{ tipo: RATING, parent: TSECTION, model: 'component_number', term: { 'lg-eng': 'Rating' } },
		{
			tipo: NOTE,
			parent: TSECTION,
			model: 'component_input_text',
			term: { 'lg-eng': 'Note' },
			is_translatable: true,
		},
		{
			tipo: FREL,
			parent: TSECTION,
			model: 'component_portal',
			term: { 'lg-eng': 'Frame relation' },
			properties: portalConfig([{ tipo: RATING, parent: 'self', section_tipo: TSECTION }]),
		},
		{
			tipo: NMAIN2,
			parent: TSECTION,
			model: 'component_portal',
			term: { 'lg-eng': 'Nested main' },
			properties: portalConfig([
				{ tipo: NSLOT2, mode: 'edit', parent: 'self', section_tipo: TSECTION },
			]),
		},
		{
			tipo: NSLOT2,
			parent: NMAIN2,
			model: 'component_dataframe',
			term: { 'lg-eng': 'Nested slot' },
			properties: slotConfig([RATING]),
		},
		{
			tipo: PMAIN,
			parent: SECTION,
			model: 'component_portal',
			term: { 'lg-eng': 'Portal main' },
			properties: portalConfig([
				{ tipo: SLOT, mode: 'edit', parent: 'self', section_tipo: SECTION },
				{ tipo: RATING, parent: 'self', section_tipo: TSECTION },
				{ tipo: NMAIN2, mode: 'edit', parent: 'self', section_tipo: TSECTION },
			]),
		},
		{
			tipo: SLOT,
			parent: PMAIN,
			model: 'component_dataframe',
			term: { 'lg-eng': 'Portal slot' },
			properties: {
				...slotConfig(FRAME_CHILDREN),
				dataframe: { delete_policy: 'delete_target' },
			},
		},
		{
			tipo: LMAIN,
			parent: SECTION,
			model: 'component_input_text',
			term: { 'lg-eng': 'Literal main' },
			properties: { has_dataframe: true },
		},
		{
			tipo: LSLOT,
			parent: LMAIN,
			model: 'component_dataframe',
			term: { 'lg-eng': 'Literal slot' },
			properties: slotConfig(FRAME_CHILDREN),
		},
		{
			tipo: SMAIN,
			parent: SECTION,
			model: 'component_portal',
			term: { 'lg-eng': 'Sibling-slot main' },
			properties: portalConfig([
				{ tipo: SSLOT, mode: 'edit', parent: 'self', section_tipo: SIBLING },
				{ tipo: SSLOT2, mode: 'edit', parent: 'self', section_tipo: SIBLING },
			]),
		},
		{
			tipo: SSLOT,
			parent: SMAIN,
			model: 'component_dataframe',
			term: { 'lg-eng': 'Sibling slot' },
			properties: slotConfig(FRAME_CHILDREN),
		},
		{
			tipo: SSLOT2,
			parent: SMAIN,
			model: 'component_dataframe',
			term: { 'lg-eng': 'Second sibling slot' },
			properties: slotConfig([RATING]),
		},
		{
			tipo: QMAIN,
			parent: SECTION,
			model: 'component_portal',
			term: { 'lg-eng': 'Re-entrant main' },
			properties: portalConfig([
				{ tipo: QSLOT, mode: 'edit', parent: 'self', section_tipo: SECTION },
				{ tipo: BACK, mode: 'edit', parent: 'self', section_tipo: TSECTION },
			]),
		},
		{
			tipo: QSLOT,
			parent: QMAIN,
			model: 'component_dataframe',
			term: { 'lg-eng': 'Re-entrant slot' },
			properties: slotConfig([RATING]),
		},
		{
			tipo: ALIAS,
			parent: SECTION,
			model: 'component_alias',
			term: { 'lg-eng': 'Portal main alias' },
			properties: { alias_of: PMAIN },
		},
		{ tipo: SECID, parent: TSECTION, model: 'component_section_id', term: { 'lg-eng': 'Id' } },
		{
			tipo: BACK,
			parent: TSECTION,
			model: 'component_portal',
			term: { 'lg-eng': 'Back to host' },
			properties: {
				source: {
					request_config: [
						{
							sqo: { section_tipo: [{ value: [SECTION], source: 'section' }] },
							show: {
								ddo_map: [{ tipo: QMAIN, mode: 'edit', parent: 'self', section_tipo: SECTION }],
							},
						},
					],
				},
			},
		},
	],
});

type Item = Record<string, unknown>;
const MAX = Number.MAX_SAFE_INTEGER;

// ---------------------------------------------------------------- lifecycle

beforeAll(async () => {
	await assertTestDatabase('tm_preview_frame_as_of_native');
	await ensureSituation(SITUATION);
	for (const tipo of [SECTION, TSECTION, SIBLING]) {
		expect(await getMatrixTableFromTipo(tipo)).toBe(TABLE);
	}
}, 60_000);

/** A section's activity rows (dd542: the audited address rides in misc dd551, never in `data`). */
const ACTIVITY_OF_SECTION = `matrix_activity WHERE section_tipo = 'dd542'
	   AND misc->'dd551'->0->'value'->>'section_tipo' = $1`;

afterAll(async () => {
	for (const tipo of [SECTION, TSECTION, SIBLING]) {
		await sql.unsafe('DELETE FROM matrix_time_machine WHERE section_tipo = $1', [tipo]);
		await sql.unsafe('DELETE FROM dedalo_ts_record_generation WHERE section_tipo = $1', [tipo]);
		await sql.unsafe(`DELETE FROM "${TABLE}" WHERE section_tipo = $1`, [tipo]);
		await sql.unsafe(`DELETE FROM ${ACTIVITY_OF_SECTION}`, [tipo]);
		const residue = (await sql.unsafe(`SELECT count(*) AS n FROM ${ACTIVITY_OF_SECTION}`, [
			tipo,
		])) as { n: number | string }[];
		expect({ tipo, activity: Number(residue[0]?.n) }).toEqual({ tipo, activity: 0 });
	}
	expect(await dropSituation(SITUATION)).toBe(0);
}, 60_000);

// ---------------------------------------------------------------- doors

async function save(
	sectionTipo: string,
	id: number,
	tipo: string,
	lang: string,
	changedData: unknown[],
	callerDataframe?: { main_component_tipo: string; id_key: number },
): Promise<void> {
	const saved = await saveComponentData({
		componentTipo: tipo,
		sectionTipo,
		sectionId: id,
		lang,
		changedData: changedData as never,
		userId: USER_ID,
		callerDataframe: callerDataframe as never,
	});
	expect(saved.ok).toBe(true);
}

const target = (): Promise<number> => createSectionRecord(TSECTION, USER_ID);
const host = (): Promise<number> => createSectionRecord(SECTION, USER_ID);

/** RATING = `value` on target `t` (a history row). */
const rate = (t: number, value: number) =>
	save(TSECTION, t, RATING, NOLAN, [
		{ action: 'set_data', value: [{ id: 1, lang: NOLAN, value }] },
	]);

/** NOTE's `lang` lane on target `t` (a history row). */
const note = (t: number, lang: string, value: string | null) =>
	save(TSECTION, t, NOTE, lang, [
		{ action: 'set_data', value: value === null ? [] : [{ id: 1, lang, value }] },
	]);

/** FREL on target `t` → the TSECTION records `ids`. */
const relate = (t: number, ids: number[]) =>
	save(TSECTION, t, FREL, NOLAN, [
		{
			action: 'set_data',
			value: ids.map((sid, n) => ({
				id: n + 1,
				type: 'dd151',
				section_tipo: TSECTION,
				section_id: sid,
				from_component_tipo: FREL,
			})),
		},
	]);

/** A portal main's items: item n+1 → TSECTION/ids[n]. */
const portalItems = (main: string, ids: number[]) =>
	ids.map((sid, n) => ({
		id: n + 1,
		type: 'dd151',
		section_tipo: TSECTION,
		section_id: sid,
		from_component_tipo: main,
	}));

const setPortal = (main: string, id: number, ids: number[]) =>
	save(SECTION, id, main, NOLAN, [{ action: 'set_data', value: portalItems(main, ids) }]);

/** Add a frame of main item `idKey` → TSECTION/t through the slot save (host `sectionTipo`/`id`). */
const link = (
	sectionTipo: string,
	id: number,
	slot: string,
	main: string,
	idKey: number,
	t: number,
) =>
	save(
		sectionTipo,
		id,
		slot,
		NOLAN,
		[{ action: 'insert', id: null, value: { section_tipo: TSECTION, section_id: String(t) } }],
		{ main_component_tipo: main, id_key: idKey },
	);

async function watermark(): Promise<number> {
	const rows = (await sql.unsafe('SELECT COALESCE(MAX(id), 0) AS m FROM matrix_time_machine')) as {
		m: number;
	}[];
	return Number(rows[0]?.m ?? 0);
}

/** Visible rows of one key above a watermark, id ASC. */
async function rowsOf(sectionTipo: string, id: number, tipo: string, after: number) {
	const rows = (await sql.unsafe(
		`SELECT id FROM matrix_time_machine
		  WHERE section_tipo = $1 AND section_id = $2 AND tipo = $3 AND id > $4 AND tm_role IS NULL
		  ORDER BY id ASC`,
		[sectionTipo, id, tipo, after],
	)) as { id: number }[];
	return rows.map((row) => Number(row.id));
}

/** Run `step` and answer the id of the ONE-or-more main rows it wrote (the newest). */
async function mainRow(
	sectionTipo: string,
	id: number,
	main: string,
	step: () => Promise<void>,
): Promise<number> {
	const mark = await watermark();
	await step();
	const rows = await rowsOf(sectionTipo, id, main, mark);
	expect(rows.length).toBeGreaterThan(0);
	return rows[rows.length - 1] as number;
}

/** Read one component, live (rowId null) or as the TM preview of row `rowId`. */
async function read(
	tipo: string,
	sectionTipo: string,
	id: number,
	rowId: number | null,
	options: { lang?: string; caller?: { main_component_tipo: string; id_key: number } } = {},
): Promise<Item[]> {
	const lang = options.lang ?? NOLAN;
	return (await runWithRequestLangs(
		{ applicationLang: ENG, dataLang: lang === NOLAN ? ENG : lang },
		() =>
			readComponentData({
				source: {
					tipo,
					section_tipo: sectionTipo,
					section_id: id,
					lang,
					mode: 'edit',
					...(rowId === null ? {} : { data_source: 'tm', matrix_id: rowId }),
					...(options.caller === undefined ? {} : { caller_dataframe: options.caller }),
				},
			} as never),
	)) as Item[];
}

/** The values of `childTipo` at target `t` emitted under `from` (the frame slot, or the portal). */
function childValues(items: Item[], childTipo: string, from: string, t: number): unknown[] {
	return items
		.filter(
			(item) =>
				item.tipo === childTipo &&
				item.from_component_tipo === from &&
				Number(item.section_id) === t,
		)
		.flatMap((item) => (Array.isArray(item.entries) ? (item.entries as Item[]) : []))
		.map((entry) => (childTipo === FREL ? Number(entry.section_id) : entry.value));
}

/**
 * THE PRESENCE FLOOR of an emptiness verdict: exactly one `childTipo` item at
 * target `t` under `from` is emitted — so a `[]` from childValues is the
 * contracted EMPTY child, never a child (or frame) the read dropped.
 */
function expectChildItem(items: Item[], childTipo: string, from: string, t: number): void {
	const found = items.filter(
		(item) =>
			item.tipo === childTipo && item.from_component_tipo === from && Number(item.section_id) === t,
	);
	expect(found.length).toBe(1);
	expect(Array.isArray(found[0]?.entries)).toBe(true);
}

/** The frame targets of the slot item(s) `slot` (id_key 1), as ids — with pagination.total. */
function frameTargets(items: Item[], slot: string): { ids: number[]; total: number | null } {
	const frameItems = items.filter((item) => item.tipo === slot && Number(item.id_key ?? 1) === 1);
	const ids = frameItems.flatMap((item) =>
		(Array.isArray(item.entries) ? (item.entries as Item[]) : []).map((e) => Number(e.section_id)),
	);
	const total = (frameItems[0]?.pagination as { total?: number } | undefined)?.total ?? null;
	return { ids: ids.sort((a, b) => a - b), total };
}

// ---------------------------------------------------------------- (a) bound law, door 1

describe('(a) the BOUND law through door 1 (a portal main): children as of the end of the row interval', () => {
	let id = 0;
	let t = 0;
	let anchor = 0;
	let r1 = 0;
	let r2 = 0;
	let r3 = 0;

	beforeAll(async () => {
		id = await host();
		t = await target();
		anchor = await target();
		await setPortal(PMAIN, id, [t]);
		await rate(t, 3);
		r1 = await mainRow(SECTION, id, PMAIN, () => link(SECTION, id, SLOT, PMAIN, 1, t));
		await rate(t, 5);
		r2 = await mainRow(SECTION, id, PMAIN, () => setPortal(PMAIN, id, [t, anchor]));
		await rate(t, 7);
		r3 = await mainRow(SECTION, id, PMAIN, () => setPortal(PMAIN, id, [t]));
		await rate(t, 9);
		expect(r1 < r2 && r2 < r3).toBe(true);
	}, 60_000);

	test('R1 → 5, R2 → 7, R3 (the newest) → 9 == live; the live read → 9', async () => {
		expect(childValues(await read(PMAIN, SECTION, id, r1), RATING, SLOT, t)).toEqual([5]);
		expect(childValues(await read(PMAIN, SECTION, id, r2), RATING, SLOT, t)).toEqual([7]);
		expect(childValues(await read(PMAIN, SECTION, id, r3), RATING, SLOT, t)).toEqual([9]);
		expect(childValues(await read(PMAIN, SECTION, id, null), RATING, SLOT, t)).toEqual([9]);
	}, 60_000);

	test("(a') door 3 — the slot read directly with the caller's pairing — gives the same children at every row", async () => {
		const caller = { main_component_tipo: PMAIN, id_key: 1 };
		const at = async (row: number | null) =>
			childValues(await read(SLOT, SECTION, id, row, { caller }), RATING, SLOT, t);
		expect(await at(r1)).toEqual([5]);
		expect(await at(r2)).toEqual([7]);
		expect(await at(r3)).toEqual([9]);
		expect(await at(null)).toEqual([9]);
	}, 60_000);

	test('(g) isolation: sequential previews around a live read, then concurrent previews — each its own values', async () => {
		const at = async (row: number | null) =>
			childValues(await read(PMAIN, SECTION, id, row), RATING, SLOT, t);
		expect(await at(r1)).toEqual([5]);
		expect(await at(null)).toEqual([9]);
		expect(await at(r2)).toEqual([7]);
		const [p1, p2, live] = await Promise.all([at(r1), at(r2), at(null)]);
		expect([p1, p2, live]).toEqual([[5], [7], [9]]);
	}, 60_000);

	test('(g) ONE read: T is a LIVE portal target (9) and an AS-OF frame target (5) at once', async () => {
		const items = await read(PMAIN, SECTION, id, r1);
		expect(childValues(items, RATING, PMAIN, t)).toEqual([9]);
		expect(childValues(items, RATING, SLOT, t)).toEqual([5]);
	}, 60_000);

	test('(g) the live record objects (record_loader cache, record_memo) are never mutated by the as-of graft', async () => {
		await runWithRecordMemo(async () => {
			const emission = new EmissionContext([], {
				tmAsOf: {
					rowId: r1,
					boundId: r2 - 1,
					sectionTipo: SECTION,
					sectionId: id,
					mainTipo: PMAIN,
				},
			});
			const memoLive = mustGet(await memoizedReadMatrixRecord(TABLE, TSECTION, t), 'memo row');
			const loaderLive = mustGet(
				await loadRecordCached(emission, TABLE, TSECTION, t),
				'loader row',
			);
			const memoBefore = structuredClone(memoLive.columns);
			const loaderBefore = structuredClone(loaderLive.columns);
			const asOf = mustGet(
				await loadFrameTargetAsOf(emission, TABLE, TSECTION, t, mustGet(emission.tmAsOf, 'asOf'), [
					RATING,
				]),
				'as-of record',
			);
			expect(asOf).not.toBe(loaderLive);
			expect((asOf.columns.number as Record<string, Item[]>)[RATING]?.[0]?.value).toBe(5);
			expect(memoLive.columns).toEqual(memoBefore);
			expect(loaderLive.columns).toEqual(loaderBefore);
			expect(await loadRecordCached(emission, TABLE, TSECTION, t)).toBe(loaderLive);
			expect((loaderLive.columns.number as Record<string, Item[]>)[RATING]?.[0]?.value).toBe(9);
		});
	}, 60_000);
});

// ---------------------------------------------------------------- (a-link) link then fill

describe('(a-link) the frame linked with the target EMPTY, then filled', () => {
	test('R1 previews the fill (== live) while R1 is the newest; after a main change and a refill, R1 keeps the first fill', async () => {
		const id = await host();
		const t = await target();
		const anchor = await target();
		await setPortal(PMAIN, id, [anchor]);
		const r1 = await mainRow(SECTION, id, PMAIN, () => link(SECTION, id, SLOT, PMAIN, 1, t));
		await rate(t, 3);
		expect(childValues(await read(PMAIN, SECTION, id, r1), RATING, SLOT, t)).toEqual([3]);
		expect(childValues(await read(PMAIN, SECTION, id, null), RATING, SLOT, t)).toEqual([3]);
		await mainRow(SECTION, id, PMAIN, () => setPortal(PMAIN, id, [anchor, t]));
		await rate(t, 4);
		expect(childValues(await read(PMAIN, SECTION, id, r1), RATING, SLOT, t)).toEqual([3]);
		expect(childValues(await read(PMAIN, SECTION, id, null), RATING, SLOT, t)).toEqual([4]);
	}, 60_000);
});

// ---------------------------------------------------------------- (a'') door 2, literal main

describe("(a'') door 2 — a LITERAL has_dataframe main", () => {
	test('the frame children of a literal main read as of the bound, exactly like a portal main', async () => {
		const id = await host();
		const t = await target();
		const setLiteral = (value: string) =>
			save(SECTION, id, LMAIN, NOLAN, [
				{ action: 'set_data', value: [{ id: 1, lang: NOLAN, value }] },
			]);
		await setLiteral('uno');
		await rate(t, 3);
		const r1 = await mainRow(SECTION, id, LMAIN, () => link(SECTION, id, LSLOT, LMAIN, 1, t));
		await rate(t, 5);
		const r2 = await mainRow(SECTION, id, LMAIN, () => setLiteral('dos'));
		await rate(t, 7);
		const at = async (row: number | null) =>
			childValues(await read(LMAIN, SECTION, id, row), RATING, LSLOT, t);
		expect(await at(r1)).toEqual([5]);
		expect(await at(r2)).toEqual([7]);
		expect(await at(null)).toEqual([7]);
	}, 60_000);
});

// ---------------------------------------------------------------- (b) delete_target

describe('(b) a target emptied by delete_target previews its PRE-WIPE values', () => {
	test('the wipe rows sit above the unlink row; the pre-unlink row previews rating, relation and note as they were', async () => {
		const id = await host();
		const t = await target();
		const other = await target();
		const anchor = await target();
		await setPortal(PMAIN, id, [anchor]);
		await rate(t, 3);
		await relate(t, [other]);
		await note(t, SPA, 'nota');
		const rp = await mainRow(SECTION, id, PMAIN, () => link(SECTION, id, SLOT, PMAIN, 1, t));
		const frame = mustGet(
			(
				(await read(PMAIN, SECTION, id, null)).find((item) => item.tipo === SLOT)?.entries as
					| Item[]
					| undefined
			)?.[0],
			'the live frame',
		);
		const mark = await watermark();
		const ru = await mainRow(SECTION, id, PMAIN, () =>
			save(SECTION, id, SLOT, NOLAN, [{ action: 'remove', id: frame.id, value: null }], {
				main_component_tipo: PMAIN,
				id_key: 1,
			}),
		);
		// PRECONDITIONS: the row is kept, RATING emptied; every wipe row lies ABOVE the unlink row.
		const liveRow = (await sql.unsafe(
			`SELECT number->$1 AS rating FROM "${TABLE}" WHERE section_tipo = $2 AND section_id = $3`,
			[RATING, TSECTION, t],
		)) as { rating: unknown }[];
		expect(liveRow.length).toBe(1);
		expect(liveRow[0]?.rating ?? null).toBeNull();
		const wipeRows = (await sql.unsafe(
			'SELECT id FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2 AND id > $3',
			[TSECTION, t, mark],
		)) as { id: number }[];
		expect(wipeRows.length).toBeGreaterThan(0);
		for (const row of wipeRows) expect(Number(row.id)).toBeGreaterThan(ru);

		const preview = await read(PMAIN, SECTION, id, rp, { lang: SPA });
		expect(frameTargets(preview, SLOT).ids).toEqual([t]);
		expect(childValues(preview, RATING, SLOT, t)).toEqual([3]);
		expect(childValues(preview, FREL, SLOT, t)).toEqual([other]);
		expect(childValues(preview, NOTE, SLOT, t)).toEqual(['nota']);
		// live: no frame at all
		expect(frameTargets(await read(PMAIN, SECTION, id, null), SLOT).ids).toEqual([]);
	}, 60_000);
});

describe("(b') a DELETED record's newest row previews the targets its delete wiped as they were", () => {
	test('the delete snapshot row closes the bound: the wipe rows above it are cut off', async () => {
		const id = await host();
		const t = await target();
		const anchor = await target();
		await setPortal(PMAIN, id, [anchor]);
		await rate(t, 3);
		const r = await mainRow(SECTION, id, PMAIN, () => link(SECTION, id, SLOT, PMAIN, 1, t));
		const mark = await watermark();
		const outcome = await deleteSectionRecord(SECTION, id, USER_ID);
		expect(outcome.removed).toBe(true);
		// PRECONDITIONS: no main-key row after R (R is the key's NEWEST); the
		// delete snapshot is filed under the SECTION tipo; RATING on t was wiped
		// (delete_target, commit lane) by rows ABOVE the snapshot row.
		expect(await rowsOf(SECTION, id, PMAIN, r)).toEqual([]);
		const snapshotRows = await rowsOf(SECTION, id, SECTION, mark);
		expect(snapshotRows.length).toBe(1);
		const snapshotRow = snapshotRows[0] as number;
		const liveRow = (await sql.unsafe(
			`SELECT number->$1 AS rating FROM "${TABLE}" WHERE section_tipo = $2 AND section_id = $3`,
			[RATING, TSECTION, t],
		)) as { rating: unknown }[];
		expect(liveRow[0]?.rating ?? null).toBeNull();
		const wipeRows = await rowsOf(TSECTION, t, RATING, mark);
		expect(wipeRows.length).toBeGreaterThan(0);
		for (const row of wipeRows) expect(row).toBeGreaterThan(snapshotRow);

		// The preview of R: the frame R recorded, its rating as it was at R (3), never the wipe.
		const preview = await read(PMAIN, SECTION, id, r);
		expect(frameTargets(preview, SLOT).ids).toEqual([t]);
		expect(childValues(preview, RATING, SLOT, t)).toEqual([3]);
	}, 60_000);
});

describe("(b'') a frame target DELETED after the bound previews its values as of the bound", () => {
	test('the target row is gone live; its history speaks: the frame renders on a virtual record', async () => {
		const id = await host();
		const t = await target();
		const anchor = await target();
		await setPortal(PMAIN, id, [anchor]);
		await rate(t, 3);
		const r1 = await mainRow(SECTION, id, PMAIN, () => link(SECTION, id, SLOT, PMAIN, 1, t));
		await mainRow(SECTION, id, PMAIN, () => setPortal(PMAIN, id, [anchor, t]));
		expect((await deleteSectionRecord(TSECTION, t, USER_ID)).removed).toBe(true);
		// PRECONDITION: the target has no live row.
		const liveRows = (await sql.unsafe(
			`SELECT count(*)::int AS n FROM "${TABLE}" WHERE section_tipo = $1 AND section_id = $2`,
			[TSECTION, t],
		)) as { n: number }[];
		expect(liveRows[0]?.n).toBe(0);
		const preview = await read(PMAIN, SECTION, id, r1);
		expect(frameTargets(preview, SLOT).ids).toEqual([t]);
		expect(childValues(preview, RATING, SLOT, t)).toEqual([3]);
	}, 60_000);
});

// ---------------------------------------------------------------- (c) sibling anchor

describe('(c) a SIBLING-anchored frame bag previews as of the bound', () => {
	let id = 0;
	let t1 = 0;
	let t2 = 0;
	let ra = 0;
	let rs = 0;

	beforeAll(async () => {
		id = await host();
		expect(await createSectionRecord(SIBLING, USER_ID, new Date(), id)).toBe(id);
		t1 = await target();
		t2 = await target();
		const anchor = await target();
		await rate(t1, 3);
		ra = await mainRow(SECTION, id, SMAIN, () => setPortal(SMAIN, id, [anchor]));
		await link(SIBLING, id, SSLOT, SMAIN, 1, t1);
		rs = await mainRow(SECTION, id, SMAIN, () => setPortal(SMAIN, id, [anchor, t2]));
		await link(SIBLING, id, SSLOT, SMAIN, 1, t2);
		await rate(t1, 7);
		await mainRow(SECTION, id, SMAIN, () => setPortal(SMAIN, id, [anchor]));
		await rate(t1, 9);
	}, 60_000);

	test('FILING COORDINATES: a sibling slot save is filed at (sibling, id, main) — asserted first', async () => {
		expect(
			await readFrameStateRowAt({ sectionTipo: SIBLING, sectionId: id, componentTipo: SMAIN }, MAX),
		).not.toBeNull();
		// and never on the main's own record under the main
		const ownFrames = (await sql.unsafe(
			`SELECT count(*)::int AS n FROM matrix_time_machine
			  WHERE section_tipo = $1 AND section_id = $2 AND tipo = $3 AND data::text LIKE '%dd490%'`,
			[SECTION, id, SMAIN],
		)) as { n: number }[];
		expect(ownFrames[0]?.n).toBe(0);
	}, 60_000);

	test('Ra → exactly [t1] (total 1) with t1 rating 3; Rs → [t1, t2] (total 2), rating 7; live → [t1, t2], rating 9', async () => {
		const atRa = await read(SMAIN, SECTION, id, ra);
		expect(frameTargets(atRa, SSLOT)).toEqual({ ids: [t1], total: 1 });
		expect(childValues(atRa, RATING, SSLOT, t1)).toEqual([3]);
		const atRs = await read(SMAIN, SECTION, id, rs);
		expect(frameTargets(atRs, SSLOT)).toEqual({ ids: [t1, t2].sort((a, b) => a - b), total: 2 });
		expect(childValues(atRs, RATING, SSLOT, t1)).toEqual([7]);
		const live = await read(SMAIN, SECTION, id, null);
		expect(frameTargets(live, SSLOT)).toEqual({ ids: [t1, t2].sort((a, b) => a - b), total: 2 });
		expect(childValues(live, RATING, SSLOT, t1)).toEqual([9]);
	}, 60_000);

	test("another main's frames in the same sibling slot stay LIVE in the as-of bag", async () => {
		const table = TABLE;
		const liveBag = mustGet(
			(await sql.unsafe(
				`SELECT relation FROM "${table}" WHERE section_tipo = $1 AND section_id = $2`,
				[SIBLING, id],
			)) as { relation: Record<string, unknown[]> }[],
			'sibling row',
		)[0];
		const foreign = {
			id: 99,
			type: 'dd490',
			section_tipo: TSECTION,
			section_id: t2,
			from_component_tipo: SSLOT,
			main_component_tipo: PMAIN,
			id_key: 1,
		};
		const record = {
			id: 1,
			section_id: id,
			section_tipo: SIBLING,
			columns: {
				relation: {
					...liveBag?.relation,
					[SSLOT]: [...(liveBag?.relation?.[SSLOT] ?? []), foreign],
				},
			},
			rawText: {},
		};
		const bag = mustGet(
			await frameBagAsOf(
				null,
				{ sectionTipo: SIBLING, sectionId: id },
				record as never,
				SMAIN,
				SSLOT,
				{ rowId: ra, boundId: rs - 1, sectionTipo: SECTION, sectionId: id, mainTipo: SMAIN },
			),
			'as-of bag',
		);
		const entries = (bag.columns.relation as Record<string, Item[]>)[SSLOT] ?? [];
		expect(entries.filter((e) => e.main_component_tipo === PMAIN)).toEqual([foreign]);
		expect(
			entries.filter((e) => e.main_component_tipo === SMAIN).map((e) => Number(e.section_id)),
		).toEqual([t1]);
		// the live record handed in is untouched
		expect((record.columns.relation[SSLOT] as Item[]).length).toBe(3);
	}, 60_000);

	test("(c') door 3 on the SIBLING slot is served (not empty): the same frames and children", async () => {
		const caller = { main_component_tipo: SMAIN, id_key: 1 };
		const atRa = await read(SSLOT, SIBLING, id, ra, { caller });
		expect(frameTargets(atRa, SSLOT).ids).toEqual([t1]);
		expect(childValues(atRa, RATING, SSLOT, t1)).toEqual([3]);
		const atRs = await read(SSLOT, SIBLING, id, rs, { caller });
		expect(frameTargets(atRs, SSLOT).ids).toEqual([t1, t2].sort((a, b) => a - b));
		expect(childValues(atRs, RATING, SSLOT, t1)).toEqual([7]);
	}, 60_000);

	test("(c') a mismatched section_id or main tipo is still refused (empty)", async () => {
		const other = await host();
		expect(await createSectionRecord(SIBLING, USER_ID, new Date(), other)).toBe(other);
		expect(
			await read(SSLOT, SIBLING, other, ra, { caller: { main_component_tipo: SMAIN, id_key: 1 } }),
		).toEqual([]);
		expect(
			await read(SSLOT, SIBLING, id, ra, { caller: { main_component_tipo: PMAIN, id_key: 1 } }),
		).toEqual([]);
		expect(await read(SSLOT, SIBLING, id, ra)).toEqual([]);
		// A slot the row's main does NOT declare on the read's section (SLOT lives
		// on SECTION, not SIBLING): refused, even with a complete pairing naming
		// that main and a row of the main's own living record.
		const rp = await mainRow(SECTION, id, PMAIN, () => setPortal(PMAIN, id, [t1]));
		expect(
			await read(SLOT, SIBLING, id, rp, { caller: { main_component_tipo: PMAIN, id_key: 1 } }),
		).toEqual([]);
	}, 60_000);

	test("(c') a row of a DEAD generation of the main's record is refused on the sibling slot", async () => {
		const hid = await host();
		expect(await createSectionRecord(SIBLING, USER_ID, new Date(), hid)).toBe(hid);
		const t = await target();
		const r = await mainRow(SECTION, hid, SMAIN, () => setPortal(SMAIN, hid, [t]));
		await link(SIBLING, hid, SSLOT, SMAIN, 1, t);
		const caller = { main_component_tipo: SMAIN, id_key: 1 };
		// FLOOR: served while the row's generation is the living one.
		expect(frameTargets(await read(SSLOT, SIBLING, hid, r, { caller }), SSLOT).ids).toEqual([t]);
		// The main's record reborn: the row now belongs to a dead generation.
		const epoch = mustGet(await openEpochIfReborn(SECTION, hid), 'epoch');
		expect(epoch).toBeGreaterThan(r);
		expect(await read(SSLOT, SIBLING, hid, r, { caller })).toEqual([]);
	}, 60_000);
});

// ---------------------------------------------------------------- (c-cache) two sibling slots, one anchor

describe('(c-cache) two slots of one main on the SAME sibling anchor: each bag as of the bound', () => {
	test('the per-read as-of bag is per (anchor, main, SLOT): the second slot never reuses the first one', async () => {
		const id = await host();
		expect(await createSectionRecord(SIBLING, USER_ID, new Date(), id)).toBe(id);
		const t1 = await target();
		const t2 = await target();
		const t3 = await target();
		const anchorT = await target();
		await setPortal(SMAIN, id, [anchorT]);
		await link(SIBLING, id, SSLOT, SMAIN, 1, t1);
		await link(SIBLING, id, SSLOT2, SMAIN, 1, t2);
		const r1 = await mainRow(SECTION, id, SMAIN, () => setPortal(SMAIN, id, [anchorT, t1]));
		// r1's interval ends at the NEXT main row; the t3 frame lands after it.
		await mainRow(SECTION, id, SMAIN, () => setPortal(SMAIN, id, [anchorT]));
		await link(SIBLING, id, SSLOT2, SMAIN, 1, t3);
		const preview = await read(SMAIN, SECTION, id, r1);
		expect(frameTargets(preview, SSLOT).ids).toEqual([t1]);
		expect(frameTargets(preview, SSLOT2).ids).toEqual([t2]);
		const live = await read(SMAIN, SECTION, id, null);
		expect(frameTargets(live, SSLOT2).ids).toEqual([t2, t3].sort((a, b) => a - b));
	}, 60_000);
});

// ---------------------------------------------------------------- (c-life) the anchor's own lifecycle

describe("(c-life) a sibling bag honours the ANCHOR record's own whole-record rows", () => {
	test('the anchor DELETED after the newest main row: that row previews == live — no frame resurrected (doors 1 and 3)', async () => {
		const id = await host();
		expect(await createSectionRecord(SIBLING, USER_ID, new Date(), id)).toBe(id);
		const t1 = await target();
		const anchorT = await target();
		const r = await mainRow(SECTION, id, SMAIN, () => setPortal(SMAIN, id, [anchorT]));
		await link(SIBLING, id, SSLOT, SMAIN, 1, t1);
		await rate(t1, 3);
		// FLOOR: before the delete, R (the newest main row) previews the frame.
		expect(frameTargets(await read(SMAIN, SECTION, id, r), SSLOT).ids).toEqual([t1]);
		const mark = await watermark();
		expect((await deleteSectionRecord(SIBLING, id, USER_ID)).removed).toBe(true);
		// PRECONDITIONS: R is still the main key's newest row and nothing was
		// written on the main's record; the anchor's delete snapshot exists.
		expect(await rowsOf(SECTION, id, SMAIN, r)).toEqual([]);
		expect(await rowsOf(SECTION, id, SECTION, mark)).toEqual([]);
		expect((await rowsOf(SIBLING, id, SIBLING, mark)).length).toBe(1);

		const live = await read(SMAIN, SECTION, id, null);
		const preview = await read(SMAIN, SECTION, id, r);
		expect(frameTargets(live, SSLOT)).toEqual({ ids: [], total: 0 });
		expect(frameTargets(preview, SSLOT)).toEqual({ ids: [], total: 0 });
		expect(childValues(preview, RATING, SSLOT, t1)).toEqual([]);
		// door 3 on the deleted anchor: nothing either
		const caller = { main_component_tipo: SMAIN, id_key: 1 };
		expect(frameTargets(await read(SSLOT, SIBLING, id, r, { caller }), SSLOT).ids).toEqual([]);
	}, 60_000);

	test('a whole-record snapshot row on a LIVING anchor after its last slot save (the archive-restore shape) supersedes that frame state', async () => {
		const id = await host();
		expect(await createSectionRecord(SIBLING, USER_ID, new Date(), id)).toBe(id);
		const t1 = await target();
		const t2 = await target();
		const t3 = await target();
		const anchorT = await target();
		const r = await mainRow(SECTION, id, SMAIN, () => setPortal(SMAIN, id, [anchorT]));
		await link(SIBLING, id, SSLOT, SMAIN, 1, t1);
		// The archive restore's door (restore.ts writeRecordRow): the row overwritten,
		// then ONE whole-record audit row (tipo = section_tipo, the full snapshot).
		const restoredFrame = {
			id: 1,
			type: 'dd490',
			section_tipo: TSECTION,
			section_id: t2,
			from_component_tipo: SSLOT,
			main_component_tipo: SMAIN,
			id_key: 1,
		};
		// ANOTHER main's frame in the same slot, in the snapshot AND live.
		const foreign = {
			id: 2,
			type: 'dd490',
			section_tipo: TSECTION,
			section_id: t1,
			from_component_tipo: SSLOT,
			main_component_tipo: PMAIN,
			id_key: 1,
		};
		await updateMatrixKeyData(TABLE, SIBLING, id, 'relation', SSLOT, [restoredFrame, foreign]);
		await recordTimeMachine(
			{
				sectionTipo: SIBLING,
				sectionId: id,
				componentTipo: SIBLING,
				lang: NOLAN,
				userId: USER_ID,
				data: { relation: { [SSLOT]: [restoredFrame, foreign] } },
			},
			dbTimestamp(),
		);
		// R is the main's newest row: its bag is the restored one (== live), not the pre-restore frame state.
		expect(frameTargets(await read(SMAIN, SECTION, id, r), SSLOT).ids).toEqual([t2]);
		expect(frameTargets(await read(SMAIN, SECTION, id, null), SSLOT).ids).toEqual([t2]);
		// The as-of bag takes only THIS main's frames from the snapshot: the other
		// main's frame is there once (live), never doubled by the snapshot's copy.
		const liveBag = mustGet(
			await loadRecordCached(new EmissionContext(), TABLE, SIBLING, id),
			'live sibling',
		);
		const bag = mustGet(
			await frameBagAsOf(null, { sectionTipo: SIBLING, sectionId: id }, liveBag, SMAIN, SSLOT, {
				rowId: r,
				boundId: MAX,
				sectionTipo: SECTION,
				sectionId: id,
				mainTipo: SMAIN,
			}),
			'as-of bag',
		);
		const entries = (bag.columns.relation as Record<string, Item[]>)[SSLOT] ?? [];
		expect(entries.filter((e) => e.main_component_tipo === PMAIN)).toEqual([foreign]);
		expect(
			entries.filter((e) => e.main_component_tipo === SMAIN).map((e) => Number(e.section_id)),
		).toEqual([t2]);
		// A slot save AFTER the snapshot is NEWER than it: that frame state speaks, not the snapshot.
		await link(SIBLING, id, SSLOT, SMAIN, 1, t3);
		expect(frameTargets(await read(SMAIN, SECTION, id, r), SSLOT).ids).toEqual(
			[t2, t3].sort((a, b) => a - b),
		);
		expect(frameTargets(await read(SMAIN, SECTION, id, null), SSLOT).ids).toEqual(
			[t2, t3].sort((a, b) => a - b),
		);
	}, 60_000);

	test('a sibling bag history NEVER recorded (a raw write) previews the LIVE bag', async () => {
		const id = await host();
		expect(await createSectionRecord(SIBLING, USER_ID, new Date(), id)).toBe(id);
		const t = await target();
		const anchorT = await target();
		const r = await mainRow(SECTION, id, SMAIN, () => setPortal(SMAIN, id, [anchorT]));
		await mainRow(SECTION, id, SMAIN, () => setPortal(SMAIN, id, [anchorT, t]));
		await updateMatrixKeyData(TABLE, SIBLING, id, 'relation', SSLOT, [
			{
				id: 1,
				type: 'dd490',
				section_tipo: TSECTION,
				section_id: t,
				from_component_tipo: SSLOT,
				main_component_tipo: SMAIN,
				id_key: 1,
			},
		]);
		// PRECONDITION: no frame state was ever recorded at the anchor.
		expect(
			await readFrameStateRowAt({ sectionTipo: SIBLING, sectionId: id, componentTipo: SMAIN }, MAX),
		).toBeNull();
		expect(frameTargets(await read(SMAIN, SECTION, id, r), SSLOT).ids).toEqual([t]);
		expect(frameTargets(await read(SMAIN, SECTION, id, null), SSLOT).ids).toEqual([t]);
	}, 60_000);

	test('the anchor DELETED, then its whole row written again (a restore): a bound between them previews NO frame', async () => {
		const id = await host();
		expect(await createSectionRecord(SIBLING, USER_ID, new Date(), id)).toBe(id);
		const t1 = await target();
		const anchorT = await target();
		await mainRow(SECTION, id, SMAIN, () => setPortal(SMAIN, id, [anchorT]));
		await link(SIBLING, id, SSLOT, SMAIN, 1, t1);
		const mark = await watermark();
		expect((await deleteSectionRecord(SIBLING, id, USER_ID)).removed).toBe(true);
		const w1 = mustGet((await rowsOf(SIBLING, id, SIBLING, mark))[0], 'delete snapshot');
		const r1 = await mainRow(SECTION, id, SMAIN, () => setPortal(SMAIN, id, [anchorT, t1]));
		const r2 = await mainRow(SECTION, id, SMAIN, () => setPortal(SMAIN, id, [anchorT]));
		const ownFrame = {
			id: 1,
			type: 'dd490',
			section_tipo: TSECTION,
			section_id: t1,
			from_component_tipo: SSLOT,
			main_component_tipo: SMAIN,
			id_key: 1,
		};
		// The restore's whole-record row (the archive door's shape), after r2.
		await recordTimeMachine(
			{
				sectionTipo: SIBLING,
				sectionId: id,
				componentTipo: SIBLING,
				lang: NOLAN,
				userId: USER_ID,
				data: { relation: { [SSLOT]: [ownFrame] } },
			},
			dbTimestamp(),
		);
		// PRECONDITIONS: w1 < r1 < r2 < the restore row; nothing else on the anchor between.
		const anchorRows = await rowsOf(SIBLING, id, SIBLING, mark);
		expect(anchorRows.length).toBe(2);
		expect(w1 < r1 && r1 < r2 && r2 < (anchorRows[1] as number)).toBe(true);
		// r1's bound lies between the delete and the restore: the anchor did not exist.
		expect(frameTargets(await read(SMAIN, SECTION, id, r1), SSLOT)).toEqual({ ids: [], total: 0 });
		// Directly: a living bag handed in (another main's frame, and one of this
		// main) — at that bound NOTHING, other mains' frames included.
		const liveBag = {
			id: 1,
			section_id: id,
			section_tipo: SIBLING,
			columns: {
				relation: { [SSLOT]: [ownFrame, { ...ownFrame, id: 2, main_component_tipo: PMAIN }] },
			},
			rawText: {},
		};
		const bag = mustGet(
			await frameBagAsOf(
				null,
				{ sectionTipo: SIBLING, sectionId: id },
				liveBag as never,
				SMAIN,
				SSLOT,
				{ rowId: r1, boundId: r2 - 1, sectionTipo: SECTION, sectionId: id, mainTipo: SMAIN },
			),
			'as-of bag',
		);
		expect((bag.columns.relation as Record<string, Item[]> | null)?.[SSLOT] ?? []).toEqual([]);
	}, 60_000);

	test("the anchor DELETED, then REBORN at the same id (explicit id): a bound before the rebirth previews NO frame — never the stranger's bag (doors 1 and 3)", async () => {
		const id = await host();
		expect(await createSectionRecord(SIBLING, USER_ID, new Date(), id)).toBe(id);
		const t1 = await target();
		const t2 = await target();
		const anchorT = await target();
		await link(SIBLING, id, SSLOT, SMAIN, 1, t1);
		const r1 = await mainRow(SECTION, id, SMAIN, () => setPortal(SMAIN, id, [anchorT]));
		// FLOOR: while the old generation lives, r1 previews its frame.
		expect(frameTargets(await read(SMAIN, SECTION, id, r1), SSLOT).ids).toEqual([t1]);
		expect((await deleteSectionRecord(SIBLING, id, USER_ID)).removed).toBe(true);
		const r2 = await mainRow(SECTION, id, SMAIN, () => setPortal(SMAIN, id, [anchorT, t2]));
		// The REBIRTH at the same id (explicit id → an epoch), its slot written
		// with no history for this main: a frame of THIS main and one of ANOTHER.
		const mark = await watermark();
		expect(await createSectionRecord(SIBLING, USER_ID, new Date(), id)).toBe(id);
		const stranger = {
			id: 1,
			type: 'dd490',
			section_tipo: TSECTION,
			section_id: t2,
			from_component_tipo: SSLOT,
			main_component_tipo: SMAIN,
			id_key: 1,
		};
		const foreign = { ...stranger, id: 2, main_component_tipo: PMAIN };
		await updateMatrixKeyData(TABLE, SIBLING, id, 'relation', SSLOT, [stranger, foreign]);
		// PRECONDITIONS: an epoch above the bound; the dead generation's rows hidden
		// (no frame state of this main visible at any bound); r1's bound before the rebirth.
		expect(await recordEpoch(SIBLING, id)).toBeGreaterThan(r2 - 1);
		expect(mark).toBeGreaterThanOrEqual(r2);
		expect(
			await readFrameStateRowAt({ sectionTipo: SIBLING, sectionId: id, componentTipo: SMAIN }, MAX),
		).toBeNull();
		// Live shows the living stranger's frame…
		expect(frameTargets(await read(SMAIN, SECTION, id, null), SSLOT).ids).toEqual([t2]);
		// …r1 (bound r2-1, the anchor deleted and not yet reborn) shows nothing.
		expect(frameTargets(await read(SMAIN, SECTION, id, r1), SSLOT)).toEqual({ ids: [], total: 0 });
		const caller = { main_component_tipo: SMAIN, id_key: 1 };
		expect(frameTargets(await read(SSLOT, SIBLING, id, r1, { caller }), SSLOT).ids).toEqual([]);
		// Directly: no frame at all at that bound, other mains' included.
		const liveBag = mustGet(
			await loadRecordCached(new EmissionContext(), TABLE, SIBLING, id),
			'live sibling',
		);
		const bag = mustGet(
			await frameBagAsOf(null, { sectionTipo: SIBLING, sectionId: id }, liveBag, SMAIN, SSLOT, {
				rowId: r1,
				boundId: r2 - 1,
				sectionTipo: SECTION,
				sectionId: id,
				mainTipo: SMAIN,
			}),
			'as-of bag',
		);
		expect((bag.columns.relation as Record<string, Item[]> | null)?.[SSLOT] ?? []).toEqual([]);
	}, 60_000);
});

// ---------------------------------------------------------------- (c-restore) target archive restore

describe("(c-restore) a frame TARGET's own archive restore floors its children", () => {
	test('key rows below the restore snapshot are superseded by it; key rows above it still speak; the newest row == live', async () => {
		const id = await host();
		const t = await target();
		const other = await target();
		await setPortal(PMAIN, id, [t]);
		await rate(t, 5);
		await note(t, SPA, 'antes');
		await note(t, ENG, 'before');
		const r0 = await mainRow(SECTION, id, PMAIN, () => link(SECTION, id, SLOT, PMAIN, 1, t));
		// The archive restore's door (archive/restore.ts writeRecordRow, overwrite):
		// the row rewritten, then ONE whole-record row (tipo = section_tipo, the
		// full snapshot) — no key rows.
		const restoredRating = [{ id: 1, lang: NOLAN, value: 3 }];
		const restoredNote = [{ id: 1, lang: SPA, value: 'restaurada' }];
		const mark = await watermark();
		await updateMatrixKeyData(TABLE, TSECTION, t, 'number', RATING, restoredRating);
		await updateMatrixKeyData(TABLE, TSECTION, t, 'string', NOTE, restoredNote);
		const { recordTimeMachine } = await import('../../src/core/db/time_machine.ts');
		const { dbTimestamp } = await import('../../src/core/db/db_timestamp.ts');
		await recordTimeMachine(
			{
				sectionTipo: TSECTION,
				sectionId: t,
				componentTipo: TSECTION,
				lang: NOLAN,
				userId: USER_ID,
				data: { number: { [RATING]: restoredRating }, string: { [NOTE]: restoredNote } },
			},
			dbTimestamp(),
		);
		// PRECONDITIONS: the restore wrote exactly its snapshot row, no key row.
		const snapshotRows = await rowsOf(TSECTION, t, TSECTION, mark);
		expect(snapshotRows.length).toBe(1);
		expect(await rowsOf(TSECTION, t, RATING, mark)).toEqual([]);
		expect(await rowsOf(TSECTION, t, NOTE, mark)).toEqual([]);

		// r0 is the main's NEWEST row: its preview == live — the snapshot's 3
		// and restaurada, never the superseded key rows' 5 / antes / before.
		const at = async (row: number | null, lang: string) => read(PMAIN, SECTION, id, row, { lang });
		expect(childValues(await at(r0, NOLAN), RATING, SLOT, t)).toEqual([3]);
		expect(childValues(await at(null, NOLAN), RATING, SLOT, t)).toEqual([3]);
		expect(childValues(await at(r0, SPA), NOTE, SLOT, t)).toEqual(['restaurada']);
		const newestEng = await at(r0, ENG);
		expectChildItem(newestEng, NOTE, SLOT, t);
		expect(childValues(newestEng, NOTE, SLOT, t)).toEqual([]);

		// A key row ABOVE the snapshot still speaks: eng written after the restore.
		await note(t, ENG, 'after');
		const r1 = await mainRow(SECTION, id, PMAIN, () => setPortal(PMAIN, id, [t, other]));
		await rate(t, 8);
		// r0 now ends at r1-1 (above the snapshot): rating/spa from the snapshot, eng from its row.
		expect(childValues(await at(r0, NOLAN), RATING, SLOT, t)).toEqual([3]);
		expect(childValues(await at(r0, SPA), NOTE, SLOT, t)).toEqual(['restaurada']);
		expect(childValues(await at(r0, ENG), NOTE, SLOT, t)).toEqual(['after']);
		// r1 is the newest: == live.
		expect(childValues(await at(r1, NOLAN), RATING, SLOT, t)).toEqual([8]);
		expect(childValues(await at(null, NOLAN), RATING, SLOT, t)).toEqual([8]);
		expect(childValues(await at(r1, ENG), NOTE, SLOT, t)).toEqual(['after']);
		expect(childValues(await at(null, ENG), NOTE, SLOT, t)).toEqual(['after']);
	}, 60_000);
});

// ---------------------------------------------------------------- (d) lanes

describe('(d) a translatable child: EVERY lane as of the bound; a lane never recorded stays live', () => {
	test('spa uno / eng one at R; spa dos, eng deleted; fra raw-written → R previews uno, one, and the live fra', async () => {
		const id = await host();
		const t = await target();
		const anchor = await target();
		await setPortal(PMAIN, id, [anchor]);
		await note(t, SPA, 'uno');
		await note(t, ENG, 'one');
		const r = await mainRow(SECTION, id, PMAIN, () => link(SECTION, id, SLOT, PMAIN, 1, t));
		await mainRow(SECTION, id, PMAIN, () => setPortal(PMAIN, id, [anchor, t]));
		await note(t, SPA, 'dos');
		await note(t, ENG, null);
		// fra written with NO history (a raw write beside the recorded lanes)
		const live = (await sql.unsafe(
			`SELECT string->$1 AS v FROM "${TABLE}" WHERE section_tipo = $2 AND section_id = $3`,
			[NOTE, TSECTION, t],
		)) as { v: Item[] | null }[];
		await updateMatrixKeyData(TABLE, TSECTION, t, 'string', NOTE, [
			...(live[0]?.v ?? []),
			{ id: 3, lang: FRA, value: 'trois' },
		]);
		const at = async (lang: string, row: number | null) =>
			childValues(await read(PMAIN, SECTION, id, row, { lang }), NOTE, SLOT, t);
		expect(await at(SPA, r)).toEqual(['uno']);
		expect(await at(ENG, r)).toEqual(['one']);
		expect(await at(FRA, r)).toEqual(['trois']);
		// live: dos, eng empty (no eng value), trois
		expect(await at(SPA, null)).toEqual(['dos']);
		const liveEng = await read(PMAIN, SECTION, id, null, { lang: ENG });
		expectChildItem(liveEng, NOTE, SLOT, t);
		expect(childValues(liveEng, NOTE, SLOT, t)).toEqual([]);
		expect(await at(FRA, null)).toEqual(['trois']);
	}, 60_000);
});

describe("(d') the sliced lane law of componentValueAsOf, row by row", () => {
	test('orphans once (the newest speaking row), a frames-only row skipped, a lane only above the bound EMPTY, lg-nolan of a translatable never speaks', async () => {
		const t = await target();
		const coords = { sectionTipo: TSECTION, sectionId: t, componentTipo: NOTE };
		const raw = (lang: string, data: unknown[]) =>
			recordTimeMachine({ ...coords, lang, userId: USER_ID, data }, dbTimestamp());
		await raw(ENG, [
			{ id: 2, lang: ENG, value: 'one' },
			{ id: 9, value: 'orph-eng' },
		]);
		await raw(SPA, [
			{ id: 1, lang: SPA, value: 'uno' },
			{ id: 9, value: 'orph-spa' },
		]);
		// A v6 frames-only row on the spa lane (its items speak another language): skipped.
		await raw(SPA, [{ id: 2, lang: ENG, value: 'v6' }]);
		const bound = await watermark();
		await raw(NOLAN, [{ id: 5, lang: NOLAN, value: 'nolan-row' }]);
		await raw(ITA, [{ id: 3, lang: ITA, value: 'dopo' }]);
		const base = [
			{ id: 1, lang: SPA, value: 'live-spa' },
			{ id: 2, lang: ENG, value: 'live-eng' },
			{ id: 3, lang: ITA, value: 'live-ita' },
			{ id: 4, lang: FRA, value: 'live-fra' },
			{ id: 5, lang: NOLAN, value: 'live-nolan' },
			{ id: 9, value: 'live-orph' },
		];
		const asOf = await componentValueAsOf(coords, base, bound, {
			sliced: true,
			translatable: true,
		});
		expect(asOf.spoken).toBe(true);
		const byId = (items: unknown) =>
			[...(items as Item[])].sort(
				(a, b) => Number(a.id) - Number(b.id) || String(a.value).localeCompare(String(b.value)),
			);
		expect(byId(asOf.value)).toEqual([
			{ id: 1, lang: SPA, value: 'uno' },
			{ id: 2, lang: ENG, value: 'one' },
			{ id: 4, lang: FRA, value: 'live-fra' },
			{ id: 5, lang: NOLAN, value: 'live-nolan' },
			{ id: 9, value: 'orph-spa' },
		]);
		// A key history never recorded: silent, the base stands.
		const silent = await componentValueAsOf({ ...coords, componentTipo: FREL }, base, bound, {
			sliced: true,
			translatable: true,
		});
		expect(silent).toEqual({ spoken: false, value: base });
	}, 60_000);
});

describe("(d') a lane whose only rows at or below the bound are FRAMES-ONLY previews EMPTY, never its live value", () => {
	test('translatable spa lane and a non-translatable lg-nolan lane: frames-only at or below, the value row above → empty', async () => {
		const t = await target();
		const coords = { sectionTipo: TSECTION, sectionId: t, componentTipo: NOTE };
		const raw = (lang: string, data: unknown[]) =>
			recordTimeMachine({ ...coords, lang, userId: USER_ID, data }, dbTimestamp());
		// Translatable: the ONLY spa row at or below the bound is frames-only (a
		// v6 row whose items speak another language); spa's value comes after.
		await raw(SPA, [{ id: 2, lang: ENG, value: 'v6' }]);
		const bound = await watermark();
		await raw(SPA, [{ id: 1, lang: SPA, value: 'nuevo' }]);
		const base = [
			{ id: 1, lang: SPA, value: 'nuevo' },
			{ id: 4, lang: FRA, value: 'live-fra' },
		];
		const asOf = await componentValueAsOf(coords, base, bound, {
			sliced: true,
			translatable: true,
		});
		expect(asOf.spoken).toBe(true);
		expect(asOf.value).toEqual([{ id: 4, lang: FRA, value: 'live-fra' }]);
		// Non-translatable sliced: value lane lg-nolan, shared with frames-only rows.
		const nolanCoords = { ...coords, componentTipo: FREL };
		await recordTimeMachine(
			{
				...nolanCoords,
				lang: NOLAN,
				userId: USER_ID,
				data: [{ id: 2, lang: ENG, value: 'frame' }],
			},
			dbTimestamp(),
		);
		const nolanBound = await watermark();
		await recordTimeMachine(
			{
				...nolanCoords,
				lang: NOLAN,
				userId: USER_ID,
				data: [{ id: 1, lang: NOLAN, value: 'later' }],
			},
			dbTimestamp(),
		);
		const nolanAsOf = await componentValueAsOf(
			nolanCoords,
			[{ id: 1, lang: NOLAN, value: 'later' }],
			nolanBound,
			{ sliced: true, translatable: false },
		);
		expect(nolanAsOf).toEqual({ spoken: true, value: [] });
	}, 60_000);
});

// ---------------------------------------------------------------- (e) silent history, rows above

describe('(e) silent history keeps LIVE; a key whose rows all lie above the bound previews EMPTY', () => {
	test('a raw-written rating (no row) previews live; a rating first recorded after the bound previews empty', async () => {
		const id = await host();
		const silent = await target();
		const late = await target();
		const anchor = await target();
		await setPortal(PMAIN, id, [anchor]);
		await updateMatrixKeyData(TABLE, TSECTION, silent, 'number', RATING, [
			{ id: 1, lang: NOLAN, value: 42 },
		]);
		await link(SECTION, id, SLOT, PMAIN, 1, silent);
		const r1 = await mainRow(SECTION, id, PMAIN, () => link(SECTION, id, SLOT, PMAIN, 1, late));
		await mainRow(SECTION, id, PMAIN, () => setPortal(PMAIN, id, [anchor, silent]));
		await rate(late, 5);
		const preview = await read(PMAIN, SECTION, id, r1);
		expect(frameTargets(preview, SLOT).ids).toEqual([silent, late].sort((a, b) => a - b));
		expect(childValues(preview, RATING, SLOT, silent)).toEqual([42]);
		expectChildItem(preview, RATING, SLOT, late);
		expect(childValues(preview, RATING, SLOT, late)).toEqual([]);
		expect(childValues(await read(PMAIN, SECTION, id, null), RATING, SLOT, late)).toEqual([5]);
	}, 60_000);
});

// ---------------------------------------------------------------- (f) dead generation

describe('(f) a target REBORN after the bound previews EMPTY — never the living stranger', () => {
	test('an epoch opened on the target above the bound: the children preview empty', async () => {
		const id = await host();
		const t = await target();
		const anchor = await target();
		await setPortal(PMAIN, id, [anchor]);
		await rate(t, 3);
		const r1 = await mainRow(SECTION, id, PMAIN, () => link(SECTION, id, SLOT, PMAIN, 1, t));
		const r2 = await mainRow(SECTION, id, PMAIN, () => setPortal(PMAIN, id, [anchor, t]));
		await rate(t, 4); // a row of t above the bound, so the new epoch lies above it
		const epoch = mustGet(await openEpochIfReborn(TSECTION, t), 'epoch');
		expect(epoch).toBeGreaterThan(r2 - 1);
		const preview = await read(PMAIN, SECTION, id, r1);
		// FLOORS: the frame and its RATING item are emitted — the child is EMPTY, not dropped.
		expect(frameTargets(preview, SLOT).ids).toEqual([t]);
		expectChildItem(preview, RATING, SLOT, t);
		expect(childValues(preview, RATING, SLOT, t)).toEqual([]);
		expect(childValues(await read(PMAIN, SECTION, id, null), RATING, SLOT, t)).toEqual([4]);
	}, 60_000);

	test('the bound between the EPOCH and the REBIRTH: no living record then — a key the new generation never recorded previews EMPTY, not its live value', async () => {
		const id = await host();
		const t = await target();
		const anchor = await target();
		await setPortal(PMAIN, id, [anchor]);
		await rate(t, 3); // the OLD generation's history
		// The old generation dies; the epoch lands just past its last row — BELOW the bound.
		const epoch = mustGet(await openEpochIfReborn(TSECTION, t), 'epoch');
		const r1 = await mainRow(SECTION, id, PMAIN, () => link(SECTION, id, SLOT, PMAIN, 1, t));
		const r2 = await mainRow(SECTION, id, PMAIN, () => setPortal(PMAIN, id, [anchor, t]));
		expect(epoch).toBeLessThanOrEqual(r2 - 1);
		// The REBIRTH, after the bound: RATING written with no history (an
		// explicit-id import, time machine off), the new generation's first
		// row on another key.
		await updateMatrixKeyData(TABLE, TSECTION, t, 'number', RATING, [
			{ id: 1, lang: NOLAN, value: 8 },
		]);
		await note(t, SPA, 'nueva');
		// PRECONDITION: the living generation's first visible row lies above the bound.
		const first = (await sql.unsafe(
			`SELECT MIN(id)::bigint AS id FROM matrix_time_machine
			  WHERE section_tipo = $1 AND section_id = $2 AND id >= $3 AND tm_role IS NULL`,
			[TSECTION, t, epoch],
		)) as { id: number | string | null }[];
		expect(Number(first[0]?.id)).toBeGreaterThan(r2 - 1);

		const preview = await read(PMAIN, SECTION, id, r1);
		expect(frameTargets(preview, SLOT).ids).toEqual([t]);
		expectChildItem(preview, RATING, SLOT, t);
		expect(childValues(preview, RATING, SLOT, t)).toEqual([]);
		// The as-of record itself is VIRTUAL: none of the living stranger's other
		// keys (its NOTE) rides along on it.
		const emission = new EmissionContext([], {
			tmAsOf: { rowId: r1, boundId: r2 - 1, sectionTipo: SECTION, sectionId: id, mainTipo: PMAIN },
		});
		const asOfRecord = mustGet(
			await loadFrameTargetAsOf(emission, TABLE, TSECTION, t, mustGet(emission.tmAsOf, 'asOf'), [
				RATING,
			]),
			'as-of record',
		);
		expect((asOfRecord.columns.string as Record<string, unknown> | null)?.[NOTE]).toBeUndefined();
		expect((asOfRecord.columns.number as Record<string, unknown[]> | null)?.[RATING] ?? []).toEqual(
			[],
		);
		// live (and the newest row's unbounded bound) show the living record
		expect(childValues(await read(PMAIN, SECTION, id, null), RATING, SLOT, t)).toEqual([8]);
		expect(childValues(await read(PMAIN, SECTION, id, r2), RATING, SLOT, t)).toEqual([8]);
	}, 60_000);
});

// ---------------------------------------------------------------- (h) confinement

describe('(h) confinement: a nested dataframe of a portal target stays entirely LIVE inside the preview', () => {
	test('the nested bag and its children are live; only the subject frame reads as of the row', async () => {
		const id = await host();
		const t = await target(); // PMAIN's portal target, carrying NMAIN2 + its frames
		const u = await target(); // NMAIN2's portal target
		const v = await target(); // NMAIN2's frame target
		const w = await target(); // a second NMAIN2 frame, added after the row
		await rate(v, 1);
		await save(TSECTION, t, NMAIN2, NOLAN, [
			{ action: 'set_data', value: portalItems(NMAIN2, [u]) },
		]);
		await link(TSECTION, t, NSLOT2, NMAIN2, 1, v);
		await setPortal(PMAIN, id, [t]);
		await rate(t, 3);
		const r1 = await mainRow(SECTION, id, PMAIN, () => link(SECTION, id, SLOT, PMAIN, 1, t));
		await mainRow(SECTION, id, PMAIN, () => setPortal(PMAIN, id, [t, u]));
		await rate(t, 4);
		await rate(v, 2);
		await link(TSECTION, t, NSLOT2, NMAIN2, 1, w);
		const preview = await read(PMAIN, SECTION, id, r1);
		// the subject frame: as of the row
		expect(childValues(preview, RATING, SLOT, t)).toEqual([3]);
		// the nested dataframe: bag AND children live
		expect(frameTargets(preview, NSLOT2).ids).toEqual([v, w].sort((a, b) => a - b));
		expect(childValues(preview, RATING, NSLOT2, v)).toEqual([2]);
	}, 60_000);

	test('frameTargetsAsOf answers the bound ONLY for the emission ROOT (by identity) AND its main', async () => {
		const root = makeVirtualRecord(SECTION, 77);
		const bound = { rowId: 1, boundId: 10, sectionTipo: SECTION, sectionId: 77, mainTipo: PMAIN };
		const asOf = rootedAt(bound, root);
		const emission = new EmissionContext([], { tmAsOf: asOf });
		expect(await frameTargetsAsOf(emission, PMAIN, root)).toBe(asOf);
		// the SAME address as another object (the subject met again nested): never
		expect(await frameTargetsAsOf(emission, PMAIN, cloneRecord(root))).toBeNull();
		expect(await frameTargetsAsOf(emission, PMAIN, makeVirtualRecord(SECTION, 77))).toBeNull();
		// another main of the root
		expect(await frameTargetsAsOf(emission, LMAIN, root)).toBeNull();
		// an UNROOTED bound matches no emission frame; outside a preview: never
		const unrooted = new EmissionContext([], { tmAsOf: bound });
		expect(await frameTargetsAsOf(unrooted, PMAIN, root)).toBeNull();
		expect(await frameTargetsAsOf(new EmissionContext(), PMAIN, root)).toBeNull();
	}, 60_000);

	test("a root at ANOTHER address (the history list's dd15 row record) stands for the subject: bag and anchor addressed by the subject", async () => {
		const root = makeVirtualRecord('dd15', 5);
		const asOf = rootedAt(
			{ rowId: 5, boundId: 10, sectionTipo: SECTION, sectionId: 77, mainTipo: PMAIN },
			root,
		);
		const emission = new EmissionContext([], { tmAsOf: asOf });
		expect(await frameTargetsAsOf(emission, PMAIN, root)).toBe(asOf);
		expect(subjectRowOf(asOf, root)).toEqual({ section_tipo: SECTION, section_id: 77 });
		// the subject's own record, and another dd15 row record: not the root
		expect(subjectRowOf(asOf, makeVirtualRecord(SECTION, 77))).toBeNull();
		expect(await frameTargetsAsOf(emission, PMAIN, makeVirtualRecord(SECTION, 77))).toBeNull();
		expect(await frameTargetsAsOf(emission, PMAIN, makeVirtualRecord('dd15', 6))).toBeNull();
	}, 60_000);
});

// ---------------------------------------------------------------- (i) the history list

describe("(h') confinement per FRAME: door 3 on a SHARED slot reads only the row's main's frames as of the bound", () => {
	test("another main's live frame (the caller pairing, or no pairing) keeps its LIVE children; the row's main's frame reads as of the row", async () => {
		const id = await host();
		const tp = await target(); // the row's main (PMAIN) frame target
		const tl = await target(); // ANOTHER main's (LMAIN) frame target, same slot
		const anchorT = await target();
		await rate(tp, 3);
		await rate(tl, 30);
		await setPortal(PMAIN, id, [anchorT]);
		await link(SECTION, id, SLOT, PMAIN, 1, tp);
		const r1 = await mainRow(SECTION, id, PMAIN, () => setPortal(PMAIN, id, [anchorT, tp]));
		await mainRow(SECTION, id, PMAIN, () => setPortal(PMAIN, id, [anchorT]));
		await rate(tp, 9);
		await rate(tl, 90);
		// The slot is SHARED: LMAIN's frame (id_key 1) stored in PMAIN's slot.
		const liveSlot =
			mustGet(
				(await sql.unsafe(
					`SELECT relation FROM "${TABLE}" WHERE section_tipo = $1 AND section_id = $2`,
					[SECTION, id],
				)) as { relation: Record<string, Item[]> }[],
				'host row',
			)[0]?.relation?.[SLOT] ?? [];
		expect(liveSlot.map((e) => Number(e.section_id))).toEqual([tp]);
		const foreign = {
			id: 2,
			type: 'dd490',
			section_tipo: TSECTION,
			section_id: tl,
			from_component_tipo: SLOT,
			main_component_tipo: LMAIN,
			id_key: 1,
		};
		await updateMatrixKeyData(TABLE, SECTION, id, 'relation', SLOT, [...liveSlot, foreign]);

		// CONTROL: the row's own main's frame reads as of r1 (3), live 9.
		const own = { main_component_tipo: PMAIN, id_key: 1 };
		expect(
			childValues(await read(SLOT, SECTION, id, r1, { caller: own }), RATING, SLOT, tp),
		).toEqual([3]);
		// The OTHER main's pairing at a row of PMAIN: its frame is served (floor),
		// its children == the live read's, never as of PMAIN's bound.
		const other = { main_component_tipo: LMAIN, id_key: 1 };
		const atR1 = await read(SLOT, SECTION, id, r1, { caller: other });
		const live = await read(SLOT, SECTION, id, null, { caller: other });
		expect(frameTargets(atR1, SLOT).ids).toEqual([tl]);
		expect(childValues(live, RATING, SLOT, tl)).toEqual([90]);
		expect(childValues(atR1, RATING, SLOT, tl)).toEqual([90]);
		// No pairing: each frame by its OWN main — PMAIN's as of r1, LMAIN's live.
		const unpaired = await read(SLOT, SECTION, id, r1);
		expect(childValues(unpaired, RATING, SLOT, tp)).toEqual([3]);
		expect(childValues(unpaired, RATING, SLOT, tl)).toEqual([90]);
	}, 60_000);
});

describe('(i) the history LIST: every listed row shows the frames AND frame children its preview shows', () => {
	/** Each frame target of `slot` (id_key 1) → every frame child's values: the comparable frame picture. */
	function framePicture(items: Item[], slot: string): Record<string, unknown> {
		const { ids, total } = frameTargets(items, slot);
		const children: Record<string, unknown> = {};
		for (const t of ids) {
			for (const child of FRAME_CHILDREN)
				children[`${t}.${child}`] = childValues(items, child, slot, t);
		}
		return { ids, total, children };
	}

	/** The list of `main`'s history on host `id`: row id (ASC) → that row's cell items. */
	async function listRows(main: string, id: number): Promise<Map<number, Item[]>> {
		const { data } = await runWithRequestLangs({ applicationLang: ENG, dataLang: SPA }, () =>
			readTimeMachineData({
				sqo: {
					filter_by_locators: [{ section_tipo: SECTION, section_id: id, tipo: main, lang: SPA }],
					limit: 100,
				},
				source: { lang: SPA },
				show: { ddo_map: [{ tipo: main, section_tipo: 'dd15' }] },
			} as never),
		);
		const head = (data as Item[]).find((item) => item.tipo === 'dd15');
		const rowIds = ((head?.entries as Item[] | undefined) ?? [])
			.map((e) => Number(e.matrix_id))
			.sort((a, b) => a - b);
		const byRow = new Map<number, Item[]>(rowIds.map((rowId) => [rowId, []]));
		for (const item of data as Item[]) {
			byRow.get(Number(item.row_section_id))?.push(item);
		}
		return byRow;
	}

	/** Compare list and preview for EVERY listed row; answers the pictures (callers floor them). */
	async function expectListEqualsPreview(main: string, slot: string, id: number) {
		const rows = await listRows(main, id);
		expect(rows.size).toBeGreaterThan(1); // FLOOR
		const pictures: Record<string, unknown>[] = [];
		for (const [rowId, cells] of rows) {
			const shown = framePicture(await read(main, SECTION, id, rowId, { lang: SPA }), slot);
			expect({ row: rowId, ...framePicture(cells, slot) }).toEqual({ row: rowId, ...shown });
			pictures.push(shown);
		}
		return pictures;
	}

	// CONTRACT CHANGE (nested-ddo_map plan W2, owner decision (e), 2026-11-03):
	// the host met again NESTED under its own QMAIN (QMAIN → t → BACK → host →
	// QMAIN) is a RECORD CYCLE on that path, so the repeat renders its QMAIN
	// item WITHOUT expanding its targets — its frames are not re-emitted. This
	// gate used to see the nested re-occurrence twice (the retired
	// `depth < 4` gate was the only bound) and pinned that those copies read
	// LIVE; with the cycle stopped there is no nested copy of the subject's
	// frames left to read, so it now pins the stop itself — identically in the
	// preview and in every listed row (the occurrence is the SUBJECT record in
	// both: models/portal.ts keys it by configOwnerOf, never the dd15 row).
	test("(h'') the SUBJECT's own record met again NESTED is a record cycle: stopped at the repeat, in the preview as in the list", async () => {
		const id = await host();
		const t = await target(); // QMAIN's portal target, whose BACK points at the host again
		const x = await target(); // the subject's frame at the row
		const y = await target(); // a frame linked after the row (live only)
		await rate(x, 3);
		await setPortal(QMAIN, id, [t]);
		await save(TSECTION, t, BACK, NOLAN, [
			{
				action: 'set_data',
				value: [
					{
						id: 1,
						type: 'dd151',
						section_tipo: SECTION,
						section_id: id,
						from_component_tipo: BACK,
					},
				],
			},
		]);
		const r1 = await mainRow(SECTION, id, QMAIN, () => link(SECTION, id, QSLOT, QMAIN, 1, x));
		await mainRow(SECTION, id, QMAIN, () => link(SECTION, id, QSLOT, QMAIN, 1, y));
		await rate(x, 9);
		const preview = await read(QMAIN, SECTION, id, r1, { lang: SPA });
		// THE SUBJECT (the root): its frame at r1 is [x], rating 3 as of the row.
		// The nested re-occurrence of the host (t.BACK → host → QMAIN) is the
		// cycle's repeat: its QMAIN item is there, its frames are not — never the
		// live bag [x, y] nor x at 9.
		expect(frameTargets(preview, QSLOT).ids).toEqual([x]);
		expect(childValues(preview, RATING, QSLOT, x)).toEqual([3]);
		const nestedMain = (preview as Item[]).filter(
			(item) => item.tipo === QMAIN && item.section_tipo === SECTION,
		);
		expect(nestedMain.length).toBeGreaterThan(1); // the repeat's own item still emits
		// ...and every listed row's cells == its preview, the r1 row included
		// (FLOOR: the r1 picture is the subject as of the row, x at 3).
		const pictures = await expectListEqualsPreview(QMAIN, QSLOT, id);
		const xRatings = pictures.map((p) => (p.children as Record<string, unknown>)[`${x}.${RATING}`]);
		expect(xRatings).toContainEqual([3]);
	}, 60_000);

	test('a PORTAL main: rating, relation and note of each frame target as of each row (the bound law), never live', async () => {
		const id = await host();
		const t = await target();
		const other = await target();
		await setPortal(PMAIN, id, [t]);
		await rate(t, 3);
		await note(t, SPA, 'uno');
		await link(SECTION, id, SLOT, PMAIN, 1, t);
		await rate(t, 5);
		await setPortal(PMAIN, id, [t, other]);
		await rate(t, 7);
		await note(t, SPA, 'dos');
		await relate(t, [other]);
		await setPortal(PMAIN, id, [t]);
		await rate(t, 9);
		const pictures = await expectListEqualsPreview(PMAIN, SLOT, id);
		// FLOOR: the rows differ from each other — the list is not showing one (live) state.
		const ratings = pictures.map((p) => (p.children as Record<string, unknown>)[`${t}.${RATING}`]);
		expect(ratings).toContainEqual([5]);
		expect(ratings).toContainEqual([7]);
		expect(ratings).toContainEqual([9]);
	}, 60_000);

	test('a LITERAL has_dataframe main: the same, through the literal pairing', async () => {
		const id = await host();
		const t = await target();
		const setLiteral = (value: string) =>
			save(SECTION, id, LMAIN, NOLAN, [
				{ action: 'set_data', value: [{ id: 1, lang: NOLAN, value }] },
			]);
		await setLiteral('uno');
		await rate(t, 3);
		await link(SECTION, id, LSLOT, LMAIN, 1, t);
		await rate(t, 5);
		await setLiteral('dos');
		await rate(t, 7);
		const pictures = await expectListEqualsPreview(LMAIN, LSLOT, id);
		const ratings = pictures.map((p) => (p.children as Record<string, unknown>)[`${t}.${RATING}`]);
		expect(ratings).toContainEqual([5]);
		expect(ratings).toContainEqual([7]);
	}, 60_000);

	test("a SIBLING-anchored slot: the bag and its children as of each row, addressed by the row's record (never the dd15 id)", async () => {
		const id = await host();
		expect(await createSectionRecord(SIBLING, USER_ID, new Date(), id)).toBe(id);
		const t1 = await target();
		const t2 = await target();
		const anchor = await target();
		await rate(t1, 3);
		await setPortal(SMAIN, id, [anchor]);
		await link(SIBLING, id, SSLOT, SMAIN, 1, t1);
		await setPortal(SMAIN, id, [anchor, t2]);
		await link(SIBLING, id, SSLOT, SMAIN, 1, t2);
		await rate(t1, 7);
		await setPortal(SMAIN, id, [anchor]);
		await rate(t1, 9);
		const pictures = await expectListEqualsPreview(SMAIN, SSLOT, id);
		expect(pictures.map((p) => p.ids)).toEqual([
			[t1],
			[t1, t2].sort((a, b) => a - b),
			[t1, t2].sort((a, b) => a - b),
		]);
		expect(pictures.map((p) => (p.children as Record<string, unknown>)[`${t1}.${RATING}`])).toEqual(
			[[3], [7], [9]],
		);
	}, 60_000);
});

// ---------------------------------------------------------------- (m) edges the mutation check found

describe('(m) edges a hand-mutation of the law left unpinned', () => {
	/** A bound of host `id`'s PMAIN at `boundId` (the target reads need no root). */
	const boundAt = (id: number, boundId: number) => ({
		rowId: 1,
		boundId,
		sectionTipo: SECTION,
		sectionId: id,
		mainTipo: PMAIN,
	});

	/** RATING items of target `t` emitted under SLOT. */
	const ratingItems = (items: Item[], t: number) =>
		items.filter(
			(item) =>
				item.tipo === RATING && item.from_component_tipo === SLOT && Number(item.section_id) === t,
		);

	test("isSubjectMain: an ALIAS of the row's main names it; a frame with no main (not a string) never does", async () => {
		const asOf = boundAt(1, 10);
		expect(await isSubjectMain(asOf, PMAIN)).toBe(true);
		expect(await isSubjectMain(asOf, ALIAS)).toBe(true);
		expect(await isSubjectMain(asOf, SMAIN)).toBe(false);
		expect(await isSubjectMain(asOf, undefined)).toBe(false);
		expect(await isSubjectMain(asOf, null)).toBe(false);
	}, 60_000);

	test('the NEWEST row (unbounded) of a target reborn with no visible row since: the living record IS the state — its live value, never EMPTY', async () => {
		const id = await host();
		const t = await target();
		const anchor = await target();
		await setPortal(PMAIN, id, [anchor]);
		await rate(t, 3);
		const r = await mainRow(SECTION, id, PMAIN, () => link(SECTION, id, SLOT, PMAIN, 1, t));
		const epoch = mustGet(await openEpochIfReborn(TSECTION, t), 'epoch');
		// PRECONDITIONS: r is the main key's newest row; the living generation wrote no visible row.
		expect(await rowsOf(SECTION, id, PMAIN, r)).toEqual([]);
		const living = (await sql.unsafe(
			`SELECT count(*)::int AS n FROM matrix_time_machine
			  WHERE section_tipo = $1 AND section_id = $2 AND id >= $3 AND tm_role IS NULL`,
			[TSECTION, t, epoch],
		)) as { n: number }[];
		expect(living[0]?.n).toBe(0);
		const preview = await read(PMAIN, SECTION, id, r);
		expect(frameTargets(preview, SLOT).ids).toEqual([t]);
		expect(childValues(preview, RATING, SLOT, t)).toEqual([3]);
		expect(childValues(await read(PMAIN, SECTION, id, null), RATING, SLOT, t)).toEqual([3]);
	}, 60_000);

	test('a frame target with NO live row and SILENT history is skipped exactly as the live read skips it — never a blank virtual target', async () => {
		const id = await host();
		const t = await target();
		const anchor = await target();
		await setPortal(PMAIN, id, [anchor]);
		await updateMatrixKeyData(TABLE, TSECTION, t, 'number', RATING, [
			{ id: 1, lang: NOLAN, value: 42 },
		]);
		const r = await mainRow(SECTION, id, PMAIN, () => link(SECTION, id, SLOT, PMAIN, 1, t));
		// FLOOR: while the target lives, its raw rating shows (silent history keeps live).
		expect(childValues(await read(PMAIN, SECTION, id, r), RATING, SLOT, t)).toEqual([42]);
		// The row vanishes with no history (a raw delete).
		await sql.unsafe(`DELETE FROM "${TABLE}" WHERE section_tipo = $1 AND section_id = $2`, [
			TSECTION,
			t,
		]);
		const live = await read(PMAIN, SECTION, id, null);
		const preview = await read(PMAIN, SECTION, id, r);
		expect(frameTargets(preview, SLOT).ids).toEqual([t]); // the frame itself stays
		expect(ratingItems(live, t)).toEqual([]);
		expect(ratingItems(preview, t)).toEqual([]);
	}, 60_000);

	test('a target DELETED (not reborn): its delete snapshot never floors — a silent key is EMPTY, never the snapshot value; a recorded key speaks', async () => {
		const t = await target();
		await rate(t, 3);
		await updateMatrixKeyData(TABLE, TSECTION, t, 'string', NOTE, [
			{ id: 1, lang: SPA, value: 'crudo' },
		]);
		const mark = await watermark();
		expect((await deleteSectionRecord(TSECTION, t, USER_ID)).removed).toBe(true);
		// PRECONDITION: one delete snapshot, and it carries the silent key's value.
		const snapshots = (await sql.unsafe(
			`SELECT data::text AS d FROM matrix_time_machine
			  WHERE section_tipo = $1 AND section_id = $2 AND tipo = $1 AND id > $3 AND tm_role IS NULL`,
			[TSECTION, t, mark],
		)) as { d: string }[];
		expect(snapshots.length).toBe(1);
		expect(snapshots[0]?.d).toContain('crudo');
		const emission = new EmissionContext();
		const record = mustGet(
			await loadFrameTargetAsOf(emission, TABLE, TSECTION, t, boundAt(1, MAX), [RATING, NOTE]),
			'as-of record (virtual: a child spoke)',
		);
		const ratings = (record.columns.number as Record<string, Item[]> | null)?.[RATING] ?? [];
		expect(ratings.map((item) => item.value)).toEqual([3]);
		expect((record.columns.string as Record<string, unknown> | null)?.[NOTE]).toBeUndefined();
	}, 60_000);

	test('a DEAD-generation target with a frame child of NO jsonb column (component_section_id): the child is left alone — no throw, the rest EMPTY', async () => {
		const t = await target();
		await rate(t, 3);
		const bound = await watermark();
		await rate(t, 4);
		mustGet(await openEpochIfReborn(TSECTION, t), 'epoch');
		const record = mustGet(
			await loadFrameTargetAsOf(new EmissionContext(), TABLE, TSECTION, t, boundAt(1, bound), [
				RATING,
				SECID,
			]),
			'as-of record (virtual: dead at the bound)',
		);
		expect((record.columns.number as Record<string, unknown[]> | null)?.[RATING] ?? []).toEqual([]);
	}, 60_000);

	test("(c') door 3 refuses a NON-dataframe component the row's main declares on another section at the same id — never the live value", async () => {
		const top = (await sql.unsafe(
			'SELECT COALESCE(MAX(section_id), 0)::int AS m FROM "matrix_test" WHERE section_tipo IN ($1, $2)',
			[SECTION, TSECTION],
		)) as { m: number }[];
		const nid = Number(top[0]?.m ?? 0) + 1;
		expect(await createSectionRecord(SECTION, USER_ID, new Date(), nid)).toBe(nid);
		expect(await createSectionRecord(TSECTION, USER_ID, new Date(), nid)).toBe(nid);
		await rate(nid, 6);
		const rp = await mainRow(SECTION, nid, PMAIN, () => setPortal(PMAIN, nid, [nid]));
		const caller = { main_component_tipo: PMAIN, id_key: 1 };
		// FLOOR: live, the component answers its value (PMAIN declares RATING on TSECTION).
		const live = await read(RATING, TSECTION, nid, null, { caller });
		expect(live.flatMap((item) => (item.entries as Item[]) ?? []).map((e) => e.value)).toEqual([6]);
		expect(await read(RATING, TSECTION, nid, rp, { caller })).toEqual([]);
	}, 60_000);

	test('(c-life) door 3 on an anchor DELETED after the bound: a row whose interval precedes the delete previews its frames from a virtual record', async () => {
		const id = await host();
		expect(await createSectionRecord(SIBLING, USER_ID, new Date(), id)).toBe(id);
		const t1 = await target();
		const anchorT = await target();
		const r1 = await mainRow(SECTION, id, SMAIN, () => setPortal(SMAIN, id, [anchorT]));
		await link(SIBLING, id, SSLOT, SMAIN, 1, t1);
		await rate(t1, 3);
		await mainRow(SECTION, id, SMAIN, () => setPortal(SMAIN, id, [anchorT, t1]));
		expect((await deleteSectionRecord(SIBLING, id, USER_ID)).removed).toBe(true);
		const caller = { main_component_tipo: SMAIN, id_key: 1 };
		const door3 = await read(SSLOT, SIBLING, id, r1, { caller });
		expect(frameTargets(door3, SSLOT).ids).toEqual([t1]);
		expect(childValues(door3, RATING, SSLOT, t1)).toEqual([3]);
		// door 1 agrees
		expect(frameTargets(await read(SMAIN, SECTION, id, r1), SSLOT).ids).toEqual([t1]);
	}, 60_000);
});

// ---------------------------------------------------------------- (i-snap) the record-snapshot list

describe('(i-snap) the RECORD-SNAPSHOT list (whole-record rows, tipo = section_tipo): frames from the snapshot, children as of the row', () => {
	/** The section's snapshot list (the `tipo` column filter): dd15 row id → that row's cell items. */
	async function snapshotRows(rowIds: number[]): Promise<Map<number, Item[]>> {
		const { data } = await runWithRequestLangs({ applicationLang: ENG, dataLang: SPA }, () =>
			readTimeMachineData({
				sqo: {
					section_tipo: ['dd15'],
					filter: { $and: [{ column_name: 'tipo', q: SECTION }] },
					limit: 1000,
				},
				source: { lang: SPA },
				show: {
					ddo_map: [
						{ tipo: PMAIN, section_tipo: 'dd15' },
						{ tipo: SMAIN, section_tipo: 'dd15' },
					],
				},
			} as never),
		);
		const byRow = new Map<number, Item[]>(rowIds.map((rowId) => [rowId, []]));
		for (const item of data as Item[]) byRow.get(Number(item.row_section_id))?.push(item);
		// FLOOR: every asked row is listed (its PMAIN cell emitted).
		for (const [rowId, cells] of byRow) {
			expect({ rowId, listed: cells.some((c) => c.tipo === PMAIN) }).toEqual({
				rowId,
				listed: true,
			});
		}
		return byRow;
	}

	test("a DELETED record's snapshot row: the frame + its rating (3) as they stood, though delete_target wiped the target — never the live record at <section>/<dd15 row id>", async () => {
		const id = await host();
		const t = await target();
		const anchor = await target();
		await setPortal(PMAIN, id, [anchor]);
		await rate(t, 3);
		await link(SECTION, id, SLOT, PMAIN, 1, t);
		const mark = await watermark();
		expect((await deleteSectionRecord(SECTION, id, USER_ID)).removed).toBe(true);
		const snapshot = (await rowsOf(SECTION, id, SECTION, mark))[0] as number;
		expect(snapshot).toBeGreaterThan(0);
		// PRECONDITION: the target's rating was wiped live (delete_target).
		const live = (await sql.unsafe(
			`SELECT number->$1 AS rating FROM "${TABLE}" WHERE section_tipo = $2 AND section_id = $3`,
			[RATING, TSECTION, t],
		)) as { rating: unknown }[];
		expect(live[0]?.rating ?? null).toBeNull();
		// A LIVE stranger at <section>/<dd15 row id> with its own frame (u, rating 7):
		// addressing the bag by the virtual record would read it.
		expect(await createSectionRecord(SECTION, USER_ID, new Date(), snapshot)).toBe(snapshot);
		const u = await target();
		await setPortal(PMAIN, snapshot, [anchor]);
		await rate(u, 7);
		await link(SECTION, snapshot, SLOT, PMAIN, 1, u);

		const cells = mustGet((await snapshotRows([snapshot])).get(snapshot), 'snapshot row');
		expect(frameTargets(cells, SLOT)).toEqual({ ids: [t], total: 1 });
		expect(childValues(cells, RATING, SLOT, t)).toEqual([3]);
		expect(childValues(cells, RATING, SLOT, u)).toEqual([]);
	}, 60_000);

	test('a deleted record RECOVERED by the tool (restoreSection): the recover writes its own whole-record row, so the delete snapshot still shows the rating (3) as it stood — never the delete_target-wiped live value', async () => {
		const id = await host();
		const t = await target();
		const anchor = await target();
		await setPortal(PMAIN, id, [anchor]);
		await rate(t, 3);
		await link(SECTION, id, SLOT, PMAIN, 1, t);
		const mark = await watermark();
		expect((await deleteSectionRecord(SECTION, id, USER_ID)).removed).toBe(true);
		const snapshot = (await rowsOf(SECTION, id, SECTION, mark))[0] as number;
		const snapRow = (await sql.unsafe('SELECT data FROM matrix_time_machine WHERE id = $1', [
			snapshot,
		])) as { data: unknown }[];
		await restoreSection(snapRow[0]?.data, snapshot, SECTION, id, USER_ID);
		// The recover's own audit row: ONE visible whole-record row after the snapshot.
		const recover = await rowsOf(SECTION, id, SECTION, snapshot);
		expect(recover.length).toBe(1);
		const cells = mustGet((await snapshotRows([snapshot])).get(snapshot), 'snapshot row');
		expect(frameTargets(cells, SLOT)).toEqual({ ids: [t], total: 1 });
		expect(childValues(cells, RATING, SLOT, t)).toEqual([3]);
	}, 60_000);

	test("a snapshot row on a LIVING record: children as of the main's bound (its key's next row), not the row, not live; a sibling bag addressed by the snapshot's record", async () => {
		const id = await host();
		expect(await createSectionRecord(SIBLING, USER_ID, new Date(), id)).toBe(id);
		const t = await target();
		const t1 = await target();
		const anchor = await target();
		await setPortal(PMAIN, id, [anchor]);
		await setPortal(SMAIN, id, [anchor]);
		await rate(t, 3);
		await link(SECTION, id, SLOT, PMAIN, 1, t);
		await link(SIBLING, id, SSLOT, SMAIN, 1, t1);
		await rate(t, 5);
		// The archive-restore shape: ONE whole-record row carrying the full record.
		const record = mustGet(
			await loadRecordCached(new EmissionContext(), TABLE, SECTION, id),
			'live host',
		);
		const mark = await watermark();
		await recordTimeMachine(
			{
				sectionTipo: SECTION,
				sectionId: id,
				componentTipo: SECTION,
				lang: NOLAN,
				userId: USER_ID,
				data: structuredClone(record.columns),
			},
			dbTimestamp(),
		);
		const snapshot = (await rowsOf(SECTION, id, SECTION, mark))[0] as number;
		expect(snapshot).toBeGreaterThan(0);
		await rate(t, 7);
		await mainRow(SECTION, id, PMAIN, () => setPortal(PMAIN, id, [anchor, t])); // N: ends PMAIN's interval
		await rate(t, 9);

		const cells = mustGet((await snapshotRows([snapshot])).get(snapshot), 'snapshot row');
		expect(frameTargets(cells, SLOT)).toEqual({ ids: [t], total: 1 });
		// 5 = as of the ROW (wrong: no bound); 9 = live / an unbounded bound (wrong).
		expect(childValues(cells, RATING, SLOT, t)).toEqual([7]);
		expect(frameTargets(cells, SSLOT)).toEqual({ ids: [t1], total: 1 });
	}, 60_000);
});
