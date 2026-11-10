/**
 * WRITE OBLIGATIONS — the BEHAVIOURAL twin of write_obligations_tripwire
 * (P1-8: DATA-15, DATA-16, DATA-17, DATA-18, DATA-19, DATA-28, DATA-29).
 *
 * The tripwire proves the SHAPE (every writer ends in the one post-write hook);
 * this file proves the EFFECT: every record-write door is driven for real on
 * the suite database and each obligation's observable consequence is asserted
 * — the RAG hook receiving the event, the dd201 stamp moving, the
 * matrix_activity row appearing, the tools cache surviving a rolled-back
 * transaction, the observer counter ticking, the stored component_info value
 * staying off the wire.
 *
 * THE SITUATION IS BUILT (AGENTS.md hard rules): a scratch `zzwob` TLD —
 * one section storing in `matrix_test` (the `test24` matrix_table relation),
 * a text component, a link component onto the same section (the portal-unlink and
 * the holder re-index cases), a widget-less component_info (the DATA-15
 * composition), and an observer edge whose recompute is made to FAIL (the
 * DATA-29 lane) — materialised through the engine's own ontology writer and
 * torn down whole in afterAll. No install TLD is read.
 *
 * Every door runs OUTSIDE a request scope on purpose, so the 'NEW' row's host
 * is PHP's 'unknown' — the engine-level row the audit measured as absent for
 * the duplicate door; the client door's host is the same row with the request
 * scope's IP, and needs no second proof here.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { getCounters, resetCountersForTests } from '../../src/core/api/counters.ts';
import { type ApiRequestContext, dispatchRqo } from '../../src/core/api/dispatch.ts';
import { deleteTldNodes, upsertDdOntologyNode } from '../../src/core/db/dd_ontology.ts';
import { sql, withTransaction } from '../../src/core/db/postgres.ts';
import { clearOntologyDerivedCaches } from '../../src/core/ontology/cache_invalidation.ts';
import { deletePortalLocator } from '../../src/core/relations/save.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import { deleteSectionRecord } from '../../src/core/section/record/delete_record.ts';
import { duplicateSectionRecord } from '../../src/core/section/record/duplicate_record.ts';
import { propagateToObservers } from '../../src/core/section/record/observers.ts';
import { saveComponentData } from '../../src/core/section/record/save_component.ts';
import {
	fireSaveEvent,
	type RagRecordEvent,
	registerRagRecordHook,
} from '../../src/core/section_record/save_event.ts';
import { resolvePrincipal } from '../../src/core/security/permissions.ts';
import { createSession, getSession } from '../../src/core/security/session_store.ts';
import { TOOLS_REGISTER_SECTION_TIPO } from '../../src/core/tools/ontology_map.ts';
import { getRoots } from '../../src/core/tools/paths.ts';
import { DB_READY } from '../helpers/db_ready.ts';
import { registerSessionCleanup } from '../helpers/session_cleanup.ts';
import { cleanScratchTipo } from '../helpers/test_data.ts';

registerSessionCleanup();

// ---------------------------------------------------------------------------
// The situation
// ---------------------------------------------------------------------------
const TLD = 'zzwob';
const SECTION = `${TLD}1`;
const TEXT = `${TLD}2`; // component_input_text, non-translatable
const LINK = `${TLD}3`; // component_autocomplete → SECTION (never onto its own record)
const INFO = `${TLD}4`; // component_info with NO widgets (live compute → null)
/** The observer side: a section whose matrix table does not exist, so its recompute throws. */
const BROKEN_TERM_SECTION = `${TLD}5`;
const BROKEN_TABLE_NODE = `${TLD}6`; // matrix_table node naming a table that is not there
const MIRROR = `${TLD}7`; // component_autocomplete on the broken section, observes LINK
const INDEXER = `${TLD}8`; // component_autocomplete_hi on SECTION, observed by MIRROR
const BUTTON_NEW = `${TLD}9`; // SECTION's button_new — what a create door asks (T0-2)
const TABLE = 'matrix_test';
const ROOT = -1;

/** Every RAG event the seam delivered since the last reset. */
const ragEvents: RagRecordEvent[] = [];
const ragEventsFor = (sectionId: number, kind: RagRecordEvent['kind']): RagRecordEvent[] =>
	ragEvents.filter((event) => event.sectionId === sectionId && event.kind === kind);

async function activityRows(
	sectionId: number,
): Promise<{ what: number; data: Record<string, unknown>; host: string }[]> {
	const rows = (await sql.unsafe(
		`SELECT relation->'dd545'->0->>'section_id' AS what,
		        misc->'dd551'->0->'value' AS data,
		        string->'dd544'->0->>'value' AS host
		 FROM matrix_activity
		 WHERE section_tipo = 'dd542'
		   AND string->'dd546'->0->>'value' = $1
		   AND (misc->'dd551'->0->'value'->>'section_id')::int = $2
		 ORDER BY id`,
		[SECTION, sectionId],
	)) as { what: string; data: Record<string, unknown>; host: string }[];
	return rows.map((row) => ({ what: Number(row.what), data: row.data, host: row.host }));
}

async function column(sectionId: number, name: string): Promise<Record<string, unknown> | null> {
	const rows = (await sql.unsafe(
		`SELECT "${name}" AS value FROM ${TABLE} WHERE section_tipo = $1 AND section_id = $2`,
		[SECTION, sectionId],
	)) as { value: Record<string, unknown> | null }[];
	return rows[0]?.value ?? null;
}

const modifiedDate = async (sectionId: number): Promise<unknown> =>
	(await column(sectionId, 'date'))?.dd201 ?? null;

const linkLocator = (target: number, id = 1): Record<string, unknown> => ({
	id,
	type: 'dd151',
	section_id: target,
	section_tipo: SECTION,
	from_component_tipo: LINK,
});

async function saveLink(sectionId: number, targets: number[]): Promise<void> {
	const value = targets.map((target, index) => linkLocator(target, index + 1));
	const result = await saveComponentData({
		componentTipo: LINK,
		sectionTipo: SECTION,
		sectionId,
		lang: 'lg-nolan',
		changedData: [{ action: 'set_data', key: null, value }],
		userId: ROOT,
	});
	expect(result.ok, result.message).toBe(true);
}

async function sweep(): Promise<void> {
	await cleanScratchTipo(SECTION, TABLE);
	await cleanScratchTipo(BROKEN_TERM_SECTION, TABLE);
	await sql.unsafe(
		`DELETE FROM matrix_activity WHERE section_tipo = 'dd542' AND string->'dd546'->0->>'value' = $1`,
		[SECTION],
	);
	await deleteTldNodes(TLD);
}

let tsContext: ApiRequestContext;

beforeAll(async () => {
	if (!DB_READY) return;
	await sweep();
	await upsertDdOntologyNode({
		tipo: SECTION,
		model: 'section',
		tld: TLD,
		term: { 'lg-eng': 'write obligations scratch section' },
		relations: [{ tipo: 'test24' }],
	});
	// The section's button_new: the MCP create this gate drives asks the
	// New-button predicate (T0-2 / D4, authorizeRecordCreate) — no button_new,
	// no create, the superuser included. Core create (also driven here) is
	// SECTION level (D4 REVISED) and does not ask it.
	await upsertDdOntologyNode({
		tipo: BUTTON_NEW,
		model: 'button_new',
		parent: SECTION,
		tld: TLD,
		term: { 'lg-eng': 'write obligations new' },
	});
	await upsertDdOntologyNode({
		tipo: TEXT,
		model: 'component_input_text',
		parent: SECTION,
		tld: TLD,
		is_translatable: false,
		term: { 'lg-eng': 'text' },
	});
	await upsertDdOntologyNode({
		tipo: LINK,
		model: 'component_autocomplete',
		parent: SECTION,
		tld: TLD,
		term: { 'lg-eng': 'link' },
		properties: {
			config_relation: { relation_type: 'dd151' },
		},
	});
	await upsertDdOntologyNode({
		tipo: INFO,
		model: 'component_info',
		parent: SECTION,
		tld: TLD,
		term: { 'lg-eng': 'info' },
		properties: {},
	});
	// The DATA-29 provocation: an observer whose host section resolves to a
	// matrix table that does not exist. Every SQL of the recompute fails, and
	// the failure lands in propagateToObservers' top-level catch — the
	// interactive lane, post-commit, swallowed by design.
	await upsertDdOntologyNode({
		tipo: BROKEN_TABLE_NODE,
		model: 'matrix_table',
		parent: 'dd627',
		tld: TLD,
		term: { 'lg-spa': 'matrix_zzwob_missing' },
	});
	await upsertDdOntologyNode({
		tipo: BROKEN_TERM_SECTION,
		model: 'section',
		tld: TLD,
		term: { 'lg-eng': 'write obligations broken observer section' },
		relations: [{ tipo: BROKEN_TABLE_NODE }],
	});
	await upsertDdOntologyNode({
		tipo: INDEXER,
		model: 'component_autocomplete_hi',
		parent: SECTION,
		tld: TLD,
		term: { 'lg-eng': 'indexer' },
		properties: {
			config_relation: { relation_type: 'dd96' },
			observers: [{ section_tipo: BROKEN_TERM_SECTION, component_tipo: MIRROR }],
		},
	});
	await upsertDdOntologyNode({
		tipo: MIRROR,
		model: 'component_autocomplete',
		parent: BROKEN_TERM_SECTION,
		tld: TLD,
		term: { 'lg-eng': 'mirror' },
		properties: {
			source: { mode: 'external', section_to_search: [SECTION], component_to_search: [INDEXER] },
			observe: [
				{
					component_tipo: INDEXER,
					server: {
						config: { use_self_section: false, use_observable_dato: true },
						perform: {
							function: 'set_dato_external',
							params: { save: true, changed: false, current_dato: false, references_limit: 0 },
						},
					},
				},
			],
		},
	});
	await clearOntologyDerivedCaches();
	const { getMatrixTableFromTipo } = await import('../../src/core/ontology/resolver.ts');
	expect(await getMatrixTableFromTipo(SECTION)).toBe(TABLE);

	registerRagRecordHook(async (event) => {
		ragEvents.push(event);
	});

	const token = createSession(ROOT, 'root', true);
	const session = getSession(token);
	tsContext = {
		requestId: 'write_obligations_native',
		clientIp: '127.0.0.1',
		session,
		csrfCandidate: session?.csrfToken ?? null,
		principal: await resolvePrincipal(ROOT),
	} as ApiRequestContext;
}, 60000);

afterAll(async () => {
	registerRagRecordHook(null); // never leak the recorder into other suites
	if (!DB_READY) return;
	await sweep();
	await clearOntologyDerivedCaches();
});

// ---------------------------------------------------------------------------
// The doors
// ---------------------------------------------------------------------------

describe.if(DB_READY)(
	'create: RAG index event + the NEW activity row from the ENGINE (DATA-18, DATA-19)',
	() => {
		test('createSectionRecord enqueues the newborn record and writes exactly one NEW row, host unknown', async () => {
			ragEvents.length = 0;
			const id = await createSectionRecord(SECTION, ROOT);
			expect(ragEventsFor(id, 'index')).toHaveLength(1);
			const rows = await activityRows(id);
			expect(rows).toHaveLength(1);
			expect(rows[0]?.what).toBe(3); // dd42/3 = NEW
			expect(rows[0]?.data.msg).toBe('Created section record');
			expect(rows[0]?.data.table).toBe(TABLE);
			expect(rows[0]?.host).toBe('unknown'); // no request scope here
		});

		test('the MCP create door inherits the row (it funnels into the engine)', async () => {
			const { createRecord } = await import('../../src/ai/mcp/tools/records_write.ts');
			const principal = await resolvePrincipal(ROOT);
			const { section_id: id } = await createRecord(principal, { section_tipo: SECTION });
			const rows = await activityRows(id);
			expect(rows.map((row) => row.what)).toEqual([3]);
		});

		test('the tolerated-conflict race loser writes NO row: nothing was created (the enumerated empty cell)', async () => {
			const id = await createSectionRecord(SECTION, ROOT);
			expect(await activityRows(id)).toHaveLength(1);
			// the same address again, conflict tolerated — an explicit-id import's race loser (CSV / import_files)
			const again = await createSectionRecord(SECTION, ROOT, new Date(), id, {
				conflictTolerant: true,
			});
			expect(again).toBe(id);
			expect(await activityRows(id)).toHaveLength(1);
			// while a tolerated-conflict create that DID create still gets its row
			const fresh = id + 1000;
			expect(
				await createSectionRecord(SECTION, ROOT, new Date(), fresh, { conflictTolerant: true }),
			).toBe(fresh);
			expect((await activityRows(fresh)).map((row) => row.what)).toEqual([3]);
		});
	},
);

describe.if(DB_READY)(
	'duplicate: RAG index event + ONE NEW row naming the source (DATA-18, DATA-19)',
	() => {
		test('duplicateSectionRecord enqueues the clone and logs its birth with source_section_id', async () => {
			const source = await createSectionRecord(SECTION, ROOT);
			const saved = await saveComponentData({
				componentTipo: TEXT,
				sectionTipo: SECTION,
				sectionId: source,
				lang: 'lg-nolan',
				changedData: [
					{
						action: 'set_data',
						key: null,
						value: [{ id: 1, lang: 'lg-nolan', value: 'to be cloned' }],
					},
				],
				userId: ROOT,
			});
			expect(saved.ok).toBe(true);
			ragEvents.length = 0;
			const clone = await duplicateSectionRecord(SECTION, source, ROOT);
			expect(clone).not.toBe(source);
			expect(ragEventsFor(clone, 'index')).toHaveLength(1);
			const rows = await activityRows(clone);
			expect(rows).toHaveLength(1);
			expect(rows[0]?.what).toBe(3);
			expect(rows[0]?.data.msg).toBe('Duplicated section record');
			expect(rows[0]?.data.source_section_id).toBe(source);
			// the clone really carries the content (the whole reason it must reach the index)
			expect(((await column(clone, 'string'))?.[TEXT] as { value: string }[])[0]?.value).toBe(
				'to be cloned',
			);
		});
	},
);

describe.if(DB_READY)(
	'save: the chokepoint fires the index event for every branch (DATA-17)',
	() => {
		test('a per-key save (set_data) and an atomic insert both enqueue the record', async () => {
			const id = await createSectionRecord(SECTION, ROOT);
			const target = await createSectionRecord(SECTION, ROOT);
			ragEvents.length = 0;
			await saveLink(id, [target]); // set_data → persistRecordKeys → afterRecordWrite
			expect(ragEventsFor(id, 'index')).toHaveLength(1);
			ragEvents.length = 0;
			const inserted = await saveComponentData({
				componentTipo: TEXT,
				sectionTipo: SECTION,
				sectionId: id,
				lang: 'lg-nolan',
				changedData: [
					{ action: 'insert', key: null, value: { lang: 'lg-nolan', value: 'atomic' } },
				],
				userId: ROOT,
			});
			expect(inserted.ok).toBe(true);
			expect(ragEventsFor(id, 'index')).toHaveLength(1);
		});

		test('a save inside a transaction that ROLLS BACK leaves no event behind the hook (the enqueue joins the tx)', async () => {
			// The hook itself is what is asserted elsewhere; here the discipline: the
			// event is delivered to the hook INSIDE the transaction (so a queue that
			// writes through the ambient handle rolls back with it), never after it.
			const id = await createSectionRecord(SECTION, ROOT);
			const target = await createSectionRecord(SECTION, ROOT);
			ragEvents.length = 0;
			let deliveredInside = 0;
			registerRagRecordHook(async (event) => {
				const { isInTransaction } = await import('../../src/core/db/postgres.ts');
				if (isInTransaction()) deliveredInside += 1;
				ragEvents.push(event);
			});
			try {
				await withTransaction(async () => {
					await saveLink(id, [target]);
					throw new Error('roll it back');
				});
			} catch {
				// expected
			} finally {
				registerRagRecordHook(async (event) => {
					ragEvents.push(event);
				});
			}
			expect(deliveredInside).toBe(1);
			expect((await column(id, 'relation'))?.[LINK]).toBeUndefined(); // rolled back
		});
	},
);

describe.if(DB_READY)(
	'portal unlink: stamps + index from the chokepoint (DATA-16, DATA-17)',
	() => {
		test('deletePortalLocator bumps dd201, writes a TM row, and enqueues the record', async () => {
			const id = await createSectionRecord(SECTION, ROOT);
			const kept = await createSectionRecord(SECTION, ROOT);
			const other = await createSectionRecord(SECTION, ROOT);
			await saveLink(id, [kept, other]);
			// Age the modified stamp so a refresh is observable at second granularity.
			const stale = {
				id: 1,
				start: { day: 1, hour: 0, time: 0, year: 2000, month: 1, minute: 0, second: 0 },
				lang: 'lg-nolan',
			};
			await sql.unsafe(
				`UPDATE ${TABLE} SET date = jsonb_set(COALESCE(date, '{}'::jsonb), '{dd201}', $3::text::jsonb)
			 WHERE section_tipo = $1 AND section_id = $2`,
				[SECTION, id, JSON.stringify([stale])],
			);
			expect(await modifiedDate(id)).toEqual([stale]);
			const tmBefore = (await sql.unsafe(
				`SELECT count(*)::int AS n FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2 AND tipo = $3`,
				[SECTION, id, LINK],
			)) as { n: number }[];
			ragEvents.length = 0;

			const principal = await resolvePrincipal(ROOT);
			const outcome = await deletePortalLocator(
				principal,
				{ tipo: LINK, section_tipo: SECTION, section_id: id },
				// the full stored locator (the client sends what it holds; compare_locators is a property-union strict compare)
				{ locator: linkLocator(other, 2), ar_properties: [] },
			);
			expect(outcome.removed).toBe(1);
			// the survivor is what is stored
			const survivors = (await column(id, 'relation'))?.[LINK] as { section_id: number }[];
			expect(survivors.map((item) => item.section_id)).toEqual([kept]);
			// dd201 moved off the aged stamp (DATA-16) …
			const after = (await modifiedDate(id)) as { start: { year: number } }[];
			expect(after[0]?.start.year).toBeGreaterThan(2000);
			// … the dd197 actor names the unlinking user …
			const modifiedBy = (await column(id, 'relation'))?.dd197 as { section_id: number }[];
			expect(modifiedBy[0]?.section_id).toBe(ROOT);
			// … the TM row is still written …
			const tmAfter = (await sql.unsafe(
				`SELECT count(*)::int AS n FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2 AND tipo = $3`,
				[SECTION, id, LINK],
			)) as { n: number }[];
			expect((tmAfter[0]?.n ?? 0) - (tmBefore[0]?.n ?? 0)).toBe(1);
			// … and the record is enqueued for re-index (DATA-17)
			expect(ragEventsFor(id, 'index')).toHaveLength(1);
		});
	},
);

describe.if(DB_READY)(
	'delete: every rewritten HOLDER is re-indexed, the deleted record gets its delete event (DATA-17)',
	() => {
		test('deleting a target enqueues the holders whose bags the inverse cleanup rewrote', async () => {
			const target = await createSectionRecord(SECTION, ROOT);
			const holderA = await createSectionRecord(SECTION, ROOT);
			const holderB = await createSectionRecord(SECTION, ROOT);
			await saveLink(holderA, [target]);
			await saveLink(holderB, [target, holderA]);
			ragEvents.length = 0;
			await deleteSectionRecord(SECTION, target, ROOT);
			expect(ragEventsFor(target, 'delete')).toHaveLength(1);
			// both holders were rewritten through persistRecordKeys → re-indexed
			expect(ragEventsFor(holderA, 'index').length).toBeGreaterThanOrEqual(1);
			expect(ragEventsFor(holderB, 'index').length).toBeGreaterThanOrEqual(1);
			// and the rewrite really happened (the link to the target is gone, the other survives)
			const bagB = ((await column(holderB, 'relation'))?.[LINK] ?? []) as { section_id: number }[];
			expect(bagB.map((item) => item.section_id)).toEqual([holderA]);
		});
	},
);

describe.if(DB_READY)('cache invalidation is deferred past the transaction (DATA-28)', () => {
	test('a tools-section save event inside a transaction leaves the caches intact until it settles', async () => {
		const roots = getRoots();
		expect(getRoots()).toBe(roots); // memoized, or the probe proves nothing
		let sameInsideTx = false;
		try {
			await withTransaction(async () => {
				await fireSaveEvent(TOOLS_REGISTER_SECTION_TIPO);
				// STILL the same object: the clear did NOT run mid-transaction
				sameInsideTx = getRoots() === roots;
				throw new Error('roll it back');
			});
		} catch {
			// expected
		}
		expect(sameInsideTx).toBe(true);
		// and the deferred clear replayed once the transaction settled (rollback included)
		expect(getRoots()).not.toBe(roots);
	});

	test('outside a transaction the clear runs inline, as before', async () => {
		const roots = getRoots();
		await fireSaveEvent(TOOLS_REGISTER_SECTION_TIPO);
		expect(getRoots()).not.toBe(roots);
	});
});

describe.if(DB_READY)(
	'observer propagation failure on the interactive lane is COUNTED (DATA-29)',
	() => {
		test('a recompute that throws post-commit is swallowed AND ticks observers_propagation_failed', async () => {
			const id = await createSectionRecord(SECTION, ROOT);
			resetCountersForTests();
			// The edge is real (INDEXER → MIRROR on BROKEN_TERM_SECTION); the target
			// section's table does not exist, so the recompute fails. No ambient
			// transaction: the interactive lane.
			const data = await propagateToObservers(
				INDEXER,
				SECTION,
				id,
				{
					saved: [
						{
							id: 1,
							type: 'dd96',
							section_id: 1,
							section_tipo: BROKEN_TERM_SECTION,
							from_component_tipo: INDEXER,
						},
					],
					removed: [],
				},
				ROOT,
			);
			expect(Array.isArray(data)).toBe(true); // swallowed: the save would have succeeded
			expect(getCounters().observers_propagation_failed).toBe(1);
		});

		// B6 (CLOSURE_PLAN Step 2): the in-transaction RETHROW lane is gone with
		// the obligation ledger — every write's propagation drains AFTER the
		// commit (obligation_ledger_native 5a/5b/5c), so propagation inside a
		// transaction is a caller bug and is REFUSED before anything runs: no
		// recompute attempted, nothing counted as a propagation failure.
		test('inside an ambient transaction propagation is REFUSED before it runs (nothing counted)', async () => {
			const id = await createSectionRecord(SECTION, ROOT);
			resetCountersForTests();
			await expect(
				withTransaction(() =>
					propagateToObservers(
						INDEXER,
						SECTION,
						id,
						{
							saved: [
								{
									id: 1,
									type: 'dd96',
									section_id: 1,
									section_tipo: BROKEN_TERM_SECTION,
									from_component_tipo: INDEXER,
								},
							],
							removed: [],
						},
						ROOT,
					),
				),
			).rejects.toThrow(/refusing to run inside a transaction/);
			expect(getCounters().observers_propagation_failed ?? 0).toBe(0);
		});
	},
);

describe.if(DB_READY)('component_info: a stored misc array is never served (DATA-15)', () => {
	test('a modern-shaped array put into misc (what a TM restore does) is ignored, counted, and off the wire', async () => {
		const id = await createSectionRecord(SECTION, ROOT);
		const restored = [{ id: 'x', key: 0, widget: 'state', widget_id: 'x', value: 42 }];
		await sql.unsafe(
			`UPDATE ${TABLE} SET misc = jsonb_build_object($3::text, $4::text::jsonb) WHERE section_tipo = $1 AND section_id = $2`,
			[SECTION, id, INFO, JSON.stringify(restored)],
		);
		resetCountersForTests();
		const response = (
			await dispatchRqo(
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
						mode: 'list',
						lang: 'lg-eng',
					},
					sqo: {
						section_tipo: [SECTION],
						limit: 1,
						offset: 0,
						filter_by_locators: [{ section_tipo: SECTION, section_id: id }],
					},
					show: { ddo_map: [{ tipo: INFO, section_tipo: SECTION, parent: SECTION, mode: 'list' }] },
				} as never,
				tsContext as never,
			)
		).body as { data?: { data?: { tipo?: string; entries?: unknown }[] } };
		const item = (response.data?.data ?? []).find((entry) => entry.tipo === INFO);
		expect(item).toBeDefined();
		// no widgets declared → the live compute has nothing to emit; the stored 42 never appears
		expect(item?.entries ?? []).toEqual([]);
		expect(JSON.stringify(response)).not.toContain('"value":42');
		expect(getCounters().component_info_stored_value_ignored).toBe(1);
		// and the column itself is untouched — nothing is rewritten
		expect((await column(id, 'misc'))?.[INFO]).toEqual(restored);
	});
});
