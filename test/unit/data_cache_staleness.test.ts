/**
 * S1-11 gate: data-derived caches get a WRITE and DELETE invalidation channel.
 *
 * The durable channel: every persistent record write (record_write chokepoint)
 * and every record delete (delete_record step 7) fires fireSaveEvent, which
 * fans the section tipo out to the registered section-data listeners. The
 * datalist records componentTipo→targetSections at populate time, so a write
 * to a TARGET section evicts exactly the option lists built from it.
 *
 * Scratch surface: matrix_test via the REAL ontology section 'test2' (its
 * matrix_table relation resolves to matrix_test), reserved high section_id.
 * Every row this file creates (matrix + time machine) is removed after.
 */
// Migrated to the generic `test` TLD 2026-08-20 (AGENTS.md hard rule). Install tipos
// were replaced by their twins from src/core/test_data/test_tld_tipo_map.json; the
// seed-shipped ones (rsc/dd/hierarchy/ontology/lg) have no twin and stay, because they
// ship with every installation.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { withTransaction } from '../../src/core/db/postgres.ts';
import { getDatalist } from '../../src/core/relations/datalist.ts';
import { getUserAuthorizedProjects } from '../../src/core/relations/filter_projects.ts';
import { resolveHierarchySectionsFromTypes } from '../../src/core/relations/request_config/explicit.ts';
import { deleteSectionRecord } from '../../src/core/section/record/delete_record.ts';
import { persistRecordColumns } from '../../src/core/section_record/record_write.ts';
import { fireSaveEvent } from '../../src/core/section_record/save_event.ts';
import { runWithRequestContext } from '../../src/core/security/request_context.ts';
import { cleanScratchRecord } from '../helpers/test_data.ts';

const TEST_TABLE = 'matrix_test';
const TARGET_SECTION = 'test2'; // real ontology section → matrix_test
const NEW_SECTION_ID = 900411; // reserved: collides with nothing real
const COMPONENT_TIPO = 'zzdatalist1'; // synthetic owner — datalist keys on it

/** Explicit-config properties targeting TARGET_SECTION with no label ddos (labels ''). */
const COMPONENT_PROPERTIES = {
	source: {
		request_config: [
			{
				api_engine: 'dedalo',
				sqo: { section_tipo: [TARGET_SECTION] },
				show: { ddo_map: [] },
			},
		],
	},
};

function warmDatalist(): ReturnType<typeof getDatalist> {
	return getDatalist(
		COMPONENT_TIPO,
		COMPONENT_PROPERTIES,
		{ section_tipo: TARGET_SECTION, section_id: null },
		'lg-eng',
	);
}

function cleanup(): Promise<void> {
	return cleanScratchRecord(TARGET_SECTION, NEW_SECTION_ID, TEST_TABLE);
}

describe('datalist staleness: write + delete of a target-section record (S1-11)', () => {
	beforeAll(cleanup);
	afterAll(cleanup);

	test('a record write through the chokepoint makes the datalist re-query', async () => {
		const before = await warmDatalist();
		expect(await warmDatalist()).toBe(before); // cache hit → same instance
		// WC-2026-08-10-section-id-int-canonical: datalist option addresses are
		// ints (was String(NEW_SECTION_ID)) — here and in the three probes below.
		expect(before.some((item) => item.section_id === NEW_SECTION_ID)).toBe(false);

		// WRITE a new record of the target section through the production
		// chokepoint (persistRecordColumns → fireSaveEvent).
		const outcome = await persistRecordColumns(
			{ table: TEST_TABLE, sectionTipo: TARGET_SECTION, sectionId: NEW_SECTION_ID },
			{ string: { test1: [{ id: 1, lang: 'lg-eng', value: 'datalist staleness probe' }] } },
			false,
			{ actor: -1 },
		);
		expect(outcome).toBe('inserted');

		const after = await warmDatalist();
		expect(after).not.toBe(before); // evicted → re-queried
		expect(after.some((item) => item.section_id === NEW_SECTION_ID)).toBe(true);
	});

	test('a record DELETE makes the datalist re-query (delete_record fires the event)', async () => {
		const before = await warmDatalist();
		expect(before.some((item) => item.section_id === NEW_SECTION_ID)).toBe(true);

		const result = await deleteSectionRecord(TARGET_SECTION, NEW_SECTION_ID, -1);
		expect(result.removed).toBe(true);

		const after = await warmDatalist();
		expect(after).not.toBe(before);
		expect(after.some((item) => item.section_id === NEW_SECTION_ID)).toBe(false);
	});

	test('a write to an UNRELATED section leaves the datalist cached', async () => {
		const before = await warmDatalist();
		await fireSaveEvent('testmint1'); // not a target of this datalist
		expect(await warmDatalist()).toBe(before);
	});

	test('an IN-TX save event is deferred to the transaction settle (S1-14 posture)', async () => {
		const before = await warmDatalist();
		await withTransaction(async () => {
			await fireSaveEvent(TARGET_SECTION);
			// Deferred: mid-tx the shared cache must stay untouched.
			expect(await warmDatalist()).toBe(before);
		});
		expect(await warmDatalist()).not.toBe(before); // replayed on COMMIT
	});
});

describe('filter_projects + hierarchy sections listeners (S1-11 durable channel)', () => {
	// AUTHZ-06: getUserAuthorizedProjects fails CLOSED on an unanchored call —
	// it returns a FRESH [] before ever touching the cache, so an identity
	// check on that path measures the deny, not the eviction channel. Both
	// cases below run anchored, the way the production callers (portal.ts
	// get_data/list, on the authenticated dispatch path) reach it.
	const asAdmin = <T>(fn: () => Promise<T>): Promise<T> =>
		runWithRequestContext(
			{
				principal: { userId: 1, isGlobalAdmin: true, isDeveloper: false },
				session: null,
				requestId: 'test',
				clientIp: '127.0.0.1',
			},
			fn,
		);

	test('a dd153 (projects) event rebuilds the authorized-projects cache', async () => {
		const before = await asAdmin(getUserAuthorizedProjects);
		expect(await asAdmin(getUserAuthorizedProjects)).toBe(before);
		await fireSaveEvent('dd153');
		const after = await asAdmin(getUserAuthorizedProjects);
		expect(after).not.toBe(before);
		expect(after).toEqual(before); // no data changed — same content, fresh read
	});

	test('an unrelated event leaves the authorized-projects cache untouched', async () => {
		const before = await asAdmin(getUserAuthorizedProjects);
		await fireSaveEvent('testmint1');
		expect(await asAdmin(getUserAuthorizedProjects)).toBe(before);
	});

	test('an UNANCHORED call fails closed and is never cached (AUTHZ-06)', async () => {
		const first = await getUserAuthorizedProjects();
		expect(first).toEqual([]);
		// A fresh array each time: the deny returns before the cache lookup.
		expect(await getUserAuthorizedProjects()).not.toBe(first);
	});

	test('a hierarchy1 (registry) event rebuilds the hierarchy-sections cache', async () => {
		const before = await resolveHierarchySectionsFromTypes([1]);
		expect(await resolveHierarchySectionsFromTypes([1])).toBe(before);
		await fireSaveEvent('hierarchy1');
		const after = await resolveHierarchySectionsFromTypes([1]);
		expect(after).not.toBe(before);
		expect(after).toEqual(before);
	});
});

// NOTE: no afterAll(closeDatabasePool) — the pool is shared module state
// across the test files bun runs in one process (matrix_read.test.ts NOTE).
