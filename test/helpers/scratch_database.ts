/**
 * CRASH TEARDOWN for per-process scratch DATABASES — the sweep-on-entry every
 * install-suite gate runs before creating its own `<prefix><pid>` database.
 *
 * WHY A SWEEP AT ALL. `afterAll` is not a guarantee: a SIGKILL, a crashed
 * runner or a shard killed by the parent skips it entirely, and the scratch
 * database then outlives the process that made it. MEASURED 2026-08-25 on this
 * cluster: `dedalo_install_p4_48373` — 218 MB of seeded install left behind by
 * a P4 run whose pid 48373 was long gone — on a volume with ~39 GB free, and
 * leaking N times faster under N parallel shards. Teardown is therefore
 * two-sided: every DROP the gates issue is `DROP DATABASE IF EXISTS … WITH
 * (FORCE)` (the cluster is Postgres 18.4), so a lingering backend cannot turn
 * "database is being accessed by other users" into a silent leak on the way
 * out; and `beforeAll` calls this sweep, because only a sweep on ENTRY
 * recovers from a kill — the killed process runs no code at all.
 *
 * ONE IMPLEMENTATION. This began as four byte-identical copies in the four
 * install-suite gates (install_e2e, install_db_restore, install_hierarchy_tools,
 * ontology_ingest — the lane that wrote them named the duplication as the
 * defect the same day). The grammar below is load-bearing safety, so it lives
 * once: a fix to the escaping or the pid check must never need to be made four
 * times.
 *
 * THE SWEEP IS DELIBERATELY NARROW, AND REFUSES RATHER THAN GUESSES:
 *  - it matches only the CALLER'S OWN prefix, with the literal `_` escaped —
 *    in SQL LIKE `_` is a single-character wildcard, so an unescaped pattern
 *    reaches far past its intent;
 *  - it only accepts a suffix that parses as a bare positive pid
 *    (`^[1-9][0-9]*$`); a name that matches the prefix but not that grammar is
 *    left alone and NAMED on stderr — widening a sweep to "everything that
 *    looks like ours" is how a sweep eats a database it did not create;
 *  - it never drops the running process's own database, and never drops a pid
 *    that still answers signal 0 (EPERM counts as alive: the process exists,
 *    it just is not ours to signal).
 *
 * WHAT THIS DOES NOT PROVE. It does not prove teardown ran — nothing asserted
 * from inside a process that was killed ever could. It reclaims the disk on
 * the NEXT run of the SAME gate (each gate sweeps only its own prefix, so none
 * of them cleans up after the others; an orphan from a gate that is never
 * re-run is never swept — a cross-prefix janitor is a named open follow-up).
 * Pids are reused, so an orphan whose number has since been handed to a live
 * process is deliberately kept until that process exits. And it says nothing
 * about scratch DIRECTORIES under the system temp dir, which have the same
 * crash-teardown hole and their own leak.
 *
 * NOT in test_db_marker's write-seam inventory by construction: this file
 * issues no DML against any table — it only lists `pg_database` and drops
 * whole scratch databases whose name passes the grammar above. The suite
 * database can never match: it carries no `<prefix><pid>` name.
 */

import { type DbConnDescriptor, runPsql } from '../../src/core/install/pg_exec.ts';
import { escapeLikePattern } from './regex_escape.ts';

/** True when `pid` still names a live process (EPERM = alive, just not ours). */
export function pidIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as { code?: string }).code === 'EPERM';
	}
}

/**
 * Drop every `<prefix><dead pid>` database left by a run that never reached
 * its `afterAll`. Conservative by construction — see the header. Callers run
 * this in `beforeAll`, after their own Postgres probe succeeded and before
 * their own CREATE DATABASE.
 */
export async function sweepOrphanScratchDatabases(
	admin: DbConnDescriptor,
	prefix: string,
	options: {
		/**
		 * A gate whose scratch database SPAWNS derived names (the restore door's
		 * `<db>_restoring_<stamp>` / `<db>_pre_restore_<stamp>`) names the grammar
		 * of what may follow the pid; the pid itself is still the ownership proof.
		 * Absent, nothing may follow the pid (the historical grammar).
		 */
		derivedSuffix?: RegExp;
	} = {},
): Promise<void> {
	// In LIKE, `_` matches ANY single character: escape the literal underscores
	// so the pattern cannot reach past the caller's own prefix.
	const pattern = `${escapeLikePattern(prefix)}%`;
	const listed = await runPsql(admin, [
		'-tAc',
		`SELECT datname FROM pg_database WHERE datname LIKE '${pattern}'`,
	]);
	if (listed.exitCode !== 0) return;
	const names = listed.stdout
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	for (const name of names) {
		const suffix = name.slice(prefix.length);
		const parsed = /^([1-9][0-9]*)(.*)$/.exec(suffix);
		const derived = parsed?.[2] ?? '';
		if (
			parsed === null ||
			(derived !== '' &&
				(options.derivedSuffix === undefined || !options.derivedSuffix.test(derived)))
		) {
			console.warn(
				`[UNCOVERED] scratch sweep REFUSES "${name}": the part after "${prefix}" ` +
					`("${suffix}") is not a bare pid${options.derivedSuffix ? ' (or a pid plus a declared derived suffix)' : ''}, so this gate cannot know it made it. ` +
					'Nothing dropped — remove it by hand if it is yours.',
			);
			continue;
		}
		const pid = Number(parsed[1]);
		if (pid === process.pid) continue; // our own database, not an orphan
		if (pidIsAlive(pid)) continue; // a live sibling shard still owns it
		// The name is identifier-quoted AND validated against ^prefix[1-9][0-9]*$
		// above — that grammar is what keeps this interpolation safe. Anyone
		// loosening the regex reopens it.
		const dropped = await runPsql(admin, ['-c', `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`]);
		console.warn(
			dropped.exitCode === 0
				? `[sweep] dropped orphaned scratch database "${name}" (pid ${pid} is gone)`
				: `[sweep] FAILED to drop orphaned scratch database "${name}": ${dropped.stderr.trim()}`,
		);
	}
}
