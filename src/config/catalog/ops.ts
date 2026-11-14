/**
 * CONFIG CATALOG — domain: ops
 *
 * GENERATED SCAFFOLD (probe_emit_catalog.ts). Hand-edit from here on.
 */

import { join } from 'node:path';
import type { CatalogEntry } from '../catalog_types.ts';
import { privateDir } from '../env.ts';

export const OPS_KEYS = {
	DEDALO_ACCESS_LOG: {
		type: 'boolean',
		scope: 'operator',
		default: false,
		heading: 'Defining the access log',
		typeLabel: 'bool',
		doc: `With \`true\`, the engine writes **one JSON line per API request** to its standard output:
timestamp, request id, user id, the API class and action that was called, the response status
and the duration in milliseconds. A service manager captures it with the rest of the service
log, so it can be filtered and parsed with the usual tools.

Off by default: it is a line per request, and on a busy installation that is a lot of lines.
Turn it on when you need to see who called what — a suspicious edit, a user reporting an error
they cannot reproduce — and turn it off again afterwards.

Slow requests are warn-logged whatever this is set to (see \`DEDALO_SLOW_REQUEST_MS\`), so you
do not need the access log merely to notice that something is slow.

\`\`\`bash
DEDALO_ACCESS_LOG=false
\`\`\``,
	},
	DEDALO_BACKUP_DIR: {
		type: 'string',
		scope: 'operator',
		default: undefined,
		heading: 'Defining the database backups directory',
		typeLabel: 'string',
		doc: `Where the database dumps produced by the maintenance backup tool (and by a scheduled
nightly backup job) are written. Unset, they go to \`backups/db\` inside the private directory,
next to the configuration file and the session store.

Set it to move the dumps onto another volume: a backup that lives on the same disk as the
database it came from is not a backup. The directory must be writable by the user the engine
runs as, and it must never sit inside the tree the web server publishes — a dump is a complete,
unprotected copy of your data.

Remember that the database dump is only one piece: the media originals and the private directory
have to be copied too, or a restore will bring back records that point at files that no longer
exist. This key is distinct from \`DEDALO_BACKUP_PATH\`, which is where a code update stages the
previous code tree.

The engine's restore door (\`bun scripts/restore.ts <artifact>\`, run with the engine stopped) is
the way back: it proves the artifact by a full read, restores it in one transaction beside the
current database and swaps the two by name. Each run writes its report to a \`restores/\`
directory inside this one.

\`\`\`bash
DEDALO_BACKUP_DIR="/srv/backups/dedalo/db"
\`\`\``,
	},
	DEDALO_BACKUP_PATH: {
		type: 'string',
		scope: 'operator',
		default: undefined,
		heading: 'Defining backups directory',
		typeLabel: 'string',
		doc: `This parameter defines the directory a code update stages the previous tree into
before swapping in a new release, so a failed update can be rolled back. Keep it
outside the served tree for security. Defaults to \`<install>/../backups/code\`.
This is distinct from \`DEDALO_BACKUP_DIR\`, which sets the directory for database
backups (see [Database connection](config_db.md)).

\`\`\`bash
DEDALO_BACKUP_PATH="/srv/dedalo/backups/code"
\`\`\``,
	},
	DEDALO_BACKUP_TIME_RANGE: {
		type: 'number',
		scope: 'operator',
		default: 8,
		heading: 'Defining backup time range',
		typeLabel: 'int',
		// (!) This entry used to describe a LOGIN-TRIGGERED BACKUP: "Dedalo check in every
		// user login if the last backup exceed this time lapse, in affirmative case, it will
		// create new one." That was v6's behaviour, inherited as prose and never as code.
		// Verified 2026-08-30 by reading the whole login path: nothing in the TS engine
		// starts a backup, on login or on any other event. So the sentence told an operator
		// that setting this key gave them periodic backups, when the only thing that makes a
		// backup on a schedule is `deploy/dedalo-backup.service` + `.timer` -- an operator
		// who trusted the manual had NO backups at all. Documenting what the key does is the
		// fix; implementing a multi-GB pg_dump on somebody's login is not (a nightly timer is
		// the right owner of that work, and it already exists).
		//
		// The two live readers, verified 2026-08-30 (kept HERE rather than in the rendered
		// prose: config.md is the operator's manual and internal paths are noise there) —
		// `backupFreshness` in src/core/update/preconditions.ts — applied by `requireFreshBackup`
		// as the waivable `update.refused` of a code update, and by `backupFreshnessWithin` as
		// the update panel's `backup_fresh` line (src/core/update/status.ts); and the non-forced branch of
		// `initBackupSequence` (src/core/area_maintenance/backup.ts), whose only engine
		// caller — the make_backup widget — always forces, so it does not fire today.
		doc: `This parameter is the **freshness threshold**, in hours, applied to database backups: it
decides when an existing backup is judged too old. It schedules NOTHING — no engine event, a
user login included, ever starts a backup.

Making the backups is the operating system's job — a nightly timer, described under
[Backups](../backup.md). What this value decides, verified against the code on
2026-08-30, is:

- **Whether a code update may proceed.** Applying a code release is REFUSED when the newest
  dump in the backup directory is older than this many hours, or when there is none at all:
  a code swap's rollback contract leans on there being a database to come back to. The
  operator can waive the refusal explicitly, and the update panel shows the same verdict
  before they start.
- **Whether the maintenance "Make backup" button would skip.** It never does today: that
  button always forces a dump, so the throttle it belongs to is not reached.

Age is judged by the modification time of the newest backup that PostgreSQL's own
\`pg_restore\` can read back end to end. A dump that is cut short, or whose read did not finish
within its time budget (see \`DEDALO_BACKUP_VERIFY_SECONDS_PER_GB\`), does not count, however
recent it is. Keep the value in step with how often the nightly job actually runs — set it
below the real interval and the updater refuses on an installation that is backing up
perfectly well.

\`\`\`bash
DEDALO_BACKUP_TIME_RANGE=8
\`\`\``,
	},
	DEDALO_BACKUP_VERIFY_SECONDS_PER_GB: {
		type: 'number',
		scope: 'operator',
		default: 60,
		heading: 'Defining the backup verification budget',
		typeLabel: 'int',
		// The reader is `verifyBudgetMs` (src/core/area_maintenance/backup.ts): budget =
		// max(60 s, ceil(size / 1 GiB) x this x 1000 ms), per pg_restore stage. Measured
		// 2026-08-30: a full read costs ~7.4 s per GB on this project's hardware, so the
		// default is ~8x headroom. A verification that runs out of budget is NOT a backup
		// (OPS-1, 2026-09-30): the code update refuses and names this key as the remedy,
		// which is why a slow-storage install needs a key rather than a permanent waiver.
		doc: `How long the engine may spend proving that a database backup can be restored, in
**seconds per gigabyte** of dump. Before a backup counts — for the code updater's "is there a
recent backup" check, for the update panel, and for a dump the maintenance button just made —
the engine reads the whole archive back with PostgreSQL's \`pg_restore\`, because only a full
read can tell a complete dump from one that stopped part way. That read gets this many seconds
for every started gigabyte, and never less than one minute.

A read that does not finish within its budget proves nothing, so that backup does **not**
count: the code updater refuses (it can still be waived explicitly) and says so, naming this
key. On an installation whose backups live on slow storage (a network share, a USB disk), raise
the value until the read fits; a verification that succeeded is remembered, so the cost is paid
once per backup file.

\`\`\`bash
DEDALO_BACKUP_VERIFY_SECONDS_PER_GB=60
\`\`\``,
	},
	DEDALO_DEBUG_API_ERRORS: {
		// Binary: the reader is `!== 'true'`, so unset IS false.
		type: 'boolean',
		scope: 'operator',
		default: false,
		heading: 'Defining debug detail for API errors',
		typeLabel: 'bool',
		typeSuffix: '(optional; development only)',
		doc: `When a request fails unexpectedly, the client is answered with a generic message and a
**request id**, while the exception text stays on the server, logged under that same id. This
is deliberate: the raw text of an error can carry query fragments, filesystem paths and internal
identifiers, and the request id is what lets you find the full story in the log without handing
any of it to the caller.

Set \`DEDALO_DEBUG_API_ERRORS=true\` and the exception text is **also** echoed in the response.
It is a convenience while developing, and a gift to an attacker anywhere else — every failed
request becomes a free description of your internals.

Unset (off) is the default and the only correct value on a shared or public installation.

\`\`\`bash
DEDALO_DEBUG_API_ERRORS=true
\`\`\``,
	},
	DEDALO_DEV_MODE: {
		type: 'boolean',
		scope: 'operator',
		default: false,
		heading: 'Defining development mode',
		typeLabel: 'bool',
		doc: `Marks this installation as a development server. With \`true\`, the client is told
it is talking to a development server so it takes the no-cache path instead of the offline
service-worker one, the readable, non-minified versions of the client libraries are served,
and the dev-only client libraries the browser test harness needs (mocha/chai) are served. The configuration widget in the maintenance
area reports the mode it resolved, so you can always check what a running server thinks it is.

This key is the SERVER's posture only. It does NOT control the debug/developer surfaces in the
interface (the info bar, the ontology/inspector shortcuts): those follow the LOGGED USER — a
user flagged \`is_developer\` in their record sees them, root (superuser) included. A
non-developer gets neither even on a development server — the surfaces follow the person, not
the box.

Default \`false\`, the production posture. Never \`true\` on a shared or public installation: it
switches the client off the offline cache and serves unminified libraries.

The real environment wins over the configuration file, so a single development run can be marked
without editing anything:

\`\`\`bash
DEDALO_DEV_MODE=true bun run dev
\`\`\``,
	},
	DEDALO_EXPORT_ARTIFACTS_DIR: {
		type: 'string',
		scope: 'operator',
		default: () => join(privateDir, 'export_artifacts'),
		defaultDoc: '`<private dir>/export_artifacts`',
		heading: 'Defining the export files directory',
		typeLabel: 'string',
		doc: `This parameter defines where the export tool builds the files a user downloads.

An export runs on the server as a background job: it walks every selected record, writes the
result to a working copy in this directory, and builds each download (CSV, TSV, HTML, XLSX, ODS,
the lossless NDJSON and the media ZIP) from that copy. Each user has a subdirectory of their own
and each export one more below it; only the user who ran an export can download its files.

Unset, the files go to \`export_artifacts\` inside the private directory. Point it at another
volume when exports are large: a full export of a big collection with many columns can take
gigabytes while it exists, and it is only ever temporary (see
\`DEDALO_EXPORT_ARTIFACTS_TTL_HOURS\`). The directory must be writable by the user the engine
runs as and must NEVER sit inside a tree the web server publishes — an export is a copy of your
records, and it is served only through the engine, after the owner and their read access have
been checked again. The engine enforces this: a directory that is, sits inside, or contains the
media directory, the client files or a tool directory (the in-repo tools and every
\`DEDALO_ADDITIONAL_TOOLS\` path — the engine serves those without a login) (symbolic links followed)
is refused, and no export is written until it is moved; the refusal is logged at start-up.

Give it a directory of its own, empty or not yet created. The engine deletes expired exports
here every hour, so it only works in a directory it owns: on first use it leaves a
\`.dedalo_export_artifacts\` marker file in an empty directory. A directory that already
holds other files and has no marker is refused, and nothing in it is written or deleted.

Each installation needs its OWN directory. The marker records which installation claimed it
(a fingerprint of its database), and a directory another installation's marker names is
refused by every door — listing, preview, download, sweep — so two instances that copied the
same example path never see or delete each other's exports.

\`\`\`bash
DEDALO_EXPORT_ARTIFACTS_DIR="/srv/dedalo_exports"
\`\`\``,
	},
	DEDALO_EXPORT_ARTIFACTS_QUOTA_BYTES: {
		type: 'number',
		scope: 'operator',
		default: 10737418240,
		clamp: { min: 0 },
		heading: 'Defining the export storage quota per user',
		typeLabel: 'int',
		doc: `This parameter defines how many bytes of export files one user may hold at the same time.

Every export a user runs keeps its working copy and its built files on the server until they
expire. When a new export, or a new file of an existing one, would take the user past this
amount, it is refused with a message that says so, and succeeds again once the user deletes an
older export from the export tool (Delete export, which removes it with all its files) or older
exports have expired. Ten gigabytes by default, which holds several complete exports of a large
collection.

The quota counts all of a user's exports together, including several running at the same time.

Set \`0\` to switch the quota off. Size the volume of \`DEDALO_EXPORT_ARTIFACTS_DIR\` for this
amount times the number of users who export at once.

\`\`\`bash
DEDALO_EXPORT_ARTIFACTS_QUOTA_BYTES=10737418240
\`\`\``,
	},
	DEDALO_EXPORT_ARTIFACTS_TTL_HOURS: {
		type: 'number',
		scope: 'operator',
		default: 24,
		clamp: { min: 1 },
		heading: 'Defining how long export files are kept',
		typeLabel: 'int',
		doc: `This parameter defines how many hours the files of a finished export are kept before they
are deleted.

An export expires this many hours after it FINISHED (ended, failed, was stopped or was
interrupted). It is a hard limit: building a file from the export later (a spreadsheet, a media
zip) does NOT extend it, so a file built an hour before the limit disappears with the export. From
that moment the export and its files are gone for their owner (preview, list and downloads answer
not-found at once), and the sweep — when the engine starts and every hour after that — deletes
the directory; it only waits while a file is still being built from it. An export still running is never touched while the server running it is alive; one left behind
by a server that stopped or restarted is marked interrupted and its partial files are removed
(the user runs it again). Twenty-four hours by default: long enough to come back
the next day for a download, short enough that copies of the collection do not pile up on the
server. Values below 1 are raised to 1.

\`\`\`bash
DEDALO_EXPORT_ARTIFACTS_TTL_HOURS=24
\`\`\``,
	},
	DEDALO_EXPORT_ARTIFACTS_MAX_EXPORTS: {
		type: 'number',
		scope: 'operator',
		default: 100,
		clamp: { min: 0 },
		heading: 'Defining how many exports one user may keep',
		typeLabel: 'int',
		doc: `This parameter defines how many exports one user may keep on the server at the same time.

The storage quota (\`DEDALO_EXPORT_ARTIFACTS_QUOTA_BYTES\`) counts bytes, and a tiny export
takes almost none: without this limit one user could keep a very large number of small exports,
and every listing of their exports would have to read all of them. When a new export would go
past this number it is refused with a message that says so, and succeeds again once the user
deletes an older export from the export tool or older exports have expired. One hundred by
default, far more than anyone needs within the lifetime of an export
(\`DEDALO_EXPORT_ARTIFACTS_TTL_HOURS\`).

Set \`0\` to switch the limit off.

\`\`\`bash
DEDALO_EXPORT_ARTIFACTS_MAX_EXPORTS=100
\`\`\``,
	},
	DEDALO_EXPORT_ARTIFACTS_MIN_FREE_BYTES: {
		type: 'number',
		scope: 'operator',
		default: 1073741824,
		clamp: { min: 0 },
		heading: 'Defining the free space exports always leave on their volume',
		typeLabel: 'int',
		doc: `This parameter defines how many bytes must always stay free on the volume that holds the export
files (\`DEDALO_EXPORT_ARTIFACTS_DIR\`).

The storage quota is per user, so several users together can hold far more than one quota. By
default the export files live inside the private directory, next to the session store and the
installation's settings: if that volume filled up, logins and saved settings would fail for
everyone. So an export, or a file built from one, that would leave less than this amount free
is refused (and one already writing stops) with a message saying the server is short of space,
whatever the users' quotas. One gigabyte by default.

Set \`0\` to switch the check off (only when the export directory is on a volume of its own).

\`\`\`bash
DEDALO_EXPORT_ARTIFACTS_MIN_FREE_BYTES=1073741824
\`\`\``,
	},
	DEDALO_EXPORT_PREVIEW_PAGE_SIZE: {
		type: 'number',
		scope: 'operator',
		default: 100,
		clamp: { min: 1, max: 200 },
		heading: 'Defining the export preview page size',
		typeLabel: 'int',
		doc: `This parameter defines how many records the export tool shows per page in its preview when
the user has not chosen a size.

The preview shows one page of the export at a time, whatever the size of the export, so the
browser stays responsive with hundreds of thousands of records; the downloads always contain
every record. One hundred by default. The value is kept between 1 and 200, the most the preview
will ever draw at once.

\`\`\`bash
DEDALO_EXPORT_PREVIEW_PAGE_SIZE=100
\`\`\``,
	},
	DEDALO_EXPORT_JOBS_PER_USER: {
		type: 'number',
		scope: 'operator',
		default: 2,
		clamp: { min: 1 },
		heading: 'Defining how many export jobs one user may queue',
		typeLabel: 'int',
		doc: `This parameter defines how many export jobs one user may have waiting or running at the same
time: exports being built plus files being built from them.

Export jobs share two queues (see \`DEDALO_JOB_LANE_EXPORT_CONCURRENCY\` and
\`DEDALO_JOB_LANE_EXPORT_FILE_CONCURRENCY\`), so without a limit one user could queue many complete
exports of a large collection and make everybody else wait behind them.
A request over the limit is refused at once with a message that says so, and nothing is queued;
the user can start it again when one of their jobs has finished. Two by default: an export being
built and a file being built from an earlier one. Exports still being built never block
downloading a file of an export that has already finished: a file build is counted only against
the user's other file builds.

\`\`\`bash
DEDALO_EXPORT_JOBS_PER_USER=2
\`\`\``,
	},
	DEDALO_JOB_DEADLINE_EXPORT_S: {
		type: 'number',
		scope: 'operator',
		default: 0,
		heading: 'Defining the export job deadline',
		typeLabel: 'int',
		doc: `This parameter defines how long, in seconds, an export job may run before Dédalo cancels it.

There is NO deadline by default (\`0\`): a complete export of a large collection with deep
relations is legitimately long work, the user who started it can stop it at any time, and a
deadline that cancelled it near the end would throw that work away.

Set it on an installation that knows its own ceiling, to turn an export that has stopped making
progress into a reported one instead of a lane that stays busy.

\`\`\`bash
DEDALO_JOB_DEADLINE_EXPORT_S=0
\`\`\``,
	},
	DEDALO_JOB_DEADLINE_EXPORT_FILE_S: {
		type: 'number',
		scope: 'operator',
		default: 0,
		heading: 'Defining the export file job deadline',
		typeLabel: 'int',
		doc: `This parameter defines how long, in seconds, a job that builds a file from a finished export
(a CSV, spreadsheet, HTML page or media ZIP) may run before Dédalo cancels it.

There is NO deadline by default (\`0\`): a media ZIP of a large selection copies every media file
into the archive, which is legitimately long, and the user who started it can stop it at any time.

\`\`\`bash
DEDALO_JOB_DEADLINE_EXPORT_FILE_S=0
\`\`\``,
	},
	DEDALO_JOB_DEADLINE_MAINTENANCE_S: {
		type: 'number',
		scope: 'operator',
		default: 21600,
		heading: 'Defining the maintenance job deadline',
		typeLabel: 'int',
		doc: `This parameter defines how long, in seconds, a maintenance job may run before Dédalo cancels it.

Maintenance jobs are the work an administrator starts: a code or data update, a cache rebuild, a
bulk import, a value propagated across records. Six hours by default, which is generous for a
full cache rebuild of a large collection and far more than any update needs. A job that passes
its deadline is asked to stop and its record is marked stopped, so the lane is not held for ever
by work that will never finish.

Set it to \`0\` to switch the deadline off, on an installation whose imports legitimately run
longer than the default. Raise it rather than switching it off if you can name the ceiling: a
deadline is what turns a wedged job into a reported one.

\`\`\`bash
DEDALO_JOB_DEADLINE_MAINTENANCE_S=21600
\`\`\``,
	},
	DEDALO_JOB_DEADLINE_MEDIA_S: {
		type: 'number',
		scope: 'operator',
		default: 0,
		heading: 'Defining the media job deadline',
		typeLabel: 'int',
		doc: `This parameter defines how long, in seconds, a media job may run before Dédalo cancels it.

There is NO deadline by default (\`0\`), and that is deliberate: transcoding a master video is
legitimately hours of work, and a deadline that killed it would be the fault, not the guard.

Set it on an installation that knows its own ceiling — if nothing you hold should ever take more
than two hours to convert, \`7200\` turns a stuck conversion into a reported one instead of a lane
that stays busy for ever. Note that the cancellation reaches the job itself; a conversion program
already running as a separate process finishes its own work, and the fact that it is still
holding its lane is reported in the counters.

\`\`\`bash
DEDALO_JOB_DEADLINE_MEDIA_S=0
\`\`\``,
	},
	DEDALO_JOB_DEADLINE_RAG_S: {
		type: 'number',
		scope: 'operator',
		default: 3600,
		heading: 'Defining the index job deadline',
		typeLabel: 'int',
		doc: `This parameter defines how long, in seconds, an index-building job may run before Dédalo
cancels it.

These are the jobs that compute the semantic index used by assisted search and by object
identification. One hour by default, which comfortably covers a pass over a single group of
records. A job that passes its deadline is asked to stop and its record is marked stopped.

Set it to \`0\` to switch the deadline off, or raise it when you index very large groups in one
go.

\`\`\`bash
DEDALO_JOB_DEADLINE_RAG_S=3600
\`\`\``,
	},
	DEDALO_JOB_DEADLINE_TRANSCRIPTION_S: {
		type: 'number',
		scope: 'operator',
		default: 14400,
		heading: 'Defining the transcription job deadline',
		typeLabel: 'int',
		doc: `This parameter defines how long, in seconds, a transcription job may run before Dédalo
cancels it.

Transcription jobs wait on the speech-to-text service, so they are mostly idle time; four hours
by default, which covers a long interview with room to spare. A batch that runs longer than this
is almost always a service that has stopped answering rather than work still in progress, and
the deadline turns that into a stopped job with a reason instead of a lane held for ever.

Set it to \`0\` to switch the deadline off.

\`\`\`bash
DEDALO_JOB_DEADLINE_TRANSCRIPTION_S=14400
\`\`\``,
	},
	DEDALO_JOB_LANE_EXPORT_CONCURRENCY: {
		type: 'number',
		scope: 'operator',
		default: 1,
		heading: 'Defining export job concurrency',
		typeLabel: 'int',
		doc: `This parameter defines how many export jobs Dédalo will run at the same time.

Background work in Dédalo runs in lanes, and each class of work has its own budget of
simultaneous jobs. Exports have a lane of their own because any user who can read a section can
start one: a large export must never hold up the maintenance work an administrator is waiting
on, nor the media conversions of an upload.

One by default. An export reads every selected record and writes a working copy the size of the
result, so two at once mostly share the same database and disk; the others wait their turn and
their users see them queued. Raise it on a machine with cores and disk to spare. Values below 1
are raised to 1.

An export also holds one database connection open for its whole run while it reads its selection,
and each server process allows at most a quarter of \`DB_POOL_MAX\` such reads at once (at least
one): the number of exports that actually read at the same time is the smaller of this budget and
that share. A job beyond it waits, still shown as running, until another export frees its
connection — it never fails for that reason. Raise \`DB_POOL_MAX\` together with this value.

\`\`\`bash
DEDALO_JOB_LANE_EXPORT_CONCURRENCY=1
\`\`\``,
	},
	DEDALO_JOB_LANE_EXPORT_FILE_CONCURRENCY: {
		type: 'number',
		scope: 'operator',
		default: 2,
		heading: 'Defining export file job concurrency',
		typeLabel: 'int',
		doc: `This parameter defines how many files Dédalo will build from finished exports at the same time
(the CSV, TSV, HTML, spreadsheet, NDJSON and media ZIP downloads).

These jobs have a lane of their own, separate from the exports themselves. If they shared one
queue, every user's download would wait behind someone else's complete export of a large
collection. The CSV, TSV, HTML, spreadsheet and NDJSON files read only the finished export, never
the database, and usually take seconds where an export can take hours. The media ZIP is
different: for every record it reads the database again (the record's access and its stored
media) and it copies every media file, so on a large selection it can run for hours and keeps
database connections busy all that time. Size this value, and the database pool, with that in
mind.

Two by default, so one large media ZIP does not make the next user's CSV wait. To keep that true
whoever submits, one user may hold every slot of this lane but one (with the default two: one file
at a time per user); a second file from the same user is refused until the first finishes. With
the value 1 the single slot is shared first come, first served. Values below 1 are raised to 1.

\`\`\`bash
DEDALO_JOB_LANE_EXPORT_FILE_CONCURRENCY=2
\`\`\``,
	},
	DEDALO_JOB_LANE_MAINTENANCE_CONCURRENCY: {
		type: 'number',
		scope: 'operator',
		default: 2,
		heading: 'Defining maintenance job concurrency',
		typeLabel: 'int',
		doc: `This parameter defines how many maintenance jobs Dédalo will run at the same time.

Background work in Dédalo runs in lanes, and each class of work has its own budget of
simultaneous jobs: media derivatives, transcription, index building and the maintenance work an
administrator starts by hand. The lanes are independent on purpose — a queue of video
transcodes must never be able to hold up the code update you are waiting for.

Maintenance is the administrator's own lane: code and data updates, cache rebuilds, imports,
propagations. Two by default, so that starting an import does not have to wait for a cache
rebuild to finish. Values below 1 are raised to 1.

\`\`\`bash
DEDALO_JOB_LANE_MAINTENANCE_CONCURRENCY=2
\`\`\``,
	},
	DEDALO_JOB_LANE_RAG_CONCURRENCY: {
		type: 'number',
		scope: 'operator',
		default: 2,
		heading: 'Defining index job concurrency',
		typeLabel: 'int',
		doc: `This parameter defines how many index-building jobs Dédalo will run at the same time.

Background work in Dédalo runs in lanes, and each class of work has its own budget of
simultaneous jobs: media derivatives, transcription, index building and the maintenance work an
administrator starts by hand. The lanes are independent on purpose — a queue of video
transcodes must never be able to hold up the code update you are waiting for.

This lane builds the semantic index used by assisted search and object identification. Two by
default. Raise it if you index frequently and the machine has cores to spare; lower it to 1 to
keep the index work out of the way of everything else. Values below 1 are raised to 1.

\`\`\`bash
DEDALO_JOB_LANE_RAG_CONCURRENCY=2
\`\`\``,
	},
	DEDALO_JOB_LANE_TRANSCRIPTION_CONCURRENCY: {
		type: 'number',
		scope: 'operator',
		default: 2,
		heading: 'Defining transcription job concurrency',
		typeLabel: 'int',
		doc: `This parameter defines how many transcription jobs Dédalo will run at the same time.

Background work in Dédalo runs in lanes, and each class of work has its own budget of
simultaneous jobs: media derivatives, transcription, index building and the maintenance work an
administrator starts by hand. The lanes are independent on purpose — a queue of video
transcodes must never be able to hold up the code update you are waiting for.

Transcription jobs spend nearly all their time waiting on the speech-to-text service rather than
using this machine, so their slots are cheap to hold: two by default, which keeps a short
recording from queueing behind a long interview. Raise it if your transcription service handles
several requests at once. Values below 1 are raised to 1.

\`\`\`bash
DEDALO_JOB_LANE_TRANSCRIPTION_CONCURRENCY=2
\`\`\``,
	},
	DEDALO_RECONCILE_SCHEDULER_ENABLED: {
		type: 'boolean',
		scope: 'operator',
		default: true,
		heading: 'Reconcile scheduler',
		typeLabel: 'bool',
		doc: `Whether **this** server runs the scheduled cross-store reconciles by itself: the
boot-class ones after it starts listening and the interval-class ones on their period (the
publication-marker index, which re-derives the web server's \`pub/\` markers from the
per-target truth, runs at both: after the listen and every 10 minutes). A run that had to wait
for a publication in progress past its bound is tried again a minute later, until it completes.
Every outcome is published under \`reconcile\` on \`/api/v1/counters\`
and listed by the **Reconcile** maintenance widget, which — like \`bun scripts/reconcile.ts\` —
keeps working with the scheduler off; only the automatic runs stop.

Enabled by default. Set it to \`false\` on an instance that must not touch a shared store — a
maintenance or smoke-test copy that shares the database or the media tree with the live
installation, where a boot-time repair from the wrong root would do harm.

\`\`\`bash
DEDALO_RECONCILE_SCHEDULER_ENABLED=false
\`\`\``,
	},
	DEDALO_ACTIVITY_RETENTION_DAYS: {
		type: 'number',
		scope: 'operator',
		default: 0,
		heading: 'Activity log retention',
		typeLabel: 'int',
		doc: `How many days of \`matrix_activity\` rows this installation keeps. Every
state-changing action appends one row — and so does every DENIED login, which nobody has to
be authenticated to cause — so the table grows with use and with abuse alike, inside the
database every backup copies.

The default is \`0\`: **keep everything**. That is the right default for a heritage archive,
because the activity log is the record of who changed what. The key exists so an institution
that has decided otherwise can say so, and so that the deletion is performed by the engine
(the retention scheduler, or \`bun scripts/reconcile.ts\`-style operator surfaces) rather than
by hand-written SQL against the matrix.

\`\`\`bash
DEDALO_ACTIVITY_RETENTION_DAYS=1095
\`\`\``,
	},
	DEDALO_DIFFUSION_LEDGER_RETENTION_DAYS: {
		type: 'number',
		scope: 'operator',
		default: 0,
		heading: 'Publication ledger retention',
		typeLabel: 'int',
		doc: `How many days of SETTLED rows the \`dd1758\` publication ledger keeps. The ledger
appends one row per record per publish run — republishing the same catalogue writes them all
again — so it grows linearly with how often you publish, not with how much you hold.

PENDING rows (an unpublish still owed to a public target) are NEVER pruned, whatever this is
set to: they are outstanding debt, not history.

The default is \`0\`: keep everything. Set a window if your publication history does not need
to be permanent — but the inspector's *Published (first/last)* row reads this ledger, so with a
window set "first" becomes the oldest publication still kept, not the first ever.

\`\`\`bash
DEDALO_DIFFUSION_LEDGER_RETENTION_DAYS=365
\`\`\``,
	},
	DEDALO_RETENTION_SCHEDULER_ENABLED: {
		type: 'boolean',
		scope: 'operator',
		default: true,
		heading: 'Retention scheduler',
		typeLabel: 'bool',
		doc: `Whether **this** server applies the configured retention windows by itself, once
after boot and then daily. With every window at its default (\`0\` = keep everything) it has
nothing to do, so leaving it on costs nothing and means that the day an operator sets a
window, it takes effect.

Set it to \`false\` on an instance that shares a database with the live installation — a
maintenance or smoke-test copy — where a scheduled delete would act on data it does not own.

\`\`\`bash
DEDALO_RETENTION_SCHEDULER_ENABLED=false
\`\`\``,
	},
	DEDALO_SLOW_REQUEST_MS: {
		type: 'number',
		scope: 'operator',
		default: 5000,
		heading: 'Defining the slow request threshold',
		typeLabel: 'int',
		doc: `Any API request that takes longer than this, in milliseconds, is warn-logged with its
duration, the API call, the request id and the user — and counted, so the count also shows up in
the server counters. This happens whether or not the access log is on.

Default \`5000\` (5 seconds): slow enough that a healthy installation stays quiet, fast enough to
notice a query that has started to degrade. Lower it while hunting a latency problem; raise it if
one genuinely heavy operation is flooding the log with noise you have already accounted for. Set
\`0\` to disable the warning entirely.

\`\`\`bash
DEDALO_SLOW_REQUEST_MS=5000
\`\`\``,
	},
	UPDATE_LOG_FILE: {
		type: 'string',
		scope: 'operator',
		default: undefined,
		heading: 'Update log file',
		typeLabel: 'string',
		doc: `Defines the directory path to store the update log.

The maintenance update process uses the update log to store the status of each update task. This log is useful to know what happens in the update process. If the update fails, you can consult the last status to restore the update process at this last point.

Defaults to \`update.log\` inside \`../private\`. If you move it elsewhere, keep the
directory private and outside the served tree.

\`\`\`bash
UPDATE_LOG_FILE="/srv/dedalo/private/update.log"
\`\`\``,
	},
} as const satisfies Record<string, CatalogEntry>;
