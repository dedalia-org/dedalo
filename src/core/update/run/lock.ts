/**
 * THE UPDATE_RUN LOCK (update audit 2026-10-29, U-31; design §3.1).
 *
 * One PostgreSQL advisory namespace for everything that mutates an install's
 * code, schema, data or shared ontology: the update run takes it for its whole
 * life, and every destructive door (ontology import, data rung, code update or
 * restore, move/reset tools — precondition class `destructive_shared`) takes it
 * for its own duration. Two of them can never interleave, on one process or on
 * two processes sharing the database.
 *
 * A SESSION lock on a reserved connection (an update run spans many
 * transactions and a restart is not one of them), released explicitly — or by
 * PostgreSQL when the session ends, so a killed process never leaves it held.
 * The two-key form keeps the namespace apart from every other advisory key in
 * the engine (engine.ts's single-flight, the online-migration run).
 */

import { sql } from '../../db/postgres.ts';

/** The namespace (first key) of every update-run lock. */
export const UPDATE_RUN_LOCK_NAMESPACE = 7_020_930;
/** The second key: the whole install (one run, or one destructive door, at a time). */
export const UPDATE_RUN_LOCK_KEY = 1;

/** A held lock: release it once; releasing twice is a no-op. */
export interface UpdateRunLock {
	release: () => Promise<void>;
	/**
	 * Is the lock STILL held by its session? A session lock goes with its
	 * connection (a PostgreSQL restart, pg_terminate_backend, a TCP reset): the
	 * run asks before each phase and stops, resumable, when it is gone (review
	 * 2026-10-30 #8). A connection that cannot answer is a lost lock.
	 */
	held?: () => Promise<boolean>;
	/** The holding session's backend pid (diagnostics; the dead-session gate ends exactly it). */
	pid?: number;
}

/**
 * Try to take the install's update lock. Null when another session holds it —
 * the caller refuses, naming what it was about to do; nothing waits.
 */
export async function tryAcquireUpdateRunLock(): Promise<UpdateRunLock | null> {
	const reserved = await sql.reserve();
	let got = false;
	let pid = 0;
	try {
		// The idle holder must never be reaped by the server while a long phase
		// writes on other pool connections (review 2026-10-30 (5) #7): an
		// idle_session_timeout would drop the session — and the lock with it.
		await reserved.unsafe('SET idle_session_timeout = 0');
		await reserved.unsafe('SET idle_in_transaction_session_timeout = 0');
		const [row] = (await reserved.unsafe(
			'SELECT pg_try_advisory_lock($1, $2) AS got, pg_backend_pid() AS pid',
			[UPDATE_RUN_LOCK_NAMESPACE, UPDATE_RUN_LOCK_KEY],
		)) as { got: boolean; pid: number }[];
		got = row?.got === true;
		pid = Number(row?.pid ?? 0);
	} finally {
		if (!got) reserved.release();
	}
	if (!got) return null;
	let held = true;
	return {
		pid,
		held: async () => {
			if (!held) return false;
			try {
				const [row] = (await reserved.unsafe(
					`SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND classid = $1
					   AND objid = $2 AND objsubid = 2 AND pid = pg_backend_pid() AND granted) AS held`,
					[UPDATE_RUN_LOCK_NAMESPACE, UPDATE_RUN_LOCK_KEY],
				)) as { held: boolean }[];
				return row?.held === true;
			} catch {
				return false;
			}
		},
		release: async () => {
			if (!held) return;
			held = false;
			try {
				await reserved.unsafe('SELECT pg_advisory_unlock($1, $2)', [
					UPDATE_RUN_LOCK_NAMESPACE,
					UPDATE_RUN_LOCK_KEY,
				]);
			} catch (error) {
				// The session is gone (a PostgreSQL restart, a terminated backend): it took
				// its session lock with it. A release in a `finally` must never replace
				// the outcome it guards — a run left resumable, a job that completed
				// (review 2026-10-30 (4) #7).
				console.warn('[update lock] unlock on a dead session (the lock went with it):', error);
			} finally {
				reserved.release();
			}
		},
	};
}
