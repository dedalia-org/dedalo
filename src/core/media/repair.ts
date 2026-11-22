/**
 * MEDIA REPAIR KERNEL — refresh a component's stored media items against the
 * filesystem, optionally rebuilding the derivative files first.
 *
 * `files_info` is a DISK-DERIVED CACHE the read path serves verbatim for
 * image/pdf/svg/3d (only component_av re-scans per read — component_emit.ts).
 * When it goes stale (e.g. a write that ran while MEDIA_PATH pointed at the
 * wrong tree), the record renders nothing although the files are on disk.
 * This module is the ONE copy of the fix, composed from the existing seams:
 *
 * - regenerate*  (processing.ts)  — rebuild default quality + thumb (+ image
 *   SVG envelope) from the original, where the original is on this box;
 * - refreshStoredFilesInfo (files_info.ts) — re-scan the disk and splice a
 *   fresh files_info into each stored item, preserving the sibling keys
 *   (original_* / modified_* / lib_data / external_source).
 *
 * TWO HALVES, because they belong on two sides of a row lock
 * (CLOSURE_PLAN Step 2, TOOLS-5):
 * - regenerateMediaDerivatives — the FILE work (seconds per record): outside any
 *   lock, keyed by the identities of a snapshot;
 * - rescanMediaItems — SYNCHRONOUS, a pure function of the items it is handed:
 *   it runs INSIDE files_info_persist.ts transformStoredMediaItems, on the items
 *   read under the row lock, so a value a curator committed while the files were
 *   being rebuilt is what gets refreshed — never overwritten by a snapshot.
 * refreshMediaItems composes the two for a caller that only reads (the sweep's
 * dry-run adjudication).
 *
 * Callers and their division of labor:
 * - tools/tool_update_cache (in-app, per-section, SQO-driven): regenerate, then
 *   the locked rescan with holdShrink;
 * - core/media/files_info_reconcile.ts sweepFilesInfo (scripts/
 *   media_repair_files_info.ts, the reconcile registry): no regeneration; a
 *   dry-run adjudication on the snapshot, then per change a locked rescan that
 *   re-judges GROW/DIFF/SHRINK on the locked items;
 * - section/record/duplicate_record.ts: the clone's locked rescan at its own
 *   identity.
 * PERSISTENCE IS THE TRANSFORM'S (files_info_persist.ts — NO Time Machine entry,
 * files_info is a filesystem cache): the kernel never touches the DB.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { config } from '../../config/config.ts';
import { type MediaTypeSpec, mediaTypeOf } from '../concepts/media.ts';
import { DedaloError } from '../errors/dedalo_error.ts';
import { withAvComponentClaim } from './av_component_claim.ts';
import { moveToDeleted } from './file_ops.ts';
import { refreshStoredFilesInfo } from './files_info.ts';
import { resolveMediaPathOptions } from './ontology_path.ts';
import {
	buildMediaIdentifier,
	buildMediaLocation,
	type MediaIdentity,
	type MediaPathOptions,
} from './path.ts';
import {
	buildAlternateVersions,
	buildImageVersion,
	buildMasterNormalizedCopy,
	buildThumbVersion,
	derivedTwinQualities,
	regenerate3d,
	regeneratePdf,
	regenerateSvg,
	resolveMasterSource,
} from './processing.ts';
import {
	createDefaultSvgFile,
	defaultRasterUrl,
	retireOverlayIfNoMediaFiles,
	svgOverlayLocation,
} from './svg_overlay.ts';
import { rebuildThumb, thumbIsMissing } from './thumb.ts';

export interface MediaItemsRefreshResult {
	/** The stored items with a fresh files_info spliced per item (same order, same length). */
	refreshedItems: unknown[];
	/** Derivative-rebuild failures, one message per failed item. The files_info
	 * refresh still applied to those items — the scan reports whatever exists. */
	errors: string[];
	/** Items whose stored index was KEPT because the rescan found fewer existing
	 * files than stored (holdShrink) — see the option's doc for why. */
	heldShrinks: number;
}

/** Count of entries that claim an existing file — the shrink-guard comparison unit. */
function existingFileCount(filesInfo: unknown): number {
	if (!Array.isArray(filesInfo)) return 0;
	return filesInfo.filter((entry) => (entry as Record<string, unknown> | null)?.file_exist === true)
		.length;
}

/** The rebuild options of regenerateMediaDerivatives (see refreshMediaItems). */
export interface MediaRegenerateInput {
	componentTipo: string;
	sectionTipo: string;
	sectionId: number;
	/** The component's resolved model (must satisfy mediaTypeOf(model) !== null). */
	model: string;
	/** The items whose identities (lang) and upload cues (original name) key the rebuild. */
	items: readonly unknown[];
	/** v6 delete_normalized_files — see refreshMediaItems. */
	deleteNormalized?: boolean;
	/** The dd800 bulk-process run id: deleted files land in `deleted/<id>/`. */
	bulkProcessId?: number | null;
	/** Record-scoped path options; resolved here when absent. */
	pathOpts?: MediaPathOptions;
}

/** The media type spec of a model, or the programming-error throw. */
function mediaSpecOf(model: string, componentTipo: string, sectionTipo: string): MediaTypeSpec {
	const spec = mediaTypeOf(model);
	if (spec === null) {
		throw new DedaloError('request.invalid_model', {
			message: `media repair: '${model}' is not a media model`,
			coordinates: { model, component_tipo: componentTipo, section_tipo: sectionTipo },
		});
	}
	return spec;
}

/**
 * THE FILE HALF: rebuild the MISSING derivative files of every item (v6
 * regenerate_component parity — see regenerateMissingDerivatives), keyed by
 * each item's identity. Runs OUTSIDE any row lock — this is the slow part.
 * Returns the non-fatal failures, one message each.
 */
export async function regenerateMediaDerivatives(input: MediaRegenerateInput): Promise<string[]> {
	const { componentTipo, sectionTipo, sectionId, model } = input;
	const spec = mediaSpecOf(model, componentTipo, sectionTipo);
	const pathOpts =
		input.pathOpts ?? (await resolveMediaPathOptions(componentTipo, sectionTipo, sectionId));
	const errors: string[] = [];
	for (const raw of input.items) {
		if (raw === null || typeof raw !== 'object') continue;
		const item = raw as Record<string, unknown>;
		const identity = {
			componentTipo,
			sectionTipo,
			sectionId,
			lang: (item.lang as string | null) ?? null,
		};
		// The raw upload extension (e.g. the '.png' behind a normalized '.jpg')
		// steers resolveMasterSource to the right original file.
		const rawName = item.original_normalized_name;
		const rawExtension = typeof rawName === 'string' ? (rawName.split('.').pop() ?? null) : null;
		try {
			// Non-fatal per-file failures (a twin this host cannot encode) come
			// back as values; only a fatal one throws. Both land in `errors`.
			// ONE AV OPERATION PER COMPONENT (A1-01, owner ruling 4): the av pass
			// mints the posterframe + thumb, so it holds the component; a busy one
			// (a build, an upload) is a per-record VALUE here — the sweep goes on.
			errors.push(
				...(await withAvComponentClaim(spec, identity, 'regenerate', () =>
					regenerateMissingDerivatives(model, spec, identity, pathOpts, {
						rawExtension,
						deleteNormalized: input.deleteNormalized === true,
						bulkProcessId: input.bulkProcessId ?? null,
					}),
				)),
			);
		} catch (error) {
			errors.push((error as Error).message);
		}
	}
	return errors;
}

/** The rescan's context (see rescanMediaItems). */
export interface MediaRescanOptions {
	spec: MediaTypeSpec;
	/** The record the items belong to — each item's own `lang` completes its identity. */
	identityBase: Omit<MediaIdentity, 'lang'>;
	/** Record-scoped path options (resolved by the caller, BEFORE the lock). */
	pathOpts: MediaPathOptions;
	/**
	 * KEEP an item's stored files_info when the rescan finds FEWER existing files
	 * than stored. On a box holding a PARTIAL media copy (dev laptops — buckets not
	 * synced) an unguarded rescan destroys the valid index of every record whose
	 * files live elsewhere; a runaway tool_update_cache sweep did exactly that
	 * (2026-07-19, ~86k rsc170 records, restored from the pinned backup). Bulk/tool
	 * callers MUST pass true; only a caller that adjudicates shrinks itself (the
	 * sweep's --allow-shrink, the duplicate's own fresh copy) passes false.
	 */
	holdShrink: boolean;
}

/**
 * THE INDEX HALF — SYNCHRONOUS and pure over the filesystem: re-scan each item
 * FROM ITS OWN lang and its own scan cues (scanContextFromItem: the external
 * source, the original/modified normalized names), never matched to another
 * list by index. Non-object items pass through untouched. Built to run inside
 * the locked transform (files_info_persist.ts), on the items read under the lock.
 */
export function rescanMediaItems(
	items: readonly unknown[],
	options: MediaRescanOptions,
): { items: unknown[]; heldShrinks: number } {
	const refreshed: unknown[] = [];
	let heldShrinks = 0;
	for (const raw of items) {
		if (raw === null || typeof raw !== 'object') {
			refreshed.push(raw);
			continue;
		}
		const item = raw as Record<string, unknown>;
		const identity: MediaIdentity = {
			...options.identityBase,
			lang: (item.lang as string | null) ?? null,
		};
		const fresh = refreshStoredFilesInfo(item, options.spec, identity, options.pathOpts);
		if (isHeldShrink(item, fresh, options.holdShrink)) {
			heldShrinks++;
			refreshed.push(item); // stored index kept — see holdShrink
			continue;
		}
		refreshed.push(fresh);
	}
	return { items: refreshed, heldShrinks };
}

/** Under `holdShrink`, a rescan that finds FEWER existing files than stored is held. */
function isHeldShrink(
	stored: Record<string, unknown>,
	fresh: Record<string, unknown>,
	holdShrink: boolean,
): boolean {
	return holdShrink && existingFileCount(fresh.files_info) < existingFileCount(stored.files_info);
}

/**
 * THE NORMALIZED MASTER COPIES, MISSING ONLY — the browser-viewable
 * `<id>.<defaultExtension>` beside a raw upload in each master tier
 * (buildMasterNormalizedCopy). This is what heals a record whose master was
 * uploaded before the copy was ever built: without it the tier holds only a
 * `.tif`, and the client's quality selector shows no 'original' at all.
 * MISSING ONLY is repair's contract; the ingest of a master rebuilds it
 * (processUploadedFile). Failures are VALUES, like every other repair step.
 */
async function healMissingMasterCopies(
	spec: MediaTypeSpec,
	identity: MediaIdentity,
	pathOpts: MediaPathOptions,
	rawExtension: string | null,
	errors: string[],
): Promise<void> {
	for (const quality of spec.masterQualities) {
		try {
			await buildMasterNormalizedCopy(spec, identity, quality, pathOpts, {
				rawExtension,
				rebuild: false,
			});
		} catch (error) {
			errors.push(
				`${quality}.${spec.defaultExtension} of ${buildMediaIdentifier(identity)}: ${(error as Error).message}`,
			);
		}
	}
}

/**
 * Refresh every stored media item of one component on one record — the two
 * halves composed, for a caller that READS (the sweep's dry-run adjudication):
 * with `regenerate: true` the derivative files are rebuilt first
 * (image/pdf/svg/3d — a no-op when the original is absent on this box;
 * component_av is never transcoded here, that is an async job owned by
 * tool_media_versions), then each item is re-scanned. A caller that WRITES the
 * result runs the rescan inside transformStoredMediaItems instead.
 *
 * Throws when `model` is not a media model — callers gate on isMediaModel/
 * mediaTypeOf, so reaching here with anything else is a programming error.
 */
export async function refreshMediaItems(input: {
	componentTipo: string;
	sectionTipo: string;
	sectionId: number;
	/** The component's resolved model (must satisfy mediaTypeOf(model) !== null). */
	model: string;
	/** The record's stored media items for this component. */
	items: readonly unknown[];
	/** Rebuild MISSING derivative files from the original before scanning (v6
	 * regenerate_component parity: an existing derivative is NEVER re-encoded;
	 * the image thumb is re-created always; the SVG envelope is created only
	 * when absent, with its embedded raster path fixed when it drifted). */
	regenerate: boolean;
	/**
	 * v6 delete_normalized_files (the tool's per-media-component regenerate
	 * option, UI default false): move the NORMALIZED files of the default
	 * quality (default + alternate extensions, never the uploaded original) to
	 * their `deleted/` folder before rebuilding. Guarded — a deliberate v6
	 * divergence — on a LOCALLY PRESENT original: on a partial-media box the
	 * v6 behavior would delete the only local copies and rebuild nothing.
	 */
	deleteNormalized?: boolean;
	/** The dd800 bulk-process run id: deleted files land in `deleted/<id>/` (v6
	 * move_deleted_file bulk mode), tying the moved files to the run. */
	bulkProcessId?: number | null;
	/** See MediaRescanOptions.holdShrink. */
	holdShrink: boolean;
}): Promise<MediaItemsRefreshResult> {
	const { componentTipo, sectionTipo, sectionId, model, items, holdShrink } = input;
	const spec = mediaSpecOf(model, componentTipo, sectionTipo);
	// RECORD-scoped (the third argument): `properties.additional_path` names a
	// per-record bucket, and a rescan of the numeric bucket would index nothing.
	const pathOpts = await resolveMediaPathOptions(componentTipo, sectionTipo, sectionId);
	const errors = input.regenerate
		? await regenerateMediaDerivatives({
				componentTipo,
				sectionTipo,
				sectionId,
				model,
				items,
				deleteNormalized: input.deleteNormalized,
				bulkProcessId: input.bulkProcessId,
				pathOpts,
			})
		: [];
	const rescan = rescanMediaItems(items, {
		spec,
		identityBase: { componentTipo, sectionTipo, sectionId },
		pathOpts,
		holdShrink,
	});
	return { refreshedItems: rescan.items, errors, heldShrinks: rescan.heldShrinks };
}

/**
 * v6 component_media_common::regenerate_component (:2614) parity — the TOOL
 * regenerate builds only what is MISSING (upload ingest keeps its unconditional
 * builders — a fresh original SHOULD re-encode):
 *
 *  1. delete_normalized_files (option, UI default false): move the default
 *     quality's normalized files to `deleted/` first — only when the original
 *     is locally present (our guard; v6 assumed the full media store).
 *  2. default quality: build ONLY when the file is absent (needs the original).
 *  3. image thumb: re-create ALWAYS, FROM THE DEFAULT-QUALITY FILE — v6
 *     component_image::create_thumb (:393) reads get_media_filepath(default)
 *     and NEVER touches the original; when the default file is absent it skips
 *     (v6 returns false). This must NOT be gated on the original: on a
 *     partial-media box most records have the default file but no original.
 *  4. image SVG envelope: create when absent (needs only the default file);
 *     when present, FIX the embedded raster path if it drifted (v6 str_replace).
 *  5. pdf/svg/3d: their whole derivative set builds only when the default
 *     quality file is absent (the builders are internally idempotent copies;
 *     they need the original).
 *  6. image alternate-extension twins (v6 checks them too): build the MISSING
 *     ones from the master, per derived tier that holds its own file. See the
 *     step in the body for why it is LAST and per-extension wrapped, and
 *     processing.ts buildAlternateVersions for why repair never retires or
 *     re-encodes a twin that already exists.
 *
 * RETURNS the NON-FATAL failures (today: twin builds) rather than throwing them.
 * The caller merges them into its own `errors`, which is the channel the sweep
 * and the tool already report through. A throw here would abort steps 3-5 for the
 * item — the opposite of what a repair pass is for.
 *
 * Exported for the unit gate (tool_update_cache.test.ts thumb parity).
 */
export async function regenerateMissingDerivatives(
	model: string,
	spec: MediaTypeSpec,
	identity: MediaIdentity,
	pathOpts: MediaPathOptions,
	options: {
		rawExtension: string | null;
		deleteNormalized: boolean;
		bulkProcessId: number | null;
	},
): Promise<string[]> {
	const errors: string[] = [];
	// The original is needed only by the ORIGINAL-SOURCED steps (default-quality
	// build, delete_normalized). Thumb + envelope derive from the DEFAULT file —
	// they must run even when the original is not on this box (v6 create_thumb).
	const source = resolveMasterSource(spec, identity, pathOpts, options.rawExtension);

	const defaultLocation = buildMediaLocation(
		spec,
		identity,
		spec.defaultQuality,
		spec.defaultExtension,
		pathOpts,
	);

	// 1. delete_normalized_files — move (never unlink) the normalized default-
	//    quality files to deleted/; the uploaded original itself is never touched.
	if (options.deleteNormalized && source !== null) {
		// The NORMALIZED files of the default quality: the type's own file, the twins
		// beside it, and — for pdf — the COVER, which is built whether or not the
		// config lists it and would otherwise survive the wipe and be re-served as a
		// stale picture of a document that has just been rebuilt. NOT the upload
		// allowlist: a file an operator parked in this tier is theirs, not ours.
		const extensions = [
			...new Set([spec.defaultExtension, ...spec.alternateExtensions, ...spec.coverExtensions]),
		];
		for (const extension of extensions) {
			const location = buildMediaLocation(spec, identity, spec.defaultQuality, extension, pathOpts);
			if (location.absolutePath !== source && existsSync(location.absolutePath)) {
				moveToDeleted(location.absolutePath, {
					mediaRoot: pathOpts.mediaRoot ?? undefined,
					bulkProcessId: options.bulkProcessId !== null ? String(options.bulkProcessId) : undefined,
				});
			}
		}
	}

	// THE THUMB, FOR EVERY MODEL, IN ONE PLACE — build it when it is MISSING and a
	// source exists (thumb.ts owns what "a source" means per model, and mints an av
	// posterframe when that is what is missing).
	//
	// It used to be four different rules and two silences: image rebuilt it always,
	// svg only when missing, pdf only when the whole default tier was absent, and
	// av/3d never — so a deleted av or 3d thumb was UNREPAIRABLE by the tool whose
	// entire job is repairing derived files. The image "always" survives below,
	// because that branch also fixes the envelope and is the one path with a
	// measured reason to re-encode.
	//
	// Failures are VALUES, like the twins and the covers: a host without an SVG
	// rasterizer, an audio-only av, a 3d record whose posterframe only a browser can
	// make — none of those may cost the sweep the repair of every remaining record.
	if (
		spec.hasThumb &&
		model !== 'component_image' &&
		thumbIsMissing({ spec, identity, pathOpts })
	) {
		try {
			await rebuildThumb({ spec, identity, pathOpts });
		} catch (error) {
			errors.push(
				`${config.media.thumb.quality} of ${buildMediaIdentifier(identity)}: ${(error as Error).message}`,
			);
		}
	}

	switch (model) {
		case 'component_image': {
			// 2a. THE NORMALIZED MASTER COPY, MISSING ONLY — the browser-viewable
			// `<id>.<defaultExtension>` beside a raw upload in 'original'/'modified'
			// (see buildMasterNormalizedCopy). This is the step that heals a record
			// whose master was uploaded before the copy was ever built: without it the
			// tier holds only a `.tif`, and the client's quality selector shows no
			// 'original' at all. MISSING ONLY is repair's contract; the ingest of a
			// master is what rebuilds it (processUploadedFile).
			await healMissingMasterCopies(spec, identity, pathOpts, options.rawExtension, errors);
			// 2. default quality only when absent — and only when the original is here
			if (!existsSync(defaultLocation.absolutePath) && source !== null) {
				await buildImageVersion(spec, identity, spec.defaultQuality, source, pathOpts);
			}
			// 3. thumb ALWAYS — from the DEFAULT-QUALITY file (v6 create_thumb);
			//    skip when it is absent (v6 logs + returns false).
			if (existsSync(defaultLocation.absolutePath)) {
				await buildThumbVersion(spec, identity, defaultLocation.absolutePath, pathOpts);
				// 4. envelope: create when absent, else fix a drifted raster path
				const overlay = svgOverlayLocation(spec, identity, pathOpts);
				if (!existsSync(overlay.absolutePath)) {
					await createDefaultSvgFile(spec, identity, pathOpts);
				} else {
					fixEnvelopeRasterPath(overlay.absolutePath, spec, identity, pathOpts);
				}
			}
			// 6. ALTERNATE-EXTENSION TWINS — MISSING ONLY, and deliberately AFTER the
			//    thumb + envelope block, with EVERY EXTENSION INDIVIDUALLY WRAPPED.
			//    The thumb and the envelope are the two things tool_update_cache exists
			//    to fix (a record whose edit view renders nothing has a missing
			//    envelope, not a missing avif), and a twin is the one derivative whose
			//    encoder may simply be absent on the host. Placed earlier, or wrapped
			//    as one block, an AVIF delegate missing from a box would abort the
			//    repair of every record in the sweep — turning the repair tool off for
			//    a reason unrelated to what it repairs.
			//
			//    buildAlternateVersions collects per-file failures rather than throwing,
			//    so this try/catch only catches a PROGRAMMING error (a bad tier list);
			//    it is here so that even that cannot cost the item its repair.
			if (source !== null) {
				for (const extension of spec.alternateExtensions) {
					try {
						const outcome = await buildAlternateVersions(spec, identity, pathOpts, source, {
							qualities: derivedTwinQualities(spec),
							extensions: [extension],
							// Repair's contract: build what is MISSING, never re-encode or
							// remove what is there. A STALE twin is therefore not corrected
							// here — it is corrected by the next master change, and the engine
							// cannot tell it from an operator-authored one without per-tier
							// provenance (the ledgered gap). Missing-only also never retires,
							// so a partial-media box cannot lose a twin to a repair sweep.
							mode: 'missing-only',
						});
						errors.push(...outcome.errors);
					} catch (error) {
						errors.push(`alternate '.${extension}': ${(error as Error).message}`);
					}
				}
			}
			// THE WRAPPER OF AN EMPTY RECORD MUST NOT SURVIVE (policy 2026-10-23; see
			// retireOverlayIfNoMediaFiles). Not a build: a record whose every quality
			// file is gone holds nothing for an envelope to wrap, and this is the
			// sweep's heal for records emptied before the delete seam knew the rule.
			retireOverlayIfNoMediaFiles(spec, identity, pathOpts);
			break;
		}
		case 'component_pdf':
			if (!existsSync(defaultLocation.absolutePath) && source !== null) {
				// Its cover failures are VALUES, for the same reason step 6's are: a
				// cover format this host cannot encode must cost the sweep a cover, not
				// the repair of every remaining record.
				errors.push(...(await regeneratePdf(spec, identity, pathOpts)).errors);
			}
			break;
		case 'component_svg':
			if (!existsSync(defaultLocation.absolutePath) && source !== null) {
				// Its thumb failure is a VALUE for the same reason the pdf covers' are:
				// a host with no SVG rasterizer must cost the sweep a thumbnail, not the
				// repair of every remaining record. (When the web copy IS present, the
				// generic missing-thumb pass above has already handled the thumb.)
				errors.push(...(await regenerateSvg(spec, identity, pathOpts)).errors);
			}
			break;
		case 'component_3d':
			if (
				!existsSync(defaultLocation.absolutePath) &&
				source !== null &&
				options.rawExtension !== null
			) {
				await regenerate3d(spec, identity, pathOpts, options.rawExtension);
			}
			break;
		// component_av: async transcode — deliberately not enqueued here.
	}
	return errors;
}

/**
 * v6 component_image::regenerate_component (:1799) drifted-path fix: the
 * persisted envelope must embed the CURRENT default-quality relative raster URL
 * (an install that moved/renamed its media dir leaves stale hrefs behind).
 */
function fixEnvelopeRasterPath(
	overlayPath: string,
	spec: MediaTypeSpec,
	identity: MediaIdentity,
	pathOpts: MediaPathOptions,
): void {
	const content = readFileSync(overlayPath, 'utf8');
	const match = content.match(new RegExp(`xlink:href="(\\S+\\.${spec.defaultExtension})"`));
	if (match?.[1] === undefined) return;
	const expected = defaultRasterUrl(spec, identity, pathOpts);
	if (match[1] === expected) return;
	writeFileSync(overlayPath, content.replace(match[1], expected));
}
