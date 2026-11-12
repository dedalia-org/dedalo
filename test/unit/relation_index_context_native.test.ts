/**
 * T0-8 — a CONFIG-LESS component_relation_index ships its pointing sections'
 * related_list columns in its CONTEXT (TS-native gate; the frozen store's
 * PHP context is compared in test/parity/relation_index_get_data_differential).
 *
 * The client (common.js get_columns_map) builds the index's columns from
 * `context.request_config[*].show.ddo_map` items whose `parent` is the index
 * tipo, and binds each cell to a context by tipo + mode (+ section_tipo). Before
 * T0-8 a config-less index (hierarchy40; suite twin `test25` in test3) shipped
 * `request_config: []` and self-parented (get_data) or absent (section read)
 * cell contexts: no column rendered. The contract pinned here
 * (WC-2026-11-11-relation-index-related-list-context, owner decisions D1-D4):
 *
 *   - own dedalo config: `show.ddo_map` ⊇ {tipo, section_tipo: <pointing>,
 *     parent: <index>, mode: 'related_list'} per related_list column of EVERY
 *     pointing section; `sqo.section_tipo` = the ENRICHED pointing-section
 *     ddos only — never the own section (D2); in list AND edit (D1); the FULL
 *     pointing-section set on every page, offset > 0 too (D4);
 *   - every related_list cell context: parent = the index tipo, mode
 *     related_list — in the get_data door AND the section read;
 *   - every related_list data cell: parent = the index tipo (from_component_tipo
 *     stays the cell's own tipo — PHP wire);
 *   - no pointing-section (model section) context (D3);
 *   - per viewer: a column the viewer may not read has NO ddo AND NO data cell.
 *
 * THE SITUATION IS BUILT HERE (suite DB, marked; scratch rows swept before and
 * after): dd96 pointers from scratch test3 rows (test54 slot) and from a
 * scratch row of a second pointing section, test1068 (relation_list test1087
 * → [test1071]), at three hosts:
 *   test3/MAIN_HOST_ID      ← 3 test3 rows + 1 test1068 row (two sections)
 *   test3/SOLE_HOST_ID      ← 1 test1068 row only (D2: own section test3 absent)
 *   test3/CRAWL_RECORD_IN_A ← 2 test3 rows in the editor persona's project
 * The suite DB holds no dd96 reference of its own, so every count is ours.
 */

import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { dispatchRqo } from '../../src/core/api/dispatch.ts';
import { readMatrixRecord } from '../../src/core/db/matrix.ts';
import { updateMatrixRecord } from '../../src/core/db/matrix_write.ts';
import { getMatrixTableFromTipo } from '../../src/core/ontology/resolver.ts';
import { flattenConfigDdoMaps } from '../../src/core/relations/config_ddo_map.ts';
import { resolvePrincipal } from '../../src/core/security/permissions.ts';
import { createSession, getSession } from '../../src/core/security/session_store.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { clearAclIdentityCaches } from '../helpers/acl_identity_fixture.ts';
import {
	CRAWL_DENIED_SECTION,
	CRAWL_EDITOR_PROFILE_ID,
	CRAWL_EDITOR_USER_ID,
	CRAWL_EDITOR_USERNAME,
	CRAWL_FILTER_COMPONENT,
	CRAWL_PROJECT_A,
	CRAWL_RECORD_IN_A,
	installCrawlPersonaFixture,
	removeCrawlPersonaFixture,
} from '../helpers/crawl_persona_fixture.ts';
import { registerSessionCleanup } from '../helpers/session_cleanup.ts';
import { cleanScratchRecord, createScratchRecord } from '../helpers/test_data.ts';

registerSessionCleanup();

/** The config-less relation_index twin (hierarchy40's shape: source {mode:'external'}). */
const INDEX = 'test25';
const HOST_SECTION = 'test3';
/** test3's related_list column (relation_list test138 → [test52]). */
const TEST3_COLUMN = 'test52';
/** The second pointing section and its related_list column (relation_list test1087 → [test1071]). */
const SECOND_SECTION = 'test1068';
const SECOND_COLUMN = 'test1071';
/** The test3 slot the pointers sit in (component_relation_related), and test1068's (a portal). */
const TEST3_POINTER_SLOT = 'test54';
const SECOND_POINTER_SLOT = 'test1083';

/** Scratch ids (explicit; the suite DB is the isolation, not the band). */
/**
 * The two-section host is a SCRATCH record, never test3/1: the client suite's
 * own pointer fixture (relation_index_pointer_fixture.ts, 952081 → test3/1)
 * survives a crashed client run, and every count below must be ours alone.
 */
const MAIN_HOST_ID = 948351;
const TEST3_POINTERS_TO_MAIN = [948301, 948302, 948303];
const SECOND_POINTER_TO_MAIN = 948311;
const SOLE_HOST_ID = 948321;
const SECOND_POINTER_TO_SOLE = 948312;
const TEST3_POINTERS_TO_PERSONA = [948331, 948332];
/** A test1068 pointer at the persona record: a section the EDITOR may not read (its profile grants none). */
const SECOND_POINTER_TO_PERSONA = 948313;
/** The LIST-read hosts: one pointed at by test3 only (948342 → 948341); 948301 is pointed at by nothing. */
const TEST3_ONLY_HOST_ID = 948341;
const TEST3_POINTER_TO_TEST3_ONLY = 948342;
/**
 * The TRANSLATABLE-column host: one test3 pointer whose test52 (translatable
 * input_text) value exists in lg-spa ONLY — a related_list cell read in the
 * nolan slice comes back empty (the 2026-11-11 blank-column regression).
 */
const LANG_HOST_ID = 948361;
const LANG_POINTER_ID = 948362;
const LANG_POINTER_VALUE = 'relation_index translatable column value';

interface ScratchRow {
	readonly sectionTipo: string;
	readonly sectionId: number;
}

let secondTable = 'matrix_test';
const scratchRows: ScratchRow[] = [
	{ sectionTipo: HOST_SECTION, sectionId: MAIN_HOST_ID },
	...TEST3_POINTERS_TO_MAIN.map((sectionId) => ({ sectionTipo: HOST_SECTION, sectionId })),
	{ sectionTipo: HOST_SECTION, sectionId: SOLE_HOST_ID },
	...TEST3_POINTERS_TO_PERSONA.map((sectionId) => ({ sectionTipo: HOST_SECTION, sectionId })),
	{ sectionTipo: HOST_SECTION, sectionId: TEST3_ONLY_HOST_ID },
	{ sectionTipo: HOST_SECTION, sectionId: TEST3_POINTER_TO_TEST3_ONLY },
	{ sectionTipo: HOST_SECTION, sectionId: LANG_HOST_ID },
	{ sectionTipo: HOST_SECTION, sectionId: LANG_POINTER_ID },
	{ sectionTipo: SECOND_SECTION, sectionId: SECOND_POINTER_TO_MAIN },
	{ sectionTipo: SECOND_SECTION, sectionId: SECOND_POINTER_TO_SOLE },
	{ sectionTipo: SECOND_SECTION, sectionId: SECOND_POINTER_TO_PERSONA },
];

function tableOf(row: ScratchRow): string {
	return row.sectionTipo === SECOND_SECTION ? secondTable : 'matrix_test';
}

async function sweep(): Promise<void> {
	for (const row of scratchRows)
		await cleanScratchRecord(row.sectionTipo, row.sectionId, tableOf(row));
}

/** A dd96 indexation locator in `slot`, pointing at test3/`targetId`. */
function dd96Pointer(slot: string, targetId: number): Record<string, unknown> {
	return {
		[slot]: [
			{
				id: 1,
				type: 'dd96',
				section_id: targetId,
				section_tipo: HOST_SECTION,
				from_component_tipo: slot,
			},
		],
	};
}

/** The editor persona's project assignment (so its scoped search sees the pointing rows). */
function projectA(): Record<string, unknown> {
	return {
		[CRAWL_FILTER_COMPONENT]: [
			{
				id: 1,
				type: 'dd675',
				section_id: CRAWL_PROJECT_A,
				section_tipo: 'dd153',
				from_component_tipo: CRAWL_FILTER_COMPONENT,
			},
		],
	};
}

/**
 * Narrow the editor persona's profile (a fixture row THIS file installs and
 * removes): it keeps test25 (the index) but loses the related_list column
 * test52 — so the column must vanish from its ddo map AND its data. Returns
 * the RESTORE (the gates before and after run on the full grant set).
 */
async function revokeColumnFromEditor(): Promise<() => Promise<void>> {
	await assertTestDatabase('relation_index_context_native.revokeColumnFromEditor');
	const profile = await readMatrixRecord('matrix_profiles', 'dd234', CRAWL_EDITOR_PROFILE_ID);
	const grants = ((profile?.columns.misc as { dd774?: { tipo: string }[] } | null)?.dd774 ??
		[]) as { tipo: string; section_tipo: string }[];
	expect(grants.some((grant) => grant.tipo === TEST3_COLUMN)).toBe(true);
	expect(grants.some((grant) => grant.tipo === INDEX)).toBe(true);
	const narrowed = grants.filter(
		(grant) => !(grant.tipo === TEST3_COLUMN && grant.section_tipo === HOST_SECTION),
	);
	await updateMatrixRecord('matrix_profiles', 'dd234', CRAWL_EDITOR_PROFILE_ID, {
		// a parsed object: the engine's one jsonb codec encodes it (never a pre-stringified scalar)
		misc: { ...(profile?.columns.misc as object), dd774: narrowed },
	});
	clearAclIdentityCaches();
	return async () => {
		await updateMatrixRecord('matrix_profiles', 'dd234', CRAWL_EDITOR_PROFILE_ID, {
			misc: { ...(profile?.columns.misc as object), dd774: grants },
		});
		clearAclIdentityCaches();
	};
}

/** Run `body` with test52 revoked from the editor, the grant restored after (even on failure). */
async function withColumnRevoked(body: () => Promise<void>): Promise<void> {
	const restore = await revokeColumnFromEditor();
	try {
		await body();
	} finally {
		await restore();
	}
}

beforeAll(async () => {
	await assertTestDatabase('relation_index_context_native');
	secondTable = (await getMatrixTableFromTipo(SECOND_SECTION)) ?? 'matrix_test';
	await sweep(); // a crashed run's leftovers
	await installCrawlPersonaFixture();
	await createScratchRecord(HOST_SECTION, MAIN_HOST_ID, {});
	for (const id of TEST3_POINTERS_TO_MAIN) {
		await createScratchRecord(HOST_SECTION, id, {
			relation: dd96Pointer(TEST3_POINTER_SLOT, MAIN_HOST_ID),
		});
	}
	await createScratchRecord(
		SECOND_SECTION,
		SECOND_POINTER_TO_MAIN,
		{ relation: dd96Pointer(SECOND_POINTER_SLOT, MAIN_HOST_ID) },
		{ table: secondTable },
	);
	await createScratchRecord(HOST_SECTION, SOLE_HOST_ID, {});
	await createScratchRecord(
		SECOND_SECTION,
		SECOND_POINTER_TO_SOLE,
		{ relation: dd96Pointer(SECOND_POINTER_SLOT, SOLE_HOST_ID) },
		{ table: secondTable },
	);
	for (const id of TEST3_POINTERS_TO_PERSONA) {
		await createScratchRecord(HOST_SECTION, id, {
			relation: { ...dd96Pointer(TEST3_POINTER_SLOT, CRAWL_RECORD_IN_A), ...projectA() },
		});
	}
	await createScratchRecord(
		SECOND_SECTION,
		SECOND_POINTER_TO_PERSONA,
		{ relation: dd96Pointer(SECOND_POINTER_SLOT, CRAWL_RECORD_IN_A) },
		{ table: secondTable },
	);
	await createScratchRecord(HOST_SECTION, TEST3_ONLY_HOST_ID, {});
	await createScratchRecord(HOST_SECTION, TEST3_POINTER_TO_TEST3_ONLY, {
		relation: dd96Pointer(TEST3_POINTER_SLOT, TEST3_ONLY_HOST_ID),
	});
	await createScratchRecord(HOST_SECTION, LANG_HOST_ID, {});
	await createScratchRecord(HOST_SECTION, LANG_POINTER_ID, {
		relation: dd96Pointer(TEST3_POINTER_SLOT, LANG_HOST_ID),
		string: { [TEST3_COLUMN]: [{ id: 1, lang: 'lg-spa', value: LANG_POINTER_VALUE }] },
	});
}, 60000);

afterAll(async () => {
	await sweep();
	await removeCrawlPersonaFixture();
	for (const row of scratchRows) {
		expect(await readMatrixRecord(tableOf(row), row.sectionTipo, row.sectionId)).toBeNull();
	}
});

// ── the reads ───────────────────────────────────────────────────────────────

type Entry = Record<string, unknown> & {
	tipo?: string;
	section_tipo?: string;
	mode?: string;
	parent?: string;
	model?: string;
	request_config?: ConfigItem[];
};
type ConfigItem = {
	api_engine?: string;
	sqo?: {
		section_tipo?: { tipo?: string; typo?: string; model?: string; matrix_table?: string }[];
	};
	show?: { ddo_map?: Ddo[]; sqo_config?: { limit?: number; offset?: number } };
};
type Ddo = { tipo: string; section_tipo: string; parent: string; mode: string; model?: string };
type Item = Record<string, unknown> & {
	tipo?: string;
	section_tipo?: string;
	section_id?: unknown;
	mode?: string;
	parent?: string;
	from_component_tipo?: string;
};
interface Answer {
	context: Entry[];
	data: Item[];
}

/**
 * The session's data language for the reads below (dispatch seeds
 * currentDataLang() from it). Pinned to lg-spa — the lang the translatable
 * fixture value lives in — so no gate borrows the install's menu default.
 */
const SESSION_DATA_LANG = 'lg-spa';

async function requestContext(userId: number, username: string, isAdmin: boolean) {
	const token = createSession(userId, username, isAdmin);
	const stored = getSession(token);
	const session =
		stored === null || stored === undefined ? stored : { ...stored, dataLang: SESSION_DATA_LANG };
	return {
		requestId: 'relation_index_context_native',
		clientIp: '127.0.0.1',
		session,
		csrfCandidate: session?.csrfToken ?? null,
		principal: await resolvePrincipal(userId),
	};
}

const ROOT = { userId: -1, username: 'root', isAdmin: true };
const EDITOR = { userId: CRAWL_EDITOR_USER_ID, username: CRAWL_EDITOR_USERNAME, isAdmin: false };

async function call(rqo: Record<string, unknown>, as = ROOT): Promise<Answer> {
	const result = await dispatchRqo(
		rqo as never,
		(await requestContext(as.userId, as.username, as.isAdmin)) as never,
	);
	const body = result.body as { error?: unknown; data?: { context?: Entry[]; data?: Item[] } };
	expect(body.error ?? null).toBeNull();
	return { context: body.data?.context ?? [], data: body.data?.data ?? [] };
}

/** The error code a request answers with (null = served). */
async function errorCodeOf(rqo: Record<string, unknown>, as = ROOT): Promise<string | null> {
	const result = await dispatchRqo(
		rqo as never,
		(await requestContext(as.userId, as.username, as.isAdmin)) as never,
	);
	const error = (result.body as { error?: { code?: string } | null }).error;
	return error?.code ?? null;
}

function getData(
	hostId: number,
	mode: 'list' | 'edit',
	page: { limit: number; offset: number },
	as = ROOT,
): Promise<Answer> {
	return call(
		{
			action: 'read',
			dd_api: 'dd_core_api',
			prevent_lock: true,
			options: {},
			source: {
				typo: 'source',
				model: 'component_relation_index',
				tipo: INDEX,
				section_tipo: HOST_SECTION,
				section_id: hostId,
				mode,
				lang: 'lg-spa',
				action: 'get_data',
			},
			sqo: { section_tipo: [HOST_SECTION], ...page },
		},
		as,
	);
}

/** The section EDIT read of one host record (the term edit form's door — no show sent). */
function sectionEdit(hostId: number, as = ROOT): Promise<Answer> {
	return call(
		{
			action: 'read',
			dd_api: 'dd_core_api',
			prevent_lock: true,
			options: {},
			source: {
				typo: 'source',
				model: 'section',
				tipo: HOST_SECTION,
				section_tipo: HOST_SECTION,
				section_id: hostId,
				mode: 'edit',
				lang: 'lg-spa',
				action: 'search',
			},
			sqo: {
				section_tipo: [HOST_SECTION],
				limit: 1,
				offset: 0,
				filter_by_locators: [{ section_tipo: HOST_SECTION, section_id: hostId }],
			},
		},
		as,
	);
}

/**
 * A section LIST read of several host records with test25 as its one column
 * (the client's section list sends its show map) — one node, many rows.
 */
function sectionListWithIndex(hostIds: readonly number[]): Promise<Answer> {
	return call({
		action: 'read',
		dd_api: 'dd_core_api',
		prevent_lock: true,
		options: {},
		source: {
			typo: 'source',
			model: 'section',
			tipo: HOST_SECTION,
			section_tipo: HOST_SECTION,
			mode: 'list',
			lang: 'lg-spa',
			action: 'search',
		},
		sqo: {
			section_tipo: [HOST_SECTION],
			limit: hostIds.length,
			offset: 0,
			filter_by_locators: hostIds.map((id) => ({ section_tipo: HOST_SECTION, section_id: id })),
		},
		show: {
			ddo_map: [
				{
					typo: 'ddo',
					tipo: INDEX,
					section_tipo: HOST_SECTION,
					parent: HOST_SECTION,
					mode: 'list',
				},
			],
		},
	});
}

/**
 * The PAGING get_data the CLIENT builds from a returned index context
 * (common.js build_rqo_show, top-level instance — sends_own_show is false, so
 * no show travels): `sqo.section_tipo` = the context's dedalo sqo.section_tipo
 * mapped to tipos (`[self.section_tipo]` only when the item has no sqo), the
 * limit from show.sqo_config, the host record pinned in filter_by_locators.
 * Sent through dispatchRqo — Gate B (dd_core_api gateReadTargets) included —
 * and `call` fails on any error envelope.
 */
function clientPage(
	entry: Entry,
	hostId: number,
	mode: 'list' | 'edit',
	pageIndex: number,
	as = ROOT,
): Promise<Answer> {
	const item = dedaloItem(entry);
	const sqoConfig = item.show?.sqo_config;
	const sections = item.sqo?.section_tipo
		? item.sqo.section_tipo.map((ddo) => String(ddo.tipo))
		: [HOST_SECTION];
	const limit = sqoConfig?.limit ?? 10;
	return call(clientPageRqo(sections, hostId, mode, limit, limit * pageIndex), as);
}

/** The page rqo build_rqo_show produces (see clientPage). */
function clientPageRqo(
	sections: readonly string[],
	hostId: number,
	mode: 'list' | 'edit',
	limit: number,
	offset: number,
): Record<string, unknown> {
	return {
		action: 'read',
		dd_api: 'dd_core_api',
		prevent_lock: true,
		options: {},
		source: {
			typo: 'source',
			type: 'component',
			action: 'get_data',
			model: 'component_relation_index',
			tipo: INDEX,
			section_tipo: HOST_SECTION,
			section_id: hostId,
			mode,
			lang: 'lg-spa',
		},
		sqo: {
			section_tipo: sections,
			limit,
			offset,
			filter_by_locators: [{ section_tipo: HOST_SECTION, section_id: hostId }],
		},
	};
}

// ── projections ─────────────────────────────────────────────────────────────

/** The index's OWN context entry (exactly one per read). */
function indexEntry(answer: Answer, mode: string): Entry {
	const entries = answer.context.filter(
		(entry) => entry.tipo === INDEX && entry.section_tipo === HOST_SECTION && entry.mode === mode,
	);
	expect(entries.length).toBe(1);
	return entries[0] as Entry;
}

/** The index's own dedalo config item. */
function dedaloItem(entry: Entry): ConfigItem {
	const item = (entry.request_config ?? []).find(
		(candidate) => (candidate.api_engine ?? 'dedalo') === 'dedalo',
	);
	expect(item).toBeDefined();
	return item as ConfigItem;
}

function ddoMapOf(entry: Entry): Ddo[] {
	return dedaloItem(entry).show?.ddo_map ?? [];
}

function sqoSectionsOf(entry: Entry): string[] {
	return (dedaloItem(entry).sqo?.section_tipo ?? []).map((ddo) => String(ddo.tipo));
}

/** The related_list CELL items of the index (data side). */
function cellItems(answer: Answer, columnTipo: string): Item[] {
	return answer.data.filter((item) => item.tipo === columnTipo && item.mode === 'related_list');
}

/** The related_list CELL context entries of a column. */
function cellEntries(answer: Answer, columnTipo: string): Entry[] {
	return answer.context.filter(
		(entry) => entry.tipo === columnTipo && entry.mode === 'related_list',
	);
}

/** The full client contract for ONE column of the index, on one answer. */
function expectColumn(answer: Answer, entry: Entry, columnTipo: string, section: string): void {
	const ddo = ddoMapOf(entry).find(
		(candidate) => candidate.tipo === columnTipo && candidate.section_tipo === section,
	);
	expect(ddo).toMatchObject({
		tipo: columnTipo,
		section_tipo: section,
		parent: INDEX,
		mode: 'related_list',
	});
	const contexts = cellEntries(answer, columnTipo);
	expect(contexts.length).toBe(1);
	expect(contexts[0]).toMatchObject({ section_tipo: section, parent: INDEX });
	const cells = cellItems(answer, columnTipo);
	expect(cells.length).toBeGreaterThan(0);
	for (const cell of cells) {
		expect(cell.parent).toBe(INDEX);
		expect(cell.from_component_tipo).toBe(columnTipo); // PHP wire: own tipo
	}
}

/** A served page of the index: its own item is there, at `offset`. */
function expectIndexPage(answer: Answer, offset: number): void {
	const ownItem = answer.data.find((item) => item.tipo === INDEX) as
		| { pagination?: { offset?: number } }
		| undefined;
	expect(ownItem).toBeDefined();
	expect(ownItem?.pagination?.offset).toBe(offset);
}

/** D3: no pointing-section (model section) context entry anywhere in a get_data answer. */
function expectNoSectionContexts(answer: Answer): void {
	expect(answer.context.filter((entry) => entry.model === 'section')).toEqual([]);
}

// ── the gates ───────────────────────────────────────────────────────────────

describe('relation_index (config-less) carries its related_list columns', () => {
	for (const mode of ['list', 'edit'] as const) {
		test(`get_data ${mode} on test25@test3/MAIN_HOST: merged ddo_map, enriched sqo, cells parented to the index`, async () => {
			const answer = await getData(MAIN_HOST_ID, mode, { limit: 10, offset: 0 });
			const entry = indexEntry(answer, mode);
			// Non-vacuity FIRST: an empty map is the bug itself.
			expect(ddoMapOf(entry).length).toBeGreaterThan(0);
			expectColumn(answer, entry, TEST3_COLUMN, HOST_SECTION);
			expectColumn(answer, entry, SECOND_COLUMN, SECOND_SECTION);
			const sqoSections = dedaloItem(entry).sqo?.section_tipo ?? [];
			// rule #4 (relations skill): ENRICHED ddos, the client's target_section shape
			for (const section of sqoSections) {
				expect(section).toMatchObject({ typo: 'ddo', model: 'section' });
				expect(typeof section.matrix_table).toBe('string');
			}
			expectNoSectionContexts(answer);
		});
	}

	test('section EDIT read of test3/MAIN_HOST: the column entry carries the map and the cell context exists', async () => {
		const answer = await sectionEdit(MAIN_HOST_ID);
		const entry = indexEntry(answer, 'edit');
		expect(ddoMapOf(entry).length).toBeGreaterThan(0);
		expectColumn(answer, entry, TEST3_COLUMN, HOST_SECTION);
		expectColumn(answer, entry, SECOND_COLUMN, SECOND_SECTION);
	});

	test('offset > 0: the page still carries the FULL pointing-section map (D4)', async () => {
		const first = await getData(MAIN_HOST_ID, 'list', { limit: 1, offset: 0 });
		const later = await getData(MAIN_HOST_ID, 'list', { limit: 1, offset: 2 });
		const firstEntry = indexEntry(first, 'list');
		const laterEntry = indexEntry(later, 'list');
		expect(ddoMapOf(laterEntry).length).toBeGreaterThan(0);
		expect(ddoMapOf(laterEntry)).toEqual(ddoMapOf(firstEntry));
		expect(sqoSectionsOf(laterEntry)).toEqual(sqoSectionsOf(firstEntry));
		// paging itself is untouched: the later page's own item says where it is
		const ownItem = later.data.find((item) => item.tipo === INDEX) as
			| { pagination?: { offset?: number; limit?: number; total?: number } }
			| undefined;
		expect(ownItem?.pagination).toMatchObject({ offset: 2, limit: 1, total: 4 });
	});

	test('two pointing sections: both sections, no duplicate column, ddo order follows the sqo sections', async () => {
		const answer = await getData(MAIN_HOST_ID, 'edit', { limit: 10, offset: 0 });
		const entry = indexEntry(answer, 'edit');
		const ddoMap = ddoMapOf(entry);
		expect(ddoMap.length).toBeGreaterThan(0);
		const sections = sqoSectionsOf(entry);
		expect([...sections].sort()).toEqual([HOST_SECTION, SECOND_SECTION].sort());
		const tipos = ddoMap.map((ddo) => ddo.tipo);
		expect(new Set(tipos).size).toBe(tipos.length);
		expect(new Set(sections).size).toBe(sections.length);
		const ddoSectionOrder = [...new Set(ddoMap.map((ddo) => ddo.section_tipo))];
		expect(ddoSectionOrder).toEqual(sections);
	});

	test('D2: a record pointed at only by test1068 targets test1068 alone — never its own section', async () => {
		const answer = await getData(SOLE_HOST_ID, 'edit', { limit: 10, offset: 0 });
		const entry = indexEntry(answer, 'edit');
		expect(ddoMapOf(entry).length).toBeGreaterThan(0);
		expect(sqoSectionsOf(entry)).toEqual([SECOND_SECTION]);
		expect(ddoMapOf(entry).map((ddo) => ddo.section_tipo)).toEqual([SECOND_SECTION]);
		expectColumn(answer, entry, SECOND_COLUMN, SECOND_SECTION);
	});

	test('per viewer: a column the editor may not read has no ddo AND no data cell (root control sees it)', async () => {
		// Control: root, same record, same pointers — the column IS there.
		const asRoot = await getData(CRAWL_RECORD_IN_A, 'edit', { limit: 10, offset: 0 });
		const rootEntry = indexEntry(asRoot, 'edit');
		expect(ddoMapOf(rootEntry).length).toBeGreaterThan(0);
		expectColumn(asRoot, rootEntry, TEST3_COLUMN, HOST_SECTION);

		await withColumnRevoked(async () => {
			const asEditor = await getData(CRAWL_RECORD_IN_A, 'edit', { limit: 10, offset: 0 }, EDITOR);
			// the editor still reads the index itself and the pointing locators …
			const ownItem = asEditor.data.find((item) => item.tipo === INDEX) as
				| { entries?: unknown[] }
				| undefined;
			expect(ownItem?.entries?.length ?? 0).toBeGreaterThan(0);
			const editorEntry = indexEntry(asEditor, 'edit');
			// … every pointing section still EXISTS in the context (owner rule) …
			expect([...sqoSectionsOf(editorEntry)].sort()).toEqual([HOST_SECTION, SECOND_SECTION].sort());
			// … and the column it holds no grant on has neither ddo, nor context, nor cell.
			expect(ddoMapOf(editorEntry).map((ddo) => ddo.tipo)).not.toContain(TEST3_COLUMN);
			expect(cellEntries(asEditor, TEST3_COLUMN)).toEqual([]);
			expect(cellItems(asEditor, TEST3_COLUMN)).toEqual([]);
			// the paging request the client builds from THIS context is admitted
			await clientPage(editorEntry, CRAWL_RECORD_IN_A, 'edit', 1, EDITOR);
		});
	});

	test("per viewer, section-read door: the revoked column is absent from the editor's edit read (root control)", async () => {
		const asRoot = await sectionEdit(CRAWL_RECORD_IN_A);
		expectColumn(asRoot, indexEntry(asRoot, 'edit'), TEST3_COLUMN, HOST_SECTION);
		await withColumnRevoked(async () => {
			const asEditor = await sectionEdit(CRAWL_RECORD_IN_A, EDITOR);
			// non-vacuity: the editor DOES read the record's index (its item is there)
			expect(asEditor.data.some((item) => item.tipo === INDEX)).toBe(true);
			const editorEntry = indexEntry(asEditor, 'edit');
			expect(ddoMapOf(editorEntry).map((ddo) => ddo.tipo)).not.toContain(TEST3_COLUMN);
			expect([...sqoSectionsOf(editorEntry)].sort()).toEqual([HOST_SECTION, SECOND_SECTION].sort());
			expect(cellEntries(asEditor, TEST3_COLUMN)).toEqual([]);
			expect(cellItems(asEditor, TEST3_COLUMN)).toEqual([]);
		});
	});
});

describe('the merged context is safe to page from (Gate B)', () => {
	test('RULE: whoever reads the index sees ALL its inverse relations — an unreadable caller shows as section_id + section label, no content; page 2 admitted', async () => {
		// Control: root sees BOTH pointing sections of the persona record, with content.
		const asRoot = await getData(CRAWL_RECORD_IN_A, 'list', { limit: 10, offset: 0 });
		const rootEntry = indexEntry(asRoot, 'list');
		expect([...sqoSectionsOf(rootEntry)].sort()).toEqual([HOST_SECTION, SECOND_SECTION].sort());
		expectColumn(asRoot, rootEntry, SECOND_COLUMN, SECOND_SECTION);
		const rootOwn = asRoot.data.find((item) => item.tipo === INDEX) as
			| {
					entries?: { section_tipo: string; section_id: unknown }[];
					pagination?: { total?: number };
			  }
			| undefined;

		const asEditor = await getData(CRAWL_RECORD_IN_A, 'list', { limit: 10, offset: 0 }, EDITOR);
		const editorEntry = indexEntry(asEditor, 'list');
		const editorOwn = asEditor.data.find((item) => item.tipo === INDEX) as
			| {
					entries?: { section_tipo: string; section_id: unknown }[];
					pagination?: { total?: number };
			  }
			| undefined;
		// locators and total are NEVER principal-scoped: the editor's equal root's
		expect(editorOwn?.pagination?.total).toBe(3);
		expect(editorOwn?.pagination?.total).toBe(rootOwn?.pagination?.total as number);
		expect(editorOwn?.entries).toEqual(rootOwn?.entries as never);
		const unreadable = (editorOwn?.entries ?? []).filter(
			(entry) => entry.section_tipo === SECOND_SECTION,
		);
		expect(unreadable.map((entry) => Number(entry.section_id))).toEqual([
			SECOND_POINTER_TO_PERSONA,
		]);

		// EXISTENCE: per unreadable locator the client has its section_id (the
		// entry above) AND its section's NAME — the sqo entry, stated grant 0 …
		const sqoEntries = (dedaloItem(editorEntry).sqo?.section_tipo ?? []) as Record<
			string,
			unknown
		>[];
		const existence = sqoEntries.find((entry) => entry.tipo === SECOND_SECTION);
		expect(existence).toBeDefined();
		expect(existence?.permissions).toBe(0);
		expect(typeof existence?.label).toBe('string');
		expect(String(existence?.label).length).toBeGreaterThan(0);
		// … and NOTHING else of the section: no buttons / color / matrix_table …
		// the client keys the existence cell on this marker, never on the grant
		expect(existence?.existence_only).toBe(true);
		expect(Object.keys(existence ?? {}).sort()).toEqual([
			'existence_only',
			'label',
			'model',
			'permissions',
			'tipo',
			'typo',
		]);
		// … no column ddo, no cell context, no data item of that section at all.
		expect(ddoMapOf(editorEntry).map((ddo) => ddo.section_tipo)).not.toContain(SECOND_SECTION);
		expect(cellEntries(asEditor, SECOND_COLUMN)).toEqual([]);
		expect(asEditor.data.filter((item) => item.section_tipo === SECOND_SECTION)).toEqual([]);
		expect(asEditor.context.filter((entry) => entry.section_tipo === SECOND_SECTION)).toEqual([]);
		// readable rows are unchanged: test3's column and cells are there
		expectColumn(asEditor, editorEntry, TEST3_COLUMN, HOST_SECTION);

		// the page-2 request the client builds from THIS context (it carries the
		// existence-only section) is admitted, in both modes
		for (const mode of ['list', 'edit'] as const) {
			const first = await getData(CRAWL_RECORD_IN_A, mode, { limit: 1, offset: 0 }, EDITOR);
			const entry = indexEntry(first, mode);
			await clientPage(entry, CRAWL_RECORD_IN_A, mode, 1, EDITOR);
			// … and a page that HAS rows (limit 1: edit's own limit of 10 leaves its page 2 empty)
			expectIndexPage(
				await call(clientPageRqo(sqoSectionsOf(entry), CRAWL_RECORD_IN_A, mode, 1, 1), EDITOR),
				1,
			);
		}
	});

	test('the admission is no door: a section that does NOT point at the host stays refused for the editor', async () => {
		// control: the host's own pointing set is admitted (test1068 unreadable, pointing)
		expect(
			await errorCodeOf(
				clientPageRqo([HOST_SECTION, SECOND_SECTION], CRAWL_RECORD_IN_A, 'edit', 10, 10),
				EDITOR,
			),
		).toBeNull();
		// an unreadable section that points at nothing here (the persona's denied section)
		for (const mode of ['list', 'edit'] as const) {
			expect(
				await errorCodeOf(
					clientPageRqo([HOST_SECTION, CRAWL_DENIED_SECTION], CRAWL_RECORD_IN_A, mode, 10, 0),
					EDITOR,
				),
			).toBe('perm.denied');
		}
	});

	/** The admitted page-2 rqo (the host's own pointing set), then one fact changed. */
	const pointingPage = (mode: 'list' | 'edit') =>
		clientPageRqo([HOST_SECTION, SECOND_SECTION], CRAWL_RECORD_IN_A, mode, 10, 0) as {
			action: string;
			source: Record<string, unknown>;
			sqo: Record<string, unknown>;
		};

	test('the carve-out is the config-less INDEX only: a non-index component (outside or inside the map) with the same sqo is refused', async () => {
		for (const mode of ['list', 'edit'] as const) {
			// control: the index itself is admitted
			expect(await errorCodeOf(pointingPage(mode), EDITOR)).toBeNull();
			// test101 (component_filter, a test3 component the editor holds a grant
			// on, OUTSIDE the host map: no chain) — the very case the carve-out
			// branch is reached for; the same pointing sections would be its
			// "targets" if the carve-out ignored the model (mutation-checked)
			const outsideMap = pointingPage(mode);
			outsideMap.source = {
				...outsideMap.source,
				tipo: CRAWL_FILTER_COMPONENT,
				model: 'component_filter',
			};
			expect(await errorCodeOf(outsideMap, EDITOR)).toBe('perm.denied');
			// test52 (component_input_text, IN the map: the chain-verified path)
			const inMap = pointingPage(mode);
			inMap.source = { ...inMap.source, tipo: TEST3_COLUMN, model: 'component_input_text' };
			expect(await errorCodeOf(inMap, EDITOR)).toBe('perm.denied');
		}
	});

	test('the carve-out needs the EXACT host pin: another record or another section in filter_by_locators is refused', async () => {
		for (const mode of ['list', 'edit'] as const) {
			for (const pin of [
				// another record the editor CAN access (project A), same section
				{ section_tipo: HOST_SECTION, section_id: TEST3_POINTERS_TO_PERSONA[0] },
				// the same id under another section
				{ section_tipo: SECOND_SECTION, section_id: CRAWL_RECORD_IN_A },
			]) {
				const rqo = pointingPage(mode);
				rqo.sqo = { ...rqo.sqo, filter_by_locators: [pin] };
				expect(await errorCodeOf(rqo, EDITOR)).toBe('perm.denied');
			}
		}
	});

	test('an index WITH its own request_config takes its targets from that config: no pointing-section carve-out', async () => {
		// test198 (component_relation_index, source.request_config → self) is the
		// test TLD's one configured index; it sits under a diffusion_domain, not
		// in a section, so the door itself refuses it earlier (no host component).
		// The carve-out's own answer for it is pinned here: no pointing targets,
		// even for a record that IS pointed at.
		const { hostPointingSections } = await import(
			'../../src/core/relations/models/relation_index.ts'
		);
		expect(await hostPointingSections(INDEX, HOST_SECTION, CRAWL_RECORD_IN_A)).toEqual(
			expect.arrayContaining([HOST_SECTION, SECOND_SECTION]),
		);
		expect(await hostPointingSections('test198', HOST_SECTION, CRAWL_RECORD_IN_A)).toEqual([]);
	});

	test('the COUNT door decides like the read: the pointing set admitted, a non-pointing section refused', async () => {
		for (const mode of ['list', 'edit'] as const) {
			const admitted = { ...pointingPage(mode), action: 'count' };
			expect(await errorCodeOf(admitted, EDITOR)).toBeNull();
			const refusedRqo = pointingPage(mode);
			refusedRqo.sqo = { ...refusedRqo.sqo, section_tipo: [HOST_SECTION, CRAWL_DENIED_SECTION] };
			expect(await errorCodeOf({ ...refusedRqo, action: 'count' }, EDITOR)).toBe('perm.denied');
			const nonIndex = pointingPage(mode);
			nonIndex.source = { ...nonIndex.source, tipo: TEST3_COLUMN, model: 'component_input_text' };
			expect(await errorCodeOf({ ...nonIndex, action: 'count' }, EDITOR)).toBe('perm.denied');
		}
	});

	for (const as of [ROOT, EDITOR]) {
		test(`a readable pointing section: page 2 built from the returned context is admitted (${as.username})`, async () => {
			for (const mode of ['list', 'edit'] as const) {
				const first = await getData(CRAWL_RECORD_IN_A, mode, { limit: 1, offset: 0 }, as);
				const entry = indexEntry(first, mode);
				expect(sqoSectionsOf(entry)).toContain(HOST_SECTION);
				expectColumn(first, entry, TEST3_COLUMN, HOST_SECTION);
				// admitted (call() fails on any error envelope) as the client builds
				// it — edit's limit is 10, so that page 2 is legitimately empty …
				await clientPage(entry, CRAWL_RECORD_IN_A, mode, 1, as);
				// … and a limit-1 page 2 of the same sections carries the index row
				const page2 = await call(
					clientPageRqo(sqoSectionsOf(entry), CRAWL_RECORD_IN_A, mode, 1, 1),
					as,
				);
				expectIndexPage(page2, 1);
				// the page-2 context still carries the column (D4)
				expectColumn(page2, indexEntry(page2, mode), TEST3_COLUMN, HOST_SECTION);
			}
		});
	}
});

describe('section LIST read: one shared node for every row', () => {
	test('rows with no / different pointing sets merge into ONE column entry carrying the union', async () => {
		// 948301: pointed at by nothing (the FIRST row) · SOLE_HOST: test1068 only · TEST3_ONLY: test3 only
		const hostIds = [TEST3_POINTERS_TO_MAIN[0] as number, SOLE_HOST_ID, TEST3_ONLY_HOST_ID];
		const answer = await sectionListWithIndex(hostIds);
		const entry = indexEntry(answer, 'list'); // exactly ONE merged entry
		expect([...sqoSectionsOf(entry)].sort()).toEqual([HOST_SECTION, SECOND_SECTION].sort());
		expectColumn(answer, entry, TEST3_COLUMN, HOST_SECTION);
		expectColumn(answer, entry, SECOND_COLUMN, SECOND_SECTION);
		// cells per row: SOLE_HOST's only from test1068, TEST3_ONLY's only from test3
		const rowCells = (columnTipo: string, hostId: number) =>
			cellItems(answer, columnTipo).filter((cell) => cell.row_section_id === hostId);
		expect(rowCells(SECOND_COLUMN, SOLE_HOST_ID).length).toBeGreaterThan(0);
		expect(rowCells(TEST3_COLUMN, SOLE_HOST_ID)).toEqual([]);
		expect(rowCells(TEST3_COLUMN, TEST3_ONLY_HOST_ID).length).toBeGreaterThan(0);
		expect(rowCells(SECOND_COLUMN, TEST3_ONLY_HOST_ID)).toEqual([]);
	});
});

describe('translatable related_list columns resolve in the DATA lang (never the nolan slice)', () => {
	type LangCell = Item & { lang?: string; entries?: { value?: unknown; lang?: string }[] };
	/** The ONE test52 related_list cell of the lang pointer, in `answer`. */
	const langCell = (answer: Answer): LangCell => {
		const cells = cellItems(answer, TEST3_COLUMN).filter(
			(cell) => cell.section_tipo === HOST_SECTION && Number(cell.section_id) === LANG_POINTER_ID,
		);
		expect(cells.length).toBe(1);
		return cells[0] as LangCell;
	};
	const expectSpanishValue = (cell: LangCell): void => {
		expect(cell.lang).toBe(SESSION_DATA_LANG);
		expect((cell.entries ?? []).map((entry) => entry.value)).toEqual([LANG_POINTER_VALUE]);
	};

	test('get_data door: the cell carries the lg-spa value (the reference)', async () => {
		expectSpanishValue(langCell(await getData(LANG_HOST_ID, 'edit', { limit: 10, offset: 0 })));
	});
	test('section EDIT read: same lang + value as the get_data cell', async () => {
		const reference = langCell(await getData(LANG_HOST_ID, 'edit', { limit: 10, offset: 0 }));
		const cell = langCell(await sectionEdit(LANG_HOST_ID));
		expectSpanishValue(cell);
		expect({ lang: cell.lang, entries: cell.entries }).toEqual({
			lang: reference.lang,
			entries: reference.entries,
		});
	});
	test('section LIST read: same lang + value as the get_data cell', async () => {
		const reference = langCell(await getData(LANG_HOST_ID, 'list', { limit: 10, offset: 0 }));
		const cell = langCell(await sectionListWithIndex([LANG_HOST_ID]));
		expectSpanishValue(cell);
		expect({ lang: cell.lang, entries: cell.entries }).toEqual({
			lang: reference.lang,
			entries: reference.entries,
		});
	});
});

describe('the empty-show-map log silences ONLY the relation_index placeholder', () => {
	const emptyShow = { sqo: { section_tipo: [] }, show: { ddo_map: [] } };
	const cases: [string, string | null, Record<string, unknown>, boolean][] = [
		[
			'relation_index base placeholder (targets nothing)',
			'component_relation_index',
			emptyShow,
			false,
		],
		// a config-less portal whose target section is unresolved: sqo [] too — a real drop
		['portal targeting nothing', 'component_portal', emptyShow, true],
		['unknown owner model', null, emptyShow, true],
		[
			'relation_index whose map permissions emptied over real targets',
			'component_relation_index',
			{ sqo: { section_tipo: ['test3'] }, show: { ddo_map: [] } },
			true,
		],
	];
	for (const [name, ownerModel, item, logged] of cases) {
		test(`${name}: ${logged ? 'logged' : 'silent'}`, () => {
			const warn = spyOn(console, 'warn').mockImplementation(() => {});
			try {
				flattenConfigDdoMaps([item as never], {
					ownerTipo: INDEX,
					ownerModel,
					logEmptyShowMap: true,
				});
				expect(warn.mock.calls.length).toBe(logged ? 1 : 0);
			} finally {
				warn.mockRestore();
			}
		});
	}
});
