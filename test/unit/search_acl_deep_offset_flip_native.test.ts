/**
 * PURE-ACL deep-page ORDER FLIP (sql_assembler.ts cachedBrowseTotal).
 *
 * A non-admin paging a DENSE projects-gated section used to pay a plain deep
 * OFFSET: every skipped row re-checks the lossy `relation @> …` containment
 * (measured 490-740 ms per edit-mode page on a 453 k-row section, vs 2-30 ms
 * for the admin, whose unfiltered browse already flipped). The flip now also
 * covers the browse whose WHERE is EXACTLY the caller's projects filter, its
 * row total read from the full_count path's own scoped cache key.
 *
 * What this pins, behaviourally:
 *  - for shallow / middle / far-half / last / last-partial offsets, in the
 *    default order and in explicit section_id ASC and DESC, the acquired page
 *    equals the plain `ORDER BY section_id … LIMIT OFFSET` ground truth;
 *  - a far-half page really flips (small inner OFFSET from the other end);
 *  - TWO principals with DIFFERENT projects (different totals) each get their
 *    own total — a total reused across principals shifts the far-half page,
 *    which the ground-truth comparison catches;
 *  - after the paginator's count paint the flip issues NO count statement of
 *    its own (same cache key as full_count).
 *
 * SITUATION (built here, swept here): the `test` TLD's EMPTY gated section
 * `testmint1` (component_filter testmint1013, matrix_test) gets SEED raw rows
 * split across two scratch projects plus rows in no project; two minted
 * non-admin users each hold one project (dd170). Raw INSERT/DELETE fire no
 * save event, so the count caches are evicted by hand around the run.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { config } from '../../src/config/config.ts';
import { encodeForJsonb } from '../../src/core/db/json_codec.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { runWithQueryTap } from '../../src/core/db/query_tap.ts';
import { getComponentFilterTipo } from '../../src/core/ontology/resolver.ts';
import { buildSearchSql } from '../../src/core/search/sql_assembler.ts';
import { fireSaveEvent } from '../../src/core/section_record/save_event.ts';
import { clearUserProjectsCache, type Principal } from '../../src/core/security/permissions.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';

const SECTION = 'testmint1';
const FILTER_TIPO = 'testmint1013';
const TABLE = 'matrix_test';
const LIMIT = 5;
const THRESHOLD = config.ops.searchLateRowLookupOffset;
/** BOTH totals: offset THRESHOLD in the far half AND dense (≥ the 2000-row projects-probe floor, else the sparse CTE path serves the page). */
const SEED = Math.max(THRESHOLD, 500) * 5 + 300;

const USER_A = 931101;
const USER_B = 931102;
const PROJECT_A = 931111;
const PROJECT_B = 931112;
const PRINCIPAL_A: Principal = { userId: USER_A, isGlobalAdmin: false, isDeveloper: false };
const PRINCIPAL_B: Principal = { userId: USER_B, isGlobalAdmin: false, isDeveloper: false };

/** id % 10: 0-4 → project A, 5-8 → project B, 9 → no project (outside both). */
const PROJECT_OF_ROW = `CASE WHEN g % 10 < 5 THEN ${PROJECT_A} WHEN g % 10 < 9 THEN ${PROJECT_B} END`;

const projectLocator = (projectId: number): string =>
	encodeForJsonb({ [FILTER_TIPO]: [{ section_tipo: 'dd153', section_id: String(projectId) }] });

async function sweep(): Promise<void> {
	await sql.unsafe(`DELETE FROM ${TABLE} WHERE section_tipo = $1`, [SECTION]);
	await sql.unsafe('DELETE FROM matrix_users WHERE section_tipo = $1 AND section_id IN ($2, $3)', [
		'dd128',
		USER_A,
		USER_B,
	]);
	clearUserProjectsCache();
	await fireSaveEvent(SECTION); // raw DML fires none: drop the cached totals
}

beforeAll(async () => {
	await assertTestDatabase('search_acl_deep_offset_flip_native');
	await sweep();
	await sql.unsafe(
		`INSERT INTO ${TABLE} (section_tipo, section_id, relation)
		 SELECT $1, g, CASE WHEN g % 10 = 9 THEN NULL ELSE jsonb_build_object($2::text,
		   jsonb_build_array(jsonb_build_object('section_tipo', 'dd153', 'section_id', (${PROJECT_OF_ROW})::text,
		   'type', 'dd151', 'from_component_tipo', $2::text))) END
		 FROM generate_series(1, $3) AS g`,
		[SECTION, FILTER_TIPO, SEED],
	);
	for (const [userId, projectId] of [
		[USER_A, PROJECT_A],
		[USER_B, PROJECT_B],
	] as const) {
		await sql.unsafe(
			'INSERT INTO matrix_users (section_tipo, section_id, relation) VALUES ($1, $2, $3::text::jsonb)',
			[
				'dd128',
				userId,
				encodeForJsonb({
					dd170: [
						{
							id: 1,
							type: 'dd151',
							section_tipo: 'dd153',
							section_id: projectId,
							from_component_tipo: 'dd170',
						},
					],
				}),
			],
		);
	}
	clearUserProjectsCache();
	await fireSaveEvent(SECTION);
}, 60000);

afterAll(async () => {
	await sweep();
});

type Dir = 'ASC' | 'DESC';

/** Ground truth: the plain page, written out independently of the assembler. */
async function plainIds(projectId: number, offset: number, dir: Dir): Promise<number[]> {
	const rows = (await sql.unsafe(
		`SELECT section_id FROM ${TABLE} WHERE section_tipo = $1 AND relation @> $2::text::jsonb
		 ORDER BY section_id ${dir} LIMIT ${LIMIT} OFFSET ${offset}`,
		[SECTION, projectLocator(projectId)],
	)) as { section_id: number }[];
	return rows.map((row) => Number(row.section_id));
}

function sqo(offset: number, dir: Dir | null): never {
	return {
		section_tipo: [SECTION],
		limit: LIMIT,
		offset,
		...(dir === null
			? {}
			: { order: [{ direction: dir, path: [{ component_tipo: 'section_id' }] }] }),
	} as never;
}

async function acquire(principal: Principal, offset: number, dir: Dir | null) {
	const built = await buildSearchSql(sqo(offset, dir), { principal });
	const rows = (await sql.unsafe(built.sql, built.params as (string | number | null)[])) as {
		section_id: number;
	}[];
	return { sql: built.sql, ids: rows.map((row) => Number(row.section_id)) };
}

async function total(projectId: number): Promise<number> {
	const rows = (await sql.unsafe(
		`SELECT count(*)::int AS c FROM ${TABLE} WHERE section_tipo = $1 AND relation @> $2::text::jsonb`,
		[SECTION, projectLocator(projectId)],
	)) as { c: number }[];
	return Number(rows[0]?.c ?? 0);
}

describe('pure-ACL deep-page order flip (real DB, non-admin)', () => {
	test('situation holds: gated section, rewrite enabled, two different totals, rows outside both', async () => {
		expect(await getComponentFilterTipo(SECTION)).toBe(FILTER_TIPO);
		expect(THRESHOLD).toBeGreaterThanOrEqual(0);
		const [a, b] = [await total(PROJECT_A), await total(PROJECT_B)];
		expect(a).toBeGreaterThan(2 * (THRESHOLD + LIMIT)); // offset THRESHOLD is far half for A
		expect(b).toBeGreaterThan(THRESHOLD + LIMIT);
		expect(a).not.toBe(b);
		expect(a + b).toBeLessThan(SEED);
	});

	for (const [label, principal, projectId] of [
		['A', PRINCIPAL_A, PROJECT_A],
		['B', PRINCIPAL_B, PROJECT_B],
	] as const) {
		test(`principal ${label}: every offset/order equals the plain OFFSET page`, async () => {
			const n = await total(projectId);
			const offsets = [
				Math.max(0, THRESHOLD - 1), // shallow, plain
				THRESHOLD, // deep
				Math.floor(n / 2), // crossover
				Math.max(THRESHOLD, n - 20), // far half → flips
				n - LIMIT, // last page → inner OFFSET 0
				n - 2, // last partial page (effLimit clamp)
			];
			for (const dir of [null, 'ASC', 'DESC'] as const) {
				for (const offset of offsets) {
					const got = await acquire(principal, offset, dir);
					expect(got.ids, `${label} ${dir ?? 'default'} @${offset}`).toEqual(
						await plainIds(projectId, offset, dir ?? 'ASC'),
					);
				}
			}
		}, 60000);
	}

	test('a far-half page flips: DESC page from the other end with a small OFFSET', async () => {
		const n = await total(PROJECT_A);
		const offset = n - LIMIT;
		for (const dir of [null, 'ASC'] as const) {
			const got = await acquire(PRINCIPAL_A, offset, dir);
			expect(got.sql).toMatch(/section_id DESC\nLIMIT 5 OFFSET 0\n\) page ON/);
			expect(got.sql).not.toContain(`OFFSET ${offset}`);
		}
	});

	test.skipIf(config.ops.tmCountCacheTtlMs <= 0)(
		'after the paginator count paint, the flip issues no count of its own (same key)',
		async () => {
			const n = await total(PROJECT_A);
			await fireSaveEvent(SECTION); // earlier tests warmed the flip's own entry: start empty
			await buildSearchSql({ section_tipo: [SECTION], full_count: true } as never, {
				principal: PRINCIPAL_A,
			});
			const { result, report } = await runWithQueryTap('deep page', () =>
				acquire(PRINCIPAL_A, n - LIMIT, null),
			);
			expect(result.sql).toContain('OFFSET 0');
			const counted = report.callers.filter((caller) => caller.frames.includes('bare_count'));
			expect(counted).toEqual([]);
		},
	);
});
