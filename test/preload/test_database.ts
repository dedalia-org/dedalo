/**
 * bun test preload — point the WHOLE SUITE at the dedicated test database.
 *
 * This must be the FIRST preload (bunfig.toml): it rewrites process.env BEFORE any test
 * module imports src/config/config.ts, which freezes the connection at import. The seam is
 * the same one session_db.ts already uses for the session store, the ts_state file and the
 * diffusion job tables — this one just covers the biggest shared surface of all, the DB.
 *
 * WHY. Running the suite against the application's database made the tests depend on that
 * install's data (183 of 2039 unit tests failed on a fresh install, because ~46 files need
 * the `numisdata` ontology that ships in no seed) and let them WRITE to it — a gate once
 * provisioned a scratch ontology node and DELETED a real one (test218) on its way out.
 * Tests get their own database; the app's is not theirs to touch.
 *
 * FAIL LOUD, NOT SILENT — AND NEVER ON THE APP'S DATA. If the test DB does not exist, the
 * DB-backed gates fail with connection errors that look like an engine bug. So we PROBE it
 * here and, when it is missing, say exactly what to run. What we do NOT do is fall back to
 * the configured database: that is the very footgun the WHY above describes (a gate deleting
 * test218 out of a real install), and "your test DB is missing" is not a reason to hand the
 * suite write access to production data. The missing name is set anyway, so a DB-backed gate
 * dies with `database "…_test" does not exist` — the true cause, naming its own fix.
 *
 * The hermetic CI tier has no Postgres at all: the probe fails there too, warns, and the
 * DB-less tripwires run exactly as before.
 *
 * Opt out with DEDALO_TEST_DB_DISABLE=true (runs against the configured DB, as before) —
 * an explicit, typed-out choice to point the suite at your own data, never a default.
 */

import { processEnvValue, readEnv } from '../../src/config/env.ts';
import { type EnvRead, suiteBunSqlTarget, suitePgEndpoint } from '../helpers/suite_pg.ts';
import { SUITE_MEDIA_EXPORT_BASE, suiteLangPins } from '../helpers/suite_posture.ts';
import { testDatabaseName } from '../helpers/test_database.ts';

// Pin the media WEB base to the same-origin relative default for the WHOLE suite
// ('' = unset to the config computation; process.env outranks ../private/.env).
// A developer's .env may point it at their local web server (split-origin dev) —
// but every unit golden and every frozen parity fixture pins the harvest-era
// RELATIVE '/dedalo/media' URL shape, so the suite must never inherit that key.
process.env.DEDALO_MEDIA_WEB_BASE = '';

// SUITE-OWNED SUBSYSTEMS. The DB, the media root and the session store are already
// pinned onto suite surfaces; these two were left aimed at whatever ../private/.env
// configures — i.e. at the DEVELOPER'S INSTALLATION. process.env outranks .env.
//
// No mailbox. With a real DEDALO_SMTP_HOST the mailer skips its 'not configured'
// branch and a unit run OPENS AN SMTP CONNECTION to the developer's mail server.
process.env.DEDALO_SMTP_HOST = '';
// Not a master. A developer machine that plays the official master (the code
// server, the ontology server, the developer channel) keeps those keys in its
// .env, and the suite inherited the ROLE: every "this install is neither
// master" door then answered as one (utils_update_manifest_native, 2026-09-26).
// A gate that needs a master builds it — an explicit config object or its own
// env override — it never borrows the machine's.
process.env.IS_A_CODE_SERVER = 'false';
process.env.IS_AN_ONTOLOGY_SERVER = 'false';
process.env.DEDALO_CODE_SERVER_DEV_CHANNEL = 'false';
process.env.DEDALO_CODE_SERVER_PRERELEASE_CHANNEL = 'false';
// The media export base CI runs with (test/helpers/suite_posture.ts). `??=`, like
// hosted_env.sh's `:=`: a shell export still wins, the developer's .env does not.
process.env.DEDALO_MEDIA_EXPORT_BASE ??= SUITE_MEDIA_EXPORT_BASE;
// The suite's languages (C3-40, test/helpers/suite_posture.ts): the declared
// data-language set the save chokepoint enforces is the suite's, never the one a
// developer's .env declares. A shell export still wins, like the line above.
for (const [key, value] of suiteLangPins((name) => processEnvValue(name) !== undefined)) {
	process.env[key] = value;
}
// NOT PINNED HERE: DEDALO_DIFFUSION_SCHEDULER_ENABLED. Turning dispatch off for
// the whole tier looks tempting (the unit suite does spawn real runner
// subprocesses), but MEASURED it reds 5 gates that legitimately exercise
// dispatch — diffusion_dispatch_gate asserts "enabled by default" as the
// contract itself, and diffusion_actions drives a real spawn end-to-end. A
// gate that must not be raced has to isolate itself, not disarm the engine.

if (process.env.DEDALO_TEST_DB_DISABLE !== 'true') {
	const testDb = testDatabaseName();
	// readEnv, NOT process.env: the raw read sees only the shell, so on an install
	// that keeps DB_NAME in ../private/.env (the normal case) appDb was `undefined`
	// and the guard below — the ONE check stopping the suite from pointing at a real
	// database — could never fire. readEnv also carries the DEDALO_DATABASE_CONN
	// alias itself (src/config/env.ts PHP_KEY_ALIASES), so the `??` chain was
	// redundant as well as misordered.
	const appDb = readEnv('DB_NAME');

	// Never let the "test" DB resolve to the app DB — that is the whole point of the file.
	if (testDb === appDb) {
		// THROW, do not warn. Warning here left DB_NAME naming the APPLICATION
		// database and let the run continue — "refusing to redirect" is exactly the
		// wrong move when the thing you are declining to redirect is already
		// pointed at the app. Only assertTestDatabase() (the marker) then stood
		// between the suite and the developer's records, and it only guards
		// test_data writers, not an arbitrary gate's own INSERT.
		//
		// This is a MISCONFIGURATION, not an absent environment, which is why it
		// throws where the no-Postgres path warns (bunfig.toml documents that
		// distinction: a throw for a missing DB would take down the hermetic tier;
		// a throw for "the suite is aimed at your app" is the point).
		//
		// NOTE this branch was unreachable on any install keeping DB_NAME in
		// ../private/.env until the readEnv fix above, because appDb was undefined.
		// Use DEDALO_TEST_DB_DISABLE=true for the deliberate run-against-my-own-DB case.
		throw new Error(
			`[test-preload] DEDALO_TEST_DATABASE resolves to the APPLICATION database (${testDb}). Refusing to run: the suite would write to your app. Set DEDALO_TEST_DATABASE to a distinct name, or DEDALO_TEST_DB_DISABLE=true if you mean it.`,
		);
	} else {
		const probe = await probeDatabase(testDb);
		const exists = probe !== 'absent';
		if (probe === 'sealed') {
			// ALLOW_CONNECTIONS false = a multi-bin `test:shard` run sealed it as its
			// template. A LIVE run holds the suite run lock, so this process is refused
			// by name a few preloads later (canonical_test3); with no live run the seal
			// is a SIGKILLed run's leftover.
			console.warn(
				`[test-preload] the test database '${testDb}' is SEALED (ALLOW_CONNECTIONS false) by a test:shard run. If that run is still going, wait for it; if it died, lift the seal with:\n    bun run test:shard:sweep`,
			);
		}
		if (exists) {
			// DB_NAME is the key config reads (its alias is DEDALO_DATABASE_CONN); set BOTH so
			// no lookup path can resolve back to the application database.
			// AND PIN THE RESOLVED NAME (2026-08-31). `testDatabaseName()` checks
			// DEDALO_TEST_DATABASE FIRST, so recording the answer here makes the derivation
			// IDEMPOTENT under nesting: a child `bun test` re-deriving from the rewritten
			// DB_NAME would otherwise produce `<app>_test_test`. That is the bug
			// PER_RUN_SEAMS was added to strip around; pinning kills it at the source
			// instead, which is what lets the census hand the child an explicit address.
			process.env.DEDALO_TEST_DATABASE = testDb;
			process.env.DB_NAME = testDb;
			process.env.DEDALO_DATABASE_CONN = testDb;
			console.log(`[test-preload] suite database: ${testDb} (the app DB is untouched)`);
		} else {
			// Missing test DB (or no Postgres at all — the hermetic tier). Point at it
			// ANYWAY: the app database is never the fallback. A DB-backed gate then fails
			// with `database "<testDb>" does not exist` instead of silently reading and
			// WRITING the application's records.
			// Pinned here too (see the branch above): the name a nested run must reuse is
			// the one this process RESOLVED, whether or not the database exists yet.
			process.env.DEDALO_TEST_DATABASE = testDb;
			process.env.DB_NAME = testDb;
			process.env.DEDALO_DATABASE_CONN = testDb;
			console.warn(
				`[test-preload] the test database '${testDb}' does not exist — the DB-backed gates will fail with 'database "${testDb}" does not exist'. The application database is NOT used as a fallback (the suite must never write to it). Harmless on the hermetic (DB-less) tier. Build it with:\n    bun run test:db:setup`,
			);
		}
	}
}

/**
 * Host or unix socket, the same way the engine resolves it: the engine's ONE
 * transport rule (src/config/pg_transport.ts — DB_SOCKET wins, a `/` DB_HOST is
 * a socket directory), asked through test/helpers/suite_pg.ts, which imports
 * only that PURE module. This preload may not import src/core/db/postgres.ts
 * (it builds the pool at module scope, freezing the connection before the env
 * is repointed). A hand copy of the rule that read DB_HOST alone made every
 * socket install answer a confident "the test database does not exist" about a
 * database that was right there (install campaign 3, C3-12).
 */
export function connectionTarget(read: EnvRead = readEnv): ReturnType<typeof suiteBunSqlTarget> {
	return suiteBunSqlTarget(suitePgEndpoint(read));
}

/** Cheap existence probe. Any failure (no Postgres at all — the hermetic tier) ⇒ false. */
/** 'sealed' = present but ALLOW_CONNECTIONS false (a dead sealed test:shard run). */
async function probeDatabase(name: string): Promise<'absent' | 'present' | 'sealed'> {
	try {
		const { SQL } = await import('bun');
		const admin = new SQL({
			// The TS-native spellings are PRIMARY (src/config/config.ts requires
			// DB_HOST/DB_USER/DB_NAME); the DEDALO_*_CONN forms are the PHP-era
			// fallback, which readEnv applies for us. Reading the fallback spellings
			// off process.env — as this did — meant the probe almost never saw the
			// real connection and reported "the test database does not exist" against
			// a perfectly healthy one. A DB_*-only environment is exactly what CI
			// composes, so the wrong answer was about to become the CI default.
			...connectionTarget(),
			username: readEnv('DB_USER'),
			password: readEnv('DB_PASSWORD') || undefined,
			database: 'postgres',
			max: 1,
		});
		const rows = await admin`SELECT datallowconn FROM pg_database WHERE datname = ${name}`;
		await admin.end();
		if (rows.length === 0) return 'absent';
		return rows[0].datallowconn === false ? 'sealed' : 'present';
	} catch {
		return 'absent';
	}
}
