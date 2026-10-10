/**
 * SQL IDLE-TIMEOUT CANARY — no engine pool may carry Bun's `idleTimeout`.
 *
 * THE DEFECT (2026-10-10). The maintenance lanes (src/core/db/postgres.ts) were
 * built with `idleTimeout: 30`, meant as "close a maintenance connection idle
 * for 30 s". Bun's SQL `idleTimeout` is not that: it fires on a connection that
 * has been silent on the wire for N seconds — a statement STILL RUNNING
 * included — and kills it with ERR_POSTGRES_IDLE_TIMEOUT. Every maintenance
 * statement longer than 30 s therefore died; the visible case was the
 * db_assets index rebuild of matrix_time_machine_history_visible_idx, rolled
 * back after exactly 30 s ("Idle timeout reached after 30s").
 *
 * Three legs:
 *   A. the CANARY: Bun's idleTimeout really kills an in-flight statement, both
 *      on the pool and inside a transaction. When a Bun release changes this,
 *      this leg goes red — revisit the rule (an idle-connection reaper would
 *      then be safe) instead of deleting the leg;
 *   B. the RULE, measured on the engine's real pools (their options read back
 *      from Bun, not from source text): main, maintenance and the
 *      non-transactional twin carry no idleTimeout;
 *   C. a statement on the maintenance lane that stays silent on the wire
 *      completes (the door the index rebuilds and VACUUM use).
 *
 * Read-only: pg_sleep only, on the suite database the test preload points at.
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

describe('A. canary — Bun idleTimeout kills a running statement', () => {
	test('on the pool', async () => {
		const outcome = await canary.unsafe('SELECT pg_sleep(2.5)').then(
			() => 'completed',
			(error: Error) => error.message,
		);
		expect(outcome).toContain('Idle timeout');
	});

	test('inside a transaction', async () => {
		const outcome = await canary
			.begin(async (tx) => {
				await tx.unsafe('SELECT pg_sleep(2.5)');
			})
			.then(
				() => 'completed',
				(error: Error) => error.message,
			);
		expect(outcome).toContain('Idle timeout');
	});
});

describe('B. rule — the engine pools carry no idleTimeout', () => {
	test('main, maintenance and non-transactional lanes', () => {
		expect(poolIdleTimeouts()).toEqual({
			main: undefined,
			maintenance: undefined,
			nonTransactional: undefined,
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
