/**
 * THE TARGET DATABASE MUST BE FRESH — the run's database refusals as sentences
 * (T1-P08, TODO-050): exists, no seed restore on it, EMPTY, and stampable by
 * the install role. ONE function, two callers: the run (executor.ts
 * assertFreshTarget — under the install lock, the authority) and the Database
 * screen (probes.ts databaseProbe — read-only, before the Review), so a
 * non-empty or foreign database is said where its name is typed, in the run's
 * own words. Pure (the measure is db_restore.ts inspectTargetDatabase's).
 * Gate: test/unit/install_existing_install_native.test.ts.
 */

import type { TargetDatabaseState } from './db_restore.ts';

/** Every reason `target` cannot take a fresh install, in the run's order (none: it can). */
export function freshTargetProblems(db: string, target: TargetDatabaseState): string[] {
	if (!target.exists) return [`database '${db}' must exist first`];
	const problems: string[] = [];
	if (target.seedRestoreRunning !== null) {
		problems.push(
			`a seed restore into '${db}' is still running (backend pid ${target.seedRestoreRunning})`,
		);
	}
	if (!target.emptyForInstall) {
		problems.push(
			`database '${db}' is not empty (${target.userObjectCount} objects, e.g. ${target.userObjects.slice(0, 5).join(', ')}) — the installer only installs into an empty database`,
		);
	}
	// The seed stamps the database (COMMENT ON DATABASE — owner only): what lets a
	// resume and --abort prove the database is this install's. Refused before
	// any write, not by a rolled-back restore later.
	if (!target.canStamp) {
		problems.push(
			`the install role does not own database '${db}' — create it with OWNER set to the install user (CREATE DATABASE ${db} OWNER <db user>)`,
		);
	}
	return problems;
}
