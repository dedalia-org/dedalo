/**
 * dd_ontology recovery file (UPDATE_PROCESS Phase 2 — the
 * build_database_version widget pair; PHP installer_ontology_manager::
 * build_recovery_version_file / restore_dd_ontology_recovery_from_file).
 *
 * BUILD: materialize the whitelisted-TLD slice table (db/dd_ontology.ts
 * createRecoverySlice), pg_dump ONLY that table, gzip it to the
 * recovery slot (default <private>/db/dd_ontology_recovery.sql.gz — see
 * DEDALO_ONTOLOGY_RECOVERY_PATH and runtime_paths.ts), drop the slice.
 * RESTORE: gunzip (capped — the file is local but the caps are free) and
 * feed psql; this RECREATES the dd_ontology_recovery table in the live DB —
 * it deliberately does NOT overwrite dd_ontology (PHP parity: the merge/swap
 * is a manual operator step).
 * No shell pipelines: pg_dump stdout streams through in-process gzip.
 *
 * ONE AT A TIME, EACH ON ITS OWN FILES (cross-write:r2). Build and restore both
 * DROP/CREATE the one shared `dd_ontology_recovery` table and write next to the
 * one slot, so they run under ONE single-flight lock — a Postgres advisory
 * lock (db/dd_ontology.ts withRecoverySliceLock: per database, across every
 * engine process): a second build or restore is refused "already running",
 * never raced. Every temp file is THIS session's (core/files/temp_path.ts
 * tempPathFor — a fixed `.part` was truncated and renamed by whichever session
 * opened it last, and unlinked by the other's `finally`); a failure removes
 * only its own. The lock holder sweeps the slot's STALE temp siblings (a
 * crashed build's) — only those older than STALE_TEMP_AGE_MS: the lock is per
 * DATABASE, so another installation (or suite lane) sharing the slot's
 * directory may hold its own lock and be writing a FRESH sibling right now;
 * none can still be writing one older than twice its children's deadline.
 *
 * BOUNDED WHILE HOLDING THE LOCK (cross-write:r3). pg_dump and psql run under a
 * DEADLINE (RECOVERY_CHILD_DEADLINE_MS, a caller may pass a tighter one) and
 * pg_dump with `--lock-wait-timeout`: a child waiting on a table lock or a stalled
 * server is KILLED and the call fails — it never holds the single-flight lock
 * forever, refusing every later build and restore "already running".
 */

import {
	createWriteStream,
	existsSync,
	mkdirSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { envSnapshot } from '../../config/env.ts';
import {
	createRecoverySlice,
	dropRecoverySlice,
	type RecoverySliceSwap,
	swapRecoverySliceIntoDdOntology,
	withRecoverySliceLock,
} from '../db/dd_ontology.ts';
import { fsyncDirectory, fsyncFile } from '../files/durable.ts';
import { isTempSibling, tempPathFor } from '../files/temp_path.ts';
import { resolvePgBinary } from '../install/pg_bin.ts';
import { connArgs, connFromConfig, type DbConnDescriptor, runPsql } from '../install/pg_exec.ts';
import { recoveryFileWritePath, resolveRecoveryFilePath } from '../install/runtime_paths.ts';
import { gunzipWithCaps } from './data_io_import.ts';

/** PHP installer whitelist (narrower than config to_preserve_tld). */
export const RECOVERY_PRESERVE_TLDS = [
	'dd',
	'rsc',
	'lg',
	'hierarchy',
	'ontology',
	'ontologytype',
	'test',
] as const;

/**
 * The recovery slot moved OUT of the code tree (2026-08-23, runtime-path
 * census): a code-update tree swap used to carry the pre-update dump away with
 * the old tree — the one file you need after an update went wrong. Default is
 * now `<private>/db/dd_ontology_recovery.sql.gz` (DEDALO_ONTOLOGY_RECOVERY_PATH
 * relocates it); BUILD always writes there, RESTORE reads the effective path,
 * which falls back to a still-existing legacy in-tree file (with a warning)
 * so nobody's last good dump is orphaned. Resolution lives in
 * src/core/install/runtime_paths.ts, next to the census entry that reports it.
 */

/**
 * The bound of one recovery-file child (pg_dump of the slice, psql of its
 * restore). The slice is a few whitelisted tlds of dd_ontology — seconds of work
 * on any installation — so ten minutes is a stall, never a slow dump.
 */
export const RECOVERY_CHILD_DEADLINE_MS = 10 * 60_000;

/**
 * The age past which a temp sibling of the slot is a crashed session's leftover:
 * twice the children's deadline (a live writer's child is killed at one). A
 * caller's deadline is clamped to RECOVERY_CHILD_DEADLINE_MS so this holds.
 */
const STALE_TEMP_AGE_MS = 2 * RECOVERY_CHILD_DEADLINE_MS;

/** A call's deadline: the caller's, never longer than RECOVERY_CHILD_DEADLINE_MS. */
function deadlineOf(options: RecoveryFileOptions): number {
	return Math.min(options.deadlineMs ?? RECOVERY_CHILD_DEADLINE_MS, RECOVERY_CHILD_DEADLINE_MS);
}

/** How long pg_dump waits for the slice table's lock before failing (never forever). */
const PG_DUMP_LOCK_WAIT = '60s';

/** A recovery-file call's bounds: its children's deadline (default and ceiling RECOVERY_CHILD_DEADLINE_MS). */
export interface RecoveryFileOptions {
	deadlineMs?: number;
}

export interface RecoveryFileResponse {
	/** INTERNAL outcome discriminator (never a wire body). */
	ok: boolean;
	msg: string;
	errors: string[];
	file_size?: string;
	/** restoreAndSwapRecoverySlice only: what the swap replaced. */
	swap?: RecoverySliceSwap;
}

/**
 * Stream a byte source through in-process gzip into `path`, honouring
 * backpressure (a multi-hundred-MB dump must not buffer in memory). Resolves
 * only once every byte is in the file AND fsynced (durable.ts fsyncFile) — the
 * caller's rename then publishes durable bytes, and its directory fsync makes
 * the name durable too. REJECTS on any failure of the source, the compressor
 * or the sink (ENOSPC, EACCES, a read-only dir): one `pipeline` owns the three
 * streams, so a failure is never an unhandled stream 'error' (an uncaught
 * throw that killed the server) nor a wait that never settles (a destroyed
 * sink never drains), and the source is cancelled — a pg_dump behind it gets
 * a closed pipe instead of blocking forever. A failed call may leave a partial
 * `path`: the caller owns it (both callers write a `.part` and remove it).
 * Shared with the install seed builder (install/seed_build.ts) — the other
 * pg_dump this engine compresses.
 */
export async function gzipStreamToFile(
	source: AsyncIterable<Uint8Array>,
	path: string,
): Promise<void> {
	await pipeline(Readable.from(source), createGzip(), createWriteStream(path));
	fsyncFile(path);
}

/**
 * SURF-1: rows breaking the identifier grammar are left out of the slice (a
 * recovery file never carries a row its destination refuses) — say so, in one line.
 */
function skippedSliceLines(skipped: readonly string[]): string[] {
	if (skipped.length === 0) return [];
	const named = skipped
		.slice(0, 10)
		.map((tipo) => JSON.stringify(tipo).slice(0, 64))
		.join(', ');
	return [
		`dd_ontology_recovery: ${skipped.length} row(s) left out — they break the identifier grammar (run reconcile ontology_identifiers): ${named}`,
	];
}

/** A fresh, not-yet-ok outcome (every door of this module starts from one). */
function newResponse(): RecoveryFileResponse {
	return { ok: false, msg: '', errors: [] };
}

/** The refusal of a build or restore while another one holds the lock. */
function alreadyRunning(): RecoveryFileResponse {
	const response = newResponse();
	response.msg = 'Error. A recovery-file build or restore is already running';
	response.errors.push(
		'ontology recovery file: another build or restore holds the single-flight lock',
	);
	return response;
}

/** Run `work` holding the recovery single-flight lock (db/dd_ontology.ts), or refuse. */
function withRecoveryLock(
	work: () => Promise<RecoveryFileResponse>,
): Promise<RecoveryFileResponse> {
	return withRecoverySliceLock(work, alreadyRunning);
}

/**
 * Remove the STALE temp siblings of `path` (tempPathFor's `<path>.tmp-<id>`) —
 * a crashed session's leftovers: only one last modified more than
 * STALE_TEMP_AGE_MS ago. Only the LOCK HOLDER calls it, but the lock is per
 * database: a fresh sibling may be another installation's in-flight file, so it
 * is left alone (module header).
 */
function sweepStaleTempSiblings(path: string): void {
	const dir = dirname(path);
	if (!existsSync(dir)) return;
	const prefix = `${basename(path)}.tmp-`;
	const staleBefore = Date.now() - STALE_TEMP_AGE_MS;
	for (const name of readdirSync(dir)) {
		if (!name.startsWith(prefix) || !isTempSibling(name)) continue;
		const sibling = join(dir, name);
		if (modifiedBefore(sibling, staleBefore)) rmSync(sibling, { force: true });
	}
}

/** True when `path` was last modified before `epochMs`; false when it is gone already. */
function modifiedBefore(path: string, epochMs: number): boolean {
	const stat = statSync(path, { throwIfNoEntry: false });
	return stat !== undefined && stat.mtimeMs < epochMs;
}

/**
 * The DEADLINE of one child: SIGKILL it when `deadlineMs` elapses before it
 * exits. Answers whether it fired (read after the child exited). The timer goes
 * with the child.
 */
function killAfter(
	child: { kill(signal?: number | NodeJS.Signals): void; exited: Promise<unknown> },
	deadlineMs: number,
): () => boolean {
	let fired = false;
	const timer = setTimeout(() => {
		fired = true;
		child.kill('SIGKILL');
	}, deadlineMs);
	void child.exited.finally(() => clearTimeout(timer));
	return () => fired;
}

/** The refusal line of a child killed at its deadline. */
function deadlineLine(what: string, deadlineMs: number): string {
	return `${what} exceeded its ${deadlineMs} ms deadline and was killed`;
}

/** Build the recovery file (PHP build_recovery_version_file) — one at a time. */
export function buildRecoveryVersionFile(
	conn: DbConnDescriptor = connFromConfig(),
	outFile: string = recoveryFileWritePath(),
	options: RecoveryFileOptions = {},
): Promise<RecoveryFileResponse> {
	const deadlineMs = deadlineOf(options);
	return withRecoveryLock(() => buildUnderLock(conn, outFile, deadlineMs));
}

/** The build, under the single-flight lock. */
async function buildUnderLock(
	conn: DbConnDescriptor,
	outFile: string,
	deadlineMs: number,
): Promise<RecoveryFileResponse> {
	const response = newResponse();
	try {
		const slice = await createRecoverySlice(RECOVERY_PRESERVE_TLDS);
		response.errors.push(...skippedSliceLines(slice.skipped));
	} catch (error) {
		response.errors.push((error as Error).message);
		response.msg = 'Error. Unable to build the dd_ontology_recovery slice';
		return response;
	}
	// Defect D9 (fixed 2026-08-09): the dump is written to a temp sibling and
	// renamed onto the recovery slot ONLY after pg_dump exits 0 and the sink has
	// closed. Writing straight to outFile destroyed the last good artifact on
	// every failure, and a partial-but-valid gzip restores as a SILENTLY
	// truncated dd_ontology_recovery table. Rename is atomic on the same fs.
	// The sibling is THIS session's (tempPathFor), never a fixed shared name.
	const partFile = tempPathFor(outFile);
	try {
		sweepStaleTempSiblings(outFile);
		// The private-dir slot ('<private>/db/') may not exist on a box whose
		// dump always landed in-tree before; the build creates its parent.
		mkdirSync(dirname(outFile), { recursive: true });
		// The shared transport rule (DB_SOCKET wins) — this used to DROP `-h`
		// when a socket was set, so pg_dump reached libpq's compiled-in default
		// socket instead of the configured one.
		const args = connArgs(conn);
		args.push(
			`--lock-wait-timeout=${PG_DUMP_LOCK_WAIT}`,
			'-t',
			'dd_ontology_recovery',
			conn.database,
		);
		const child = Bun.spawn([resolvePgBinary('pg_dump'), ...args], {
			stdout: 'pipe',
			stderr: 'pipe',
			env: {
				...(envSnapshot() as Record<string, string>),
				...(conn.password !== '' ? { PGPASSWORD: conn.password } : {}),
			},
		});
		const expired = killAfter(child, deadlineMs);
		// A compressor failure rejects (and cancels the child's stdout: pg_dump
		// ends on the closed pipe) — the catch below reports it, `ok` stays false.
		// A kill at the deadline closes stdout: the stream ends, the exit is non-zero.
		await gzipStreamToFile(child.stdout, partFile);
		const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
		if (expired()) {
			response.errors.push(deadlineLine('pg_dump', deadlineMs));
			response.msg = 'Error. pg_dump failed building the recovery file';
			return response;
		}
		if (exitCode !== 0) {
			response.errors.push(`pg_dump failed: ${stderr.trim()}`);
			response.msg = 'Error. pg_dump failed building the recovery file';
			return response;
		}
		// The recovery file is the ontology update's safety net: its bytes were
		// fsynced by the compressor; the rename is made durable here — a power
		// cut after `ok` never leaves an empty or torn file in the slot.
		renameSync(partFile, outFile);
		fsyncDirectory(dirname(outFile));
		response.ok = true;
		response.msg = 'OK. Request done successfully';
		response.file_size = `${statSync(outFile).size} Bytes`;
		return response;
	} catch (error) {
		response.errors.push((error as Error).message);
		response.msg = 'Error. Request failed [build_recovery_version_file]';
		return response;
	} finally {
		// This session's temp file surviving here is a failed build: never a recovery slot.
		rmSync(partFile, { force: true });
		await dropRecoverySlice();
	}
}

/** Restore the slice table from the recovery file (PHP restore twin) — one at a time. */
export async function restoreDdOntologyRecoveryFromFile(
	conn: DbConnDescriptor = connFromConfig(),
	inFile: string = resolveRecoveryFilePath(),
	options: RecoveryFileOptions = {},
): Promise<RecoveryFileResponse> {
	if (!existsSync(inFile)) {
		const response = newResponse();
		response.errors.push('source sql_file do not exists');
		response.msg = 'Error. source sql_file do not exists';
		return response;
	}
	const deadlineMs = deadlineOf(options);
	return withRecoveryLock(() => restoreUnderLock(conn, inFile, deadlineMs));
}

/** The restore, under the single-flight lock. */
async function restoreUnderLock(
	conn: DbConnDescriptor,
	inFile: string,
	deadlineMs: number,
): Promise<RecoveryFileResponse> {
	const response = newResponse();
	// The plain intermediate is THIS session's (a fixed `<file minus .gz>` was
	// overwritten and removed by every concurrent restore's own `finally`).
	const plainBase = inFile.slice(0, -'.gz'.length);
	const plainPath = tempPathFor(plainBase);
	try {
		sweepStaleTempSiblings(plainBase);
		await gunzipWithCaps(inFile, plainPath);
		// The deadline (module header): runPsql SIGKILLs its child when the signal fires.
		const deadline = AbortSignal.timeout(deadlineMs);
		const run = await runPsql(conn, ['-v', 'ON_ERROR_STOP=1', '-f', plainPath], {
			signal: deadline,
		});
		if (deadline.aborted && run.exitCode !== 0) {
			response.errors.push(deadlineLine('psql', deadlineMs));
			response.msg = 'Error. Request failed [restore_dd_ontology_recovery_from_file]';
			return response;
		}
		if (run.exitCode !== 0) {
			response.errors.push(`psql restore failed: ${run.stderr.trim()}`);
			response.msg = 'Error. Request failed [restore_dd_ontology_recovery_from_file]';
			return response;
		}
		response.ok = true;
		response.msg = 'OK. Request done successfully';
		return response;
	} catch (error) {
		response.errors.push((error as Error).message);
		response.msg = 'Error. Request failed [restore_dd_ontology_recovery_from_file]';
		return response;
	} finally {
		rmSync(plainPath, { force: true });
	}
}

/**
 * Restore the recovery file AND swap it into dd_ontology (ontology/ontology_recover.ts)
 * under ONE hold of the single-flight lock: no build or restore of another process can
 * re-create the slice from the live (damaged) dd_ontology between the two. A leftover
 * slice (a crashed or rolled-back earlier run — the plain dump's CREATE TABLE would
 * fail on it) is dropped first; a failed swap drops it again, so a rerun is never stuck.
 */
export async function restoreAndSwapRecoverySlice(
	conn: DbConnDescriptor = connFromConfig(),
	inFile: string = resolveRecoveryFilePath(),
	options: RecoveryFileOptions = {},
): Promise<RecoveryFileResponse> {
	const deadlineMs = deadlineOf(options);
	return withRecoveryLock(async () => {
		await dropRecoverySlice();
		const restored = await restoreUnderLock(conn, inFile, deadlineMs);
		try {
			if (restored.ok) restored.swap = await swapRecoverySliceIntoDdOntology();
			return restored;
		} finally {
			await dropRecoverySlice();
		}
	});
}
