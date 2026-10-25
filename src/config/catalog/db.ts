/**
 * CONFIG CATALOG — domain: db
 *
 * GENERATED SCAFFOLD (probe_emit_catalog.ts). Hand-edit from here on.
 */

import type { CatalogEntry } from '../catalog_types.ts';

export const DB_KEYS = {
	DB_HOST: {
		required: true,
		installGate: true,
		installSentinel: 'localhost',
		type: 'string',
		scope: 'operator',
		default: 'localhost',
		heading: 'Dédalo hostname connection',
		typeLabel: 'string',
		doc: `This parameter defines the hostname of the server that is running the database. By default Dédalo uses \`localhost\`, because the database and the web server typically run on the same machine — but it is possible to point this at a separate database server.

\`\`\`bash
DB_HOST="localhost"
\`\`\``,
	},
	DB_NAME: {
		required: true,
		installGate: true,
		installSentinel: 'dedalo_install_placeholder',
		placeholder: { value: 'dedalo_mydatabase' },
		type: 'string',
		scope: 'operator',
		default: 'dedalo_install_placeholder',
		heading: 'Dédalo database name',
		typeLabel: 'string',
		doc: `This parameter defines the name of the database in PostgreSQL.

\`\`\`bash
DB_NAME="dedalo_XXX"
\`\`\``,
	},
	DB_PASSWORD: {
		placeholder: { value: 'mypassword', emptyIsValid: true },
		type: 'string',
		scope: 'secret',
		default: '',
		heading: 'Dédalo database password',
		typeLabel: 'string',
		doc: `This parameter defines the password of the database user.

\`\`\`bash
DB_PASSWORD="my_password"
\`\`\``,
	},
	DB_POOL_ACQUIRE_TIMEOUT_MS: {
		type: 'number',
		scope: 'operator',
		default: 0,
		heading: 'Database connection acquire timeout',
		typeLabel: 'int',
		doc: `How long (in milliseconds) a request waits for a free database connection when the
pool is fully in use, before it gives up. The default \`0\` means *wait forever*.

Setting it — \`30000\` is a sensible production value — turns pool exhaustion from a
silent, indefinite hang into a loud, diagnosable answer: the request fails with the error
\`db.pool_exhausted\` (HTTP 503, "try again in a moment"). It does not make the server
slower: it only bounds how long it is willing to be stuck. Every way of taking a
connection counts against the pool — a query, a transaction, a connection reserved for
one caller — so nothing can exhaust the pool behind this bound's back. The maintenance
pool (\`DB_MAINTENANCE_POOL_MAX\`) has its own connections and applies the same bound to
them.

\`\`\`bash
DB_POOL_ACQUIRE_TIMEOUT_MS=30000
\`\`\``,
	},
	DB_POOL_MAX: {
		type: 'number',
		scope: 'operator',
		default: 10,
		heading: 'Database connection pool size',
		typeLabel: 'int',
		doc: `The maximum number of PostgreSQL connections this process keeps open. Default \`10\`,
minimum \`1\`.

The limit is **per process**, and a Dédalo installation runs more than one: the server
itself, plus one process per concurrent publication runner
(\`DEDALO_DIFFUSION_MAX_RUNNERS\`), plus background workers. Each process may also open
up to \`DB_MAINTENANCE_POOL_MAX\` maintenance connections. All of them together must
stay below the PostgreSQL server's own \`max_connections\` (typically 100). With the
defaults — a server and two runners — the installation uses at most 36 connections,
which leaves ample room. Raise this only when the database server has the connections
to spare.

A publication runner needs at least **2**: each batch holds one connection for its whole
write to the publication target, and the runner's heartbeat needs another beside it. A
runner started with \`DB_POOL_MAX=1\` refuses to start, naming this key.

Exports need at least **2** as well: an export holds one connection for its whole run while it
reads its selection, and needs another beside it to read the records. Each process runs at most a
quarter of this value of such exports at once (at least one); a request beyond it is answered
"busy, try again", and a background export waits for its turn. With \`DB_POOL_MAX=1\` every export
is refused.

\`\`\`bash
DB_POOL_MAX=10
\`\`\``,
	},
	DB_MAINTENANCE_POOL_MAX: {
		type: 'number',
		scope: 'operator',
		default: 2,
		heading: 'Maintenance connection pool size',
		typeLabel: 'int',
		doc: `The number of PostgreSQL connections this process keeps for MAINTENANCE work — the
maintenance-area actions that scale with the size of the data (store rebuilds, VACUUM and
REINDEX, bulk transforms, imports), the data-update engine and the other deliberately
long operations. The other maintenance-area actions stay on the request pool, so they
never queue behind a long one. Default \`2\`, minimum \`1\` (a \`0\` is read as \`1\`).

These connections are separate from the request pool (\`DB_POOL_MAX\`) for one reason:
they carry no statement ceiling (\`DB_STATEMENT_TIMEOUT_MS\` does not apply to them), and
keeping them apart means the request pool's ceiling is never lifted on a connection a
request could later be handed. The pool is opened only when maintenance work first
runs, and its idle connections close after 30 seconds.

Count these connections in the installation's budget TWICE: every process may hold up
to \`DB_POOL_MAX + 2 × DB_MAINTENANCE_POOL_MAX + 2\` connections (16 with the defaults).
The index-rebuild lane (REINDEX/VACUUM) is a second set of these connections that keeps
its own idle ones for 30 seconds, and a stop or an update verdict opens up to 2
short-lived connections of its own. All processes together (the server, each diffusion
runner) must stay below the PostgreSQL server's \`max_connections\`.

\`\`\`bash
DB_MAINTENANCE_POOL_MAX=2
\`\`\``,
	},
	DB_PORT: {
		type: 'number',
		scope: 'operator',
		default: 5432,
		heading: 'Dédalo database host port connection',
		typeLabel: 'int',
		doc: `This parameter defines the host port of the server that is running the database. By default Dédalo uses the default PostgreSQL \`5432\` port.

\`\`\`bash
DB_PORT=5432
\`\`\``,
	},
	DB_SOCKET: {
		type: 'string',
		scope: 'operator',
		default: '',
		heading: 'Dédalo database unix socket',
		typeLabel: 'string',
		doc: `The unix-socket DIRECTORY of the PostgreSQL server, for a local connection that does not go
through the network stack (e.g. \`/var/run/postgresql\` on Debian/Ubuntu, \`/tmp\` on macOS
Homebrew). When set it **wins**: \`DB_HOST\` is then ignored for the connection, and
\`DB_PORT\` only selects the socket file inside the directory (\`.s.PGSQL.<port>\`). A path
to the socket file itself (\`/var/run/postgresql/.s.PGSQL.5432\`) is accepted too; its port
is the one in the file name.

Leave it empty (the default) to connect over TCP to \`DB_HOST\`:\`DB_PORT\`. A \`DB_HOST\`
that starts with \`/\` is also read as a socket directory, as PostgreSQL's own tools do.

The value must be an absolute path — a relative one refuses the boot. One rule decides the
route for everything that connects to this database: the server, the installer's connection
test, the backups and every \`psql\`/\`pg_dump\` the maintenance tools run, so they can never
reach different servers. A socket that does not exist fails loudly; it never falls back to
TCP. The old spelling \`DEDALO_SOCKET_CONN\` is still read when this key is not set.

\`\`\`bash
DB_SOCKET="/var/run/postgresql"
\`\`\``,
	},
	DB_SSLMODE: {
		type: 'string',
		scope: 'operator',
		default: 'disable',
		heading: 'Database TLS mode',
		typeLabel: 'string',
		doc: `Whether the engine negotiates TLS on its PostgreSQL connections, in PostgreSQL's
own \`sslmode\` vocabulary: \`disable\` (the default), \`allow\`, \`prefer\`, \`require\`,
\`verify-ca\` or \`verify-full\`.

**Why this key exists at all.** Bun 1.4 began honouring the ambient \`PGSSLMODE\` /
\`PG_SSLMODE\` environment variables inside \`Bun.sql\` (Bun 1.3 ignored them). Those are
set on plenty of machines for \`psql\`/\`pg_dump\`, so without an explicit value here the
engine's own TLS mode would be decided by whatever the surrounding shell, systemd unit
or CI image happened to export — an input the typed config catalog cannot see and the
operator has nothing to correct in \`../private/.env\`. Dédalo therefore always passes
this value explicitly, and the ambient variables can never apply.

The default \`disable\` preserves the behaviour every installation had before Bun 1.4.
A typical install talks to PostgreSQL over a unix socket or localhost, where TLS buys
nothing. Set \`require\` (or a verifying mode) when the database lives on another host.

\`\`\`bash
DB_SSLMODE=disable
\`\`\``,
	},
	DB_STATEMENT_TIMEOUT_MS: {
		type: 'number',
		scope: 'operator',
		default: 0,
		heading: 'Database statement timeout',
		typeLabel: 'int',
		doc: `The maximum time (in milliseconds) any single database statement of ordinary request
traffic may run before PostgreSQL cancels it. The default \`0\` means no limit.

**A production installation should set it** — \`60000\` (one minute) is the recommended
value: one runaway query must not be able to occupy a connection forever and starve
every other user. It is also the only bound on a search that cannot stop early: some
columns are deliberately left unindexed, and a term that matches nothing there reads
the whole table — on a large activity log that is minutes, and a user closing the
browser does NOT cancel it. A statement stopped by this ceiling answers with the error
\`db.statement_timeout\` (HTTP 503), never a generic server error.

Long-running MAINTENANCE does not run under this ceiling, so it does not have to be
sized around it: the maintenance-area actions (reindex, vacuum, search-store rebuilds,
the bulk transforms) and the data-update engine run on a separate maintenance connection
pool whose statements are unbounded (\`DB_MAINTENANCE_POOL_MAX\`), and the boot
migrations lift the ceiling for their own transaction. Not yet exempt, so measure them
on your installation before setting a value: the search-store builds a boot runs when
it finds a store missing or damaged, the observer mirror reconcile
(\`scripts/observer_reconcile.ts\`) and the activity-log retention prune on a very large
log. Choose a value comfortably above your slowest legitimate *request* — if searches
or exports on very large sections are part of daily work, measure them first (see
\`DEDALO_SLOW_QUERY_MS\`). An export's record selection is computed under this ceiling
as well, in the background lane too: an export whose selection takes longer to compute
is refused with \`db.statement_timeout\` before its first line.

\`\`\`bash
DB_STATEMENT_TIMEOUT_MS=60000
\`\`\``,
	},
	DB_USER: {
		required: true,
		installGate: true,
		installSentinel: 'dedalo',
		placeholder: { value: 'myusername' },
		type: 'string',
		scope: 'operator',
		default: 'dedalo',
		heading: 'Dédalo database username',
		typeLabel: 'string',
		doc: `This parameter defines the name of the user who can administer the database. This user must be an administrator or owner of the database, Dédalo must be able to create, update and select all tables and records.

\`\`\`bash
DB_USER="my_username"
\`\`\``,
	},
	DEDALO_PG_BIN_PATH: {
		type: 'string',
		scope: 'operator',
		default: undefined,
		heading: 'Path to the database binary',
		typeLabel: 'string',
		doc: `This parameter defines the directory holding the PostgreSQL client binaries
(\`psql\`, \`pg_dump\`, \`pg_restore\`) used for maintenance tasks and backups. When
unset, Dédalo probes common Homebrew install locations (newest version first)
and falls back to resolving the binary name from \`PATH\`.

\`\`\`bash
DEDALO_PG_BIN_PATH="/usr/lib/postgresql/16/bin/"
\`\`\``,
	},
	SEARCH_LATE_ROW_LOOKUP_OFFSET: {
		type: 'number',
		scope: 'operator',
		default: 1000,
		heading: 'Deep pagination rewrite threshold',
		typeLabel: 'int',
		doc: `From this list offset on, default-ordered section searches are rewritten to a
"late row lookup": the wanted page of record ids is found on an index-only scan first,
and only those rows' full data is fetched. Same rows, same order — measured ~70×
faster at offset 300000 on a 438k-record section, because a plain \`OFFSET\` makes
PostgreSQL read and discard every skipped row's data columns.

A page in the far half of the list is fetched from the other end with a small offset
(the last page costs milliseconds). This applies to the unfiltered browse and to a
browse filtered only by the user's own access (projects, record allow-list), whose
cached total makes the flip exact — so a non-administrator stepping through the newest
records is as fast as an administrator. Pages in the middle gain nothing from the flip.

Shallow pages keep the plain query (the rewrite would gain nothing there). Set \`-1\`
to disable the rewrite entirely.

\`\`\`bash
SEARCH_LATE_ROW_LOOKUP_OFFSET=1000
\`\`\``,
	},
	TM_COUNT_CACHE_TTL_MS: {
		type: 'number',
		scope: 'operator',
		default: 30000,
		heading: 'Browse total cache lifetime',
		typeLabel: 'int',
		doc: `The freshness backstop (in milliseconds) for every cached BROWSE TOTAL. It was
named for the first of them: the unfiltered time-machine browse shows a total that
costs a full count of the (typically huge, append-only) \`matrix_time_machine\` table.
It now also floors the list assembler's totals — the unfiltered per-section browse
count (per ACL scope), the projects-density verdict and the section-total verdict —
each of which is a full count of a section's records. All are invalidated on every
save this engine performs; this key bounds how long one may survive a change made by
anything else. Default \`30000\` (30 s). Set \`0\` to disable the caches and count
exactly on every request — the right setting for parity test environments.

\`\`\`bash
TM_COUNT_CACHE_TTL_MS=30000
\`\`\``,
	},
	DEDALO_SLOW_QUERY_MS: {
		type: 'number',
		scope: 'operator',
		default: 0,
		heading: 'Slow query',
		typeLabel: 'int',
		doc: `This parameter defines the time limit for query calls: if a statement takes longer than this value, Dédalo logs a warning line naming it. Set to \`0\` (the default) to disable slow-query logging.

Every statement is measured, whichever connection it runs on: the ordinary pooled ones, the ones inside a transaction (that is, the whole write path — saving a record, importing, publishing) and the ones on a connection reserved for a single caller (maintenance, background locks). The warning line names the lane it came from, so an unexpectedly slow save is as visible as an unexpectedly slow search.

\`\`\`bash
DEDALO_SLOW_QUERY_MS=1200
\`\`\``,
	},
	PHP_API_BASE_URL: {
		type: 'string',
		scope: 'test_seam',
		default: undefined,
		heading: 'Reference-engine API endpoint (test seam)',
		typeLabel: 'string',
		doc: `Not an administrator setting, and not a live integration: no part of the running
engine calls this endpoint. It is one of three keys used only by the developers' parity
test harness, which can replay recorded responses of the legacy reference engine and
compare them against this engine's. Unset on every installation — the harness defaults
to replaying a frozen, credential-free fixture store instead.`,
	},
	PHP_API_PASSWORD: {
		type: 'string',
		scope: 'test_seam',
		default: undefined,
		heading: 'Reference-engine API password (test seam)',
		typeLabel: 'string',
		doc: `Not an administrator setting. The password half of the credentials the developers'
parity test harness would use against a legacy reference installation (the companion of
the reference-engine API endpoint key above). The running engine never reads it; leave
it unset.`,
	},
	DEDALO_TEST_DATABASE: {
		type: 'string',
		scope: 'test_seam',
		default: undefined,
		heading: 'Test suite database (test seam)',
		typeLabel: 'string',
		consumer:
			'src/config/suite_database.ts (from the PROCESS env only, by design: the pin the suite preload sets) + test/preload/test_database.ts',
		doc: `Test seam, not a setting. The name of the database the test suite runs against; unset, the suite derives \`<DB_NAME>_test\`. The suite's preload (\`test/preload/test_database.ts\`) pins it before it repoints \`DB_NAME\`, and that pin is what ARMS the connection pool inside a test process: a \`bun test\` process opens a database only when this names exactly that database (or \`DEDALO_TEST_DB_DISABLE=true\`). A \`bun test\` started outside the repository root never reads the preload, so its pool refuses to open the application database instead of writing test data into it. The running engine never reads it outside a test process; leave it unset.

\`\`\`bash
DEDALO_TEST_DATABASE="dedalo7_test"
\`\`\``,
	},
	DEDALO_TEST_DB_DISABLE: {
		type: 'string',
		scope: 'test_seam',
		default: undefined,
		heading: 'Run the test suite against the configured database (test seam)',
		typeLabel: 'string',
		consumer:
			'src/config/suite_database.ts + test/preload/test_database.ts (both from the PROCESS env only, by design: an explicit typed-out choice, never a .env line)',
		doc: `Test seam, not a setting. \`true\` makes the test suite run against the CONFIGURED database instead of its own \`_test\` database — an explicit, typed-out choice to let the tests read and write your data, never a default. It also stands the test-process connection guard down (see the test suite database key above). The running engine never reads it outside a test process; leave it unset.

\`\`\`bash
DEDALO_TEST_DB_DISABLE="true"
\`\`\``,
	},
	PHP_API_USERNAME: {
		type: 'string',
		scope: 'test_seam',
		default: undefined,
		heading: 'Reference-engine API username (test seam)',
		typeLabel: 'string',
		doc: `Not an administrator setting. The username half of the credentials the developers'
parity test harness would use against a legacy reference installation (the companion of
the reference-engine API endpoint key above). The running engine never reads it; leave
it unset.`,
	},
} as const satisfies Record<string, CatalogEntry>;
