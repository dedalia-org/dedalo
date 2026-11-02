/**
 * A LIST PAINT COSTS ONE COUNT, NOT ONE PER PAINT (PERF-09 + PERF-10).
 *
 * The paginator total is the most expensive statement of an ordinary list
 * paint (a ~2.5 s parallel index-only scan on a 33 M-row section), and it is
 * the same number until the section is written to. The assembler used to serve
 * it from a cache in exactly one case — an UNFILTERED browse of a
 * policy-governed log table — which is the case a curator almost never is in:
 * a NON-ADMIN's projects predicate lands in `whereParts`, so the short-circuit
 * could never fire for them and every single paint re-counted the section.
 *
 * MEASURED BEHAVIOURALLY, never on the implementation: this gate counts the
 * statements the engine actually issues while ASSEMBLING a paint, through the
 * engine's own query tap (db/query_tap.ts). What it pins:
 *  - a second identical paint issues ZERO count statements, for the bare
 *    browse AND for the ACL-scoped one;
 *  - a paint carrying a CLIENT FILTER is never served from the cache (the
 *    total is request-specific and must be counted every time);
 *  - the cache key discriminates by ACL scope — two different rendered
 *    predicates never read each other's total;
 *  - the TTL FLOOR expires a stamp, so an out-of-band writer (a sibling
 *    worker, an importer, psql) cannot be served a stale total forever.
 *
 * SITUATION: the zzscale corpus for the bare browse (a section nothing else in
 * the suite counts, so the first paint is a real cold miss) and the `test`
 * TLD's own playground section for the ACL one. Built here, torn down here.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { config } from '../../src/config/config.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { runWithQueryTap } from '../../src/core/db/query_tap.ts';
import { scopedBrowseCount } from '../../src/core/search/bare_count.ts';
import { browseCountScopeSignature, freshValue } from '../../src/core/search/sql_assembler.ts';
import {
	ZZSCALE_SECTION,
	ZZSCALE_TERM_COMPONENT,
	ZZSCALE_TERM_PREFIX,
	ZZSCALE_TOTAL_RECORDS,
} from '../../src/core/test_data/situations/zzscale_constants.ts';
import {
	dropZzScaleCorpus,
	ensureZzScaleCorpus,
} from '../../src/core/test_data/situations/zzscale_corpus.ts';
import { buildSearchSql } from '../helpers/search_sql.ts';

/** A section that IS project-gated, so a non-admin gets an ACL predicate. */
const ACL_SECTION = 'test3';
const NON_ADMIN = { userId: 931001, isGlobalAdmin: false, isDeveloper: false };

const TTL = config.ops.tmCountCacheTtlMs;

beforeAll(async () => {
	await ensureZzScaleCorpus();
}, 60000);

afterAll(async () => {
	await dropZzScaleCorpus();
});

/**
 * ONE paint's ASSEMBLY, and the statements it cost.
 *
 * The counting statement is the assembler's own — a cached total is returned as
 * a literal and costs nothing, an uncached one is a statement here. The paint's
 * DATA query is issued by the caller afterwards and is not part of this budget.
 */
async function assemble(
	sectionTipo: string,
	options: Record<string, unknown> = {},
	extra: Record<string, unknown> = {},
): Promise<{ sql: string; params: unknown[]; statements: number }> {
	const { result, report } = await runWithQueryTap('list paint', async () =>
		buildSearchSql(
			{ section_tipo: [sectionTipo], full_count: true, ...extra } as never,
			options as never,
		),
	);
	return { sql: result.sql, params: result.params, statements: report.count };
}

/** Run an assembled query and sum its full_count rows. */
async function run(built: { sql: string; params: unknown[] }): Promise<number> {
	const rows = (await sql.unsafe(built.sql, built.params as (string | number | null)[])) as {
		full_count: number | string;
	}[];
	return rows.reduce((sum, row) => sum + Number(row.full_count), 0);
}

describe.skipIf(TTL <= 0)(
	'the browse count is paid once per write (skipped when TM_COUNT_CACHE_TTL_MS=0, the exact-count parity setting)',
	() => {
		test('the tap really sees statements (a vacuous zero cannot pass)', async () => {
			const { report } = await runWithQueryTap('control', async () => {
				await sql.unsafe('SELECT count(*) AS c FROM matrix_test WHERE section_tipo = $1', [
					ZZSCALE_SECTION,
				]);
			});
			expect(report.count).toBe(1);
		});

		test('BARE browse: the first paint counts, the second issues ZERO statements', async () => {
			const first = await assemble(ZZSCALE_SECTION);
			expect(first.statements).toBeGreaterThan(0);
			expect(await run(first)).toBe(ZZSCALE_TOTAL_RECORDS);
			const second = await assemble(ZZSCALE_SECTION);
			expect(second.statements).toBe(0);
			expect(second.sql).toBe(first.sql);
			expect(second.sql).toMatch(/^SELECT \d+::int AS full_count;$/);
		});

		test('ACL-SCOPED browse: the non-admin paint is cached too (PERF-10)', async () => {
			const first = await assemble(ACL_SECTION, { principal: NON_ADMIN });
			expect(first.statements).toBeGreaterThan(0);
			const second = await assemble(ACL_SECTION, { principal: NON_ADMIN });
			expect(second.statements).toBe(0);
			expect(second.sql).toBe(first.sql);
			expect(second.sql).toMatch(/^SELECT \d+::int AS full_count;$/);
		});

		test('the ACL paint is NOT the bare paint (the scope really narrows)', async () => {
			const scoped = await assemble(ACL_SECTION, { principal: NON_ADMIN });
			const bare = await assemble(ACL_SECTION);
			expect(await run(bare)).toBeGreaterThan(await run(scoped));
		});

		test('a CLIENT-FILTERED count is never served from the cache', async () => {
			const filter = {
				$and: [
					{
						q: ZZSCALE_TERM_PREFIX,
						path: [{ section_tipo: ZZSCALE_SECTION, component_tipo: ZZSCALE_TERM_COMPONENT }],
					},
				],
			};
			const first = await assemble(ZZSCALE_SECTION, {}, { filter });
			const second = await assemble(ZZSCALE_SECTION, {}, { filter });
			// The total is request-specific: it stays a real counting query, paid
			// by the caller on EVERY paint — never a cached literal.
			for (const built of [first, second]) {
				expect(built.sql).toContain('count(');
				expect(built.sql).not.toMatch(/^SELECT \d+::int AS full_count;$/);
			}
			expect(await run(first)).toBeGreaterThan(0);
		});

		test('the cache KEY discriminates by ACL scope', async () => {
			// Two different rendered predicates with deliberately different answers:
			// a key that ignored the scope would serve the first to the second.
			const a = await scopedBrowseCount(
				'matrix_test',
				ZZSCALE_SECTION,
				'scope-A',
				'SELECT 11 AS c',
				[],
			);
			const b = await scopedBrowseCount(
				'matrix_test',
				ZZSCALE_SECTION,
				'scope-B',
				'SELECT 22 AS c',
				[],
			);
			expect([a, b]).toEqual([11, 22]);
			// and scope-A is really cached (the query would answer 99 now)
			expect(
				await scopedBrowseCount('matrix_test', ZZSCALE_SECTION, 'scope-A', 'SELECT 99 AS c', []),
			).toBe(11);
		});

		test('the KEY is a function of the BOUND VALUES, not just the predicate text', () => {
			// The rendered WHERE carries `$1` placeholders, so two principals with
			// different project grants render IDENTICAL text and differ only in
			// what is bound. A key built from the text alone would serve one
			// curator's total to another — the ACL leak this half exists to stop.
			const text = ['m.section_tipo = $1', '(m.relation @> $2::jsonb)'];
			const a = browseCountScopeSignature(text, ['test3', '{"dd153":[{"section_id":10}]}']);
			const b = browseCountScopeSignature(text, ['test3', '{"dd153":[{"section_id":20}]}']);
			expect(a).not.toBe(b);
			// same text AND same values ⇒ the same paint
			expect(browseCountScopeSignature(text, ['test3', 'x'])).toBe(
				browseCountScopeSignature([...text], ['test3', 'x']),
			);
			// and the predicate text still matters
			expect(browseCountScopeSignature(['other'], ['test3', 'x'])).not.toBe(
				browseCountScopeSignature(text, ['test3', 'x']),
			);
		});

		test('a non-matrix table is REFUSED, never counted', async () => {
			await expect(
				scopedBrowseCount('pg_class', ZZSCALE_SECTION, 'scope-X', 'SELECT 1 AS c', []),
			).rejects.toThrow(/refusing non-matrix table/);
		});
	},
);

/**
 * Verdict-cache reads and the ones NOT wrapped in the floor.
 *
 * `uniqueSectionKeyCache` is EXEMPT with its own reason: it caches a SCHEMA
 * property (whether a table carries a UNIQUE (section_id, section_tipo) index),
 * which no data event can change — a floor there would re-probe pg_index for
 * nothing.
 */
const FLOOR_EXEMPT_CACHES: ReadonlySet<string> = new Set(['uniqueSectionKeyCache']);

function unflooredCacheReads(source: string): { reads: number; unfloored: string[] } {
	const unfloored: string[] = [];
	let reads = 0;
	for (const match of source.matchAll(/(\w+Cache)\.get\(/g)) {
		const name = match[1] as string;
		if (FLOOR_EXEMPT_CACHES.has(name)) continue;
		reads += 1;
		const before = source.slice(Math.max(0, (match.index as number) - 11), match.index as number);
		if (before !== 'freshValue(') unfloored.push(name);
	}
	return { reads, unfloored };
}

describe('the TTL floor (PERF-09)', () => {
	test('a stamp older than the floor is NOT served', () => {
		expect(freshValue({ value: 7, at: Date.now() })).toBe(TTL > 0 ? 7 : undefined);
		expect(freshValue({ value: 7, at: Date.now() - TTL - 1 })).toBeUndefined();
		expect(freshValue(undefined)).toBeUndefined();
	});

	test('CENSUS: EVERY verdict cache in the assembler is read through the floor', () => {
		// The save-event eviction is exact for writes THIS process sees and blind
		// to every other one, so a reader that skipped the floor could serve a
		// stale verdict for the life of the process. Derived from the source, with
		// a floor: two caches carry a verdict today (projects density, section
		// total); the schema-property cache is deliberately NOT one.
		const source = readFileSync('src/core/search/sql_assembler.ts', 'utf8');
		expect(unflooredCacheReads(source).reads).toBeGreaterThan(1);
		expect(unflooredCacheReads(source).unfloored).toEqual([]);
	});

	test('POSITIVE CONTROL: an unfloored read IS reported', () => {
		const planted =
			'const a = freshValue(projectsDensityCache.get(k));\nconst b = sectionTotalCache.get(k);';
		expect(unflooredCacheReads(planted).unfloored).toEqual(['sectionTotalCache']);
	});
});
