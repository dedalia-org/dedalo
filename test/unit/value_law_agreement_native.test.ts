/**
 * VALUE-LAW AGREEMENT — the BEHAVIOURAL half (P2-17: DATA-14, DATA-26, DATA-27,
 * DATA-32, DATA-33). Every case here drives the engine on the SUITE database
 * against a situation this file BUILDS on a `zz` scratch TLD and tears down;
 * the hermetic twin (value_law_agreement_tripwire.test.ts) scans the tree for
 * the second copies these laws must never grow again.
 *
 * Each divergence was two code paths answering one question differently:
 *
 *   DATA-33  "what is this section's REAL section?" — getSectionRealTipo (the
 *            first relation of model 'section') vs the `relations[0].tipo`
 *            copies, which took a matrix_table for a real section. The planted
 *            offender is a section_list + section_map under a matrix_table node
 *            named at relations[0]: the naive copy would INHERIT them.
 *   DATA-14  "does an insert on a monovalue model replace?" — PHP yes, the
 *            insert branch appended (only element 0 is ever read).
 *   DATA-27  "which id does a blank dataframe slot pair at?" — the client says
 *            counter+1, the server emitted 1.
 *   DATA-32  "is this table covered by the derived store?" — the trigger was
 *            probed per table, the backfill per store.
 *   DATA-26  "is this locator's section_id a record address the index may
 *            cast?" — the SQL trigger said `^-?[0-9]+$`, the app refuses a
 *            leading zero and keeps such ids verbatim.
 *
 * Scratch: TLD `zzvl` (nodes + records, swept by dropSituation; the residue
 * count is asserted 0), matrix_test rows at reserved-high ids, and — for the
 * store case — the suite's OWN derived rows for matrix_test, deleted and
 * refilled through the engine's per-table door inside a finally.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { dispatchRqo } from '../../src/core/api/dispatch.ts';
import {
	INT4_MAX,
	INT4_MIN,
	isConvertibleSectionIdString,
	sectionIdAddressSqlPredicate,
	sectionIdAddressSqlValue,
} from '../../src/core/concepts/section_id.ts';
import {
	backfillSearchStoreTables,
	decideSearchStores,
	observeSearchStores,
	RELATION_INDEX_ADDRESS_PREDICATE,
} from '../../src/core/db/db_assets.ts';
import { readMatrixRecord } from '../../src/core/db/matrix.ts';
import { sql, withTransaction } from '../../src/core/db/postgres.ts';
import {
	clearOntologyCaches,
	findFirstDescendantTipoByModel,
	getModelByTipo,
	getNode,
	getSectionRealTipo,
	listSectionNodes,
} from '../../src/core/ontology/resolver.ts';
import { clearSectionMapCache, getSectionMap } from '../../src/core/ontology/section_map.ts';
import {
	clearRelatedListCache,
	getRelatedListChildTipos,
} from '../../src/core/resolve/relation_index.ts';
import {
	clearSearchStoreCache,
	relationIndexCovers,
	searchStoreCovers,
	tableCoveredByStore,
} from '../../src/core/search/search_store.ts';
import {
	clearSectionButtonsCache,
	sectionRelationListTipo,
} from '../../src/core/section/buttons.ts';
import { findSectionChildByModel } from '../../src/core/section/list_definitions/node_find.ts';
import { clearListCellConfigCache } from '../../src/core/section/list_definitions/section_list.ts';
import { saveComponentData } from '../../src/core/section/record/save_component.ts';
import { resolvePrincipal } from '../../src/core/security/permissions.ts';
import { createSession, getSession } from '../../src/core/security/session_store.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { cleanScratchRecord, createScratchRecord } from '../helpers/test_data.ts';

const TABLE = 'matrix_test';

// --- the situation ---------------------------------------------------------
/** The scratch matrix_table node — its term names matrix_test, like test24. */
const MATRIX_TABLE_NODE = 'zzvl9';
/** THE OFFENDERS: definition nodes planted UNDER the matrix_table node. */
const OFFENDER_SECTION_LIST = 'zzvl10';
const OFFENDER_SECTION_MAP = 'zzvl11';
const OFFENDER_RELATION_LIST = 'zzvl12';
/** Real section A — no own definition nodes; relations[0] is the matrix_table. */
const REAL_A = 'zzvl1';
const GEO = 'zzvl2'; // component_geolocation — monovalue, not lang-sliced
const TEXT_AREA = 'zzvl3'; // component_text_area — monovalue, lang-sliced
const INPUT_TEXT = 'zzvl4'; // component_input_text — MULTI-value control
const DF_MAIN = 'zzvl5'; // has_dataframe literal main
const DF_FRAME = 'zzvl6'; // its frame
/** Virtual of A — the section relation sits at index 1, AFTER the matrix_table. */
const VIRTUAL_A = 'zzvl20';
/** Real section B — carries its OWN definition nodes. */
const REAL_B = 'zzvl30';
const B_SECTION_LIST = 'zzvl31';
const B_SECTION_MAP = 'zzvl32';
const B_RELATION_LIST = 'zzvl33';
/** Virtual of B — same shape, matrix_table first. */
const VIRTUAL_B = 'zzvl40';

const MONOVALUE_RECORD = 900920;
const BLANK_SLOT_RECORD = 900921;
const TRIGGER_RECORD = 900922;
const BLANK_SLOT_COUNTER = 7;
/** A section tipo that stands for an external service's section (the trigger reads none of the ontology). */
const EXTERNAL_LIKE = 'zzvlx1';

const SITUATION = situation({
	tld: 'zzvl',
	name: 'value_law_agreement',
	nodes: [
		{ tipo: MATRIX_TABLE_NODE, model: 'matrix_table', term: { 'lg-spa': TABLE } },
		{
			tipo: OFFENDER_SECTION_LIST,
			parent: MATRIX_TABLE_NODE,
			model: 'section_list',
			term: { 'lg-spa': 'offender section_list' },
			properties: { source: { request_config: [{ show: { ddo_map: [] } }] } },
		},
		{
			tipo: OFFENDER_SECTION_MAP,
			parent: MATRIX_TABLE_NODE,
			model: 'section_map',
			term: { 'lg-spa': 'offender section_map' },
			properties: { main: { term: OFFENDER_SECTION_LIST } },
		},
		{
			tipo: OFFENDER_RELATION_LIST,
			parent: MATRIX_TABLE_NODE,
			model: 'relation_list',
			term: { 'lg-spa': 'offender relation_list' },
			relations: [{ tipo: GEO }],
		},
		{
			tipo: REAL_A,
			parent: 'test1',
			model: 'section',
			term: { 'lg-spa': 'Real A' },
			relations: [{ tipo: MATRIX_TABLE_NODE }],
		},
		{ tipo: GEO, parent: REAL_A, model: 'component_geolocation', term: { 'lg-spa': 'geo' } },
		{
			tipo: TEXT_AREA,
			parent: REAL_A,
			model: 'component_text_area',
			is_translatable: true,
			term: { 'lg-spa': 'texto largo' },
		},
		{
			tipo: INPUT_TEXT,
			parent: REAL_A,
			model: 'component_input_text',
			is_translatable: true,
			term: { 'lg-spa': 'texto' },
		},
		{
			tipo: DF_MAIN,
			parent: REAL_A,
			model: 'component_input_text',
			is_translatable: true,
			term: { 'lg-spa': 'principal con ficha' },
			properties: { has_dataframe: true },
		},
		{
			tipo: DF_FRAME,
			parent: DF_MAIN,
			model: 'component_dataframe',
			term: { 'lg-spa': 'ficha' },
		},
		{
			tipo: VIRTUAL_A,
			parent: 'test1',
			model: 'section',
			term: { 'lg-spa': 'Virtual A' },
			relations: [{ tipo: MATRIX_TABLE_NODE }, { tipo: REAL_A }],
		},
		{
			tipo: REAL_B,
			parent: 'test1',
			model: 'section',
			term: { 'lg-spa': 'Real B' },
			relations: [{ tipo: MATRIX_TABLE_NODE }],
		},
		{
			tipo: B_SECTION_LIST,
			parent: REAL_B,
			model: 'section_list',
			term: { 'lg-spa': 'B section_list' },
			properties: { source: { request_config: [{ show: { ddo_map: [] } }] } },
		},
		{
			tipo: B_SECTION_MAP,
			parent: REAL_B,
			model: 'section_map',
			term: { 'lg-spa': 'B section_map' },
			properties: { main: { term: B_SECTION_LIST } },
		},
		{
			tipo: B_RELATION_LIST,
			parent: REAL_B,
			model: 'relation_list',
			term: { 'lg-spa': 'B relation_list' },
			relations: [{ tipo: INPUT_TEXT }],
		},
		{
			tipo: VIRTUAL_B,
			parent: 'test1',
			model: 'section',
			term: { 'lg-spa': 'Virtual B' },
			relations: [{ tipo: MATRIX_TABLE_NODE }, { tipo: REAL_B }],
		},
	],
	records: [
		{ section_tipo: REAL_A, section_id: MONOVALUE_RECORD },
		{ section_tipo: REAL_A, section_id: BLANK_SLOT_RECORD },
	],
});

function clearDerivedCaches(): void {
	clearOntologyCaches();
	clearSectionMapCache();
	clearRelatedListCache();
	clearSectionButtonsCache();
	clearListCellConfigCache();
}

beforeAll(async () => {
	await ensureSituation(SITUATION);
	clearDerivedCaches();
}, 60000);

afterAll(async () => {
	expect(await dropSituation(SITUATION)).toBe(0);
	clearDerivedCaches();
});

// --- DATA-33 ---------------------------------------------------------------
describe('DATA-33 — ONE virtual→real law, consulted by every borrower', () => {
	test('getSectionRealTipo: the first relation of model section, wherever it sits; identity otherwise', async () => {
		expect(await getSectionRealTipo(REAL_A)).toBe(REAL_A);
		expect(await getSectionRealTipo(REAL_B)).toBe(REAL_B);
		expect(await getSectionRealTipo(VIRTUAL_A)).toBe(REAL_A);
		expect(await getSectionRealTipo(VIRTUAL_B)).toBe(REAL_B);
		expect(await getSectionRealTipo(MATRIX_TABLE_NODE)).toBe(MATRIX_TABLE_NODE);
		// POSITIVE CONTROL: the naive law answers the matrix_table for all four.
		for (const tipo of [REAL_A, REAL_B, VIRTUAL_A, VIRTUAL_B]) {
			const relations = (await getNode(tipo))?.relations as { tipo: string }[];
			expect(relations[0]?.tipo).toBe(MATRIX_TABLE_NODE);
			expect(await getModelByTipo(MATRIX_TABLE_NODE)).toBe('matrix_table');
		}
	});

	test('a REAL section whose relations[0] is a matrix_table inherits NOTHING from it', async () => {
		// the planted offenders exist and sit under the matrix_table node
		expect((await getNode(OFFENDER_SECTION_LIST))?.parent).toBe(MATRIX_TABLE_NODE);
		expect((await getNode(OFFENDER_SECTION_MAP))?.parent).toBe(MATRIX_TABLE_NODE);
		expect((await getNode(OFFENDER_RELATION_LIST))?.parent).toBe(MATRIX_TABLE_NODE);
		// …and no borrower serves them for the real section
		expect(await findSectionChildByModel(REAL_A, 'section_list')).toBeNull();
		expect(await getSectionMap(REAL_A)).toBeNull();
		expect(await sectionRelationListTipo(REAL_A)).toBeNull();
		expect(await getRelatedListChildTipos(REAL_A)).toEqual([]);
	});

	test('a VIRTUAL section whose section relation sits at index 1 borrows from the REAL section', async () => {
		// virtual of A: A has no definitions → null, never the offender
		expect(await findSectionChildByModel(VIRTUAL_A, 'section_list')).toBeNull();
		expect(await getSectionMap(VIRTUAL_A)).toBeNull();
		expect(await sectionRelationListTipo(VIRTUAL_A)).toBeNull();
		expect(await getRelatedListChildTipos(VIRTUAL_A)).toEqual([]);
		// virtual of B: B's own definitions
		expect((await findSectionChildByModel(VIRTUAL_B, 'section_list'))?.tipo).toBe(B_SECTION_LIST);
		expect(await getSectionMap(VIRTUAL_B)).toEqual({ main: { term: B_SECTION_LIST } });
		expect(await sectionRelationListTipo(VIRTUAL_B)).toBe(B_RELATION_LIST);
		expect(await getRelatedListChildTipos(VIRTUAL_B)).toEqual([INPUT_TEXT]);
		// the subtree walk's virtual fallback: A's components through virtual A
		expect(await findFirstDescendantTipoByModel(VIRTUAL_A, 'component_geolocation')).toBe(GEO);
		expect(await findFirstDescendantTipoByModel(VIRTUAL_A, 'section_list')).toBeNull();
	});

	test('ONTOLOGY-WIDE: getSectionRealTipo equals the model-checked law for EVERY section (floor + planted disagreement)', async () => {
		const sections = await listSectionNodes();
		expect(sections.length).toBeGreaterThan(20);
		let naiveDisagreements = 0;
		for (const { tipo } of sections) {
			// the law, re-derived independently of the resolver's implementation
			const relations = (await getNode(tipo))?.relations;
			let expected = tipo;
			for (const relation of Array.isArray(relations) ? relations : []) {
				const related = (relation as { tipo?: unknown }).tipo;
				if (typeof related !== 'string' || related === '') continue;
				if ((await getModelByTipo(related)) === 'section') {
					expected = related;
					break;
				}
			}
			expect(await getSectionRealTipo(tipo), tipo).toBe(expected);
			const naive = Array.isArray(relations)
				? (relations[0] as { tipo?: unknown } | undefined)?.tipo
				: undefined;
			if (typeof naive === 'string' && naive !== expected) naiveDisagreements++;
		}
		// anti-vacuity: the four planted sections are exactly where the two laws differ
		expect(naiveDisagreements).toBeGreaterThanOrEqual(4);
	});
});

// --- DATA-14 ---------------------------------------------------------------
type Item = Record<string, unknown> & { id?: number; lang?: string };

async function slot(column: string, tipo: string): Promise<Item[]> {
	const record = await readMatrixRecord(TABLE, REAL_A, MONOVALUE_RECORD);
	const value = (record?.columns[column as 'string'] as Record<string, unknown> | null)?.[tipo];
	return Array.isArray(value) ? (value as Item[]) : [];
}

async function insert(tipo: string, lang: string, value: Record<string, unknown>): Promise<void> {
	const result = await saveComponentData({
		componentTipo: tipo,
		sectionTipo: REAL_A,
		sectionId: MONOVALUE_RECORD,
		lang,
		changedData: [{ action: 'insert', key: null, value }] as never,
		userId: -1,
	});
	expect(result.ok, JSON.stringify(result)).toBe(true);
}

async function tmRows(): Promise<number> {
	const rows = (await sql`
		SELECT count(*)::int AS n FROM matrix_time_machine
		WHERE section_tipo = ${REAL_A} AND section_id = ${MONOVALUE_RECORD}
	`) as { n: number }[];
	return rows[0]?.n ?? 0;
}

describe('DATA-14 — an insert on a MONOVALUE model REPLACES (PHP :4128-4131)', () => {
	test('not lang-sliced (component_geolocation): the array never grows past one item', async () => {
		await insert(GEO, 'lg-spa', { lat: 1, lon: 1, zoom: 9, alt: null });
		const first = await slot('geo', GEO);
		expect(first.length).toBe(1);
		const tm = await tmRows();
		await insert(GEO, 'lg-spa', { lat: 2, lon: 2, zoom: 9, alt: null });
		const second = await slot('geo', GEO);
		expect(second.length).toBe(1);
		expect(second[0]?.lat).toBe(2);
		expect(typeof second[0]?.id).toBe('number');
		// the replace is audited like every save (it took the full-array persist)
		expect(await tmRows()).toBe(tm + 1);
	});

	test('lang-sliced (component_text_area): the CURRENT-lang slice is replaced, the other languages kept', async () => {
		await insert(TEXT_AREA, 'lg-spa', { value: 'a' });
		await insert(TEXT_AREA, 'lg-eng', { value: 'b' });
		expect((await slot('string', TEXT_AREA)).length).toBe(2);
		await insert(TEXT_AREA, 'lg-spa', { value: 'c' });
		const items = await slot('string', TEXT_AREA);
		expect(items.length).toBe(2);
		expect(items.find((item) => item.lang === 'lg-spa')?.value).toBe('c');
		expect(items.find((item) => item.lang === 'lg-eng')?.value).toBe('b');
	});

	test('CONTROL — a multi-value model (component_input_text) still APPENDS', async () => {
		await insert(INPUT_TEXT, 'lg-spa', { value: 'x' });
		await insert(INPUT_TEXT, 'lg-spa', { value: 'y' });
		const items = await slot('string', INPUT_TEXT);
		expect(items.map((item) => item.value)).toEqual(['x', 'y']);
	});
});

// --- DATA-27 ---------------------------------------------------------------
async function readFrameItems(): Promise<Record<string, unknown>[]> {
	const rqo = {
		action: 'read',
		dd_api: 'dd_core_api',
		prevent_lock: true,
		options: {},
		source: {
			typo: 'source',
			model: 'section',
			tipo: REAL_A,
			section_tipo: REAL_A,
			action: 'search',
			mode: 'list',
			lang: 'lg-spa',
		},
		sqo: {
			section_tipo: [REAL_A],
			limit: 1,
			offset: 0,
			filter_by_locators: [{ section_tipo: REAL_A, section_id: String(BLANK_SLOT_RECORD) }],
		},
		show: {
			ddo_map: [{ tipo: DF_MAIN, section_tipo: REAL_A, parent: REAL_A, mode: 'list' }],
		},
	};
	const token = createSession(-1, 'root', true);
	const session = getSession(token);
	const principal = await resolvePrincipal(-1);
	const body = (
		await dispatchRqo(
			structuredClone(rqo) as never,
			{
				requestId: 'value-law',
				clientIp: '127.0.0.1',
				session,
				csrfCandidate: session?.csrfToken ?? null,
				principal,
			} as never,
		)
	).body as { data?: { data?: Record<string, unknown>[] } };
	return (body.data?.data ?? []).filter((item) => item.tipo === DF_FRAME);
}

describe('DATA-27 — the blank dataframe slot pairs at counter+1, the id the client derives', () => {
	test('empty slice with counter 7 → the frame emits id_key 8; a stored item keeps its own id', async () => {
		await cleanScratchRecord(REAL_A, BLANK_SLOT_RECORD, TABLE);
		await createScratchRecord(
			REAL_A,
			BLANK_SLOT_RECORD,
			{
				data: {
					section_id: BLANK_SLOT_RECORD,
					section_tipo: REAL_A,
					counters: { [DF_MAIN]: BLANK_SLOT_COUNTER },
				},
			},
			{ table: TABLE },
		);
		const blank = await readFrameItems();
		expect(blank.length).toBe(1);
		expect(blank[0]?.id_key).toBe(BLANK_SLOT_COUNTER + 1);
		expect(blank[0]?.main_component_tipo).toBe(DF_MAIN);

		// CONTROL: a stored item pairs at ITS id, never at the provisional one
		await createScratchRecord(
			REAL_A,
			BLANK_SLOT_RECORD,
			{
				data: {
					section_id: BLANK_SLOT_RECORD,
					section_tipo: REAL_A,
					counters: { [DF_MAIN]: BLANK_SLOT_COUNTER },
				},
				string: { [DF_MAIN]: [{ id: 3, lang: 'lg-spa', value: 'stored' }] },
			},
			{ table: TABLE },
		);
		const stored = await readFrameItems();
		expect(stored.map((item) => item.id_key)).toEqual([3]);
	});
});

// --- DATA-32 ---------------------------------------------------------------
async function storeRowsFor(table: string, sectionTipo?: string): Promise<number> {
	// Optionally narrowed to ONE section: the whole-table count is not a
	// stable quantity in full-suite order (earlier files leave `matrix_test`
	// records whose store rows predate a value change, so a fresh backfill
	// legitimately derives a different total) — the refill assertion below
	// compares only the rows of the section this file OWNS.
	const rows = (await sql.unsafe(
		`SELECT count(*)::int AS n FROM matrix_string_search s
		 WHERE EXISTS (SELECT 1 FROM "${table}" t WHERE t.section_tipo = s.section_tipo AND t.section_id = s.section_id)
		   AND ($1::text IS NULL OR s.section_tipo = $1::text)`,
		[sectionTipo ?? null],
	)) as { n: number }[];
	return rows[0]?.n ?? 0;
}

describe('DATA-32 — coverage and backfill are PER (store, table)', () => {
	test('a table whose store rows are gone is uncovered while its siblings stay covered (rolled back)', async () => {
		clearSearchStoreCache();
		expect(await storeRowsFor(TABLE)).toBeGreaterThan(0);
		expect(await storeRowsFor('matrix_users')).toBeGreaterThan(0);
		expect(await tableCoveredByStore('matrix_string_search', TABLE)).toBe(true);
		expect(await searchStoreCovers('matrix_users')).toBe(true);
		const sentinel = new Error('rollback');
		await expect(
			withTransaction(async () => {
				await sql.unsafe(
					`DELETE FROM matrix_string_search s USING "${TABLE}" t
					 WHERE s.section_tipo = t.section_tipo AND s.section_id = t.section_id`,
					[],
				);
				clearSearchStoreCache();
				// the store as a WHOLE is still populated — the old store-global probe
				// would have said "covered" here
				expect(await storeRowsFor('matrix_users')).toBeGreaterThan(0);
				expect(await searchStoreCovers(TABLE)).toBe(false);
				expect(await searchStoreCovers('matrix_users')).toBe(true);
				// the boot decision names exactly the (store, table) pair
				const observations = await observeSearchStores(new Set([TABLE, 'matrix_users']));
				const decision = decideSearchStores({ ddlNeeded: false }, observations);
				expect(decision.tablesNeedingBackfill).toEqual([
					{ store: 'matrix_string_search', table: TABLE },
				]);
				expect(decision.healthy).toBe(false);
				throw sentinel;
			}),
		).rejects.toBe(sentinel);
		clearSearchStoreCache();
		expect(await searchStoreCovers(TABLE)).toBe(true);
	});

	test('the per-table refill restores exactly that table`s rows and touches no sibling', async () => {
		// Measured on the section this file owns (REAL_A's records), not the
		// whole table — see storeRowsFor.
		const before = await storeRowsFor(TABLE, REAL_A);
		const usersBefore = await storeRowsFor('matrix_users');
		expect(before).toBeGreaterThan(0);
		try {
			await sql.unsafe(
				`DELETE FROM matrix_string_search s USING "${TABLE}" t
				 WHERE s.section_tipo = t.section_tipo AND s.section_id = t.section_id`,
				[],
			);
			clearSearchStoreCache();
			expect(await storeRowsFor(TABLE)).toBe(0);
			expect(await searchStoreCovers(TABLE)).toBe(false);
		} finally {
			const response = await backfillSearchStoreTables([
				{ store: 'matrix_string_search', table: TABLE },
			]);
			expect(response.errors).toEqual([]);
			clearSearchStoreCache();
		}
		expect(await storeRowsFor(TABLE, REAL_A)).toBe(before);
		expect(await storeRowsFor(TABLE)).toBeGreaterThan(0);
		expect(await storeRowsFor('matrix_users')).toBe(usersBefore);
		expect(await searchStoreCovers(TABLE)).toBe(true);
		expect(await relationIndexCovers([TABLE])).toBe(true);
	});
});

// --- DATA-26 ---------------------------------------------------------------
/** The value corpus both sides of the law are measured on. */
const CORPUS = [
	'0',
	'7',
	'-1',
	'-666',
	'1338683',
	'001338683', // zero-padded external id — the DATA-26 class
	'01',
	'-0',
	'-01',
	'Q42',
	'search_1',
	'',
	' 7',
	'7 ',
	'1e3',
	'0x10',
	'1.0',
	String(INT4_MAX),
	String(INT4_MAX + 1),
	String(INT4_MIN),
	String(INT4_MIN - 1),
	'9007199254740991',
	'9007199254740993',
	'12345678901234567890',
	'-12345678901234567890',
];

/** The JS side of the SQL predicate: the app rule ∧ the int4 column range. */
function jsIndexable(value: string): boolean {
	if (!isConvertibleSectionIdString(value)) return false;
	const n = Number(value);
	return n >= INT4_MIN && n <= INT4_MAX;
}

describe('DATA-26 — the SQL record-address predicate agrees with the app rule', () => {
	test('the predicate and isConvertibleSectionIdString ∧ int4 agree on every corpus value', async () => {
		const rows = (await sql.unsafe(
			`SELECT v, ${sectionIdAddressSqlPredicate('v')} AS ok
			 FROM jsonb_array_elements_text($1::text::jsonb) AS t(v)`,
			[JSON.stringify(CORPUS)],
		)) as { v: string; ok: boolean }[];
		expect(rows.length).toBe(CORPUS.length);
		for (const { v, ok } of rows) {
			expect(ok, JSON.stringify(v)).toBe(jsIndexable(v));
		}
		// anti-vacuity: both classes are populated
		expect(rows.filter(({ ok }) => ok).length).toBeGreaterThanOrEqual(7);
		expect(rows.filter(({ ok }) => !ok).length).toBeGreaterThanOrEqual(10);
		// and the DATA-26 class itself is refused
		expect(rows.find(({ v }) => v === '001338683')?.ok).toBe(false);
		expect(rows.find(({ v }) => v === '1338683')?.ok).toBe(true);
	});

	test('the VALUE form (hop joins, T1-36) answers the address or NULL, and never raises', async () => {
		// One statement over the whole corpus: a single unguarded cast of 'Q42'
		// or a past-int4 value would abort it (22P02 / 22003).
		const rows = (await sql.unsafe(
			`SELECT v, ${sectionIdAddressSqlValue('v')} AS address
			 FROM jsonb_array_elements_text($1::text::jsonb) AS t(v)`,
			[JSON.stringify(CORPUS)],
		)) as { v: string; address: number | null }[];
		expect(rows.length).toBe(CORPUS.length);
		for (const { v, address } of rows) {
			expect(address, JSON.stringify(v)).toBe(jsIndexable(v) ? Number(v) : null);
		}
		// the DATA-26 class reaches no record; its unpadded twin reaches its own
		expect(rows.find(({ v }) => v === '001338683')?.address).toBeNull();
		expect(rows.find(({ v }) => v === '1338683')?.address).toBe(1338683);
		expect(rows.filter(({ address }) => address !== null).length).toBeGreaterThanOrEqual(7);
		expect(rows.filter(({ address }) => address === null).length).toBeGreaterThanOrEqual(10);
	});

	test('the LIVE trigger indexes the address and skips the zero-padded twin (rolled back)', async () => {
		const sentinel = new Error('rollback');
		const relation = {
			[INPUT_TEXT]: [
				{
					type: 'dd151',
					section_tipo: EXTERNAL_LIKE,
					section_id: '001338683',
					from_component_tipo: INPUT_TEXT,
				},
				{
					type: 'dd151',
					section_tipo: EXTERNAL_LIKE,
					section_id: '1338683',
					from_component_tipo: INPUT_TEXT,
				},
				{ type: 'dd151', section_tipo: REAL_B, section_id: 5, from_component_tipo: INPUT_TEXT },
				{
					type: 'dd151',
					section_tipo: REAL_B,
					section_id: String(INT4_MAX + 1),
					from_component_tipo: INPUT_TEXT,
				},
			],
		};
		await expect(
			withTransaction(async () => {
				await sql.unsafe(
					`INSERT INTO "${TABLE}" (section_id, section_tipo, relation) VALUES ($1, $2, $3::text::jsonb)`,
					[TRIGGER_RECORD, REAL_A, JSON.stringify(relation)],
				);
				const indexed = (await sql.unsafe(
					`SELECT target_section_tipo, target_section_id FROM matrix_relation_index
					 WHERE section_tipo = $1 AND section_id = $2 ORDER BY target_section_id`,
					[REAL_A, TRIGGER_RECORD],
				)) as { target_section_tipo: string; target_section_id: number }[];
				expect(indexed).toEqual([
					{ target_section_tipo: REAL_B, target_section_id: 5 },
					{ target_section_tipo: EXTERNAL_LIKE, target_section_id: 1338683 },
				]);
				throw sentinel;
			}),
		).rejects.toBe(sentinel);
		const residue = (await sql.unsafe(
			'SELECT 1 FROM matrix_relation_index WHERE section_tipo = $1 AND section_id = $2',
			[REAL_A, TRIGGER_RECORD],
		)) as unknown[];
		expect(residue.length).toBe(0);
	});

	test('the backfill twin carries the SAME predicate the trigger body does', async () => {
		const rows = (await sql.unsafe(
			`SELECT p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
			 WHERE n.nspname = 'public' AND p.proname = 'matrix_relation_index_sync'`,
			[],
		)) as { prosrc: string }[];
		expect(rows[0]?.prosrc).toContain(RELATION_INDEX_ADDRESS_PREDICATE);
	});
});
