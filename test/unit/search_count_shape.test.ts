/**
 * full_count SELECT shape (sql_assembler::buildSearchSql): count(*) vs
 * count(DISTINCT section_id).
 *
 * Every matrix table carries UNIQUE (section_id, section_tipo), so a
 * single-section count with no join chain scans rows whose section_id is
 * already unique — count(*) is equivalent and unlocks a parallel index-only
 * scan (measured 260k → 1.6k buffers on a 438k-row tipo). DISTINCT remains
 * REQUIRED in exactly two shapes:
 *
 *  1. multi-hop join chains (LEFT JOIN LATERAL unnest) — a record with N
 *     matching locators becomes N joined rows;
 *  2. multi-section — two tipos in one table may share a section_id, so the
 *     count is DISTINCT over the IDENTITY (section_tipo, section_id). PHP's
 *     count(DISTINCT section_id) collapsed them; that was a bug, not parity
 *     (WC-2026-09-24-multi-section-search-identity-dedup).
 */
// Migrated to the generic `test` TLD 2026-08-19 (AGENTS.md hard rules): every
// install tipo was rewritten through src/core/test_data/test_tld_tipo_map.json;
// seed-shipped ontology (dd/rsc/hierarchy/lg) stays and is spelled through `seed()`,
// which keeps it out of the install-TLD census's `<tld><digits>` token grammar.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sanitizeClientSqo } from '../../src/core/concepts/sqo.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { dropTestCorpus, ensureTestCorpus } from '../../src/core/test_data/test_corpus/ensure.ts';
import { buildSearchSql } from '../helpers/search_sql.ts';

/** Seed-shipped ontology, spelled out of the install-TLD census's token grammar. */
const seed = <T extends string, N extends number>(tld: T, id: N): `${T}${N}` => `${tld}${id}`;

/** A thesaurus twin: VIRTUAL over the seed's hierarchy20, so its term is hierarchy25. */
const SECTION = 'test2827';
const SECTION_TWIN = 'test2822';
const TERM = 'hierarchy25';
/**
 * The section the VALUE equivalence is measured on. It must actually hold
 * records or `count(*) === count(DISTINCT section_id)` is 0 === 0 — the gate
 * therefore owns the corpus rows it counts.
 */
const COUNT_SECTION = 'test6099';
const COUNT_TABLE = 'matrix_test';

let dbReady = false;
beforeAll(async () => {
	try {
		await sql`SELECT 1`;
		dbReady = true;
	} catch {
		dbReady = false;
		return;
	}
	await ensureTestCorpus([COUNT_SECTION]);
});

afterAll(async () => {
	if (!dbReady) return;
	expect(await dropTestCorpus([COUNT_SECTION])).toBe(0);
});

describe('full_count SELECT shape', () => {
	// The UNFILTERED browse no longer reaches the SELECT shape at all: it is
	// answered from the save-event-evicted, TTL-floored browse-count cache and
	// returned as a literal (PERF-10, list_count_budget_native). The count(*)
	// vs count(DISTINCT) law this file exists for is asserted on every shape
	// that still emits a counting query — the filtered, UNION and join-chain
	// cases below, which is where the DISTINCT question actually lives.
	test('single section, no filter → the cached browse total, as a literal', async () => {
		const { sql: builtSql, params } = await buildSearchSql({
			section_tipo: [SECTION],
			full_count: true,
		} as never);
		expect(builtSql).toMatch(/^SELECT \d+::int AS full_count;$/);
		expect(params).toEqual([]);
	});

	test('single section, flat (non-join) filter → still plain count(*)', async () => {
		const sqo = sanitizeClientSqo(
			structuredClone({
				section_tipo: [SECTION],
				full_count: true,
				filter: {
					$and: [
						{ q: 'ea', path: [{ section_tipo: SECTION, component_tipo: TERM }], q_split: true },
					],
				},
			}),
		);
		const { sql: builtSql } = await buildSearchSql(sqo, {});
		expect(builtSql).toContain('count(*) as full_count');
		expect(builtSql).not.toContain('count(DISTINCT');
		expect(builtSql).not.toContain('LEFT JOIN LATERAL');
	});

	test('multi-section counts DISTINCT identities (section_tipo, section_id)', async () => {
		const { sql: builtSql } = await buildSearchSql({
			section_tipo: [SECTION, SECTION_TWIN],
			full_count: true,
		} as never);
		expect(builtSql).toContain('count(DISTINCT (mix.section_tipo, mix.section_id))');
		expect(builtSql).not.toContain('count(*) as full_count');
	});

	/** Two-step path rsc197.rsc91 → test2827 term, with the given q. */
	const deepSqo = (q: string) =>
		sanitizeClientSqo(
			structuredClone({
				section_tipo: [seed('rsc', 197)],
				full_count: true,
				filter: {
					$and: [
						{
							q,
							path: [
								{ section_tipo: seed('rsc', 197), component_tipo: seed('rsc', 91) },
								{ section_tipo: SECTION, component_tipo: TERM },
							],
							q_split: true,
						},
					],
				},
			}),
		);

	test('multi-hop NEGATED filter is a NOT EXISTS semi-join → plain count(*)', async () => {
		// '!*' (is empty) on a deep path = "no related record holds a value"
		// (deep_path.ts): a correlated NOT EXISTS, never a join in the main FROM,
		// so there is no fan-out to dedup.
		const { sql: builtSql } = await buildSearchSql(deepSqo('!*'), {});
		expect(builtSql).toContain('NOT EXISTS (SELECT 1 FROM jsonb_array_elements(');
		expect(builtSql).not.toContain('LEFT JOIN LATERAL');
		expect(builtSql).not.toContain('count(DISTINCT');
		expect(builtSql).toContain('count(*) as full_count');
	});

	test('multi-hop REVERSED filter has no fan-out → plain count(*)', async () => {
		// A positive leaf is driven from the leaf through matrix_relation_index
		// (deep_path.ts): no join fragments, one row per record.
		const { sql: builtSql } = await buildSearchSql(deepSqo('ea'), {});
		expect(builtSql).toContain('FROM matrix_relation_index AS ri_');
		expect(builtSql).not.toContain('LEFT JOIN LATERAL');
		expect(builtSql).toContain('count(*) as full_count');
	});

	test('count(*) value equals count(DISTINCT section_id) on a real section', async () => {
		if (!dbReady) return;
		const { sql: builtSql, params } = await buildSearchSql({
			section_tipo: [COUNT_SECTION],
			full_count: true,
		} as never);
		const rows = (await sql.unsafe(builtSql, params as (string | number | null)[])) as {
			full_count: number | string;
		}[];
		const plain = rows.reduce((sum, row) => sum + Number(row.full_count), 0);
		const truth = (await sql.unsafe(
			`SELECT count(DISTINCT section_id)::int AS c FROM ${COUNT_TABLE} WHERE section_tipo = $1`,
			[COUNT_SECTION],
		)) as { c: number }[];
		// Anti-vacuity: 0 === 0 would satisfy the equality without measuring it.
		expect(truth[0]?.c ?? 0).toBeGreaterThan(1);
		expect(plain).toBe(truth[0]?.c as number);
	});
});
