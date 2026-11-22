/**
 * MEDIA FILE OPS — the No-hard-delete law + duplication + the deleted/ scan, and
 * the RECORD-level pair that law exists for: delete a record's media and put it
 * back (PHP section_record::remove_section_media_files /
 * restore_deleted_section_media_files, engineering/MEDIA_SPEC.md §5.6 + §8).
 *
 * Ports PHP move_deleted_file (:1929) / rename_old_files (:1193) /
 * duplicate_component_media_files (:1999) / the get_deleted_image natsort scan.
 * Every filesystem touch is confined via assertInsideMediaRoot (the path
 * chokepoint). Files are never hard-deleted — they move to '<dir>/deleted/'.
 *
 * DELETE AND RESTORE ARE ONE PAIR AND LIVE IN ONE FILE. They were not: the
 * remove half sat in `section/record/delete_record.ts` resolving the media root
 * from a bare env key that is normally UNSET (the root is a DERIVED default), so
 * on an ordinary install it moved nothing at all; the restore half — which
 * `MEDIA_SPEC.md` §8 names as the tool_time_machine section-restore touchpoint —
 * did not exist, so an undeleted record reported success with its audio, image or
 * scanned consent form still in `deleted/` and a files_info claiming
 * `file_exist:true`. A half-pair is how that happens; the halves are written
 * against each other here, and the round trip is gated as a round trip
 * (test/unit/media_lifecycle_native.test.ts).
 *
 * NEITHER HALF READS files_info. It is a filesystem-derived CACHE, and a delete
 * is precisely the moment it may be stale (a file added since the last scan would
 * be left behind, live, under a deleted record's name). Both halves enumerate the
 * type's own census — every quality × managed extension, plus the AV POSTERFRAME,
 * which is not a quality and which neither PHP-side caller could reach through
 * files_info either.
 *
 * Datestamp note: PHP has TWO formats, per call-site.
 * `move_deleted_file` (:1929 — the soft-delete every record-level and tier-level
 * delete goes through, INCLUDING the section delete) uses `Y-m-d_Hi`;
 * `rename_old_files` (:1226 — the pre-overwrite backup on upload) uses
 * `Y-m-d_Gis`. Do NOT unify: time-machine scanners and humans read both.
 */

import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { config } from '../../config/config.ts';
import { isMediaModel, type MediaTypeSpec, mediaTypeOf } from '../concepts/media.ts';
import { DedaloError } from '../errors/dedalo_error.ts';
import { getModelByTipo } from '../ontology/resolver.ts';
import { AvRecordHold } from './av_component_claim.ts';
import { recordFromColumns, resolveMediaPathOptions } from './ontology_path.ts';
import {
	assertInsideMediaRoot,
	buildMediaLocation,
	type MediaIdentity,
	type MediaPathOptions,
	posterframeLocation,
} from './path.ts';
import { escapeRegexLiteral } from './protection.ts';

/**
 * PHP `date('Y-m-d_Hi')` — the `move_deleted_file` stamp, i.e. every soft-delete:
 * a tier, a twin, a whole record.
 *
 * It is NOT PHP's `rename_old_files` stamp, which is `Y-m-d_Gis`
 * (class.component_media_common.php:1226). `renameOldFiles` below stamps `Hi`
 * for both of its callers; on `processing.ts` (the derivative-replacement pass,
 * which has no PHP counterpart at all) that is simply this engine's own choice,
 * but on `ingest/add_file.ts` — the pre-overwrite upload backup, which IS
 * PHP's rename_old_files — it is a KNOWN, ledgered divergence in the on-disk
 * name. Nothing reads the stamp to make a decision (the deleted/ scan matches
 * `<stem>_deleted_<stamp>.<ext>` and orders by name), so it costs recognisability, not
 * recoverability. Handed off rather than changed here: the two callers would
 * have to be told apart first, and that is not this workstream's file.
 */
export function deletedStampHi(now: Date): string {
	const pad = (v: number): string => String(v).padStart(2, '0');
	return (
		`${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
		`_${pad(now.getHours())}${pad(now.getMinutes())}`
	);
}

/** Split an absolute file path into { dir, stem, extension }. */
function splitPath(absolutePath: string): { dir: string; stem: string; extension: string } {
	const slash = absolutePath.lastIndexOf('/');
	const dir = absolutePath.slice(0, slash);
	const fileName = absolutePath.slice(slash + 1);
	const dot = fileName.lastIndexOf('.');
	return {
		dir,
		stem: dot > 0 ? fileName.slice(0, dot) : fileName,
		extension: dot > 0 ? fileName.slice(dot + 1) : '',
	};
}

/**
 * Move a file into '<dir>/deleted[/<bulkProcessId>]/<stem>_deleted_<stamp>.<ext>'
 * (PHP move_deleted_file :1929). Bulk mode drops the stamp (plain '<stem>.<ext>').
 * Returns the target path, or null when the source is absent (idempotent).
 */
export function moveToDeleted(
	absolutePath: string,
	opts: { bulkProcessId?: string; now?: Date; mediaRoot?: string } = {},
): string | null {
	const source = assertInsideMediaRoot(absolutePath, opts.mediaRoot);
	if (!existsSync(source)) return null;
	const { dir, stem, extension } = splitPath(source);
	const deletedDir = assertInsideMediaRoot(
		opts.bulkProcessId ? `${dir}/deleted/${opts.bulkProcessId}` : `${dir}/deleted`,
		opts.mediaRoot,
	);
	if (!existsSync(deletedDir)) mkdirSync(deletedDir, { recursive: true, mode: 0o775 });
	const extSuffix = extension !== '' ? `.${extension}` : '';
	const target = opts.bulkProcessId
		? `${deletedDir}/${stem}${extSuffix}`
		: `${deletedDir}/${stem}_deleted_${deletedStampHi(opts.now ?? new Date())}${extSuffix}`;
	renameSync(source, assertInsideMediaRoot(target, opts.mediaRoot));
	return target;
}

/**
 * Back up any existing file at `absolutePath` into deleted/ BEFORE it is
 * overwritten (PHP rename_old_files :1193). No-op (null) when nothing is there.
 */
export function renameOldFiles(
	absolutePath: string,
	now: Date = new Date(),
	mediaRoot?: string,
): string | null {
	return existsSync(assertInsideMediaRoot(absolutePath, mediaRoot))
		? moveToDeleted(absolutePath, { now, mediaRoot })
		: null;
}

/**
 * Copy every existing quality × extension file of a source identity to a target
 * identity (PHP duplicate_component_media_files :1999). Returns the created
 * absolute paths. The caller then refreshStoredFilesInfo + save on the target so
 * files_info carries the target's paths, not the source's.
 *
 * ASYNCHRONOUS because the copies are WHOLE MEDIA FILES and this runs on the
 * request path (duplicate_record): one record can hold several components, each
 * with every quality × managed extension on disk, so a synchronous copy here
 * blocks the single event loop for the sum of them and every other request on
 * the install waits. Only the byte copy is async — the existsSync/mkdirSync
 * around it are O(1) metadata syscalls (gate:
 * test/unit/sync_io_on_request_path_tripwire.test.ts).
 */
export async function duplicateMediaFiles(
	spec: MediaTypeSpec,
	source: MediaIdentity,
	target: MediaIdentity,
	pathOpts: { source: MediaPathOptions; target: MediaPathOptions },
): Promise<string[]> {
	const created: string[] = [];
	for (const [quality, extension] of managedFileSlots(spec)) {
		const from = buildMediaLocation(spec, source, quality, extension, pathOpts.source).absolutePath;
		if (!existsSync(from)) continue;
		const to = buildMediaLocation(spec, target, quality, extension, pathOpts.target).absolutePath;
		if (to === from) {
			// NEVER COPY A FILE ONTO ITSELF — an INVARIANT since T1-10 OD-1 was ruled
			// (2026-11-13): the duplicate CLEARS the clone's `properties.image_id`
			// sibling before the insert (duplicate_record.ts, stem_rules.ts
			// stripImageIdSiblings), so the clone's files land under its identifier,
			// and the stem rules refuse a stem two records would share. Two identities
			// resolving to ONE path means one of those doors was bypassed: stop loudly,
			// write nothing (the duplicate reports the component as incomplete, 'copy').
			throw new DedaloError('internal.invariant', {
				message: `duplicateMediaFiles: the copy of ${spec.model} '${target.componentTipo}' resolves to the source's own file (${basename(from)}) — the clone's image_id sibling was not cleared, or two records share a stem the stem rules refuse; nothing was copied`,
				coordinates: {
					section_tipo: target.sectionTipo,
					component_tipo: target.componentTipo,
					source_id: source.sectionId,
					target_id: target.sectionId,
				},
			});
		}
		const toDir = dirname(to);
		if (!existsSync(toDir)) mkdirSync(toDir, { recursive: true, mode: 0o775 });
		await copyFile(from, to);
		created.push(to);
	}
	return created;
}

/**
 * EVERY `[quality, extension]` slot a media type may hold on disk — the ONE
 * census behind duplicate, record-delete and record-restore, so those three can
 * never disagree about what "this record's files" means.
 *
 * It is the MANAGED extension list, never the BUILT one. A walk that enumerates
 * only what the engine builds silently drops the pdf COVER (built whether or not
 * the config lists it) and every configured-but-refused legacy file — which on a
 * copy left the duplicate without the only visual a pdf has in a list view, and
 * on a delete would leave a live file behind under a deleted record's name. See
 * MediaTypeSpec.managedExtensions for the measurement.
 *
 * The thumb tier is the one exception: `files_info` scans it with
 * `config.media.thumb.extension` alone, so any other file there could never be
 * indexed and is not this record's.
 */
export function managedFileSlots(spec: MediaTypeSpec): [string, string][] {
	const thumbQuality = config.media.thumb.quality;
	const qualities = [...spec.qualities];
	if (spec.hasThumb && !qualities.includes(thumbQuality)) qualities.push(thumbQuality);
	const slots: [string, string][] = [];
	for (const quality of qualities) {
		const extensions =
			quality === thumbQuality ? [config.media.thumb.extension] : spec.managedExtensions;
		for (const extension of extensions) slots.push([quality, extension]);
	}
	return slots;
}

/**
 * List the deleted versions of ONE quality × extension (PHP get_deleted_image /
 * restore_component_media_files, both `glob("<id>_*.<ext>")` + natsort):
 * '<quality dir>/deleted/<stem>_deleted_<stamp>.<ext>' (exactly — see
 * deletedVersionName), natural-sorted, newest last. Absolute
 * paths. Used by time-machine reads to recover a soft-deleted file.
 *
 * THE EXTENSION IS PART OF THE MATCH, as it is in PHP's glob. Keying on the STEM
 * alone was harmless while a tier held exactly one file and is not any more — the
 * engine BUILDS alternate-extension twins since 2026-08-07, so a stem-only scan
 * of the default tier answers with the '.avif' twin's soft-deleted bytes as
 * readily as the '.jpg' it was asked for, and a restore would then write those
 * bytes to the '.jpg' path. Every browser would refuse the result.
 */
export function listDeletedVersions(
	spec: MediaTypeSpec,
	identity: MediaIdentity,
	quality: string,
	extension: string,
	pathOpts: MediaPathOptions,
): string[] {
	const location = buildMediaLocation(spec, identity, quality, extension, pathOpts);
	const { dir, stem, extension: cleanExtension } = splitPath(location.absolutePath);
	return listDeletedIn(dir, stem, cleanExtension);
}

/**
 * EXACTLY one stem's soft-deleted name: `<stem>_deleted_<stamp>.<ext>`, the
 * `moveToDeleted` shape. The stamp is `Y-m-d_Hi` (this engine, PHP
 * move_deleted_file) or `Y-m-d_Gis` (PHP rename_old_files, 1–2 hour digits), so
 * the time part is 3–6 digits.
 *
 * NOT a `<stem>_` prefix (PHP's `glob("<id>_*")`). That was safe only while every
 * stem was an identifier ending in a section_id; an `image_id` stem is free text
 * (T1-10), and the prefix of 'coin' matches 'coin_reverse_deleted_…' — another
 * record's soft-deleted bytes, which a restore would then move into this record's
 * live file (T1-10 review).
 */
function deletedVersionName(stem: string, extension: string): RegExp {
	const suffix = extension === '' ? '' : `.${extension}`;
	return new RegExp(
		`^${escapeRegexLiteral(stem)}_deleted_[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{3,6}${escapeRegexLiteral(suffix)}$`,
	);
}

/**
 * The deleted/ scan itself, on a plain directory + stem + extension — shared by
 * `listDeletedVersions` (quality files) and the POSTERFRAME restore, which is not
 * a quality and so has no `buildMediaLocation` to go through.
 */
function listDeletedIn(dir: string, stem: string, extension: string): string[] {
	const deletedDir = `${dir}/deleted`;
	if (!existsSync(deletedDir)) return [];
	const versionName = deletedVersionName(stem, extension);
	const matches = readdirSync(deletedDir)
		.filter((name) => versionName.test(name))
		.map((name) => `${deletedDir}/${name}`)
		.filter((path) => {
			try {
				return statSync(path).isFile();
			} catch {
				return false;
			}
		});
	// Natural sort (PHP natsort) so '..._9' precedes '..._10'.
	return matches.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

// ---------------------------------------------------------------------------
// The record-level pair: delete a record's media, and put it back
// ---------------------------------------------------------------------------

/** One media component this pass handled (PHP returns `{tipo, model}` objects). */
export interface SectionMediaComponent {
	tipo: string;
	model: string;
}

/** What a record-level media pass did. `errors` is never thrown away. */
export interface SectionMediaFilesOutcome {
	/** The media components actually walked, in column order. */
	components: SectionMediaComponent[];
	/** Absolute paths of the files this pass moved (targets). */
	files: string[];
	/**
	 * Per-component failures. PHP logs and continues here, and so do we: one
	 * unreadable component may not abort the other five, and a delete whose media
	 * pass half-ran must SAY so rather than report a clean sweep. The caller
	 * surfaces them; nothing is silently narrowed.
	 */
	errors: string[];
}

/** Options shared by both directions. `mediaRoot` is the scratch-root seam. */
export interface SectionMediaFilesOptions {
	now?: Date;
	mediaRoot?: string;
	/** Bulk-import batch id — drops the datestamp (PHP move_deleted_file). */
	bulkProcessId?: string;
	/**
	 * `properties.additional_path` values the CALLER already knows, keyed by
	 * component tipo — authoritative, and resolved from here otherwise.
	 *
	 * It exists because `additional_path` is a NAMED bucket folder taken from
	 * ANOTHER COMPONENT'S VALUE IN THIS RECORD (rsc165's Certificate of Cession and
	 * Questionnaire files live in one), so resolving it needs the record to be
	 * readable — and the section delete runs POST-COMMIT, when the row is already
	 * gone. Left to resolve itself there, the walk falls back to the numeric bucket
	 * and sweeps a folder the ingest never wrote to, i.e. leaves the files live
	 * under a deleted record's name.
	 *
	 * Both delete doors hand over the pre-delete record instead — see `snapshot`
	 * below, which resolves this per component from it. This field stays for the
	 * caller that knows the bucket outright (and for the gates); a caller whose
	 * row IS readable can omit both, and the resolution below is exact.
	 */
	additionalPathOverrides?: Record<string, string | null>;
	/**
	 * The record's FULL jsonb columns (the Time Machine snapshot shape:
	 * `{media:{…}, string:{…}, …}`) — the readable form of the same problem
	 * `additionalPathOverrides` solves, for the caller that HAS the snapshot and
	 * should not have to re-implement PHP's `get_additional_path` to use it.
	 *
	 * Given it, the bucket of a component declaring `properties.additional_path`
	 * is read from the SNAPSHOT's sibling value instead of from the (already
	 * deleted, or about-to-be-emptied) row. An explicit `additionalPathOverrides`
	 * entry still wins; a component that declares no `additional_path` is
	 * untouched by either.
	 */
	snapshot?: Record<string, unknown>;
	/**
	 * The caller's RECORD-WIDE av hold (A1-01 review M3: av_component_claim.ts
	 * holdRecordAvComponents), taken BEFORE it wrote anything so a busy component
	 * refused the whole delete / restore. The two movers move an av identity's
	 * files only under a hold of its whole component: this one (a component it
	 * does not cover yet is taken here), or — without it — the mover's own for
	 * the pass. Ignored by the read-only walks.
	 */
	avHold?: AvRecordHold;
}

/**
 * Run a MOVER pass under a record av hold — the caller's, or the pass's own
 * (released after). See `SectionMediaFilesOptions.avHold`.
 */
async function withMoverAvHold<T>(
	sectionTipo: string,
	sectionId: number,
	options: SectionMediaFilesOptions,
	work: (hold: AvRecordHold) => Promise<T>,
): Promise<T> {
	if (options.avHold !== undefined) return await work(options.avHold);
	const own = new AvRecordHold(sectionTipo, sectionId);
	try {
		return await work(own);
	} finally {
		own.release();
	}
}

/**
 * The movers' av rule: an av identity's files move only while the hold has its
 * WHOLE component (every lang), re-checked on disk per identity (A1-01 review
 * F3). A component another holder has (a build, an upload, a conform), or a
 * hold reclaimed meanwhile, THROWS `media.build_running` — the walk reports it
 * as that component's error and its files stay where they are (recoverable:
 * re-run the sweep), never moved under a build writing them. Other models pass.
 */
function requireMoverSlot(hold: AvRecordHold, spec: MediaTypeSpec, identity: MediaIdentity): void {
	if (spec.model === 'component_av') hold.require(identity.componentTipo);
}

/**
 * Walk a record's `media` column and hand each media component's identity to
 * `handle`. The two directions differ ONLY in what `handle` does, so the
 * ontology resolution, the model gate, the per-lang identity fan-out and the
 * error contract are written once.
 *
 * The per-item `lang` fan-out mirrors `duplicate_record.ts`: a translatable media
 * component stores one item per lang and each has its own identifier on disk, so
 * a pass that assumed `lang:null` would leave every translated file behind. With
 * no stored items at all we still walk once with `lang:null` — the column key
 * exists, so the record HAD this component, and its files must not survive it.
 */
async function walkSectionMedia(
	sectionTipo: string,
	sectionId: number,
	mediaColumn: Record<string, unknown[]> | null | undefined,
	options: SectionMediaFilesOptions,
	handle: (
		spec: MediaTypeSpec,
		identity: MediaIdentity,
		pathOpts: MediaPathOptions,
	) => string[] | Promise<string[]>,
): Promise<SectionMediaFilesOutcome> {
	const mediaRoot = options.mediaRoot;
	const outcome: SectionMediaFilesOutcome = { components: [], files: [], errors: [] };
	if (mediaColumn === null || mediaColumn === undefined) return outcome;

	for (const [componentTipo, rawItems] of Object.entries(mediaColumn)) {
		const model = await getModelByTipo(componentTipo);
		const spec = model === null || !isMediaModel(model) ? null : mediaTypeOf(model);
		if (model === null || spec === null) {
			// PHP logs an ERROR ("Inconsistent data in media column") and skips. It is
			// reported rather than swallowed: a non-media tipo in the media column is a
			// data fault someone has to see, and on the delete side it is also a file
			// that may still be live.
			outcome.errors.push(
				`media column of ${sectionTipo}/${String(sectionId)} holds '${componentTipo}', whose model is ` +
					`${model === null ? 'unknown' : `'${model}'`} — not a media component; its files were NOT touched`,
			);
			continue;
		}
		try {
			// THE RECORD-SCOPED RESOLUTION (three arguments), so `additional_path`'s
			// NAMED bucket is honoured: the ingest wrote there, and a delete that swept
			// the numeric bucket instead would leave those files live. A caller-supplied
			// value wins — see SectionMediaFilesOptions.additionalPathOverrides for the
			// post-commit case where the record can no longer be read at all.
			// A SNAPSHOT is read as the record itself — the same sibling rule, so
			// `additional_path`'s bucket AND `image_id`'s file stem (T1-10) are the
			// pre-delete row's, never a fallback to the identifier / numeric bucket.
			const resolved = await resolveMediaPathOptions(
				componentTipo,
				sectionTipo,
				sectionId,
				options.snapshot === undefined
					? {}
					: { record: recordFromColumns(sectionTipo, sectionId, options.snapshot) },
			);
			const explicit = options.additionalPathOverrides?.[componentTipo];
			const pathOpts: MediaPathOptions = {
				...resolved,
				...(explicit === undefined ? {} : { additionalPathOverride: explicit }),
				mediaRoot,
			};
			const items = Array.isArray(rawItems) ? rawItems : [];
			const langs = new Set<string | null>();
			for (const item of items) {
				langs.add((item as { lang?: string } | null)?.lang ?? null);
			}
			if (langs.size === 0) langs.add(null);
			for (const lang of langs) {
				const identity: MediaIdentity = { componentTipo, sectionTipo, sectionId, lang };
				outcome.files.push(...(await handle(spec, identity, pathOpts)));
			}
			outcome.components.push({ tipo: componentTipo, model });
		} catch (error) {
			outcome.errors.push(`${componentTipo} (${model}): ${(error as Error).message}`);
		}
	}
	return outcome;
}

/**
 * Move EVERY file of a deleted record's media into its own `deleted/` folder
 * (PHP section_record::remove_section_media_files → component_media_common::
 * remove_component_media_files → move_deleted_file, plus component_av's override
 * for the posterframe).
 *
 * Recoverable by construction: this is a move, and `restoreDeletedSectionMediaFiles`
 * below is the exact inverse. Files that are already absent are silent no-ops
 * (`moveToDeleted` returns null), so the pass is idempotent — which matters
 * because it runs POST-COMMIT, after the row is already gone.
 */
export async function removeSectionMediaFiles(
	sectionTipo: string,
	sectionId: number,
	mediaColumn: Record<string, unknown[]> | null | undefined,
	options: SectionMediaFilesOptions = {},
): Promise<SectionMediaFilesOutcome> {
	const now = options.now ?? new Date();
	return withMoverAvHold(sectionTipo, sectionId, options, (hold) =>
		walkSectionMedia(sectionTipo, sectionId, mediaColumn, options, (spec, identity, pathOpts) => {
			requireMoverSlot(hold, spec, identity);
			const moved: string[] = [];
			for (const [quality, extension] of managedFileSlots(spec)) {
				const path = buildMediaLocation(spec, identity, quality, extension, pathOpts).absolutePath;
				const target = moveToDeleted(path, {
					now,
					mediaRoot: pathOpts.mediaRoot,
					bulkProcessId: options.bulkProcessId,
				});
				if (target !== null) moved.push(target);
			}
			// THE POSTERFRAME IS NOT A QUALITY, and no quality walk can reach it. PHP
			// overrides the whole method on component_av for exactly this file; the TS
			// delete path moved it in neither shape, so a deleted interview left its
			// still frame in a live folder — the one image of the record every list
			// view shows.
			const posterframe = posterframeLocation(spec, identity, pathOpts);
			if (posterframe !== null) {
				const target = moveToDeleted(posterframe.absolutePath, {
					now,
					mediaRoot: pathOpts.mediaRoot,
					bulkProcessId: options.bulkProcessId,
				});
				if (target !== null) moved.push(target);
			}
			return moved;
		}),
	);
}

/**
 * Put a record's soft-deleted media back (PHP section_record::
 * restore_deleted_section_media_files → restore_component_media_files + the
 * component_av posterframe override) — the tool_time_machine section-restore
 * touchpoint `engineering/MEDIA_SPEC.md` §8 names.
 *
 * Per quality × extension (and for the posterframe): take the NEWEST version in
 * `deleted/` and move it back to the live path. Older versions STAY — a restore
 * consumes one deletion, not the record's whole deletion history, and PHP's
 * `end(natsort(glob()))` says the same.
 *
 * A quality with nothing in `deleted/` is skipped, exactly as PHP skips it: the
 * file may simply never have existed, and the alternative — failing the restore —
 * would deny the record every file that IS recoverable.
 *
 * It does NOT overwrite a live file. PHP's `rename()` would; but a restore runs
 * AFTER the record's data is already back, and by then an operator may have
 * re-uploaded. Silently replacing the newer file with the pre-delete one is the
 * one outcome nothing can undo, so the live file wins and the deleted version
 * stays where it is, still recoverable by hand.
 */
export async function restoreDeletedSectionMediaFiles(
	sectionTipo: string,
	sectionId: number,
	mediaColumn: Record<string, unknown[]> | null | undefined,
	options: SectionMediaFilesOptions = {},
): Promise<SectionMediaFilesOutcome> {
	return withMoverAvHold(sectionTipo, sectionId, options, (hold) =>
		walkSectionMedia(sectionTipo, sectionId, mediaColumn, options, (spec, identity, pathOpts) => {
			requireMoverSlot(hold, spec, identity);
			const restored: string[] = [];
			for (const [quality, extension] of managedFileSlots(spec)) {
				const live = buildMediaLocation(spec, identity, quality, extension, pathOpts).absolutePath;
				const versions = listDeletedVersions(spec, identity, quality, extension, pathOpts);
				const target = restoreNewest(versions, live, pathOpts.mediaRoot);
				if (target !== null) restored.push(target);
			}
			const posterframe = posterframeLocation(spec, identity, pathOpts);
			if (posterframe !== null) {
				const { dir, stem, extension } = splitPath(posterframe.absolutePath);
				const target = restoreNewest(
					listDeletedIn(dir, stem, extension),
					posterframe.absolutePath,
					pathOpts.mediaRoot,
				);
				if (target !== null) restored.push(target);
			}
			return restored;
		}),
	);
}

/**
 * Move the newest entry of `versions` back to `live`, or null when there is
 * nothing to restore or a live file is already there (see the no-overwrite rule
 * above). Both paths pass the media-root chokepoint.
 */
function restoreNewest(versions: string[], live: string, mediaRoot?: string): string | null {
	const newest = versions[versions.length - 1];
	if (newest === undefined) return null;
	const target = assertInsideMediaRoot(live, mediaRoot);
	if (existsSync(target)) return null;
	const liveDir = dirname(target);
	if (!existsSync(liveDir)) mkdirSync(liveDir, { recursive: true, mode: 0o775 });
	renameSync(assertInsideMediaRoot(newest, mediaRoot), target);
	return target;
}

/** What the duplicate's copy did for ONE media component (duplicateSectionMediaFiles). */
export interface ComponentMediaCopy {
	tipo: string;
	/** The source's managed files found on disk (every quality × managed extension). */
	sourceFiles: number;
	/** Files copied to the target identity. */
	copiedFiles: number;
	/** Why the component's copy stopped (a refused bucket, a failed copy) — absent when it ran. */
	error?: string;
}

/**
 * COPY a record's media files to its duplicate (PHP section_record::duplicate →
 * duplicate_component_media_files :1999), per media component, through the SAME
 * record-scoped walk as the delete/restore pair — so `properties.additional_path`'s
 * NAMED bucket is resolved from the SOURCE record's own sibling value (the
 * snapshot `sourceColumns`), the per-lang identity fan-out is the one the other
 * two directions use, and every path passes the media-root chokepoint. The
 * TARGET's options are the CLONE's own, record-scoped (resolveMediaPathOptions
 * on the inserted row): the clone carries the same bucket sibling (same bucket)
 * but NOT the source's `properties.image_id` sibling — the duplicate clears it
 * (stem_rules.ts stripImageIdSiblings, T1-10 OD-1 ruled b) — so the clone's
 * files are named by its identifier, never by the source's stem.
 *
 * NEVER THROWS for a component and never swallows: each component answers what
 * it found and copied, and why it stopped (`error`) — the duplicate turns that
 * into its VERDICT (section/record/duplicate_record.ts, CORE-5). A copy that
 * fails half-way still reports the files it had copied.
 */
export async function duplicateSectionMediaFiles(
	sectionTipo: string,
	sourceSectionId: number,
	targetSectionId: number,
	sourceColumns: Record<string, unknown>,
	options: { mediaRoot?: string } = {},
): Promise<{ perComponent: ComponentMediaCopy[] }> {
	const mediaColumn = sourceColumns.media as Record<string, unknown[]> | null | undefined;
	const perComponent: ComponentMediaCopy[] = [];
	if (mediaColumn === null || mediaColumn === undefined || typeof mediaColumn !== 'object') {
		return { perComponent };
	}
	for (const [componentTipo, items] of Object.entries(mediaColumn)) {
		const copy: ComponentMediaCopy = { tipo: componentTipo, sourceFiles: 0, copiedFiles: 0 };
		const outcome = await walkSectionMedia(
			sectionTipo,
			sourceSectionId,
			{ [componentTipo]: items },
			{ mediaRoot: options.mediaRoot, snapshot: sourceColumns },
			async (spec, identity, pathOpts) => {
				const target: MediaIdentity = { ...identity, sectionId: targetSectionId };
				for (const [quality, extension] of managedFileSlots(spec)) {
					const from = buildMediaLocation(
						spec,
						identity,
						quality,
						extension,
						pathOpts,
					).absolutePath;
					if (existsSync(from)) copy.sourceFiles++;
				}
				// The clone's own record-scoped options (see the header): its row is
				// inserted by now, its image_id sibling cleared.
				const targetOpts = {
					...(await resolveMediaPathOptions(identity.componentTipo, sectionTipo, targetSectionId)),
					mediaRoot: pathOpts.mediaRoot,
				};
				const created = await duplicateMediaFiles(spec, identity, target, {
					source: pathOpts,
					target: targetOpts,
				});
				copy.copiedFiles += created.length;
				return created;
			},
		);
		if (outcome.errors.length > 0) copy.error = outcome.errors.join('; ');
		perComponent.push(copy);
	}
	return { perComponent };
}

/**
 * ENUMERATE a record's media files as they exist on disk RIGHT NOW — the
 * read-only third direction of the walk, for the archive extraction
 * (core/archive/extract.ts). Same census as the two movers: every quality ×
 * managed extension plus the AV posterframe, `files_info` never consulted (it is
 * a cache, and an archive built from a stale cache would be an archive with
 * holes). Absent files are simply not listed; nothing is touched.
 *
 * NOT listed, and stated so the archive can say the same: the `deleted/`
 * versions (history, not state — the archive's own scope rule) and the AV
 * subtitles, whose grammar lives on component_av alone (`path.ts subtitlesPath`)
 * and is not a quality slot of any type.
 */
export async function listSectionMediaFiles(
	sectionTipo: string,
	sectionId: number,
	mediaColumn: Record<string, unknown[]> | null | undefined,
	options: SectionMediaFilesOptions = {},
): Promise<SectionMediaFilesOutcome> {
	return walkSectionMedia(
		sectionTipo,
		sectionId,
		mediaColumn,
		options,
		(spec, identity, pathOpts) => {
			const present: string[] = [];
			for (const [quality, extension] of managedFileSlots(spec)) {
				const path = buildMediaLocation(spec, identity, quality, extension, pathOpts).absolutePath;
				if (existsSync(path) && statSync(path).isFile()) present.push(path);
			}
			const posterframe = posterframeLocation(spec, identity, pathOpts);
			if (posterframe !== null && existsSync(posterframe.absolutePath)) {
				present.push(posterframe.absolutePath);
			}
			return present;
		},
	);
}
