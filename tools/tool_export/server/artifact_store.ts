/**
 * THE EXPORT ARTIFACT STORE — where tool_export's background job keeps what it
 * builds: the SPOOL (the full protocol stream, written once, read many times)
 * and the FILES built from it (csv, tsv, html, xlsx, ods, ndjson, media zip).
 *
 * LAYOUT (one directory per export, per owner):
 *
 *   <root>/<userId>/<jobId>/request.json    the IMMUTABLE request: options + read set,
 *                                           written ONCE at createJob (temp+rename)
 *                           manifest.json   owner, status, counts — the MUTABLE state
 *                                           every checkpoint rewrites (temp+rename)
 *                           grid.ndjson     EVERY protocol line, byte-identical to the
 *                                           get_export_grid stream (meta, col*, row*, end)
 *                           cols.ndjson     the 'col' lines only (the header, readable
 *                                           without scanning the grid)
 *                           grid.idx        fixed-width byte offsets: line k = offset in
 *                                           grid.ndjson of the first row of record k*R
 *                           media.ndjson    the MEDIA ADDRESSES the walk read, one line per
 *                                           record that read any ({rec, a:[[col, section_tipo,
 *                                           section_id, component_tipo], …]} —
 *                                           src/diffusion/export/row_media.ts); created only
 *                                           when the first one arrives, never served; the
 *                                           media ZIP's input (manifest `media_models`)
 *                           export[_v].<ext> built files (temp+rename, never partial);
 *                                           v = a hash of the options that change the bytes
 *                           media[_v].zip   the media archive (v = the quality choice)
 *
 * THE ROOT. `config.ops.exportArtifactsDir` (DEDALO_EXPORT_ARTIFACTS_DIR, default
 * `<privateDir>/export_artifacts` — private, never web-served: every byte leaves
 * through the owner-checked download route — ENFORCED: a root that is, sits
 * inside or contains a web-served tree (the media root, the client tree;
 * symlinks followed) is refused by every writing door and the boot sweep,
 * `assertExportArtifactsPlacement`). UNDER THE TEST SEAM
 * (`DEDALO_TEST_MEDIA_ROOT` set — the ONE key that arms every suite file guard,
 * src/core/media/test_media_root.ts) the seam OUTRANKS the key, exactly as it
 * outranks MEDIA_PATH, and the root is `<test media root>.export_artifacts`:
 * a sibling of the suite's own marked tree. Armed, EVERY root this store opens
 * must carry the `.dedalo_test_export_artifacts` marker or it refuses before it
 * writes — naming itself, the root, and that nothing was written. The derived
 * root is created and marked HERE, and only when the test media root it derives
 * from is itself marked (provenance: a declared test root declares its sibling);
 * a root a gate passes explicitly is never auto-marked — the gate declares it
 * (`markExportArtifactsRoot` in test/helpers/media_scratch_root.ts), the same law as
 * the media scratch roots.
 *
 * CONFINEMENT. Every path this store opens is built from validated parts
 * (`userId` a safe integer, `jobId` /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/, a file
 * name from a closed allowlist) AND re-checked with
 * `resolve(p).startsWith(dir + sep)`; a symlink is never served. The download
 * route reuses `resolveArtifactFile` — one confinement, not two.
 *
 * LIFECYCLE. An export is a SNAPSHOT with a fixed lifetime: it expires
 * `ttlHours` after its END (finished, failed, cancelled or interrupted —
 * `exportExpired`, a HARD ceiling: a file built from it later never extends it,
 * so no export outlives its end + TTL however often files are rebuilt). An
 * expired export is not-found at every door at once (access.ts), and its
 * directory is swept — never while a file build holds a
 * live lease on it (`builds`, FileBuildLease: taken, released and consulted
 * under the manifest lock, so the sweep cannot remove a directory a build is
 * writing into, nor a file committed but not yet recorded); a RUNNING export is never touched while
 * its owner lives. It is marked `interrupted` (partial spool deleted — the user
 * runs it again, there is no resume) when its owner is certainly gone — another
 * boot wrote it and its pid is dead, or is OURS (pid reuse: a container's bun is
 * PID 1 on every start) — or when another boot's job has not heartbeaten
 * (manifest `updated_at`) for DEAD_WRITER_SILENCE_MS (1 h, the writer's cadence,
 * never the TTL). The sweep runs at boot and hourly
 * (`startExportArtifactSweeper`). The OWNER may delete an export before its
 * TTL (`deleteIdleJob`, tool_export.delete_export_job) under the SAME lock and
 * the SAME liveness rules (runningJobLive, liveBuildTemps): never while it runs
 * or a file is being built from it (`export.artifact_busy` — stop it first).
 *
 * QUOTA. The bytes one user holds under `<root>/<userId>` may not exceed
 * `quotaBytes` (DEDALO_EXPORT_ARTIFACTS_QUOTA_BYTES, 0 = off). Checked when a job
 * is created and ENFORCED while bytes are written, so an export that would
 * overflow stops with `export.artifact_quota` instead of filling the disk. The
 * budget is ONE per user, shared by every writer of that user at once (and by
 * every process on the root): a writer never spends a private snapshot; it
 * re-measures the user's directory (the truth, whoever wrote it) every
 * `quotaRecheckStep(quota)` bytes, after pushing its own buffered bytes to disk.
 * A writer's SCRATCH (an unlinked side file in the job directory, which the
 * directory measure cannot see — media_zip's failure log) is admitted through
 * the SAME meter before it is written (`FileSink.admitScratch`) and counted
 * against the quota from then on, so it never grows past the quota or the
 * volume floor either.
 * The bound is therefore quota + Σ over the user's LIVE writers of (one
 * re-check step + one unfinished spool record) — a step is quota/64 (at most
 * 16 MiB), so a few percent of the quota at worst, never N × quota.
 *
 * TWO MORE BOUNDS beside the bytes. COUNT: a user keeps at most `maxExports`
 * exports (DEDALO_EXPORT_ARTIFACTS_MAX_EXPORTS, 0 = off; `export.artifact_count`
 * at createJob) — a tiny export costs almost no bytes, yet every list and
 * reclaim reads each one. VOLUME: the quota is per user, so N users hold up to
 * N quotas; the store never lets the root's volume fall below `minFreeBytes`
 * free (DEDALO_EXPORT_ARTIFACTS_MIN_FREE_BYTES, 0 = off; `export.storage_low`),
 * checked at every writing door and by the same meter while bytes are written
 * — the default root shares ../private with the session store and settings.
 *
 * MANIFEST = request.json + manifest.json. The caller-sized part (the recorded
 * options — up to MANIFEST_OPTIONS_MAX_BYTES — and the read set derived from
 * them) never changes after createJob, so it lives in its own file, written
 * once; `manifest.json` holds only the small mutable state. A checkpoint (up
 * to 4 per second for the whole walk) rewrites a few hundred bytes, never the
 * options; a listing reads every job's small state and parses a job's options
 * only when it needs them (listJobs `where`). `readManifest` answers the
 * joined record, so readers see one ExportManifest.
 *
 * Every read-modify-write (`updateManifest`, the sweep's interrupt)
 * holds the job's `manifest.json.lock` (created atomically with its holder's
 * token, stale after 30 s, taken over and released only by token under a
 * per-instance breaker — withManifestLock), so parallel builds of one job
 * never lose each other's `files` entries, and a stale takeover never admits
 * two holders.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
	type FileHandle,
	link,
	lstat,
	mkdir,
	open,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	stat,
	statfs,
	unlink,
	writeFile,
} from 'node:fs/promises';
import { dirname, join, basename as pathBasename, resolve, sep } from 'node:path';
import { config } from '../../../src/config/config.ts';
import { DedaloError, type ErrorDetailScalar } from '../../../src/core/errors/index.ts';
import { isTempSibling, tempPathFor } from '../../../src/core/files/temp_path.ts';
import { mediaRootIsMarked } from '../../../src/core/media/test_media_root.ts';
import { getBackgroundJob } from '../../../src/core/tools/background.ts';
import { getRoots as getToolRoots } from '../../../src/core/tools/paths.ts';
import { type ExportExternalDegradation, rowMediaOf } from '../../../src/diffusion/api/export.ts';

// ---------------------------------------------------------------------------
// Names, formats, grammar
// ---------------------------------------------------------------------------

/** The marker file an export root must carry under the test seam. */
export const EXPORT_ARTIFACTS_TEST_MARKER = '.dedalo_test_export_artifacts';

/**
 * THE OWNERSHIP MARKER — on EVERY install, not only under the test seam. The
 * store plants it when it first uses a root that is empty (or that it just
 * created), and every door that writes or deletes — the hourly TTL sweep first
 * among them — refuses a non-empty root without it. The root's NAME is not
 * proof of ownership: DEDALO_EXPORT_ARTIFACTS_DIR pointed at a shared mount that
 * holds `<year>/<batch>` directories would otherwise have them aged and deleted
 * recursively as manifest-less jobs every hour.
 */
export const EXPORT_ARTIFACTS_OWNER_MARKER = '.dedalo_export_artifacts';

/** The spool's fixed file names (never downloadable: they are the job's working copy). */
export const SPOOL_FILES = {
	grid: 'grid.ndjson',
	cols: 'cols.ndjson',
	index: 'grid.idx',
	/** The media-address sidecar (row_media.ts) — created lazily, only when a record read media. */
	media: 'media.ndjson',
	manifest: 'manifest.json',
	/** The immutable request (options + read set), written once — see MANIFEST in the module doc. */
	request: 'request.json',
} as const;

/** The spool's DATA files — what a failed/aborted run deletes (the manifest stays). */
const SPOOL_DATA_FILES: readonly string[] = [
	SPOOL_FILES.grid,
	SPOOL_FILES.cols,
	SPOOL_FILES.index,
	SPOOL_FILES.media,
];

/** The ExportManifest keys that live in request.json (immutable, caller-sized). */
export const MANIFEST_REQUEST_KEYS = ['options', 'sections'] as const;

/** The MUTABLE part of a manifest — what manifest.json holds. */
export type ExportJobState = Omit<ExportManifest, (typeof MANIFEST_REQUEST_KEYS)[number]>;

/** The IMMUTABLE part — what request.json holds (identity repeated, checked on read). */
export interface ExportJobRequest {
	v: 1;
	job_id: string;
	user_id: number;
	options: Record<string, unknown>;
	sections: string[];
}

/** The state half of a manifest (the request keys dropped — never written into manifest.json). */
export function manifestState(manifest: ExportManifest | ExportJobState): ExportJobState {
	const state = { ...manifest } as Record<string, unknown>;
	for (const key of MANIFEST_REQUEST_KEYS) delete state[key];
	return state as ExportJobState;
}

/** Records between two grid.idx entries (R). A page seek skips at most R-1 records. */
export const DEFAULT_INDEX_EVERY = 100;

/** Width of one grid.idx line: 16 zero-padded decimal digits + '\n' (random access by k*17). */
export const INDEX_LINE_BYTES = 17;

/**
 * The ceiling on a manifest's recorded `options`, serialized (UTF-8 bytes).
 * The manifest is re-read and re-parsed on every checkpoint, preview page,
 * file build, download and listing (listJobs holds every one in memory), so
 * what a caller sends is PERSISTED cost, not a one-off parse: an unbounded
 * options object turned one request body into gigabytes of repeated JSON work.
 * 1 MiB holds a maximal SQO (MAX_SQO_NODES) of realistic nodes plus a wide
 * ddo list; the per-user listing is then bounded by count × this. createJob
 * refuses above it (defence in depth — the export door refuses first,
 * before the producer opens).
 */
export const MANIFEST_OPTIONS_MAX_BYTES = 1024 * 1024;

/** Refuse (request.invalid_options) a recorded-options object over the ceiling. */
export function assertManifestOptionsSize(options: Record<string, unknown>): void {
	const bytes = Buffer.byteLength(JSON.stringify(options) ?? '');
	if (bytes > MANIFEST_OPTIONS_MAX_BYTES) {
		throw new DedaloError('request.invalid_options', {
			publicMessage: `The export options are too large (${bytes} bytes; the maximum is ${MANIFEST_OPTIONS_MAX_BYTES})`,
			coordinates: { bytes, limit: MANIFEST_OPTIONS_MAX_BYTES },
		});
	}
}

/** Every downloadable format the export can build. */
export const EXPORT_FORMATS = ['csv', 'tsv', 'html', 'xlsx', 'ods', 'ndjson', 'media_zip'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/**
 * THE FILE COUNT BOUND — at most this many built files of ONE format per
 * export. A file's NAME is a function of the options that change its bytes
 * (writers/index.ts artifactFileVariant), and one of them, the media-link
 * `origin`, comes from the caller's browser: without a bound, one user could
 * commit a new tiny file per distinct origin, growing `manifest.files` (parsed
 * by every listing, preview and download) and the inode count without limit
 * while the byte quota barely moved. A commit past the bound evicts that
 * format's OLDEST file (its download link answers 404; asking again rebuilds
 * it). Legitimate use needs a handful: the tipo-in-label toggle × an origin or
 * two, the media qualities.
 */
export const MAX_FILES_PER_FORMAT = 4;

/**
 * The files to EVICT when `committed` joins `files`: the oldest of its format
 * past MAX_FILES_PER_FORMAT (never `committed` itself). Pure.
 */
export function filesPastFormatBound(
	files: Readonly<Record<string, ExportArtifactFile>>,
	committed: ExportArtifactFile,
	limit: number = MAX_FILES_PER_FORMAT,
): string[] {
	const others = Object.values(files)
		.filter((file) => file.format === committed.format && file.basename !== committed.basename)
		.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
	const excess = others.length + 1 - limit;
	return excess > 0 ? others.slice(0, excess).map((file) => file.basename) : [];
}

/** Per-format file extension + served Content-Type. */
export const FORMAT_SPECS: Readonly<
	Record<ExportFormat, { readonly extension: string; readonly contentType: string }>
> = {
	csv: { extension: 'csv', contentType: 'text/csv; charset=utf-8' },
	tsv: { extension: 'tsv', contentType: 'text/tab-separated-values; charset=utf-8' },
	html: { extension: 'html', contentType: 'text/html; charset=utf-8' },
	xlsx: {
		extension: 'xlsx',
		contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	},
	ods: { extension: 'ods', contentType: 'application/vnd.oasis.opendocument.spreadsheet' },
	ndjson: { extension: 'ndjson', contentType: 'application/x-ndjson; charset=utf-8' },
	media_zip: { extension: 'zip', contentType: 'application/zip' },
};

const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const USER_DIR_PATTERN = /^-?\d{1,15}$/;
const VARIANT_PATTERN = /^[a-z0-9]{1,32}$/;
/** THE download allowlist: built files only — the spool and the manifest are never served. */
const DOWNLOADABLE_NAME_PATTERN =
	/^(?:export(?:_[a-z0-9]{1,32})?\.(?:csv|tsv|html|xlsx|ods|ndjson)|media(?:_[a-z0-9]{1,32})?\.zip)$/;

/** Is `name` a file name the download route may serve? (closed allowlist) */
export function isDownloadableArtifactName(name: string): boolean {
	return DOWNLOADABLE_NAME_PATTERN.test(name);
}

/** Is `jobId` a well-formed artifact id? */
export function isValidArtifactJobId(jobId: string): boolean {
	return JOB_ID_PATTERN.test(jobId) && jobId !== '.' && jobId !== '..';
}

/** A fresh, collision-free artifact id (job ids of the lane manager repeat across restarts). */
export function newArtifactJobId(): string {
	return `exp_${Date.now().toString(36)}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

/**
 * The final file name of a format: `export.<ext>` / `media.zip`, or with a
 * `variant` (/^[a-z0-9]{1,32}$/) `export_<variant>.<ext>` / `media_<variant>.zip`.
 * The variant is derived by writers/index.ts artifactFileVariant from every
 * option that changes the bytes, so two option sets never share a file.
 */
export function artifactFileName(format: ExportFormat, variant?: string): string {
	if (variant !== undefined && variant !== '' && !VARIANT_PATTERN.test(variant)) {
		throw new DedaloError('request.invalid_options', {
			message: `artifactFileName: variant '${variant}' is not /^[a-z0-9]{1,32}$/`,
		});
	}
	const suffix = variant === undefined || variant === '' ? '' : `_${variant}`;
	if (format === 'media_zip') return `media${suffix}.zip`;
	return `export${suffix}.${FORMAT_SPECS[format].extension}`;
}

/**
 * `resolve(dir, name)` confined to `dir`, or null. The ONE confinement check —
 * the download route reuses it through `resolveArtifactFile`.
 */
export function confinedPath(dir: string, name: string): string | null {
	if (name === '' || name.includes('\0')) return null;
	const base = resolve(dir);
	const candidate = resolve(base, name);
	return candidate.startsWith(base + sep) ? candidate : null;
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export type ExportJobStatus = 'running' | 'ended' | 'failed' | 'cancelled' | 'interrupted';

/** One built file, as recorded in the manifest. */
export interface ExportArtifactFile {
	format: ExportFormat;
	basename: string;
	bytes: number;
	rows: number;
	created_at: string;
}

export interface ExportManifest {
	v: 1;
	job_id: string;
	user_id: number;
	status: ExportJobStatus;
	/** The lane manager's job id (job_follow / stop_process), when the job records it. */
	background_job_id: string | null;
	/** The process that owns a running job (the sweep's liveness test). */
	owner_pid: number;
	owner_boot: string;
	section_tipo: string;
	/** Every section the selection reads (the download route re-checks read access on each). */
	sections: string[];
	/** The export options as the job ran them. */
	options: Record<string, unknown>;
	/**
	 * The owner's RECORD SCOPE when the walk ran (access.ts exportRecordScope:
	 * global-admin flag; else projects + the dd478 record allow-list). Every later read asks it again and a
	 * different answer is not-found: the spool holds the records THAT scope
	 * could read, and is served only while the scope is the same.
	 */
	record_scope: string;
	application_lang: string;
	created_at: string;
	/** Refreshed on every checkpoint — a running job's heartbeat. */
	updated_at: string;
	ended_at: string | null;
	/** The 'meta' protocol line, once seen. */
	meta: Record<string, unknown> | null;
	/** Records the selection holds (meta.total), once known. */
	total: number | null;
	records: number;
	rows: number;
	spool_bytes: number;
	/**
	 * The grid bytes COMMITTED — written completely, at a record boundary — as of
	 * the last checkpoint (the whole grid once ended). A preview reads the grid
	 * only up to here: past it a flush may still be in flight, and a record read
	 * half-written would be served cut short (SpoolStats.committedGridBytes).
	 */
	grid_bytes: number;
	/** end.columns — the authoritative display order, once ended. */
	columns: number[] | null;
	index_every: number;
	unresolved: string[];
	/**
	 * The export's external-source summary (grid.ts
	 * OpenedExportGrid.externalDegradation), recorded at every checkpoint and
	 * at the end; null = nothing degraded. Optional: absent on a manifest
	 * written before 2026-09-24 (read as null).
	 */
	external_degraded?: ExportExternalDegradation | null;
	/**
	 * THE MEDIA MODELS the export READ (row_media.ts): the distinct media models
	 * of every component the walk captured into `media.ndjson`, at any path
	 * depth, recorded at every checkpoint and at the end — data-exact (a portal
	 * whose targets hold no file offers nothing). Its PRESENCE marks a spool
	 * built with media capture: the media ZIP then resolves related media from
	 * the sidecar. Absent on a manifest written before 2026-09-24 (or a spool
	 * written outside runExportArtifact): the ZIP reads only columns whose own
	 * model is a media model, as before, and says so in info.txt.
	 */
	media_models?: string[];
	frontier_refusals: unknown[];
	/**
	 * The RUNTIME (section, component) grants the walk's frontier allowed so
	 * far — the pairs the spooled values were read under that no DECLARED
	 * segment names (grid.ts OpenedExportGrid.frontierGrants). Written at every
	 * checkpoint and at the end, so it always covers the committed spool; every
	 * later read re-asks each pair (access.ts exportStillReadable), and a
	 * manifest without the list is bound to none (fail closed).
	 */
	frontier_grants: { section_tipo: string; component_tipo: string }[];
	files: Record<string, ExportArtifactFile>;
	/**
	 * The file builds IN PROGRESS on this export, keyed by their temp basename
	 * (see FileBuildLease). Absent on a manifest no build ever touched.
	 */
	builds?: Record<string, FileBuildLease>;
	/**
	 * Why the export did not end: the registry CODE and the throw's details
	 * ALREADY FILTERED by the error converter (`toErrorBody`: `details_keys`,
	 * scalars only) — never a message, never a coordinate; the manifest is served
	 * back to its owner. The label is NOT stored: it is the registry's, looked up
	 * when the summary is served (export_job.ts summarizeJob).
	 */
	error: { code: string; details?: Record<string, ErrorDetailScalar> } | null;
}

/**
 * One file build in progress — taken under the manifest lock in the same step
 * that creates the temp file (`openFileSink`), released under it in the same
 * step that renames the file and records it (`commit`) or deletes the temp
 * (`abort`). The TTL sweep decides expiry under that lock too, so it never
 * removes a directory a live build is writing into. Liveness follows the
 * running-job rule: a lease of THIS boot is live (its build is in this
 * process); a lease of another boot is dead when its process certainly is
 * (pid dead, or ours — pid reuse), else live while its temp still grows
 * (mtime within the stale-temp age).
 */
export interface FileBuildLease {
	/** The final basename the build commits to. */
	basename: string;
	owner_pid: number;
	owner_boot: string;
	started_at: string;
}

/** What a caller supplies to create a job (the rest is the store's). */
export interface ExportJobInit {
	userId: number;
	/** Defaults to `newArtifactJobId()`. */
	jobId?: string;
	sectionTipo: string;
	sections: readonly string[];
	options: Record<string, unknown>;
	/** The owner's record scope when the walk starts (access.ts exportRecordScope). */
	recordScope: string;
	applicationLang: string;
	backgroundJobId?: string | null;
	indexEvery?: number;
}

/** A validated, confined reference to one export's directory. */
export interface ArtifactJobRef {
	readonly root: string;
	readonly userId: number;
	readonly jobId: string;
	readonly dir: string;
}

/** This process's identity for `owner_boot` (a restart is a different boot even if the pid repeats). */
export const STORE_BOOT_ID: string = randomUUID();

// ---------------------------------------------------------------------------
// Root resolution + the test-seam refusal
// ---------------------------------------------------------------------------

/** True when this process runs under the suite's file seam (the marker guard is armed). */
export function exportArtifactsGuardArmed(): boolean {
	return config.media.testRoot !== null;
}

/** The root the store uses when none is passed (see module doc for the seam rule). */
export function defaultExportArtifactsRoot(): string {
	const testRoot = config.media.testRoot;
	if (testRoot !== null) return `${resolve(testRoot)}.export_artifacts`;
	return resolve(config.ops.exportArtifactsDir);
}

/**
 * The mode of every directory this store creates: OWNER-ONLY. An export is a
 * copy of the archive's records (and a media zip a copy of its files), served
 * only through the owner-checked download route — never by the web server,
 * never readable by its group. Not MEDIA_DIR_MODE: this tree is not media.
 */
export const EXPORT_ARTIFACTS_DIR_MODE = 0o700;

/**
 * THE INSTALL THE STORE BELONGS TO. Jobs are keyed `<userId>/<jobId>` only, and
 * a global admin's record scope is the same constant on every install, so two
 * instances pointed at one DEDALO_EXPORT_ARTIFACTS_DIR (a copied example path,
 * one system user) would list, serve and sweep each other's exports: install
 * A's records to install B's admin. The owner marker therefore names the
 * install — a fingerprint of the database it serves (the archive IS the
 * database; opaque, never the name) — and a root claimed by another install
 * is refused by every door, reads included (ArtifactStore readers check it
 * once per store).
 */
export function exportStoreInstallFingerprint(database: string = config.db.database): string {
	return createHash('sha256')
		.update(`dedalo-export-artifacts\u0000${database}`)
		.digest('hex')
		.slice(0, 32);
}

/** The marker line that carries the install fingerprint. */
const MARKER_INSTALL_PREFIX = 'install: ';

function ownerMarkerText(fingerprint: string): string {
	return `Dédalo export artifacts root — the export store owns this directory\n${MARKER_INSTALL_PREFIX}${fingerprint}\n`;
}

/**
 * The install the owner marker of `root` names: undefined when there is no
 * marker, null for a marker that names none (planted before the marker
 * carried it).
 */
async function markerInstall(root: string): Promise<string | null | undefined> {
	let text: string;
	try {
		text = await readFile(join(root, EXPORT_ARTIFACTS_OWNER_MARKER), 'utf8');
	} catch (error) {
		if (errnoCode(error) === 'ENOENT') return undefined;
		throw error;
	}
	for (const line of text.split('\n')) {
		if (line.startsWith(MARKER_INSTALL_PREFIX))
			return line.slice(MARKER_INSTALL_PREFIX.length).trim();
	}
	return null;
}

function foreignInstallError(root: string, door: string, found: string): DedaloError {
	return new DedaloError('export.store_unavailable', {
		message: `${door} REFUSED: the export artifacts root '${root}' belongs to ANOTHER installation (its owner marker names install ${found}, this one is ${exportStoreInstallFingerprint()}). Every instance needs its own DEDALO_EXPORT_ARTIFACTS_DIR — sharing one would serve one archive's exports to another's users. NOTHING WAS READ, WRITTEN OR DELETED.`,
		coordinates: { root, marker_install: found },
	});
}

/**
 * Refuse a root whose owner marker names another install (see
 * exportStoreInstallFingerprint). No marker, or one naming none: not refused
 * here (the claim adopts / upgrades it on the first write).
 */
export async function assertExportArtifactsRootInstall(root: string, door: string): Promise<void> {
	const found = await markerInstall(root);
	if (typeof found === 'string' && found !== exportStoreInstallFingerprint()) {
		throw foreignInstallError(root, door, found);
	}
}

/**
 * Claim `root` for the store (it exists): owned when it carries
 * EXPORT_ARTIFACTS_OWNER_MARKER naming THIS install; adopted (the marker
 * planted) when it holds nothing but the markers; otherwise REFUSED — a
 * directory with content the store did not plant is somebody else's, and so
 * is a root another install's marker names. Nothing is written or deleted.
 */
export async function claimExportArtifactsRoot(root: string, door: string): Promise<void> {
	const marker = join(root, EXPORT_ARTIFACTS_OWNER_MARKER);
	const fingerprint = exportStoreInstallFingerprint();
	const found = await markerInstall(root);
	if (found === fingerprint) return;
	if (typeof found === 'string') throw foreignInstallError(root, door, found);
	if (found === null) {
		// a marker from before it named its install: ours (the root was claimed),
		// now bound to this install
		await atomicWriteText(marker, ownerMarkerText(fingerprint));
		return;
	}
	const foreign = (await readdir(root)).filter(
		(name) => name !== EXPORT_ARTIFACTS_TEST_MARKER && name !== EXPORT_ARTIFACTS_OWNER_MARKER,
	);
	if (foreign.length > 0) {
		throw new DedaloError('export.store_unavailable', {
			message: `${door} REFUSED: the export artifacts root '${root}' is not empty and carries no '${EXPORT_ARTIFACTS_OWNER_MARKER}' marker, so the store does not own it (it holds ${foreign.length} entries it did not create). NOTHING WAS WRITTEN OR DELETED. Point DEDALO_EXPORT_ARTIFACTS_DIR at an empty directory the engine owns.`,
			coordinates: { root, entries: foreign.length },
		});
	}
	try {
		await writeFile(marker, ownerMarkerText(fingerprint), { flag: 'wx', mode: 0o600 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
		// planted concurrently: it must be OURS
		await assertExportArtifactsRootInstall(root, door);
	}
}

/**
 * Is `name` (an entry of a job directory) one the store itself creates? The
 * spool + manifest, the manifest lock and its per-instance breakers, temp
 * siblings, and built files. The sweep removes a manifest-less job directory
 * only when EVERY entry is one of these — never a directory holding anything
 * else, whatever its age.
 */
export function isStoreOwnedJobEntry(name: string): boolean {
	return (
		(Object.values(SPOOL_FILES) as string[]).includes(name) ||
		name === MANIFEST_LOCK ||
		name.startsWith(`${MANIFEST_LOCK}.break-`) ||
		isTempSibling(name) ||
		isDownloadableArtifactName(name)
	);
}

/**
 * Plant the test marker in the DERIVED suite root (created if missing) — only
 * `assertExportArtifactsRoot` calls it, once the marked test media root vouches
 * for its sibling. Async: this module is reachable from the route table, where
 * no call may block the one event loop (sync_io_on_request_path_tripwire). A
 * gate declares its OWN scratch root with test/helpers/media_scratch_root.ts
 * `markExportArtifactsRoot` (never auto-marked here).
 */
async function markDerivedExportArtifactsRoot(dir: string): Promise<string> {
	await mkdir(dir, { recursive: true, mode: EXPORT_ARTIFACTS_DIR_MODE });
	try {
		await writeFile(
			join(dir, EXPORT_ARTIFACTS_TEST_MARKER),
			'test export artifacts root — a test created this\n',
			{ flag: 'wx' },
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
	}
	return dir;
}

/** Does `root` carry the export test marker? */
export async function exportArtifactsRootIsMarked(root: string): Promise<boolean> {
	return pathExists(join(resolve(root), EXPORT_ARTIFACTS_TEST_MARKER));
}

/**
 * The client tree the web server publishes directly (deploy/nginx*.conf and
 * apache.conf alias `/dedalo/` onto it) — the same directory src/server.ts
 * CLIENT_ROOT serves.
 */
const CLIENT_TREE_DIR = resolve(import.meta.dir, '../../../client/dedalo');

/**
 * The trees served WITHOUT an owner check: the media root (the generated media
 * locations resolve files against it), the client tree, and EVERY tool root —
 * /dedalo/tools/<tool>/<rest> is served by the engine itself
 * (src/core/tools/serving.ts) with no session, .json and .html included, so an
 * export root under a tool root would publish every manifest and HTML export.
 * Both the resolved roots the loader serves (paths.ts getRoots) and the
 * configured extra roots as written (one missing at boot may appear later).
 * An export root may overlap none of them.
 */
export function webServedTrees(): string[] {
	const trees = [CLIENT_TREE_DIR];
	if (config.media.rootPath !== null) trees.push(resolve(config.media.rootPath));
	for (const root of getToolRoots()) trees.push(root.path);
	for (const extra of config.tools.additionalRoots) trees.push(resolve(extra.path));
	return [...new Set(trees)];
}

/** `path` with its symlinks resolved as far as it exists (the tail that does not exist yet is kept lexically). */
async function canonicalPath(path: string): Promise<string> {
	const absolute = resolve(path);
	const tail: string[] = [];
	let head = absolute;
	for (;;) {
		try {
			return join(await realpath(head), ...tail);
		} catch {
			const parent = dirname(head);
			if (parent === head) return absolute;
			tail.unshift(pathBasename(head));
			head = parent;
		}
	}
}

function overlaps(a: string, b: string): boolean {
	return a === b || a.startsWith(b + sep) || b.startsWith(a + sep);
}

/**
 * The web-served tree `root` overlaps (is, sits inside, or contains), or null.
 * Compared lexically AND after resolving symlinks, so a symlinked export dir
 * that lands in the media tree is caught too.
 */
export async function exportArtifactsPlacementConflict(
	root: string,
	servedTrees: readonly string[] = webServedTrees(),
): Promise<string | null> {
	const lexical = resolve(root);
	const canonical = await canonicalPath(lexical);
	for (const tree of servedTrees) {
		const treeLexical = resolve(tree);
		const treeCanonical = await canonicalPath(treeLexical);
		if (overlaps(lexical, treeLexical) || overlaps(canonical, treeCanonical)) return treeLexical;
	}
	return null;
}

/**
 * THE PLACEMENT RULE (DEDALO_EXPORT_ARTIFACTS_DIR "must NEVER sit inside a tree
 * the web server publishes"): an export is a full copy of records whose only
 * way out is the owner-checked download route; under the media root or the
 * client tree the web server would serve it to anyone who guessed the path,
 * and the 0700 mode fails when proxy and engine run as one user. Refused on
 * EVERY door that writes (and at the boot sweep), armed or not, before
 * anything is written.
 */
export async function assertExportArtifactsPlacement(root: string, door: string): Promise<void> {
	const conflict = await exportArtifactsPlacementConflict(root);
	if (conflict === null) return;
	throw new DedaloError('export.store_unavailable', {
		message: `${door} REFUSED: the export artifacts root '${resolve(root)}' overlaps the web-served tree '${conflict}' (DEDALO_EXPORT_ARTIFACTS_DIR must never be inside, equal to, or a parent of the media root or the client tree — the web server would publish every export). NOTHING WAS WRITTEN.`,
		coordinates: { root: resolve(root), served_tree: conflict },
	});
}

/**
 * THE ARMED DOOR. Inert on a real installation; under the test seam `root` must
 * carry the marker — except the DERIVED default root, which is created and
 * marked here when the (marked) test media root it derives from vouches for it.
 */
export async function assertExportArtifactsRoot(root: string, door: string): Promise<string> {
	if (!exportArtifactsGuardArmed()) return root;
	const resolved = resolve(root);
	if (await exportArtifactsRootIsMarked(resolved)) return resolved;
	const testRoot = config.media.testRoot as string;
	if (resolved === defaultExportArtifactsRoot() && mediaRootIsMarked(testRoot)) {
		await markDerivedExportArtifactsRoot(resolved);
		return resolved;
	}
	throw new DedaloError('export.store_unavailable', {
		message: `${door} REFUSED: the export artifacts root '${resolved}' carries no '${EXPORT_ARTIFACTS_TEST_MARKER}' marker file while the test seam is armed, so it has not declared itself a disposable test root. NOTHING WAS WRITTEN. Declare a scratch root with markExportArtifactsRoot() (test/helpers/media_scratch_root.ts) first.`,
		coordinates: { root: resolved },
	});
}

// ---------------------------------------------------------------------------
// Small fs helpers
// ---------------------------------------------------------------------------

function nowIso(now: number = Date.now()): string {
	return new Date(now).toISOString();
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * Sum of regular-file sizes under `dir` (symlinks are not followed, not
 * counted). A file with several HARD LINKS in the tree is counted ONCE (by
 * device + inode): the NDJSON download is the ended spool itself, linked into
 * place (writers/index.ts), and holds no second copy of the bytes.
 */
async function directoryBytes(dir: string, seen: Set<string> = new Set()): Promise<number> {
	let total = 0;
	let entries: import('node:fs').Dirent[];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return 0;
	}
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) total += await directoryBytes(path, seen);
		else if (entry.isFile()) {
			try {
				const info = await lstat(path);
				if (info.nlink > 1) {
					const identity = `${info.dev}:${info.ino}`;
					if (seen.has(identity)) continue;
					seen.add(identity);
				}
				total += info.size;
			} catch {
				// vanished between readdir and lstat (a concurrent sweep) — not held
			}
		}
	}
	return total;
}

/** Atomic text write (temp + rename). */
async function atomicWriteText(finalPath: string, text: string): Promise<void> {
	const temp = tempPathFor(finalPath);
	try {
		await writeFile(temp, text, { mode: 0o600 });
		await rename(temp, finalPath);
	} catch (error) {
		await rm(temp, { force: true });
		throw error;
	}
}

/** Atomic JSON write (temp + rename, same directory ⇒ same filesystem). */
async function atomicWriteJson(finalPath: string, value: unknown): Promise<void> {
	const temp = tempPathFor(finalPath);
	try {
		await writeFile(temp, `${JSON.stringify(value)}\n`);
		await rename(temp, finalPath);
	} catch (error) {
		await rm(temp, { force: true });
		throw error;
	}
}

function processAlive(pid: number): boolean {
	if (!Number.isSafeInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: it exists, it is simply not ours to signal.
		return (error as NodeJS.ErrnoException).code === 'EPERM';
	}
}

/**
 * The lane job recorded on `manifest`, ONLY when THIS boot wrote it; null
 * otherwise. Lane job ids are `<kind>_<pid>_<counter>` (media/jobs.ts nextId):
 * the counter restarts with the process and bun is PID 1 in the container on
 * every start, so another boot's id can equal a job of this one. Every reader
 * that ties a manifest to a lane job (liveness, list_export_jobs `pending`,
 * the served summary a reopened client matches on) goes through here, so a
 * new job is never bound to an old export.
 */
export function thisBootLaneJobId(
	manifest: Pick<ExportManifest, 'owner_boot' | 'background_job_id'>,
): string | null {
	if (manifest.owner_boot !== STORE_BOOT_ID) return null;
	const laneJobId = manifest.background_job_id;
	return typeof laneJobId === 'string' && laneJobId !== '' ? laneJobId : null;
}

/**
 * A 'running' manifest of THIS boot whose writer is certainly gone: the lane
 * job recorded on it (`background_job_id`) is no longer running in this
 * process — it returned or threw without a terminal manifest write (a failed
 * finalization whose failure write failed too) — or its record is gone (only
 * TERMINAL records are evicted, and the id was minted by this process before
 * the manifest existed). A manifest with no lane job id (a direct writer: the
 * gates) cannot be asked, and stays live.
 */
export function sameBootWriterGone(manifest: ExportJobState): boolean {
	const laneJobId = thisBootLaneJobId(manifest);
	if (typeof laneJobId !== 'string' || laneJobId === '') return false;
	return getBackgroundJob(laneJobId)?.status !== 'running';
}

/** A temp older than this is a crash leftover. */
const STALE_TEMP_MS = 60 * 60 * 1000;

/**
 * A foreign running export SILENT this long is dead, whatever its pid says.
 * Tied to the WRITER's cadence, never to the files' TTL: a live walk
 * heartbeats (`updated_at`) at every checkpoint — every completed record past
 * CHECKPOINT_MS, at most CHECKPOINT_RECORDS apart (export_job.ts) — so an hour
 * without one is a dead writer. The pid alone cannot prove life: kill(pid, 0)
 * answers EPERM for ANY live process of another user, and a restarted engine
 * (systemd: new pid) may find the dead one's pid reused by, say, a root cron
 * child. With the TTL in this bound (max(TTL, 1 h) = 24 h by default) such an
 * orphan stayed 'running' — undeletable, counted against the quota, polled —
 * for a day.
 */
export const DEAD_WRITER_SILENCE_MS = 60 * 60 * 1000;

/**
 * THE RUNNING-JOB LIVENESS RULE (one rule, three readers: the sweep, the
 * owner's delete, and every status a reader is served — effectiveJobStatus). A 'running' manifest of THIS boot is live (its writer is in
 * this process). Another boot's is dead when its owner certainly is — pid dead,
 * or OUR pid (pid reuse: bun is PID 1 in the container on every start) — or
 * when it has not heartbeaten (`updated_at`) for DEAD_WRITER_SILENCE_MS.
 */
function runningJobLive(manifest: ExportJobState, now: number): boolean {
	if (manifest.owner_boot === STORE_BOOT_ID) return !sameBootWriterGone(manifest);
	const ownerGone = manifest.owner_pid === process.pid || !processAlive(manifest.owner_pid);
	const heartbeatDead = now - Date.parse(manifest.updated_at) > DEAD_WRITER_SILENCE_MS;
	return !ownerGone && !heartbeatDead;
}

/**
 * The status a READER is served (list_export_jobs, get_export_preview): a
 * 'running' manifest is 'interrupted' exactly when runningJobLive says its
 * writer is gone — the verdict the sweep and deleteIdleJob act on, so the
 * client never offers Delete on an export the server would refuse as busy, nor
 * keeps polling one the sweep will interrupt. (`ttlHours` is accepted for the
 * callers' uniform shape; liveness does not depend on it — DEAD_WRITER_SILENCE_MS.)
 */
export function effectiveJobStatus(
	manifest: ExportJobState,
	options: { ttlHours?: number; now?: number },
): ExportJobStatus {
	if (manifest.status !== 'running') return manifest.status;
	return runningJobLive(manifest, options.now ?? Date.now()) ? 'running' : 'interrupted';
}

/**
 * HAS THIS EXPORT EXPIRED? A finished export (any status but 'running') expires
 * `ttlHours` after its END — `ended_at`, else its last heartbeat. A HARD
 * ceiling: nothing extends it (a file built from the export later does not),
 * so an export — a snapshot of what its owner could read when it ran — never
 * outlives end + TTL. A running export never expires here (the sweep's
 * liveness rule owns it). The ONE verdict: the sweep deletes by it and every
 * read door refuses by it (access.ts exportStillReadable), so an export past
 * its ceiling is gone for its owner at once, not at the next hourly sweep.
 */
export function exportExpired(
	manifest: Pick<ExportManifest, 'status' | 'ended_at' | 'updated_at'>,
	options: { ttlHours: number; now?: number },
): boolean {
	if (manifest.status === 'running') return false;
	const endedAt = Date.parse(manifest.ended_at ?? manifest.updated_at);
	// An unreadable end cannot be aged: expired (fail closed).
	if (!Number.isFinite(endedAt)) return true;
	const ttlMs = Math.max(0, options.ttlHours) * 60 * 60 * 1000;
	return (options.now ?? Date.now()) - endedAt > ttlMs;
}

function quotaError(quotaBytes: number, coordinates: Record<string, string | number>): DedaloError {
	return new DedaloError('export.artifact_quota', {
		details: { quota_bytes: quotaBytes },
		coordinates,
	});
}

function notFound(coordinates: Record<string, string | number>): DedaloError {
	return new DedaloError('export.artifact_not_found', { coordinates });
}

// ---------------------------------------------------------------------------
// The per-user quota, shared by every live writer (see QUOTA above)
// ---------------------------------------------------------------------------

const QUOTA_RECHECK_MIN_BYTES = 4096;
/**
 * The re-measure is a walk of the user's WHOLE export tree (every job, every
 * spool and built file — directoryBytes), so its cost is (bytes written /
 * step) x (files the user holds). At a 1 MiB ceiling a 5 GB export walked the
 * tree ~5,000 times — millions of lstat calls on the shared event loop for one
 * user's build. 16 MiB keeps the step proportional to the quota (quota/64) on
 * any real quota, and the bound it buys stays small: at most one step per LIVE
 * writer past the quota (a user has at most DEDALO_EXPORT_JOBS_PER_USER; the
 * export lanes are 1 + 2 slots per process for the volume floor).
 */
const QUOTA_RECHECK_MAX_BYTES = 16 * 1024 * 1024;

/** Bytes a writer may spend between two re-measurements: quota/64, within 4 KiB..16 MiB. */
export function quotaRecheckStep(quotaBytes: number): number {
	return Math.max(
		QUOTA_RECHECK_MIN_BYTES,
		Math.min(QUOTA_RECHECK_MAX_BYTES, Math.floor(quotaBytes / 64)),
	);
}

interface QuotaBudget {
	readonly quotaBytes: number;
	/** Bytes the user holds on disk NOW (less any file this writer replaces). */
	measure(): Promise<number>;
	overflow(): DedaloError;
	/** The installation-wide free-space floor (absent / minFreeBytes 0 = off). */
	floor?: VolumeFloor;
}

/** The export volume's free-space floor (see VOLUME in the module doc). */
interface VolumeFloor {
	readonly minFreeBytes: number;
	/** Bytes free on the export root's volume NOW. */
	freeBytes(): Promise<number>;
	low(): DedaloError;
}

interface QuotaMeter {
	/**
	 * Admit `bytes` more, or throw `overflow()`. Past the allowance it calls
	 * `settle` (push own buffered bytes to disk; returns the own bytes STILL not
	 * on disk) and re-measures the user's directory.
	 */
	admit(bytes: number, settle: () => Promise<number>): Promise<void>;
	/**
	 * Admit `bytes` the directory measure can NOT see (an unlinked scratch file):
	 * the same allowance and floor check as `admit`, and from then on the quota
	 * counts them on top of every `measure()`. The volume floor needs no such
	 * addition — statfs sees an unlinked file's blocks.
	 */
	admitHidden(bytes: number, settle: () => Promise<number>): Promise<void>;
}

function quotaMeter(budget: QuotaBudget | null): QuotaMeter {
	const quotaOn = budget !== null && budget.quotaBytes > 0;
	const floor = budget?.floor !== undefined && budget.floor.minFreeBytes > 0 ? budget.floor : null;
	if (budget === null || (!quotaOn && floor === null)) {
		return { async admit() {}, async admitHidden() {} };
	}
	const step = quotaOn ? quotaRecheckStep(budget.quotaBytes) : QUOTA_RECHECK_MAX_BYTES;
	let allowance = 0;
	/** Admitted bytes on disk that `budget.measure()` cannot see. */
	let hidden = 0;
	const admit = async (bytes: number, settle: () => Promise<number>): Promise<void> => {
		if (bytes <= allowance) {
			allowance -= bytes;
			return;
		}
		const unsettled = await settle();
		let remaining = Number.POSITIVE_INFINITY;
		if (quotaOn) {
			remaining = budget.quotaBytes - (await budget.measure()) - hidden - unsettled;
			if (bytes > remaining) throw budget.overflow();
		}
		if (floor !== null) {
			const spare = (await floor.freeBytes()) - floor.minFreeBytes - unsettled;
			if (bytes > spare) throw floor.low();
			remaining = Math.min(remaining, spare);
		}
		allowance = Math.max(0, Math.min(remaining, step) - bytes);
	};
	return {
		admit,
		async admitHidden(bytes, settle) {
			await admit(bytes, settle);
			hidden += bytes;
		},
	};
}

/** Bytes free (to an unprivileged writer) on the volume holding `path`. */
async function volumeFreeBytes(path: string): Promise<number> {
	const info = await statfs(path);
	return Number(info.bavail) * Number(info.bsize);
}

const MANIFEST_LOCK = 'manifest.json.lock';
/**
 * A lock older than this is a dead holder's. Generous on purpose: the longest
 * locked step is the owner's delete (`rm -r` of a job directory that may hold
 * gigabytes, on a slow mount), and a live holder must never be taken over.
 */
export const MANIFEST_LOCK_STALE_MS = 30_000;

/**
 * How long a waiter waits before `export.store_unavailable`: ALWAYS LONGER than
 * the stale threshold (×1.5). A lock left by a killed process (SIGKILL / OOM
 * inside a checkpoint's RMW) is young when the restarted engine meets it — the
 * boot sweep runs at once — and a waiter that gave up BEFORE the lock could turn
 * stale would never take it over: the sweep failed the job, and every owner
 * door answered store_unavailable until the lock was stale AND someone asked
 * again. With the wait past the threshold, the first waiter to meet a dead lock
 * outlives it and takes it over (gate: tool_export_artifact_store_native).
 */
export function manifestLockWaitMs(staleMs: number): number {
	return Math.ceil(staleMs * 1.5);
}

/** Timing seam of {@link withManifestLock} (gates only; production uses the defaults). */
export interface ManifestLockTiming {
	/** A lock (or a breaker) older than this is a dead holder's. */
	staleMs?: number;
	/** How long a waiter waits before `export.store_unavailable` (default manifestLockWaitMs(staleMs)). */
	waitMs?: number;
	/**
	 * Awaited between a waiter's stale verdict and its takeover — lets a gate
	 * pin the interleaving where another waiter takes the dead lock over first.
	 */
	beforeTakeover?: () => Promise<void>;
}

function errnoCode(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException | null)?.code;
}

/** The token a lock file holds; null when the file is gone. */
async function readLockToken(path: string): Promise<string | null> {
	try {
		return await readFile(path, 'utf8');
	} catch (error) {
		if (errnoCode(error) === 'ENOENT') return null;
		throw error;
	}
}

/** The breaker of ONE lock instance: named by a hash of its token (any content is safe). */
function lockBreakerPath(path: string, token: string): string {
	return `${path}.break-${createHash('sha256').update(token).digest('hex').slice(0, 32)}`;
}

/**
 * Create the lock WITH its token in one atomic step: write a temp, hard-link it
 * to the lock name (link fails EEXIST exactly like O_EXCL), drop the temp. A
 * lock file therefore never exists without its token.
 */
async function tryCreateLock(path: string, token: string): Promise<'held' | 'busy' | 'no_dir'> {
	const temp = tempPathFor(path);
	try {
		await writeFile(temp, token, { flag: 'wx' });
	} catch (error) {
		if (errnoCode(error) === 'ENOENT') return 'no_dir';
		throw error;
	}
	try {
		await link(temp, path);
		return 'held';
	} catch (error) {
		// ENOENT: the temp was swept (deleteSpool drops every temp) — just retry.
		const code = errnoCode(error);
		if (code === 'EEXIST' || code === 'ENOENT') return 'busy';
		throw error;
	} finally {
		await rm(temp, { force: true });
	}
}

/**
 * Remove the lock INSTANCE whose token is `token` — never another one. Every
 * removal of a lock (a holder's release, a waiter's stale takeover) goes
 * through here, under that instance's BREAKER (O_EXCL, named by the token): at
 * most one party at a time may remove one instance, and it re-reads the token
 * under the breaker, so a lock that was already replaced by a new holder's is
 * left alone. Answers false when another party holds the breaker.
 *
 * A breaker older than `staleMs` is a holder that died inside this few-ms
 * step: it is removed and the caller retries.
 */
async function removeLockInstance(path: string, token: string, staleMs: number): Promise<boolean> {
	const breaker = lockBreakerPath(path, token);
	try {
		await writeFile(breaker, '', { flag: 'wx' });
	} catch (error) {
		const code = errnoCode(error);
		if (code === 'ENOENT') return true; // the job directory is gone
		if (code !== 'EEXIST') throw error;
		try {
			if (Date.now() - (await stat(breaker)).mtimeMs > staleMs) await rm(breaker, { force: true });
		} catch {
			// released meanwhile
		}
		return false;
	}
	try {
		if ((await readLockToken(path)) === token) await rm(path, { force: true });
		return true;
	} finally {
		await rm(breaker, { force: true });
	}
}

/**
 * Run `fn` holding the job's manifest lock — cross-process, no module state.
 *
 * The lock is a file holding its holder's unique TOKEN. A waiter that finds it
 * older than `staleMs` (a holder that died mid-update — an RMW takes
 * milliseconds) takes it over through `removeLockInstance`: only the waiter
 * that wins the instance's breaker removes it, and only while it still holds
 * the token that was judged stale — two waiters can never both take over one
 * dead lock, nor can the loser delete the winner's fresh lock. A holder that
 * overran `staleMs` and was taken over releases through the same door, so it
 * never deletes its successor's lock.
 */
export async function withManifestLock<T>(
	dir: string,
	fn: () => Promise<T>,
	timing: ManifestLockTiming = {},
): Promise<T> {
	const staleMs = timing.staleMs ?? MANIFEST_LOCK_STALE_MS;
	const waitMs = timing.waitMs ?? manifestLockWaitMs(staleMs);
	const path = join(dir, MANIFEST_LOCK);
	const token = `${process.pid}-${randomUUID()}`;
	const deadline = Date.now() + waitMs;
	let delay = 2;
	for (;;) {
		const outcome = await tryCreateLock(path, token);
		// No job directory: nothing to lock — fn's own read reports not-found.
		if (outcome === 'no_dir') return fn();
		if (outcome === 'held') break;
		const holder = await readLockToken(path);
		if (holder === null) continue; // released between the link and the read
		let ageMs: number;
		try {
			ageMs = Date.now() - (await stat(path)).mtimeMs;
		} catch {
			continue;
		}
		// The age may be a NEWER instance's (the read and the stat are two steps):
		// harmless — the removal is keyed by the token read, never by the name.
		if (ageMs > staleMs) {
			await timing.beforeTakeover?.();
			if (await removeLockInstance(path, holder, staleMs)) continue;
		}
		if (Date.now() > deadline) {
			throw new DedaloError('export.store_unavailable', {
				message: `manifest lock '${path}' held for more than ${waitMs} ms`,
				coordinates: { dir },
			});
		}
		await Bun.sleep(delay);
		delay = Math.min(delay * 2, 50);
	}
	try {
		return await fn();
	} finally {
		await removeLockInstance(path, token, staleMs);
	}
}

// ---------------------------------------------------------------------------
// Buffered append file (bounded memory)
// ---------------------------------------------------------------------------

/**
 * WRITE EVERY BYTE. `FileHandle.write` does not loop: a write(2) that returns a
 * partial count (a nearly full volume) resolves normally with `bytesWritten`
 * short, and a caller that counts the whole buffer as written records offsets
 * (manifest `grid_bytes`, grid.idx) past what is on disk, or renames a short
 * built file into place. This loops until the buffer is on disk; a write that
 * makes NO progress without an error is the volume refusing — typed, never a
 * silent short file. `position` null = the handle's current position (append);
 * a number = positional writes from there. Returns the bytes written (all).
 */
export async function writeFully(
	handle: Pick<FileHandle, 'write'>,
	bytes: Uint8Array,
	position: number | null = null,
): Promise<number> {
	let offset = 0;
	while (offset < bytes.byteLength) {
		const { bytesWritten } = await handle.write(
			bytes,
			offset,
			bytes.byteLength - offset,
			position === null ? null : position + offset,
		);
		if (!(bytesWritten > 0)) {
			throw new DedaloError('export.storage_low', {
				message: `a write made no progress (${offset} of ${bytes.byteLength} bytes on disk)`,
				coordinates: { written: offset, expected: bytes.byteLength },
			});
		}
		offset += bytesWritten;
	}
	return offset;
}

/** Pending bytes after which a spool file is flushed (at a record boundary). */
const FLUSH_THRESHOLD_BYTES = 256 * 1024;

/**
 * An append-only file with an in-memory tail. `mark()` records a boundary;
 * `flush(toMark)` writes only up to it, so a reader never sees half a record.
 */
class AppendFile {
	private chunks: string[] = [];
	private chunkBytes: number[] = [];
	private boundary = 0;
	private pending = 0;
	private pendingToBoundary = 0;
	private written = 0;

	private constructor(private handle: FileHandle | null) {}

	static async create(path: string): Promise<AppendFile> {
		return new AppendFile(await open(path, 'wx'));
	}

	get pendingBytes(): number {
		return this.pending;
	}

	get flushableBytes(): number {
		return this.pendingToBoundary;
	}

	/** Bytes whose write has COMPLETED (a reader bounded by it never meets a write in flight). */
	get writtenBytes(): number {
		return this.written;
	}

	append(text: string, bytes: number): void {
		this.chunks.push(text);
		this.chunkBytes.push(bytes);
		this.pending += bytes;
	}

	/** Everything appended so far may be flushed. */
	mark(): void {
		this.boundary = this.chunks.length;
		this.pendingToBoundary = this.pending;
	}

	async flush(toBoundary: boolean): Promise<void> {
		const upto = toBoundary ? this.boundary : this.chunks.length;
		if (upto === 0 || this.handle === null) return;
		const text = this.chunks.slice(0, upto).join('');
		let flushed = 0;
		for (let i = 0; i < upto; i++) flushed += this.chunkBytes[i] as number;
		this.chunks = this.chunks.slice(upto);
		this.chunkBytes = this.chunkBytes.slice(upto);
		this.boundary -= upto;
		if (this.boundary < 0) this.boundary = 0;
		this.pending -= flushed;
		this.pendingToBoundary = toBoundary ? 0 : Math.max(0, this.pendingToBoundary - flushed);
		await writeFully(this.handle, Buffer.from(text, 'utf8'));
		this.written += flushed;
	}

	async close(): Promise<void> {
		if (this.handle === null) return;
		await this.flush(false);
		await this.handle.close();
		this.handle = null;
	}

	async discard(): Promise<void> {
		this.chunks = [];
		this.chunkBytes = [];
		this.pending = 0;
		this.pendingToBoundary = 0;
		this.boundary = 0;
		if (this.handle === null) return;
		await this.handle.close();
		this.handle = null;
	}
}

// ---------------------------------------------------------------------------
// Spool writer
// ---------------------------------------------------------------------------

export interface SpoolStats {
	/** Bytes of grid + cols + idx appended. */
	bytes: number;
	gridBytes: number;
	/**
	 * Grid bytes whose write has COMPLETED — always a whole-record boundary after
	 * flush()/close(). The job records it in the manifest (`grid_bytes`) at each
	 * checkpoint: the bound a preview reads to (spool_reader.ts readPage).
	 */
	committedGridBytes: number;
	lines: number;
	rows: number;
	records: number;
	cols: number;
	meta: Record<string, unknown> | null;
	/** end.columns once the 'end' line was written, else null. */
	columns: number[] | null;
	ended: boolean;
	/** Bytes of media.ndjson appended (the media-address sidecar; 0 = none). */
	mediaBytes: number;
	/** The distinct component tipos the sidecar names, in first-seen order. */
	mediaComponentTipos: string[];
}

export interface SpoolWriter {
	/** Append one protocol line (serialized exactly as the NDJSON stream does). */
	write(line: Record<string, unknown>): Promise<void>;
	/** Make everything up to the last COMPLETE record visible to readers. */
	flush(): Promise<void>;
	readonly stats: Readonly<SpoolStats>;
	/** Flush everything and close. Idempotent. */
	close(): Promise<SpoolStats>;
	/** Close and delete the spool files (grid, cols, idx, media). Idempotent. */
	abort(): Promise<void>;
}

export interface SpoolWriterOptions {
	/** R — records between grid.idx entries (default DEFAULT_INDEX_EVERY). */
	indexEvery?: number;
	/** The owner's shared quota (internal: the store supplies it). Absent = unbounded. */
	quota?: QuotaBudget;
}

function indexLine(offset: number): string {
	return `${String(offset).padStart(INDEX_LINE_BYTES - 1, '0')}\n`;
}

async function openSpoolWriterAt(
	job: ArtifactJobRef,
	options: SpoolWriterOptions = {},
): Promise<SpoolWriter> {
	const indexEvery =
		Number.isSafeInteger(options.indexEvery) && (options.indexEvery as number) > 0
			? (options.indexEvery as number)
			: DEFAULT_INDEX_EVERY;
	const meter = quotaMeter(options.quota ?? null);
	// All three or none: a later create that fails (EMFILE, ENOSPC, EEXIST from
	// a leftover) closes the handles already opened before it rethrows — the
	// caller's cleanup (deleteSpool) removes the files by NAME, never a handle.
	const opened: AppendFile[] = [];
	try {
		for (const name of [SPOOL_FILES.grid, SPOOL_FILES.cols, SPOOL_FILES.index]) {
			opened.push(await AppendFile.create(join(job.dir, name)));
		}
	} catch (error) {
		for (const file of opened) await file.discard().catch(() => undefined);
		throw error;
	}
	const [grid, cols, index] = opened as [AppendFile, AppendFile, AppendFile];
	/** The media-address sidecar — opened on the first record that read media. */
	let media: AppendFile | null = null;
	const mediaTipos = new Set<string>();
	const stats: SpoolStats = {
		bytes: 0,
		gridBytes: 0,
		committedGridBytes: 0,
		lines: 0,
		rows: 0,
		records: 0,
		cols: 0,
		meta: null,
		columns: null,
		ended: false,
		mediaBytes: 0,
		mediaComponentTipos: [],
	};
	let closed = false;

	const all = (): AppendFile[] =>
		media === null ? [cols, grid, index] : [cols, grid, index, media];
	/** cols first (a reader must know every column a visible row uses), then grid, then idx (an offset never leads its bytes). */
	const flushAll = async (toBoundary: boolean): Promise<void> => {
		// the sidecar is read only once the export ENDED: whole, whatever the boundary
		if (media !== null) await media.flush(false);
		await cols.flush(false);
		await grid.flush(toBoundary);
		stats.committedGridBytes = grid.writtenBytes;
		if (!toBoundary || grid.pendingBytes === 0) await index.flush(false);
		else await index.flush(true);
	};

	/** Own bytes not on disk yet after pushing whole records (the open record stays buffered). */
	const settle = async (): Promise<number> => {
		await flushAll(true);
		return cols.pendingBytes + grid.pendingBytes + index.pendingBytes + (media?.pendingBytes ?? 0);
	};

	return {
		stats,
		async write(line) {
			if (closed) {
				throw new DedaloError('internal.invariant', {
					message: 'SpoolWriter.write after close/abort',
					coordinates: { job_id: job.jobId },
				});
			}
			const text = `${JSON.stringify(line)}\n`;
			const bytes = Buffer.byteLength(text);
			const kind = line.t;
			const recordStart = kind === 'row' && Number(line.sub ?? 0) === 0;
			// A record boundary: everything before this line is whole records.
			if (recordStart || kind === 'end') {
				grid.mark();
				index.mark();
				if (grid.flushableBytes >= FLUSH_THRESHOLD_BYTES) await flushAll(true);
			}
			let extra = 0;
			let idx = '';
			if (recordStart && stats.records % indexEvery === 0) {
				idx = indexLine(stats.gridBytes);
				extra += INDEX_LINE_BYTES;
			}
			if (kind === 'col') extra += bytes;
			// the record's media addresses (a symbol key: never in `text`)
			const addresses = recordStart ? rowMediaOf(line) : [];
			let mediaText = '';
			if (addresses.length > 0) {
				mediaText = `${JSON.stringify({ rec: line.rec, a: addresses })}\n`;
				extra += Buffer.byteLength(mediaText);
			}
			await meter.admit(bytes + extra, settle);
			stats.bytes += bytes + extra;
			if (mediaText !== '') {
				if (media === null) media = await AppendFile.create(join(job.dir, SPOOL_FILES.media));
				const mediaBytes = Buffer.byteLength(mediaText);
				media.append(mediaText, mediaBytes);
				stats.mediaBytes += mediaBytes;
				for (const address of addresses) {
					if (mediaTipos.has(address[3])) continue;
					mediaTipos.add(address[3]);
					stats.mediaComponentTipos.push(address[3]);
				}
			}
			if (idx !== '') index.append(idx, INDEX_LINE_BYTES);
			grid.append(text, bytes);
			stats.gridBytes += bytes;
			stats.lines++;
			if (kind === 'col') {
				cols.append(text, bytes);
				stats.cols++;
			} else if (kind === 'row') {
				stats.rows++;
				if (recordStart) stats.records++;
			} else if (kind === 'meta') {
				stats.meta = line;
			} else if (kind === 'end') {
				stats.ended = true;
				stats.columns = Array.isArray(line.columns) ? (line.columns as number[]) : [];
				grid.mark();
				index.mark();
			}
		},
		async flush() {
			if (closed) return;
			await flushAll(true);
		},
		async close() {
			if (closed) return stats;
			closed = true;
			// flushAll's order, one after the other: cols, then grid, then idx — the
			// last record's buffered idx entry must never land before the grid bytes
			// it points at (a concurrent preview would read an offset past EOF).
			// On a failure (the final flush can hit ENOSPC) nothing further is
			// flushed and ALL three are discarded, so no handle outlives the writer.
			try {
				if (media !== null) await media.close();
				await cols.close();
				await grid.close();
				stats.committedGridBytes = grid.writtenBytes;
				await index.close();
			} catch (error) {
				for (const file of all()) await file.discard().catch(() => undefined);
				throw error;
			}
			return stats;
		},
		async abort() {
			if (!closed) {
				closed = true;
				for (const file of all()) await file.discard();
			}
			for (const name of SPOOL_DATA_FILES) {
				await rm(join(job.dir, name), { force: true });
			}
		},
	};
}

// ---------------------------------------------------------------------------
// File sink (built files) — bounded memory, temp + rename
// ---------------------------------------------------------------------------

/** A bounded-memory byte sink onto a temp file. */
export interface FileSink {
	write(chunk: string | Uint8Array): Promise<void>;
	/**
	 * Admit `bytes` of the writer's SCRATCH BEFORE writing them: a side file in
	 * the job directory that the quota's directory measure cannot see (media_zip's
	 * UNLINKED failure log). Same meter as `write` — the user's quota counts them
	 * from then on and the volume floor is re-checked — so a refusal throws the
	 * same `export.artifact_quota` / `export.storage_low` before the byte lands.
	 * Not counted in `bytes` (they are not the built file's).
	 */
	admitScratch(bytes: number): Promise<void>;
	readonly bytes: number;
}

/** An allocated final file: write to `tempPath` through a sink, then `commit`. */
export interface AllocatedArtifactFile {
	readonly format: ExportFormat;
	readonly basename: string;
	readonly finalPath: string;
	readonly tempPath: string;
}

export interface OpenedFileSink {
	readonly sink: FileSink;
	/**
	 * Close, rename temp → final (atomic) and RECORD the file in the manifest,
	 * releasing the build lease — one step under the manifest lock, so the TTL
	 * sweep never sees the file built but not yet recorded. Returns the entry.
	 */
	commit(details: { rows: number }): Promise<ExportArtifactFile>;
	/** Close and delete the temp file, releasing the build lease. Idempotent. */
	abort(): Promise<void>;
}

/** The raw sink (no manifest bookkeeping): the store wraps it in the lease. */
interface RawFileSink {
	readonly sink: FileSink;
	/** Close and rename temp → final (atomic). Returns the bytes written. */
	commit(): Promise<number>;
	/** Close and delete the temp file. Idempotent. */
	abort(): Promise<void>;
}

const SINK_BUFFER_BYTES = 256 * 1024;

async function openSinkAt(
	file: AllocatedArtifactFile,
	quota: QuotaBudget | null,
): Promise<RawFileSink> {
	const meter = quotaMeter(quota);
	let handle: FileHandle | null = await open(file.tempPath, 'wx');
	let buffered: Uint8Array[] = [];
	let bufferedBytes = 0;
	let written = 0;
	const encoder = new TextEncoder();

	const drain = async (): Promise<void> => {
		if (bufferedBytes === 0 || handle === null) return;
		const joined = Buffer.concat(buffered, bufferedBytes);
		buffered = [];
		bufferedBytes = 0;
		await writeFully(handle, joined);
	};

	const sink: FileSink = {
		async write(chunk) {
			if (handle === null) {
				throw new DedaloError('internal.invariant', {
					message: 'FileSink.write after commit/abort',
					coordinates: { file: file.basename },
				});
			}
			const bytes = typeof chunk === 'string' ? encoder.encode(chunk) : chunk;
			await meter.admit(bytes.byteLength, async () => {
				await drain();
				return 0;
			});
			written += bytes.byteLength;
			buffered.push(bytes);
			bufferedBytes += bytes.byteLength;
			if (bufferedBytes >= SINK_BUFFER_BYTES) await drain();
		},
		async admitScratch(bytes) {
			if (handle === null) {
				throw new DedaloError('internal.invariant', {
					message: 'FileSink.admitScratch after commit/abort',
					coordinates: { file: file.basename },
				});
			}
			await meter.admitHidden(bytes, async () => {
				await drain();
				return 0;
			});
		},
		get bytes() {
			return written;
		},
	};

	return {
		sink,
		async commit() {
			if (handle === null) {
				throw new DedaloError('internal.invariant', {
					message: 'FileSink.commit after commit/abort',
					coordinates: { file: file.basename },
				});
			}
			await drain();
			await handle.close();
			handle = null;
			await rename(file.tempPath, file.finalPath);
			return written;
		},
		async abort() {
			buffered = [];
			bufferedBytes = 0;
			if (handle !== null) {
				await handle.close();
				handle = null;
			}
			await rm(file.tempPath, { force: true });
		},
	};
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export interface ArtifactStoreOptions {
	/** Root override (a gate's MARKED scratch root). Default: `defaultExportArtifactsRoot()`. */
	root?: string;
	/** Default: config.ops.exportArtifactsQuotaBytes (0 = off). */
	quotaBytes?: number;
	/** Default: config.ops.exportArtifactsTtlHours. */
	ttlHours?: number;
	/** Default: config.ops.exportArtifactsMaxExports (0 = off). */
	maxExports?: number;
	/** Default: config.ops.exportArtifactsMinFreeBytes (0 = off). */
	minFreeBytes?: number;
	/** Free-space probe seam (gates only): default statfs of the root's volume. */
	freeBytes?: (root: string) => Promise<number>;
}

export interface SweepReport {
	/** Job directories deleted (expired). */
	deleted: number;
	/** Running jobs whose owning process is gone, marked interrupted. */
	interrupted: number;
	/** Stale temp files removed. */
	temps: number;
	/** Job directories left in place. */
	kept: number;
}

export interface ArtifactStore {
	readonly root: string;
	readonly quotaBytes: number;
	readonly ttlHours: number;
	/** A validated reference (no IO). Throws export.artifact_not_found on a malformed id. */
	jobRef(userId: number, jobId: string): ArtifactJobRef;
	/** Create the job directory + initial manifest (status 'running'). Quota-checked. */
	createJob(init: ExportJobInit): Promise<{ job: ArtifactJobRef; manifest: ExportManifest }>;
	/** The joined manifest (request.json + manifest.json). */
	readManifest(job: ArtifactJobRef): Promise<ExportManifest>;
	/** The MUTABLE state only (manifest.json) — what the liveness, lock and sweep decisions read. */
	readJobState(job: ArtifactJobRef): Promise<ExportJobState>;
	/**
	 * Write a WHOLE manifest (fixtures, repair): the request half AND the state
	 * half. Every production writer patches the state only (updateManifest).
	 */
	writeManifest(job: ArtifactJobRef, manifest: ExportManifest): Promise<void>;
	/** Read-modify-write (atomic write); refreshes updated_at. */
	updateManifest(
		job: ArtifactJobRef,
		patch: Partial<ExportManifest> | ((current: ExportManifest) => ExportManifest),
	): Promise<ExportManifest>;
	/**
	 * The user's exports, newest first (unreadable manifests skipped). `where`
	 * is asked on each job's small STATE first: a job it refuses never has its
	 * request (the caller-sized options) read or parsed.
	 */
	listJobs(userId: number, where?: (state: ExportJobState) => boolean): Promise<ExportManifest[]>;
	/** Every job's STATE only, newest first — no request is read. */
	listJobStates(userId: number): Promise<ExportJobState[]>;
	/** Remove the whole job directory. False when it did not exist. Unconditional (tests, cleanup). */
	deleteJob(job: ArtifactJobRef): Promise<boolean>;
	/**
	 * THE OWNER'S DELETE: remove a job directory that nothing is writing, decided
	 * and done under the manifest lock (the lock every build takes). Refuses with
	 * `export.artifact_busy` while the export runs (runningJobLive) or a file
	 * build holds a live lease on it; a dead foreign 'running' job (interrupted)
	 * is deletable. Answers the bytes the directory held (freed from the quota).
	 * `export.artifact_not_found` when the job is not there.
	 */
	deleteIdleJob(job: ArtifactJobRef, options?: { now?: number }): Promise<{ freedBytes: number }>;
	/** Remove the spool files (grid, cols, idx) and stray temps; the manifest stays. */
	deleteSpool(job: ArtifactJobRef): Promise<void>;
	/** Bytes the user holds. */
	usedBytes(userId: number): Promise<number>;
	/** Throw export.artifact_quota unless `incoming` more bytes fit. Returns the remaining budget (Infinity when off). */
	assertQuota(userId: number, incoming?: number): Promise<number>;
	openSpoolWriter(
		job: ArtifactJobRef,
		options?: Omit<SpoolWriterOptions, 'maxBytes' | 'quotaBytes'>,
	): Promise<SpoolWriter>;
	/** Allocate the final path (+ a sibling temp) for a format. */
	allocateFile(job: ArtifactJobRef, format: ExportFormat, variant?: string): AllocatedArtifactFile;
	/** Open a quota-bounded sink onto an allocated file's temp path. */
	openFileSink(job: ArtifactJobRef, file: AllocatedArtifactFile): Promise<OpenedFileSink>;
	/**
	 * Commit an allocated file as a HARD LINK to one of the job's own spool
	 * files (the NDJSON download IS the ended grid, byte for byte): link to a
	 * temp, rename into place and record it — one step under the manifest
	 * lock, like a sink's commit. No bytes are written and none are counted
	 * twice (directoryBytes counts an inode once). Answers null when the
	 * filesystem cannot hard-link (the caller then copies through a sink).
	 */
	linkSpoolAsFile(
		job: ArtifactJobRef,
		file: AllocatedArtifactFile,
		details: { source: (typeof SPOOL_FILES)['grid']; rows: number },
	): Promise<ExportArtifactFile | null>;
	/**
	 * For the download route: the absolute path of a DOWNLOADABLE built file, or
	 * null for everything else (malformed ids, disallowed name, escape attempt,
	 * symlink, missing). Never throws — every refusal is the same null.
	 */
	resolveArtifactFile(userId: number, jobId: string, basename: string): Promise<string | null>;
	sweep(options?: { now?: number }): Promise<SweepReport>;
}

/**
 * The temp basenames of the LIVE file builds recorded on a manifest (see
 * FileBuildLease for the liveness rule). A lease whose temp no longer exists
 * is not live — its build committed or aborted without releasing it.
 */
async function liveBuildTemps(
	dir: string,
	manifest: ExportJobState,
	now: number,
	tempMaxAgeMs: number,
): Promise<Set<string>> {
	const live = new Set<string>();
	for (const [tempName, lease] of Object.entries(manifest.builds ?? {})) {
		if (!isTempSibling(tempName)) continue;
		const path = confinedPath(dir, tempName);
		if (path === null) continue;
		let mtimeMs: number;
		try {
			mtimeMs = (await stat(path)).mtimeMs;
		} catch {
			continue;
		}
		if (lease.owner_boot === STORE_BOOT_ID) {
			live.add(tempName);
			continue;
		}
		const ownerGone = lease.owner_pid === process.pid || !processAlive(lease.owner_pid);
		if (!ownerGone && now - mtimeMs <= tempMaxAgeMs) live.add(tempName);
	}
	return live;
}

/** Open the store (the root is created and — under the seam — verified). */
export function openArtifactStore(options: ArtifactStoreOptions = {}): ArtifactStore {
	const root = resolve(options.root ?? defaultExportArtifactsRoot());
	const quotaBytes = Math.max(0, options.quotaBytes ?? config.ops.exportArtifactsQuotaBytes);
	const ttlHours = Math.max(0, options.ttlHours ?? config.ops.exportArtifactsTtlHours);
	const maxExports = Math.max(0, options.maxExports ?? config.ops.exportArtifactsMaxExports);
	const minFreeBytes = Math.max(0, options.minFreeBytes ?? config.ops.exportArtifactsMinFreeBytes);
	const probeFree = options.freeBytes ?? volumeFreeBytes;
	const floorFor = (coordinates: Record<string, string | number>): VolumeFloor => ({
		minFreeBytes,
		freeBytes: () => probeFree(root),
		low: () =>
			new DedaloError('export.storage_low', {
				coordinates: { ...coordinates, root, min_free_bytes: minFreeBytes },
			}),
	});
	/** Refuse a write door when the volume is already at (or under) the floor. */
	const assertFloor = async (coordinates: Record<string, string | number>): Promise<void> => {
		if (minFreeBytes <= 0) return;
		const floor = floorFor(coordinates);
		if ((await floor.freeBytes()) <= minFreeBytes) throw floor.low();
	};
	/** Refuse a new export when the user already keeps `maxExports`. */
	const assertCount = async (userId: number): Promise<void> => {
		if (maxExports <= 0) return;
		let kept = 0;
		try {
			for (const entry of await readdir(userDir(userId), { withFileTypes: true })) {
				if (entry.isDirectory() && JOB_ID_PATTERN.test(entry.name)) kept++;
			}
		} catch {
			return; // no directory yet: nothing kept
		}
		if (kept >= maxExports) {
			throw new DedaloError('export.artifact_count', {
				details: { max_exports: maxExports },
				coordinates: { user_id: userId, kept },
			});
		}
	};

	/** Every door that writes calls this first. */
	const writableRoot = async (door: string): Promise<string> => {
		await assertExportArtifactsPlacement(root, door);
		const checked = await assertExportArtifactsRoot(root, door);
		try {
			await mkdir(checked, { recursive: true, mode: EXPORT_ARTIFACTS_DIR_MODE });
		} catch (error) {
			throw new DedaloError('export.store_unavailable', {
				message: `${door}: cannot create the export artifacts root '${checked}'`,
				coordinates: { root: checked },
				cause: error,
			});
		}
		await claimExportArtifactsRoot(checked, door);
		return checked;
	};

	const userDir = (userId: number): string => {
		if (!Number.isSafeInteger(userId)) throw notFound({ user_id: String(userId) });
		const dir = confinedPath(root, String(userId));
		if (dir === null) throw notFound({ user_id: userId });
		return dir;
	};

	const jobRef = (userId: number, jobId: string): ArtifactJobRef => {
		if (typeof jobId !== 'string' || !isValidArtifactJobId(jobId)) {
			throw notFound({ user_id: String(userId), job_id: String(jobId).slice(0, 64) });
		}
		const owner = userDir(userId);
		const dir = confinedPath(owner, jobId);
		if (dir === null) throw notFound({ user_id: userId, job_id: jobId });
		return { root, userId, jobId, dir };
	};

	const manifestPath = (job: ArtifactJobRef): string => join(job.dir, SPOOL_FILES.manifest);
	const requestPath = (job: ArtifactJobRef): string => join(job.dir, SPOOL_FILES.request);

	/** Read + parse one of the job's JSON files; its recorded owner must be the directory's. */
	const readOwnedJson = async <T extends { user_id?: unknown; job_id?: unknown }>(
		job: ArtifactJobRef,
		path: string,
	): Promise<T> => {
		let text: string;
		try {
			text = await readFile(path, 'utf8');
		} catch {
			throw notFound({ user_id: job.userId, job_id: job.jobId });
		}
		let parsed: T;
		try {
			parsed = JSON.parse(text) as T;
		} catch {
			throw notFound({ user_id: job.userId, job_id: job.jobId });
		}
		// The owner recorded inside must agree with the directory it sits in.
		if (parsed?.user_id !== job.userId || parsed?.job_id !== job.jobId) {
			throw notFound({ user_id: job.userId, job_id: job.jobId });
		}
		return parsed;
	};

	/** The root's install, checked ONCE per store instance before any read (see exportStoreInstallFingerprint). */
	let rootInstallChecked: Promise<void> | null = null;
	const assertReadableRoot = (): Promise<void> => {
		rootInstallChecked ??= assertExportArtifactsRootInstall(root, 'ArtifactStore.read');
		return rootInstallChecked;
	};

	const readJobState = async (job: ArtifactJobRef): Promise<ExportJobState> => {
		await assertReadableRoot();
		return manifestState(await readOwnedJson<ExportJobState>(job, manifestPath(job)));
	};

	/**
	 * The request, parsed ONCE per file version for this store instance: keyed
	 * by the file's identity (inode + mtime + size), so a request replaced by a
	 * fixture write — or a job deleted and re-created under the same id by
	 * another process — is re-read, never served stale. One stat per read
	 * instead of one parse of up to MANIFEST_OPTIONS_MAX_BYTES.
	 */
	const requestMemo = new Map<string, { identity: string; request: ExportJobRequest }>();
	const readJobRequest = async (job: ArtifactJobRef): Promise<ExportJobRequest> => {
		const path = requestPath(job);
		let identity: string;
		try {
			const info = await stat(path);
			identity = `${info.ino}:${info.mtimeMs}:${info.size}`;
		} catch {
			requestMemo.delete(job.dir);
			throw notFound({ user_id: job.userId, job_id: job.jobId });
		}
		const memo = requestMemo.get(job.dir);
		if (memo !== undefined && memo.identity === identity) return memo.request;
		const request = await readOwnedJson<ExportJobRequest>(job, path);
		requestMemo.set(job.dir, { identity, request });
		return request;
	};

	const joinManifest = (state: ExportJobState, request: ExportJobRequest): ExportManifest =>
		({
			...state,
			options:
				request.options !== null && typeof request.options === 'object' ? request.options : {},
			sections: Array.isArray(request.sections) ? request.sections : [],
		}) as ExportManifest;

	const readManifest = async (job: ArtifactJobRef): Promise<ExportManifest> =>
		joinManifest(await readJobState(job), await readJobRequest(job));

	/** Write the STATE half only (the request keys are dropped, never persisted here). */
	const writeJobState = async (
		job: ArtifactJobRef,
		state: ExportJobState | ExportManifest,
	): Promise<void> => {
		await writableRoot('ArtifactStore.writeJobState');
		await atomicWriteJson(manifestPath(job), manifestState(state));
	};

	const requestOf = (manifest: ExportManifest): ExportJobRequest => ({
		v: 1,
		job_id: manifest.job_id,
		user_id: manifest.user_id,
		options: manifest.options,
		sections: [...(manifest.sections ?? [])],
	});

	const writeManifest = async (job: ArtifactJobRef, manifest: ExportManifest): Promise<void> => {
		await writableRoot('ArtifactStore.writeManifest');
		await atomicWriteJson(requestPath(job), requestOf(manifest));
		await atomicWriteJson(manifestPath(job), manifestState(manifest));
	};

	const listJobStates = async (userId: number): Promise<ExportJobState[]> => {
		await assertReadableRoot();
		const dir = userDir(userId);
		let names: string[] = [];
		try {
			names = await readdir(dir);
		} catch {
			return [];
		}
		const out: ExportJobState[] = [];
		for (const name of names) {
			if (!isValidArtifactJobId(name)) continue;
			try {
				out.push(await readJobState(jobRef(userId, name)));
			} catch {
				// half-created or foreign — not listed
			}
		}
		return out.sort((a, b) =>
			a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0,
		);
	};

	const usedBytes = (userId: number): Promise<number> => directoryBytes(userDir(userId));

	const assertQuota = async (userId: number, incoming = 0): Promise<number> => {
		if (quotaBytes <= 0) return Number.POSITIVE_INFINITY;
		const used = await usedBytes(userId);
		if (used + incoming > quotaBytes) throw quotaError(quotaBytes, { user_id: userId, used });
		return quotaBytes - used;
	};

	/**
	 * Remove the built files the format bound evicted (already dropped from the
	 * manifest, so never served again). Best effort: a leftover is unlisted and
	 * leaves with the job directory.
	 */
	const removeEvicted = async (job: ArtifactJobRef, evicted: readonly string[]): Promise<void> => {
		for (const name of evicted) {
			if (!isDownloadableArtifactName(name)) continue;
			const path = confinedPath(job.dir, name);
			if (path !== null) await rm(path, { force: true }).catch(() => undefined);
		}
	};

	const deleteSpool = async (job: ArtifactJobRef): Promise<void> => {
		await writableRoot('ArtifactStore.deleteSpool');
		for (const name of SPOOL_DATA_FILES) {
			await rm(join(job.dir, name), { force: true });
		}
		let entries: string[] = [];
		try {
			entries = await readdir(job.dir);
		} catch {
			return;
		}
		for (const name of entries) {
			if (isTempSibling(name)) await rm(join(job.dir, name), { force: true });
		}
	};

	const store: ArtifactStore = {
		root,
		quotaBytes,
		ttlHours,
		jobRef,

		async createJob(init) {
			const jobId = init.jobId ?? newArtifactJobId();
			if (!isValidArtifactJobId(jobId)) {
				throw new DedaloError('request.invalid_options', {
					message: `ArtifactStore.createJob: job id '${jobId.slice(0, 64)}' is not /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/`,
				});
			}
			await writableRoot('ArtifactStore.createJob');
			assertManifestOptionsSize(init.options);
			const job = jobRef(init.userId, jobId);
			const now = nowIso();
			const manifest: ExportManifest = {
				v: 1,
				job_id: jobId,
				user_id: init.userId,
				status: 'running',
				background_job_id: init.backgroundJobId ?? null,
				owner_pid: process.pid,
				owner_boot: STORE_BOOT_ID,
				section_tipo: init.sectionTipo,
				sections: [...init.sections],
				options: init.options,
				record_scope: init.recordScope,
				application_lang: init.applicationLang,
				created_at: now,
				updated_at: now,
				ended_at: null,
				meta: null,
				total: null,
				records: 0,
				rows: 0,
				spool_bytes: 0,
				grid_bytes: 0,
				columns: null,
				index_every:
					Number.isSafeInteger(init.indexEvery) && (init.indexEvery as number) > 0
						? (init.indexEvery as number)
						: DEFAULT_INDEX_EVERY,
				unresolved: [],
				external_degraded: null,
				frontier_refusals: [],
				frontier_grants: [],
				files: {},
				error: null,
			};
			// The manifest is charged to the quota BEFORE it is written: its bytes
			// (above all the recorded options) are the owner's disk like the spool.
			await assertQuota(
				init.userId,
				Buffer.byteLength(`${JSON.stringify(requestOf(manifest))}\n`) +
					Buffer.byteLength(`${JSON.stringify(manifestState(manifest))}\n`),
			);
			await assertCount(init.userId);
			await assertFloor({ user_id: init.userId });
			await mkdir(userDir(init.userId), { recursive: true, mode: EXPORT_ARTIFACTS_DIR_MODE });
			try {
				await mkdir(job.dir, { mode: EXPORT_ARTIFACTS_DIR_MODE });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
					throw new DedaloError('resource.conflict', {
						message: `ArtifactStore.createJob: job directory already exists (${jobId})`,
						coordinates: { user_id: init.userId, job_id: jobId },
					});
				}
				throw error;
			}
			// The request FIRST, written once and never again; the state last — a
			// job is readable only once both exist (readManifest needs both).
			await atomicWriteJson(requestPath(job), requestOf(manifest));
			await atomicWriteJson(manifestPath(job), manifestState(manifest));
			return { job, manifest };
		},

		readManifest,
		readJobState,
		writeManifest,

		async updateManifest(job, patch) {
			await writableRoot('ArtifactStore.updateManifest');
			return withManifestLock(job.dir, async () => {
				// The request is IMMUTABLE: a patch never touches request.json, and its
				// request keys (if any) are ignored like the identity. An object patch —
				// every checkpoint — reads and rewrites the small state only.
				if (typeof patch === 'function') {
					const current = await readManifest(job);
					const next = patch(current);
					const state = manifestState(next);
					state.v = 1;
					state.job_id = current.job_id;
					state.user_id = current.user_id;
					state.updated_at = nowIso();
					await writeJobState(job, state);
					return joinManifest(state, requestOf(current));
				}
				const current = await readJobState(job);
				const state = manifestState({ ...current, ...patch } as ExportJobState);
				state.v = 1;
				state.job_id = current.job_id;
				state.user_id = current.user_id;
				state.updated_at = nowIso();
				await writeJobState(job, state);
				return joinManifest(state, await readJobRequest(job));
			});
		},

		listJobStates,

		async listJobs(userId, where) {
			const out: ExportManifest[] = [];
			for (const state of await listJobStates(userId)) {
				if (where !== undefined && !where(state)) continue;
				try {
					out.push(joinManifest(state, await readJobRequest(jobRef(userId, state.job_id))));
				} catch {
					// half-created or foreign — not listed
				}
			}
			return out;
		},

		async deleteJob(job) {
			await writableRoot('ArtifactStore.deleteJob');
			if (!(await pathExists(job.dir))) return false;
			await rm(job.dir, { recursive: true, force: true });
			return true;
		},

		async deleteIdleJob(job, options = {}) {
			await writableRoot('ArtifactStore.deleteIdleJob');
			const now = options.now ?? Date.now();
			if (!(await pathExists(job.dir))) throw notFound({ user_id: job.userId, job_id: job.jobId });
			return withManifestLock(job.dir, async () => {
				// Throws export.artifact_not_found when it vanished meanwhile (a sweep).
				const current = await readJobState(job);
				const busy = (reason: string) =>
					new DedaloError('export.artifact_busy', {
						coordinates: { user_id: job.userId, job_id: job.jobId, reason },
					});
				if (current.status === 'running' && runningJobLive(current, now)) {
					throw busy('running');
				}
				if ((await liveBuildTemps(job.dir, current, now, STALE_TEMP_MS)).size > 0) {
					throw busy('file_build');
				}
				// The lock this step holds (its token) is not the export's bytes.
				let lockBytes = 0;
				try {
					lockBytes = (await stat(join(job.dir, MANIFEST_LOCK))).size;
				} catch {
					lockBytes = 0;
				}
				const freedBytes = Math.max(0, (await directoryBytes(job.dir)) - lockBytes);
				await rm(job.dir, { recursive: true, force: true });
				return { freedBytes };
			});
		},

		deleteSpool,
		usedBytes,
		assertQuota,

		async openSpoolWriter(job, options = {}) {
			await writableRoot('ArtifactStore.openSpoolWriter');
			await assertQuota(job.userId, 0);
			await assertFloor({ user_id: job.userId, job_id: job.jobId });
			return openSpoolWriterAt(job, {
				...options,
				quota: {
					quotaBytes,
					measure: () => usedBytes(job.userId),
					overflow: () => quotaError(quotaBytes, { user_id: job.userId, job_id: job.jobId }),
					floor: floorFor({ user_id: job.userId, job_id: job.jobId }),
				},
			});
		},

		allocateFile(job, format, variant) {
			if (!(EXPORT_FORMATS as readonly string[]).includes(format)) {
				throw new DedaloError('request.invalid_options', {
					message: `ArtifactStore.allocateFile: unknown format '${String(format)}'`,
				});
			}
			const basename = artifactFileName(format, variant);
			const finalPath = confinedPath(job.dir, basename);
			if (finalPath === null) throw notFound({ job_id: job.jobId, file: basename });
			return { format, basename, finalPath, tempPath: tempPathFor(finalPath) };
		},

		async openFileSink(job, file) {
			await writableRoot('ArtifactStore.openFileSink');
			// A rebuilt file replaces the old one: its bytes are not "held" twice.
			let previous = 0;
			try {
				previous = (await stat(file.finalPath)).size;
			} catch {
				previous = 0;
			}
			const quota: QuotaBudget = {
				quotaBytes,
				measure: async () => Math.max(0, (await usedBytes(job.userId)) - previous),
				overflow: () =>
					quotaError(quotaBytes, { user_id: job.userId, job_id: job.jobId, file: file.basename }),
				floor: floorFor({ user_id: job.userId, job_id: job.jobId, file: file.basename }),
			};
			if (quotaBytes > 0 && quotaBytes - (await quota.measure()) <= 0) {
				throw quotaError(quotaBytes, { user_id: job.userId, job_id: job.jobId });
			}
			await assertFloor({ user_id: job.userId, job_id: job.jobId, file: file.basename });
			const leaseKey = pathBasename(file.tempPath);
			// THE LEASE, taken in the same locked step that creates the temp: the
			// sweep decides under this lock, so it either removed the directory
			// first (the read below answers export.artifact_not_found — typed) or
			// it will see this build and keep the export.
			const raw = await withManifestLock(job.dir, async () => {
				const current = await readJobState(job);
				const opened = await openSinkAt(file, quota);
				try {
					await writeJobState(job, {
						...current,
						builds: {
							...(current.builds ?? {}),
							[leaseKey]: {
								basename: file.basename,
								owner_pid: process.pid,
								owner_boot: STORE_BOOT_ID,
								started_at: nowIso(),
							},
						},
						updated_at: nowIso(),
					});
				} catch (error) {
					await opened.abort();
					throw error;
				}
				return opened;
			});
			const withoutLease = (current: ExportJobState): ExportJobState => {
				const builds = { ...(current.builds ?? {}) };
				delete builds[leaseKey];
				return { ...current, builds, updated_at: nowIso() };
			};
			// Settled once a commit SUCCEEDED or an abort ran; a commit that failed
			// half-way leaves the abort to delete the temp and release the lease.
			let settled = false;
			return {
				sink: raw.sink,
				async commit(details) {
					if (settled) {
						throw new DedaloError('internal.invariant', {
							message: 'OpenedFileSink.commit after commit/abort',
							coordinates: { file: file.basename },
						});
					}
					const entry = await withManifestLock(job.dir, async () => {
						const current = await readJobState(job);
						const bytes = await raw.commit();
						const entry: ExportArtifactFile = {
							format: file.format,
							basename: file.basename,
							bytes,
							rows: details.rows,
							created_at: nowIso(),
						};
						const evicted = filesPastFormatBound(current.files, entry);
						const files = { ...current.files, [file.basename]: entry };
						for (const name of evicted) delete files[name];
						try {
							await writeJobState(job, { ...withoutLease(current), files });
						} catch (error) {
							// The rename already landed: a final file the manifest does not
							// record would never be served yet still count against the quota.
							// Undo it (rename + record are ONE step, or neither), then fail.
							await rm(file.finalPath, { force: true });
							throw error;
						}
						await removeEvicted(job, evicted);
						return entry;
					});
					settled = true;
					return entry;
				},
				async abort() {
					if (settled) return;
					settled = true;
					await raw.abort();
					await withManifestLock(job.dir, async () => {
						let current: ExportJobState;
						try {
							current = await readJobState(job);
						} catch {
							return; // the export is gone — nothing to release
						}
						await writeJobState(job, withoutLease(current));
					});
				},
			};
		},

		async linkSpoolAsFile(job, file, details) {
			await writableRoot('ArtifactStore.linkSpoolAsFile');
			const source = join(job.dir, details.source);
			return withManifestLock(job.dir, async () => {
				const current = await readJobState(job);
				try {
					await rm(file.tempPath, { force: true });
					await link(source, file.tempPath);
				} catch (error) {
					await rm(file.tempPath, { force: true });
					// no hard links here (EPERM on some mounts, EXDEV, EMLINK, ENOTSUP):
					// the caller copies instead. A vanished spool is not-found, typed.
					if (errnoCode(error) === 'ENOENT') throw notFound({ job_id: job.jobId });
					return null;
				}
				let entry: ExportArtifactFile;
				try {
					await rename(file.tempPath, file.finalPath);
					entry = {
						format: file.format,
						basename: file.basename,
						bytes: (await stat(file.finalPath)).size,
						rows: details.rows,
						created_at: nowIso(),
					};
				} catch (error) {
					await rm(file.tempPath, { force: true });
					throw error;
				}
				const evicted = filesPastFormatBound(current.files, entry);
				const files = { ...current.files, [file.basename]: entry };
				for (const name of evicted) delete files[name];
				try {
					await writeJobState(job, { ...current, files, updated_at: nowIso() });
				} catch (error) {
					await rm(file.finalPath, { force: true });
					throw error;
				}
				await removeEvicted(job, evicted);
				return entry;
			});
		},

		async resolveArtifactFile(userId, jobId, basename) {
			if (!isDownloadableArtifactName(basename)) return null;
			try {
				await assertReadableRoot();
			} catch {
				return null;
			}
			let job: ArtifactJobRef;
			try {
				job = jobRef(userId, jobId);
			} catch {
				return null;
			}
			const path = confinedPath(job.dir, basename);
			if (path === null) return null;
			try {
				const info = await lstat(path);
				return info.isFile() ? path : null;
			} catch {
				return null;
			}
		},

		async sweep(options = {}) {
			const now = options.now ?? Date.now();
			const ttlMs = ttlHours * 60 * 60 * 1000;
			const tempMaxAgeMs = STALE_TEMP_MS;
			const report: SweepReport = { deleted: 0, interrupted: 0, temps: 0, kept: 0 };
			// A misplaced root is reported at the boot sweep (and every hour), not
			// first at a user's export.
			await assertExportArtifactsPlacement(root, 'ArtifactStore.sweep');
			if (!(await pathExists(root))) return report;
			await writableRoot('ArtifactStore.sweep');
			let users: string[] = [];
			try {
				users = await readdir(root);
			} catch {
				return report;
			}
			for (const userName of users) {
				if (!USER_DIR_PATTERN.test(userName)) continue;
				const userId = Number(userName);
				let jobs: string[] = [];
				try {
					jobs = await readdir(join(root, userName));
				} catch {
					continue;
				}
				for (const jobName of jobs) {
					if (!isValidArtifactJobId(jobName)) continue;
					const job = jobRef(userId, jobName);
					try {
						let manifest: ExportJobState | null = null;
						try {
							manifest = await readJobState(job);
						} catch {
							manifest = null;
						}
						if (manifest === null) {
							// No readable manifest: age by the directory itself — and remove it
							// only when everything in it is a name the store creates (a crash
							// between mkdir and the first manifest write, a torn manifest).
							const info = await stat(job.dir);
							const entries = await readdir(job.dir);
							if (!entries.every(isStoreOwnedJobEntry)) {
								report.kept++;
								continue;
							}
							if (now - info.mtimeMs > ttlMs) {
								await rm(job.dir, { recursive: true, force: true });
								report.deleted++;
							} else report.kept++;
							continue;
						}
						if (manifest.status === 'running') {
							// Decided AND acted on under the manifest lock (the lock finishJob's
							// terminal write takes): the unlocked read above only picks the
							// branch. A job that ended between that read and this lock is
							// re-read here as 'ended' and left alone — its manifest is never
							// overwritten 'interrupted', its spool never deleted.
							const verdict = await withManifestLock(job.dir, async () => {
								let current: ExportJobState;
								try {
									current = await readJobState(job);
								} catch {
									return 'gone' as const;
								}
								if (current.status !== 'running') return 'settled' as const;
								if (runningJobLive(current, now)) return 'live' as const;
								await deleteSpool(job);
								await atomicWriteJson(manifestPath(job), {
									...current,
									status: 'interrupted',
									ended_at: nowIso(now),
									updated_at: nowIso(now),
								} satisfies ExportJobState);
								return 'interrupted' as const;
							});
							if (verdict === 'interrupted') report.interrupted++;
							else if (verdict !== 'gone') report.kept++;
							continue;
						}
						// ENDED. Decided and acted on under the manifest lock — the lock a
						// file build takes to create its temp + lease and to record its file.
						const outcome = await withManifestLock(job.dir, async () => {
							let current: ExportJobState;
							try {
								current = await readJobState(job);
							} catch {
								return 'gone' as const;
							}
							const liveTemps = await liveBuildTemps(job.dir, current, now, tempMaxAgeMs);
							if (liveTemps.size > 0) return { keep: liveTemps };
							// Expiry runs from the export's END — a hard ceiling no file build
							// extends (exportExpired, the verdict every read door shares).
							if (exportExpired(current, { ttlHours, now })) {
								await rm(job.dir, { recursive: true, force: true });
								return 'deleted' as const;
							}
							return { keep: liveTemps };
						});
						if (outcome === 'deleted') {
							report.deleted++;
							continue;
						}
						if (outcome === 'gone') continue;
						// Finished, not expired: temps older than an hour are crash leftovers
						// (a live build's temp is never one, however long it has stalled).
						for (const name of await readdir(job.dir)) {
							if (!isTempSibling(name)) continue;
							if (outcome.keep.has(name)) continue;
							const path = join(job.dir, name);
							const info = await stat(path);
							if (now - info.mtimeMs > tempMaxAgeMs) {
								await unlink(path);
								report.temps++;
							}
						}
						report.kept++;
					} catch (error) {
						console.warn(`[export_artifacts] sweep of ${job.dir} failed`, error);
					}
				}
			}
			return report;
		},
	};
	return store;
}

// ---------------------------------------------------------------------------
// Sweeper (boot + hourly)
// ---------------------------------------------------------------------------

export const EXPORT_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/** One sweep pass, logged when it removed anything; never throws. */
async function runPass(given: ArtifactStore | undefined): Promise<SweepReport | null> {
	try {
		const store = given ?? openArtifactStore();
		const report = await store.sweep();
		if (report.deleted > 0 || report.interrupted > 0 || report.temps > 0) {
			console.log(
				`[export_artifacts] sweep: ${report.deleted} expired, ${report.interrupted} interrupted, ${report.temps} temp file(s) removed`,
			);
		}
		return report;
	} catch (error) {
		console.warn('[export_artifacts] sweep failed', error);
		return null;
	}
}

/**
 * Start the TTL sweep: one pass right away (boot), then every hour. The handle
 * is the caller's — no module state here; timers are unref'd so they never
 * hold the process, and `stop()` is for SIGTERM. Never throws, never fatal.
 * ONE pass at a time: a call while a pass runs (the boot timer and an explicit
 * `runOnce`, or an hour tick over a slow pass) joins that pass and gets ITS
 * report — two overlapping passes would split one job's verdict between them.
 */
export function startExportArtifactSweeper(
	options: { store?: ArtifactStore; intervalMs?: number } = {},
): { stop(): void; runOnce(): Promise<SweepReport | null> } {
	let inFlight: Promise<SweepReport | null> | null = null;
	const runOnce = (): Promise<SweepReport | null> => {
		inFlight ??= runPass(options.store).finally(() => {
			inFlight = null;
		});
		return inFlight;
	};
	const first = setTimeout(() => void runOnce(), 0);
	first.unref?.();
	const timer = setInterval(() => void runOnce(), options.intervalMs ?? EXPORT_SWEEP_INTERVAL_MS);
	timer.unref?.();
	return {
		stop() {
			clearTimeout(first);
			clearInterval(timer);
		},
		runOnce,
	};
}
