# Database connection

> See also: [How configuration works](administration.md) · [Settings reference](config.md) · [What changed in v7](whats_changed_v7.md)

Dédalo v7 connects to **two** databases, both configured in `../private/.env`:

- **PostgreSQL** — the work system: every record, the ontology, users. Required.
- **MariaDB / MySQL** — the diffusion (publication) target. Optional, and written
  only by the [diffusion engine](../diffusion/native_engine.md).

```bash
# ../private/.env — PostgreSQL (the work system)
DB_NAME=dedalo
DB_HOST=localhost
DB_PORT=5432
DB_USER=dedalo
DB_PASSWORD=…
```

The v6 names (`DEDALO_DATABASE_CONN`, `DEDALO_HOSTNAME_CONN`, `DEDALO_USERNAME_CONN`,
`DEDALO_PASSWORD_CONN`, `DEDALO_DB_PORT_CONN`) are still honored as fallbacks, so a
migrated `.env` works unchanged.

---

<!-- BEGIN GENERATED — src/config/catalog/ · regenerate: bun run config:gen -->

## Work system database variables {#db}

### Dédalo hostname connection

DB_HOST `string`

This parameter defines the hostname of the server that is running the database. By default Dédalo uses `localhost`, because the database and the web server typically run on the same machine — but it is possible to point this at a separate database server.

```bash
DB_HOST="localhost"
```

*Default: localhost*

---

### Dédalo database name

DB_NAME `string`

This parameter defines the name of the database in PostgreSQL.

```bash
DB_NAME="dedalo_XXX"
```

*Default: dedalo_install_placeholder*

---

### Dédalo database password

DB_PASSWORD `string`

This parameter defines the password of the database user.

```bash
DB_PASSWORD="my_password"
```

*Default: (empty)*

---

### Database connection acquire timeout

DB_POOL_ACQUIRE_TIMEOUT_MS `int`

How long (in milliseconds) a request waits for a free database connection when the
pool is fully in use, before it gives up. The default `0` means *wait forever*.

Setting it — `30000` is a sensible production value — turns pool exhaustion from a
silent, indefinite hang into a loud, diagnosable answer: the request fails with the error
`db.pool_exhausted` (HTTP 503, "try again in a moment"). It does not make the server
slower: it only bounds how long it is willing to be stuck. Every way of taking a
connection counts against the pool — a query, a transaction, a connection reserved for
one caller — so nothing can exhaust the pool behind this bound's back. The maintenance
pool (`DB_MAINTENANCE_POOL_MAX`) has its own connections and applies the same bound to
them.

```bash
DB_POOL_ACQUIRE_TIMEOUT_MS=30000
```

*Default: 0*

---

### Database connection pool size

DB_POOL_MAX `int`

The maximum number of PostgreSQL connections this process keeps open. Default `10`,
minimum `1`.

The limit is **per process**, and a Dédalo installation runs more than one: the server
itself, plus one process per concurrent publication runner
(`DEDALO_DIFFUSION_MAX_RUNNERS`), plus background workers. Each process may also open
up to `DB_MAINTENANCE_POOL_MAX` maintenance connections. All of them together must
stay below the PostgreSQL server's own `max_connections` (typically 100). With the
defaults — a server and two runners — the installation uses at most 36 connections,
which leaves ample room. Raise this only when the database server has the connections
to spare.

A publication runner needs at least **2**: each batch holds one connection for its whole
write to the publication target, and the runner's heartbeat needs another beside it. A
runner started with `DB_POOL_MAX=1` refuses to start, naming this key.

Exports need at least **2** as well: an export holds one connection for its whole run while it
reads its selection, and needs another beside it to read the records. Each process runs at most a
quarter of this value of such exports at once (at least one); a request beyond it is answered
"busy, try again", and a background export waits for its turn. With `DB_POOL_MAX=1` every export
is refused.

```bash
DB_POOL_MAX=10
```

*Default: 10*

---

### Maintenance connection pool size

DB_MAINTENANCE_POOL_MAX `int`

The number of PostgreSQL connections this process keeps for MAINTENANCE work — the
maintenance-area actions that scale with the size of the data (store rebuilds, VACUUM and
REINDEX, bulk transforms, imports), the data-update engine and the other deliberately
long operations. The other maintenance-area actions stay on the request pool, so they
never queue behind a long one. Default `2`, minimum `1` (a `0` is read as `1`).

These connections are separate from the request pool (`DB_POOL_MAX`) for one reason:
they carry no statement ceiling (`DB_STATEMENT_TIMEOUT_MS` does not apply to them), and
keeping them apart means the request pool's ceiling is never lifted on a connection a
request could later be handed. The pool is opened only when maintenance work first
runs, and its idle connections close after 30 seconds.

Count these connections in the installation's budget TWICE: every process may hold up
to `DB_POOL_MAX + 2 × DB_MAINTENANCE_POOL_MAX + 2` connections (16 with the defaults).
The index-rebuild lane (REINDEX/VACUUM) is a second set of these connections that keeps
its own idle ones for 30 seconds, and a stop or an update verdict opens up to 2
short-lived connections of its own. All processes together (the server, each diffusion
runner) must stay below the PostgreSQL server's `max_connections`.

```bash
DB_MAINTENANCE_POOL_MAX=2
```

*Default: 2*

---

### Dédalo database host port connection

DB_PORT `int`

This parameter defines the host port of the server that is running the database. By default Dédalo uses the default PostgreSQL `5432` port.

```bash
DB_PORT=5432
```

*Default: 5432*

---

### Dédalo database unix socket

DB_SOCKET `string`

The unix-socket DIRECTORY of the PostgreSQL server, for a local connection that does not go
through the network stack (e.g. `/var/run/postgresql` on Debian/Ubuntu, `/tmp` on macOS
Homebrew). When set it **wins**: `DB_HOST` is then ignored for the connection, and
`DB_PORT` only selects the socket file inside the directory (`.s.PGSQL.<port>`). A path
to the socket file itself (`/var/run/postgresql/.s.PGSQL.5432`) is accepted too; its port
is the one in the file name.

Leave it empty (the default) to connect over TCP to `DB_HOST`:`DB_PORT`. A `DB_HOST`
that starts with `/` is also read as a socket directory, as PostgreSQL's own tools do.

The value must be an absolute path — a relative one refuses the boot. One rule decides the
route for everything that connects to this database: the server, the installer's connection
test, the backups and every `psql`/`pg_dump` the maintenance tools run, so they can never
reach different servers. A socket that does not exist fails loudly; it never falls back to
TCP. The old spelling `DEDALO_SOCKET_CONN` is still read when this key is not set.

```bash
DB_SOCKET="/var/run/postgresql"
```

*Default: (empty)*

---

### Database TLS mode

DB_SSLMODE `string`

Whether the engine negotiates TLS on its PostgreSQL connections, in PostgreSQL's
own `sslmode` vocabulary: `disable` (the default), `allow`, `prefer`, `require`,
`verify-ca` or `verify-full`.

**Why this key exists at all.** Bun 1.4 began honouring the ambient `PGSSLMODE` /
`PG_SSLMODE` environment variables inside `Bun.sql` (Bun 1.3 ignored them). Those are
set on plenty of machines for `psql`/`pg_dump`, so without an explicit value here the
engine's own TLS mode would be decided by whatever the surrounding shell, systemd unit
or CI image happened to export — an input the typed config catalog cannot see and the
operator has nothing to correct in `../private/.env`. Dédalo therefore always passes
this value explicitly, and the ambient variables can never apply.

The default `disable` preserves the behaviour every installation had before Bun 1.4.
A typical install talks to PostgreSQL over a unix socket or localhost, where TLS buys
nothing. Set `require` (or a verifying mode) when the database lives on another host.

```bash
DB_SSLMODE=disable
```

*Default: disable*

---

### Database statement timeout

DB_STATEMENT_TIMEOUT_MS `int`

The maximum time (in milliseconds) any single database statement of ordinary request
traffic may run before PostgreSQL cancels it. The default `0` means no limit.

**A production installation should set it** — `60000` (one minute) is the recommended
value: one runaway query must not be able to occupy a connection forever and starve
every other user. It is also the only bound on a search that cannot stop early: some
columns are deliberately left unindexed, and a term that matches nothing there reads
the whole table — on a large activity log that is minutes, and a user closing the
browser does NOT cancel it. A statement stopped by this ceiling answers with the error
`db.statement_timeout` (HTTP 503), never a generic server error.

Long-running MAINTENANCE does not run under this ceiling, so it does not have to be
sized around it: the maintenance-area actions (reindex, vacuum, search-store rebuilds,
the bulk transforms) and the data-update engine run on a separate maintenance connection
pool whose statements are unbounded (`DB_MAINTENANCE_POOL_MAX`), and the boot
migrations lift the ceiling for their own transaction. Not yet exempt, so measure them
on your installation before setting a value: the search-store builds a boot runs when
it finds a store missing or damaged, the observer mirror reconcile
(`scripts/observer_reconcile.ts`) and the activity-log retention prune on a very large
log. Choose a value comfortably above your slowest legitimate *request* — if searches
or exports on very large sections are part of daily work, measure them first (see
`DEDALO_SLOW_QUERY_MS`). An export's record selection is computed under this ceiling
as well, in the background lane too: an export whose selection takes longer to compute
is refused with `db.statement_timeout` before its first line.

```bash
DB_STATEMENT_TIMEOUT_MS=60000
```

*Default: 0*

---

### Dédalo database username

DB_USER `string`

This parameter defines the name of the user who can administer the database. This user must be an administrator or owner of the database, Dédalo must be able to create, update and select all tables and records.

```bash
DB_USER="my_username"
```

*Default: dedalo*

---

### Path to the database binary

DEDALO_PG_BIN_PATH `string`

This parameter defines the directory holding the PostgreSQL client binaries
(`psql`, `pg_dump`, `pg_restore`) used for maintenance tasks and backups. When
unset, Dédalo probes common Homebrew install locations (newest version first)
and falls back to resolving the binary name from `PATH`.

```bash
DEDALO_PG_BIN_PATH="/usr/lib/postgresql/16/bin/"
```

*Default: (unset)*

---

### Deep pagination rewrite threshold

SEARCH_LATE_ROW_LOOKUP_OFFSET `int`

From this list offset on, default-ordered section searches are rewritten to a
"late row lookup": the wanted page of record ids is found on an index-only scan first,
and only those rows' full data is fetched. Same rows, same order — measured ~70×
faster at offset 300000 on a 438k-record section, because a plain `OFFSET` makes
PostgreSQL read and discard every skipped row's data columns.

A page in the far half of the list is fetched from the other end with a small offset
(the last page costs milliseconds). This applies to the unfiltered browse and to a
browse filtered only by the user's own access (projects, record allow-list), whose
cached total makes the flip exact — so a non-administrator stepping through the newest
records is as fast as an administrator. Pages in the middle gain nothing from the flip.

Shallow pages keep the plain query (the rewrite would gain nothing there). Set `-1`
to disable the rewrite entirely.

```bash
SEARCH_LATE_ROW_LOOKUP_OFFSET=1000
```

*Default: 1000*

---

### Browse total cache lifetime

TM_COUNT_CACHE_TTL_MS `int`

The freshness backstop (in milliseconds) for every cached BROWSE TOTAL. It was
named for the first of them: the unfiltered time-machine browse shows a total that
costs a full count of the (typically huge, append-only) `matrix_time_machine` table.
It now also floors the list assembler's totals — the unfiltered per-section browse
count (per ACL scope), the projects-density verdict and the section-total verdict —
each of which is a full count of a section's records. All are invalidated on every
save this engine performs; this key bounds how long one may survive a change made by
anything else. Default `30000` (30 s). Set `0` to disable the caches and count
exactly on every request — the right setting for parity test environments.

```bash
TM_COUNT_CACHE_TTL_MS=30000
```

*Default: 30000*

---

### Slow query

DEDALO_SLOW_QUERY_MS `int`

This parameter defines the time limit for query calls: if a statement takes longer than this value, Dédalo logs a warning line naming it. Set to `0` (the default) to disable slow-query logging.

Every statement is measured, whichever connection it runs on: the ordinary pooled ones, the ones inside a transaction (that is, the whole write path — saving a record, importing, publishing) and the ones on a connection reserved for a single caller (maintenance, background locks). The warning line names the lane it came from, so an unexpectedly slow save is as visible as an unexpectedly slow search.

```bash
DEDALO_SLOW_QUERY_MS=1200
```

*Default: 0*

---

## Diffusion system database (MariaDB) {#diffusion_db}

The diffusion system database is the external, flat (publication) copy of the data, stored in MariaDB/MySQL: only public data is exported, relationships are pre-resolved, and the result is standard SQL tables/rows/columns.

Every MariaDB operation — publish, delete, backup — is performed by the [diffusion engine](../diffusion/native_engine.md) built into the work server.

### Diffusion target database host

DEDALO_DIFFUSION_DB_HOST `string`

The hostname or IP of the MariaDB/MySQL server that receives the published tables.
Set it when the publication target runs on a different machine than Dédalo, or when it
listens on TCP rather than on a local socket.

Transport precedence is: `DEDALO_DIFFUSION_DB_SOCKET` first, then this host (with
`DEDALO_DIFFUSION_DB_PORT`), and — when neither is set — the default local socket
`/tmp/mysql.sock`. Only the transport is configured here: the target *databases* and
*tables* themselves come from the diffusion ontology.

```bash
DEDALO_DIFFUSION_DB_HOST="localhost"
```

*Default: (unset)*

---

### Diffusion target database password

DEDALO_DIFFUSION_DB_PASSWORD `string`

The password of `DEDALO_DIFFUSION_DB_USER`, the account Dédalo uses to write the
published tables into the target database. This is a **secret**: the shipped template
carries a placeholder only, and a real installation must replace it with the actual
password (or leave it empty when the target authenticates the user by socket instead).

```bash
DEDALO_DIFFUSION_DB_PASSWORD="my_password"
```

*Default: (empty)*

---

### Diffusion target database port

DEDALO_DIFFUSION_DB_PORT `int`

The TCP port of the publication target database. Only used when
`DEDALO_DIFFUSION_DB_HOST` is set (a socket connection ignores it). Defaults to
`3306`, the standard MariaDB/MySQL port.

```bash
DEDALO_DIFFUSION_DB_PORT=3306
```

*Default: 3306*

---

### Diffusion target database socket

DEDALO_DIFFUSION_DB_SOCKET `string`

Path to the local unix socket of the publication target database. Set it when the
target server runs on the same machine as Dédalo and you want to bypass TCP — the
usual production posture, and the fastest one.

It takes precedence over `DEDALO_DIFFUSION_DB_HOST`. When neither key is set, Dédalo
falls back to the conventional socket path `/tmp/mysql.sock`; if your distribution
puts it elsewhere, name it here.

```bash
DEDALO_DIFFUSION_DB_SOCKET="/var/run/mysqld/mysqld.sock"
```

*Default: (unset)*

---

### Diffusion target database username

DEDALO_DIFFUSION_DB_USER `string`

The user account Dédalo connects with to publish into the target database. It must
be able to create and alter the published tables and to insert, update and delete their
rows: the engine provisions the table structure from the diffusion ontology on every
run, so read/write on existing tables is not enough.

```bash
DEDALO_DIFFUSION_DB_USER="my_username"
```

*Default: (empty)*

---

The target database names come from the diffusion ontology (`database` node labels), and the databases must be **pre-created** — a missing database is a loud configuration error, never an auto-create. Create the database and its user with full privileges, e.g.:

```sql
CREATE USER 'username'@'localhost' IDENTIFIED BY 'password';
GRANT ALL PRIVILEGES ON `web_dedalo`.* TO 'username'@'localhost';
```

See [the diffusion engine → Configuration](../diffusion/native_engine.md#configuration) for the full key set (resolve levels, output languages, runner concurrency).

> The standalone **publication server** (`publication/server_api/`) is a separate, legacy deployable with its **own** read-only database config — see [server_config_api](../diffusion/publication_api/server_config_api.md). That is independent of this work install’s database settings.

<!-- END GENERATED -->
