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

import { describe, expect, test } from 'bun:test';
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

/** caseInsensitive: '=' (lower both sides); otherwise '==' (case-sensitive). */
async function groundTruthExact(term: string, caseInsensitive = true): Promise<number> {
	const cmp = caseInsensitive
		? `lower(f_unaccent(e->>'value')) = lower(f_unaccent($3))`
		: `f_unaccent(e->>'value') = f_unaccent($3)`;
	const rows = (await sql.unsafe(
		`SELECT count(*)::int AS c FROM matrix_hierarchy
		 WHERE section_tipo = $1 AND EXISTS (
			SELECT 1 FROM jsonb_array_elements(COALESCE(string->$2, data->$2)) e
			WHERE ${cmp})`,
		[SECTION, TERM, term],
	)) as { c: number }[];
	return rows[0]?.c as number;
}

describe("string '=' exact operator (WC-014)", () => {
	test('=<short name> matches exactly the ground-truth set, not contains', async () => {
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

	test("'=' ignores letter case: '=ea' finds 'Ea' (WC-014)", async () => {
		for (const name of SYNTHETIC_PROBE_TERMS) {
			const truth = await groundTruthExact(name);
			expect(truth).toBeGreaterThan(0);
			expect(await runCount(`=${name.toLowerCase()}`)).toBe(truth);
			expect(await runCount(`=${name.toUpperCase()}`)).toBe(truth);
		}
	}, 30000);

	test("'==' and quoted literal stay CASE-SENSITIVE (import lookups rely on it)", async () => {
		const probe = SYNTHETIC_PROBE_TERMS[0] as string;
		const sensitive = await groundTruthExact(probe, false);
		expect(sensitive).toBeGreaterThan(0);
		expect(await runCount(`==${probe}`)).toBe(sensitive);
		expect(await runCount(`'${probe}'`)).toBe(sensitive);
		// a case-only variant: '==' finds only what equals it byte-for-case
		const lower = probe.toLowerCase();
		expect(await runCount(`==${lower}`)).toBe(await groundTruthExact(lower, false));
		expect(await runCount(`'${lower}'`)).toBe(await groundTruthExact(lower, false));
		expect(await runCount(`=${lower}`)).toBe(await groundTruthExact(lower));
	});

	test("'!=' is the complement of '=' whatever the letter case", async () => {
		const all = await runCount('*'); // records holding a value
		for (const name of SYNTHETIC_PROBE_TERMS) {
			const lower = name.toLowerCase();
			const equal = await runCount(`=${lower}`);
			expect(equal).toBeGreaterThan(0);
			// every probe record holds ONE term value, so the two sets partition `all`
			expect(await runCount(`!=${lower}`)).toBe(all - equal);
		}
	}, 30000);
});
