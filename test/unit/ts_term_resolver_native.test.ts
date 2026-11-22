/**
 * TS_TERM_RESOLVER — native gates for `getTermByLocator` (:277) and
 * `getDdoValueByLocator` (:338), the two label resolvers every tree node, portal
 * chip and 'M' model badge renders through.
 *
 * WHY THIS FILE. Both functions were exercised only indirectly (tree/section
 * reads), so their guards, their two DIFFERENT language chains and — above all —
 * the shared module cache were unpinned. The cache is the point of half of these
 * cases: its key includes the lang, and `invalidateNode` is the only targeted
 * eviction path. Order matters everywhere below: seed, read stale, invalidate,
 * re-read.
 *
 * ONE chain since T2 THES-01/03 (2026-11-22; the two doors used to differ — the
 * term door stopped at the main lang, the ddo door ran on to "any non-empty"):
 * a translatable part reads data-lang → hierarchy main lang → lg-nolan → the
 * project langs in config order, and STOPS there (PHP
 * get_value_with_fallback_from_data); a non-translatable part reads lg-nolan
 * only. `test3/27` holds its `test52` in lg-spa only (a project lang), so an
 * lg-eng read resolves 'El dos' through BOTH doors; a value held only in a
 * language no project declares (`lg-tlh`) resolves through neither.
 *
 * Fixtures: canonical playground rows test3/1 and test3/27 (re-seeded by
 * test/preload/canonical_test3.ts) for the read cases; scratch test3 rows in
 * 924000-924999 (this file's assigned namespace) for every case a canonical row
 * cannot reach — the lg-nolan / project-lang rungs, the non-project stop, the
 * non-translatable branch,
 * a multi-fragment join, and the rename that invalidateNode must expose.
 * Scratch rows are inserted raw (no counter bump, no TM tail) and removed
 * fail-loud in afterAll.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { config } from '../../src/config/config.ts';
import { sql } from '../../src/core/db/postgres.ts';
import {
	clearTermCache,
	getDdoValueByLocator,
	getTermByLocator,
	invalidateNode,
} from '../../src/core/ts_object/term_resolver.ts';

// --- scratch namespace (assigned): test3 section ids 924000-924999 -----------
const SCRATCH_MIN = 924000;
const SCRATCH_MAX = 924999;

/** translatable value only under lg-nolan → exercises the ddo lg-nolan step. */
const ID_NOLAN = 924001;
/** translatable value only under lg-fra (a project lang) → the project-lang rung. */
const ID_ANY = 924002;
/** NON-translatable component stored under lg-eng only → the no-fallback branch. */
const ID_NOTRANS_ENG = 924003;
/** NON-translatable component stored under lg-nolan → the branch's positive. */
const ID_NOTRANS_NOLAN = 924004;
/** two non-empty ddo fragments → the join/separator positive. */
const ID_TWO_FRAGMENTS = 924005;
/** renamed under the cache's nose → invalidateNode. */
const ID_RENAME = 924006;
/** a second node renamed at the same time → proves the eviction is SCOPED. */
const ID_NEIGHBOUR = 924007;
/** translatable value only under lg-tlh (NO project lang) → the chain's stop. */
const ID_FOREIGN = 924008;
const FOREIGN_LANG = 'lg-tlh';

async function seedTest3(sectionId: number, stringColumn: unknown): Promise<void> {
	await sql.unsafe(
		`INSERT INTO matrix_test (section_id, section_tipo, string)
		 VALUES ($1, 'test3', $2::text::jsonb)
		 ON CONFLICT (section_id, section_tipo) DO UPDATE SET string = EXCLUDED.string`,
		[sectionId, JSON.stringify(stringColumn)],
	);
}

beforeAll(async () => {
	// Pre-count MUST be zero: a leftover row from a crashed run would make the
	// reads below assert against data this file did not write.
	const before = (await sql.unsafe(
		`SELECT count(*)::int AS n FROM matrix_test
		 WHERE section_tipo = 'test3' AND section_id BETWEEN $1 AND $2`,
		[SCRATCH_MIN, SCRATCH_MAX],
	)) as { n: number }[];
	expect(before[0]?.n).toBe(0);

	await seedTest3(ID_NOLAN, { test52: [{ lang: 'lg-nolan', value: 'Nolan stored' }] });
	await seedTest3(ID_ANY, { test52: [{ lang: 'lg-fra', value: 'Seulement en français' }] });
	await seedTest3(ID_NOTRANS_ENG, { test208: [{ lang: 'lg-eng', value: 'eng@example.org' }] });
	await seedTest3(ID_NOTRANS_NOLAN, {
		test208: [{ lang: 'lg-nolan', value: 'nolan@example.org' }],
	});
	await seedTest3(ID_TWO_FRAGMENTS, {
		test52: [{ lang: 'lg-eng', value: 'Alpha' }],
		test17: [{ lang: 'lg-eng', value: 'Beta' }],
	});
	await seedTest3(ID_RENAME, { test52: [{ lang: 'lg-eng', value: 'ORIGINAL' }] });
	await seedTest3(ID_NEIGHBOUR, { test52: [{ lang: 'lg-eng', value: 'NEIGHBOUR' }] });
	await seedTest3(ID_FOREIGN, { test52: [{ lang: FOREIGN_LANG, value: 'Only Klingon' }] });
});

// Both functions share ONE module cache; a case that did not clear it would
// assert the previous case's cache instead of the function.
beforeEach(() => {
	clearTermCache();
});

afterAll(async () => {
	await sql.unsafe(
		`DELETE FROM matrix_test WHERE section_tipo = 'test3' AND section_id BETWEEN $1 AND $2`,
		[SCRATCH_MIN, SCRATCH_MAX],
	);
	await sql.unsafe(
		`DELETE FROM matrix_time_machine WHERE section_tipo = 'test3' AND section_id BETWEEN $1 AND $2`,
		[SCRATCH_MIN, SCRATCH_MAX],
	);
	const left = (await sql.unsafe(
		`SELECT
			(SELECT count(*)::int FROM matrix_test
			  WHERE section_tipo = 'test3' AND section_id BETWEEN $1 AND $2) AS rows,
			(SELECT count(*)::int FROM matrix_time_machine
			  WHERE section_tipo = 'test3' AND section_id BETWEEN $1 AND $2) AS tm`,
		[SCRATCH_MIN, SCRATCH_MAX],
	)) as { rows: number; tm: number }[];
	// Fail loud: a surviving scratch row poisons the next run's pre-count.
	expect(left[0]?.rows).toBe(0);
	expect(left[0]?.tm).toBe(0);
	clearTermCache();
});

// ---------------------------------------------------------------------------
// getTermByLocator — section_map `term` scope
// ---------------------------------------------------------------------------

describe('getTermByLocator — term resolution', () => {
	test('resolves the section_map term component in the requested lang', async () => {
		// test3's thesaurus scope declares term = 'test52'; test3/1 holds it in lg-eng.
		const value = await getTermByLocator({ section_tipo: 'test3', section_id: 1 }, 'lg-eng');
		expect(value).toBe('input text content of one');
	});

	test('main-lang fallback: an lg-spa read of test3/1 still returns the ENGLISH value', async () => {
		// test3/1 has no lg-spa test52; test3's hierarchy main lang resolves to
		// lg-eng, so the chain's main-lang rung supplies the value. This is
		// the case that makes test3/1 useless for contrasting the two resolvers.
		const value = await getTermByLocator({ section_tipo: 'test3', section_id: 1 }, 'lg-spa');
		expect(value).toBe('input text content of one');
	});

	test('test3/27 in lg-spa returns its stored value', async () => {
		const value = await getTermByLocator({ section_tipo: 'test3', section_id: 27 }, 'lg-spa');
		expect(value).toBe('El dos');
	});

	test('project-lang rung: test3/27 in lg-eng resolves its lg-spa value', async () => {
		// lg-eng missing, main lang (lg-eng) missing, lg-nolan missing ⇒ the
		// project langs in config order supply lg-spa.
		expect(config.menu.projectsDefaultLangs).toContain('lg-spa');
		const value = await getTermByLocator({ section_tipo: 'test3', section_id: 27 }, 'lg-eng');
		expect(value).toBe('El dos');
	});

	test('the chain STOPS at the project langs: a value only in a non-project lang is EMPTY', async () => {
		expect(config.menu.projectsDefaultLangs).not.toContain(FOREIGN_LANG);
		const locator = { section_tipo: 'test3', section_id: ID_FOREIGN };
		expect(await getTermByLocator(locator, 'lg-eng')).toBe('');
		// …and the read is not failing: in its own lang the value is there.
		expect(await getTermByLocator(locator, FOREIGN_LANG)).toBe('Only Klingon');
	});

	test('a section with no term tipos falls back to the legacy locator STRING', async () => {
		// dd64 (si/no) has no section_map term; the fallback must carry the
		// optional decoration keys in order.
		expect(
			await getTermByLocator(
				{ section_tipo: 'dd64', section_id: 1, component_tipo: 'test88', tag_id: 3 },
				'lg-eng',
			),
		).toBe('dd64_1_test88_3');
		expect(await getTermByLocator({ section_tipo: 'dd64', section_id: 1 }, 'lg-eng')).toBe(
			'dd64_1',
		);
		expect(
			await getTermByLocator({ section_tipo: 'dd64', section_id: 1, tag_id: 7 }, 'lg-eng'),
		).toBe('dd64_1_7');
	});

	test('a non-string section_tipo returns null (not a string, not a throw)', async () => {
		expect(
			await getTermByLocator({ section_tipo: undefined, section_id: 1 } as never, 'lg-eng'),
		).toBeNull();
		expect(await getTermByLocator({ section_id: 1 } as never, 'lg-eng')).toBeNull();
	});
});

describe('getTermByLocator — cache discipline', () => {
	test('the cache key includes the LANG: a cached lg-eng miss never leaks into another lang', async () => {
		const locator = { section_tipo: 'test3', section_id: ID_FOREIGN };
		// Seed the cache with the empty English result…
		expect(await getTermByLocator(locator, 'lg-eng')).toBe('');
		// …then read the record's own lang FROM CACHE. A lang-less key would serve '' here.
		expect(await getTermByLocator(locator, FOREIGN_LANG, true)).toBe('Only Klingon');
		// and the English entry is still the cached one.
		expect(await getTermByLocator(locator, 'lg-eng', true)).toBe('');
	});

	test('fromCache=false re-reads the record; fromCache=true serves the stale entry', async () => {
		const locator = { section_tipo: 'test3', section_id: ID_RENAME };
		expect(await getTermByLocator(locator, 'lg-eng')).toBe('ORIGINAL');

		await seedTest3(ID_RENAME, { test52: [{ lang: 'lg-eng', value: 'RENAMED' }] });

		// Cached read: deliberately stale — the cache is content-keyed, not
		// write-through, which is exactly why invalidateNode exists.
		expect(await getTermByLocator(locator, 'lg-eng', true)).toBe('ORIGINAL');
		// Uncached read sees the new value and REWRITES the entry.
		expect(await getTermByLocator(locator, 'lg-eng', false)).toBe('RENAMED');
		expect(await getTermByLocator(locator, 'lg-eng', true)).toBe('RENAMED');

		await seedTest3(ID_RENAME, { test52: [{ lang: 'lg-eng', value: 'ORIGINAL' }] });
	});

	test('invalidateNode evicts every lang/scope entry of ONE node and nothing else', async () => {
		const target = { section_tipo: 'test3', section_id: ID_RENAME };
		// The neighbour is a SECOND scratch node renamed at the same instant: its
		// cached value is the only way to observe an eviction that is too WIDE.
		// (A neighbour that is not renamed proves nothing — a re-read after an
		// over-broad eviction returns the same string either way.)
		const neighbour = { section_tipo: 'test3', section_id: ID_NEIGHBOUR };

		expect(await getTermByLocator(target, 'lg-eng')).toBe('ORIGINAL');
		expect(await getTermByLocator(target, 'lg-spa')).toBe('ORIGINAL'); // via main lang
		expect(await getTermByLocator(neighbour, 'lg-eng')).toBe('NEIGHBOUR');

		await seedTest3(ID_RENAME, { test52: [{ lang: 'lg-eng', value: 'RENAMED' }] });
		await seedTest3(ID_NEIGHBOUR, { test52: [{ lang: 'lg-eng', value: 'NEIGHBOUR CHANGED' }] });

		// Still stale before the eviction — proves the cache was really populated.
		expect(await getTermByLocator(target, 'lg-eng', true)).toBe('ORIGINAL');

		invalidateNode('test3', ID_RENAME);

		// Every lang/scope entry of the target node is gone…
		expect(await getTermByLocator(target, 'lg-eng', true)).toBe('RENAMED');
		expect(await getTermByLocator(target, 'lg-spa', true)).toBe('RENAMED');
		// …and the neighbour's entry survived: eviction is per-RECORD, not
		// per-section-tipo (that coarser sweep is the save/delete hook's job).
		expect(await getTermByLocator(neighbour, 'lg-eng', true)).toBe('NEIGHBOUR');

		await seedTest3(ID_RENAME, { test52: [{ lang: 'lg-eng', value: 'ORIGINAL' }] });
		await seedTest3(ID_NEIGHBOUR, { test52: [{ lang: 'lg-eng', value: 'NEIGHBOUR' }] });
		await seedTest3(ID_FOREIGN, { test52: [{ lang: FOREIGN_LANG, value: 'Only Klingon' }] });
	});
});

// ---------------------------------------------------------------------------
// getDdoValueByLocator — explicit ddo_map tipo list, WIDER language chain
// ---------------------------------------------------------------------------

describe('getDdoValueByLocator — guards', () => {
	test('an empty tipo list returns the empty string', async () => {
		expect(
			await getDdoValueByLocator({ section_tipo: 'test3', section_id: 1 }, [], ', ', 'lg-eng'),
		).toBe('');
	});

	test('a missing/empty section_tipo or section_id returns the empty string', async () => {
		expect(await getDdoValueByLocator({ section_id: 1 }, ['test52'], ', ', 'lg-eng')).toBe('');
		expect(
			await getDdoValueByLocator({ section_tipo: '', section_id: 1 }, ['test52'], ', ', 'lg-eng'),
		).toBe('');
		expect(await getDdoValueByLocator({ section_tipo: 'test3' }, ['test52'], ', ', 'lg-eng')).toBe(
			'',
		);
		expect(
			await getDdoValueByLocator(
				{ section_tipo: 'test3', section_id: '' },
				['test52'],
				', ',
				'lg-eng',
			),
		).toBe('');
		expect(
			await getDdoValueByLocator(
				// the runtime `sectionId === null` guard has no reachable typed form.
				{ section_tipo: 'test3', section_id: null as unknown as number },
				['test52'],
				', ',
				'lg-eng',
			),
		).toBe('');
	});
});

describe('getDdoValueByLocator — the SAME language chain', () => {
	test('both doors share ONE chain: test3/27 in lg-eng resolves through each', async () => {
		const locator = { section_tipo: 'test3', section_id: 27 };
		expect(await getDdoValueByLocator(locator, ['test52'], ', ', 'lg-eng')).toBe('El dos');
		expect(await getTermByLocator(locator, 'lg-eng')).toBe('El dos');
		// …and both STOP at the project langs (no any-non-empty tail).
		const foreign = { section_tipo: 'test3', section_id: ID_FOREIGN };
		expect(await getDdoValueByLocator(foreign, ['test52'], ', ', 'lg-eng')).toBe('');
		expect(await getTermByLocator(foreign, 'lg-eng')).toBe('');
	});

	test('lg-nolan step: a translatable component stored under lg-nolan resolves in lg-eng', async () => {
		expect(
			await getDdoValueByLocator(
				{ section_tipo: 'test3', section_id: ID_NOLAN },
				['test52'],
				', ',
				'lg-eng',
			),
		).toBe('Nolan stored');
	});

	test('project-lang rung: a value stored only under another project lang renders', async () => {
		expect(config.menu.projectsDefaultLangs).toContain('lg-fra');
		expect(
			await getDdoValueByLocator(
				{ section_tipo: 'test3', section_id: ID_ANY },
				['test52'],
				', ',
				'lg-eng',
			),
		).toBe('Seulement en français');
	});

	test('NON-translatable components read lg-nolan ONLY — no fallback of any kind', async () => {
		// test208 (component_email) is not translatable. A value stored under
		// lg-eng is invisible: PHP sets fallback_value only for translatable
		// components, so the whole chain is skipped.
		expect(
			await getDdoValueByLocator(
				{ section_tipo: 'test3', section_id: ID_NOTRANS_ENG },
				['test208'],
				', ',
				'lg-eng',
			),
		).toBe('');
		// The same component under lg-nolan resolves — proving the case above is
		// the fallback being refused, not the read failing.
		expect(
			await getDdoValueByLocator(
				{ section_tipo: 'test3', section_id: ID_NOTRANS_NOLAN },
				['test208'],
				', ',
				'lg-eng',
			),
		).toBe('nolan@example.org');
	});
});

describe('getDdoValueByLocator — joining', () => {
	test('empty fragments are dropped: no leading, trailing or doubled separator', async () => {
		// test3/27 has test52 but no test17.
		expect(
			await getDdoValueByLocator(
				{ section_tipo: 'test3', section_id: 27 },
				['test52', 'test17'],
				' | ',
				'lg-eng',
			),
		).toBe('El dos');
		// …and the same with the empty one FIRST.
		expect(
			await getDdoValueByLocator(
				{ section_tipo: 'test3', section_id: 27 },
				['test17', 'test52'],
				' | ',
				'lg-eng',
			),
		).toBe('El dos');
	});

	test('two non-empty fragments join with the caller separator in tipo order', async () => {
		const locator = { section_tipo: 'test3', section_id: ID_TWO_FRAGMENTS };
		expect(await getDdoValueByLocator(locator, ['test52', 'test17'], ' | ', 'lg-eng')).toBe(
			'Alpha | Beta',
		);
		clearTermCache();
		// Order follows the tipo list, not the stored key order…
		expect(await getDdoValueByLocator(locator, ['test17', 'test52'], ' | ', 'lg-eng')).toBe(
			'Beta | Alpha',
		);
		clearTermCache();
		// …and the default separator is ', ' (section_map::DEFAULT_FIELDS_SEPARATOR).
		expect(await getDdoValueByLocator(locator, ['test52', 'test17'])).toBe('Alpha, Beta');
	});

	test('an unknown tipo contributes nothing rather than throwing', async () => {
		expect(
			await getDdoValueByLocator(
				{ section_tipo: 'test3', section_id: ID_TWO_FRAGMENTS },
				['test52', 'nosuchtipo999'],
				' | ',
				'lg-eng',
			),
		).toBe('Alpha');
	});
});

describe('getDdoValueByLocator — cache', () => {
	test('the cache key includes the lang and the tipo list, and invalidateNode clears it', async () => {
		const locator = { section_tipo: 'test3', section_id: ID_RENAME };
		expect(await getDdoValueByLocator(locator, ['test52'], ', ', 'lg-eng')).toBe('ORIGINAL');

		await seedTest3(ID_RENAME, { test52: [{ lang: 'lg-eng', value: 'RENAMED' }] });

		// This resolver has no fromCache flag — it ALWAYS serves the cache.
		expect(await getDdoValueByLocator(locator, ['test52'], ', ', 'lg-eng')).toBe('ORIGINAL');
		// A different lang is a different key, so it reads through to the DB…
		expect(await getDdoValueByLocator(locator, ['test52'], ', ', 'lg-spa')).toBe('RENAMED');
		// …and so is a different tipo list.
		expect(await getDdoValueByLocator(locator, ['test52', 'test17'], ', ', 'lg-eng')).toBe(
			'RENAMED',
		);

		invalidateNode('test3', ID_RENAME);
		expect(await getDdoValueByLocator(locator, ['test52'], ', ', 'lg-eng')).toBe('RENAMED');

		await seedTest3(ID_RENAME, { test52: [{ lang: 'lg-eng', value: 'ORIGINAL' }] });
	});
});
