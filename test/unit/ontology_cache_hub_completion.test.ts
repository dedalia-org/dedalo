/**
 * S1-09 gate: EVERY dd_ontology-reading module cache is registered with the
 * invalidation hub, so an ontology write propagates without a restart.
 *
 * Three layers, against the real dev DB:
 *  1. REGISTRATION — each module's exported named clearer is registered with
 *     the hub (introspected identity, so a module cannot satisfy the gate
 *     with a stray lambda while its named clearer goes unregistered).
 *  2. IDENTITY — for the object-valued cached getters, the Wave-2 probe
 *     technique: two calls share one reference (cache hit), a hub fire makes
 *     the next call rebuild (new reference). Read-only.
 *  3. STALE-READ SCENARIO — the D2 `hub_gap_stale_reads` probe as a test: a
 *     REAL dd_ontology write (scratch TLD, purged after) must make label,
 *     section_map, section_id-component and children-tipo reads re-resolve
 *     fresh — exactly the reads that served stale values before this fix.
 */
// Migrated to the generic `test` TLD 2026-08-20: the identity probes name the
// `test`-TLD clones of the sections/components they used to borrow from an
// install — the subject is cache identity across a hub fire, not either install.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { clearAreaWalkCache, collectAreaRows } from '../../src/core/api/handlers/menu.ts';
import { clearChildrenTipoCache } from '../../src/core/area/tree.ts';
import { deleteTldNodes, upsertDdOntologyNode } from '../../src/core/db/dd_ontology.ts';
import { clearLabelsCache, getLabels } from '../../src/core/labels/catalog.ts';
import { clearAliasCaches } from '../../src/core/ontology/alias.ts';
import {
	clearOntologyDerivedCaches,
	isOntologyCacheClearerRegistered,
} from '../../src/core/ontology/cache_invalidation.ts';
import { clearLabelCache, labelByTipo } from '../../src/core/ontology/labels.ts';
import { clearOntologyCaches } from '../../src/core/ontology/resolver.ts';
import {
	clearSectionIdComponentCache,
	getSectionIdComponentTipo,
} from '../../src/core/ontology/section_id_component.ts';
import { clearSectionMapCache, getSectionMap } from '../../src/core/ontology/section_map.ts';
import { clearSectionComponentCache, getChildrenTipo } from '../../src/core/relations/children.ts';
import { clearDatalistCache } from '../../src/core/relations/datalist.ts';
import {
	clearFilterProjectsCache,
	getUserAuthorizedProjects,
} from '../../src/core/relations/filter_projects.ts';
import {
	clearHierarchySectionsCache,
	clearOntologySectionsCache,
	resolveHierarchySectionsFromTypes,
	resolveOntologySections,
} from '../../src/core/relations/request_config/explicit.ts';
import { clearDdInfoCache } from '../../src/core/resolve/dd_info.ts';
import {
	clearRelatedListCache,
	getRelatedListChildTipos,
} from '../../src/core/resolve/relation_index.ts';
import { clearFieldsSeparatorCache } from '../../src/core/resolve/relation_list.ts';
import { clearSecurityAccessCaches } from '../../src/core/resolve/security_access_datalist.ts';
import { clearStructureContextCache } from '../../src/core/resolve/structure_context.ts';
import {
	clearRelatedTablesCache,
	getRelationTables,
} from '../../src/core/search/search_related.ts';
import { clearSectionButtonsCache, sectionButtonRows } from '../../src/core/section/buttons.ts';
import {
	clearListCellConfigCache,
	getDataframeChildTipos,
	resolveListCellMap,
	resolveOwnConfigMap,
} from '../../src/core/section/list_definitions/section_list.ts';
import { clearObserverSubscriptionRegistry } from '../../src/core/section/record/observer_subscriptions.ts';
import { runWithRequestContext } from '../../src/core/security/request_context.ts';

// --- 1. registration census -------------------------------------------------

const REGISTERED_CLEARERS: [string, () => void][] = [
	['resolver clearOntologyCaches', clearOntologyCaches],
	['labels clearLabelCache', clearLabelCache],
	['section_map clearSectionMapCache', clearSectionMapCache],
	['section_id_component clearSectionIdComponentCache', clearSectionIdComponentCache],
	['structure_context clearStructureContextCache', clearStructureContextCache],
	['labels/catalog clearLabelsCache', clearLabelsCache],
	['dd_info clearDdInfoCache', clearDdInfoCache],
	['relation_index clearRelatedListCache', clearRelatedListCache],
	['relation_list clearFieldsSeparatorCache', clearFieldsSeparatorCache],
	['security_access_datalist clearSecurityAccessCaches', clearSecurityAccessCaches],
	['children clearSectionComponentCache', clearSectionComponentCache],
	['section_list clearListCellConfigCache', clearListCellConfigCache],
	['area/tree clearChildrenTipoCache', clearChildrenTipoCache],
	['search_related clearRelatedTablesCache', clearRelatedTablesCache],
	['datalist clearDatalistCache', clearDatalistCache],
	['filter_projects clearFilterProjectsCache', clearFilterProjectsCache],
	['request_config/explicit clearHierarchySectionsCache', clearHierarchySectionsCache],
	['request_config/explicit clearOntologySectionsCache', clearOntologySectionsCache],
	['handlers/menu clearAreaWalkCache', clearAreaWalkCache],
	// ontology/term_label's row cache folded into labels.ts 2026-11-04: it is
	// cleared by clearLabelCache (registered above).
	// component_alias caches (WC-020); the object-identity probe lives in
	// test/unit/component_alias.test.ts on scratch fixtures (no live alias node
	// is valid pre-migration — the v5 keys throw by contract).
	['ontology/alias clearAliasCaches', clearAliasCaches],
	['section/buttons clearSectionButtonsCache', clearSectionButtonsCache],
	// Observer subscription registry (Act 2, 2026-08-02): index + seed-race
	// build tokens; the identity probe lives in observer_subscriptions_native
	// (lifecycle test) rather than IDENTITY_CASES — the registry is global, not
	// per-tipo keyed.
	[
		'record/observer_subscriptions clearObserverSubscriptionRegistry',
		clearObserverSubscriptionRegistry,
	],
];

describe('hub registration census (S1-09)', () => {
	for (const [name, clearer] of REGISTERED_CLEARERS) {
		test(`${name} is registered with the invalidation hub`, () => {
			expect(isOntologyCacheClearerRegistered(clearer)).toBe(true);
		});
	}
});

// --- 2. object identity across a hub fire ------------------------------------

/** Object-valued cached getters: same ref on a hit, new ref after a hub fire. */
const IDENTITY_CASES: [string, () => Promise<object | null>][] = [
	['section_list resolveListCellMap', () => resolveListCellMap('testmint1002')],
	['section_list resolveOwnConfigMap', () => resolveOwnConfigMap('testmint1002')],
	['section_list getDataframeChildTipos', () => getDataframeChildTipos('testmint1002')],
	['relation_index getRelatedListChildTipos', () => getRelatedListChildTipos('testmint1')],
	['labels/catalog getLabels', () => getLabels('lg-eng')],
	['search_related getRelationTables', () => getRelationTables()],
	['section_map getSectionMap', () => getSectionMap('test6813')],
	// AUTHZ-06 made getUserAuthorizedProjects fail CLOSED without an ambient
	// principal (a fresh [] each call — no identity to test), which left this
	// case permanently red. Anchor a global-admin principal so the case tests
	// what it was written to test: cache identity across a hub fire. (The
	// fail-closed no-principal behaviour has its own assertion surface in the
	// AUTHZ gates; repaired 2026-08-02 during the Act 2 remediation.)
	[
		'filter_projects getUserAuthorizedProjects',
		() =>
			runWithRequestContext(
				{
					principal: { userId: 1, isGlobalAdmin: true, isDeveloper: false },
					session: null,
					requestId: 'hub_completion_test',
					clientIp: '127.0.0.1',
				},
				() => getUserAuthorizedProjects(),
			),
	],
	[
		'request_config/explicit resolveHierarchySectionsFromTypes',
		() => resolveHierarchySectionsFromTypes([1]),
	],
	['request_config/explicit resolveOntologySections', () => resolveOntologySections()],
	['handlers/menu collectAreaRows', () => collectAreaRows()],
	['section/buttons sectionButtonRows', () => sectionButtonRows('test6813')],
];

describe('object identity across a hub fire (S1-09)', () => {
	for (const [name, getter] of IDENTITY_CASES) {
		test(`${name}: cached by reference, rebuilt after clearOntologyDerivedCaches`, async () => {
			const first = await getter();
			expect(first).not.toBeNull(); // a null value cannot carry identity
			expect(await getter()).toBe(first as object); // cache hit → same instance
			await clearOntologyDerivedCaches();
			const rebuilt = await getter();
			expect(rebuilt).not.toBe(first as object); // rebuilt → fresh instance
			expect(rebuilt).toEqual(first); // same content (no DB writes happened)
		});
	}
});

// --- 3. stale-read scenario (the D2 hub_gap_stale_reads probe as a test) -----

const SCRATCH_TLD = 'zzhubgate';
const SECTION = `${SCRATCH_TLD}1`;
const SECTION_MAP_NODE = `${SCRATCH_TLD}2`;
const SECTION_ID_COMPONENT = `${SCRATCH_TLD}5`;
const CHILDREN_COMPONENT = `${SCRATCH_TLD}6`;

describe('ontology write → derived reads re-resolve fresh (S1-09)', () => {
	beforeAll(async () => {
		await deleteTldNodes(SCRATCH_TLD);
	});
	afterAll(async () => {
		await deleteTldNodes(SCRATCH_TLD); // fires the hub itself — leaves no scratch state
	});

	test('labelByTipo serves the NEW term after an ontology re-write', async () => {
		await upsertDdOntologyNode({
			tipo: SECTION,
			model: 'section',
			tld: SCRATCH_TLD,
			term: { 'lg-eng': 'Hub gate label A' },
		});
		expect(await labelByTipo(SECTION, 'lg-eng')).toBe('Hub gate label A');
		await upsertDdOntologyNode({
			tipo: SECTION,
			model: 'section',
			tld: SCRATCH_TLD,
			term: { 'lg-eng': 'Hub gate label B' },
		});
		// Before the fix labels.ts never registered → this served 'A' forever.
		expect(await labelByTipo(SECTION, 'lg-eng')).toBe('Hub gate label B');
	});

	test('getSectionMap serves the NEW properties after a section_map re-write', async () => {
		await upsertDdOntologyNode({
			tipo: SECTION_MAP_NODE,
			parent: SECTION,
			model: 'section_map',
			tld: SCRATCH_TLD,
			properties: { main: { term: `${SCRATCH_TLD}3` } },
		});
		expect(await getSectionMap(SECTION)).toEqual({ main: { term: `${SCRATCH_TLD}3` } });
		await upsertDdOntologyNode({
			tipo: SECTION_MAP_NODE,
			parent: SECTION,
			model: 'section_map',
			tld: SCRATCH_TLD,
			properties: { main: { term: `${SCRATCH_TLD}4` } },
		});
		expect(await getSectionMap(SECTION)).toEqual({ main: { term: `${SCRATCH_TLD}4` } });
	});

	test('getSectionIdComponentTipo picks up a NEWLY added component', async () => {
		expect(await getSectionIdComponentTipo(SECTION)).toBeNull(); // cached miss
		await upsertDdOntologyNode({
			tipo: SECTION_ID_COMPONENT,
			parent: SECTION,
			model: 'component_section_id',
			tld: SCRATCH_TLD,
		});
		// Before the fix the cached null survived the write.
		expect(await getSectionIdComponentTipo(SECTION)).toBe(SECTION_ID_COMPONENT);
	});

	test('children getChildrenTipo picks up a NEWLY added component', async () => {
		expect(await getChildrenTipo(SECTION)).toBeNull(); // cached miss
		await upsertDdOntologyNode({
			tipo: CHILDREN_COMPONENT,
			parent: SECTION,
			model: 'component_relation_children',
			tld: SCRATCH_TLD,
		});
		expect(await getChildrenTipo(SECTION)).toBe(CHILDREN_COMPONENT);
	});
});

// NOTE: no afterAll(closeDatabasePool) — the pool is shared module state
// across the test files bun runs in one process (matrix_read.test.ts NOTE).
