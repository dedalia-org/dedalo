/**
 * Database backup (PHP core/backup/class.backup.php init_backup_sequence +
 * get_backup_files, behind the make_backup maintenance widget) — TS-NATIVE:
 * the server dumps the application database with its own pg_dump into its
 * backup directory (`getBackupDir`: DEDALO_BACKUP_DIR, else
 * <privateDir>/backups/db). File naming and the custom-format dump command
 * keep the PHP-era shape, so existing backup sets stay readable:
 *
 *   <Y-m-d_His>.<db>.postgresql_<user>_forced_dbv<maj-min-patch>.custom.backup
 *   pg_dump -F c -b -f <that name>.part <db>  (spawned detached)
 *
 * The throttled (non-forced) window naming (<Y-m-d_H>… + the 8h
 * DEDALO_BACKUP_TIME_RANGE guard) applies when skipTimeRange is false.
 *
 * FRESHNESS IS NOT USABILITY (audit P0-13, 2026-08-30). Until that date the
 * only thing this module asked of a finished dump was `existsSync && size > 0`,
 * so a pg_dump killed at 60% left an artifact that the widget listed, that
 * `newestBackupMtimeMs` counted, and that satisfied the code-update
 * precondition — the operator swapped the whole code tree believing they had a
 * restore point. The restore-point verdict now lives in
 * `verifyBackupArtifact` / `newestUsableBackup` at the foot of this file, and
 * `newestBackupMtimeMs` keeps its honest, narrow meaning: RECENCY only.
 *
 * A DUMP IN FLIGHT IS NOT A BACKUP (OPS-2, 2026-09-30): pg_dump writes
 * `<final>.part`, and only two doors ever give bytes the final name — see THE
 * NAME GRAMMAR below for what each door proves. An orphaned part is adopted by a
 * full read, never deleted. ONE VERDICT (OPS-1, 2026-09-30): every "is this a
 * restore point" question is the full `pg_restore` read, asked asynchronously,
 * shared, serialized and budgeted — see the verification section's header.
 */

import {
	closeSync,
	existsSync,
	linkSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	realpathSync,
	renameSync,
	statSync,
	unlinkSync,
} from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { config } from '../../config/config.ts';
import { privateDir } from '../../config/env.ts';
import { libpqTransportArgs, resolvePgTransport } from '../../config/pg_transport.ts';
import { sql } from '../db/postgres.ts';
import { DedaloError } from '../errors/index.ts';
import { DirectoryBarrier, fsyncDirectory, writeFileDurably } from '../files/durable.ts';
import { type JobRecord, jobAbortInfo, mediaJobs } from '../media/jobs.ts';

/** Minimum hours between throttled backups (PHP DEDALO_BACKUP_TIME_RANGE). */
const BACKUP_TIME_RANGE_HOURS = config.ops.backupTimeRangeHours;

/**
 * The TS server's own backup directory: DEDALO_BACKUP_DIR override, else
 * <privateDir>/backups/db — derived from the SAME privateDir constant the
 * session store and .env use, never from the process cwd (audit S2-35: the
 * old cwd-based guess silently changed with the launch directory).
 */
export function getBackupDir(): string {
	const declared = config.ops.backupDir;
	if (typeof declared === 'string' && declared !== '') return declared;
	return join(privateDir, 'backups', 'db');
}

/**
 * The installed data version from matrix_updates, STRICT (OPS-6): `[]` ONLY
 * when the table does not exist (42P01, a fresh install); any other failure
 * propagates. The update engine's in-transaction re-read uses this — a
 * transient read error must never look like "no version" to a migration.
 */
export async function readInstalledDataVersionStrict(): Promise<number[]> {
	try {
		// (!) `WHERE data ? 'dedalo_version'`: matrix_updates also carries NON-version
		// rows (the section_id_int_normalize marker, WC-2026-08-10-section-id-int-canonical) — without the guard their NULL version sorts FIRST under DESC
		// (Postgres NULLS FIRST default) and version detection silently breaks.
		const rows = (await sql.unsafe(
			`SELECT data FROM "matrix_updates"
			 WHERE data ? 'dedalo_version'
			 ORDER BY string_to_array(data->>'dedalo_version', '.')::int[] DESC LIMIT 1`,
			[],
		)) as { data: { dedalo_version?: string } | null }[];
		const version = rows[0]?.data?.dedalo_version;
		return typeof version === 'string' ? version.split('.').map((part) => Number(part)) : [];
	} catch (error) {
		if ((error as { errno?: unknown } | null)?.errno === '42P01') return [];
		throw error;
	}
}

/**
 * Current data version from matrix_updates (PHP get_current_data_version) —
 * the PANEL read: any failure reports `[]` (PHP behavior; the panel bytes of a
 * fresh or broken install stay what they were).
 */
export async function getCurrentDataVersion(): Promise<number[]> {
	try {
		return await readInstalledDataVersionStrict();
	} catch {
		return [];
	}
}

/* ------------------------------------------------------------------------- *
 * THE NAME GRAMMAR (OPS-2, audit 2026-09-26) — built ONCE, here.
 *
 * Until 2026-09-30 the grammar lived twice (this module and the make_backup
 * widget's own literal), so the panel could advertise one name while the dump
 * landed at another. And pg_dump's `-f` pointed straight at the FINAL name: for
 * the whole life of a dump — minutes to hours — a partial archive sat under the
 * one suffix every scanner matches. The widget listed it, the freshness scan
 * judged it, and a second claimant of the same name judged the LIVE dump
 * "disproved" (a header-only prefix is not an archive yet) and retired it from
 * under its own pg_dump.
 *
 * THE LAW NOW: in-flight bytes live at `<final>.part` (claimed atomically,
 * `open wx`), and exactly TWO doors give a part of ours a `.backup` name — never
 * over an existing file (`renameNoClobber`). They do NOT prove the same thing:
 *
 * - `publishDump` (our own dump, whose exit status we saw): pg_dump exited 0 AND
 *   - a full read proved the bytes → PROVEN (`<final>.verified` sidecar), or
 *   - the read could not LOOK (no pg_restore on this host, or it outran its
 *     budget) → COMPLETED, UNVERIFIED (no sidecar; every later freshness ask
 *     reads it afresh, and a timed-out read does not count as a restore point);
 * - `adoptOrphanedParts` (a part whose writer's exit status nobody saw): a full
 *   read alone proved the bytes → PROVEN (sidecar). Nothing else is adopted.
 *
 * So a `*.backup` of ours is either proven by a full read (sidecar present) or a
 * dump that exited 0 and has not been read yet — never a dump known to have
 * failed. `deploy/dedalo-db-backup.sh` follows the same `.part` → full read →
 * rename shape for the nightly timer's dumps (it has no unverified door: without
 * a completed read it refuses).
 * ------------------------------------------------------------------------- */

/** The suffix of every dump this engine writes (the PHP-era custom format). */
export const BACKUP_SUFFIX = '.custom.backup';

/** Appended to a dump's final name while pg_dump is still writing it. */
export const PART_SUFFIX = '.part';

/** An in-flight `.part` older than this is an orphan of a dead process (deploy/ sweeps the same). */
const PART_ORPHAN_AGE_MS = 24 * 3_600_000;

function timestampName(now: Date, forced: boolean): string {
	const pad = (value: number) => String(value).padStart(2, '0');
	const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
	return forced
		? `${date}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
		: `${date}_${pad(now.getHours())}`;
}

/**
 * THE dump file name (PHP init_backup_sequence's shape, so existing backup sets
 * stay readable): `<Y-m-d_His>.<db>.postgresql_<user>[_forced]_dbv<maj-min-patch>.custom.backup`,
 * with an hour-only stamp for a throttled (non-forced) dump.
 */
export function backupFileName(parts: {
	now: Date;
	database: string;
	userId: number;
	forced: boolean;
	version: number[];
}): string {
	return `${timestampName(parts.now, parts.forced)}.${parts.database}.postgresql_${parts.userId}${
		parts.forced ? '_forced' : ''
	}_dbv${parts.version.join('-')}${BACKUP_SUFFIX}`;
}

/** Where the bytes of a dump destined for `finalPath` live while pg_dump writes them. */
export function inFlightName(finalPath: string): string {
	return `${finalPath}${PART_SUFFIX}`;
}

/**
 * Does this directory entry name a backup ARTIFACT? The one predicate every
 * scanner here uses: `.part` (in flight), `.log`, `.verified` and `.failed`
 * siblings all fall outside it by construction.
 */
export function isBackupArtifactName(name: string): boolean {
	return name.endsWith('.backup');
}

/** What follows `<stamp>.<db>.` in a PANEL dump's name (`backupFileName`, forced or throttled). */
const PANEL_DUMP_TAIL = /^postgresql_-?\d+(_forced)?_dbv[\d-]*\.custom\.backup$/;

/** What follows `<stamp>.<db>.` in a SCHEDULED dump's name (deploy/dedalo-db-backup.sh `--label`). */
const LABELLED_DUMP_TAIL = /^postgresql_[^/]+\.custom\.backup$/;

/**
 * The newest SCHEDULED dump of `database` in `backupDir`, or null when every
 * dump there was made from the panel (or there is none).
 *
 * THE ENGINE SCHEDULES NOTHING (DEDALO_BACKUP_TIME_RANGE's catalog entry): a
 * backup on a schedule is the OS's job — `deploy/dedalo-backup.timer`, the
 * compose `backup` service, or the operator's own cron — and none of those is
 * visible from here, nor portably probeable (systemd, launchd, cron, a sidecar
 * container). What IS visible is their output: deploy/dedalo-db-backup.sh names
 * its dumps `<stamp>.<db>.postgresql_<label>.custom.backup`, the panel names
 * them `…postgresql_<user>[_forced]_dbv<v>.custom.backup`. So this answers "has a
 * scheduler EVER delivered a dump of this database here" — evidence, not
 * configuration: a timer installed today and not yet fired reads as null, and a
 * scheduler that died long ago still reads as found (its age is the panel's
 * staleness line, not this one). Another database's dumps never count: a job
 * backing up `mht` does not back up this one.
 */
export function newestScheduledBackupName(
	database: string,
	backupDir: string = getBackupDir(),
): string | null {
	const scheduled = statableBackups(backupDir)
		.map(({ name }) => name)
		.filter((name) => isScheduledDumpOf(name, database));
	// Newest BY NAME (the timestamp leads it), as getBackupFiles lists them.
	// biome-ignore lint/complexity/useMathMinMax: STRINGS compared by code unit — Math.max would coerce them to NaN.
	return scheduled.length === 0 ? null : scheduled.reduce((a, b) => (b > a ? b : a));
}

/** `<stamp>.<database>.<labelled tail>` — and the tail is not the panel's. */
function isScheduledDumpOf(name: string, database: string): boolean {
	const dot = name.indexOf('.');
	if (dot < 0 || !name.startsWith(`${database}.`, dot + 1)) return false;
	const tail = name.slice(dot + database.length + 2);
	return LABELLED_DUMP_TAIL.test(tail) && !PANEL_DUMP_TAIL.test(tail);
}

export interface BackupResponse {
	/** Did the sequence start (or legitimately skip)? An INTERNAL outcome — never a wire body. */
	ok: boolean;
	msg: string;
	errors: string[];
	/** The poll handle's pid: the job's OWNER (this server), never the pg_dump child. */
	pid?: number;
	/** The FINAL name — it exists only once the dump has been promoted. */
	file_path?: string;
	/** Process-record basename inside ../private/processes — the handle the
	 * copied make_backup widget polls via dd_utils_api:get_process_status. */
	pfile?: string;
}

/** Test-injection seams (production callers pass nothing). */
export interface BackupOverrides {
	backupDir?: string;
	pgDumpBin?: string;
	/** ms to wait for a FAST failure before reporting the background pid. */
	fastFailWindowMs?: number;
	/** pg_restore used to VERIFY the finished artifact (P0-13). `null` = the
	 * machine has none, which degrades to "unverifiable", never to a lie. */
	pgRestoreBin?: string | null;
	/** Overrides the size-scaled verification budget (VerifyOptions.budgetMs). */
	budgetMs?: number;
	/** The clock the FILE NAME is stamped with (only the name — every age test reads the real clock). */
	now?: Date;
}

/** The last N lines of the sidecar .log, for surfacing pg_dump's own words. */
function logTail(logPath: string, lines = 5): string {
	try {
		return readFileSync(logPath, 'utf-8').trim().split('\n').slice(-lines).join('\n');
	} catch {
		return '';
	}
}

/**
 * Newest `*.backup` mtimeMs in the backup dir (0 = none) — RECENCY ONLY.
 *
 * FRESHNESS IS NOT USABILITY: this answers "when was something last written
 * here", never "is there a restore point". A dump that died at 60% has the
 * freshest mtime of all. Every caller that must know whether a RESTORE POINT
 * exists — the throttle below and core/update/preconditions.ts — asks
 * `newestUsableBackup` instead (P0-13). Kept exported and unchanged because it
 * is also the honest answer to the narrow question, and
 * test/unit/backup_recency_native.test.ts pins it.
 */
export function newestBackupMtimeMs(backupDir: string = getBackupDir()): number {
	let newest = 0;
	for (const artifact of statableBackups(backupDir)) {
		if (artifact.mtimeMs > newest) newest = artifact.mtimeMs;
	}
	return newest;
}

interface StatableBackup {
	name: string;
	path: string;
	mtimeMs: number;
	size: number;
}

/**
 * The backup ARTIFACTS in `backupDir` that can actually be stat'd — the ONE
 * directory walk every listing here is built on (recency, the widget list, the
 * verification scan). An absent or unreadable directory is simply empty.
 *
 * Per-entry guard: an unstatable entry — a dangling symlink to backup storage
 * that has been moved or unmounted, or a rotation cron deleting between readdir
 * and stat — used to throw ENOENT out of the WHOLE scan, into the code-update
 * path and the panel. A file that cannot be stat'd is not a restore point either
 * way.
 */
function statableBackups(backupDir: string): StatableBackup[] {
	let names: string[];
	try {
		names = readdirSync(backupDir);
	} catch {
		return [];
	}
	const artifacts: StatableBackup[] = [];
	for (const name of names) {
		if (!isBackupArtifactName(name)) continue;
		const path = join(backupDir, name);
		try {
			const stats = statSync(path);
			artifacts.push({ name, path, mtimeMs: stats.mtimeMs, size: stats.size });
		} catch {
			/* gone or unreadable */
		}
	}
	return artifacts;
}

/**
 * The in-flight parts THIS process has claimed and not yet settled (absolute
 * paths). The orphan adoption never judges one of them, whatever its age: a dump
 * blocked on a lock can sit quiet for a long time and is still ours.
 */
const partsInFlight = new Set<string>();

/**
 * Orphan adoptions in flight, keyed on the resolved directory: concurrent dumps
 * into one directory share ONE pass (each orphan is a full read). No request
 * identity; deleted when the pass settles.
 */
const adoptionInFlight = new Map<string, Promise<void>>();

/**
 * ADOPT the orphaned in-flight dumps of `backupDir` — NEVER delete them (OPS-2
 * review, 2026-09-30).
 *
 * A server restart under `KillMode=process` leaves a running pg_dump alive, but
 * the continuation that would have promoted its `.part` died with the old
 * process. The dump may well finish, exit 0 and be a complete restore point; the
 * first cut of OPS-2 unlinked it after 24 h, which destroyed a backup the pre-fix
 * engine would have kept. The law of this module is that a dump's bytes are
 * never removed, so an orphan is JUDGED instead, by the one question (the full
 * read):
 *
 * - `verified_deep` and the final name is free → promoted (proof, then the name,
 *   never over an existing file, then the directory fsync);
 * - disproved (not an archive / truncated), or proven but the final name is
 *   taken → kept aside as `<final>.orphaned` (or the first free
 *   `<final>.orphaned.<n>`), never clobbering anything;
 * - EMPTY → left exactly where it is. A custom-format pg_dump writes NOTHING
 *   until it holds every table lock and has read the whole schema, so a dump
 *   queued behind a lock for a day is a 0-byte part that is still alive; once it
 *   writes, its mtime moves and a later pass adopts it;
 * - anything undecided (it moved during the read, the read ran out of time or
 *   failed for a reason that is not the bytes', the host cannot look) → left
 *   alone for the next pass.
 *
 * Only a part older than PART_ORPHAN_AGE_MS and not claimed by this process is
 * considered: a younger one may be a live dump of another process. Mirrored by
 * deploy/dedalo-db-backup.sh for the nightly timer.
 */
export function adoptOrphanedParts(
	backupDir: string = getBackupDir(),
	options: VerifyOptions = {},
): Promise<void> {
	const key = resolvePath(backupDir);
	const existing = adoptionInFlight.get(key);
	if (existing !== undefined) return existing;
	const pass = adoptOrphans(key, options).finally(() => {
		adoptionInFlight.delete(key);
	});
	adoptionInFlight.set(key, pass);
	return pass;
}

/**
 * The adoption pass in flight for `backupDir`, if any — READ-ONLY: it never
 * starts one (resolves at once when none runs). What a caller that must observe
 * the pass `initBackupSequence` starts awaits, without doing the adoption itself.
 */
export function orphanAdoptionSettled(backupDir: string = getBackupDir()): Promise<void> {
	return adoptionInFlight.get(resolvePath(backupDir)) ?? Promise.resolve();
}

async function adoptOrphans(backupDir: string, options: VerifyOptions): Promise<void> {
	let names: string[];
	try {
		names = readdirSync(backupDir);
	} catch {
		return;
	}
	const nowMs = Date.now();
	for (const name of names) {
		const partPath = join(backupDir, name);
		if (!isOrphanCandidate(partPath, nowMs)) continue;
		// Per-entry guard: one orphan that cannot be judged must not stop the rest.
		try {
			await adoptOrphan(partPath, options);
		} catch (error) {
			console.error(`[backup] could not judge orphaned dump '${partPath}':`, error);
		}
	}
}

/**
 * Is this a part nobody will ever promote? Our in-flight suffix, not claimed by
 * this process (a dump blocked on a lock can sit quiet for a long time and is
 * still ours), and older than PART_ORPHAN_AGE_MS.
 */
function isOrphanCandidate(partPath: string, nowMs: number): boolean {
	if (!partPath.endsWith(`${BACKUP_SUFFIX}${PART_SUFFIX}`)) return false;
	if (partsInFlight.has(partPath)) return false;
	try {
		return nowMs - statSync(partPath).mtimeMs > PART_ORPHAN_AGE_MS;
	} catch {
		return false; // gone meanwhile
	}
}

async function adoptOrphan(partPath: string, options: VerifyOptions): Promise<void> {
	const finalPath = partPath.slice(0, -PART_SUFFIX.length);
	const verdict = await judgeArtifact(partPath, {
		pgRestoreBin: options.pgRestoreBin,
		budgetMs: options.budgetMs,
	});
	// Empty: possibly a live pg_dump still waiting on its locks — never touched.
	if (verdict.reason === 'empty') return;
	if (promoteOrphan(partPath, finalPath, verdict)) return;
	if (adoptionDecided(verdict)) keepAside(partPath, `${finalPath}.orphaned`);
}

/** Give a PROVEN orphan its final name, when that name is free. */
function promoteOrphan(partPath: string, finalPath: string, verdict: BackupVerdict): boolean {
	if (verdict.reason !== 'verified_deep' || existsSync(finalPath)) return false;
	if (!promoteArtifact(partPath, finalPath, verdict)) return false;
	console.warn(
		`[backup] adopted the orphaned dump '${partPath}' as '${finalPath}' (a full read proved it)`,
	);
	return true;
}

/** Did the read DECIDE this orphan (proven, or disproved)? Anything else waits for the next pass. */
function adoptionDecided(verdict: BackupVerdict): boolean {
	return verdict.reason === 'verified_deep' || artifactDisproved(verdict);
}

/**
 * Move bytes that are not a restore point out of every scanner's way WITHOUT
 * destroying anything: renamed to `target`, or to the first free
 * `<target>.<n>` — never over a file already there.
 */
function keepAside(source: string, target: string): void {
	try {
		const keptAs = moveAside(source, target);
		if (keptAs === null) {
			console.error(`[backup] '${source}' was NOT moved aside: no free name next to '${target}'`);
			return;
		}
		console.error(`[backup] '${source}' kept as '${keptAs}' — it is NOT a restore point`);
		makeEntryDurable(keptAs);
	} catch (error) {
		console.error(`[backup] could not move '${source}' aside:`, error);
	}
}

/**
 * fsync the directory holding `path` (the durable kernel), so the entry a rename
 * or a link just gave it survives a power cut. A filesystem that cannot fsync a
 * directory is warned about by the kernel; a REAL failure (EIO: the device did
 * not take it) is logged here and answered `false` — the bytes stay where they
 * are, but nobody may be told the name is durable.
 */
function makeEntryDurable(path: string, barrier?: DirectoryBarrier): boolean {
	try {
		if (barrier !== undefined) barrier.flush();
		else fsyncDirectory(dirname(path));
		return true;
	} catch (error) {
		console.error(
			`[backup] '${path}' is in place but its directory could not be fsynced — the name may not survive a power cut:`,
			error,
		);
		return false;
	}
}

/** How many numbered siblings `moveAside` tries before giving up (and leaving the file where it is). */
const MAX_ASIDE_NAMES = 100;

/**
 * Rename `source` to `target`, or to the first free `<target>.<n>` — NEVER over
 * an existing file. Returns the name it got, or null when none was free (the
 * file then stays where it is). A failed dump retired twice under one name, or an
 * orphan whose `.orphaned` name is taken, keeps BOTH sets of bytes.
 */
function moveAside(source: string, target: string): string | null {
	for (let attempt = 0; attempt < MAX_ASIDE_NAMES; attempt += 1) {
		const candidate = attempt === 0 ? target : `${target}.${attempt}`;
		if (renameNoClobber(source, candidate)) return candidate;
	}
	return null;
}

/** errnos a filesystem without hard links answers `link` with (FAT/exFAT, some network mounts). */
const LINK_UNSUPPORTED: ReadonlySet<string> = new Set([
	'EPERM',
	'ENOTSUP',
	'EOPNOTSUPP',
	'ENOSYS',
	'EMLINK',
	'EXDEV',
]);

/**
 * THE NO-CLOBBER RENAME: `true` when `source` now lives at `target`, `false`
 * when `target` was taken (nothing moved). `renameSync` silently REPLACES an
 * existing file, so it is never the primitive here: `link` fails atomically with
 * EEXIST when the name is taken, and the source name is dropped only after the
 * new one exists (a live writer keeps writing the same inode). On a filesystem
 * without hard links it falls back to check-then-rename (a narrow race the
 * platform leaves open). Throws on any other error.
 */
function renameNoClobber(source: string, target: string): boolean {
	try {
		linkSync(source, target);
	} catch (error) {
		const code = String((error as { code?: unknown }).code);
		if (code === 'EEXIST') return false;
		if (!LINK_UNSUPPORTED.has(code)) throw error;
		if (existsSync(target)) return false;
		renameSync(source, target);
		return true;
	}
	unlinkSync(source);
	return true;
}

/** What a finished dump came to (`publishDump`'s answer). */
interface DumpOutcome {
	ok: boolean;
	reason: string;
}

/**
 * PHP init_backup_sequence: throttle window (unless forced), then a
 * custom-format pg_dump of the configured database into the backup dir, run as
 * a MAINTENANCE-LANE JOB (`mediaJobs`, kind `backup`). Returns with the job's
 * pfile; the dump continues in background.
 *
 * Audit S2-35 hardening:
 * - PGPASSWORD is threaded from config.db.password (password-auth Postgres —
 *   exactly what production uses — previously failed with fe_sendauth into a
 *   .log nobody surfaced, while the widget reported success);
 * - a short fast-fail window catches immediate exits (auth/connection errors)
 *   and reports them as FAILURE with the .log tail in the widget message.
 *
 * P0-13 (2026-08-30) + OPS-2 (2026-09-30): pg_dump writes `<final>.part`; only
 * `publishDump` — pg_dump's own exit 0 AND a full `pg_restore` read — gives the
 * bytes the final name, with the proof recorded in a `<final>.verified` sidecar
 * so no later reader has to re-derive it. A failure is kept as `<final>.failed`
 * (never deleted when it holds bytes, never left looking like a backup).
 *
 * WHY A JOB, NOT A BARE PFILE (OPS-2 review, 2026-09-30). The status record used
 * to be a pfile written by hand, owned by the pg_dump CHILD's pid. After pg_dump
 * exits the promotion still has a full read to do (seconds per GB, plus its turn
 * in the one-read-at-a-time slot) — and in that window the record said `running`
 * under a DEAD owner, so the widget's next poll ran the lazy reconcile and
 * flipped a SUCCESSFUL backup to `interrupted`. A job registered with the job
 * manager is owned by this server process for its whole life, dump AND
 * verification: the poll reads it from the registry, and only a server that
 * actually died leaves it to the reconcile. It spends a `maintenance` slot, which
 * is what a whole-database dump is; it has no deadline (its length is the
 * database's size); a user STOP kills the dump (the part is then retired), a
 * server SHUTDOWN does not (the dump may finish, and `adoptOrphanedParts`
 * promotes it later).
 *
 * TWO IDENTITIES, deliberately apart: `userId` is the one the FILE NAME carries
 * (`postgresql_<userId>…` — the widget always names its dumps by -1, the forced
 * dump's grammar), `ownerId` is the PRINCIPAL the job belongs to — who may
 * stream it and stop it, and who the record says asked. Default: the same.
 */
export async function initBackupSequence(
	userId: number,
	skipTimeRange = true,
	overrides: BackupOverrides = {},
	ownerId: number = userId,
): Promise<BackupResponse> {
	const response: BackupResponse = {
		ok: false,
		msg: 'Error. Request failed initBackupSequence',
		errors: [],
	};
	const backupDir = resolvePath(overrides.backupDir ?? getBackupDir());
	try {
		mkdirSync(backupDir, { recursive: true, mode: 0o700 });
	} catch (error) {
		// The OS's words go to the log, never into the payload (SEC-18 / A6).
		console.error(`[backup] unable to create the backup directory '${backupDir}':`, error);
		response.errors.push('unable to create the backups folder (see the server log)');
		return response;
	}
	// Detached: every orphan is a full read, and this is an HTTP request.
	adoptOrphanedParts(backupDir, {
		pgRestoreBin: overrides.pgRestoreBin,
		budgetMs: overrides.budgetMs,
	}).catch((error: unknown) => console.error('[backup] orphan adoption failed:', error));

	// Throttle window (PHP: newest *.backup mtime within the range → skip).
	// USABLE, not merely present (P0-13): skipping the nightly dump because a
	// truncated corpse is 3 hours old is how an install ends up with no restore
	// point at all. A scan still verifying after the bounded wait counts as NO
	// usable backup — the safe direction is to dump more often, never less.
	if (!skipTimeRange) {
		const scan = await newestUsableBackupWithin(PANEL_WAIT_MS, backupDir, {
			pgRestoreBin: overrides.pgRestoreBin,
			budgetMs: overrides.budgetMs,
		});
		const newest = 'pending' in scan ? 0 : scan.mtimeMs;
		const hours = Math.round(Date.now() / 3600000 - Math.round(newest / 1000) / 3600);
		if (newest > 0 && hours < BACKUP_TIME_RANGE_HOURS) {
			response.ok = true;
			response.msg = ` Skipped backup. A recent backup (about ${hours} hours early) already exists. It is not necessary to build another one`;
			return response;
		}
	}

	const db = config.db as { database?: string; user?: string };
	const databaseName = String(db.database ?? 'dedalo');
	const fileName = backupFileName({
		now: overrides.now ?? new Date(),
		database: databaseName,
		userId,
		forced: skipTimeRange,
		version: await getCurrentDataVersion(),
	});
	const filePath = join(backupDir, fileName);
	const partPath = inFlightName(filePath);
	const skipped = (): BackupResponse => {
		response.ok = true;
		response.msg = ` Skipped backup. A recent backup already exists ('${filePath}'). It is not necessary to build another one`;
		return response;
	};
	if (existsSync(filePath)) {
		// Name collision (same second, forced). A `*.backup` name only ever holds a
		// PROMOTED dump now, so skipping is honest unless reading it back actually
		// DISPROVES it — then it is retired (kept as .failed) and the dump proceeds.
		// A verification that merely could not finish disproves nothing.
		const existing = await verifyBackupArtifact(filePath, {
			pgRestoreBin: overrides.pgRestoreBin,
			budgetMs: overrides.budgetMs,
		});
		if (!artifactDisproved(existing)) return skipped();
		retireFailedArtifact(filePath);
	}
	// THE CLAIM. `wx` is atomic: of two claimants of one name exactly one creates
	// the part, and the other SKIPS without touching it — the live dump of the
	// winner is never judged, never retired, never clobbered.
	try {
		closeSync(openSync(partPath, 'wx', 0o600));
	} catch (error) {
		if ((error as { code?: string }).code === 'EEXIST') return skipped();
		// The OS's words go to the log, never into the payload (SEC-18).
		console.error(`[backup] unable to claim '${partPath}':`, error);
		response.errors.push('unable to claim the in-flight dump file (see the server log)');
		return response;
	}
	partsInFlight.add(partPath);

	// custom format with blobs (PHP: pg_dump … -F c -b) into the PART; stderr
	// streams to a sibling .log (PHP writes it to the process file)
	// The shared transport rule (DB_SOCKET wins) — the route the pool takes.
	const args = [
		'-F',
		'c',
		'-b',
		'-f',
		partPath,
		...libpqTransportArgs(resolvePgTransport(config.db)),
	];
	if (db.user) args.push('-U', String(db.user));
	args.push(databaseName);
	const dump: DumpJob = {
		fileName,
		filePath,
		partPath,
		logPath: `${filePath}.log`,
		command: [overrides.pgDumpBin ?? resolvePgDump(), ...args],
		overrides,
	};
	let started: StartedDump;
	try {
		started = startDumpJob(dump, ownerId);
	} catch (error) {
		// The armed test seam's processes-dir refusal (the job never existed):
		// nothing will ever write the claimed part.
		partsInFlight.delete(partPath);
		retireFailedArtifact(partPath, `${filePath}.failed`);
		console.error('[backup] the backup job could not be registered:', error);
		response.errors.push('unable to register the backup job (see the server log)');
		return response;
	}

	// Fast-fail window: an auth/connection error exits within milliseconds —
	// report THAT as failure with pg_dump's own words instead of "running". A job
	// still queued for its lane slot has not spawned yet: it answers "running".
	const early = await Promise.race([
		started.spawned.then((child) =>
			child === null ? 'ended' : child.exited.then(() => 'ended' as const),
		),
		Bun.sleep(overrides.fastFailWindowMs ?? 1500).then(() => 'running' as const),
	]);
	// The poll handle names the job's OWNER — this server — never the pg_dump
	// child: a job queued behind a full maintenance lane has no child yet, and a
	// null pid makes the client refuse to poll at all (the operator would see
	// "running" and then nothing, S2-35). `pfile` is what identifies the job.
	response.pid = process.pid;
	if (early === 'ended') {
		// It ended inside the window (an auth failure, or a tiny DB / test dump).
		// Its promotion is a full read that may queue behind another archive's, so
		// the request waits for it only a BOUNDED time: an HTTP surface never
		// awaits a settled verdict. A lost wait answers "running" with the pfile.
		const outcome = await Promise.race([
			started.settled,
			Bun.sleep(PANEL_WAIT_MS).then(() => null),
		]);
		if (outcome !== null && !outcome.ok) {
			const tail = logTail(dump.logPath);
			response.errors.push(outcome.reason);
			response.msg = `Error. Backup failed (${outcome.reason}). ${tail}`;
			return response;
		}
	}
	response.ok = true;
	response.file_path = filePath;
	response.pfile = `${started.jobId}.json`;
	response.msg = `OK. backup process running for db: ${fileName}`;
	return response;
}

/** Everything the dump job needs, fixed before it is submitted. */
interface DumpJob {
	fileName: string;
	filePath: string;
	partPath: string;
	logPath: string;
	command: string[];
	overrides: BackupOverrides;
}

/** A submitted dump job, as `initBackupSequence` observes it. */
interface StartedDump {
	jobId: string;
	/** The pg_dump child once spawned; null when it never will be (spawn failure, stop while queued). */
	spawned: Promise<ReturnType<typeof Bun.spawn> | null>;
	/** The outcome, resolved AFTER the job's terminal record is committed. */
	settled: Promise<DumpOutcome>;
}

/**
 * Submit the dump as a `backup` job on the maintenance lane. The worker spawns
 * pg_dump, awaits its exit, and runs the ONE promotion (`publishDump`) — all
 * inside the job, so the record stays live (owned by this server) until the
 * verdict is written. Throws only when the job cannot be registered.
 */
function startDumpJob(dump: DumpJob, userId: number): StartedDump {
	const spawned = Promise.withResolvers<ReturnType<typeof Bun.spawn> | null>();
	const settled = Promise.withResolvers<DumpOutcome>();
	let workerRan = false;
	let outcome: DumpOutcome | null = null;
	const record = mediaJobs.submit(
		'backup',
		async ({ onData, signal }) => {
			workerRan = true;
			try {
				let child: ReturnType<typeof Bun.spawn>;
				try {
					child = Bun.spawn(dump.command, {
						stdout: 'ignore',
						stderr: Bun.file(dump.logPath),
						env: {
							...inheritedEnvironment(),
							// Password auth (S2-35): pg_dump has no config file here; without
							// this it fails fe_sendauth on every password-auth install.
							...(config.db.password !== '' ? { PGPASSWORD: config.db.password } : {}),
						},
					});
				} catch (error) {
					spawned.resolve(null);
					retireFailedArtifact(dump.partPath, `${dump.filePath}.failed`);
					console.error(`[backup] pg_dump for '${dump.fileName}' could not be started:`, error);
					outcome = { ok: false, reason: 'pg_dump could not be started (see the server log)' };
					throw dumpFailure(dump, outcome, '');
				}
				const running = child;
				spawned.resolve(running);
				onData({ msg: `Backup running: ${dump.fileName}`, file_path: dump.filePath });
				// A user STOP (or a deadline) kills the dump; a server SHUTDOWN does not
				// — the dump may still finish, and the orphan adoption promotes it.
				const stopDump = (): void => {
					if (jobAbortInfo(signal)?.cause !== 'shutdown') running.kill('SIGTERM');
				};
				signal.addEventListener('abort', stopDump, { once: true });
				let exitCode: number;
				try {
					exitCode = await running.exited;
				} finally {
					signal.removeEventListener('abort', stopDump);
				}
				onData({ msg: `Verifying backup: ${dump.fileName}`, file_path: dump.filePath });
				const published = await publishDumpOrReport(dump, exitCode);
				outcome = published;
				if (!published.ok) throw dumpFailure(dump, published, logTail(dump.logPath));
				let size = 0;
				try {
					size = statSync(dump.filePath).size;
				} catch {
					/* reported without a size */
				}
				console.log(`[backup] completed: ${dump.fileName} (${size} bytes, ${published.reason})`);
				return {
					msg: `OK. Backup done: ${dump.fileName} (${size} bytes, ${published.reason})`,
					file_path: dump.filePath,
				};
			} finally {
				partsInFlight.delete(dump.partPath);
			}
		},
		{
			lane: 'maintenance',
			userId,
			// No deadline: a dump's length is the database's size, and a deadline that
			// killed it near the end would throw the whole dump away.
			deadlineMs: 0,
			onTerminal: (terminal: JobRecord) => {
				if (!workerRan) {
					// Stopped or interrupted while still queued: nothing ever wrote the
					// claimed (empty) part.
					partsInFlight.delete(dump.partPath);
					retireFailedArtifact(dump.partPath, `${dump.filePath}.failed`);
					spawned.resolve(null);
				}
				settled.resolve(
					outcome ?? { ok: false, reason: `the backup job ended ${terminal.status}` },
				);
			},
		},
	);
	return {
		jobId: record.id,
		spawned: spawned.promise,
		settled: settled.promise,
	};
}

/**
 * `publishDump`, with an unexpected throw (a configured pg_restore that cannot be
 * spawned, a filesystem error) turned into an ordinary failed outcome: its words
 * go to the log, never into the job's frame. publishDump's own `finally` has
 * already retired the part.
 */
async function publishDumpOrReport(dump: DumpJob, exitCode: number): Promise<DumpOutcome> {
	try {
		return await publishDump(dump.partPath, dump.filePath, exitCode, dump.overrides);
	} catch (error) {
		console.error(`[backup] the dump '${dump.fileName}' could not be verified:`, error);
		return { ok: false, reason: 'the dump could not be verified (see the server log)' };
	}
}

/**
 * The typed failure a dump job ends with. `maintenance.action_failed` is a
 * PUBLIC-disclosure code: its frame line is the vetted sentence below, which
 * carries pg_dump's own last words (the S2-35 contract: the operator sees WHY —
 * `fe_sendauth`, a lost connection) — the same tail this widget has always shown.
 */
function dumpFailure(dump: DumpJob, outcome: DumpOutcome, tail: string): DedaloError {
	console.error(
		`[backup] pg_dump for '${dump.fileName}' FAILED (${outcome.reason}): ${tail || `see ${dump.logPath}`}`,
	);
	const sentence = `Error. Backup failed (${outcome.reason})${tail !== '' ? `: ${tail}` : ''}`;
	return new DedaloError('maintenance.action_failed', {
		message: `backup '${dump.fileName}' failed: ${outcome.reason}`,
		publicMessage: sentence,
	});
}

/**
 * THE PROMOTION OF OUR OWN DUMP (OPS-2) — one of the two doors that give a part
 * a `.backup` name (the other is the orphan adoption; THE NAME GRAMMAR above says
 * what each proves).
 *
 * - pg_dump exited non-zero → the part is retired as `<final>.failed` (an empty
 *   one is deleted). Whatever the bytes look like: only pg_dump's exit 0 proves
 *   the dump ran to COMPLETION.
 * - exit 0 → a pure full read of the PART (`judgeArtifact`; no cache involved):
 *   - DISPROVED by its bytes (empty / not an archive / truncated —
 *     `artifactDisproved`) → retired as `<final>.failed`;
 *   - `verified_deep` → `promoteArtifact` with its proof (the sidecar);
 *   - a read that could not LOOK or could not FINISH for a reason that is not
 *     the bytes' (no pg_restore on this host, a read that outran its budget, a
 *     read killed from outside / an I/O error / a pg_restore older than the
 *     archive — `unverifiable_read_failed`) → promoted WITHOUT a sidecar,
 *     "completed, not verified": the exit 0 is proof of completion, not of
 *     readability, and the next freshness ask reads it afresh. ONLY THE BYTES
 *     DISPROVE — a transient host event must never cost the install a complete
 *     restore point (OPS-1 review, third round).
 * - a file that appeared at the final name while the dump ran is NEVER
 *   overwritten: the part is retired instead.
 * - whatever path left the part on disk unpromoted retires it — never `rm` of
 *   bytes (P0-13 keeps a failed dump for the operator), never over an earlier
 *   `.failed` (`moveAside`).
 */
async function publishDump(
	partPath: string,
	finalPath: string,
	exitCode: number,
	overrides: BackupOverrides,
): Promise<DumpOutcome> {
	let outcome: DumpOutcome = { ok: false, reason: `pg_dump exited ${exitCode}` };
	try {
		if (exitCode === 0) outcome = await promoteFinishedDump(partPath, finalPath, overrides);
		return outcome;
	} finally {
		if (!outcome.ok) retireFailedArtifact(partPath, `${finalPath}.failed`);
	}
}

/**
 * The verdicts a dump that EXITED 0 is promoted on (see publishDump): the proof,
 * and every verdict that says the host could not judge it. What is left out is a
 * disproof (`artifactDisproved`), `in_progress` (the part moved after pg_dump
 * exited — something else writes it) and `missing`.
 */
const PROMOTABLE_REASONS: ReadonlySet<BackupVerdictReason> = new Set<BackupVerdictReason>([
	'verified_deep',
	'unverifiable_timeout',
	'unverifiable_no_pg_restore',
	'unverifiable_read_failed',
]);

/** publishDump's exit-0 half: read the part, then promote it or say why not. */
async function promoteFinishedDump(
	partPath: string,
	finalPath: string,
	overrides: BackupOverrides,
): Promise<DumpOutcome> {
	const verdict = await judgeArtifact(partPath, {
		pgRestoreBin: overrides.pgRestoreBin,
		budgetMs: overrides.budgetMs,
		// The dump JUST finished, so the in-progress window would refuse it: the
		// exit status already proved nothing is still writing this file.
		nowMs: Number.MAX_SAFE_INTEGER,
	});
	if (!PROMOTABLE_REASONS.has(verdict.reason)) {
		return {
			ok: false,
			reason: `pg_dump exited 0 but the artifact did not verify: ${describeVerdict(verdict)}`,
		};
	}
	if (existsSync(finalPath)) {
		console.error(`[backup] '${finalPath}' appeared while the dump ran — it is NOT overwritten`);
		return { ok: false, reason: 'another file took the backup name while the dump ran' };
	}
	if (!promoteArtifact(partPath, finalPath, verdict)) {
		return { ok: false, reason: 'could not promote the dump (see the server log)' };
	}
	return {
		ok: true,
		reason:
			verdict.reason === 'verified_deep'
				? verdict.reason
				: `completed, not verified (${verdict.reason})`,
	};
}

/** `<reason>` or `<reason> (<pg_restore's words>)`. */
function describeVerdict(verdict: BackupVerdict): string {
	return verdict.detail === undefined || verdict.detail === ''
		? verdict.reason
		: `${verdict.reason} (${verdict.detail})`;
}

/**
 * Give `source` the backup name `finalPath`, DURABLY and NEVER over an existing
 * file (`renameNoClobber`): a `verified_deep` verdict's sidecar is written (the
 * durable kernel: tmp + fsync + rename) at the final name first — keyed on
 * size+mtime, which a rename preserves — then the name, then ONE fsync of the
 * directory (a barrier covering both entries), so a power loss after the caller
 * reports "done" cannot revert the rename and leave only the part behind. Writing the proof first is a COST choice, not a correctness one: a
 * reader that races the promotion finds the proof instead of re-reading a large
 * archive, and a final name without its sidecar is simply read again. `false`
 * (logged) when the name was taken or the rename failed (the sidecar is removed),
 * or when the directory fsync failed (the bytes keep the final name, but the
 * promotion is not reported done).
 */
function promoteArtifact(source: string, finalPath: string, verdict: BackupVerdict): boolean {
	const proven = verdict.reason === 'verified_deep';
	const sidecar = verificationSidecarPath(finalPath);
	const barrier = new DirectoryBarrier();
	if (proven) writeVerdictSidecar(verdict, sidecar, barrier);
	let moved = false;
	try {
		moved = renameNoClobber(source, finalPath);
		if (!moved) console.error(`[backup] '${finalPath}' is taken — '${source}' was NOT promoted`);
	} catch (error) {
		console.error(`[backup] could not promote '${source}' to '${finalPath}':`, error);
	}
	if (!moved) {
		if (proven) unlinkQuietly(sidecar);
		return false;
	}
	barrier.add(dirname(finalPath));
	return makeEntryDurable(finalPath, barrier);
}

function unlinkQuietly(path: string): void {
	try {
		unlinkSync(path);
	} catch {
		/* already gone */
	}
}

/**
 * The pg_dump binary matching the SERVER version (PHP system::get_pg_bin_path
 * — explicit config first, then platform locations). A client older than the
 * server refuses to dump, so version-suffixed Homebrew installs are probed
 * newest-first before falling back to PATH.
 */
export function resolvePgDump(): string {
	const candidates = pgDumpCandidates(config.ops.pgBinPath);
	// The last entry is the bare-PATH fallback: it is RETURNED without an
	// existsSync probe (PATH resolution is the shell's job), so only the
	// preceding absolute paths are probed.
	const fallback = candidates[candidates.length - 1] ?? 'pg_dump';
	for (const candidate of candidates.slice(0, -1)) {
		if (existsSync(candidate)) return candidate;
	}
	return fallback;
}

/**
 * The pg_dump binaries `resolvePgDump` probes, IN ORDER — pure, so the order
 * itself is gateable without touching the filesystem.
 *
 * The order is load-bearing and NEWEST-FIRST: a pg_dump older than the server
 * refuses to dump, so a machine carrying both pg15 and pg19 must not pick
 * pg15 — that backup fails silently into a `.log` nobody reads (audit S2-35).
 * A newly released major belongs at the FRONT of the version list, never the
 * end. The explicitly configured directory always wins, and the bare
 * `pg_dump` (PATH) is always last.
 */
export function pgDumpCandidates(declaredDir: unknown): string[] {
	return pgBinCandidates(declaredDir, 'pg_dump');
}

/**
 * PHP backup::get_backup_files: newest-first {name, size} of the backup
 * ARTIFACTS in `backupDir` (default: the configured dir). A dump still being
 * written is a `.part` and is not listed (OPS-2).
 */
export function getBackupFiles(
	backupDir: string = getBackupDir(),
): { name: string; size: string }[] {
	const formatSize = (bytes: number): string => {
		// PHP format_size_units
		if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(2)} GB`;
		if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(2)} MB`;
		if (bytes >= 1024) return `${(bytes / 1024).toFixed(2)} KB`;
		if (bytes > 1) return `${bytes} bytes`;
		if (bytes === 1) return '1 byte';
		return '0 bytes';
	};
	// Newest first BY NAME (the timestamp leads it), as PHP listed them.
	return statableBackups(backupDir)
		.sort((a, b) => Number(b.name > a.name) - Number(b.name < a.name))
		.map(({ name, size }) => ({ name, size: formatSize(size) }));
}

/* ------------------------------------------------------------------------- *
 * RESTORE-POINT VERIFICATION (audit P0-13, 2026-08-30; OPS-1, 2026-09-30)
 *
 * THE DEFECT THIS SECTION EXISTS TO PREVENT: the old `artifactIsUsable` was
 * `existsSync(file) && size > 0`. A pg_dump killed at 60% leaves a large,
 * non-empty, PERFECTLY FRESH file — it passed, the widget listed it, the
 * update panel counted it, and the code-update precondition told the operator
 * they had a restore point before they replaced the whole code tree.
 *
 * WHAT EACH CHECK ACTUALLY PROVES (measured 2026-08-30 on this machine, against
 * the 400 MB `2026-07-11_102750….custom.backup` artifact, pg_restore 17):
 *
 *   pg_restore --list        0.03 s. Reads header + TOC only (the archive is
 *                            seekable), so it catches a NON-archive, a garbage
 *                            or error-text file, and a death early enough to
 *                            cut the header/TOC (a 2 KB prefix fails with
 *                            "could not read from input file: end of file").
 *                            It does NOT catch data truncation: the same
 *                            archive cut to 60% (240 MB) STILL listed all 1121
 *                            entries and exited 0. Used here ONLY as a fast
 *                            FAIL — it never produces a positive verdict.
 *   pg_restore -f /dev/null  2.97 s on the whole 400 MB archive (~7.4 s/GB,
 *                            no server connection — it emits SQL to the file).
 *                            Reads and decompresses EVERY data block, so the
 *                            60% copy fails in 1.7 s with the same EOF error.
 *                            This is the only read that disproves truncation,
 *                            and it is the ONLY positive verdict there is.
 *   pg_dump's own exit 0     The only proof the dump ran to COMPLETION; nothing
 *                            read back from the file can substitute for it,
 *                            which is why our own dumps are promoted only after
 *                            it (publishDump).
 *
 * ONE QUESTION (OPS-1). Until 2026-09-30 the freshness path asked the CHEAP
 * question (`--list`, a `verified_toc` verdict "usable but unproven"), so a dump
 * that died at 60% counted as a fresh restore point and the unwaived code update
 * swapped the tree. The cheap verdict is gone: every caller — the require path,
 * the panel, the throttle, the restore door — asks the full read.
 *
 * COST DISCIPLINE, now that the one question is the expensive one:
 * - ASYNC. `pg_restore` runs as a child the event loop awaits; nothing here
 *   freezes the single-threaded server (it used to be `spawnSync`).
 * - PAID ONCE per artifact: a decisive verdict is cached in a
 *   `<artifact>.verified` sidecar keyed on (size, mtime); our own dumps get
 *   theirs at promotion, so no one waits on them at all.
 * - SINGLE-FLIGHT: concurrent askers of one file (`verifyInFlight`) and of one
 *   directory generation (`scanInFlight`) share ONE read.
 * - SERIALIZED: at most one full read runs at a time in the process
 *   (`deepReadSlot`); its budget clock starts when it gets the slot.
 * - CAPPED at MAX_VERIFY_CANDIDATES artifacts per scan.
 * - BOUNDED on HTTP: the panel and update_data_version race the shared scan
 *   against PANEL_WAIT_MS and say `verifying` — never `ok` — when it loses. Only
 *   the require path (the code update, inside its background job) awaits the
 *   settled verdict.
 * - BUDGETED by size (`verifyBudgetMs`, DEDALO_BACKUP_VERIFY_SECONDS_PER_GB).
 *
 * DEGRADATION: when we CANNOT judge an artifact because of THIS HOST (no
 * pg_restore) or THIS FORMAT (a foreign, non-custom dump under a name OTHER than
 * our `.custom.backup` suffix) the verdict stays `usable: true, verified: false` —
 * refusing a legitimate update over a format we never claimed to verify would be
 * an outage. Our own suffix without the archive magic is `not_an_archive`: that
 * name is our grammar, and a zero-filled file under it is a corpse. A read that OUTRAN ITS BUDGET is
 * different (OPS-1): the host could have looked and did not finish, so nothing
 * was proven — `unverifiable_timeout` is `usable: false`. It is never cached
 * (it describes this moment) and never counts as a DISPROOF (nothing is retired
 * or clobbered because of it); the require path refuses and names the key.
 *
 * ONLY THE BYTES DISPROVE (OPS-1 review). A pg_restore failure is a disproof —
 * cached in the sidecar, a reason to retire a file — only when its words say the
 * ARCHIVE is damaged (`ARCHIVE_DAMAGE`), or when an unrecognized failure repeats
 * word for word on a second read. A read killed from outside, an I/O error on
 * the backup storage, a pg_restore older than the archive, or a failure that did
 * not repeat is `unverifiable_read_failed`: not a restore point, not a disproof,
 * never cached — the next ask reads again.
 * ------------------------------------------------------------------------- */

/**
 * How recent an UNVERIFIABLE artifact may be before we assume a dump is still
 * WRITING it. Used only on the two hosts that cannot ask pg_restore (no binary,
 * foreign format): there a heuristic is the honest answer. Everywhere else a
 * partial archive fails the full read, and a file that MOVED during that read is
 * `in_progress` by observation, not by guess.
 */
const IN_PROGRESS_WINDOW_MS = 90_000;

/** The floor of every verification budget, whatever the archive's size. */
const MIN_VERIFY_BUDGET_MS = 60_000;

/**
 * How many artifacts a scan verifies before giving up on the directory. If the
 * three newest dumps are all corpses an older one will not rescue the operator
 * (it is almost certainly stale anyway), and every candidate is a full read.
 */
export const MAX_VERIFY_CANDIDATES = 3;

/** How long a TIMED-OUT verdict is remembered, so a slow host is not re-read on every panel poll. */
const TIMEOUT_MEMO_MS = 15 * 60_000;

/**
 * How long an HTTP surface (the update panel, update_data_version's warnings,
 * the throttle) waits on a verification before answering `verifying`: half the
 * server's idle timeout, never more than 5 s — a panel must answer, not hang.
 */
export const PANEL_WAIT_MS = Math.min(5000, (config.ops.idleTimeoutSeconds * 1000) / 2);

/** First bytes of a pg_dump custom-format archive (`pg_backup_custom.c`). */
const CUSTOM_ARCHIVE_MAGIC = 'PGDMP';

/**
 * Does this path's NAME promise a custom-format archive — our suffix, finished or
 * in flight? Only other names may degrade to `unverifiable_foreign_format`.
 */
function claimsCustomFormat(filePath: string): boolean {
	return filePath.endsWith(BACKUP_SUFFIX) || filePath.endsWith(`${BACKUP_SUFFIX}${PART_SUFFIX}`);
}

/**
 * The longest delay a timer can hold. Past it `setTimeout` fires after ~1 ms
 * (measured in Bun: `TimeoutOverflowWarning … set to 1`), which would SIGKILL
 * every verification at once — every update refused, and the refusal's remedy
 * (raise the key) making it worse. Every budget is clamped to it (~24.8 days).
 */
export const MAX_VERIFY_BUDGET_MS = 2 ** 31 - 1;

/**
 * Why an artifact does or does not count as a restore point. Decisive reasons
 * (`verified_deep`, `not_an_archive`, `truncated`) are cached in the sidecar;
 * situational ones (`in_progress`, `unverifiable_timeout`,
 * `unverifiable_read_failed`) and host-bound ones (`unverifiable_no_pg_restore`,
 * `unverifiable_foreign_format`) are not, because they describe THIS MOMENT or
 * THIS HOST, not the file. `verified_deep` is the only PROOF;
 * `unverifiable_no_pg_restore` / `unverifiable_foreign_format` are usable
 * degradations; everything else does not count.
 *
 * `unverifiable_read_failed`: pg_restore failed for a reason that is NOT the
 * archive's bytes — killed by a signal we did not send, an I/O error on the
 * backup storage, a pg_restore older than the archive's format, a failure whose
 * words we do not recognize that a second read did not repeat. Not a restore
 * point (nothing was proven), but not a DISPROOF either: never cached, never a
 * reason to retire or clobber a file.
 */
export type BackupVerdictReason =
	| 'verified_deep'
	| 'missing'
	| 'empty'
	| 'in_progress'
	| 'not_an_archive'
	| 'truncated'
	| 'unverifiable_no_pg_restore'
	| 'unverifiable_foreign_format'
	| 'unverifiable_timeout'
	| 'unverifiable_read_failed';

export interface BackupVerdict {
	filePath: string;
	size: number;
	mtimeMs: number;
	/** May this count as a restore point? */
	usable: boolean;
	/** Was it PROVEN restorable (a full read)? Only `verified_deep` is. */
	verified: boolean;
	reason: BackupVerdictReason;
	/** pg_restore's own words, when it had any. */
	detail?: string;
	/**
	 * The wall-clock budget each pg_restore stage RAN UNDER — present only when
	 * this verdict came from reading the archive (absent when it was decided
	 * without pg_restore, or answered from a sidecar). The observable of the
	 * size-scaled default (`verifyBudgetMs`, DEDALO_BACKUP_VERIFY_SECONDS_PER_GB):
	 * what an operator (and the gate) reads to know which budget a slow read had.
	 */
	budgetMs?: number;
}

/** The knobs a verification takes. Production passes none of them. */
export interface VerifyOptions {
	/** The pg_restore to ask (`null` = this host has none). Default: `resolvePgRestore()`. */
	pgRestoreBin?: string | null;
	/** Overrides the size-scaled budget of BOTH pg_restore stages (the test seam). */
	budgetMs?: number;
	/** The clock the in-progress window reads (the no-pg_restore / foreign branches only). */
	nowMs?: number;
}

/** The cached verdict lives beside the artifact; the name must not end `.backup`. */
function verificationSidecarPath(filePath: string): string {
	return `${filePath}.verified`;
}

interface SidecarRecord {
	size: number;
	mtimeMs: number;
	reason: BackupVerdictReason;
	verifiedAt: number;
	detail?: string;
	/** Which classifier wrote the verdict (SIDECAR_CLASSIFIER); absent on legacy records. */
	classifier?: number;
}

/**
 * The classifier generation a sidecar must carry to be TRUSTED. 2 = OPS-1's
 * "only the bytes disprove" (`classifyRead`). Engines before it cached
 * `not_an_archive` for ANY failed `--list` and `truncated` for ANY failed full
 * read — a read killed from outside, an I/O error, a pg_restore older than the
 * archive — and they are on field installs. Those records carry no generation,
 * so every one of them is re-derived once by the byte-only classifier: a good
 * archive the old rule misjudged is never refused, or retired, forever. 3 = the
 * same classifier reading pg_restore's words in the C locale
 * (`pgRestoreEnvironment`): generation 2 read them in the SERVER's locale, and a
 * translated host failure repeated on the re-read was cached as a disproof — so
 * every generation-2 record is re-derived once too. Bump it whenever what a
 * cached reason MEANS changes.
 */
const SIDECAR_CLASSIFIER = 3;

/** The reasons a sidecar may record — and the only ones a sidecar is TRUSTED for. */
const CACHEABLE_REASONS: ReadonlySet<string> = new Set([
	'verified_deep',
	'not_an_archive',
	'truncated',
]);

/**
 * Does a verdict with this reason count as a restore point? The proof, plus the
 * two degradations a host cannot do better than (see the section header).
 */
function verdictIsUsableReason(reason: BackupVerdictReason): boolean {
	return (
		reason === 'verified_deep' ||
		reason === 'unverifiable_no_pg_restore' ||
		reason === 'unverifiable_foreign_format'
	);
}

/**
 * A cached verdict, or null when there is none, it is stale, or it is not one we
 * trust. Keyed on (size, mtime): any rewrite of the artifact invalidates it, so a
 * stale sidecar can never vouch for a new file. ONLY a record of THIS classifier
 * generation (SIDECAR_CLASSIFIER) with a cacheable reason is trusted: every
 * sidecar an engine before OPS-1 wrote — a `verified_toc` blind to truncation, a
 * `truncated` / `not_an_archive` cached for a read the host could not perform —
 * is ignored, so the artifact is read again.
 */
function readVerdictSidecar(filePath: string, size: number, mtimeMs: number): BackupVerdict | null {
	let record: SidecarRecord;
	try {
		record = JSON.parse(readFileSync(verificationSidecarPath(filePath), 'utf-8')) as SidecarRecord;
	} catch {
		return null;
	}
	if (record.size !== size || record.mtimeMs !== mtimeMs) return null;
	if (record.classifier !== SIDECAR_CLASSIFIER || !CACHEABLE_REASONS.has(record.reason)) {
		return null;
	}
	return {
		filePath,
		size,
		mtimeMs,
		usable: verdictIsUsableReason(record.reason),
		verified: record.reason === 'verified_deep',
		reason: record.reason,
		detail: record.detail,
	};
}

/**
 * Was this artifact DISPROVED as a restore point — as opposed to merely unproven?
 *
 * The distinction decides whether today's dump is skipped and whether a file is
 * retired. An artifact we could not judge (no pg_restore on the host, a foreign
 * format, a verification that timed out) is NOT a reason to overwrite what may be
 * the only restore point there is; only a verdict that actually caught it —
 * empty, not an archive, truncated — is.
 */
function artifactDisproved(verdict: BackupVerdict): boolean {
	return (
		verdict.reason === 'empty' ||
		verdict.reason === 'not_an_archive' ||
		verdict.reason === 'truncated'
	);
}

/** Best-effort cache write: a read-only backup dir loses the cache, never the verdict. */
function writeVerdictSidecar(
	verdict: BackupVerdict,
	target: string = verificationSidecarPath(verdict.filePath),
	barrier?: DirectoryBarrier,
): void {
	const record: SidecarRecord = {
		size: verdict.size,
		mtimeMs: verdict.mtimeMs,
		reason: verdict.reason,
		verifiedAt: Date.now(),
		detail: verdict.detail,
		classifier: SIDECAR_CLASSIFIER,
	};
	try {
		// The durable kernel (tmp 'wx' + every byte + fsync + rename + the directory
		// fsync, now or at the promotion's barrier): the promotion writes the proof
		// BEFORE the final name exists, and a half-written proof must never be what
		// survives — nor a proof whose name a power cut takes back.
		writeFileDurably(target, JSON.stringify(record), { mode: 0o600, barrier });
	} catch {
		/* the sidecar is a cache; every reader can re-derive the verdict */
	}
}

/**
 * The pg binaries a resolver probes, IN ORDER — pure, so the order itself is
 * gateable without touching the filesystem. Shared by pg_dump and pg_restore so
 * a host with a version-suffixed install resolves BOTH the same way: a
 * pg_restore older than the archive's format version refuses to read it, and
 * that refusal would otherwise be indistinguishable from a broken backup.
 */
export function pgBinCandidates(declaredDir: unknown, binName: string): string[] {
	const candidates: string[] = [];
	if (typeof declaredDir === 'string' && declaredDir !== '') {
		candidates.push(join(declaredDir, binName));
	}
	for (const version of [18, 17, 16, 15]) {
		candidates.push(`/opt/homebrew/opt/postgresql@${version}/bin/${binName}`);
	}
	candidates.push(binName);
	return candidates;
}

/**
 * The pg_restore that verifies an artifact, or null when this host has none.
 * Null is a first-class answer: it degrades every verdict to "unverifiable"
 * (usable, unproven) instead of refusing backups the host simply cannot read.
 * Unlike resolvePgDump the bare-PATH entry is RESOLVED (Bun.which), because
 * here "not found" is a verdict, not a fallback.
 */
export function resolvePgRestore(): string | null {
	const candidates = pgBinCandidates(config.ops.pgBinPath, 'pg_restore');
	for (const candidate of candidates.slice(0, -1)) {
		if (existsSync(candidate)) return candidate;
	}
	return Bun.which('pg_restore');
}

/**
 * The wall clock one pg_restore stage may spend on an archive of `sizeBytes`:
 * `secondsPerGib` for every started GiB, never under a minute. The default rate
 * IS the config key; a test (or a caller that already read it) may pass its own.
 * Measured 2026-08-30: ~7.4 s/GB for a full read, so the default 60 s/GiB is ~8x
 * headroom — and a slow-storage install raises the key instead of waiving.
 * Clamped to MAX_VERIFY_BUDGET_MS (a timer cannot hold more).
 */
export function verifyBudgetMs(
	sizeBytes: number,
	secondsPerGib: number = config.ops.backupVerifySecondsPerGb,
): number {
	return Math.min(
		MAX_VERIFY_BUDGET_MS,
		Math.max(MIN_VERIFY_BUDGET_MS, Math.ceil(sizeBytes / 2 ** 30) * secondsPerGib * 1000),
	);
}

/**
 * First `length` bytes of a file as latin1 text ('' when unreadable). Opened
 * and read by DESCRIPTOR, never `readFileSync`: these files are gigabytes, and
 * reading one whole archive into memory to look at five bytes would turn a
 * panel probe into an OOM on the smallest install.
 */
function fileMagic(filePath: string, length: number): string {
	let fd: number | null = null;
	try {
		fd = openSync(filePath, 'r');
		const buffer = Buffer.alloc(length);
		const read = readSync(fd, buffer, 0, length, 0);
		return buffer.subarray(0, read).toString('latin1');
	} catch {
		return '';
	} finally {
		if (fd !== null) closeSync(fd);
	}
}

interface PgRestoreOutcome {
	ok: boolean;
	timedOut: boolean;
	/** Died by a signal WE did not send (the OOM killer, an operator). */
	signaled: boolean;
	detail: string;
}

/**
 * The server's environment as a child process inherits it — the ONE raw env read
 * in this module (config_env_tripwire allowlist). Read per call: a child gets the
 * environment of the moment it is spawned.
 */
function inheritedEnvironment(): Record<string, string> {
	return { ...(process.env as Record<string, string>) };
}

/**
 * pg_restore's environment: the server's own (a Debian `pg_wrapper` picks its
 * version from PGCLUSTER / ~/.postgresqlrc — dropping those could swap the
 * binary), with two deliberate differences:
 * - the MESSAGE LOCALE IS C. The host-vs-bytes verdict reads pg_restore's words
 *   (HOST_BOUND_FAILURE / ARCHIVE_DAMAGE); an NLS build translates them under the
 *   server's LANG, and a translated "unsupported version (1.99)" matched neither
 *   list, repeated on the re-read and was CACHED as a disproof of a good archive
 *   (OPS-6/PERF-11 review). LC_ALL outranks LANG and every LC_*, and under C
 *   gettext ignores LANGUAGE — so the words are the ones the lists were measured on.
 * - NO PGPASSWORD: every mode used here reads a file, never a database.
 */
function pgRestoreEnvironment(): Record<string, string> {
	const { PGPASSWORD: _credential, LANGUAGE: _languages, ...env } = inheritedEnvironment();
	return { ...env, LC_ALL: 'C', LC_MESSAGES: 'C', LANG: 'C' };
}

/**
 * Run pg_restore ASYNCHRONOUSLY under `budgetMs`; its stderr is the detail.
 * No PGPASSWORD and no connection parameters: every mode used here READS THE
 * FILE (`--list`, and `-f` to a path) and never opens a database, so the child
 * has no business carrying the credential. Its message locale is pinned to C
 * (`pgRestoreEnvironment`): the verdict below classifies its words.
 *
 * `timedOut` is OUR timer's flag and nothing else. A child killed from outside
 * also dies by signal: that is `signaled` — the verdict must say what WE did, and
 * a killed read proves nothing about the bytes. A spawn failure (a configured
 * binary that does not exist) THROWS: it is neither a verdict on the archive nor
 * a timeout.
 */
async function runPgRestore(
	bin: string,
	args: string[],
	budgetMs: number,
): Promise<PgRestoreOutcome> {
	const child = Bun.spawn([bin, ...args], {
		stdout: 'ignore',
		stderr: 'pipe',
		env: pgRestoreEnvironment(),
	});
	let timedOut = false;
	const timer = setTimeout(
		() => {
			timedOut = true;
			child.kill('SIGKILL');
		},
		Math.min(budgetMs, MAX_VERIFY_BUDGET_MS),
	);
	try {
		const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
		const signal = timedOut ? null : child.signalCode;
		return {
			ok: !timedOut && exitCode === 0,
			timedOut,
			signaled: signal !== null,
			detail:
				stderr.trim().slice(0, 500) || (signal === null ? '' : `pg_restore was killed (${signal})`),
		};
	} finally {
		clearTimeout(timer);
	}
}

/**
 * pg_restore's words for a failure that is about THIS FILE'S BYTES — the only
 * failures that may DISPROVE an artifact (and be cached, and get a file
 * retired). Measured with pg_restore 18 on real archives, in the C message
 * locale every spawn pins (`pgRestoreEnvironment`): a cut anywhere reads
 * "could not read from input file: end of file"; garbage after the magic reads
 * "unsupported version (<not 1>.<n>) in file header". The rest are the archive
 * reader's own corruption messages (pg_backup_archiver.c / pg_backup_custom.c).
 */
const ARCHIVE_DAMAGE =
	/could not read from input file: end of file|unexpected end of file|did not find magic string|unsupported version \((?!1\.)\d+\.\d+\)|could not find block ID|possibly corrupt|unrecognized data block type|found unexpected block ID|does not appear to be a valid archive|input file is too short|unrecognized file format|could not (?:un|de)compress data/i;

/**
 * Failures that are about THIS HOST, never the bytes: the backup storage failed
 * a read (EIO on a USB disk, a network mount that stalled), the file could not
 * be opened, or this pg_restore is older than the archive's format (a real
 * archive's format major is always 1). Never a disproof.
 */
const HOST_BOUND_FAILURE =
	/could not open input file|could not read from input file: (?!end of file)|unsupported version \(1\.\d+\)/i;

/** One pg_restore stage, classified: what the read says about the BYTES. */
interface StageOutcome {
	kind: 'passed' | 'timed_out' | 'damaged' | 'read_failed' | 'unrecognized';
	detail: string;
}

function classifyRead(run: PgRestoreOutcome): StageOutcome {
	if (run.timedOut) return { kind: 'timed_out', detail: run.detail };
	if (run.ok) return { kind: 'passed', detail: '' };
	if (run.signaled) return { kind: 'read_failed', detail: run.detail };
	if (HOST_BOUND_FAILURE.test(run.detail)) return { kind: 'read_failed', detail: run.detail };
	if (ARCHIVE_DAMAGE.test(run.detail)) return { kind: 'damaged', detail: run.detail };
	return { kind: 'unrecognized', detail: run.detail };
}

/**
 * Run one stage; a failure whose words are not recognized is READ AGAIN before
 * it may count against the file. The same failure twice is a property of the
 * bytes (a corrupt length field reads "out of memory" every time); anything else
 * — a different failure, or a pass — was this moment, not the file.
 */
async function readStage(bin: string, args: string[], budgetMs: number): Promise<StageOutcome> {
	const first = classifyRead(await runPgRestore(bin, args, budgetMs));
	if (first.kind !== 'unrecognized') return first;
	const second = classifyRead(await runPgRestore(bin, args, budgetMs));
	if (second.kind !== 'unrecognized') return second;
	return {
		kind: second.detail === first.detail ? 'damaged' : 'read_failed',
		detail: second.detail,
	};
}

/**
 * The full-read slot: at most ONE `pg_restore -f /dev/null` runs at a time in
 * this process. Each is a multi-GB sequential read; two in parallel only make
 * both slower and both likelier to outrun their budgets. A FIFO chain of
 * promises — `deepReadTail` is the settle-promise of the last reader queued.
 */
let deepReadTail: Promise<void> = Promise.resolve();

async function withDeepReadSlot<T>(run: () => Promise<T>): Promise<T> {
	const previous = deepReadTail;
	let releaseSlot: () => void = () => {};
	deepReadTail = new Promise<void>((resolveSlot) => {
		releaseSlot = resolveSlot;
	});
	await previous;
	try {
		return await run();
	} finally {
		releaseSlot();
	}
}

/** Has the file changed since `size`/`mtimeMs` were read? (A vanished file has.) */
function fileMoved(filePath: string, size: number, mtimeMs: number): boolean {
	try {
		const now = statSync(filePath);
		return now.size !== size || now.mtimeMs !== mtimeMs;
	} catch {
		return true;
	}
}

interface ArtifactStats {
	size: number;
	mtimeMs: number;
}

/** Builds a verdict for one artifact's (path, size, mtime). */
type Judge = (reason: BackupVerdictReason, detail?: string) => BackupVerdict;

function judgeOf(filePath: string, stats: ArtifactStats): Judge {
	return (reason, detail) => ({
		filePath,
		size: stats.size,
		mtimeMs: stats.mtimeMs,
		usable: verdictIsUsableReason(reason),
		verified: reason === 'verified_deep',
		reason,
		...(detail !== undefined && detail !== '' ? { detail } : {}),
	});
}

/**
 * THE VERDICT, pure: no sidecar read, no sidecar write, no sharing. What an
 * artifact IS, right now, by the one question (a full read). See the section
 * header for what each layer proves.
 *
 * The magic-byte gate before pg_restore is deliberate: an install whose
 * `*.backup` files are plain-SQL or foreign dumps (under any name but our
 * `.custom.backup` suffix) keeps behaving as it did before P0-13 (counted,
 * unproven) rather than being refused for a format we never claimed to verify.
 */
export async function judgeArtifact(
	filePath: string,
	options: VerifyOptions = {},
): Promise<BackupVerdict> {
	let stats: ArtifactStats;
	try {
		const stat = statSync(filePath);
		stats = { size: stat.size, mtimeMs: stat.mtimeMs };
	} catch {
		return { filePath, size: 0, mtimeMs: 0, usable: false, verified: false, reason: 'missing' };
	}
	const judge = judgeOf(filePath, stats);
	if (stats.size === 0) return judge('empty');
	const bin = options.pgRestoreBin === undefined ? resolvePgRestore() : options.pgRestoreBin;
	const unread = verdictWithoutReading(filePath, stats.mtimeMs, bin, options.nowMs);
	if (unread !== null) return judge(unread.reason, unread.detail);
	const budgetMs = options.budgetMs ?? verifyBudgetMs(stats.size);
	return { ...(await readArchive(filePath, stats, bin as string, budgetMs, judge)), budgetMs };
}

/**
 * The verdicts decided WITHOUT pg_restore: our suffix without the archive magic
 * (disproved), a foreign format, or a host with no pg_restore (degradations) —
 * null when the file must be read.
 *
 * AGE IS THE LAST RESORT, NOT THE FIRST TEST. A blanket "younger than
 * IN_PROGRESS_WINDOW_MS does not count" rejected a FINISHED, verified dump for
 * the first 90 seconds of its life (it broke update_preconditions.test.ts the day
 * it landed, 2026-08-30). Whether a dump is still being written is DECIDABLE
 * where pg_restore can read the file, so it is decided by the read; the window
 * survives only for the two hosts that CANNOT ask.
 */
function verdictWithoutReading(
	filePath: string,
	mtimeMs: number,
	bin: string | null,
	nowMs: number | undefined,
): { reason: BackupVerdictReason; detail?: string } | null {
	const unlessInProgress = (reason: BackupVerdictReason) => ({
		reason: (nowMs ?? Date.now()) - mtimeMs < IN_PROGRESS_WINDOW_MS ? 'in_progress' : reason,
	});
	if (fileMagic(filePath, CUSTOM_ARCHIVE_MAGIC.length) !== CUSTOM_ARCHIVE_MAGIC) {
		// OUR suffix is OUR grammar: every `*.custom.backup` this engine or the
		// nightly timer writes is `pg_dump -F c`, whose first bytes are the magic. A
		// file under that name without it — zero-filled after a crash, a copy that
		// wrote no data — is DISPROVED, not a foreign format to be counted blind.
		if (claimsCustomFormat(filePath)) {
			return { reason: 'not_an_archive', detail: 'no custom-format archive header (PGDMP)' };
		}
		return unlessInProgress('unverifiable_foreign_format');
	}
	if (bin === null) return unlessInProgress('unverifiable_no_pg_restore');
	return null;
}

/**
 * The two pg_restore stages. FAST FAIL first: a header/TOC that does not parse
 * needs no full read — its success proves nothing (a 60% cut lists every entry)
 * and yields no verdict. Then the full read, in the one-at-a-time slot.
 */
async function readArchive(
	filePath: string,
	stats: ArtifactStats,
	bin: string,
	budgetMs: number,
	judge: Judge,
): Promise<BackupVerdict> {
	const toc = await readStage(bin, ['--list', filePath], budgetMs);
	if (toc.kind !== 'passed') return stageVerdict(toc, 'not_an_archive', filePath, stats, judge);
	const full = await withDeepReadSlot(() =>
		readStage(bin, ['-f', '/dev/null', filePath], budgetMs),
	);
	if (full.kind === 'timed_out') {
		console.warn(
			`[backup] verification of '${filePath}' outran its ${budgetMs} ms budget — NOT counted as a restore point (DEDALO_BACKUP_VERIFY_SECONDS_PER_GB)`,
		);
	}
	if (full.kind !== 'passed') return stageVerdict(full, 'truncated', filePath, stats, judge);
	// RE-STAT: a verdict is about the bytes that were READ. If the file changed
	// during the read (a dump still appending, a copy in progress) a pass does not
	// describe what is on disk now.
	return fileMoved(filePath, stats.size, stats.mtimeMs)
		? judge('in_progress')
		: judge('verified_deep');
}

/**
 * A stage that did not pass: out of time; a file that MOVED under the read (a
 * live write, not a disproof); a failure about the bytes (`disproof`); or a read
 * that failed for another reason (proves nothing either way).
 */
function stageVerdict(
	stage: StageOutcome,
	disproof: 'not_an_archive' | 'truncated',
	filePath: string,
	stats: ArtifactStats,
	judge: Judge,
): BackupVerdict {
	if (stage.kind === 'timed_out') return judge('unverifiable_timeout');
	if (fileMoved(filePath, stats.size, stats.mtimeMs)) return judge('in_progress');
	if (stage.kind === 'damaged') return judge(disproof, stage.detail);
	return judge('unverifiable_read_failed', stage.detail);
}

interface VerifyFlight {
	promise: Promise<BackupVerdict>;
	/** Set only for a memoized TIMEOUT verdict: when it settled. */
	settledAt?: number;
	verdict?: BackupVerdict;
}

/**
 * Verifications in flight, keyed on FILE IDENTITY + how it is judged
 * (`realpath|size|mtimeMs|budgetMs|bin`) — never on request identity, so no
 * answer can bleed between principals: two askers of the same bytes get the
 * same bytes' verdict. An entry is deleted the moment it settles, EXCEPT a
 * timeout verdict, memoized for TIMEOUT_MEMO_MS (swept on access) so a slow host
 * is not re-read on every panel poll. The budget is in the key, so raising
 * DEDALO_BACKUP_VERIFY_SECONDS_PER_GB forces a fresh read.
 */
const verifyInFlight = new Map<string, VerifyFlight>();

function sweepTimeoutMemo(nowMs: number): void {
	for (const [key, flight] of verifyInFlight) {
		if (flight.settledAt !== undefined && nowMs - flight.settledAt > TIMEOUT_MEMO_MS) {
			verifyInFlight.delete(key);
		}
	}
}

/**
 * Is this artifact a restore point? The CACHED, SINGLE-FLIGHT door over
 * `judgeArtifact`: a trusted sidecar answers first; otherwise concurrent askers
 * share one read, and a decisive verdict is written to the sidecar.
 */
export async function verifyBackupArtifact(
	filePath: string,
	options: VerifyOptions = {},
): Promise<BackupVerdict> {
	let size: number;
	let mtimeMs: number;
	try {
		const stats = statSync(filePath);
		size = stats.size;
		mtimeMs = stats.mtimeMs;
	} catch {
		return { filePath, size: 0, mtimeMs: 0, usable: false, verified: false, reason: 'missing' };
	}
	if (size === 0) {
		return { filePath, size, mtimeMs, usable: false, verified: false, reason: 'empty' };
	}
	const cached = readVerdictSidecar(filePath, size, mtimeMs);
	if (cached !== null) return cached;

	const bin = options.pgRestoreBin === undefined ? resolvePgRestore() : options.pgRestoreBin;
	const budgetMs = options.budgetMs ?? verifyBudgetMs(size);
	let identity = filePath;
	try {
		identity = realpathSync(filePath);
	} catch {
		/* judged under the given path */
	}
	const key = `${identity}|${size}|${mtimeMs}|${budgetMs}|${bin ?? ''}`;
	sweepTimeoutMemo(Date.now());
	const existing = verifyInFlight.get(key);
	if (existing !== undefined) {
		const shared = existing.verdict ?? (await existing.promise);
		return { ...shared, filePath };
	}
	const flight: VerifyFlight = {
		promise: judgeArtifact(filePath, { pgRestoreBin: bin, budgetMs, nowMs: options.nowMs }).then(
			(verdict) => {
				if (CACHEABLE_REASONS.has(verdict.reason)) writeVerdictSidecar(verdict);
				if (verdict.reason === 'unverifiable_timeout') {
					flight.settledAt = Date.now();
					flight.verdict = verdict;
				} else {
					verifyInFlight.delete(key);
				}
				return verdict;
			},
			(error: unknown) => {
				verifyInFlight.delete(key);
				throw error;
			},
		),
	};
	verifyInFlight.set(key, flight);
	return flight.promise;
}

export interface NewestUsableBackup {
	/** mtime of the newest artifact that counts as a restore point (0 = none). */
	mtimeMs: number;
	/** Its verdict, or null when nothing in the directory counts. */
	verdict: BackupVerdict | null;
	/** Newer artifacts that were REFUSED — what the operator must be told about. */
	rejected: BackupVerdict[];
}

/** A bounded wait that lost the race: the shared scan is still verifying `candidate`. */
export interface PendingBackupScan {
	pending: true;
	/** The artifact being verified when the wait ran out (null: none reached yet). */
	candidate: string | null;
}

interface ScanFlight {
	promise: Promise<NewestUsableBackup>;
	/** The artifact the walk is verifying right now — what a lost wait reports. */
	current: string | null;
}

/**
 * Directory scans in flight, keyed on the directory, how its files are judged,
 * AND the directory's GENERATION (every artifact's name, size and mtime at the
 * moment of asking). The panel's bounded wait and the pipeline's settled ask
 * share ONE walk — but only a walk over the SAME artifacts: a walk snapshots its
 * candidate list when it starts, so an asker who arrives after a new dump was
 * promoted (or an artifact changed) must not inherit a verdict that never looked
 * at it — it would be refused "no usable backup" beside a proven fresh one. The
 * entry is deleted when the walk settles, so a later ask always walks again (and
 * hits the sidecars). No request identity.
 */
const scanInFlight = new Map<string, ScanFlight>();

/** The artifacts a walk judges, newest first — and the generation that names them. */
function scanSnapshot(backupDir: string): { candidates: StatableBackup[]; generation: string } {
	const candidates = statableBackups(backupDir).sort((a, b) => b.mtimeMs - a.mtimeMs);
	const identity = candidates
		.map((artifact) => `${artifact.name}\0${artifact.size}\0${artifact.mtimeMs}`)
		.sort()
		.join('\n');
	return { candidates, generation: Bun.hash(identity).toString(36) };
}

async function walkCandidates(
	candidates: StatableBackup[],
	options: VerifyOptions,
	flight: ScanFlight,
): Promise<NewestUsableBackup> {
	const rejected: BackupVerdict[] = [];
	for (const candidate of candidates.slice(0, MAX_VERIFY_CANDIDATES)) {
		flight.current = candidate.path;
		const verdict = await verifyBackupArtifact(candidate.path, options);
		if (verdict.usable) return { mtimeMs: candidate.mtimeMs, verdict, rejected };
		rejected.push(verdict);
	}
	return { mtimeMs: 0, verdict: null, rejected };
}

function sharedScan(backupDir: string, options: VerifyOptions): ScanFlight {
	const { candidates, generation } = scanSnapshot(backupDir);
	const key = [
		resolvePath(backupDir),
		generation,
		String(options.pgRestoreBin),
		String(options.budgetMs),
		String(options.nowMs),
	].join('\0');
	const existing = scanInFlight.get(key);
	if (existing !== undefined) return existing;
	const flight: ScanFlight = { promise: Promise.resolve(null as never), current: null };
	flight.promise = walkCandidates(candidates, options, flight).finally(() => {
		scanInFlight.delete(key);
	});
	// A scan whose bounded waiter gave up runs on DETACHED: its failure must be
	// logged, never an unhandled rejection. (Awaiting callers still see it.)
	flight.promise.catch((error: unknown) => {
		console.error(`[backup] backup scan of '${backupDir}' failed:`, error);
	});
	scanInFlight.set(key, flight);
	return flight;
}

/**
 * The newest artifact in `backupDir` that counts as a RESTORE POINT, newest
 * first — the SETTLED answer. This, not `newestBackupMtimeMs`, is what every
 * "do we have a backup" question must ask (P0-13).
 */
export function newestUsableBackup(
	backupDir: string = getBackupDir(),
	options: VerifyOptions = {},
): Promise<NewestUsableBackup> {
	return sharedScan(backupDir, options).promise;
}

/**
 * The SAME shared scan, waited on for at most `maxWaitMs` — the HTTP surfaces'
 * door. A lost wait never computes a second verdict: it reports which artifact
 * is still being read, and the scan carries on for the next asker.
 */
export async function newestUsableBackupWithin(
	maxWaitMs: number,
	backupDir: string = getBackupDir(),
	options: VerifyOptions = {},
): Promise<NewestUsableBackup | PendingBackupScan> {
	const flight = sharedScan(backupDir, options);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const lost = new Promise<null>((resolveLost) => {
		timer = setTimeout(() => resolveLost(null), maxWaitMs);
	});
	try {
		const settled = await Promise.race([flight.promise, lost]);
		return settled ?? { pending: true, candidate: flight.current };
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Retire an artifact a failed dump left behind: delete it when empty (its writer
 * has exited — this is never called on an orphan), otherwise move it aside
 * (default `<source>.failed`, else the first free `<source>.failed.<n>` — an
 * earlier failure under the same name is NEVER overwritten). NEVER leave a corpse
 * that looks like a backup — the name is what every scanner here matches on
 * (`*.backup`), so a retired corpse disappears from the widget list, from
 * `newestBackupMtimeMs` and from the update precondition, while staying on disk
 * for the operator to look at.
 */
function retireFailedArtifact(source: string, retiredAs = `${source}.failed`): void {
	if (!existsSync(source)) return;
	try {
		if (statSync(source).size === 0) {
			unlinkSync(source);
			return;
		}
		const keptAs = moveAside(source, retiredAs);
		console.error(
			keptAs === null
				? `[backup] failed dump '${source}' NOT retired: no free name next to '${retiredAs}'`
				: `[backup] failed dump retired as '${keptAs}' — it is NOT a restore point`,
		);
	} catch (error) {
		console.error(`[backup] could not retire failed artifact '${source}': ${error}`);
	}
}
