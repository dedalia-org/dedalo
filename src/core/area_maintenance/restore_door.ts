/**
 * THE RESTORE DOOR — a DATA restore is a procedure the engine owns (audit
 * 2026-08-26 S-7; the residual of P0-13 that "could not be gated as written").
 *
 * THE DEFECT THIS CLOSES. Until this file the only restore recipe was prose:
 * `pg_restore --clean` with no full read of the artifact, no stop-the-engine
 * step, no `--single-transaction`, no `--exit-on-error`, no exit-status check.
 * `pg_restore` continues past errors by default, so a run whose COPY of one
 * table failed left that table's OLD rows beside restored neighbours — and the
 * result looked exactly like a successful restore from every angle an operator
 * has. A museum's catalogue was one distracted 3am shell session away from a
 * half-restore nobody could detect.
 *
 * WHAT THE DOOR DOES, in order — each phase is a hard gate for the next:
 *
 *  1. VERIFY the artifact with a FULL READ (`verifyBackupArtifact` — since OPS-1
 *     the only question it asks; a read that outruns its budget is refused too):
 *     `--list` exits 0 on an archive cut in half because the TOC sits at the
 *     front; only `pg_restore -f /dev/null` disproves truncation (P0-13,
 *     measured). Anything short of `verified_deep` is `recovery.artifact_unusable`
 *     — BEFORE any statement reaches Postgres.
 *  2. QUIESCE: `pg_stat_activity` on the target must show ZERO foreign
 *     backends, else `recovery.writers_active` naming pid/application_name.
 *     The engine being stopped IS the drain (the door does not stop it: it
 *     cannot swap the database its own pool holds, and a CLI cannot see the
 *     service manager). The door also stamps `maintenance_mode:true` in
 *     ts_state.json, so an engine restarted before the operator has read the
 *     report boots refusing non-superusers.
 *  3. RESTORE INTO A SIDECAR `<db>_restoring_<stamp>`, created empty from
 *     template0, with `--single-transaction --exit-on-error --no-owner
 *     --no-privileges`, exit status checked. A failure DROPS the sidecar and
 *     throws `recovery.restore_failed`: the target was never touched.
 *  4. SWAP by two `ALTER DATABASE … RENAME`: target → `<db>_pre_restore_<stamp>`
 *     (KEPT, unless `dropPrevious`), sidecar → target. Both need zero
 *     connections, which phase 2 guaranteed and every psql of ours is
 *     transient. This is why the door restores into a sidecar rather than into
 *     an emptied target, as PRODUCTION.md §6.1 once prescribed: `dropdb` first
 *     means a failed restore leaves NOTHING, while here it leaves everything.
 *  5. RECONCILE through the registry plan (`core/reconcile/post_restore.ts`),
 *     then WRITE THE JOURNAL `<backupDir>/restores/<stamp>.json`.
 *
 * TWO MODES, decided by ONE comparison — the target against the database the
 * process is configured for (`config.db.database`, the one the shared pool is
 * bound to for the life of the process):
 *
 *  - `restore` (target == configured): all five phases. The plan's registry
 *    definitions run through the pool, and after the swap the pool lands on
 *    the restored data, so running them IS reconciling the restored database.
 *  - `rehearsal` (target != configured, `--database other`): phases 1, 3 and
 *    4 only (phase 2's backend check still guards the rename). NO plan and NO
 *    maintenance stamp: the plan would run through the pool — against the
 *    LIVE database, not the rehearsal target — and its two apply steps would
 *    write there, while the stamp lands in the live `ts_state.json` a running
 *    engine re-reads per request. A rehearsal that flips production into
 *    maintenance mode and repairs its counters is the "live engine + wrong
 *    database" class the door exists to close (reviewer-found, 2026-09-03).
 *    The report says `mode: 'rehearsal'` and `reconcile: null`; the exit code
 *    is 0 on a restored rehearsal.
 *
 * The plan cannot be re-pointed: every registered reconcile is an owner module
 * on the pool, and the pool cannot be handed a descriptor per call. That is
 * why the mode is the rule and not a flag — the alternative (a plan bound to a
 * descriptor) means rewriting every owner's data access, and the rehearsal
 * question is answered by the restore itself (the row counts in the target).
 *
 * WHY THE RECONCILE PHASE IS ALSO A SEAM (an injectable function, default = the
 * registry plan). The gate restores into a SCRATCH database while the pool
 * stays on the suite database; to prove WHEN the plan runs (after the swap,
 * once, never in a rehearsal) it injects a recorder and simulates the
 * production wiring with `configuredDatabase`; a separate leg runs the real
 * default and reads the registry's own run records.
 *
 * ONE CHANNEL. Every statement here ships through psql (`runPsql`) against an
 * explicit descriptor; this file never imports the pool. Two reasons: the pool
 * cannot be pointed at a maintenance database or a sidecar, and a pool
 * connection to the target would itself be the foreign backend phase 2 refuses.
 *
 * WHAT THE DOOR DOES NOT DO — stated, not implied:
 *  - It does not copy MEDIA. Media originals come back from a dated generation
 *    of `deploy/dedalo-tree-backup.sh` (PRODUCTION.md §6.1 step 4); the plan's
 *    `counters_media` step is what makes the restored counters honest about
 *    the files that outlived the backup.
 *  - It does not restore `../private/` or the RAG database (§6.1 steps 1, 3).
 *  - It does not lift maintenance mode: the operator does, after reading the
 *    reconcile report (`held` names the decisions still open).
 *  - It does not prune `<db>_pre_restore_<stamp>`: that is a whole second copy
 *    of the database on the same volume, and dropping it is the operator's
 *    decision (`--drop-previous` at the door, or `DROP DATABASE` later).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { envSnapshot } from '../../config/env.ts';
import { DedaloError } from '../errors/dedalo_error.ts';
import {
	connArgs,
	connFromConfig,
	type DbConnDescriptor,
	runPsqlScript,
} from '../install/pg_exec.ts';
import { type PostRestoreReport, runPostRestore } from '../reconcile/post_restore.ts';
import { setServerState } from '../resolve/server_state.ts';
import {
	type BackupVerdict,
	getBackupDir,
	resolvePgRestore,
	verifyBackupArtifact,
} from './backup.ts';

/** Where a run's journal lands, under the backup directory. */
export const RESTORE_JOURNAL_SUBDIR = 'restores';

/**
 * A Postgres identifier this door is willing to interpolate: lowercase
 * unquoted-identifier grammar, within the 63-byte limit. Every database name
 * the door builds or receives passes this BEFORE it appears in a statement —
 * the grammar is what makes the `"${name}"` interpolations below exact.
 */
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const IDENTIFIER_MAX = 63;

/** A quoted identifier for a name the grammar does not govern (the configured role). */
function quoteIdentifier(name: string): string {
	return `"${name.replace(/"/g, '""')}"`;
}

export interface RestoreDoorOptions {
	/** The custom-format artifact to restore. */
	artifact: string;
	/**
	 * The connection: user/host/port/password, and `database` = the TARGET.
	 * Defaults to the frozen config (the production CLI case). The role needs
	 * CREATEDB (CREATE DATABASE + both RENAMEs require it, or ownership plus it).
	 */
	connection?: DbConnDescriptor;
	/**
	 * The database the admin statements connect THROUGH — never the target
	 * (a RENAME cannot be issued from the database being renamed). `postgres`
	 * by default; `template1` on a cluster that dropped it.
	 */
	maintenanceDatabase?: string;
	/** Drop `<db>_pre_restore_<stamp>` after a successful swap (default: keep). */
	dropPrevious?: boolean;
	/** The journal directory (default `<backupDir>/restores`). */
	journalDir?: string;
	/** Test seam: the pg_restore binary (default `resolvePgRestore()`). */
	pgRestoreBin?: string;
	/** Test seam: phase 5's reconcile (default: the registry plan). Only ever run in `restore` mode. */
	reconcile?: () => Promise<PostRestoreReport>;
	/** Test seam: the run stamp (default: now, `YYYYMMDD_HHMMSS`). */
	stamp?: string;
	/**
	 * Test seam: the database the process (its pool, its ts_state) is configured
	 * for — what the target is compared with to pick the mode. Default: the
	 * frozen config's. A gate sets it to its scratch target to simulate the
	 * production wiring (target == configured) without restoring the suite DB.
	 */
	configuredDatabase?: string;
}

/** `restore` = the configured database (plan + maintenance stamp); `rehearsal` = another one (neither). */
export type RestoreMode = 'restore' | 'rehearsal';

/** The ONE comparison the mode is. */
export function restoreMode(target: string, configuredDatabase: string): RestoreMode {
	return target === configuredDatabase ? 'restore' : 'rehearsal';
}

export interface RestoreDoorReport {
	stamp: string;
	mode: RestoreMode;
	target: string;
	/** The database the process is configured for — the one the plan and the stamp belong to. */
	configured_database: string;
	/** `<db>_pre_restore_<stamp>` when the target existed and was kept; null otherwise. */
	previous: string | null;
	/** True when `dropPrevious` removed the previous database. */
	previous_dropped: boolean;
	sidecar: string;
	artifact: BackupVerdict;
	pg_restore: { bin: string; args: readonly string[]; duration_ms: number };
	/** The plan's report in `restore` mode; null in a rehearsal (the plan did not run). */
	reconcile: PostRestoreReport | null;
	/** True only in `restore` mode: a rehearsal never touches the live ts_state. */
	maintenance_mode_stamped: boolean;
	journal_path: string;
	started_at: string;
	finished_at: string;
}

/** `YYYYMMDD_HHMMSS` — identifier-safe (no dashes), lexically chronological. */
export function restoreStamp(now: Date = new Date()): string {
	const pad = (v: number) => String(v).padStart(2, '0');
	return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/** The three names one run uses, all validated against the identifier grammar. */
export function restoreDatabaseNames(
	target: string,
	stamp: string,
): { target: string; sidecar: string; previous: string } {
	const names = {
		target,
		sidecar: `${target}_restoring_${stamp}`,
		previous: `${target}_pre_restore_${stamp}`,
	};
	for (const [role, name] of Object.entries(names)) {
		if (!IDENTIFIER.test(name) || name.length > IDENTIFIER_MAX) {
			throw new DedaloError('recovery.artifact_unusable', {
				message: `restore door: the ${role} database name '${name}' is not an unquoted lowercase identifier within ${IDENTIFIER_MAX} bytes; refusing before any write`,
				coordinates: { role, name },
			});
		}
	}
	return names;
}

export interface ForeignBackend {
	pid: number;
	application_name: string;
	usename: string;
}

/**
 * Every CLIENT backend on `database` other than the one asking. Postgres's
 * own workers (an autovacuum worker analysing a freshly restored table, a
 * parallel worker) are not writers of ours: `ALTER DATABASE … RENAME` itself
 * signals them away and waits (CountOtherDBBackends), while a client session
 * makes it fail — so a client is what the door refuses on.
 */
export async function foreignBackends(
	admin: DbConnDescriptor,
	maintenanceDatabase: string,
	database: string,
): Promise<ForeignBackend[]> {
	const listed = await runPsqlScript(
		admin,
		`SELECT pid, coalesce(application_name, ''), coalesce(usename, '') FROM pg_stat_activity WHERE datname = '${database}' AND pid <> pg_backend_pid() AND backend_type = 'client backend'`,
		{ flags: ['-tA'], database: maintenanceDatabase },
	);
	if (listed.exitCode !== 0) {
		throw new DedaloError('recovery.restore_failed', {
			message: `restore door: cannot read pg_stat_activity through '${maintenanceDatabase}': ${listed.stderr}`,
			coordinates: { phase: 'quiesce', maintenance_database: maintenanceDatabase },
		});
	}
	return listed.stdout
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line !== '')
		.map((line) => {
			const [pid, application_name, usename] = line.split('|');
			return { pid: Number(pid), application_name: application_name ?? '', usename: usename ?? '' };
		});
}

async function databaseExists(
	admin: DbConnDescriptor,
	maintenanceDatabase: string,
	database: string,
): Promise<boolean> {
	const probe = await runPsqlScript(
		admin,
		`SELECT 1 FROM pg_database WHERE datname = '${database}'`,
		{
			flags: ['-tA'],
			database: maintenanceDatabase,
		},
	);
	if (probe.exitCode !== 0) {
		throw new DedaloError('recovery.restore_failed', {
			message: `restore door: cannot list pg_database through '${maintenanceDatabase}': ${probe.stderr}`,
			coordinates: { phase: 'quiesce', maintenance_database: maintenanceDatabase },
		});
	}
	return probe.stdout.trim() === '1';
}

/** One admin statement through the maintenance database; a failure is the caller's to name. */
async function admin(
	conn: DbConnDescriptor,
	maintenanceDatabase: string,
	statement: string,
): Promise<{ ok: boolean; stderr: string }> {
	const run = await runPsqlScript(conn, statement, { database: maintenanceDatabase });
	return { ok: run.exitCode === 0, stderr: run.stderr };
}

/**
 * Run pg_restore INTO a database. Unlike backup.ts's verification runs this one
 * opens a connection, so it carries the credential the way pg_exec does:
 * PGPASSWORD in the child's environment, never argv.
 */
async function pgRestoreInto(
	bin: string,
	conn: DbConnDescriptor,
	database: string,
	artifact: string,
): Promise<{ exitCode: number; stderr: string; args: string[]; durationMs: number }> {
	const args = [
		'--dbname',
		database,
		...connArgs(conn),
		'--no-owner',
		'--no-privileges',
		'--single-transaction',
		'--exit-on-error',
		artifact,
	];
	const startedAt = Date.now();
	const child = Bun.spawn([bin, ...args], {
		stdin: 'ignore',
		stdout: 'ignore',
		stderr: 'pipe',
		env: {
			...(envSnapshot() as Record<string, string>),
			...(conn.password !== '' ? { PGPASSWORD: conn.password } : {}),
		},
	});
	const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
	return { exitCode, stderr: stderr.trim().slice(-2000), args, durationMs: Date.now() - startedAt };
}

/** The names one run works with, derived once from the target and the stamp. */
interface RestoreNames {
	target: string;
	sidecar: string;
	previous: string;
}

/** Everything a phase needs to reach the cluster. */
interface DoorContext {
	conn: DbConnDescriptor;
	maintenanceDatabase: string;
	names: RestoreNames;
}

async function dropSidecar(ctx: DoorContext): Promise<{ ok: boolean; stderr: string }> {
	return admin(
		ctx.conn,
		ctx.maintenanceDatabase,
		`DROP DATABASE IF EXISTS "${ctx.names.sidecar}" WITH (FORCE)`,
	);
}

/** Phase 1: a full read of the artifact, before any statement reaches Postgres. */
async function verifyPhase(
	artifact: string,
	pgRestoreBin: string | null,
): Promise<BackupVerdict & { bin: string }> {
	if (pgRestoreBin === null) {
		throw new DedaloError('recovery.artifact_unusable', {
			message:
				'restore door: no pg_restore on this host (DEDALO_PG_BIN_PATH, or install the client tools)',
			coordinates: { phase: 'verify', reason: 'unverifiable_no_pg_restore' },
		});
	}
	const verdict = await verifyBackupArtifact(artifact, { pgRestoreBin });
	if (!verdict.verified || verdict.reason !== 'verified_deep') {
		throw new DedaloError('recovery.artifact_unusable', {
			message: `restore door: '${artifact}' is ${verdict.reason}${verdict.detail ? ` (${verdict.detail})` : ''}; nothing was written`,
			coordinates: { phase: 'verify', reason: verdict.reason, artifact },
		});
	}
	return { ...verdict, bin: pgRestoreBin };
}

export function describeBackend(b: ForeignBackend): string {
	return `pid ${b.pid} (${b.usename}${b.application_name ? `, ${b.application_name}` : ''})`;
}

/** Phase 2: zero foreign backends on an existing target, or refuse. Returns whether the target exists. */
async function quiescePhase(ctx: DoorContext): Promise<boolean> {
	const targetExists = await databaseExists(ctx.conn, ctx.maintenanceDatabase, ctx.names.target);
	if (!targetExists) return false;
	const backends = await foreignBackends(ctx.conn, ctx.maintenanceDatabase, ctx.names.target);
	if (backends.length > 0) {
		throw new DedaloError('recovery.writers_active', {
			message: `restore door: '${ctx.names.target}' still has ${backends.length} connection(s): ${backends.map(describeBackend).join(', ')}; nothing was written`,
			coordinates: { phase: 'quiesce', target: ctx.names.target, backends: backends.length },
		});
	}
	return true;
}

/** Phase 3: create the sidecar and pg_restore into it; a failure drops the sidecar and names it. */
async function restoreIntoSidecar(
	ctx: DoorContext,
	pgRestoreBin: string,
	artifact: string,
): Promise<Awaited<ReturnType<typeof pgRestoreInto>>> {
	const created = await admin(
		ctx.conn,
		ctx.maintenanceDatabase,
		`CREATE DATABASE "${ctx.names.sidecar}" TEMPLATE template0 OWNER ${quoteIdentifier(ctx.conn.user)}`,
	);
	if (!created.ok) {
		throw new DedaloError('recovery.restore_failed', {
			message: `restore door: cannot create the sidecar '${ctx.names.sidecar}' (the role needs CREATEDB): ${created.stderr}`,
			coordinates: { phase: 'restore', sidecar: ctx.names.sidecar },
		});
	}
	const restored = await pgRestoreInto(pgRestoreBin, ctx.conn, ctx.names.sidecar, artifact);
	if (restored.exitCode !== 0) {
		const dropped = await dropSidecar(ctx);
		throw new DedaloError('recovery.restore_failed', {
			message: `restore door: pg_restore exited ${restored.exitCode} into the sidecar '${ctx.names.sidecar}' — ${dropped.ok ? 'sidecar dropped' : `sidecar NOT dropped (${dropped.stderr})`}, '${ctx.names.target}' untouched: ${restored.stderr}`,
			coordinates: {
				phase: 'restore',
				sidecar: ctx.names.sidecar,
				exit_code: restored.exitCode,
				sidecar_dropped: dropped.ok ? 'yes' : 'no',
			},
		});
	}
	return restored;
}

/** Phase 4a: park the existing target under its `_pre_restore_` name; a failure drops the sidecar. */
async function parkTarget(ctx: DoorContext): Promise<string> {
	const parked = await admin(
		ctx.conn,
		ctx.maintenanceDatabase,
		`ALTER DATABASE "${ctx.names.target}" RENAME TO "${ctx.names.previous}"`,
	);
	if (!parked.ok) {
		await dropSidecar(ctx);
		throw new DedaloError('recovery.restore_failed', {
			message: `restore door: cannot rename '${ctx.names.target}' to '${ctx.names.previous}' (a connection appeared after the check?): ${parked.stderr}; sidecar dropped, target untouched`,
			coordinates: { phase: 'swap', target: ctx.names.target, sidecar_dropped: 'yes' },
		});
	}
	return ctx.names.previous;
}

/** Phase 4b: the sidecar takes the target's name; on failure the previous name is put back and BOTH are named. */
async function promoteSidecar(ctx: DoorContext, previous: string | null): Promise<void> {
	const promoted = await admin(
		ctx.conn,
		ctx.maintenanceDatabase,
		`ALTER DATABASE "${ctx.names.sidecar}" RENAME TO "${ctx.names.target}"`,
	);
	if (promoted.ok) return;
	// The one window with no clean exit: put the previous name back so the
	// operator finds the database where it was, and name BOTH databases.
	const restoredName =
		previous === null
			? { ok: true, stderr: '' }
			: await admin(
					ctx.conn,
					ctx.maintenanceDatabase,
					`ALTER DATABASE "${previous}" RENAME TO "${ctx.names.target}"`,
				);
	const outcome = restoredName.ok
		? `The previous database is back under '${ctx.names.target}'; the complete restore is still in '${ctx.names.sidecar}'.`
		: `BOTH databases exist: previous as '${previous}', restored as '${ctx.names.sidecar}' — rename by hand (${restoredName.stderr}).`;
	throw new DedaloError('recovery.restore_failed', {
		message: `restore door: the restored sidecar '${ctx.names.sidecar}' could not take the name '${ctx.names.target}': ${promoted.stderr}. ${outcome}`,
		coordinates: {
			phase: 'swap',
			sidecar: ctx.names.sidecar,
			previous: previous ?? '',
			previous_renamed_back: restoredName.ok ? 'yes' : 'no',
		},
	});
}

/** Phase 4c: drop the parked copy when asked; a failure is warned, never fatal (the restore stands). */
async function dropPreviousIfAsked(
	ctx: DoorContext,
	previous: string | null,
	dropPrevious: boolean,
): Promise<boolean> {
	if (previous === null || !dropPrevious) return false;
	const dropped = await admin(ctx.conn, ctx.maintenanceDatabase, `DROP DATABASE "${previous}"`);
	if (!dropped.ok) {
		console.warn(
			`[restore] previous database '${previous}' could NOT be dropped: ${dropped.stderr}`,
		);
	}
	return dropped.ok;
}

/** The options with every default applied — the one place the defaults live. */
interface ResolvedDoor extends DoorContext {
	startedAt: Date;
	stamp: string;
	configuredDatabase: string;
	mode: RestoreMode;
	pgRestoreBin: string | null;
	dropPrevious: boolean;
	reconcile: () => Promise<PostRestoreReport>;
	journalDir: string;
}

function resolveConnection(
	options: RestoreDoorOptions,
): DoorContext & { stamp: string; startedAt: Date } {
	const startedAt = new Date();
	const conn = options.connection ?? connFromConfig();
	const maintenanceDatabase = options.maintenanceDatabase ?? 'postgres';
	if (!IDENTIFIER.test(maintenanceDatabase)) {
		throw new DedaloError('recovery.artifact_unusable', {
			message: `restore door: maintenance database '${maintenanceDatabase}' is not an unquoted identifier`,
			coordinates: { role: 'maintenance', name: maintenanceDatabase },
		});
	}
	const stamp = options.stamp ?? restoreStamp(startedAt);
	return {
		conn,
		maintenanceDatabase,
		names: restoreDatabaseNames(conn.database, stamp),
		stamp,
		startedAt,
	};
}

function resolveDoor(options: RestoreDoorOptions): ResolvedDoor {
	const base = resolveConnection(options);
	const configuredDatabase = options.configuredDatabase ?? connFromConfig().database;
	return {
		...base,
		configuredDatabase,
		mode: restoreMode(base.names.target, configuredDatabase),
		pgRestoreBin: options.pgRestoreBin ?? resolvePgRestore(),
		dropPrevious: options.dropPrevious === true,
		reconcile: options.reconcile ?? runPostRestore,
		journalDir: options.journalDir ?? join(getBackupDir(), RESTORE_JOURNAL_SUBDIR),
	};
}

/** Phase 5's tail: the report, written as the journal `<journalDir>/<stamp>.json`. */
function writeJournal(
	door: ResolvedDoor,
	fields: Omit<
		RestoreDoorReport,
		| 'stamp'
		| 'mode'
		| 'target'
		| 'configured_database'
		| 'sidecar'
		| 'journal_path'
		| 'started_at'
		| 'finished_at'
	>,
): RestoreDoorReport {
	const journalPath = join(door.journalDir, `${door.stamp}.json`);
	const report: RestoreDoorReport = {
		stamp: door.stamp,
		mode: door.mode,
		target: door.names.target,
		configured_database: door.configuredDatabase,
		...fields,
		sidecar: door.names.sidecar,
		journal_path: journalPath,
		started_at: door.startedAt.toISOString(),
		finished_at: new Date().toISOString(),
	};
	mkdirSync(door.journalDir, { recursive: true });
	writeFileSync(journalPath, `${JSON.stringify(report, null, '\t')}\n`);
	return report;
}

/**
 * The door. Throws a typed refusal from the phase that fired; returns the
 * report (also written as the journal) on success.
 */
export async function runRestoreDoor(options: RestoreDoorOptions): Promise<RestoreDoorReport> {
	const door = resolveDoor(options);

	// ── 1. VERIFY: a full read, before any statement reaches Postgres ────────
	const { bin: pgRestoreBin, ...verdict } = await verifyPhase(options.artifact, door.pgRestoreBin);

	// ── 2. QUIESCE: zero foreign backends, or refuse ─────────────────────────
	const targetExists = await quiescePhase(door);
	// The stamp belongs to the configured database's engine: a rehearsal of
	// another database must not flip a running production into maintenance.
	const stampMaintenance = door.mode === 'restore';
	if (stampMaintenance) setServerState({ maintenance_mode: true });

	// ── 3. RESTORE INTO THE SIDECAR ──────────────────────────────────────────
	const restored = await restoreIntoSidecar(door, pgRestoreBin, options.artifact);

	// ── 4. SWAP: two renames, target untouched until the sidecar is complete ─
	const previous = targetExists ? await parkTarget(door) : null;
	await promoteSidecar(door, previous);
	const previousDropped = await dropPreviousIfAsked(door, previous, door.dropPrevious);

	// ── 5. RECONCILE through the plan (restore mode only), then the journal ──
	// In a rehearsal the plan would run through the pool — bound to the
	// configured database, not the target — so it does not run at all.
	const reconcile = stampMaintenance ? await door.reconcile() : null;
	return writeJournal(door, {
		previous: previousDropped ? null : previous,
		previous_dropped: previousDropped,
		artifact: verdict,
		pg_restore: { bin: pgRestoreBin, args: restored.args, duration_ms: restored.durationMs },
		reconcile,
		maintenance_mode_stamped: stampMaintenance,
	});
}
