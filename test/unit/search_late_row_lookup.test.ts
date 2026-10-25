/**
 * Late-row-lookup pagination (sql_assembler::buildSearchSql, SEARCH_LATE_ROW_LOOKUP_OFFSET):
 * from the configured offset on, the default-ordered single-section query is
 * rewritten to find the page of section_ids on an index-only scan first and
 * join back for the wide jsonb columns. Identical rows, order and columns —
 * only the SQL shape changes, and ONLY above the threshold (shallow pages and
 * every fixture-replayed shape keep the plain OFFSET query byte-identical).
 *
 * The tests ride the key's DEFAULT (1000): offsets below stay plain, offsets
 * at/above rewrite. The DB-backed case proves row equality against the plain
 * shape written out verbatim.
 */

import { beforeAll, describe, expect, test } from 'bun:test';
import { config } from '../../src/config/config.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { buildSearchSql } from '../../src/core/search/sql_assembler.ts';
import { SYNTHETIC_HIERARCHY_A_TLD } from '../../src/core/test_data/synthetic_hierarchy_constants.ts';

// The synthetic workhorse hierarchy (src/core/test_data/synthetic_hierarchy_fixture.ts):
// its terms section carries max(1300, THRESHOLD+300) generated rows, DERIVED from
// the same config default this file pages at — so a raised default cannot
// silently starve the deep page (the fixture and this gate read the same key).
// Replaced the real Spain hierarchy 2026-08-25: the volume was the need, never
// the toponymy (generic-`test`-TLD law, AGENTS.md hard rules).
const SECTION = `${SYNTHETIC_HIERARCHY_A_TLD}1`;
const THRESHOLD = config.ops.searchLateRowLookupOffset;

let dbReady = false;
beforeAll(async () => {
	try {
		await sql`SELECT 1`;
		dbReady = true;
	} catch {
		dbReady = false;
	}
});

describe('late row lookup SQL shape', () => {
	test('sanity: the default threshold is active (tests ride it)', () => {
		expect(THRESHOLD).toBeGreaterThan(0);
	});

	test('offset 0 → plain query (no rewrite, no OFFSET)', async () => {
		const { sql: builtSql } = await buildSearchSql({
			section_tipo: [SECTION],
			limit: 30,
			offset: 0,
		} as never);
		expect(builtSql).not.toContain('page ON');
		expect(builtSql).not.toContain('OFFSET');
	});

	test('shallow offset (below threshold) → plain OFFSET query', async () => {
		const { sql: builtSql } = await buildSearchSql({
			section_tipo: [SECTION],
			limit: 30,
			offset: THRESHOLD - 1,
		} as never);
		expect(builtSql).not.toContain('page ON');
		expect(builtSql).toContain(`OFFSET ${THRESHOLD - 1}`);
	});

	test('deep offset (at threshold) → late-row-lookup join', async () => {
		const { sql: builtSql } = await buildSearchSql({
			section_tipo: [SECTION],
			limit: 30,
			offset: THRESHOLD,
		} as never);
		expect(builtSql).toContain('JOIN (');
		expect(builtSql).toContain('page ON page.section_id');
		// The page subquery carries the LIMIT/OFFSET; the outer re-orders. On
		// this fixture offset THRESHOLD is a far-half page, so the unfiltered
		// browse ORDER-FLIPS (small mirror OFFSET, section_id DESC inside).
		expect(builtSql).toMatch(/LIMIT 30 OFFSET \d+\n\) page ON/);
		expect(builtSql).toMatch(/ORDER BY\s+\w+\.section_id ASC;$/);
	});

	test('deep offset ordered by the id PK flattens AND rewrites on the id key (WC-046)', async () => {
		// The dd542 Activity list DEFAULTS to `id DESC`. Single-section + unique
		// key ⇒ flattens (no main_select window, no DISTINCT ON), and the id PK is
		// a unique total order ⇒ the deep-page late-lookup/flip rewrites on `id`
		// (was plain OFFSET before WC-046 — the 5 s dd542 deep-page regression).
		const { sql: builtSql } = await buildSearchSql({
			section_tipo: [SECTION],
			limit: 30,
			offset: THRESHOLD,
			order: [{ direction: 'DESC', path: [{ component_tipo: 'id' }] }],
		} as never);
		expect(builtSql).not.toContain('main_select');
		expect(builtSql).not.toContain('DISTINCT ON');
		expect(builtSql).toContain('page ON page.id');
		expect(builtSql).toMatch(/ORDER BY\s+\w+\.id (?:ASC|DESC);$/);
	});

	test('multi-section deep offset keeps the plain shape (no rewrite)', async () => {
		const { sql: builtSql } = await buildSearchSql({
			section_tipo: [SECTION, `${SYNTHETIC_HIERARCHY_A_TLD}4`],
			limit: 30,
			offset: THRESHOLD,
		} as never);
		expect(builtSql).not.toContain('page ON');
		expect(builtSql).toContain(`OFFSET ${THRESHOLD}`);
	});

	test('full_count is untouched by deep offsets (count has no pagination)', async () => {
		const { sql: builtSql } = await buildSearchSql({
			section_tipo: [SECTION],
			full_count: true,
			limit: 30,
			offset: THRESHOLD,
		} as never);
		expect(builtSql).toContain('full_count');
		expect(builtSql).not.toContain('page ON');
		expect(builtSql).not.toContain('OFFSET');
	});

	test('late-lookup rows are IDENTICAL to the plain OFFSET shape', async () => {
		if (!dbReady) return;
		const limit = 25;
		const offset = THRESHOLD + 200;
		const { sql: builtSql, params } = await buildSearchSql({
			section_tipo: [SECTION],
			limit,
			offset,
		} as never);
		expect(builtSql).toContain('page ON'); // proves the rewrite fired
		const late = (await sql.unsafe(builtSql, params as (string | number | null)[])) as Record<
			string,
			unknown
		>[];
		// The pre-rewrite shape, written out verbatim (default order,
		// DEFAULT_SELECT_COLUMNS in assembler order).
		const plain = (await sql.unsafe(
			`SELECT DISTINCT ON (${SECTION}.section_id) ${SECTION}.section_id, ${SECTION}.section_tipo,
			        ${SECTION}.data, ${SECTION}.relation, ${SECTION}.string, ${SECTION}.date, ${SECTION}.iri, ${SECTION}.geo,
			        ${SECTION}.number, ${SECTION}.media, ${SECTION}.misc, ${SECTION}.meta
			 FROM matrix_hierarchy AS ${SECTION}
			 WHERE (${SECTION}.section_tipo = $1::text)
			 ORDER BY ${SECTION}.section_id ASC
			 LIMIT ${limit} OFFSET ${offset}`,
			[SECTION],
		)) as Record<string, unknown>[];
		expect(late.length).toBe(plain.length);
		expect(
			late.length,
			`the synthetic hierarchy ${SECTION} did not page at offset ${offset} — the suite fixture is missing or short (it seeds THRESHOLD+300 rows). Rebuild: bun run test:db:setup`,
		).toBeGreaterThan(0);
		expect(JSON.parse(JSON.stringify(late))).toEqual(JSON.parse(JSON.stringify(plain)));
	});
});
