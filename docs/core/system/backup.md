# backup

> See also: [Architecture overview](../architecture_overview.md) ·
> [area_maintenance](../areas/area_maintenance.md) · [db](db.md) ·
> [Diffusion](diffusion.md)

`src/core/area_maintenance/backup.ts` dumps and lists Dédalo's PostgreSQL work
database. It is a stateless module of exported functions, driven by the
`make_backup` maintenance widget.

## Scope

This module backs up **one database with one method**: a custom-format `pg_dump`
of the PostgreSQL work database, into the server's own backup directory.

!!! warning "What backup does NOT cover"
    It does **not** back up the publication database, uploaded media files,
    configuration, or source code. The restore path is the sibling module
    `src/core/area_maintenance/restore_door.ts`, driven from the shell by
    `bun scripts/restore.ts` with the engine stopped — never an in-app action,
    because the running engine cannot swap the database its own pool holds.
    See [How do I backup and restore](../../administration/backup.md).

    The publication database (MariaDB) belongs to the diffusion engine; this
    server never connects to it. The widget's MySQL file list is therefore always
    empty, by design.

## Where backups land

| target | function | tool | output |
| --- | --- | --- | --- |
| PostgreSQL work DB | `initBackupSequence()` | `pg_dump -F c -b` | `<date>.<db>.postgresql_<user>[_forced]_dbv<ver>.custom.backup`, plus a sibling `.log` capturing the dump's stderr |

The final name is given only once the dump has finished. The siblings a backup
directory can hold:

| name | meaning |
| --- | --- |
| `<name>.custom.backup.part` | A dump still being written. Never listed, never counted as a backup. |
| `<name>.custom.backup` | A dump that exited successfully: either proven by a full read (a `.verified` sidecar exists) or not yet read back ("completed, not verified"). Never one known to be damaged. |
| `<name>.custom.backup.verified` | The cached verdict of a full read (see [Verification](#verification-one-verdict-the-full-read)). |
| `<name>.custom.backup.failed` (`.failed.1`, …) | A dump that failed or was stopped, kept for inspection. An earlier failure is never overwritten. |
| `<name>.custom.backup.orphaned` | A `.part` left by a dead process whose full read proved it damaged (or whose final name was already taken). |

`getBackupDir()` resolves the directory: the `DEDALO_BACKUP_DIR` config override
if set, otherwise `<privateDir>/backups/db`.

!!! warning "The directory derives from privateDir, never from the working directory"
    It is derived from the same `privateDir` constant the session store and the
    `.env` loader use. An earlier cwd-based derivation meant the backup directory
    silently changed depending on where the server was launched from — which is
    exactly how a backup ends up somewhere nobody looks.

## Version-matched `pg_dump`

A `pg_dump` **client** older than the **server** refuses to dump at all. That is
not a theoretical hazard: it silently produces zero-byte files while the calling
process reports success.

`resolvePgDump()` guards against it: it probes the version-suffixed installs
(`postgresql@18` down to `@15`) **newest-first** before falling back to a bare
`pg_dump` on `PATH`. `config.ops.pgBinPath` overrides the probe.

## Failure is surfaced, not swallowed

The dump runs as a **maintenance job** (kind `backup`, no deadline), so
`initBackupSequence()` returns the job handle immediately rather than blocking
on a multi-gigabyte dump. The job stays `running` until the dump has been
promoted or kept aside, so its status never claims success early. The module
does four things to surface failure:

- **The password is threaded** from `config.db.password`, so a password-auth
  Postgres does not fail with an authentication error into a log file nobody
  reads while the widget reports success.
- **A short fast-fail window** catches an immediate exit — an authentication or
  connection error — and reports it as a **failure**, with the tail of the `.log`
  in the widget's message.
- **A dump is named only after it finishes.** `pg_dump` writes
  `<name>.part`; a non-zero exit, or a stop, keeps the bytes as `<name>.failed`
  (an empty one is deleted). The backup list can therefore never offer a
  half-written file as restorable.
- **The finished dump is read back** before it is named (see
  [Verification](#verification-one-verdict-the-full-read)).

**The job belongs to the caller.** The file keeps the forced dump's name
(`postgresql_-1_forced_…`), but the job record's user is the person who pressed
the button: they are the one who may stream it and stop it. A user stop kills
`pg_dump`; a server shutdown does not (the dump may finish, and the next dump
adopts it).

## Naming and the throttle window

`initBackupSequence(userId, skipTimeRange, overrides?, ownerId = userId)`:

- **`userId`** is the identity the file name carries; **`ownerId`** is the
  principal the job belongs to. The widget passes `-1` and the caller's id.
- **`skipTimeRange = true`** (forced — the maintenance widget's path):
  second-resolution `Y-m-d_His` naming with a `_forced` marker, no throttle check.
- **`skipTimeRange = false`**: hour-resolution `Y-m-d_H` naming. If the newest
  **usable** backup is younger than `config.ops.backupTimeRangeHours`
  (`DEDALO_BACKUP_TIME_RANGE`, default 8), the call reports "skipped, a recent
  backup already exists" instead of dumping. A backup still being verified when
  the bounded wait runs out counts as none: the safe direction is to dump more
  often, never less.

## Verification: one verdict, the full read

`pg_restore --list` exits 0 on a dump cut in half, because the table of contents
sits at the front of the archive. Only a full read (`pg_restore -f /dev/null`)
tells a complete dump from a cut one, so that read is the only question the
engine asks (`verifyBackupArtifact`). It runs asynchronously, one read at a time,
shared between askers of the same file, and within a budget of
`max(60 s, DEDALO_BACKUP_VERIFY_SECONDS_PER_GB × started GiB)`.

- **Only the archive's own bytes can disprove it.** Empty, not an archive, or
  truncated is a disproof: such a dump is kept as `.failed` and never named.
- **A read that could not finish for a host reason is not a disproof.** A read
  that outran its budget (`unverifiable_timeout`), or one killed from outside,
  an I/O error on the backup storage, or a `pg_restore` older than the archive
  (`unverifiable_read_failed`). A dump that exited 0 but could not be read back
  is still given its final name, **without** a `.verified` sidecar, and
  reported as "completed, not verified (`<reason>`)". It does not count as a
  backup until a later read proves it, and every later freshness check reads it
  again.
- **A host that cannot read at all degrades, it does not lie.** With no
  `pg_restore` on the host (`unverifiable_no_pg_restore`), or for a file whose
  name does not promise our custom format (`unverifiable_foreign_format`), a
  backup counts unproven, judged by age alone.
- **The sidecar is trusted only from this classifier.** A `.verified` sidecar
  carries `classifier: 2`; one written by an older engine (which could cache a
  host failure as `truncated`) is read again once and rewritten, never trusted
  as it stands.
- **Orphans are adopted, never deleted.** A `.part` older than 24 hours (the
  orphan of a server that died mid-dump) is read end to end by the next dump:
  proven, it is named with its sidecar; disproven, it is kept as `.orphaned`;
  a read that failed for a host reason leaves it where it is, for the next
  pass. The nightly script `deploy/dedalo-db-backup.sh` follows the same rule:
  it moves an orphan aside only when `pg_restore`'s own words say the file is
  damaged, and leaves every undecided orphan in place for the engine.

## The surface

`src/core/area_maintenance/backup.ts`:

| function | purpose |
| --- | --- |
| `initBackupSequence(userId, skipTimeRange=true, overrides?, ownerId=userId)` | Create the backup directory if missing, adopt orphaned parts, apply the throttle window unless forced, build the dated filename, and start the dump job (`pg_dump -F c -b -f <path>.part …`). Returns `{ok, msg, errors, pid?, file_path?, pfile?}`; `file_path` is the final name, which exists only once the dump is promoted. |
| `getBackupFiles(backupDir?)` | Return `[{name, size}]` for every `.backup` file, newest first by name, with a human-readable size. In-flight `.part` files are not listed. Returns `[]` when the directory does not exist. |
| `newestBackupMtimeMs(backupDir?)` | The newest `.backup` file's mtime (`0` when there are none). Recency only — never the answer to "is there a restore point". |
| `verifyBackupArtifact(file, options?)` | The full-read verdict of one artifact: `{usable, verified, reason, detail?, budgetMs?}`. |
| `newestUsableBackup(backupDir?)` / `newestUsableBackupWithin(ms, backupDir?)` | The newest backup that counts as a restore point; the second waits at most `ms` and otherwise reports which file is still being read. |
| `getBackupDir()` | Resolve the backup directory. |
| `resolvePgDump()` | Resolve the `pg_dump` binary path. |
| `getCurrentDataVersion()` | Read `matrix_updates` for the highest `dedalo_version`, parsed into `[major, minor, patch]`. `[]` on a fresh database. |

## How it fits with the rest of Dédalo

- **The `make_backup` widget** (`src/core/area_maintenance/widgets/make_backup.ts`)
  is the only caller. It registers two actions — `make_psql_backup` and
  `get_dedalo_backup_files` — plus a `getValue` that reports the would-be filename
  and the backup directory. See [area_maintenance](../areas/area_maintenance.md).
- **The update preconditions** (`src/core/update/preconditions.ts`) ask
  `newestUsableBackup`: a code update is refused (`requireFreshBackup`, waivable)
  when no proven backup is recent enough, and the update panel waits a bounded
  time and otherwise shows "verifying". A code update also stops cleanly when its
  job is stopped: it checks after the backup verdict and again just before the
  swap, so a stopped update never swaps the code tree.
- **The restore door** (`restore_door.ts`) reuses `verifyBackupArtifact` for its
  first phase — the full-read proof that an artifact is a restore point — and
  `getBackupDir()` for its journal directory (`<backup dir>/restores/`). It is
  CLI-only (`scripts/restore.ts`): verify, refuse writers, one-transaction
  restore into a sidecar database, rename swap, the post-restore reconcile plan
  (`src/core/reconcile/post_restore.ts`), journal.
- **Diffusion** is not involved: MariaDB belongs to the diffusion engine. See
  [Diffusion](diffusion.md).

## Examples

### Force an immediate backup

```ts
import { initBackupSequence } from './backup.ts';

// what the make_backup widget's make_psql_backup action does
// forced → dump now, '_forced' filename; the job belongs to the caller
const response = await initBackupSequence(-1, true, {}, principal.userId);
// response.ok, response.pid, response.file_path (named once promoted)
```

### List existing backups

```ts
import { getBackupFiles } from './backup.ts';

const files = getBackupFiles(); // [{name, size}, …] — *.backup, newest first; no .part
```

### Resolve the version-matched binary

```ts
import { resolvePgDump } from './backup.ts';

const pgDump = resolvePgDump();
// e.g. '/opt/homebrew/opt/postgresql@18/bin/pg_dump' when the server is v18
// and a matching install exists, else a bare 'pg_dump' from PATH
```

## Related

- [Architecture overview](../architecture_overview.md) — the work-PostgreSQL vs
  publication-MariaDB split this module only handles one side of.
- [area_maintenance](../areas/area_maintenance.md) — the widget that drives it.
- [db](db.md) — the database layer it dumps.
- [Sections](../sections/index.md) — the `matrix` tables inside the dump.
