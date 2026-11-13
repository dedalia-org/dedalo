/**
 * MEDIA PATH BUILDER — the deterministic file/dir grammar (Identity law).
 *
 * A media file's on-disk location is fully computed from its identity and
 * quality; the DB never stores an absolute path (only a media-root-relative
 * one). This module ports the PHP grammar so the TS engine can compute,
 * verify, and regenerate files rather than trusting stored paths.
 *
 * PHP references (core/component_media_common/class.component_media_common.php):
 *   - identifier: get_id (:649-681)  →  {component_tipo}_{section_tipo}_{section_id}[_{lang}]
 *   - file stem:  component_image::get_id (class.component_image.php:158-219) →
 *                 the `properties.image_id` sibling's value when filled, else the identifier
 *   - dir:        get_media_path_dir (:2859)  →  MEDIA_PATH + folder + initial_media_path + '/' + quality + additional_path
 *   - file:       get_media_filepath (:3356)  →  dir + '/' + id + '.' + extension
 *   - bucket:     get_additional_path (:753-819)  →  '/' + max * floor(section_id / max)
 *
 * EVERY absolute path produced here is confined inside the media root via
 * assertInsideMediaRoot — the one traversal chokepoint (stronger than PHP's
 * scattered realpath calls). Identifier segments run through the tipo gate.
 */

import { resolve, sep } from 'node:path';
import { config } from '../../config/config.ts';
import {
	assertValidQuality,
	hasPosterframe,
	type MediaTypeSpec,
	mediaTypeOf,
} from '../concepts/media.ts';
import { isValidTipo } from '../concepts/ontology.ts';
import { DedaloError } from '../errors/dedalo_error.ts';
import { assertValidTipo } from '../search/identifier_gate.ts';
import { MEDIA_FILENAME_GRAMMAR } from './protection.ts';
import { assertTestMediaRoot } from './test_media_root.ts';

/** A media component instance's identity (the identifier inputs). */
export interface MediaIdentity {
	componentTipo: string;
	sectionTipo: string;
	sectionId: number;
	/** Non-null only for translatable media components (PHP get_id lang suffix :672-674). */
	lang: string | null;
}

/** Path-shaping options resolved from ontology (per-section / per-component properties). */
export interface MediaPathOptions {
	/** Per-section initial media segment WITH leading slash, or '' (PHP get_initial_media_path :715). */
	initialMediaPath: string;
	/** properties.max_items_folder bucket size (usually 1000), or null (PHP get_additional_path :801). */
	maxItemsFolder: number | null;
	/**
	 * The resolved `properties.additional_path` bucket — a SIBLING component's
	 * value on THIS record, leading slash forced / trailing slash stripped. Wins
	 * over the max_items_folder bucket, matching PHP (:778 before :801).
	 *
	 * THREE STATES, and the difference is load-bearing:
	 * - a string  → the named bucket ('/cession_files');
	 * - `''`      → the property IS declared but this record's sibling is empty;
	 *               PHP's `empty()` branch then falls back to the numeric bucket;
	 * - `null`    → the component declares no `additional_path` at all;
	 * - ABSENT    → NOT RESOLVED HERE. Only `resolveMediaPathOptions`'s
	 *               record-scoped form (or `completeMediaPathOptions`) can answer
	 *               it, because the answer is a record's data, not the ontology's.
	 *
	 * Until 2026-08-09 nothing ever set this field — it was declared and resolved
	 * by nobody — so a component that uses the property wrote and read at the
	 * numeric bucket instead of the named folder. `media/ontology_path.ts` is now
	 * the single resolver; see its header for who still asks the section-scoped
	 * question and why.
	 */
	additionalPathOverride?: string | null;
	/**
	 * The resolved FILE STEM a `component_image` takes from `properties.image_id`
	 * (PHP component_image::get_id, class.component_image.php:158-219): a SIBLING
	 * component's trimmed value on THIS record (rsc29 → rsc34 'Filename') names the
	 * files instead of the identifier — `photo_2.jpg`, not `rsc29_rsc170_7.jpg`.
	 *
	 * THREE STATES, like {@link additionalPathOverride}:
	 * - a string    → the stem ({@link assertMediaFileStem}-checked again at use);
	 * - `null`      → the component declares no `image_id` (or is not an image),
	 *                 or this record's sibling is empty — the identifier names it;
	 * - ABSENT      → NOT RESOLVED HERE (the section-scoped form). Only the
	 *                 record-scoped `resolveMediaPathOptions` /
	 *                 `completeMediaPathOptions` can answer it.
	 *
	 * NO lang suffix: PHP's image get_id returns the value verbatim, so every
	 * language of a translatable image shares the stem.
	 */
	fileIdOverride?: string | null;
	/**
	 * Media root override — production omits it (config.media.rootPath is used);
	 * write-phase gates pass a scratch root so tests never touch the shared dir
	 * (engineering/MEDIA_SPEC.md §7). When set, confinement is relative to this root.
	 */
	mediaRoot?: string;
}

/** A resolved media file location (all three forms the engine needs). */
export interface MediaLocation {
	/** Media-root-relative directory, leading slash (matches files_info.file_path dirname). */
	relativeDir: string;
	/** Media-root-relative file path, leading slash (the stored files_info.file_path shape). */
	relativePath: string;
	/** Absolute filesystem path, confined inside the media root. */
	absolutePath: string;
}

/**
 * Build the media identifier: `{component_tipo}_{section_tipo}_{section_id}`
 * plus `_{lang}` when the component is translatable (PHP get_id :649-681).
 * This is the CLONE SIGNATURE (PHP get_identifier) — a FILE is named by
 * {@link mediaFileId}, which an image's `properties.image_id` stem overrides.
 * Both tipos pass the identifier gate; section_id must be a positive integer.
 */
export function buildMediaIdentifier(identity: MediaIdentity): string {
	const componentTipo = assertValidTipo(identity.componentTipo, 'media identifier component_tipo');
	const sectionTipo = assertValidTipo(identity.sectionTipo, 'media identifier section_tipo');
	if (!Number.isInteger(identity.sectionId) || identity.sectionId <= 0) {
		throw new DedaloError('media.invalid_identifier', {
			message: `Invalid media section_id '${identity.sectionId}' (must be a positive integer)`,
			coordinates: { section_tipo: sectionTipo, component_tipo: componentTipo },
		});
	}
	let id = `${componentTipo}_${sectionTipo}_${identity.sectionId}`;
	if (identity.lang !== null && identity.lang !== '') {
		// lang is a controlled 'lg-*' code; the gate lives in the section read layer,
		// here we only guard the charset so it can't inject a path separator.
		if (!/^lg-[a-z0-9_]+$/.test(identity.lang)) {
			throw new DedaloError('media.invalid_identifier', {
				message: `Invalid media identifier lang '${identity.lang}'`,
				coordinates: { section_tipo: sectionTipo, component_tipo: componentTipo },
			});
		}
		id += `_${identity.lang}`;
	}
	return id;
}

/**
 * The FILE STEM law for a `properties.image_id` value (T1-10). PHP used the
 * sibling's trimmed value verbatim; the stem becomes a file NAME under the
 * media root and reaches HTML attributes, so the engine refuses — loudly, as
 * `media.invalid_identifier` — what PHP let through:
 *
 * - a path separator (`/`, `\`), NUL or any control character, and the whole
 *   value `.` / `..` — a stem names a file, never a folder;
 * - `"`, `<`, `>` — the T0-10 attribute law (`normalizeAdditionalPath` refuses
 *   the same set for the bucket);
 * - a stem the media-protection grammar (`protection.ts MEDIA_FILENAME_GRAMMAR`)
 *   parses as ANOTHER record's file — with a TIPO-shaped section token (letters
 *   then digits); an all-digit token (a camera default, IMG_20230512_142233) names no record. The web server maps a file to its record
 *   through that grammar alone, so `x_rsc170_5.jpg` written for record 7 would be
 *   published whenever record 5 is — and it is, by name, record 5's file for every
 *   other door. A stem that parses to THIS record (its own identifier included)
 *   is accepted; one that does not parse at all stays login-only by design.
 */
export function assertMediaFileStem(value: string, identity: MediaIdentity): string {
	const why = stemRefusal(value, identity);
	if (why !== null) {
		throw new DedaloError('media.invalid_identifier', {
			message: `image_id file name '${value}' for ${identity.componentTipo} on ${identity.sectionTipo}/${identity.sectionId} ${why}`,
			coordinates: {
				section_tipo: identity.sectionTipo,
				section_id: identity.sectionId,
				component_tipo: identity.componentTipo,
			},
		});
	}
	return value;
}

/**
 * Whether a value is a FILE NAME at all (the first half of the stem law, pure):
 * false for `.`/`..`, a path separator, a control character or the T0-10
 * attribute set. The stem LOCK (media/stem_rules.ts) asks this of a STORED value
 * before looking for files under it — a value that is no file name can have
 * none, and re-asserting it there would stop a curator from REPLACING a bad one.
 */
export function isMediaFileStemName(value: string): boolean {
	return !NOT_A_FILE_STEM.test(value);
}

/** Why a stem is refused (see assertMediaFileStem), or null when it is a file name of THIS record. */
function stemRefusal(value: string, identity: MediaIdentity): string | null {
	if (NOT_A_FILE_STEM.test(value)) {
		return 'is not a file name (empty, a path segment, a control character or one of / \\ " < >)';
	}
	const owner = stemRecord(value);
	if (owner === null) return null;
	const sameRecord =
		owner.sectionTipo === identity.sectionTipo && owner.sectionId === identity.sectionId;
	return sameRecord
		? null
		: `names record ${owner.sectionTipo}/${owner.sectionId}'s files (media-protection grammar)`;
}

/**
 * The record a stem names through the media-protection grammar, or null.
 *
 * The grammar's section part is `[a-z0-9]+`, but only a TIPO-shaped token
 * (letters then digits) can name a record: 'IMG_20230512_142233' (a camera
 * default) or 'inv_1987_23' parse to section '20230512' / '1987', which no
 * section tipo can be — no record's marker exists for them, so the web server
 * publishes nothing by them, and no door reads them as another record's file.
 */
function stemRecord(value: string): { sectionTipo: string; sectionId: number } | null {
	const parsed = MEDIA_FILE_RECORD_GRAMMAR.exec(`${value}.x`);
	const sectionTipo = parsed?.[1] ?? '';
	if (!isValidTipo(sectionTipo)) return null;
	return { sectionTipo, sectionId: Number(parsed?.[2]) };
}

/**
 * What a file stem may not be: empty, `.` or `..`, or carry a separator, NUL or
 * any C0 control / DEL (a control character IS the refusal, hence the lint
 * suppression), or the T0-10 attribute set.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the control range IS the refusal
const NOT_A_FILE_STEM = /^\.{0,2}$|[/\\\u0000-\u001f\u007f"<>]/;

/** The media-protection filename grammar, anchored (see assertMediaFileStem). */
const MEDIA_FILE_RECORD_GRAMMAR = new RegExp(`^${MEDIA_FILENAME_GRAMMAR}`);

/**
 * The FILE STEM a location is named by: the resolved `image_id` stem when the
 * options carry one (re-asserted — options are plain data and may be hand-built),
 * else {@link buildMediaIdentifier}. PHP's `get_id` vs `get_identifier` split:
 * the identifier stays the CLONE SIGNATURE (counter reconcile, the files_info
 * foreign check, log labels, the av fragment/subtitles grammar); only the file
 * grammar asks for this.
 */
export function mediaFileId(identity: MediaIdentity, opts: MediaPathOptions): string {
	const stem = opts.fileIdOverride;
	if (typeof stem === 'string' && stem !== '') return assertMediaFileStem(stem, identity);
	return buildMediaIdentifier(identity);
}

/**
 * The numeric bucket sub-path (PHP get_additional_path :801):
 * `'/' + max * floor(section_id / max)`. Returns '' when max is null/≤0.
 * (PHP operator precedence: the multiplication happens before the string concat.)
 */
export function additionalPath(sectionId: number, maxItemsFolder: number | null): string {
	if (maxItemsFolder === null || !Number.isFinite(maxItemsFolder) || maxItemsFolder <= 0) {
		return '';
	}
	const bucket = maxItemsFolder * Math.floor(sectionId / maxItemsFolder);
	return `/${bucket}`;
}

/**
 * Compute a media location for a given quality + extension.
 * Dir = folder + initial_media_path + '/' + quality + additional_path (relative
 * to the media root). File appends '/' + identifier + '.' + extension.
 */
export function buildMediaLocation(
	spec: MediaTypeSpec,
	identity: MediaIdentity,
	quality: string,
	extension: string,
	opts: MediaPathOptions,
): MediaLocation {
	const safeQuality = assertValidQuality(spec, quality);
	const identifier = mediaFileId(identity, opts);
	const cleanExtension = String(extension).replace(/^\./, '');
	if (!/^[A-Za-z0-9]+$/.test(cleanExtension)) {
		throw new DedaloError('media.invalid_extension', {
			message: `Invalid media extension '${extension}'`,
			coordinates: { model: spec.model },
		});
	}
	const bucket =
		opts.additionalPathOverride != null && opts.additionalPathOverride !== ''
			? opts.additionalPathOverride
			: additionalPath(identity.sectionId, opts.maxItemsFolder);
	// PHP: folder + initial_media_path + '/' + quality + additional_path
	const relativeDir = `${spec.folder}${opts.initialMediaPath}/${safeQuality}${bucket}`;
	const relativePath = `${relativeDir}/${identifier}.${cleanExtension}`;
	const root = requireMediaRoot(opts.mediaRoot);
	const absolutePath = assertInsideMediaRoot(resolve(root, `.${relativePath}`), root);
	return { relativeDir, relativePath, absolutePath };
}

/**
 * The SEGMENT files a media record can carry beside its quality ladder — files
 * that live in a folder of the same grammar but are NOT a quality.
 *
 * `posterframe` is the only one today. It is a closed list because this is the
 * gate that replaces `buildMediaLocation`'s quality check: a segment name reaches
 * the filesystem as a directory, so it may not come from a caller's string.
 */
export type MediaSegment = 'posterframe';
const MEDIA_SEGMENTS: ReadonlySet<string> = new Set<MediaSegment>(['posterframe']);

/**
 * A segment file's location — same grammar as a quality
 * (`{folder}{initial_media_path}/{segment}{bucket}/{id}.{ext}`), with the quality
 * ladder gate replaced by the segment allowlist above.
 *
 * IT LIVES HERE BECAUSE THE GRAMMAR MUST HAVE ONE PRODUCER. Before this, the
 * posterframe path was built in THREE places: a private helper in
 * tools/posterframe.ts (which also wrote the av/3d THUMB through it, so one file
 * was written by an ungated builder and read back by the gated one), and an inline
 * template string in component_emit.ts that ignored `additionalPathOverride`
 * entirely. They agreed character-for-character only by luck, and nothing
 * mechanical held them together — `media_thumb_census_tripwire.test.ts` now does, against
 * this function.
 */
export function buildMediaSegmentLocation(
	spec: MediaTypeSpec,
	identity: MediaIdentity,
	segment: MediaSegment,
	extension: string,
	opts: MediaPathOptions,
): MediaLocation {
	if (!MEDIA_SEGMENTS.has(segment)) {
		throw new DedaloError('media.invalid_identifier', {
			message: `Invalid media segment '${segment}' for ${spec.model}`,
			coordinates: { model: spec.model },
		});
	}
	const identifier = mediaFileId(identity, opts);
	const cleanExtension = String(extension).replace(/^\./, '');
	if (!/^[A-Za-z0-9]+$/.test(cleanExtension)) {
		throw new DedaloError('media.invalid_extension', {
			message: `Invalid media extension '${extension}'`,
			coordinates: { model: spec.model },
		});
	}
	const bucket =
		opts.additionalPathOverride != null && opts.additionalPathOverride !== ''
			? opts.additionalPathOverride
			: additionalPath(identity.sectionId, opts.maxItemsFolder);
	const relativeDir = `${spec.folder}${opts.initialMediaPath}/${segment}${bucket}`;
	const relativePath = `${relativeDir}/${identifier}.${cleanExtension}`;
	const root = requireMediaRoot(opts.mediaRoot);
	const absolutePath = assertInsideMediaRoot(resolve(root, `.${relativePath}`), root);
	return { relativeDir, relativePath, absolutePath };
}

/**
 * The posterframe's location for the models that carry one, else null — the ONE
 * resolver for both the file (tools/posterframe.ts) and the URL the client is
 * given (component_emit.ts). PURE: it does not stat the file; a caller that needs
 * "renderable now" tests `absolutePath` itself, exactly as `mediaThumbLocation`
 * documents for the thumb.
 */
export function posterframeLocation(
	spec: MediaTypeSpec,
	identity: MediaIdentity,
	opts: MediaPathOptions,
): MediaLocation | null {
	if (!hasPosterframe(spec.model)) return null;
	return buildMediaSegmentLocation(
		spec,
		identity,
		'posterframe',
		config.media.avExtras.posterframeExtension,
		opts,
	);
}

/**
 * The absolute media root: an explicit override (scratch/test) or the configured
 * MEDIA_PATH. Throws when neither is set (production must configure it).
 *
 * THE ONE ROOT RESOLVER, and therefore the place the test-media guard sits: every
 * media path in the engine — quality files, segments, subtitles, the staging tree,
 * `deleted/`, the thumb — is built on the value this returns, so a root that has
 * not declared itself disposable is refused here rather than at the ~40 write call
 * sites downstream. Inert unless DEDALO_TEST_MEDIA_ROOT is set
 * (src/core/media/test_media_root.ts).
 */
export function requireMediaRoot(override?: string): string {
	const root = override ?? config.media.rootPath;
	if (root === null || root === undefined || root === '') {
		throw new DedaloError('media.not_configured', {
			message: 'MEDIA_PATH is not configured (config.media.rootPath is null)',
		});
	}
	return assertTestMediaRoot(resolve(root), 'requireMediaRoot');
}

/**
 * THE traversal chokepoint: confirm an absolute path resolves INSIDE the media
 * root and return it normalized. Throws on escape. Every filesystem touch in
 * the media subsystem passes through here (stronger than PHP's per-call-site
 * realpath checks — one gate, no bypass). `mediaRoot` overrides the configured
 * root for scratch/test roots.
 */
export function assertInsideMediaRoot(absolutePath: string, mediaRoot?: string): string {
	const root = requireMediaRoot(mediaRoot);
	const normalized = resolve(absolutePath);
	if (normalized !== root && !normalized.startsWith(root + sep)) {
		// Disclosure `operator`: the wire says only "Invalid media path" — the
		// resolved path stays in the log, where a traversal attempt belongs.
		throw new DedaloError('media.invalid_path', {
			message: 'Media path escapes the media root (traversal blocked)',
			coordinates: { path: normalized },
		});
	}
	return normalized;
}

/**
 * Turn a media-root-relative path (as stored in files_info.file_path, leading
 * slash) into a confined absolute path. Used by the scanner / file ops when
 * they must touch a stored file.
 */
export function absoluteFromRelative(relativePath: string, mediaRoot?: string): string {
	const root = requireMediaRoot(mediaRoot);
	return assertInsideMediaRoot(resolve(root, `.${relativePath}`), root);
}

// ---------------------------------------------------------------------------
// Subtitles grammar (PHP component_av::get_subtitles_path/:619 get_subtitles_url/:644)
// ---------------------------------------------------------------------------

/**
 * Media-root-relative subtitles path (leading slash):
 * `folder + DEDALO_SUBTITLES_FOLDER + '/' + identifier + '_' + lang + '.' + ext`.
 * PHP defines the subtitles grammar on component_av only, so the folder is the
 * AV media folder regardless of identity.componentTipo's own type. The lang is
 * an EXPLICIT suffix (AV identities carry lang:null — the component is not
 * translatable; the subtitle FILE is per-language). SINGLE SOURCE: the tool
 * writer (tool_transcription build_subtitles_file) and the component emitter
 * (component_emit.ts item.subtitles) both build through here — no drift.
 */
export function subtitlesRelativePath(identity: MediaIdentity, lang: string): string {
	const spec = mediaTypeOf('component_av');
	if (spec === null) throw new Error('component_av media spec is not registered');
	if (!/^lg-[a-z0-9_]+$/.test(lang)) {
		throw new DedaloError('media.invalid_identifier', {
			message: `Invalid subtitles lang '${lang}'`,
		});
	}
	const identifier = buildMediaIdentifier(identity);
	const { subtitlesFolder, subtitlesExtension } = config.media.avExtras;
	return `${spec.folder}${subtitlesFolder}/${identifier}_${lang}.${subtitlesExtension}`;
}

/** Absolute subtitles file path, confined inside the media root (PHP get_subtitles_path). */
export function subtitlesPath(identity: MediaIdentity, lang: string, mediaRoot?: string): string {
	return absoluteFromRelative(subtitlesRelativePath(identity, lang), mediaRoot);
}

/**
 * Public subtitles URL (PHP get_subtitles_url — DEDALO_MEDIA_URL root):
 * the media web base + the relative path. Matches the shape the AV player's
 * <track> consumes (component_emit.ts item.subtitles.subtitles_url).
 */
export function subtitlesUrl(identity: MediaIdentity, lang: string): string {
	return `${config.media.webBase}${subtitlesRelativePath(identity, lang)}`;
}

/**
 * Public URL of a record's THUMB derivative, or null when the media type has no
 * thumb tier. The media subsystem owns this grammar so callers outside it (the
 * RAG image index, which stores the URL alongside a vector) never assemble a
 * media URL by hand.
 *
 * PURE — it does not stat the file. A thumb that has not been generated yet
 * still yields a URL, so a caller that needs "renderable now" must check
 * existence itself (`buildMediaLocation(...).absolutePath`). Reading it back is
 * subject to the normal media access rules: the thumb tier is public-listed, so
 * an anonymous reader still needs the record's publication marker, and everyone
 * else needs the media auth cookie.
 */
export function mediaThumbUrl(
	spec: MediaTypeSpec,
	identity: MediaIdentity,
	options: MediaPathOptions,
): string | null {
	const location = mediaThumbLocation(spec, identity, options);
	return location === null ? null : `${config.media.webBase}${location.relativePath}`;
}

/**
 * The thumb derivative's location (null when the media type has no thumb tier).
 * Split out of {@link mediaThumbUrl} so a caller that needs BOTH the URL and
 * "does it exist yet" resolves the path once, and neither of them names the
 * thumb quality or extension itself.
 */
export function mediaThumbLocation(
	spec: MediaTypeSpec,
	identity: MediaIdentity,
	options: MediaPathOptions,
): MediaLocation | null {
	if (!spec.hasThumb) return null;
	return buildMediaLocation(
		spec,
		identity,
		config.media.thumb.quality,
		config.media.thumb.extension,
		options,
	);
}
