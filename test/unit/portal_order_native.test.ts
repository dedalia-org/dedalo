/**
 * PORTAL ORDER MODEL (owner ruling 2026-10-31 — WC-2026-10-31-portal-order-model,
 * addendum on WC-048). The STORED locator array is the only real order:
 *
 *  - CHOKEPOINT: a relation key whose component declares a per-ddo `order` is
 *    written SORTED by every door — save (set_data), insert/link (never the
 *    atomic append: `persistAppendedKeyItems` refuses the key), TM restore
 *    (`persistRestoredKeys`), removal (`persistRelationRemovalKeys`), observer
 *    mirror (`persistObserverMirrorKeys`), whole-record restore
 *    (`persistRecordColumns`), birth (`persistRecordBirth`, `prepareBirthColumns`
 *    — create-with-values) and duplicate. `applyKeySaveRules` is identity for
 *    every other key (same reference). A non-declared portal (mutation control)
 *    keeps the order it was given.
 *  - REFUSAL: `sort_data` and `sort_by_column` on a declared-order portal answer
 *    `request.invalid_data`, reason `declared_order`, nothing written.
 *  - READ: a temporary `sqo.view_order` orders the FULL list before paginating,
 *    is honoured on a declared-order portal, refuses a column that is not a
 *    `sort_by_column` column; `paginated_key` is the STORED index under a
 *    read order; a declared-order portal is served AS STORED (no read-time
 *    declared sort — the chokepoint and the reconcile own its order).
 *  - CONTEXT: `declared_order` = `[{tipo, direction}]` on a declared-order
 *    portal, absent otherwise.
 *
 *  - OBSERVER RE-SORT (addendum 2026-10-31 on
 *    WC-2026-08-02-observer-relay-writes-nothing): editing a target's ordering
 *    value re-sorts every host portal holding it — no host save, ONE TM row on
 *    the host — through the edges the registry DERIVES from the declared order
 *    (observer_subscriptions.ts pass 4) and the generalized default branch
 *    (observers.ts resaveObserverThroughSaveRules). Literal column (one hop,
 *    including the "+" flow: a new empty target linked, then filled) and
 *    relation column (two hops: the term leaf → the target's autocomplete → the
 *    host; the intermediate is re-saved through identity rules — no write, no
 *    TM row); a host already in order is not written; a guard at maxDepth
 *    stops the hop loudly; a host revisited under one guard is not re-written.
 *
 *  - BACKFILL: the `portal_declared_order` reconcile at the ontology-change
 *    point — a portal node whose `order` declaration projectOntologyNode or
 *    rebuildOntology ADDS or CHANGES re-sorts its hosts after COMMIT (one TM row),
 *    an unchanged declaration runs nothing, a rolled-back node write re-sorts
 *    nothing; the operator run (dry, then apply) inside a transaction reports
 *    the drift and sorts, a rolled-back run leaves the host unsorted. (The
 *    reconcile's own dry/plant pair is reconcile_registry_native's PLANTER.)
 *
 * Scratch surface: test3 records created at runtime (the generic `test` TLD:
 * `test52` component_input_text is the ordering column) and two scratch portal
 * nodes on a `zz` TLD (orphan parent, torn down after): `zzpdo1` declares
 * `order: asc` + `sort_by_column` on test52, `zzpdo2` only `sort_by_column`.
 * The observer re-sort legs add host-declared portals (a host portal must be DECLARED by
 * its host section — an orphan portal hosts nothing): `zzpdo10` host section,
 * `zzpdo11` (order on test52 over test3) and `zzpdo12` (order on the
 * autocomplete `zzpdo31` of the `zzpdo30` section, whose leaf is the
 * `zzpdo21` text of the `zzpdo20` term section) — all three sections stored
 * in matrix_test (`test24`), every record swept by section.
 * The backfill legs project `zzpdt1` from a real ontology source record
 * (`zzpdt0/1`, matrix_ontology) under the scratch host section `zzpdo40`.
 * Records, TM rows and nodes are swept after.
 */

import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { config } from '../../src/config/config.ts';
import { getCounters } from '../../src/core/api/counters.ts';
import type { Rqo } from '../../src/core/concepts/rqo.ts';
import { sqoSchema } from '../../src/core/concepts/sqo.ts';
import {
	deleteTldNodes,
	readDdOntologyRow,
	upsertDdOntologyNode,
} from '../../src/core/db/dd_ontology.ts';
import { runDetachedFromTransaction, sql, withTransaction } from '../../src/core/db/postgres.ts';
import { DedaloError } from '../../src/core/errors/dedalo_error.ts';
import { mediaJobs } from '../../src/core/media/jobs.ts';
import { getEffectivePropertiesByTipo } from '../../src/core/ontology/alias.ts';
import { clearOntologyDerivedCaches } from '../../src/core/ontology/cache_invalidation.ts';
import {
	rebuildOntology,
	withOrderReconcileBatch,
} from '../../src/core/ontology/ontology_state.ts';
import { deriveOntologyPackages } from '../../src/core/ontology/ontology_update.ts';
import {
	reconcileGauge,
	registerReconcile,
	runReconcile,
} from '../../src/core/reconcile/registry.ts';
import { stopReconcileScheduler } from '../../src/core/reconcile/scheduler.ts';
import {
	DECLARED_ORDER_JOB_KIND,
	declaredOrderReportLines,
	PORTAL_DECLARED_ORDER,
	PORTAL_DECLARED_ORDER_RECONCILE,
	reconcilePortalDeclaredOrder,
} from '../../src/core/relations/declared_order_reconcile.ts';
import * as orderLocators from '../../src/core/relations/order_locators.ts';
import {
	componentDeclaresOrder,
	declaredOrderOf,
	declaredOrderSignature,
	orderLocatorsByViewOrder,
} from '../../src/core/relations/order_locators.ts';
import { buildStructureContext } from '../../src/core/resolve/structure_context.ts';
import { buildOrderPath } from '../../src/core/search/order_path.ts';
import { readComponentData } from '../../src/core/section/read.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import { duplicateSectionRecord } from '../../src/core/section/record/duplicate_record.ts';
import { getObserverSubscriptions } from '../../src/core/section/record/observer_subscriptions.ts';
import {
	type CascadeGuard,
	MAX_CASCADE_DEPTH,
	propagateToObservers,
	recomputeExternalRelation,
	resaveObserverThroughSaveRules,
} from '../../src/core/section/record/observers.ts';
import { saveComponentData } from '../../src/core/section/record/save_component.ts';
import {
	ontologyNodeAddress,
	projectOntologyNode,
} from '../../src/core/section_record/ontology_projection.ts';
import {
	applyKeySaveRules,
	persistAppendedKeyItems,
	persistObserverMirrorKeys,
	persistRecordBirth,
	persistRecordColumns,
	persistRelationRemovalKeys,
	persistRestoredKeys,
	prepareBirthColumns,
} from '../../src/core/section_record/record_write.ts';
import {
	ddoIsAuthorized,
	type Principal,
	resolvePrincipal,
} from '../../src/core/security/permissions.ts';
import { runWithRequestContext } from '../../src/core/security/request_context.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import {
	ACL_DENIED_COMPONENT,
	ACL_GRANTED_COMPONENT,
	ACL_NON_ADMIN_PROFILE_ID,
	ACL_NON_ADMIN_USER_ID,
	clearAclIdentityCaches,
	installAclIdentityFixture,
	removeAclIdentityFixture,
} from '../helpers/acl_identity_fixture.ts';
import { cleanScratchRecord, cleanScratchTipo } from '../helpers/test_data.ts';

const SECTION = 'test3';
const TABLE = 'matrix_test';
const ORDER_COLUMN = 'test52'; // component_input_text under test3
const OTHER_COLUMN = 'test80'; // a test3 component the portals do NOT offer for sorting
const TLD = 'zzpdo';
const DECLARED = `${TLD}1`; // order asc + sort_by_column on test52
const PLAIN = `${TLD}2`; // sort_by_column on test52, no order
const USER_ID = -1;
const ROOT: Principal = { userId: USER_ID, isGlobalAdmin: true, isDeveloper: true };
/** The rank search reads the module-level DATA_LANG (order_locators.ts). */
const DATA_LANG = config.menu.dataLang;

// Observer re-sort — host-declared portals (see the header).
const HOST_SECTION = `${TLD}10`;
const HOSTED = `${TLD}11`; // order asc on test52 over test3
const HOSTED_REL = `${TLD}12`; // order asc on MID_AUTO over MID_SECTION (a relation column)
const TERM_SECTION = `${TLD}20`;
const TERM_TEXT = `${TLD}21`;
const MID_SECTION = `${TLD}30`;
const MID_AUTO = `${TLD}31`; // autocomplete → TERM_SECTION, leaf TERM_TEXT

// One predicate: `order` declared only on a LATER request_config item (config[0] has none).
const LATE_ORDER = `${TLD}3`;
// view_order column grants: offers the ACL fixture's granted AND denied test3 columns.
const GRANTS_PORTAL = `${TLD}4`;
// sort_by_column on FILTER_COLUMN (a test3 component_filter: a TWO-STEP order
// path, the column then the project name dd156@dd153)
const FILTER_SORT_PORTAL = `${TLD}5`;
const FILTER_COLUMN = 'test41';
// Copy-law mirror that declares an order (the mirror recompute converges).
const MIRROR_TERM = `${TLD}50`;
const MIRROR_POINTER = `${TLD}51`;
const MIRROR_TYPE = `${TLD}52`;
const MIRROR = `${TLD}53`;
const MIRROR_SOURCE = `${TLD}54`;
// Order data source: a declared-order portal whose targets come from RECORDS (field_value).
const FIELD_HOST = `${TLD}60`;
const FIELD_TEXT = `${TLD}61`;
const FIELD_PORTAL = `${TLD}62`;

const created: number[] = [];
/** Linked targets, by their test52 value. */
let alpha = 0;
let bravo = 0;
let charlie = 0;

async function newRecord(): Promise<number> {
	const id = await createSectionRecord(SECTION, USER_ID);
	created.push(id);
	return id;
}

const locator = (portal: string, sectionId: number, id: number): Record<string, unknown> => ({
	id,
	type: 'dd151',
	section_id: sectionId,
	section_tipo: SECTION,
	from_component_tipo: portal,
});

/** The stored bag in the given (unsorted) target order: Charlie, Alpha, Bravo. */
const unsorted = (portal: string): Record<string, unknown>[] => [
	locator(portal, charlie, 1),
	locator(portal, alpha, 2),
	locator(portal, bravo, 3),
];

/** A bag as its target ids, in stored order. */
const idsOf = (items: unknown): number[] =>
	(Array.isArray(items) ? items : []).map((item) =>
		Number((item as { section_id?: unknown }).section_id),
	);

async function seedRelation(sectionId: number, tipo: string, items: unknown[]): Promise<void> {
	await assertTestDatabase('portal_order_native seed');
	await sql.unsafe(
		`UPDATE ${TABLE}
		 SET relation = COALESCE(relation, '{}'::jsonb) || jsonb_build_object($2::text, $3::text::jsonb)
		 WHERE section_tipo = $1 AND section_id = $4`,
		[SECTION, tipo, JSON.stringify(items), sectionId],
	);
}

async function seedValue(sectionId: number, value: string): Promise<void> {
	await assertTestDatabase('portal_order_native seed');
	await sql.unsafe(
		`UPDATE ${TABLE}
		 SET string = COALESCE(string, '{}'::jsonb) || jsonb_build_object($2::text, $3::text::jsonb)
		 WHERE section_tipo = $1 AND section_id = $4`,
		[SECTION, ORDER_COLUMN, JSON.stringify([{ id: 1, lang: DATA_LANG, value }]), sectionId],
	);
}

async function stored(sectionId: number, tipo: string): Promise<unknown[]> {
	const rows = (await sql.unsafe(
		`SELECT relation->$3 AS value FROM ${TABLE} WHERE section_tipo = $1 AND section_id = $2`,
		[SECTION, sectionId, tipo],
	)) as { value: unknown[] | null }[];
	return rows[0]?.value ?? [];
}

/** A scratch (orphan) portal node with the given request_config. */
async function upsertScratchPortal(tipo: string, requestConfig: unknown[]): Promise<void> {
	await upsertDdOntologyNode({
		tipo,
		parent: `${TLD}999999`, // orphan: a valid tipo no node carries (SURF-1 grammar)
		model: 'component_portal',
		tld: TLD,
		term: { 'lg-spa': `scratch portal order ${tipo}` },
		is_model: false,
		is_translatable: false,
		is_main: false,
		properties: { source: { request_config: requestConfig } },
	});
}

/** A scratch portal node over test3, offering test52 (with/without a declared order). */
async function upsertPortal(tipo: string, declared: boolean): Promise<void> {
	await upsertScratchPortal(tipo, [
		{
			sqo: { section_tipo: [{ value: [SECTION], source: 'section' }] },
			show: {
				ddo_map: [
					{
						tipo: ORDER_COLUMN,
						parent: 'self',
						section_tipo: 'self',
						sort_by_column: true,
						...(declared ? { order: 'asc' } : {}),
					},
				],
			},
		},
	]);
}

/** The thrown DedaloError of `run`, or null. */
async function thrown(run: () => Promise<unknown>): Promise<DedaloError | null> {
	try {
		await run();
		return null;
	} catch (error) {
		if (error instanceof DedaloError) return error;
		throw error;
	}
}

/** One portal get_data page (readComponentData, the paginator door). */
async function readPage(
	portal: string,
	sectionId: number,
	limit: number,
	offset: number,
	viewOrder?: { tipo: string; direction: string },
): Promise<{ ids: number[]; keys: number[] }> {
	const items = await readComponentData({
		action: 'get_data',
		source: {
			tipo: portal,
			section_tipo: SECTION,
			section_id: sectionId,
			mode: 'edit',
			lang: 'lg-nolan',
		},
		sqo: {
			section_tipo: [SECTION],
			limit,
			offset,
			...(viewOrder === undefined ? {} : { view_order: viewOrder }),
		},
	} as unknown as Rqo);
	// The portal's OWN data item carries its page under `entries` (the DataItem
	// wire key); the other items are the resolved target columns.
	const own = items.find((item) => (item as { tipo?: unknown }).tipo === portal) as unknown as
		| { entries?: unknown[] }
		| undefined;
	const value = own?.entries ?? [];
	return {
		ids: idsOf(value),
		keys: value.map((item) => Number((item as { paginated_key?: unknown }).paginated_key)),
	};
}

beforeAll(async () => {
	await assertTestDatabase('portal_order_native');
	await deleteTldNodes(TLD);
	await upsertPortal(DECLARED, true);
	await upsertPortal(PLAIN, false);
	await upsertScratchPortal(LATE_ORDER, [
		{
			sqo: { section_tipo: [{ value: [SECTION], source: 'section' }] },
			show: {
				ddo_map: [
					{ tipo: ORDER_COLUMN, parent: 'self', section_tipo: 'self', sort_by_column: true },
				],
			},
		},
		{
			sqo: { section_tipo: [{ value: [SECTION], source: 'section' }] },
			show: {
				ddo_map: [{ tipo: ORDER_COLUMN, parent: 'self', section_tipo: 'self', order: 'asc' }],
			},
		},
	]);
	await upsertScratchPortal(FILTER_SORT_PORTAL, [
		{
			sqo: { section_tipo: [{ value: [SECTION], source: 'section' }] },
			show: {
				ddo_map: [
					{ tipo: FILTER_COLUMN, parent: 'self', section_tipo: 'self', sort_by_column: true },
				],
			},
		},
	]);
	await upsertScratchPortal(GRANTS_PORTAL, [
		{
			sqo: { section_tipo: [{ value: [SECTION], source: 'section' }] },
			show: {
				ddo_map: [ACL_GRANTED_COMPONENT, ACL_DENIED_COMPONENT].map((tipo) => ({
					tipo,
					parent: 'self',
					section_tipo: 'self',
					sort_by_column: true,
				})),
			},
		},
	]);
	await clearOntologyDerivedCaches();
	// Created AGAINST their value order (ids: bravo < charlie < alpha), so a
	// stored array in VALUE order is never also in section_id order, either
	// direction, nor the unsorted() input: a door (or a ranker) that fell back to
	// id order instead of the declared column would red every leg below.
	bravo = await newRecord();
	charlie = await newRecord();
	alpha = await newRecord();
	await seedValue(alpha, 'Alpha');
	await seedValue(bravo, 'Bravo');
	await seedValue(charlie, 'Charlie');
}, 30000);

afterAll(async () => {
	for (const sectionTipo of [
		HOST_SECTION,
		TERM_SECTION,
		MID_SECTION,
		MIRROR_TERM,
		MIRROR_TYPE,
		FIELD_HOST,
	]) {
		await cleanScratchTipo(sectionTipo, TABLE);
	}
	await deleteTldNodes(TLD);
	await clearOntologyDerivedCaches();
	for (const id of created) await cleanScratchRecord(SECTION, id, TABLE);
	const rows = (await sql.unsafe(
		`SELECT count(*)::int AS n FROM ${TABLE} WHERE section_tipo = $1 AND section_id = ANY(string_to_array($2, ',')::int[])`,
		[SECTION, created.join(',')],
	)) as { n: number }[];
	expect(rows[0]?.n).toBe(0);
});

describe('chokepoint — every door stores a declared-order key sorted', () => {
	test('save (set_data): stored AND echoed sorted; the plain portal keeps the given order', async () => {
		const host = await newRecord();
		const result = await saveComponentData({
			componentTipo: DECLARED,
			sectionTipo: SECTION,
			sectionId: host,
			lang: 'lg-nolan',
			userId: USER_ID,
			principal: ROOT,
			changedData: [{ action: 'set_data', value: unsorted(DECLARED) }],
		});
		expect(result.ok).toBe(true);
		expect(idsOf(await stored(host, DECLARED))).toEqual([alpha, bravo, charlie]);
		expect(idsOf(result.data)).toEqual([alpha, bravo, charlie]);

		// mutation control: no `order` → the array is stored as given
		const plain = await saveComponentData({
			componentTipo: PLAIN,
			sectionTipo: SECTION,
			sectionId: host,
			lang: 'lg-nolan',
			userId: USER_ID,
			principal: ROOT,
			changedData: [{ action: 'set_data', value: unsorted(PLAIN) }],
		});
		expect(plain.ok).toBe(true);
		expect(idsOf(await stored(host, PLAIN))).toEqual([charlie, alpha, bravo]);
	});

	test('insert (link): lands in order, never appended at the end; plain portal appends', async () => {
		const host = await newRecord();
		await seedRelation(host, DECLARED, [
			locator(DECLARED, alpha, 1),
			locator(DECLARED, charlie, 2),
		]);
		await seedRelation(host, PLAIN, [locator(PLAIN, alpha, 1), locator(PLAIN, charlie, 2)]);
		const insert = (portal: string) =>
			saveComponentData({
				componentTipo: portal,
				sectionTipo: SECTION,
				sectionId: host,
				lang: 'lg-nolan',
				userId: USER_ID,
				principal: ROOT,
				changedData: [
					{
						action: 'insert',
						value: { type: 'dd151', section_tipo: SECTION, section_id: bravo },
					},
				],
			});
		expect((await insert(DECLARED)).ok).toBe(true);
		expect(idsOf(await stored(host, DECLARED))).toEqual([alpha, bravo, charlie]);
		expect((await insert(PLAIN)).ok).toBe(true);
		expect(idsOf(await stored(host, PLAIN))).toEqual([alpha, charlie, bravo]);
	});

	test('the atomic append REFUSES a declared-order key (nothing written)', async () => {
		const host = await newRecord();
		await seedRelation(host, DECLARED, [locator(DECLARED, charlie, 1)]);
		const error = await thrown(() =>
			persistAppendedKeyItems(
				{ table: TABLE, sectionTipo: SECTION, sectionId: host },
				'relation',
				DECLARED,
				[locator(DECLARED, alpha, 2)],
				false,
				{ actor: USER_ID },
			),
		);
		expect(error?.code).toBe('internal.invariant');
		expect(error?.coordinates?.reason).toBe('declared_order');
		expect(idsOf(await stored(host, DECLARED))).toEqual([charlie]);
	});

	test('TM restore / removal / observer mirror key entries all sort', async () => {
		const doors = [persistRestoredKeys, persistRelationRemovalKeys, persistObserverMirrorKeys];
		for (const door of doors) {
			const host = await newRecord();
			await door(
				{ table: TABLE, sectionTipo: SECTION, sectionId: host },
				[{ column: 'relation', key: DECLARED, value: unsorted(DECLARED) }],
				false,
				{ actor: USER_ID },
			);
			expect(idsOf(await stored(host, DECLARED))).toEqual([alpha, bravo, charlie]);
		}
	});

	test('whole-record restore (persistRecordColumns) sorts the restored bag', async () => {
		const host = await newRecord();
		await persistRecordColumns(
			{ table: TABLE, sectionTipo: SECTION, sectionId: host },
			{ relation: { [DECLARED]: unsorted(DECLARED), [PLAIN]: unsorted(PLAIN) } },
			false,
			{ actor: USER_ID },
		);
		expect(idsOf(await stored(host, DECLARED))).toEqual([alpha, bravo, charlie]);
		expect(idsOf(await stored(host, PLAIN))).toEqual([charlie, alpha, bravo]);
	});

	test('birth: persistRecordBirth and prepareBirthColumns (create-with-values) sort', async () => {
		const address = await newRecord();
		await cleanScratchRecord(SECTION, address, TABLE); // free the address for the birth
		const born = await persistRecordBirth(
			{ table: TABLE, sectionTipo: SECTION, sectionId: address },
			{ relation: { [DECLARED]: unsorted(DECLARED) } },
			false,
			{ actor: USER_ID },
		);
		expect(born).not.toBeNull();
		expect(idsOf(await stored(address, DECLARED))).toEqual([alpha, bravo, charlie]);

		// prepareBirthColumns WITHOUT a section (create_record / duplicate call
		// shape): the host section falls back to the component's ancestor.
		const values = { relation: { [DECLARED]: unsorted(DECLARED), [PLAIN]: unsorted(PLAIN) } };
		const given = values.relation;
		await prepareBirthColumns(values as never);
		const bag = values.relation as Record<string, unknown>;
		expect(idsOf(bag[DECLARED])).toEqual([alpha, bravo, charlie]);
		expect(idsOf(bag[PLAIN])).toEqual([charlie, alpha, bravo]);
		// the caller's bag object is not mutated through the rule
		expect(idsOf(given[DECLARED])).toEqual([charlie, alpha, bravo]);
	});

	test('duplicate: the clone is born sorted, the source is untouched', async () => {
		const source = await newRecord();
		await seedRelation(source, DECLARED, unsorted(DECLARED));
		const clone = await duplicateSectionRecord(SECTION, source, USER_ID);
		created.push(clone);
		expect(idsOf(await stored(clone, DECLARED))).toEqual([alpha, bravo, charlie]);
		expect(idsOf(await stored(source, DECLARED))).toEqual([charlie, alpha, bravo]);
	});

	test('applyKeySaveRules is identity (same reference) for every other key', async () => {
		const target = { table: TABLE, sectionTipo: SECTION, sectionId: 0 };
		const plain = unsorted(PLAIN);
		expect(await applyKeySaveRules(target, PLAIN, plain)).toBe(plain);
		const single = [locator(DECLARED, charlie, 1)];
		expect(await applyKeySaveRules(target, DECLARED, single)).toBe(single);
		expect(await applyKeySaveRules(target, DECLARED, null)).toBeNull();
		expect(idsOf(await applyKeySaveRules(target, DECLARED, unsorted(DECLARED)))).toEqual([
			alpha,
			bravo,
			charlie,
		]);
	});

	test('a legacy NULL item in a declared-order array is sorted past, never a TypeError (the chokepoint runs on every door)', async () => {
		const target = { table: TABLE, sectionTipo: SECTION, sectionId: 0 };
		const ruled = (await applyKeySaveRules(target, DECLARED, [
			locator(DECLARED, charlie, 1),
			null,
			locator(DECLARED, alpha, 2),
		])) as unknown[];
		// unresolved items rank LAST (stable): the null keeps its place among them
		expect(ruled).toHaveLength(3);
		expect(ruled[2]).toBeNull();
		expect(idsOf(ruled.slice(0, 2))).toEqual([alpha, charlie]);
	});
});

describe('refusal — sort_data / sort_by_column on a declared-order portal', () => {
	test('both refused request.invalid_data, reason declared_order, nothing written', async () => {
		const host = await newRecord();
		await seedRelation(host, DECLARED, unsorted(DECLARED));
		const save = (change: Record<string, unknown>) =>
			saveComponentData({
				componentTipo: DECLARED,
				sectionTipo: SECTION,
				sectionId: host,
				lang: 'lg-nolan',
				userId: USER_ID,
				principal: ROOT,
				changedData: [change as never],
			});
		const sortData = await thrown(() =>
			save({ action: 'sort_data', source_key: 0, target_key: 2, value: unsorted(DECLARED)[0] }),
		);
		expect(sortData?.code).toBe('request.invalid_data');
		expect(sortData?.coordinates?.reason).toBe('declared_order');
		const byColumn = await thrown(() =>
			save({ action: 'sort_by_column', component_tipo: ORDER_COLUMN, direction: 'DESC' }),
		);
		expect(byColumn?.code).toBe('request.invalid_data');
		expect(byColumn?.coordinates?.reason).toBe('declared_order');
		expect(idsOf(await stored(host, DECLARED))).toEqual([charlie, alpha, bravo]);
	});

	test('ONE predicate: an `order` only on a later request_config item is no declared order anywhere — no refusal, no context key, no sort', async () => {
		// the raw scan sees it; the resolved edit config (config[0]) does not
		expect(await componentDeclaresOrder(LATE_ORDER, SECTION)).toBe(false);
		expect(await declaredOrderOf(LATE_ORDER, SECTION)).toBeNull();
		const host = await newRecord();
		await seedRelation(host, LATE_ORDER, unsorted(LATE_ORDER));
		const result = await saveComponentData({
			componentTipo: LATE_ORDER,
			sectionTipo: SECTION,
			sectionId: host,
			lang: 'lg-nolan',
			userId: USER_ID,
			principal: ROOT,
			changedData: [
				{ action: 'sort_by_column', component_tipo: ORDER_COLUMN, direction: 'DESC' } as never,
			],
		});
		expect(result.ok).toBe(true);
		expect(idsOf(await stored(host, LATE_ORDER))).toEqual([charlie, bravo, alpha]);
	});

	test('control: sort_by_column on the plain portal still persists', async () => {
		const host = await newRecord();
		await seedRelation(host, PLAIN, unsorted(PLAIN));
		const result = await saveComponentData({
			componentTipo: PLAIN,
			sectionTipo: SECTION,
			sectionId: host,
			lang: 'lg-nolan',
			userId: USER_ID,
			principal: ROOT,
			changedData: [
				{ action: 'sort_by_column', component_tipo: ORDER_COLUMN, direction: 'DESC' } as never,
			],
		});
		expect(result.ok).toBe(true);
		expect(idsOf(await stored(host, PLAIN))).toEqual([charlie, bravo, alpha]);
	});
});

describe('read — view_order, stored-index paginated_key, declared order served as stored', () => {
	test('view_order orders the FULL list before paginating; paginated_key = stored index', async () => {
		const host = await newRecord();
		await seedRelation(host, PLAIN, unsorted(PLAIN)); // stored: C(0) A(1) B(2)
		const asc = { tipo: ORDER_COLUMN, direction: 'ASC' };
		expect(await readPage(PLAIN, host, 2, 0, asc)).toEqual({
			ids: [alpha, bravo],
			keys: [1, 2],
		});
		expect(await readPage(PLAIN, host, 2, 2, asc)).toEqual({ ids: [charlie], keys: [0] });
		// no view order, no declared order: stored order, keys = position
		expect(await readPage(PLAIN, host, 3, 0)).toEqual({
			ids: [charlie, alpha, bravo],
			keys: [0, 1, 2],
		});
	});

	test('view_order is honoured on a declared-order portal', async () => {
		const host = await newRecord();
		await seedRelation(host, DECLARED, unsorted(DECLARED)); // stored: C(0) A(1) B(2)
		expect(await readPage(DECLARED, host, 3, 0, { tipo: ORDER_COLUMN, direction: 'DESC' })).toEqual(
			{ ids: [charlie, bravo, alpha], keys: [0, 2, 1] },
		);
	});

	test('view_order on a column the portal does not offer is refused (reason view_order)', async () => {
		const host = await newRecord();
		await seedRelation(host, PLAIN, unsorted(PLAIN));
		const error = await thrown(() =>
			readPage(PLAIN, host, 3, 0, { tipo: OTHER_COLUMN, direction: 'ASC' }),
		);
		expect(error?.code).toBe('request.invalid_data');
		expect(error?.coordinates?.reason).toBe('view_order');
	});

	test('a non-offered view_order is refused whatever the record holds (0 and 1 locators too)', async () => {
		const empty = await newRecord();
		const single = await newRecord();
		await seedRelation(single, PLAIN, [locator(PLAIN, alpha, 1)]);
		for (const host of [empty, single]) {
			const error = await thrown(() =>
				readPage(PLAIN, host, 3, 0, { tipo: OTHER_COLUMN, direction: 'ASC' }),
			);
			expect(error?.code, `host with ${host === empty ? 0 : 1} locator(s)`).toBe(
				'request.invalid_data',
			);
			expect(error?.coordinates?.reason).toBe('view_order');
		}
		// control: an offered column on the same records answers
		expect(
			(await readPage(PLAIN, single, 3, 0, { tipo: ORDER_COLUMN, direction: 'ASC' })).ids,
		).toEqual([alpha]);
	});

	test('the wire shape of sqo.view_order is validated (direction, extra keys)', () => {
		const base = { section_tipo: [SECTION] };
		expect(
			sqoSchema.safeParse({ ...base, view_order: { tipo: ORDER_COLUMN, direction: 'DESC' } })
				.success,
		).toBe(true);
		// absent or null = no view order
		expect(sqoSchema.safeParse({ ...base, view_order: null }).success).toBe(true);
		expect(sqoSchema.safeParse(base).success).toBe(true);
		// ONE spelling on the wire (the sqo.order / context.declared_order one): lowercase,
		// a null or unknown direction and an extra key are refused
		for (const direction of ['desc', 'asc', 'up', null]) {
			expect(
				sqoSchema.safeParse({ ...base, view_order: { tipo: ORDER_COLUMN, direction } }).success,
			).toBe(false);
		}
		expect(
			sqoSchema.safeParse({
				...base,
				view_order: { tipo: ORDER_COLUMN, direction: 'ASC', persist: true },
			}).success,
		).toBe(false);
	});

	test('a declared-order portal is served AS STORED: no read-time declared sort', async () => {
		const host = await newRecord();
		// planted raw (seedRelation bypasses the chokepoint): stored C(0) A(1) B(2)
		await seedRelation(host, DECLARED, unsorted(DECLARED));
		expect(await readPage(DECLARED, host, 3, 0)).toEqual({
			ids: [charlie, alpha, bravo],
			keys: [0, 1, 2],
		});
		expect(await readPage(DECLARED, host, 2, 1)).toEqual({ ids: [alpha, bravo], keys: [1, 2] });
	});
});

describe('view_order — the ranking column must be READABLE by the request principal', () => {
	beforeAll(installAclIdentityFixture, 30000);
	afterAll(removeAclIdentityFixture);

	test('a level-0 column is refused (reason view_order); a level-1 column ranks; no principal = internal, unfiltered', async () => {
		const principal = await resolvePrincipal(ACL_NON_ADMIN_USER_ID);
		const items = unsorted(GRANTS_PORTAL);
		const properties = await getEffectivePropertiesByTipo(GRANTS_PORTAL);
		const rank = (column: string) =>
			orderLocatorsByViewOrder(
				items,
				{ tipo: column, direction: 'ASC' },
				properties,
				GRANTS_PORTAL,
				SECTION,
			);
		const as = <T>(fn: () => Promise<T>): Promise<T> =>
			runWithRequestContext(
				{ principal, session: null, requestId: 'portal_order_native', clientIp: '127.0.0.1' },
				fn,
			);
		const denied = await as(() => thrown(() => rank(ACL_DENIED_COMPONENT)));
		expect(denied?.code).toBe('request.invalid_data');
		expect(denied?.coordinates?.reason).toBe('view_order');
		expect(await as(() => thrown(() => rank(ACL_GRANTED_COMPONENT)))).toBeNull();
		// outside a request scope (an internal resolution) no filter applies
		expect(await thrown(() => rank(ACL_DENIED_COMPONENT))).toBeNull();
	});

	test('a RELATION column: EVERY hop of its order path must be readable — column readable but leaf (dd156@dd153) not → refused; leaf granted → ranks', async () => {
		/** Add one read grant to the reader profile's dd774 matrix (swept with the fixture). */
		const grantReader = async (tipo: string, sectionTipo: string): Promise<void> => {
			await assertTestDatabase('portal_order_native grant');
			await sql.unsafe(
				`UPDATE matrix_profiles
				 SET misc = jsonb_set(misc, '{dd774}', (misc->'dd774') || $1::text::jsonb)
				 WHERE section_tipo = 'dd234' AND section_id = $2`,
				[
					JSON.stringify([{ id: 100 + tipo.length, tipo, section_tipo: sectionTipo, value: 1 }]),
					ACL_NON_ADMIN_PROFILE_ID,
				],
			);
			clearAclIdentityCaches();
		};
		const items = unsorted(FILTER_SORT_PORTAL);
		const properties = await getEffectivePropertiesByTipo(FILTER_SORT_PORTAL);
		const rankAs = async (): Promise<DedaloError | null> => {
			const principal = await resolvePrincipal(ACL_NON_ADMIN_USER_ID);
			return runWithRequestContext(
				{ principal, session: null, requestId: 'portal_order_native', clientIp: '127.0.0.1' },
				() =>
					thrown(() =>
						orderLocatorsByViewOrder(
							items,
							{ tipo: FILTER_COLUMN, direction: 'ASC' },
							properties,
							FILTER_SORT_PORTAL,
							SECTION,
						),
					),
			);
		};
		// FLOOR: the column ranks on a TWO-step path whose leaf lives in another section
		expect(
			(await buildOrderPath(FILTER_COLUMN, SECTION)).map(
				(step) => `${step.component_tipo}@${step.section_tipo}`,
			),
		).toEqual([`${FILTER_COLUMN}@${SECTION}`, 'dd156@dd153']);
		// root unreadable → refused (the pre-existing column check)
		expect((await rankAs())?.coordinates?.reason).toBe('view_order');
		// the column readable, its leaf NOT: still refused — a column-only gate
		// would rank system-scoped on dd156 here (an ordering oracle)
		await grantReader(FILTER_COLUMN, SECTION);
		const principal = await resolvePrincipal(ACL_NON_ADMIN_USER_ID);
		expect(await ddoIsAuthorized(principal, SECTION, FILTER_COLUMN)).toBe(true);
		expect(await ddoIsAuthorized(principal, 'dd153', 'dd156')).toBe(false);
		const denied = await rankAs();
		expect(denied?.code).toBe('request.invalid_data');
		expect(denied?.coordinates?.reason).toBe('view_order');
		// control: the leaf granted too → the same request ranks
		await grantReader('dd156', 'dd153');
		expect(await rankAs()).toBeNull();
	});
});

describe('context — declared_order', () => {
	const contextOf = (tipo: string) =>
		buildStructureContext({
			configFrom: { source: 'own', reason: 'unit-test' },
			tipo,
			sectionTipo: SECTION,
			mode: 'edit',
			lang: 'lg-nolan',
			permissions: 2,
		});

	test('a declared-order portal emits [{tipo, direction}]; a plain one emits nothing', async () => {
		const declared = await contextOf(DECLARED);
		expect(declared?.declared_order).toEqual([{ tipo: ORDER_COLUMN, direction: 'ASC' }]);
		const plain = await contextOf(PLAIN);
		expect(plain).not.toBeNull();
		expect(plain && 'declared_order' in plain).toBe(false);
	});
});

describe('alias — the declared order is asked by the DATA tipo: context, refusal, chokepoint and reconcile agree', () => {
	// component_alias nodes (WC-020) over the two scratch portals, each with its OWN
	// `source` override: ALIAS_OWN declares an order its target (PLAIN) does not;
	// ALIAS_BARE drops the order its target (DECLARED) declares.
	const ALIAS_OWN = `${TLD}6`;
	const ALIAS_BARE = `${TLD}7`;
	const aliasNode = (tipo: string, target: string, declared: boolean) =>
		upsertDdOntologyNode({
			tipo,
			parent: `${TLD}999999`,
			model: 'component_alias',
			tld: TLD,
			term: { 'lg-spa': `scratch alias ${tipo}` },
			is_model: false,
			is_translatable: false,
			is_main: false,
			properties: {
				alias_of: target,
				source: {
					request_config: [
						{
							sqo: { section_tipo: [{ value: [SECTION], source: 'section' }] },
							show: {
								ddo_map: [
									{
										tipo: ORDER_COLUMN,
										parent: 'self',
										section_tipo: 'self',
										sort_by_column: true,
										...(declared ? { order: 'desc' } : {}),
									},
								],
							},
						},
					],
				},
			},
		});
	const contextOf = (tipo: string) =>
		buildStructureContext({
			configFrom: { source: 'own', reason: 'unit-test' },
			tipo,
			sectionTipo: SECTION,
			mode: 'edit',
			lang: 'lg-nolan',
			permissions: 2,
		});

	beforeAll(async () => {
		await aliasNode(ALIAS_OWN, PLAIN, true);
		await aliasNode(ALIAS_BARE, DECLARED, false);
		await clearOntologyDerivedCaches();
	});
	afterAll(async () => {
		await assertTestDatabase('portal_order_native alias sweep');
		// Bun.sql binds a JS array as 'a,b' text, never an array literal
		await sql.unsafe("DELETE FROM dd_ontology WHERE tipo = ANY(string_to_array($1, ','))", [
			[ALIAS_OWN, ALIAS_BARE].join(','),
		]);
		await clearOntologyDerivedCaches();
	});

	test('an alias answers EXACTLY as its target — its own `order` (or its dropped one) changes nothing', async () => {
		// FLOOR: the alias's own effective properties DO differ from its target's
		const ownProperties = await getEffectivePropertiesByTipo(ALIAS_OWN);
		expect(declaredOrderSignature(ownProperties)).not.toBeNull();
		expect(declaredOrderSignature(await getEffectivePropertiesByTipo(ALIAS_BARE))).toBeNull();

		// predicate + context: the target's answer, never the override's
		expect(await declaredOrderOf(ALIAS_OWN, SECTION)).toBeNull();
		expect(await componentDeclaresOrder(ALIAS_OWN, SECTION)).toBe(false);
		const ownContext = await contextOf(ALIAS_OWN);
		expect(ownContext).not.toBeNull();
		expect(ownContext && 'declared_order' in ownContext).toBe(false);
		expect(await declaredOrderOf(ALIAS_BARE, SECTION)).toEqual([
			{ tipo: ORDER_COLUMN, direction: 'ASC' },
		]);
		expect((await contextOf(ALIAS_BARE))?.declared_order).toEqual([
			{ tipo: ORDER_COLUMN, direction: 'ASC' },
		]);

		// chokepoint: asked through the alias, it sorts as the target does
		expect(await orderLocators.sortByDeclaredOrder(unsorted(PLAIN), ALIAS_OWN, SECTION)).toBeNull();
		expect(
			idsOf(await orderLocators.sortByDeclaredOrder(unsorted(DECLARED), ALIAS_BARE, SECTION)),
		).toEqual([alpha, bravo, charlie]);

		// refusal: a save through the alias is re-keyed to its target — the context
		// that shows ALIAS_BARE as declared-order is the save that refuses its reorder
		const host = await newRecord();
		await seedRelation(host, DECLARED, unsorted(DECLARED));
		const refused = await thrown(() =>
			saveComponentData({
				componentTipo: ALIAS_BARE,
				sectionTipo: SECTION,
				sectionId: host,
				lang: 'lg-nolan',
				userId: USER_ID,
				principal: ROOT,
				changedData: [
					{
						action: 'sort_data',
						source_key: 0,
						target_key: 2,
						value: unsorted(DECLARED)[0],
					} as never,
				],
			}),
		);
		expect(refused?.coordinates?.reason).toBe('declared_order');

		// reconcile: an alias is never scanned (no record holds its key); the one
		// whose own `order` is ignored is NAMED
		const summary = await reconcilePortalDeclaredOrder({ scope: [ALIAS_OWN, ALIAS_BARE] });
		expect(summary.portals).toEqual([]);
		const reasons = new Map(summary.skipped.map((entry) => [entry.tipo, entry.reason]));
		expect(reasons.get(ALIAS_OWN)).toContain(
			`ignored: a declared order is keyed on its data tipo '${PLAIN}'`,
		);
		expect(reasons.get(ALIAS_BARE)).toContain('no record holds an alias key');
	}, 60000);
});

describe('observer re-sort — editing a target re-sorts its hosts, no host save', () => {
	const sectionNode = (tipo: string) =>
		upsertDdOntologyNode({
			tipo,
			parent: 'test1',
			model: 'section',
			tld: TLD,
			term: { 'lg-spa': `scratch order section ${tipo}` },
			relations: [{ tipo: 'test24' }],
			is_model: false,
			is_translatable: false,
			is_main: false,
			properties: {},
		});
	const componentNode = (
		tipo: string,
		parent: string,
		model: string,
		properties: Record<string, unknown>,
		translatable = false,
	) =>
		upsertDdOntologyNode({
			tipo,
			parent,
			model,
			tld: TLD,
			term: { 'lg-spa': `scratch order ${tipo}` },
			is_model: false,
			is_translatable: translatable,
			is_main: false,
			properties,
		});
	const ordering = (targetSection: string, column: string) => ({
		source: {
			request_config: [
				{
					sqo: { section_tipo: [{ value: [targetSection], source: 'section' }] },
					show: {
						ddo_map: [{ tipo: column, parent: 'self', section_tipo: 'self', order: 'asc' }],
					},
				},
			],
		},
	});

	const scratchIn = (sectionTipo: string) => createSectionRecord(sectionTipo, USER_ID);
	const relLocator = (portal: string, sectionTipo: string, sectionId: number, id: number) => ({
		id,
		type: 'dd151',
		section_id: sectionId,
		section_tipo: sectionTipo,
		from_component_tipo: portal,
	});
	const storedAt = async (sectionTipo: string, sectionId: number, tipo: string) => {
		const rows = (await sql.unsafe(
			`SELECT relation->$3 AS value FROM ${TABLE} WHERE section_tipo = $1 AND section_id = $2`,
			[sectionTipo, sectionId, tipo],
		)) as { value: unknown[] | null }[];
		return rows[0]?.value ?? [];
	};
	const tmRows = async (sectionTipo: string, sectionId: number, tipo?: string) => {
		const rows = (await sql.unsafe(
			`SELECT count(*)::int AS c FROM matrix_time_machine
			 WHERE section_tipo = $1 AND section_id = $2${tipo === undefined ? '' : ' AND tipo = $3'}`,
			tipo === undefined ? [sectionTipo, sectionId] : [sectionTipo, sectionId, tipo],
		)) as { c: number }[];
		return rows[0]?.c ?? 0;
	};
	const save = (
		componentTipo: string,
		sectionTipo: string,
		sectionId: number,
		changedData: unknown[],
		lang = 'lg-nolan',
	) =>
		saveComponentData({
			componentTipo,
			sectionTipo,
			sectionId,
			lang,
			userId: USER_ID,
			principal: ROOT,
			changedData: changedData as never,
		});
	const saveText = (componentTipo: string, sectionTipo: string, sectionId: number, value: string) =>
		save(
			componentTipo,
			sectionTipo,
			sectionId,
			[{ action: 'set_data', value: [{ id: 1, lang: DATA_LANG, value }] }],
			DATA_LANG,
		);
	const freshGuard = (depth = 0): CascadeGuard => ({
		depth,
		maxDepth: MAX_CASCADE_DEPTH,
		visited: new Set(),
		recomputed: new Set(),
		resaved: new Set(),
		chain: ['portal_order_native'],
	});

	/** test3 targets of the literal legs, by their test52 value. */
	let mike = 0;
	let november = 0;
	let oscar = 0;
	/** The relation-column fixture. */
	let termDelta = 0;
	let termEcho = 0;
	let midDelta = 0;
	let midEcho = 0;

	beforeAll(async () => {
		await assertTestDatabase('portal_order_native observer re-sort');
		for (const sectionTipo of [HOST_SECTION, TERM_SECTION, MID_SECTION]) {
			await cleanScratchTipo(sectionTipo, TABLE);
		}
		await sectionNode(HOST_SECTION);
		await sectionNode(TERM_SECTION);
		await sectionNode(MID_SECTION);
		await componentNode(TERM_TEXT, TERM_SECTION, 'component_input_text', {}, true);
		await componentNode(MID_AUTO, MID_SECTION, 'component_autocomplete', {
			source: {
				request_config: [
					{
						sqo: { section_tipo: [{ value: [TERM_SECTION], source: 'section' }] },
						show: { ddo_map: [{ tipo: TERM_TEXT, parent: 'self', section_tipo: 'self' }] },
					},
				],
			},
		});
		await componentNode(HOSTED, HOST_SECTION, 'component_portal', ordering(SECTION, ORDER_COLUMN));
		await componentNode(
			HOSTED_REL,
			HOST_SECTION,
			'component_portal',
			ordering(MID_SECTION, MID_AUTO),
		);
		await clearOntologyDerivedCaches();

		mike = await newRecord();
		november = await newRecord();
		oscar = await newRecord();
		await seedValue(mike, 'Mike');
		await seedValue(november, 'November');
		await seedValue(oscar, 'Oscar');

		termDelta = await scratchIn(TERM_SECTION);
		termEcho = await scratchIn(TERM_SECTION);
		expect((await saveText(TERM_TEXT, TERM_SECTION, termDelta, 'Delta')).ok).toBe(true);
		expect((await saveText(TERM_TEXT, TERM_SECTION, termEcho, 'Echo')).ok).toBe(true);
		midDelta = await scratchIn(MID_SECTION);
		midEcho = await scratchIn(MID_SECTION);
		for (const [mid, term] of [
			[midDelta, termDelta],
			[midEcho, termEcho],
		] as const) {
			const linked = await save(MID_AUTO, MID_SECTION, mid, [
				{ action: 'set_data', value: [relLocator(MID_AUTO, TERM_SECTION, term, 1)] },
			]);
			expect(linked.ok).toBe(true);
		}
	}, 60000);

	test('FLOOR: the registry derives the edges the declared orders imply (literal: one; relation: the chain)', async () => {
		const observersOf = async (observed: string) =>
			(await getObserverSubscriptions(observed))
				.filter((sub) => sub.declaration === 'order-derived')
				.map((sub) => sub.observerTipo);
		expect(await observersOf(ORDER_COLUMN)).toContain(HOSTED);
		// the live control of the no-order filter (computeOrderDerivedContext): PLAIN
		// offers the SAME column with sort_by_column and no `order` — it derives nothing
		expect(await observersOf(ORDER_COLUMN)).not.toContain(PLAIN);
		expect(await observersOf(MID_AUTO)).toContain(HOSTED_REL);
		expect(await observersOf(TERM_TEXT)).toEqual([MID_AUTO]);
	});

	test('ORDER DATA SOURCE: a declared-order portal whose targets come from RECORDS gains its edge on the data write — no ontology write', async () => {
		const observersOf = async (observed: string) =>
			(await getObserverSubscriptions(observed))
				.filter((sub) => sub.declaration === 'order-derived')
				.map((sub) => sub.observerTipo);
		await cleanScratchTipo(FIELD_HOST, TABLE);
		await sectionNode(FIELD_HOST);
		await componentNode(FIELD_TEXT, FIELD_HOST, 'component_input_text', {});
		await componentNode(FIELD_PORTAL, FIELD_HOST, 'component_portal', {
			source: {
				request_config: [
					{
						// the targets are the VALUES of FIELD_TEXT on the host's ACTIVE records
						sqo: { section_tipo: [{ source: 'field_value', value: [FIELD_TEXT] }] },
						show: {
							ddo_map: [{ tipo: ORDER_COLUMN, parent: 'self', section_tipo: 'self', order: 'asc' }],
						},
					},
				],
			},
		});
		await clearOntologyDerivedCaches();
		// no active host record names a target yet: no edge (the registry is now CACHED)
		expect(await observersOf(ORDER_COLUMN)).not.toContain(FIELD_PORTAL);
		const record = await scratchIn(FIELD_HOST);
		await assertTestDatabase('portal_order_native field_value seed');
		await sql.unsafe(
			`UPDATE ${TABLE}
			 SET relation = COALESCE(relation, '{}'::jsonb) || jsonb_build_object('hierarchy4', $3::text::jsonb)
			 WHERE section_tipo = $1 AND section_id = $2`,
			[
				FIELD_HOST,
				record,
				JSON.stringify([
					{ type: 'dd151', section_tipo: 'dd64', section_id: 1, from_component_tipo: 'hierarchy4' },
				]),
			],
		);
		// the DATA write that names the target: the registry must follow it
		const named = await save(FIELD_TEXT, FIELD_HOST, record, [
			{ action: 'set_data', value: [{ id: 1, lang: 'lg-nolan', value: SECTION }] },
		]);
		expect(named.ok).toBe(true);
		expect(await observersOf(ORDER_COLUMN)).toContain(FIELD_PORTAL);
	}, 30000);

	test('a COPY-LAW mirror that declares an order CONVERGES: the second recompute writes nothing (no TM row, changed:false)', async () => {
		await cleanScratchTipo(MIRROR_TERM, TABLE);
		await cleanScratchTipo(MIRROR_TYPE, TABLE);
		await sectionNode(MIRROR_TERM);
		await sectionNode(MIRROR_TYPE);
		// the type's own portal: the law's source, a plain portal over test3
		await componentNode(MIRROR_SOURCE, MIRROR_TYPE, 'component_portal', {
			source: {
				request_config: [
					{
						sqo: { section_tipo: [{ value: [SECTION], source: 'section' }] },
						show: { ddo_map: [{ tipo: ORDER_COLUMN, parent: 'self', section_tipo: 'self' }] },
					},
				],
			},
		});
		await componentNode(MIRROR_POINTER, MIRROR_TERM, 'component_portal', {
			source: {
				request_config: [
					{
						sqo: { section_tipo: [{ value: [MIRROR_TYPE], source: 'section' }] },
						show: { ddo_map: [] },
					},
				],
			},
			observers: [{ section_tipo: 'self', component_tipo: MIRROR }],
		});
		// the mirror: a source_overwrite copy (order 'desired' — the law's order is the
		// value) on a portal that ALSO declares `order: asc` on test52
		await componentNode(MIRROR, MIRROR_TERM, 'component_portal', {
			source: {
				mode: 'external',
				source_overwrite: { data_from_field: MIRROR_SOURCE },
				section_to_search: [SECTION],
				component_to_search: [MIRROR_POINTER],
				request_config: [
					{
						sqo: { section_tipo: [{ value: [SECTION], source: 'section' }] },
						show: {
							ddo_map: [{ tipo: ORDER_COLUMN, parent: 'self', section_tipo: 'self', order: 'asc' }],
						},
					},
				],
			},
			observe: [
				{
					component_tipo: MIRROR_POINTER,
					server: {
						config: { use_self_section: true, use_observable_dato: true },
						perform: {
							function: 'set_dato_external',
							params: { save: true, changed: false, current_dato: false, references_limit: 0 },
						},
					},
				},
			],
		});
		await clearOntologyDerivedCaches();
		const type = await scratchIn(MIRROR_TYPE);
		const term = await scratchIn(MIRROR_TERM);
		await assertTestDatabase('portal_order_native mirror seed');
		const seedAt = (sectionTipo: string, id: number, tipo: string, value: unknown[]) =>
			sql.unsafe(
				`UPDATE ${TABLE}
				 SET relation = COALESCE(relation, '{}'::jsonb) || jsonb_build_object($3::text, $4::text::jsonb)
				 WHERE section_tipo = $1 AND section_id = $2`,
				[sectionTipo, id, tipo, JSON.stringify(value)],
			);
		// the law's order: Charlie, Alpha, Bravo — NOT the declared (asc) order
		await seedAt(MIRROR_TYPE, type, MIRROR_SOURCE, [
			relLocator(MIRROR_SOURCE, SECTION, charlie, 1),
			relLocator(MIRROR_SOURCE, SECTION, alpha, 2),
			relLocator(MIRROR_SOURCE, SECTION, bravo, 3),
		]);
		await seedAt(MIRROR_TERM, term, MIRROR_POINTER, [
			relLocator(MIRROR_POINTER, MIRROR_TYPE, type, 1),
		]);

		const first = await recomputeExternalRelation(
			MIRROR,
			MIRROR_TERM,
			term,
			USER_ID,
			new Date(),
			{},
		);
		expect(first.changed).toBe(true);
		expect(idsOf(await storedAt(MIRROR_TERM, term, MIRROR))).toEqual([alpha, bravo, charlie]);
		const tm = await tmRows(MIRROR_TERM, term, MIRROR);
		expect(tm).toBeGreaterThan(0);

		const second = await recomputeExternalRelation(
			MIRROR,
			MIRROR_TERM,
			term,
			USER_ID,
			new Date(),
			{},
		);
		expect(second.changed).toBe(false);
		expect(await tmRows(MIRROR_TERM, term, MIRROR)).toBe(tm);
		// the dry run (the observer_mirrors reconcile's verdict) agrees: no drift
		const dry = await recomputeExternalRelation(MIRROR, MIRROR_TERM, term, USER_ID, new Date(), {
			write: false,
		});
		expect(dry.changed).toBe(false);
		expect(idsOf(await storedAt(MIRROR_TERM, term, MIRROR))).toEqual([alpha, bravo, charlie]);
	}, 60000);

	test('literal column: editing the target value re-sorts the host — ONE TM row, no host save; in order → no write', async () => {
		const host = await scratchIn(HOST_SECTION);
		const linked = await save(HOSTED, HOST_SECTION, host, [
			{
				action: 'set_data',
				value: [
					relLocator(HOSTED, SECTION, oscar, 1),
					relLocator(HOSTED, SECTION, mike, 2),
					relLocator(HOSTED, SECTION, november, 3),
				],
			},
		]);
		expect(linked.ok).toBe(true);
		expect(idsOf(await storedAt(HOST_SECTION, host, HOSTED))).toEqual([mike, november, oscar]);
		const hostTm = await tmRows(HOST_SECTION, host);

		// Mike → Zulu: the host's array must follow, without anyone saving it
		expect((await saveText(ORDER_COLUMN, SECTION, mike, 'Zulu')).ok).toBe(true);
		expect(idsOf(await storedAt(HOST_SECTION, host, HOSTED))).toEqual([november, oscar, mike]);
		expect(await tmRows(HOST_SECTION, host)).toBe(hostTm + 1);
		expect(await tmRows(HOST_SECTION, host, HOSTED)).toBeGreaterThan(0);

		// an edit that keeps the order: the re-save finds it in order → nothing written
		expect((await saveText(ORDER_COLUMN, SECTION, oscar, 'Papa')).ok).toBe(true);
		expect(idsOf(await storedAt(HOST_SECTION, host, HOSTED))).toEqual([november, oscar, mike]);
		expect(await tmRows(HOST_SECTION, host)).toBe(hostTm + 1);
	}, 30000);

	test('the "+" flow: a NEW empty target linked, then filled — the host re-sorts on the fill', async () => {
		const host = await scratchIn(HOST_SECTION);
		expect(
			(
				await save(HOSTED, HOST_SECTION, host, [
					{
						action: 'set_data',
						value: [
							relLocator(HOSTED, SECTION, november, 1),
							relLocator(HOSTED, SECTION, oscar, 2),
						],
					},
				])
			).ok,
		).toBe(true);
		const fresh = await newRecord(); // "+": the new target is born empty…
		expect(
			(
				await save(HOSTED, HOST_SECTION, host, [
					{ action: 'insert', value: { type: 'dd151', section_tipo: SECTION, section_id: fresh } },
				])
			).ok,
		).toBe(true);
		expect(idsOf(await storedAt(HOST_SECTION, host, HOSTED))).toEqual([november, oscar, fresh]);
		const hostTm = await tmRows(HOST_SECTION, host);
		// …and is filled AFTER the link: 'Alpha' ranks first
		expect((await saveText(ORDER_COLUMN, SECTION, fresh, 'Alpha')).ok).toBe(true);
		// the empty target ranked LAST on the link (no value), so the fill moves it: one re-sort
		expect(idsOf(await storedAt(HOST_SECTION, host, HOSTED))).toEqual([fresh, november, oscar]);
		expect(await tmRows(HOST_SECTION, host)).toBe(hostTm + 1);
	}, 30000);

	/** Set a term's TERM_TEXT RAW — no propagation: a leg's own starting state. */
	const rawTermText = async (termId: number, value: string): Promise<void> => {
		await assertTestDatabase('portal_order_native raw term seed');
		await sql.unsafe(
			`UPDATE ${TABLE}
			 SET string = COALESCE(string, '{}'::jsonb) || jsonb_build_object($2::text, $3::text::jsonb)
			 WHERE section_tipo = $1 AND section_id = $4`,
			[TERM_SECTION, TERM_TEXT, JSON.stringify([{ id: 1, lang: DATA_LANG, value }]), termId],
		);
	};

	test('relation column (two hops): editing the term leaf re-sorts the host; the intermediate is not written', async () => {
		// its OWN starting state (never the previous leg's): Delta, Echo
		await rawTermText(termDelta, 'Delta');
		await rawTermText(termEcho, 'Echo');
		const host = await scratchIn(HOST_SECTION);
		expect(
			(
				await save(HOSTED_REL, HOST_SECTION, host, [
					{
						action: 'set_data',
						value: [
							relLocator(HOSTED_REL, MID_SECTION, midEcho, 1),
							relLocator(HOSTED_REL, MID_SECTION, midDelta, 2),
						],
					},
				])
			).ok,
		).toBe(true);
		expect(idsOf(await storedAt(HOST_SECTION, host, HOSTED_REL))).toEqual([midDelta, midEcho]);
		const hostTm = await tmRows(HOST_SECTION, host);
		const midTm = await tmRows(MID_SECTION, midDelta);
		const midBag = JSON.stringify(await storedAt(MID_SECTION, midDelta, MID_AUTO));

		// Delta → Zeta on the TERM: two hops away from the host
		expect((await saveText(TERM_TEXT, TERM_SECTION, termDelta, 'Zeta')).ok).toBe(true);
		expect(idsOf(await storedAt(HOST_SECTION, host, HOSTED_REL))).toEqual([midEcho, midDelta]);
		expect(await tmRows(HOST_SECTION, host)).toBe(hostTm + 1);
		// the intermediate: re-saved through identity rules → no write, no TM row
		expect(await tmRows(MID_SECTION, midDelta)).toBe(midTm);
		expect(JSON.stringify(await storedAt(MID_SECTION, midDelta, MID_AUTO))).toBe(midBag);
	}, 30000);

	test('a guard at maxDepth stops the hop LOUDLY (the host is left as stored); without it the host re-sorts', async () => {
		// its OWN starting state (never the previous leg's): Zeta, Echo
		await rawTermText(termDelta, 'Zeta');
		await rawTermText(termEcho, 'Echo');
		const host = await scratchIn(HOST_SECTION);
		expect(
			(
				await save(HOSTED_REL, HOST_SECTION, host, [
					{
						action: 'set_data',
						value: [
							relLocator(HOSTED_REL, MID_SECTION, midDelta, 1),
							relLocator(HOSTED_REL, MID_SECTION, midEcho, 2),
						],
					},
				])
			).ok,
		).toBe(true);
		// seeded values: Zeta (midDelta), Echo (midEcho) → stored [midEcho, midDelta]
		const before = idsOf(await storedAt(HOST_SECTION, host, HOSTED_REL));
		expect(before).toEqual([midEcho, midDelta]);
		// Echo → Zulu WITHOUT propagation (raw), then drive the term's propagation by hand
		await rawTermText(termEcho, 'Zulu');
		const depthBefore = getCounters().observers_cascade_depth_exceeded ?? 0;
		await propagateToObservers(
			TERM_TEXT,
			TERM_SECTION,
			termEcho,
			{ saved: [], removed: [] },
			USER_ID,
			new Date(),
			freshGuard(MAX_CASCADE_DEPTH),
		);
		expect((getCounters().observers_cascade_depth_exceeded ?? 0) - depthBefore).toBe(1);
		expect(idsOf(await storedAt(HOST_SECTION, host, HOSTED_REL))).toEqual(before);
		// control: the same propagation with budget re-sorts the host
		await propagateToObservers(
			TERM_TEXT,
			TERM_SECTION,
			termEcho,
			{ saved: [], removed: [] },
			USER_ID,
		);
		expect(idsOf(await storedAt(HOST_SECTION, host, HOSTED_REL))).toEqual([midDelta, midEcho]);
	}, 30000);

	test('a host revisited under ONE guard is not re-written (deduped); a non-host target is skipped', async () => {
		const host = await scratchIn(HOST_SECTION);
		await assertTestDatabase('portal_order_native revisit seed');
		await sql.unsafe(
			`UPDATE ${TABLE}
			 SET relation = COALESCE(relation, '{}'::jsonb) || jsonb_build_object($2::text, $3::text::jsonb)
			 WHERE section_tipo = $1 AND section_id = $4`,
			[
				HOST_SECTION,
				HOSTED,
				JSON.stringify([
					relLocator(HOSTED, SECTION, oscar, 1),
					relLocator(HOSTED, SECTION, november, 2),
				]),
				host,
			],
		);
		const hostTm = await tmRows(HOST_SECTION, host, HOSTED);
		const guard = freshGuard();
		const target = { section_tipo: HOST_SECTION, section_id: host };
		expect(await resaveObserverThroughSaveRules(HOSTED, target, USER_ID, new Date(), guard)).toBe(
			'written',
		);
		expect(idsOf(await storedAt(HOST_SECTION, host, HOSTED))).toEqual([november, oscar]);
		// the same host again, same guard: deduped — no read, no second TM row
		expect(await resaveObserverThroughSaveRules(HOSTED, target, USER_ID, new Date(), guard)).toBe(
			'deduped',
		);
		const afterTm = await tmRows(HOST_SECTION, host, HOSTED);
		expect(afterTm).toBeGreaterThan(hostTm);
		// a fresh guard finds it in order: 'unchanged', nothing written
		expect(
			await resaveObserverThroughSaveRules(HOSTED, target, USER_ID, new Date(), freshGuard()),
		).toBe('unchanged');
		expect(await tmRows(HOST_SECTION, host, HOSTED)).toBe(afterTm);
		// test3 does not declare HOSTED: the orphan-host case is skipped unread
		expect(
			await resaveObserverThroughSaveRules(
				HOSTED,
				{ section_tipo: SECTION, section_id: mike },
				USER_ID,
				new Date(),
				freshGuard(),
			),
		).toBe('not_host');
	}, 30000);

	test('a re-save that THROWS is isolated per target: the next host still re-sorts, counted observers_resave_failed, the propagation is not failed', async () => {
		const target = await newRecord();
		await seedValue(target, 'Papa');
		/** A host of HOSTED linking `target` first, then `other` (out of order: Papa > Mike/November). */
		const hostLinking = async (other: number): Promise<number> => {
			const host = await scratchIn(HOST_SECTION);
			await assertTestDatabase('portal_order_native isolated re-save seed');
			await sql.unsafe(
				`UPDATE ${TABLE}
				 SET relation = COALESCE(relation, '{}'::jsonb) || jsonb_build_object($2::text, $3::text::jsonb)
				 WHERE section_tipo = $1 AND section_id = $4`,
				[
					HOST_SECTION,
					HOSTED,
					JSON.stringify([
						relLocator(HOSTED, SECTION, target, 1),
						relLocator(HOSTED, SECTION, other, 2),
					]),
					host,
				],
			);
			return host;
		};
		// scanned FIRST (the inverse lookup orders by section_tipo, section_id)
		const poisoned = await hostLinking(mike);
		const healthy = await hostLinking(november);
		// the poisoned host's ranking throws (a rank search refusing a legacy array)
		const realSort = orderLocators.sortByDeclaredOrder;
		const spy = spyOn(orderLocators, 'sortByDeclaredOrder').mockImplementation(
			async (items, componentTipo, hostSectionTipo) => {
				if (componentTipo === HOSTED && idsOf(items).includes(mike)) {
					throw new DedaloError('request.invalid_tipo', { message: 'planted rank failure' });
				}
				return realSort(items, componentTipo, hostSectionTipo);
			},
		);
		const resaveFailed = getCounters().observers_resave_failed ?? 0;
		const propagationFailed = getCounters().observers_propagation_failed ?? 0;
		try {
			await propagateToObservers(
				ORDER_COLUMN,
				SECTION,
				target,
				{ saved: [], removed: [] },
				USER_ID,
			);
		} finally {
			spy.mockRestore();
		}
		expect((getCounters().observers_resave_failed ?? 0) - resaveFailed).toBe(1);
		expect((getCounters().observers_propagation_failed ?? 0) - propagationFailed).toBe(0);
		// the target AFTER the failing one was still re-sorted; the failing one left as stored
		expect(idsOf(await storedAt(HOST_SECTION, healthy, HOSTED))).toEqual([november, target]);
		expect(idsOf(await storedAt(HOST_SECTION, poisoned, HOSTED))).toEqual([target, mike]);
		// identity-rule observer (MID_AUTO declares no order): no rule → no lock, no read
		expect(
			await resaveObserverThroughSaveRules(
				MID_AUTO,
				{ section_tipo: MID_SECTION, section_id: midDelta },
				USER_ID,
				new Date(),
				freshGuard(),
			),
		).toBe('no_rule');
	}, 30000);
});

describe('backfill — ontology-change trigger, the operator run', () => {
	// A portal node projected from a REAL ontology source record (`zzpdt0/1`
	// → node `zzpdt1`, model component_portal, ontology17 = its source), hosted by
	// the scratch section `zzpdo40` (its parent). The two dd_ontology node-write
	// doors re-project it; the reconcile re-sorts the host's stored array.
	const PORTAL_TLD = 'zzpdt';
	const PORTAL_SECTION = `${PORTAL_TLD}0`;
	const PORTAL = `${PORTAL_TLD}1`;
	// a SECOND scratch portal tld (node `zzpdu1`, same host section): the
	// multi-tld ontology update leg
	const SECOND_PORTAL_TLD = 'zzpdu';
	const TRIGGER_HOST = `${TLD}40`;
	const PORTAL_TYPE = 'component_portal';
	let portalModelTipo = '';

	const loc = (sectionTipo: string, sectionId: number, from: string, type = 'dd151') => ({
		id: 1,
		type,
		section_id: sectionId,
		section_tipo: sectionTipo,
		from_component_tipo: from,
	});
	/** `dd1129` → {section_tipo: 'dd0', section_id: 1129} — the locator a tipo composes from. */
	const locatorOfTipo = (tipo: string, from: string, type = 'dd151') => {
		const match = /^([a-z]+)(\d+)$/.exec(tipo);
		if (match === null) throw new Error(`not a tipo: ${tipo}`);
		return loc(`${match[1]}0`, Number(match[2]), from, type);
	};
	/** The portal's ontology17 value: test3 targets, test52 shown, with/without an order. */
	const portalSource = (order: 'asc' | 'desc' | null) => ({
		request_config: [
			{
				sqo: { section_tipo: [{ value: [SECTION], source: 'section' }] },
				show: {
					ddo_map: [
						{
							tipo: ORDER_COLUMN,
							parent: 'self',
							section_tipo: 'self',
							...(order === null ? {} : { order }),
						},
					],
				},
			},
		],
	});

	async function seedPortalRecord(
		order: 'asc' | 'desc' | null,
		tld: string = PORTAL_TLD,
	): Promise<void> {
		const portalSection = `${tld}0`;
		await assertTestDatabase('portal_order_native backfill ontology seed');
		await sql.unsafe('DELETE FROM matrix_ontology WHERE section_tipo = $1 AND section_id = 1', [
			portalSection,
		]);
		await sql.unsafe(
			`INSERT INTO matrix_ontology (section_id, section_tipo, data, relation, string, misc)
			 VALUES (1, $1, $2::text::jsonb, $3::text::jsonb, $4::text::jsonb, $5::text::jsonb)`,
			[
				portalSection,
				JSON.stringify({ section_id: 1, section_tipo: portalSection }),
				JSON.stringify({
					ontology6: [locatorOfTipo(portalModelTipo, 'ontology6')],
					ontology15: [loc(`${TLD}0`, 40, 'ontology15', 'dd47')],
				}),
				JSON.stringify({
					ontology7: [{ id: 1, lang: 'lg-nolan', value: tld }],
					ontology5: [{ id: 1, lang: 'lg-spa', value: 'scratch declared-order portal' }],
				}),
				JSON.stringify({ ontology17: [{ id: 1, value: portalSource(order) }] }),
			],
		);
		await clearOntologyDerivedCaches();
	}

	/**
	 * The rebuild LANDED: no error, no drift, the one node projected. NOT `ok` — the
	 * scratch tld has no hierarchy registry row, so `mainNode: 'existing'` leaves
	 * `<tld>0` absent and `mainNodeOk:false` makes `ok` false BY FIXTURE
	 * CONSTRUCTION; that fact is pinned here so a real drift still reds.
	 */
	const expectRebuilt = (result: Awaited<ReturnType<typeof rebuildOntology>>): void => {
		expect(result.errors).toEqual([]);
		expect(result.state.drift).toEqual([]);
		expect(result.state.foreignNodes).toBe(0);
		expect(result.state.matrixNodes).toBe(1);
		expect(result.state.storedNodes).toBe(1);
		expect(result.state.mainNodeOk).toBe(false);
		expect(result.applied).toContain('rebuilt 1 node(s)');
	};

	const project = async () => {
		const address = ontologyNodeAddress(PORTAL_SECTION, 1);
		if (address === null) throw new Error('zzpdt0/1 is not an ontology node address');
		return projectOntologyNode(address);
	};
	const hostRecord = async (): Promise<number> => createSectionRecord(TRIGGER_HOST, USER_ID);
	const seedHost = async (host: number, order: number[]) => {
		await assertTestDatabase('portal_order_native backfill host seed');
		await sql.unsafe(
			`UPDATE ${TABLE}
			 SET relation = COALESCE(relation, '{}'::jsonb) || jsonb_build_object($2::text, $3::text::jsonb)
			 WHERE section_tipo = $1 AND section_id = $4`,
			[
				TRIGGER_HOST,
				PORTAL,
				JSON.stringify(order.map((id, at) => ({ ...locator(PORTAL, id, at + 1) }))),
				host,
			],
		);
	};
	const hostIds = async (host: number): Promise<number[]> => {
		const rows = (await sql.unsafe(
			`SELECT relation->$3 AS value FROM ${TABLE} WHERE section_tipo = $1 AND section_id = $2`,
			[TRIGGER_HOST, host, PORTAL],
		)) as { value: unknown[] | null }[];
		return idsOf(rows[0]?.value ?? []);
	};
	const hostTm = async (host: number): Promise<number> => {
		const rows = (await sql.unsafe(
			'SELECT count(*)::int AS c FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2 AND tipo = $3',
			[TRIGGER_HOST, host, PORTAL],
		)) as { c: number }[];
		return rows[0]?.c ?? 0;
	};

	async function sweepPortalTld(): Promise<void> {
		await assertTestDatabase('portal_order_native backfill sweep');
		for (const tld of [PORTAL_TLD, SECOND_PORTAL_TLD]) {
			await sql.unsafe('DELETE FROM matrix_ontology WHERE section_tipo = $1', [`${tld}0`]);
			await deleteTldNodes(tld);
		}
		await cleanScratchTipo(TRIGGER_HOST, TABLE);
		await clearOntologyDerivedCaches();
	}

	beforeAll(async () => {
		await assertTestDatabase('portal_order_native backfill');
		await sweepPortalTld();
		const models = (await sql.unsafe(
			`SELECT tipo FROM dd_ontology WHERE term->>'lg-spa' = $1 AND is_model = true ORDER BY tipo LIMIT 1`,
			[PORTAL_TYPE],
		)) as { tipo: string }[];
		portalModelTipo = models[0]?.tipo ?? '';
		expect(portalModelTipo, 'the suite ontology carries no component_portal model node').not.toBe(
			'',
		);
		await upsertDdOntologyNode({
			tipo: TRIGGER_HOST,
			parent: 'test1',
			model: 'section',
			tld: TLD,
			term: { 'lg-spa': 'scratch order trigger host' },
			relations: [{ tipo: 'test24' }],
			is_model: false,
			is_translatable: false,
			is_main: false,
			properties: {},
		});
		// the portal, projected WITHOUT an order: nothing to re-sort yet
		await seedPortalRecord(null);
		expect((await project()).kind).toBe('projected');
	}, 60000);

	afterAll(sweepPortalTld);

	test('FLOOR: the projected node is a component_portal hosted by the scratch section', async () => {
		const row = await readDdOntologyRow(PORTAL);
		expect(row?.model).toBe(PORTAL_TYPE);
		expect(row?.parent).toBe(TRIGGER_HOST);
		expect(declaredOrderSignature(row?.properties)).toBeNull();
	});

	test('projectOntologyNode: ADDING an order re-sorts the host after COMMIT (one TM row); an unchanged order runs nothing', async () => {
		const host = await hostRecord();
		await seedHost(host, [charlie, alpha, bravo]);
		const tm = await hostTm(host);
		await seedPortalRecord('asc');
		expect((await project()).kind).toBe('projected');
		expect(await hostIds(host)).toEqual([alpha, bravo, charlie]);
		expect(await hostTm(host)).toBe(tm + 1);

		// same declaration re-projected: the trigger queues nothing — the host stays as planted
		await seedHost(host, [bravo, charlie, alpha]);
		expect((await project()).kind).toBe('projected');
		expect(await hostIds(host)).toEqual([bravo, charlie, alpha]);
		expect(await hostTm(host)).toBe(tm + 1);
	}, 60000);

	test('rebuildOntology: CHANGING the order (asc → desc) re-sorts the host after COMMIT; an unchanged rebuild runs nothing', async () => {
		const host = await hostRecord();
		await seedHost(host, [alpha, charlie, bravo]);
		await seedPortalRecord('desc');
		const changed = await rebuildOntology(PORTAL_TLD, USER_ID, { mainNode: 'existing' });
		expectRebuilt(changed);
		expect(await hostIds(host)).toEqual([charlie, bravo, alpha]);

		await seedHost(host, [bravo, alpha, charlie]);
		const unchanged = await rebuildOntology(PORTAL_TLD, USER_ID, { mainNode: 'existing' });
		expectRebuilt(unchanged);
		expect(await hostIds(host)).toEqual([bravo, alpha, charlie]);
	}, 60000);

	test('a rolled-back node write re-sorts nothing (the trigger rides the COMMIT-ONLY lane)', async () => {
		// its OWN starting state (never the previous leg's): the node committed desc
		await seedPortalRecord('desc');
		expectRebuilt(await rebuildOntology(PORTAL_TLD, USER_ID, { mainNode: 'existing' }));
		expect(declaredOrderSignature((await readDdOntologyRow(PORTAL))?.properties)).toContain('DESC');
		const host = await hostRecord();
		// out of order for BOTH directions: any re-sort would move it
		await seedHost(host, [bravo, alpha, charlie]);
		// flip the source to asc, project, roll back
		await seedPortalRecord('asc');
		const sentinel = new Error('planted rollback');
		await expect(
			withTransaction(async () => {
				expect((await project()).kind).toBe('projected');
				throw sentinel;
			}),
		).rejects.toBe(sentinel);
		await clearOntologyDerivedCaches();
		expect(await hostIds(host)).toEqual([bravo, alpha, charlie]);
		expect(declaredOrderSignature((await readDdOntologyRow(PORTAL))?.properties)).toContain('DESC');
	}, 60000);

	test('the operator run (dry, then apply) in a transaction: reports the drift, sorts; a rolled-back run leaves it unsorted', async () => {
		// its OWN starting state: the node committed asc; its trigger runs now…
		await seedPortalRecord('asc');
		const rebuilt = await rebuildOntology(PORTAL_TLD, USER_ID, { mainNode: 'existing' });
		expectRebuilt(rebuilt);
		// …so the drift the run must find is planted AFTER it
		const host = await hostRecord();
		await seedHost(host, [bravo, charlie, alpha]);
		const run = async (): Promise<{ failed: number; lines: string }> => {
			const dry = await reconcilePortalDeclaredOrder({ scope: [PORTAL] });
			const applied = await reconcilePortalDeclaredOrder({ apply: true, scope: [PORTAL] });
			return {
				failed: applied.failed,
				lines: [...declaredOrderReportLines(dry), ...declaredOrderReportLines(applied)].join('\n'),
			};
		};

		const sentinel = new Error('planted run rollback');
		await expect(
			withTransaction(async () => {
				const out = await run();
				expect(out.failed, out.lines).toBe(0);
				expect(out.lines).toContain(`portal_declared_order (dry)`);
				expect(out.lines).toMatch(
					new RegExp(`${PORTAL}: \\d+ holder\\(s\\), [1-9]\\d* out of order`),
				);
				expect(await hostIds(host)).toEqual([alpha, bravo, charlie]);
				throw sentinel;
			}),
		).rejects.toBe(sentinel);
		expect(await hostIds(host)).toEqual([bravo, charlie, alpha]);

		const committed = await withTransaction(run);
		expect(committed.failed, committed.lines).toBe(0);
		expect(await hostIds(host)).toEqual([alpha, bravo, charlie]);
	}, 120000);

	test('a record whose save THROWS is isolated: counted and listed, and the sweep goes on to the next holder', async () => {
		await seedPortalRecord('asc');
		expectRebuilt(await rebuildOntology(PORTAL_TLD, USER_ID, { mainNode: 'existing' }));
		// scanned FIRST (lower section_id): a legacy array with a NULL item — the save
		// door's value-shape law throws on it (request.invalid_data)
		const poisoned = await hostRecord();
		await assertTestDatabase('portal_order_native poisoned host seed');
		await sql.unsafe(
			`UPDATE ${TABLE}
			 SET relation = COALESCE(relation, '{}'::jsonb) || jsonb_build_object($2::text, $3::text::jsonb)
			 WHERE section_tipo = $1 AND section_id = $4`,
			[
				TRIGGER_HOST,
				PORTAL,
				JSON.stringify([locator(PORTAL, charlie, 1), null, locator(PORTAL, alpha, 2)]),
				poisoned,
			],
		);
		const healthy = await hostRecord();
		await seedHost(healthy, [charlie, bravo, alpha]);

		try {
			const dry = await reconcilePortalDeclaredOrder({ scope: [PORTAL] });
			expect(dry.failed, declaredOrderReportLines(dry).join('\n')).toBe(0);
			const applied = await reconcilePortalDeclaredOrder({ apply: true, scope: [PORTAL] });
			const lines = declaredOrderReportLines(applied).join('\n');
			expect(applied.failed, lines).toBe(1);
			const report = applied.portals.find((portal) => portal.tipo === PORTAL);
			expect(report?.failedCount).toBe(1);
			expect(report?.failed.map((entry) => entry.section_id)).toEqual([poisoned]);
			// the CODE only — the raw exception text is logged, never put in the report payload
			expect(report?.failed[0]?.error).toBe('request.invalid_data');
			expect(lines).toContain(`failed ${TRIGGER_HOST}/${poisoned}`);
			// the holder AFTER it was still re-sorted
			expect(await hostIds(healthy)).toEqual([alpha, bravo, charlie]);
			// the poisoned one is left as stored (its save rolled back alone)
			const kept = (await sql.unsafe(
				`SELECT relation->$3 AS value FROM ${TABLE} WHERE section_tipo = $1 AND section_id = $2`,
				[TRIGGER_HOST, poisoned, PORTAL],
			)) as { value: unknown[] }[];
			expect(
				(kept[0]?.value ?? []).map((item) =>
					item === null ? null : (item as { section_id: number }).section_id,
				),
			).toEqual([charlie, null, alpha]);
		} finally {
			// the poisoned key would fail every later apply run over this portal
			await assertTestDatabase('portal_order_native poisoned host sweep');
			await sql.unsafe(
				`UPDATE ${TABLE} SET relation = relation - $3::text WHERE section_tipo = $1 AND section_id = $2`,
				[TRIGGER_HOST, poisoned, PORTAL],
			);
		}
	}, 120000);

	test('the sweep is STOPPABLE: an abort ends it at the next record (typed update.failed) — records before it rewritten, the rest left as drift; the SIGTERM drain stops a registry run in flight', async () => {
		await seedPortalRecord('asc');
		expectRebuilt(await rebuildOntology(PORTAL_TLD, USER_ID, { mainNode: 'existing' }));
		const first = await hostRecord();
		await seedHost(first, [charlie, alpha, bravo]);
		const second = await hostRecord();
		await seedHost(second, [bravo, charlie, alpha]);
		// holders scanned BEFORE `first` (keyset on section_id) — earlier legs' hosts
		const earlier = (await sql.unsafe(
			`SELECT count(*)::int AS n FROM ${TABLE} WHERE section_tipo = $1 AND relation ? $2 AND section_id < $3`,
			[TRIGGER_HOST, PORTAL, first],
		)) as { n: number }[];
		// the signal is read once per portal, then once per holder: let the portal,
		// every earlier holder and `first` through, abort on `second` (depth > 0)
		const allowed = 1 + (earlier[0]?.n ?? 0) + 1;
		let reads = 0;
		const signal = {
			get aborted() {
				reads++;
				return reads > allowed;
			},
			reason: 'portal_order_native stop',
		} as unknown as AbortSignal;
		const aborted = await thrown(() =>
			reconcilePortalDeclaredOrder({ apply: true, scope: [PORTAL], signal }),
		);
		expect(aborted?.code).toBe('update.failed');
		expect(reads).toBe(allowed + 1);
		expect(await hostIds(first)).toEqual([alpha, bravo, charlie]);
		expect(await hostIds(second)).toEqual([bravo, charlie, alpha]);

		// THE REGISTRY DOOR (what the ontology-change trigger and the operator run
		// through): the SIGTERM drain — scheduler.ts stopReconcileScheduler — stops
		// a run in flight; the gauge records the typed abort, nothing is rewritten
		registerReconcile(PORTAL_DECLARED_ORDER_RECONCILE);
		const inFlight = runReconcile(PORTAL_DECLARED_ORDER, { apply: true, scope: [PORTAL] });
		stopReconcileScheduler();
		expect((await thrown(() => inFlight))?.code).toBe('update.failed');
		const gauge = reconcileGauge()[PORTAL_DECLARED_ORDER] as { last_error?: unknown };
		expect(gauge.last_error).toBe('update.failed');
		expect(await hostIds(second)).toEqual([bravo, charlie, alpha]);

		// control: the same run NOT stopped re-sorts it (a later run gets a fresh controller)
		await runReconcile(PORTAL_DECLARED_ORDER, { apply: true, scope: [PORTAL] });
		expect(await hostIds(second)).toEqual([alpha, bravo, charlie]);
	}, 120000);

	test('the unscoped census SKIPS and NAMES a node the ontology layer refuses (ontology.invalid_node), and still lists the declared portals', async () => {
		const BROKEN = `${TLD}70`;
		await upsertDdOntologyNode({
			tipo: BROKEN,
			parent: `${TLD}999999`,
			model: 'component_alias',
			tld: TLD,
			term: { 'lg-spa': 'scratch alias with a retired v5 key' },
			is_model: false,
			is_translatable: false,
			is_main: false,
			// `source` lists it in the census; `edit_view` is a retired v5 alias key (WC-020)
			properties: { alias_of: ORDER_COLUMN, edit_view: 'line', source: { request_config: [] } },
		});
		await clearOntologyDerivedCaches();
		try {
			const census = await reconcilePortalDeclaredOrder();
			const skipped = census.skipped.find((entry) => entry.tipo === BROKEN);
			// the code, never the exception text (the report is a payload)
			expect(skipped?.reason).toBe('unresolvable node (ontology.invalid_node)');
			expect(census.portals.map((portal) => portal.tipo)).toContain(DECLARED);
		} finally {
			await assertTestDatabase('portal_order_native broken node sweep');
			await sql.unsafe('DELETE FROM dd_ontology WHERE tipo = $1', [BROKEN]);
			await clearOntologyDerivedCaches();
		}
	}, 120000);

	test('a SCOPED run (what the ontology-change trigger always runs) SKIPS and NAMES an unresolvable scope entry and still re-sorts the other portal', async () => {
		await seedPortalRecord('asc');
		expectRebuilt(await rebuildOntology(PORTAL_TLD, USER_ID, { mainNode: 'existing' }));
		const host = await hostRecord();
		await seedHost(host, [charlie, bravo, alpha]);
		// sorts BEFORE the portal in the scope ('zzpdo70' < 'zzpdt1'): an unisolated
		// throw would end the run before the portal is scanned
		const BROKEN = `${TLD}70`;
		await upsertDdOntologyNode({
			tipo: BROKEN,
			parent: `${TLD}999999`,
			model: 'component_alias',
			tld: TLD,
			term: { 'lg-spa': 'scratch alias with a retired v5 key' },
			is_model: false,
			is_translatable: false,
			is_main: false,
			// `edit_view` is a retired v5 alias key (WC-020): resolving it throws ontology.invalid_node
			properties: { alias_of: ORDER_COLUMN, edit_view: 'line', source: { request_config: [] } },
		});
		await clearOntologyDerivedCaches();
		try {
			const applied = await reconcilePortalDeclaredOrder({ apply: true, scope: [PORTAL, BROKEN] });
			expect(applied.skipped).toContainEqual({
				tipo: BROKEN,
				reason: 'unresolvable node (ontology.invalid_node)',
			});
			expect(applied.portals.map((portal) => portal.tipo)).toEqual([PORTAL]);
			expect(applied.failed, declaredOrderReportLines(applied).join('\n')).toBe(0);
			expect(await hostIds(host)).toEqual([alpha, bravo, charlie]);
		} finally {
			await assertTestDatabase('portal_order_native broken node sweep');
			await sql.unsafe('DELETE FROM dd_ontology WHERE tipo = $1', [BROKEN]);
			await clearOntologyDerivedCaches();
		}
	}, 120000);

	test("an HTTP REQUEST's ontology write HANDS the sweep to a background job: the request returns without walking the holders; the job re-sorts", async () => {
		await seedPortalRecord('asc');
		expectRebuilt(await rebuildOntology(PORTAL_TLD, USER_ID, { mainNode: 'existing' }));
		const host = await hostRecord();
		await seedHost(host, [bravo, alpha, charlie]);
		const tm = await hostTm(host);
		const jobsBefore = new Set(
			mediaJobs
				.jobsForUser(USER_ID)
				.filter((job) => job.kind === DECLARED_ORDER_JOB_KIND)
				.map((job) => job.id),
		);
		await seedPortalRecord('desc');
		const request = {
			principal: ROOT,
			session: null,
			requestId: 'portal_order_native:handoff',
			clientIp: '',
		};
		// The host row is LOCKED while the request runs: a sweep the request
		// awaited would block on its FOR UPDATE re-read and the request would not
		// return — the race below would answer 'waited'.
		const outcome = await withTransaction(async () => {
			await sql.unsafe(
				`SELECT section_id FROM ${TABLE} WHERE section_tipo = $1 AND section_id = $2 FOR UPDATE`,
				[TRIGGER_HOST, host],
			);
			return runDetachedFromTransaction(() =>
				runWithRequestContext(request, () =>
					Promise.race([
						project().then(() => 'returned' as const),
						Bun.sleep(15000).then(() => 'waited' as const),
					]),
				),
			);
		});
		expect(outcome).toBe('returned');
		const job = mediaJobs
			.jobsForUser(USER_ID)
			.find((entry) => entry.kind === DECLARED_ORDER_JOB_KIND && !jobsBefore.has(entry.id));
		expect(job, 'no background job was handed the sweep').toBeDefined();
		// the lock is released: the job finishes the sweep
		for (let waited = 0; waited < 60000; waited += 100) {
			const status = mediaJobs.status(job?.id ?? '')?.status;
			if (status !== 'queued' && status !== 'running') break;
			await Bun.sleep(100);
		}
		expect(mediaJobs.status(job?.id ?? '')?.status).toBe('done');
		expect(await hostIds(host)).toEqual([charlie, bravo, alpha]);
		expect(await hostTm(host)).toBe(tm + 1);
	}, 120000);

	test('an ontology UPDATE runs ONE sweep after every tld (deriveOntologyPackages batch): none between two tlds, one over both changed portals', async () => {
		const SECOND_PORTAL = `${SECOND_PORTAL_TLD}1`;
		await seedPortalRecord('asc');
		await seedPortalRecord('asc', SECOND_PORTAL_TLD);
		expectRebuilt(await rebuildOntology(PORTAL_TLD, USER_ID, { mainNode: 'existing' }));
		expect(
			(await rebuildOntology(SECOND_PORTAL_TLD, USER_ID, { mainNode: 'existing' })).errors,
		).toEqual([]);
		const host = await hostRecord();
		await seedHost(host, [alpha, charlie, bravo]);

		// THE BATCH DOOR: a committed rebuild inside it re-sorts NOTHING until the batch ends
		await seedPortalRecord('desc');
		await withOrderReconcileBatch(async () => {
			expectRebuilt(await rebuildOntology(PORTAL_TLD, USER_ID, { mainNode: 'existing' }));
			expect(await hostIds(host)).toEqual([alpha, charlie, bravo]);
		});
		expect(await hostIds(host)).toEqual([charlie, bravo, alpha]);

		// THE UPDATE: both tlds change their order; the per-tld rebuilds commit one
		// by one, and ONE apply sweep — scoped to both portals — runs after the last
		await seedHost(host, [bravo, alpha, charlie]);
		await seedPortalRecord('asc');
		await seedPortalRecord('desc', SECOND_PORTAL_TLD);
		const logs: string[] = [];
		const spy = spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
			logs.push(args.map(String).join(' '));
		});
		let derived: { messages: string[]; errors: string[] } = { messages: [], errors: [] };
		try {
			derived = await deriveOntologyPackages(
				[
					{ tld: PORTAL_TLD, sectionTipo: PORTAL_SECTION, stagedPath: '' },
					{ tld: SECOND_PORTAL_TLD, sectionTipo: `${SECOND_PORTAL_TLD}0`, stagedPath: '' },
				],
				USER_ID,
			);
		} finally {
			spy.mockRestore();
		}
		const sweeps = logs.filter((line) =>
			line.startsWith(`[reconcile] ${PORTAL_DECLARED_ORDER} (apply):`),
		);
		expect(sweeps, [...derived.errors, ...logs].join('\n')).toHaveLength(1);
		expect(sweeps[0]).toContain('2 declared-order portal(s)');
		expect(declaredOrderSignature((await readDdOntologyRow(SECOND_PORTAL))?.properties)).toContain(
			'DESC',
		);
		expect(await hostIds(host)).toEqual([alpha, bravo, charlie]);
	}, 120000);
});
