/**
 * SQL IDLE-TIMEOUT CANARY — Bun's `idleTimeout` reaps IDLE connections only, so
 * the maintenance lanes may carry it.
 *
 * HISTORY. On Bun 1.4.2/1.4.3 `idleTimeout` was not an idle-connection reaper:
 * it fired on a connection silent on the wire for N seconds, a statement STILL
 * RUNNING included, and killed it with ERR_POSTGRES_IDLE_TIMEOUT. The
 * maintenance lanes' `idleTimeout: 30` therefore rolled back every statement
 * longer than 30 s — the db_assets index rebuild of
 * matrix_time_machine_history_visible_idx died at exactly 30 s (2026-10-10), and
 * the rule became "no idleTimeout on any pool". Bun 1.4.4 (the pin since
 * 2026-11-02) changed the semantics, this canary's leg A went red as designed,
 * and the rule was revisited: the maintenance lanes carry the reaper again.
 *
 * Three legs:
 *   A. the CANARY, both halves on a private 1 s pool: a silent statement
 *      outlives the timeout (on the pool, inside a transaction, a transaction
 *      idle BETWEEN statements, and a RESERVED connection idle between its
 *      statements), AND an idle pooled connection IS
 *      closed — so the reaper is proven real, not merely harmless. If a Bun
 *      release brings the old semantics back, the first half goes red: drop the
 *      maintenance reaper again (postgres.ts MAINTENANCE_IDLE_TIMEOUT_S);
 *   B. the RULE, measured on the engine's real pools (their options read back
 *      from Bun, not from source text): both maintenance lanes carry the 30 s
 *      reaper, the main pool none;
 *   C. a statement on the maintenance lane that stays silent on the wire
 *      completes (the door the index rebuilds and VACUUM use).
 *
 * Read-only: pg_sleep and pg_stat_activity only, on the suite database the
 * test preload points at.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { poolIdleTimeouts, runWithoutStatementTimeout, sql } from '../../src/core/db/postgres.ts';

/** The connection fields of the engine's own pool, for the canary's private pool. */
function engineConnection(): Record<string, unknown> {
	const options = (sql as unknown as { options: Record<string, unknown> }).options;
	// `path` carries a unix-socket connection (Bun keeps it beside `hostname`).
	const { hostname, port, username, password, database, path } = options;
	return { hostname, port, username, password, database, path };
}

const canary = new SQL({ ...engineConnection(), max: 1, idleTimeout: 1 } as ConstructorParameters<
	typeof SQL
>[0]);

afterAll(async () => {
	await canary.close();
});

/** Above Bun's 5 s per-test default, which bunfig cannot raise: a bare `bun test` of this file must hold. */
const LEG_TIMEOUT_MS = 20_000;

describe('A. canary — Bun idleTimeout spares a running statement and reaps an idle connection', () => {
	test(
		'on the pool: a 2.5 s silent statement under a 1 s timeout completes',
		async () => {
			const outcome = await canary.unsafe('SELECT pg_sleep(2.5)').then(
				() => 'completed',
				(error: Error) => error.message,
			);
			expect(outcome).toBe('completed');
		},
		LEG_TIMEOUT_MS,
	);

	test(
		'inside a transaction: a silent statement, and an idle gap between statements',
		async () => {
			const outcome = await canary
				.begin(async (tx) => {
					await tx.unsafe('SELECT pg_sleep(2.5)');
					await Bun.sleep(2500);
					await tx.unsafe('SELECT 1');
				})
				.then(
					() => 'completed',
					(error: Error) => error.message,
				);
			expect(outcome).toBe('completed');
		},
		LEG_TIMEOUT_MS,
	);

	test(
		'a RESERVED connection idle between statements survives (a session-level holder)',
		async () => {
			// A reserved connection may hold session state across statements (an advisory lock,
			// a cursor): the reaper must never close one its holder has not released.
			const reserved = await canary.reserve();
			try {
				const [first] = (await reserved.unsafe('SELECT pg_backend_pid() AS pid')) as {
					pid: number;
				}[];
				await Bun.sleep(2500);
				const [second] = (await reserved.unsafe('SELECT pg_backend_pid() AS pid')) as {
					pid: number;
				}[];
				expect(Number(second?.pid)).toBe(Number(first?.pid));
			} finally {
				reserved.release();
			}
		},
		LEG_TIMEOUT_MS,
	);

	test(
		'an idle pooled connection IS closed (the reaper is real)',
		async () => {
			const [row] = (await canary.unsafe('SELECT pg_backend_pid() AS pid')) as { pid: number }[];
			const pid = Number(row?.pid);
			const backendAlive = async (): Promise<boolean> => {
				const rows = (await sql.unsafe('SELECT 1 FROM pg_stat_activity WHERE pid = $1', [
					pid,
				])) as unknown[];
				return rows.length > 0;
			};
			expect(await backendAlive()).toBe(true);
			const deadline = Date.now() + 10_000;
			while ((await backendAlive()) && Date.now() < deadline) await Bun.sleep(250);
			expect(await backendAlive()).toBe(false);
		},
		LEG_TIMEOUT_MS,
	);
});

describe('B. rule — the maintenance lanes carry the idle reaper, the main pool none', () => {
	test('main, maintenance and non-transactional lanes', () => {
		// Bun reads back `idleTimeout` normalised to MILLISECONDS (30 s → 30000).
		expect(poolIdleTimeouts()).toEqual({
			main: undefined,
			maintenance: 30_000,
			nonTransactional: 30_000,
		});
	});
});

describe('C. a silent statement on the maintenance lane completes', () => {
	test('pg_sleep through runWithoutStatementTimeout', async () => {
		const rows = (await runWithoutStatementTimeout('SELECT pg_sleep(2.5), 1 AS done')) as {
			done: number;
		}[];
		expect(Number(rows[0]?.done)).toBe(1);
	});
});
