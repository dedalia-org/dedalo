/**
 * SHARD DATABASE PROVISIONING — clone, marker-rewrite, drop and sweep for the
 * Phase 3 shard runner (scripts/test_shard.ts).
 *
 * WHY CLONES AND NOT A SHARED DATABASE. The co-location census
 * (scripts/lib/test_components.ts, 2026-08-25) measured ONE dominant connected
 * component of 95 test files welded by TLD-wide destructive drops, whole-corpus
 * `ensureTestCorpus()` calls and the canonical test3 rewriters: two concurrent
 * `bun test` processes on ONE database destroy each other's fixtures
 * non-deterministically. Each shard therefore gets its OWN database, cloned
 * from the suite template.
 *
 * WHY `STRATEGY = FILE_COPY` IS EXPLICIT (server measured: Postgres 18.4). The
 * PG15+ default, WAL_LOG, pushes the whole 7.43 GiB template through the WAL —
 * on a volume at 96% capacity that is the difference between a clone and an
 * outage. A physical file copy also never fires the derivation triggers: the
 * 13.9M `matrix_relation_index` and 5.6M `matrix_string_search` derived rows
 * arrive ALREADY DERIVED, which is exactly why engineering/CI.md's objection
 * to a `pg_dump -Fc` cache (a logical restore re-derives everything) does NOT
 * transfer here.
 *
 * THE MARKER REWRITE IS MANDATORY, NOT COSMETIC. A file copy carries the
 * template's `id = 1` marker row naming the TEMPLATE — on the clone that is the
 * 'misrouted' state `readTestDatabaseMarker()` refuses for EVERY test-data
 * write ("a test-database dump restored somewhere it does not belong"), so an
 * unrewritten clone fails the whole DB tier loudly. The rewrite names the table
 * through `TEST_MARKER_TABLE` from the DB-FREE constants module — never the
 * literal, which `test_db_marker_tripwire` rule 5 forbids outside the marker
 * modules — over a SHORT-LIVED psql subprocess, the same shape as
 * scripts/test_db_setup.ts's provenance probe and for the same two reasons:
 * importing the marker module would connect postgres.ts's module-scope pool,
 * and a held session makes the later DROP fail with "being accessed by other
 * users".
 *
 * SWEEP IS A GUARDED PATH, NOT A PATTERN DROP. Re-deriving disposability from
 * a NAME SHAPE is exactly what this codebase closed on 2026-08-25 ("a name is a
 * claim ABOUT a database; this one asks the database itself" —
 * scripts/test_db_setup.ts guard 2). The sweep enumerates candidates with a
 * fully-escaped LIKE (in LIKE, a bare `_` is a single-char wildcard — an
 * unescaped pattern would enumerate NEIGHBOURING databases), then probes EACH
 * candidate's own marker and drops only the ones that say, themselves, that
 * they are disposable AND name THEMSELVES; anything unmarked / wrong-purpose /
 * misrouted is REFUSED AND NAMED, never dropped. Media twins likewise: a
 * directory under the test-media base is removed only when it carries the
 * `.dedalo_test_media` marker.
 *
 * THREE SURFACES PER SHARD, NOT TWO. A shard child also builds a VECTOR
 * database: `test/preload/rag_db.ts` derives it from the child's own `DB_NAME`,
 * so it is `<template>__shard<N>_rag`, created on the spot. The anchored
 * `__shard<N>` grammar cannot see that name, and `test:db:setup` refuses a shard
 * name outright, so nothing would have dropped it: every shard run WOULD have
 * leaked one vector database for ever. Stated in the conditional deliberately —
 * the vector preload and the sweep landed in the SAME change (2026-08-30), so no
 * such database was ever actually left behind, and the reviewer confirmed none
 * exists on this server. The hazard was designed out before it could happen, not
 * observed and repaired. It is swept HERE, with the clone it
 * belongs to, on the SAME guarded path: the twin's name is DERIVED by the same
 * function the preload uses (`suiteRagDatabaseName`, never a re-typed `_rag`
 * tail), the vector server is the store's own (`DEDALO_RAG_DB_*_CONN` may put it
 * on another host), and the DROP is licensed by the twin's own
 * `dedalo_test_rag_marker` row — `dropSuiteRagDatabase` probes it and refuses
 * anything else. The twins land in the SAME `dropped`/`refused` report arrays as
 * the matrix clones, so every caller that already prints or exit-codes on those
 * reports them without a line of new plumbing.
 *
 * WHAT THIS DOES NOT PROVE, stated plainly:
 *  - It does not verify the TEMPLATE is current — a clone of a stale suite
 *    database is faithfully stale. `bun run test:db:setup` owns freshness.
 *  - The backend-termination step kills sessions on the TEMPLATE only (named,
 *    one by one, never the application database); a session opened between the
 *    terminate and the CREATE can still make the clone fail. That failure is
 *    loud (psql non-zero ⇒ throw), not silent.
 *  - `cp -c` (APFS clonefile) is this workstation's media copy; on a
 *    non-APFS volume it falls back to a plain copy and SAYS so.
 *  - An explicit `DEDALO_TEST_RAG_DATABASE` pins ONE vector database name for
 *    every process that inherits it, shards included; the name is then not
 *    derived from the shard and this sweep will NOT drop it (it says so, loudly,
 *    once per sweep). That configuration also means concurrent shards share one
 *    vector index — a collision this module can report but not fix.
 */

import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readEnv } from '../../src/config/env.ts';
// DB-free ON PURPOSE (see that module's header): the marker is named through
// the constant, never the literal (test_db_marker_tripwire rule 5), and never
// through the marker module itself (its postgres.ts import connects the pool
// at module scope — a held session breaks DROP DATABASE).
import {
	TEST_MARKER_PURPOSE,
	TEST_MARKER_TABLE,
} from '../../src/core/test_data/test_database_marker_constants.ts';
import { suitePsqlConnArgs, suitePsqlEnv } from '../../test/helpers/suite_pg.ts';
import {
	TEST_MEDIA_MARKER,
	testMediaBaseDir,
	testMediaRootPath,
} from '../../test/helpers/test_media_root.ts';
// The vector twin's name and its guarded DROP, from the module that owns the
// vector-store connection rule. Safe as a STATIC import, unlike the marker
// writer it reaches dynamically: that module's own imports stop at
// `src/config/env.ts` and the config CATALOG (a frozen data literal), so nothing
// here freezes the configuration before the runner has composed a child
// environment — the ordering law the lazy `psqlBinary()` below exists for.
import {
	dropSuiteRagDatabase,
	listRagDatabases,
	suiteRagDatabaseName,
} from '../../test/helpers/test_rag_database.ts';

/** The reserved suffix grammar: `<template>__shard<N>` (double underscore). */
export const SHARD_SUFFIX_RE = /__shard\d+$/;

export function shardDatabaseName(template: string, shard: number): string {
	return `${template}__shard${shard}`;
}

/**
 * IDEMPOTENT ON THE VALUE, not via a sentinel key. `testDatabaseName()` feeds
 * its own input (explicit seam, else `<DB_NAME>_test`), so composing a shard
 * env on top of an ALREADY-SHARDED env would yield `<base>__shard2__shard2`.
 * The refusal is on the VALUE — a name already carrying the suffix — because a
 * `..._APPLIED` sentinel key is a trap for whoever edits
 * scripts/lib/parity_census.ts's PER_RUN_SEAMS next (that list is where
 * inherited per-run seams are deliberately STRIPPED so a child re-establishes
 * them, and a sentinel would survive the strip while its meaning did not).
 */
export function assertShardableTemplate(template: string): string {
	if (template === '') {
		throw new Error('test_shard_db: the template database name resolved empty — refusing.');
	}
	if (SHARD_SUFFIX_RE.test(template)) {
		throw new Error(
			`test_shard_db: template '${template}' already carries the __shard<N> suffix — this process is itself running inside a shard environment. Re-sharding would derive '${template}__shard2'-style names; refusing.`,
		);
	}
	// Same charset law as scripts/test_db_setup.ts: the name reaches SQL as a
	// double-quoted identifier and the media tree as a path segment. REFUSE
	// rather than escape — escaping is where the next injection lives.
	if (!/^[A-Za-z0-9_.-]+$/.test(template)) {
		throw new Error(
			`test_shard_db: template database name '${template}' contains characters outside [A-Za-z0-9_.-]; it is interpolated into SQL identifiers. Refusing.`,
		);
	}
	return template;
}

// ── psql plumbing (mirrors scripts/test_db_setup.ts) ─────────────────────────

const user = readEnv('DB_USER') ?? readEnv('DEDALO_USERNAME_CONN') ?? '';
const password = readEnv('DB_PASSWORD') ?? readEnv('DEDALO_PASSWORD_CONN') ?? '';

/**
 * `-h/-p` decided by the engine's ONE transport rule (DB_SOCKET wins, a `/`
 * DB_HOST is a socket directory, else TCP; an unset port is 5432) — the route
 * the suite's own pool takes. readEnv already honours the PHP alias spellings.
 * Plus `-w` and a PGCONNECT_TIMEOUT (test/helpers/suite_pg.ts): never a
 * password prompt on the terminal (C3-12).
 */
const conn = suitePsqlConnArgs(readEnv, user);

/**
 * The psql binary, resolved the way the ENGINE resolves it — imported LAZILY
 * and dynamically because pg_bin reads `config.ops.pgBinPath`, and a static
 * import would pull src/config/config.ts in at parse time, freezing the
 * connection AND the media root before the shard runner has composed a single
 * child environment (the exact ordering scripts/test_db_setup.ts is built
 * around).
 */
let resolvedPsql: string | undefined;
async function psqlBinary(): Promise<string> {
	if (resolvedPsql === undefined) {
		const { resolvePgBinary } = await import('../../src/core/install/pg_bin.ts');
		resolvedPsql = resolvePgBinary('psql');
	}
	return resolvedPsql;
}

/** Short-lived psql subprocess; throws on non-zero (ON_ERROR_STOP). */
export async function psql(database: string, args: string[], stdin?: string): Promise<string> {
	const proc = Bun.spawn(
		[await psqlBinary(), ...conn, '-d', database, '-v', 'ON_ERROR_STOP=1', ...args],
		{
			env: suitePsqlEnv(process.env, password),
			stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin),
			stdout: 'pipe',
			stderr: 'pipe',
		},
	);
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) throw new Error(`psql (${database}) exited ${code}: ${err.trim()}`);
	return out;
}

// ── provenance probe (same three-state contract as test_db_setup's guard 2) ──

export type ShardProvenance =
	| { state: 'absent' }
	| { state: 'marked' }
	| { state: 'unmarked' }
	| { state: 'wrong_purpose' }
	| { state: 'misrouted'; markerDatabase: string };

/**
 * Ask a database ITSELF whether it is a disposable test database naming
 * ITSELF. FAIL-CLOSED by shape: a probe that errors throws and aborts; only a
 * successful empty result means 'absent', so a surprise can over-refuse but
 * never over-drop. Values reach SQL as psql variables (:'db', :'purpose') on
 * STDIN — psql interpolates variables only when lexing file/stdin input.
 */
export async function probeProvenance(database: string): Promise<ShardProvenance> {
	const exists = (
		await psql(
			'postgres',
			['-t', '-A', '-v', `db=${database}`, '-f', '-'],
			"SELECT 1 FROM pg_database WHERE datname = :'db'\n",
		)
	).trim();
	if (exists === '') return { state: 'absent' };

	const tablePresent = (
		await psql(database, [
			'-t',
			'-A',
			'-c',
			`SELECT to_regclass('public.${TEST_MARKER_TABLE}') IS NOT NULL`,
		])
	).trim();
	if (tablePresent !== 't') return { state: 'unmarked' };

	const row = (
		await psql(
			database,
			['-t', '-A', '-F', '\t', '-v', `purpose=${TEST_MARKER_PURPOSE}`, '-f', '-'],
			`SELECT (purpose = :'purpose')::text, database_name FROM "${TEST_MARKER_TABLE}" WHERE id = 1\n`,
		)
	).trim();
	if (row === '') return { state: 'unmarked' };
	// Split on the FIRST tab only: database_name is data from a database we do
	// not yet trust, and must not be able to smuggle a field boundary.
	const tab = row.indexOf('\t');
	const purposeMatches = tab === -1 ? row : row.slice(0, tab);
	const markerDatabase = tab === -1 ? '' : row.slice(tab + 1);
	if (purposeMatches !== 'true') return { state: 'wrong_purpose' };
	if (markerDatabase !== database) return { state: 'misrouted', markerDatabase };
	return { state: 'marked' };
}

// ── provisioning ─────────────────────────────────────────────────────────────

/**
 * Terminate live sessions on the TEMPLATE — and ONLY the template, never the
 * application database (`WHERE datname = :'db' AND pid <> pg_backend_pid()`).
 * `CREATE DATABASE … TEMPLATE …` refuses while any other session holds the
 * template. Every backend killed is NAMED in the returned lines, so the
 * scrollback is the audit trail of whose session went away.
 */
export async function terminateTemplateBackends(template: string): Promise<string[]> {
	const out = (
		await psql(
			'postgres',
			['-t', '-A', '-F', ' ', '-v', `db=${template}`, '-f', '-'],
			[
				"SELECT pid::text, coalesce(usename, '?'), coalesce(application_name, '?'),",
				'       pg_terminate_backend(pid)::text',
				"FROM pg_stat_activity WHERE datname = :'db' AND pid <> pg_backend_pid()\n",
			].join('\n'),
		)
	).trim();
	return out === '' ? [] : out.split('\n').map((line) => line.trim());
}

/**
 * Provision one shard clone: drop any stale twin, physically copy the
 * template, rewrite the marker so the clone names ITSELF (see the header), and
 * verify the result probes 'marked'.
 */
export async function provisionShardDatabase(template: string, shard: number): Promise<string> {
	const name = shardDatabaseName(assertShardableTemplate(template), shard);
	const killed = await terminateTemplateBackends(template);
	for (const line of killed) {
		console.log(`[shard-db] terminated template backend: ${line}`);
	}
	await psql('postgres', ['-c', `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`]);
	// FILE_COPY, explicitly — see the header for why the WAL_LOG default is
	// wrong here and why the physical copy sidesteps re-derivation entirely.
	await psql('postgres', [
		'-c',
		`CREATE DATABASE "${name}" TEMPLATE "${template}" STRATEGY = FILE_COPY`,
	]);
	// The clone's marker row still names the TEMPLATE — the 'misrouted' state
	// every test-data writer refuses. Rewrite it to name the clone itself:
	// `current_database()`, NEVER a caller-supplied name, so a provisioner
	// pointed at the wrong database cannot stamp a correct-looking marker onto
	// it (test_db_marker_tripwire rule 7 pins this exact shape).
	const updated =
		(
			await psql(name, [
				'-t',
				'-A',
				'-c',
				`UPDATE "${TEST_MARKER_TABLE}" SET database_name = current_database() WHERE id = 1 RETURNING database_name`,
			])
		)
			.trim()
			// psql prints the RETURNING value AND the command tag ("UPDATE 1") — even
			// under -t -A, because the tag is not a tuple. Comparing the whole output
			// to the name made a SUCCESSFUL rewrite look like a missing marker row:
			// MEASURED as `returned 'dedalo_v7_mht_test__shard2\nUPDATE 1'` on the first
			// real shard run. Take the first line: that is the returned tuple.
			.split('\n')[0]
			?.trim() ?? '';
	if (updated !== name) {
		throw new Error(
			`[shard-db] marker rewrite on '${name}' returned '${updated}' — the clone carries no id=1 marker row to rewrite. Refusing to hand it to a test process; drop it and rebuild the template with 'bun run test:db:setup'.`,
		);
	}
	const provenance = await probeProvenance(name);
	if (provenance.state !== 'marked') {
		throw new Error(
			`[shard-db] freshly provisioned '${name}' probes '${provenance.state}', not 'marked' — refusing to use it.`,
		);
	}
	return name;
}

// ── the sealed template ──────────────────────────────────────────────────────

/**
 * SEAL the template for the length of a multi-bin run: every bin runs on its
 * OWN clone (the base bin included), so nothing has a legitimate reason to
 * touch the template — and with `ALLOW_CONNECTIONS false` nothing CAN. A
 * process that escapes its shard (a spawned grandchild handed a rebuilt env, a
 * helper that re-derives the suite database) then fails LOUDLY on connect
 * instead of silently writing a surface its peers read. This is what replaces
 * pinning spawners to a base bin by source scan: the scan guessed; the seal
 * enforces. Live template sessions are terminated first (named, as in
 * provisioning) so the seal is total from the first file on.
 *
 * Reversible by design: `unsealTemplate` runs in the runner's finally, on the
 * entry sweep and under `--sweep`, so a SIGKILLed run cannot leave a serial
 * `bun test` facing a template that refuses it.
 */
export async function sealTemplate(template: string): Promise<string[]> {
	assertShardableTemplate(template);
	await psql('postgres', ['-c', `ALTER DATABASE "${template}" WITH ALLOW_CONNECTIONS false`]);
	return terminateTemplateBackends(template);
}

/** Lift the seal. Answers whether the template WAS sealed (a dead run's leftover is said out loud). */
export async function unsealTemplate(template: string): Promise<boolean> {
	assertShardableTemplate(template);
	const was = (
		await psql(
			'postgres',
			['-t', '-A', '-v', `db=${template}`, '-f', '-'],
			"SELECT (NOT datallowconn)::text FROM pg_database WHERE datname = :'db'\n",
		)
	).trim();
	if (was !== 'true') return false;
	await psql('postgres', ['-c', `ALTER DATABASE "${template}" WITH ALLOW_CONNECTIONS true`]);
	return true;
}

/**
 * The template's media tree as one comparable string — every path with its
 * size and mtime. The database seal cannot cover the filesystem (a process
 * that resolves the TEMPLATE's media root writes there without a connection),
 * so the runner takes this before and after the run and names any difference
 * as contact. `null` = no tree (a contact would CREATE one — also a difference).
 */
export function templateMediaFingerprint(template: string): string | null {
	return treeFingerprint(testMediaRootPath(template));
}

/** The fingerprint itself, over any root (pure fs; the tripwire drives it on a scratch tree). */
export function treeFingerprint(root: string): string | null {
	if (!existsSync(root)) return null;
	const lines: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
			a.name.localeCompare(b.name),
		)) {
			const path = join(dir, entry.name);
			const stats = statSync(path);
			lines.push(`${path}\t${entry.isDirectory() ? 'd' : stats.size}\t${stats.mtimeMs}`);
			if (entry.isDirectory()) walk(path);
		}
	};
	walk(root);
	return lines.join('\n');
}

/** DROP one clone — call ONLY after `probeProvenance` answered 'marked'. */
export async function dropShardDatabase(name: string): Promise<void> {
	await psql('postgres', ['-c', `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`]);
}

// ── media twin ───────────────────────────────────────────────────────────────

/**
 * Copy the suite media tree to the shard's twin —
 * `../private/test_media/<template>` → `…/<template>__shard<N>` — with APFS
 * clonefile (`cp -c`, byte-free on APFS) and a plain `cp -R` fallback that
 * announces itself. The marker on the copy is VERIFIED, never planted: a copy
 * without one means the SOURCE was not a declared test media root, and
 * planting a marker on an undeclared tree is precisely the accident the marker
 * system exists to prevent.
 *
 * A missing source is fine and said so: the child's own preload
 * (test/preload/test_media.ts) creates an empty marked root, exactly as a
 * fresh `bun test` does. NEVER set DEDALO_TEST_MEDIA_ROOT for the child —
 * `testMediaRootPath()` derives the tree FROM the database name, so it follows
 * the shard database for free; setting both by hand is exactly how they come
 * to disagree.
 */
export async function cloneShardMedia(template: string, shard: number): Promise<string | null> {
	const source = testMediaRootPath(template);
	const destination = testMediaRootPath(shardDatabaseName(template, shard));
	if (!existsSync(source)) {
		console.warn(
			`[shard-db] suite media tree '${source}' does not exist — the shard's preload will create an empty marked root (same as a fresh 'bun test').`,
		);
		return null;
	}
	rmSync(destination, { recursive: true, force: true });
	const clone = Bun.spawnSync(['cp', '-c', '-R', source, destination], {
		stdout: 'pipe',
		stderr: 'pipe',
	});
	if (clone.exitCode !== 0) {
		console.warn(
			`[shard-db] 'cp -c' (APFS clonefile) failed (${clone.stderr.toString().trim()}) — falling back to a plain copy.`,
		);
		const plain = Bun.spawnSync(['cp', '-R', source, destination], {
			stdout: 'pipe',
			stderr: 'pipe',
		});
		if (plain.exitCode !== 0) {
			throw new Error(`[shard-db] media copy failed: ${plain.stderr.toString().trim()}`);
		}
	}
	if (!existsSync(join(destination, TEST_MEDIA_MARKER))) {
		// The copy is OURS (created three lines up), so removing it directly is
		// legitimate; the refusal is about the SOURCE.
		rmSync(destination, { recursive: true, force: true });
		throw new Error(
			`[shard-db] '${source}' carries no '${TEST_MEDIA_MARKER}' marker — it has not declared itself a test media root, so its copy was removed and nothing will be handed to a test process. Rebuild it with 'bun run test:db:setup'.`,
		);
	}
	return destination;
}

// ── sweep ────────────────────────────────────────────────────────────────────

export interface SweepReport {
	/** Databases that probed 'marked' and were dropped — matrix clones AND vector twins. */
	dropped: string[];
	/** Candidates the sweep REFUSED to drop, with the probe state naming why. */
	refused: { name: string; state: string }[];
	/** Media twins removed (they carried the marker). */
	mediaSwept: string[];
	/** Media directories at a shard name WITHOUT the marker — reported, kept. */
	mediaRefused: string[];
	/** Suite MariaDB lanes at a shard name: server stopped, marked root removed. */
	mariadbSwept: string[];
	/** Suite MariaDB lane roots at a shard name WITHOUT `.dedalo_test_mariadb` — reported, kept. */
	mariadbRefused: string[];
	/** MARKED lane roots whose stop/remove FAILED — kept, with the real error (never "unmarked"). */
	mariadbFailed: { lane: string; error: string }[];
}

/** Escape LIKE's metacharacters — a bare `_` is a single-char WILDCARD. */
function escapeLike(value: string): string {
	return value.replace(/([\\%_])/g, '\\$1');
}

/** The same job for a RegExp: a database name is data, never a pattern. */
function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Sweep every `<template>__shard<N>` clone, its VECTOR twin and its media twin —
 * the guarded path described in the header. Runs on ENTRY as well as exit (finally + signal
 * handlers + the named `--sweep` command), because a SIGKILL defeats all
 * three in-process hooks and a stale clone of an old schema is worse than no
 * clone.
 */
export async function sweepShardClones(template: string): Promise<SweepReport> {
	assertShardableTemplate(template);
	const report: SweepReport = {
		dropped: [],
		refused: [],
		mediaSwept: [],
		mediaRefused: [],
		mariadbSwept: [],
		mariadbRefused: [],
		mariadbFailed: [],
	};

	// Enumerate by ESCAPED LIKE, then re-filter by exact grammar in TS: the LIKE
	// narrows server-side, the regex is the authority.
	const pattern = `${escapeLike(template)}\\_\\_shard%`;
	const listing = (
		await psql(
			'postgres',
			['-t', '-A', '-v', `pattern=${pattern}`, '-f', '-'],
			"SELECT datname FROM pg_database WHERE datname LIKE :'pattern' ESCAPE '\\' ORDER BY datname\n",
		)
	).trim();
	const grammar = new RegExp(`^${escapeRegex(template)}__shard\\d+$`);
	const candidates = (listing === '' ? [] : listing.split('\n'))
		.map((name) => name.trim())
		.filter((name) => grammar.test(name));

	for (const name of candidates) {
		const provenance = await probeProvenance(name);
		if (provenance.state === 'marked') {
			await dropShardDatabase(name);
			report.dropped.push(name);
			continue;
		}
		if (provenance.state === 'absent') continue; // raced away — nothing to do
		report.refused.push({
			name,
			state:
				provenance.state === 'misrouted'
					? `misrouted (marker names '${provenance.markerDatabase}')`
					: provenance.state,
		});
	}

	// VECTOR TWINS. Enumerated on the VECTOR server (its own connection keys; it
	// need not be the matrix one) rather than derived from the clones above,
	// because the twin outlives its clone: `provisionShardDatabase` drops a stale
	// clone before every run, and a previous sweep dropped clones without ever
	// seeing their twins — so the leaked databases this closes are precisely the
	// ORPHANS a clone-driven derivation would miss.
	//
	// The `_rag` tail is NEVER re-typed here: it is read back from
	// `suiteRagDatabaseName`, the one function `test/preload/rag_db.ts` uses to
	// build the name in the child. If it does not answer with the shard name plus
	// a tail, an explicit DEDALO_TEST_RAG_DATABASE has pinned one shared name for
	// every shard — not a per-shard twin, not this sweep's to drop, and said out
	// loud because it also means concurrent shards share one vector index.
	const shardSample = shardDatabaseName(template, 0);
	const twinSample = suiteRagDatabaseName(shardSample);
	if (!twinSample.startsWith(shardSample)) {
		console.warn(
			`[shard-db] DEDALO_TEST_RAG_DATABASE pins the vector database to '${twinSample}' for every process that inherits it, so shards do not get their own twin and none is swept. Concurrent shards then share one vector index; unset it to get '<clone>_rag' per shard.`,
		);
	} else {
		const twinGrammar = new RegExp(
			`^${escapeRegex(template)}__shard\\d+${escapeRegex(twinSample.slice(shardSample.length))}$`,
		);
		for (const name of await listRagDatabases(`${template}__shard`)) {
			if (!twinGrammar.test(name)) continue;
			// Probed and dropped by the twin's OWN marker row — `dropSuiteRagDatabase`
			// drops nothing it could not prove, and hands back what it found.
			const provenance = await dropSuiteRagDatabase(name);
			if (provenance.state === 'marked') {
				report.dropped.push(name);
				continue;
			}
			if (provenance.state === 'absent') continue; // raced away — nothing to do
			report.refused.push({
				name,
				state:
					provenance.state === 'refused'
						? `vector marker refused (${provenance.detail})`
						: `vector database ${provenance.state}`,
			});
		}
	}

	// Media twins: same grammar over the test-media base; the `.dedalo_test_media`
	// marker — not the name — is what licenses the rm.
	const base = testMediaBaseDir();
	if (existsSync(base)) {
		for (const entry of readdirSync(base)) {
			if (!grammar.test(entry)) continue;
			const dir = join(base, entry);
			if (existsSync(join(dir, TEST_MEDIA_MARKER))) {
				rmSync(dir, { recursive: true, force: true });
				report.mediaSwept.push(dir);
			} else {
				report.mediaRefused.push(dir);
			}
		}
	}

	// SUITE MARIADB LANES (PUB-05): a shard child's first MariaDB gate installs and
	// starts a DETACHED mariadbd under ../private/test_mariadb/<clone>. Same grammar;
	// the `.dedalo_test_mariadb` marker — not the name — licenses stop + rm. Imported
	// lazily for the same reason as pg_bin above (its graph reaches src/config).
	const { sweepSuiteMariadbLanes } = await import('../../test/helpers/suite_mariadb_lanes.ts');
	const lanes = await sweepSuiteMariadbLanes((lane) => grammar.test(lane));
	report.mariadbSwept.push(...lanes.swept);
	report.mariadbRefused.push(...lanes.refused);
	report.mariadbFailed.push(...lanes.failed);

	return report;
}
