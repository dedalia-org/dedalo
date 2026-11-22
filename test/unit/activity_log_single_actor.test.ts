/**
 * The SINGLE-ACTOR invariant of the dd542 activity log (WC-056).
 *
 * The Who search no longer emits jsonb containment; it emits an equality on
 * `relation->'dd543'->0->>'section_id'` / `->>'section_tipo'`, because that is
 * the only shape an index can serve TOGETHER with the list's ("timestamp", id)
 * order — containment cost >300 s for a departed actor on the 32.9M-row mdcat
 * log, the expression 1.1–4.3 ms for every actor class
 * (activity_who_expression_search.test.ts carries the full table).
 *
 * Reading element 0 is exact only while a row carries exactly ONE actor
 * locator. That is not a hopeful assumption — it is how `logActivity` writes,
 * and this gate pins it at the WRITER so the search cannot silently start
 * missing rows if the shape ever changes. A second dd543 locator would be
 * invisible to Who search, and invisible is the dangerous failure: no error,
 * just absent audit rows.
 *
 * (dd545 What is written the same way and is NOT part of the rewrite — it keeps
 * containment, served by the restored `relation` GIN — so it is asserted here
 * only as the shape this file would have to revisit if What ever joins.)
 *
 * Scratch hygiene: writes go to a reserved high section_id range on the real
 * matrix_activity and are deleted in afterAll.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { logActivity } from '../../src/core/api/handlers/activity_log.ts';
import { sql } from '../../src/core/db/postgres.ts';

/**
 * A tipo that is neither empty, nor one of the audit-of-the-audit skips, nor a
 * TM-excluded section (dd655 was the probe until O16-01 made it a skip).
 */
const PROBE_TIPO = 'test3';
const PROBE_USER = 987654321; // no real user — makes the written row findable

interface ActivityRow {
	section_id: number;
	relation: { dd543?: unknown[]; dd545?: unknown[] };
}

async function writtenRows(): Promise<ActivityRow[]> {
	return (await sql.unsafe(
		`SELECT section_id, relation FROM matrix_activity
		 WHERE section_tipo = 'dd542'
		   AND relation->'dd543'->0->>'section_id' = $1
		 ORDER BY id DESC`,
		[String(PROBE_USER)],
	)) as ActivityRow[];
}

afterAll(async () => {
	await sql.unsafe(
		`DELETE FROM matrix_activity
		 WHERE section_tipo = 'dd542' AND relation->'dd543'->0->>'section_id' = $1`,
		[String(PROBE_USER)],
	);
});

describe('logActivity writes exactly one dd543 actor locator (WC-056)', () => {
	test('the written row carries a single, fully-addressed actor', async () => {
		await logActivity({
			userId: PROBE_USER,
			what: 'SAVE',
			tipo: PROBE_TIPO,
			host: '127.0.0.1',
			data: { msg: 'single-actor invariant gate' },
		});

		const rows = await writtenRows();
		expect(rows.length).toBeGreaterThan(0);
		const relation = rows[0]?.relation;

		// THE invariant the Who search's element-0 read depends on.
		expect(Array.isArray(relation?.dd543)).toBe(true);
		expect(relation?.dd543?.length, 'dd543 must be exactly one locator').toBe(1);

		// Both halves present — the emitted predicate binds section_tipo too, so a
		// locator missing either half would drop the clause instead of matching.
		const actor = relation?.dd543?.[0] as Record<string, unknown>;
		// WC-2026-08-10-section-id-int-canonical: the actor address is an INT
		// (activity_log.ts dd543 dropped its String(userId) cast).
		expect(typeof actor.section_id).toBe('number');
		expect(actor.section_id).toBe(PROBE_USER);
		expect(actor.section_tipo).toBe('dd128');

		// dd545 What is single too; it keeps containment (GIN-served) for now.
		expect(relation?.dd545?.length).toBe(1);
	}, 30000);

	test('repeated writes each carry their own single locator (no accumulation)', async () => {
		await logActivity({
			userId: PROBE_USER,
			what: 'SAVE',
			tipo: PROBE_TIPO,
			host: '127.0.0.1',
			data: { msg: 'second write' },
		});
		const rows = await writtenRows();
		expect(rows.length).toBeGreaterThanOrEqual(2);
		for (const row of rows) {
			expect(row.relation.dd543?.length, `section_id ${row.section_id}`).toBe(1);
		}
	}, 30000);
});
