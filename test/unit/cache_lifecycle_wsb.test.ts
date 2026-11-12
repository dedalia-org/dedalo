/**
 * WS-B cache-lifecycle gates (REMEDIATION WS-B; DEC-11/DEC-13/DEC-20).
 *
 * Covers, against the real dev DB:
 *  1. FACTORY (item 1): a cache built by createOntologyCache is cleared by a
 *     hub fire BY CONSTRUCTION; a createDataCache receives the save/delete
 *     event with its own eviction callback, and the event is DEFERRED to the
 *     transaction settle point (S1-14 posture). The grep gate lives in
 *     module_state_tripwire.test.ts.
 *  2. S1-14 residual (item 2): an in-tx read of an UNCOMMITTED dd_ontology row
 *     must not seed the shared node cache — after ROLLBACK the row does not
 *     exist and the cache must not pretend it does. (The raw INSERT here fires
 *     no hub event on purpose: it isolates the cacheSet guard from the
 *     deferred-clear replay, which deferred_cache_clear.test.ts already gates.)
 *  3. S2-10 (item 3): renaming a thesaurus term through the ORDINARY record
 *     write chokepoint (persistRecordColumns → fireSaveEvent) makes
 *     getTermByLocator(fromCache=true) — the tree render path — serve the new
 *     label without any ts_api tree mutation.
 *  4. S3-18 (item 7): a users-section write through the event channel drops
 *     the per-user projects cache (the TM-restore path fires the same event).
 *  5. S3-21/59 (item 7): getLangNameFromCode keys by BOTH the requested lang
 *     and the request data lang — two sessions with different data langs get
 *     their own fallback, not the first writer's.
 *  6. S3-22 (item 7): the datalist cache is growth-bounded — overflowing wipes
 *     rather than pinning entries forever.
 *
 * (The former item 7 — the S2-09 tools-registry coexistence TTL — retired at
 * the 2026-07-11 cutover with the TTL itself: single-writer invalidation via
 * the save_event channel needs no staleness bound.)
 *
 * Scratch surfaces only: a reserved-high-id row in the SYNTHETIC hierarchy's
 * terms section (matrix_hierarchy; src/core/test_data/synthetic_hierarchy_fixture.ts
 * — migrated off the real Spain hierarchy 2026-08-25: any section whose
 * section_map resolves thesaurus.term = hierarchy25 hosts this case) + its
 * time-machine rows, a scratch dd_ontology tipo that only ever exists inside a
 * rolled-back transaction, and the synthetic 'test2' datalist component from
 * the data_cache_staleness precedent. All cleaned up.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql, withTransaction } from '../../src/core/db/postgres.ts';
import { createDataCache, createOntologyCache } from '../../src/core/ontology/cache_factory.ts';
import { clearOntologyDerivedCaches } from '../../src/core/ontology/cache_invalidation.ts';
import { getNode } from '../../src/core/ontology/resolver.ts';
import { clearDatalistCache, getDatalist } from '../../src/core/relations/datalist.ts';
import { getLangNameFromCode } from '../../src/core/resolve/lang_names.ts';
import { runWithRequestLangs } from '../../src/core/resolve/request_lang.ts';
import { persistRecordColumns } from '../../src/core/section_record/record_write.ts';
import { fireSaveEvent } from '../../src/core/section_record/save_event.ts';
import { getUserProjects } from '../../src/core/security/permissions.ts';
import { SYNTHETIC_HIERARCHY_A_TLD } from '../../src/core/test_data/synthetic_hierarchy_constants.ts';
import { getTermByLocator } from '../../src/core/ts_object/term_resolver.ts';
import { cleanScratchRecord } from '../helpers/test_data.ts';

// --- 1. factory auto-registration --------------------------------------------

describe('cache factory registers by construction (WS-B item 1)', () => {
	test('createOntologyCache: a hub fire clears the map', async () => {
		const cache = createOntologyCache<string, number>();
		cache.set('k', 1);
		await clearOntologyDerivedCaches();
		expect(cache.size).toBe(0);
	});

	test('createDataCache: fireSaveEvent reaches the eviction callback', async () => {
		const seen: string[] = [];
		const cache = createDataCache<string, number>((map, sectionTipo) => {
			seen.push(sectionTipo);
			map.clear();
		});
		cache.set('k', 1);
		await fireSaveEvent('zzwsbfactory1');
		expect(seen).toContain('zzwsbfactory1');
		expect(cache.size).toBe(0);
	});

	test('createDataCache: an in-tx save event is deferred to the settle point (S1-14 posture)', async () => {
		const seen: string[] = [];
		createDataCache<string, number>((_map, sectionTipo) => {
			seen.push(sectionTipo);
		});
		await withTransaction(async () => {
			await fireSaveEvent('zzwsbfactory2');
			expect(seen).not.toContain('zzwsbfactory2'); // queued, not fired mid-tx
		});
		expect(seen).toContain('zzwsbfactory2'); // replayed after COMMIT
	});
});

// --- 2. S1-14 in-tx cache-seed guard ------------------------------------------

const GUARD_TIPO = 'zzwsbguard1';

describe('in-tx reads never seed shared ontology caches (S1-14 residual)', () => {
	beforeAll(async () => {
		await sql`DELETE FROM dd_ontology WHERE tipo = ${GUARD_TIPO}`;
		await clearOntologyDerivedCaches();
	});

	test('a rolled-back node read leaves no cache poison', async () => {
		await expect(
			withTransaction(async () => {
				await sql`INSERT INTO dd_ontology (tipo, model, tld) VALUES (${GUARD_TIPO}, 'section', 'zzwsbguard')`;
				const inTx = await getNode(GUARD_TIPO);
				expect(inTx).not.toBeNull(); // the tx sees its own uncommitted write
				throw new Error('wsb-force-rollback');
			}),
		).rejects.toThrow('wsb-force-rollback');
		// The INSERT never committed. Before the guard, the in-tx getNode had
		// memoized the phantom row process-wide (and no hub fire ever rescued
		// it, because the raw INSERT fires none).
		expect(await getNode(GUARD_TIPO)).toBeNull();
	});
});

// --- 3. S2-10 thesaurus term staleness through ordinary saves ------------------

const TERM_SECTION = `${SYNTHETIC_HIERARCHY_A_TLD}1`; // activated thesaurus section: section_map thesaurus.term = hierarchy25
const TERM_TABLE = 'matrix_hierarchy';
const TERM_COMPONENT = 'hierarchy25';
const TERM_ID = 900431; // reserved scratch id — collides with nothing real

function termCleanup(): Promise<void> {
	return cleanScratchRecord(TERM_SECTION, TERM_ID, TERM_TABLE);
}

describe('ordinary section save invalidates the term cache (S2-10)', () => {
	beforeAll(termCleanup);
	afterAll(termCleanup);

	test('getTermByLocator(fromCache=true) serves the NEW term after a chokepoint write', async () => {
		const locator = { section_tipo: TERM_SECTION, section_id: TERM_ID };
		const write = (value: string) =>
			persistRecordColumns(
				{ table: TERM_TABLE, sectionTipo: TERM_SECTION, sectionId: TERM_ID },
				{ string: { [TERM_COMPONENT]: [{ id: 1, lang: 'lg-eng', value }] } },
				false,
				{ actor: -1 },
			);

		await write('WSB term A');
		expect(await getTermByLocator(locator, 'lg-eng', true)).toBe('WSB term A');
		await write('WSB term B');
		// Before the S2-10 hook the tree path served 'WSB term A' forever
		// (invalidateNode ran only on ts_api tree mutations).
		expect(await getTermByLocator(locator, 'lg-eng', true)).toBe('WSB term B');
	});
});

// --- 4. S3-18 permissions eviction via the event channel -----------------------

describe('users-section writes drop the permissions caches (S3-18)', () => {
	test('getUserProjects rebuilds after a dd128 save event', async () => {
		const probeUserId = 987654; // no such user — the [] result still caches by reference
		const first = await getUserProjects(probeUserId);
		expect(await getUserProjects(probeUserId)).toBe(first); // cache hit → same ref
		await fireSaveEvent('dd128'); // what a TM restore via persistRecordColumns fires
		expect(await getUserProjects(probeUserId)).not.toBe(first); // evicted → rebuilt
	});
});

// --- 5. S3-21/59 lang_names dual-lang key --------------------------------------

describe('lang-name fallback is keyed by the request data lang (S3-21/S3-59)', () => {
	test('two data langs get their own fallback value, not the first writer’s', async () => {
		// 'lg-spa' has no lg-cat name on this install, so the requested lang
		// misses and the DATA-LANG fallback decides — per request.
		const underEng = await runWithRequestLangs(
			{ applicationLang: 'lg-eng', dataLang: 'lg-eng' },
			() => getLangNameFromCode('lg-spa', 'lg-cat'),
		);
		const underSpa = await runWithRequestLangs(
			{ applicationLang: 'lg-spa', dataLang: 'lg-spa' },
			() => getLangNameFromCode('lg-spa', 'lg-cat'),
		);
		expect(underEng).toBe('Spanish');
		expect(underSpa).toBe('Castellano'); // pre-fix: served 'Spanish' from the shared key
	});
});

// --- 6. S3-22 datalist growth bound ---------------------------------------------

const DATALIST_TARGET = 'test2'; // real ontology section → matrix_test (staleness-gate precedent)
const DATALIST_COMPONENT = 'zzwsbdatalist1';
const DATALIST_PROPERTIES = {
	source: {
		request_config: [
			{
				api_engine: 'dedalo',
				sqo: { section_tipo: [DATALIST_TARGET] },
				show: { ddo_map: [] },
			},
		],
	},
};

describe('datalist cache is growth-bounded (S3-22)', () => {
	test('overflow wipes the cache instead of pinning entries forever', async () => {
		clearDatalistCache();
		const warm = (lang: string) =>
			getDatalist(
				DATALIST_COMPONENT,
				DATALIST_PROPERTIES,
				{ section_tipo: DATALIST_TARGET, section_id: null },
				lang,
			);
		const first = await warm('lg-wsb0');
		expect(await warm('lg-wsb0')).toBe(first); // sanity: cached by reference
		// Push the cache past MAX_DATALIST_CACHE_ENTRIES (500) distinct keys.
		for (let index = 1; index <= 500; index++) {
			await warm(`lg-wsb${index}`);
		}
		// The overflow wipe must have evicted the first entry (unbounded growth
		// would still hold it by reference).
		expect(await warm('lg-wsb0')).not.toBe(first);
		clearDatalistCache();
	}, 60000);
});

// (Former section 7 — the S2-09 registry coexistence TTL gate — deleted at
// the 2026-07-11 cutover together with the TTL mechanism in tools/registry.ts.)

// NOTE: no afterAll(closeDatabasePool) — the pool is shared module state
// across the test files bun runs in one process (matrix_read.test.ts NOTE).
