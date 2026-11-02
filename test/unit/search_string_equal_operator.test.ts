/**
 * The single '=' EXACT-MATCH operator (WC-014, TS-BEYOND-PHP, owner-directed
 * 2026-07-09): '=Ea' matches ONLY the records whose value equals 'Ea'
 * (accent/case-insensitive) — PHP has no single '=' operator (it strips the
 * '=' and runs contains), so short names ('Ea', 'Ye', 'Ibi') drowned in
 * 1000+ contains-matches and could never be picked in the autocomplete.
 *
 * These cases assert TS ground truth (SQL EXISTS twins), NOT PHP equality —
 * running '=' against the oracle would (and should) diverge. The '==' and
 * quoted-literal shapes keep their prior semantics (both engines agree there;
 * pinned in ts_search/sqo differentials).
 *
 * Fixture: the SYNTHETIC workhorse hierarchy (src/core/test_data/
 * synthetic_hierarchy_fixture.ts, replaced the real Spain toponymy
 * 2026-08-25 — the DATA property here is a DISTRIBUTION, never a country's
 * place names): for each probe name exactly ONE branch term equals it while
 * HUNDREDS of generated leaves CONTAIN it (~(N-4)/3 + 1 per probe, ~433 at
 * the shipped volume — the drowning the '=' operator exists to fix, at
 * fixture scale). Ground truth is re-derived in-test, never hardcoded.
 */

import { beforeAll, describe, expect, test } from 'bun:test';
import { sanitizeClientSqo } from '../../src/core/concepts/sqo.ts';
import { sql } from '../../src/core/db/postgres.ts';
import {
	SYNTHETIC_HIERARCHY_A_TLD,
	SYNTHETIC_PROBE_TERMS,
} from '../../src/core/test_data/synthetic_hierarchy_constants.ts';
import { buildSearchSql } from '../helpers/search_sql.ts';

const SECTION = `${SYNTHETIC_HIERARCHY_A_TLD}1`;
const TERM = 'hierarchy25';

async function runCount(q: string): Promise<number> {
	const sqo = sanitizeClientSqo(
		structuredClone({
			section_tipo: [SECTION],
			limit: 10,
			offset: 0,
			full_count: true,
			filter: {
				$and: [{ q, path: [{ section_tipo: SECTION, component_tipo: TERM }], q_split: true }],
			},
		}),
	);
	const { sql: builtSql, params } = await buildSearchSql(sqo, {});
	const rows = (await sql.unsafe(builtSql, params as (string | number | null)[])) as {
		full_count: number | string;
	}[];
	return rows.reduce((sum, row) => sum + Number(row.full_count), 0);
}

async function groundTruthExact(term: string): Promise<number> {
	const rows = (await sql.unsafe(
		`SELECT count(*)::int AS c FROM matrix_hierarchy
		 WHERE section_tipo = $1 AND EXISTS (
			SELECT 1 FROM jsonb_array_elements(COALESCE(string->$2, data->$2)) e
			WHERE f_unaccent(e->>'value') = f_unaccent($3))`,
		[SECTION, TERM, term],
	)) as { c: number }[];
	return rows[0]?.c as number;
}

let dbReady = false;
beforeAll(async () => {
	try {
		await sql`SELECT 1`;
		dbReady = true;
	} catch {
		dbReady = false; // no shared DB on this machine — cases skip honestly
	}
});

describe("string '=' exact operator (WC-014)", () => {
	test('=<short name> matches exactly the ground-truth set, not contains', async () => {
		if (!dbReady) return;
		for (const name of SYNTHETIC_PROBE_TERMS) {
			const truth = await groundTruthExact(name);
			expect(
				truth,
				`no ${SECTION} term equals '${name}' — the synthetic hierarchy fixture is missing its probe branches. Rebuild: bun run test:db:setup`,
			).toBeGreaterThan(0);
			expect(await runCount(`=${name}`)).toBe(truth);
			// the whole point: plain contains is orders of magnitude wider
			expect(await runCount(name)).toBeGreaterThan(truth);
		}
	}, 30000);

	test("'=' alone contributes nothing (no crash)", async () => {
		if (!dbReady) return;
		const unfiltered = await runCount('*'); // not-empty envelope as a baseline
		expect(typeof unfiltered).toBe('number');
		const sqo = sanitizeClientSqo(
			structuredClone({
				section_tipo: [SECTION],
				limit: 10,
				offset: 0,
				full_count: true,
				filter: {
					$and: [
						{ q: '=', path: [{ section_tipo: SECTION, component_tipo: TERM }], q_split: true },
					],
				},
			}),
		);
		const { sql: builtSql } = await buildSearchSql(sqo, {});
		expect(typeof builtSql).toBe('string'); // dropped leaf, valid SQL
	});

	test("'==' and quoted-literal exact shapes are unchanged (same result as '=')", async () => {
		if (!dbReady) return;
		const probe = SYNTHETIC_PROBE_TERMS[0] as string;
		const viaEq = await runCount(`=${probe}`);
		expect(await runCount(`==${probe}`)).toBe(viaEq);
		expect(await runCount(`'${probe}'`)).toBe(viaEq);
	});
});
