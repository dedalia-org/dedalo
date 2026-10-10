/**
 * install_db_from_default_file (PHP installer_database_manager). Restores the
 * vendored seed dump into an EMPTY database: schema (30+ tables), extensions,
 * functions, indexes, the CORE ontologies (`CORE_ONTOLOGY_TLDS` — nothing else:
 * the seed is core-only, compiled from repo sources by seed_build.ts), the languages
 * thesaurus terms, root user (empty pw), and the default project/profiles. Then,
 * on the default connection, it completes the install's base: the derived search
 * stores (the seed ships them empty), the engine-owned ontology and the core
 * hierarchies.
 *
 * NO TEST FIXTURES. An installation receives no `test` TLD and no test3
 * playground: those belong to the SUITE database, which `bun run test:db:setup`
 * builds through this same door and then adds its fixtures to. Domain
 * ontologies (oh, tch…) are the installer's next step (ontology_install.ts),
 * never part of the restore.
 *
 * Gate: the target DB must be empty (no `matrix_users` table) — a populated DB
 * is never clobbered. The dump is plain-format SQL, gunzipped in-process and fed
 * to psql with ON_ERROR_STOP=1; a nonzero exit is a hard failure (no partial
 * success). PGPASSWORD + -h/-p make it remote-safe.
 */

import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { CORE_ONTOLOGY_TLDS } from '../ontology/core_tlds.ts';
import { SEED_DUMP_PATH } from './paths.ts';
import { connFromConfig, type DbConnDescriptor, runPsql } from './pg_exec.ts';
import { refuseInstall } from './refuse.ts';

/** The step's answer on the ONLY path that returns: restored (every refusal throws). */
export interface DbRestoreResult {
	ok: true;
	msg: string;
}

/** Is the target DB empty (no matrix_users table)? */
async function targetIsEmpty(conn: DbConnDescriptor): Promise<boolean> {
	const probe = await runPsql(conn, ['-tAc', "SELECT to_regclass('public.matrix_users')"]);
	if (probe.exitCode !== 0) {
		// Cannot even query → treat as "not safely empty"; the caller reports it.
		return false;
	}
	// to_regclass returns the relation name when it exists, empty/NULL otherwise.
	return probe.stdout.trim() === '';
}

/**
/** One returned (never thrown) store error as text. */
function errorText(error: unknown): string {
	if (typeof error === 'string') return error;
	return error instanceof Error ? error.message : JSON.stringify(error);
}

/**
 * The default-config half of the restore — everything that writes through the ENGINE'S
 * pool, which is guaranteed to point at the restored database only when no explicit
 * connection was given. Answers the step's sentence.
 *
 * ORDER IS LOAD-BEARING. The seed ships the derived search stores EMPTY
 * (seed_build.ts SEED_EMPTY_STORES), and the relation-index
 * reader THROWS `search.index_unavailable` on an empty store while relation data
 * exists (search_store.ts requireRelationIndex) — so the stores are filled
 * FIRST, through the engine's own door (the one a booting server runs), before
 * any engine write or read can touch them.
 */
async function completeFreshInstall(): Promise<string> {
	// DERIVED SEARCH STORES — per-(store, table) refill of everything the seed
	// restored (db_assets.ts ensureSearchStores). Its errors are RETURNED (a
	// booting server logs and serves); an install whose search stores did not
	// build is not an install that worked, so here they refuse.
	const { ensureSearchStores } = await import('../db/db_assets.ts');
	const stores = await ensureSearchStores();
	if (stores.errors.length > 0) {
		refuseInstall(
			'install.step_failed',
			`Derived search stores could not be built: ${stores.errors.map(errorText).join(' | ')}`,
		);
	}
	// The ENGINE-OWNED ontology (the sections the engine writes — the AI
	// spend ledger): the same idempotent
	// door boot runs, so a fresh install is complete before its first boot
	// (ontology/engine_ontology.ts).
	const { ensureEngineOntology } = await import('../ontology/engine_ontology.ts');
	const engine = await ensureEngineOntology();
	// CORE HIERARCHIES (A7): Languages is ACTIVATED against the terms the seed
	// already ships in matrix_langs — never imported (hierarchy_activate.ts
	// header carries the measurement). Here, in the restore, so every surface
	// that restores the seed (CLI, wizard, install.sh, the suite builder) gets
	// it with no step of its own; a failure fails the restore — an install
	// without its languages thesaurus is not an install that worked (the door
	// itself refuses `install.step_failed`, naming each failed tld).
	const { activateCoreHierarchies } = await import('./hierarchy_activate.ts');
	const core = await activateCoreHierarchies(-1);
	return `Database installed from seed (core ontologies: ${CORE_ONTOLOGY_TLDS.join(', ')}) + derived search stores + engine ontology (${engine.written} records) + core hierarchies activated (${core.activated.join(', ')}) — OK`;
}

/** Restore the seed dump into an empty database. `conn` defaults to config.db. */
/*
 * COVERAGE-EXEMPT (coverage plan §5.2; reason registered in
 * engineering/crap_coverage_exempt.json): a ONE-SHOT install procedure that
 * MUTATES THE MACHINE — config files, a database restore, root credentials, a
 * 126 MB hierarchy import, or a process restart. Blocked by DANGER, not by
 * fixture: the hermetic logic in the same subsystem (deriveLangConfig,
 * installIpAllowed, resolvePgBinary, the hierarchy_meta readers) IS gated
 * (test/unit/tier1_install_native.test.ts).
 */
export async function installDbFromSeed(
	conn?: DbConnDescriptor,
	/** The dump to restore — the vendored seed; a freshly BUILT one in its gate (seed_build_native). */
	seedPath: string = SEED_DUMP_PATH,
): Promise<DbRestoreResult> {
	const connection = conn ?? connFromConfig();

	// Empty-DB gate: never restore over an existing install.
	const reachable = await runPsql(connection, ['-tAc', 'SELECT 1']);
	if (reachable.exitCode !== 0) {
		refuseInstall('install.step_failed', `Database not reachable: ${reachable.stderr}`);
	}
	if (!(await targetIsEmpty(connection))) {
		refuseInstall(
			'install.state_conflict',
			'Database is not empty (matrix_users already exists) — restore refused',
		);
	}

	// Decompress the seed to a temp .sql and restore with `psql -f` — far more
	// robust than streaming ~14 MB through stdin (backpressure/EPIPE). The temp
	// file is always removed.
	const tmpSql = join(tmpdir(), `dedalo_seed_${process.pid}_${Date.now()}.sql`);
	try {
		writeFileSync(tmpSql, gunzipSync(readFileSync(seedPath)));
	} catch (error) {
		rmSync(tmpSql, { force: true });
		refuseInstall(
			'install.step_failed',
			`Cannot read/decompress seed: ${(error as Error).message}`,
			error,
		);
	}
	try {
		const restore = await runPsql(connection, ['-v', 'ON_ERROR_STOP=1', '--quiet', '-f', tmpSql]);
		if (restore.exitCode !== 0) {
			refuseInstall(
				'install.step_failed',
				`Restore failed: ${restore.stderr || 'psql nonzero exit'}`,
			);
		}
		// Default-config path only: the search stores, the engine ontology and
		// the core hierarchies go through the pool, which is guaranteed to point
		// at this DB only when no explicit conn was given.
		if (conn === undefined) return { ok: true, msg: await completeFreshInstall() };
		return {
			ok: true,
			msg: 'Database installed from seed — OK (explicit connection: derived search stores, engine ontology and core hierarchies are not completed here)',
		};
	} finally {
		rmSync(tmpSql, { force: true });
	}
}
