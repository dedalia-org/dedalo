/**
 * MEDIA contract — the ONE typed accessor over the media catalog.
 *
 * Dédalo has five media component models (image, av, pdf, svg, 3d). Each is
 * defined by a TYPE catalog — quality ladder, default/original quality,
 * extensions, thumbnail dims — that PHP holds as `DEDALO_*` config constants
 * (core/base/config/catalog/domains/media_*.php) and this rewrite holds in the
 * env-based config (engineering/MEDIA_SPEC.md §3). This module resolves a model name
 * to its `MediaTypeSpec` and provides the pure predicates the engine relies on
 * (quality validation, pixel-area budget). It hardcodes NOTHING — every value
 * comes from `config.media`; the scattered LIST_QUALITIES/environment literals
 * this replaces were the named §1 defect.
 *
 * PHP references: component_media_common::get_media_components() (:309),
 * sanitize_quality() (:2830, SEC-065), component_image pixel law (:1850-1899).
 */

import { config, type MediaTypeConfig } from '../../config/config.ts';
import { DedaloError } from '../errors/dedalo_error.ts';

/** The five media component model names (PHP get_media_components, sorted). */
export type MediaModel =
	| 'component_3d'
	| 'component_av'
	| 'component_image'
	| 'component_pdf'
	| 'component_svg';

/** The type-folder label (first path segment under the media root, no slash). */
export type MediaTypeFolder = 'image' | 'av' | 'pdf' | 'svg' | '3d';

/**
 * The resolved catalog for one media model — everything the path builder,
 * files_info scanner, and processors need. Built from `config.media`.
 */
export interface MediaTypeSpec {
	readonly model: MediaModel;
	/** First path segment under the media root, WITHOUT leading slash ('image', 'av', …). */
	readonly typeFolder: MediaTypeFolder;
	/** The raw config folder value WITH leading slash (DEDALO_*_FOLDER, e.g. '/image') — used verbatim in paths. */
	readonly folder: string;
	/** Full ordered quality ladder, high→low. */
	readonly qualities: readonly string[];
	/** Default web-delivery quality. */
	readonly defaultQuality: string;
	/** Original (source-of-truth) quality — never mutated in place (Original law). */
	readonly originalQuality: string;
	/**
	 * The MASTER tiers: the ones that hold RAW uploads and act as derivative
	 * SOURCES, in PRECEDENCE ORDER, highest first.
	 *
	 * Dédalo's domain has TWO masters for images, not one (v6
	 * component_image::get_image_source / get_normalized_ar_quality, frozen PHP
	 * class.component_image.php:1569 + :296):
	 *  - the ORIGINAL is the camera/scanner shot, stored AS IS, never mutated;
	 *  - the RETOUCHED tier (DEDALO_IMAGE_QUALITY_RETOUCHED, canonically
	 *    'modified') is the HUMAN-RETOUCHED master — colour-corrected, cropped,
	 *    background removed. It is a SECOND MASTER, not a derivative: it is
	 *    stored full-size and losslessly, in whatever format the upload
	 *    allowlist admits (.tif / .psd), and it OUTRANKS the original as the
	 *    source every other tier is built from, for as long as it exists.
	 *
	 * Every other model has one master (its `originalQuality`); no ladder but
	 * the image one has a retouched tier at all.
	 *
	 * Derived from config, never from the literal 'modified': installs rename
	 * these tiers, which is why protection.ts:316 forbids hardcoding them.
	 *
	 * NOT the same idea as `protection.ts masterQualities()`: that is a
	 * cross-model SECURITY set (it also carries the literal names as a belt, so
	 * a renamed tier can never be configured web-public). This is the per-type
	 * PRECEDENCE list the processing layer resolves sources through.
	 */
	readonly masterQualities: readonly string[];
	/** Normalized default extension the type converts to. */
	readonly defaultExtension: string;
	/** Upload allowlist. */
	readonly allowedExtensions: readonly string[];
	/**
	 * The alternate TWIN extensions this type really builds — already FILTERED to
	 * what a writer exists for (see ALTERNATE_BUILDER_BY_MODEL); whatever the
	 * config named for a model with no writer is in `refusedAlternateExtensions`
	 * instead, never here.
	 *
	 * WHAT A TWIN IS (2026-08-07, the builder that closes "config read, never
	 * honoured"): a per-tier COMPANION of that tier's normalized file — the same
	 * picture, same tier, other container. NOT "every quality with every format":
	 *
	 *  - a DERIVED tier that has its `.<defaultExtension>` file gets one twin per
	 *    extension listed here, built FROM THE MASTER (never transcoded from the
	 *    sibling jpg, which is already flattened onto white);
	 *  - a derived tier with no such file gets none, and any twin found there is
	 *    RETIRED — `exists(Q/<id>.E) ⇒ exists(Q/<id>.jpg)` for every derived Q,
	 *    the one direction the engine holds at ALL times (a twin may legitimately
	 *    be absent; a twin without its companion is always wrong);
	 *  - MASTER tiers never (a machine-authored file parked in a master tier
	 *    becomes resolvable AS the master — resolveMaster walks allowedExtensions);
	 *  - the THUMB tier never (files_info scans thumb with the thumb extension
	 *    alone, so a twin there would be permanently unindexable).
	 */
	readonly alternateExtensions: readonly string[];
	/**
	 * The configured alternate extensions this type CANNOT build, kept rather than
	 * dropped so the refusal is VISIBLE (boot log) instead of silent. Non-empty
	 * only for the models in NO_ALTERNATE_BUILDER_REASON.
	 */
	readonly refusedAlternateExtensions: readonly string[];
	/** The config key both lists come from, so a refusal can name what to edit. */
	readonly alternateExtensionsConfigKey: string;
	/**
	 * Extensions of the COVER files this type builds into its default quality
	 * from a source it cannot itself display — today only pdf, whose first page is
	 * rasterized to `<defaultQuality>/<id>.jpg` (+ every alternate).
	 *
	 * SCANNED UNCONDITIONALLY by files_info: the jpg cover is built whether or not
	 * the config lists it, so deriving the scan list from the config alone would
	 * let an operator who empties DEDALO_PDF_ALTERNATIVE_EXTENSIONS un-index every
	 * cover already on disk — the file keeps existing and the record stops seeing
	 * it. Empty for every other type.
	 */
	readonly coverExtensions: readonly string[];
	/**
	 * EVERY extension a file of this type may legitimately carry on disk — what the
	 * engine must SEE, COPY and SOFT-DELETE, as opposed to `alternateExtensions`,
	 * which is what it BUILDS. Default extension FIRST (the order is load-bearing —
	 * see files_info.ts), then the upload allowlist, the built twins, the covers,
	 * and finally the configured-but-refused ones.
	 *
	 * THE TWO LISTS ARE DIFFERENT QUESTIONS AND CONFLATING THEM LOSES FILES.
	 * Measured, before this field existed:
	 *
	 *  - `duplicateMediaFiles` enumerated `[default, allowed, alternates]`, so a pdf
	 *    whose `DEDALO_PDF_ALTERNATIVE_EXTENSIONS` an operator had emptied lost its
	 *    jpg COVER on every duplicate_record — the cover is built whether or not the
	 *    key lists it, and it is the only visual a pdf record has in a list view;
	 *  - narrowing `alternateExtensions` at construction (the D5 capability filter)
	 *    additionally made a REFUSED extension invisible: with
	 *    `DEDALO_AV_ALTERNATIVE_EXTENSIONS=["ogg"]` a legacy `404/<id>.ogg` on disk
	 *    was no longer scanned into files_info, no longer copied by duplicate_record
	 *    and no longer moved by delete_quality — it stayed on disk, unreferenced,
	 *    forever. Refusing to BUILD a format is right; refusing to SEE the files
	 *    that already exist is data loss by omission.
	 *
	 * A file the engine will not build is still a file the engine must not lose.
	 */
	readonly managedExtensions: readonly string[];
	/**
	 * The qualities projected into list-mode reads (replaces the old hardcoded
	 * media_list_value LIST_QUALITIES — now covers av/3d too). Default quality +
	 * thumb where the type has one.
	 */
	readonly listQualities: readonly string[];
	/**
	 * Whether this type builds a thumbnail. ALL FIVE do — see THUMB_IS_UNIVERSAL
	 * for why the field survives an all-true census.
	 */
	readonly hasThumb: boolean;
}

/** Model → its config block + folder label (the only place the mapping lives). */
const MODEL_TO_TYPE: Readonly<
	Record<
		MediaModel,
		{
			readonly folder: MediaTypeFolder;
			readonly cfg: () => MediaTypeConfig;
			/** The env key `cfg.alternateExtensions` is read from (config.ts readList). */
			readonly alternateKey: string;
		}
	>
> = {
	component_image: {
		folder: 'image',
		cfg: () => config.media.image,
		alternateKey: 'DEDALO_IMAGE_ALTERNATIVE_EXTENSIONS',
	},
	component_av: {
		folder: 'av',
		cfg: () => config.media.av,
		alternateKey: 'DEDALO_AV_ALTERNATIVE_EXTENSIONS',
	},
	component_pdf: {
		folder: 'pdf',
		cfg: () => config.media.pdf,
		alternateKey: 'DEDALO_PDF_ALTERNATIVE_EXTENSIONS',
	},
	component_svg: {
		folder: 'svg',
		cfg: () => config.media.svg,
		alternateKey: 'DEDALO_SVG_ALTERNATIVE_EXTENSIONS',
	},
	component_3d: {
		folder: '3d',
		cfg: () => config.media.threeD,
		alternateKey: 'DEDALO_3D_ALTERNATIVE_EXTENSIONS',
	},
};

/**
 * THE ALTERNATE-TWIN CAPABILITY CENSUS — every media model, stated once.
 *
 * The value is the WRITER that builds this model's alternate extensions, or null
 * when there is none. A model with no writer must never advertise the key:
 * `DEDALO_*_ALTERNATIVE_EXTENSIONS` was read by seven modules and written by
 * none, so the engine scanned for, indexed and offered files nothing could ever
 * produce. Filtering here makes every existing consumer correct with no edit of
 * its own, and the refusal stays visible in `refusedAlternateExtensions`.
 *
 * ADDING A BUILDER = moving a model from NO_ALTERNATE_BUILDER_REASON to here.
 * The two maps are exact complements, and the media_alternate_versions tripwire
 * is what holds them to it.
 */
export const ALTERNATE_BUILDER_BY_MODEL: Readonly<Record<MediaModel, string | null>> = {
	component_image: 'buildAlternateVersions (core/media/processing.ts)',
	component_pdf: 'buildPdfCovers (core/media/processing.ts)',
	component_av: null,
	component_svg: null,
	component_3d: null,
};

/**
 * Why the models above have no alternate builder — the OPERATOR-facing half of
 * the census (this text reaches the boot log next to the key and its value).
 * Each reason names the code that would have to change.
 */
export const NO_ALTERNATE_BUILDER_REASON: Readonly<Record<MediaModel, string | null>> = {
	component_image: null,
	component_pdf: null,
	component_av:
		'every ffmpeg profile in core/media/engine/ffmpeg_profiles.ts forces the same container and codec (force: "mp4", videoCodec: "libx264"), and a profile is chosen by getFfmpegProfile(settingName), whose names carry only resolution/standard/aspect — there is no container axis to build a second format on',
	component_svg:
		'an svg derivative is a BYTE COPY of the master (regenerateSvg → copyToQuality in core/media/processing.ts): there is no encoder here to point at another extension',
	component_3d:
		'the 3d derivative is likewise a naive copy (regenerate3d in core/media/processing.ts) because the format converters are ledgered PHP-dead — nothing in this engine can transcode a mesh',
};

/**
 * WHICH MASTER FILES MAY BE A DERIVATIVE SOURCE — the census `resolveMaster`
 * (core/media/processing.ts) filters its walk through.
 *
 *  - `any_upload`: every allowlisted raw is something this type's builders can
 *    read (ImageMagick a tif/psd, ffmpeg a mov, the svg/3d byte copies).
 *  - `default_extension`: ONLY the type's default format is. component_pdf's
 *    original tier holds the AUTHORED document (`.doc`, `.odt`, `.pages`…) side by
 *    side with its PDF RENDITION — the v6 coexistence law the owner kept on
 *    2026-11-11 (frozen component_pdf::rename_old_files :663, v6 :570) — and every
 *    pdf builder (web byte copy, page-1 thumb, covers, transcription) reads PDF
 *    only. Walking the allowlist here copied `.doc` bytes into `web/<id>.pdf`.
 *    An original with no PDF beside it has NO derivative source: the record shows
 *    no web copy, honestly, and the ingest says why.
 */
export const DERIVATIVE_SOURCE_BY_MODEL: Readonly<
	Record<MediaModel, 'any_upload' | 'default_extension'>
> = {
	component_image: 'any_upload',
	component_av: 'any_upload',
	component_pdf: 'default_extension',
	component_svg: 'any_upload',
	component_3d: 'any_upload',
};

/** True when a master file of `extension` may feed this type's derivative builders. */
export function isDerivativeSourceExtension(spec: MediaTypeSpec, extension: string): boolean {
	return (
		DERIVATIVE_SOURCE_BY_MODEL[spec.model] === 'any_upload' ||
		extension.toLowerCase() === spec.defaultExtension.toLowerCase()
	);
}

/** The thumb quality name from config (shared across types). */
export function thumbQuality(): string {
	return config.media.thumb.quality;
}

/**
 * WHERE A MODEL'S THUMB COMES FROM — the census every thumb trigger dispatches
 * on, so that "when is a thumbnail (re)built" has ONE answer per model instead of
 * one per call site.
 *
 *  - `default_tier`: the record's own delivered file (default quality, falling
 *    back to the master). image, pdf and svg differ only in the RECIPE that turns
 *    it into a raster — plain resize, page-1 rasterization, librsvg render — and
 *    that recipe lives in ONE place (processing.ts buildThumbVersion).
 *  - `posterframe`: a still picture stored beside the qualities, because the
 *    record's own file is not an image at all (a video, a mesh). See
 *    POSTERFRAME_WRITER_BY_MODEL for who produces it.
 *
 * The distinction is not cosmetic: it decides what INVALIDATES a thumb. A
 * `default_tier` thumb is stale when the delivered file changes; a `posterframe`
 * thumb is stale when the POSTERFRAME changes, and survives a master it no longer
 * depicts unless something retires it.
 */
export const THUMB_SOURCE_BY_MODEL: Readonly<Record<MediaModel, 'default_tier' | 'posterframe'>> = {
	component_image: 'default_tier',
	component_pdf: 'default_tier',
	component_svg: 'default_tier',
	component_av: 'posterframe',
	component_3d: 'posterframe',
};

/**
 * WHO WRITES THE POSTERFRAME — the one irreducible difference between the two
 * posterframe models, stated as a fact rather than discovered as a branch.
 *
 *  - `server_frame_extract`: the engine can mint one unaided (ffmpeg pulls a
 *    frame). PHP did exactly this on demand — `component_av::create_thumb`
 *    (frozen class.component_av.php:560) auto-generates a posterframe at t=10
 *    whenever one is missing and only then gives up — so an av thumb is never
 *    blocked on an operator.
 *  - `client_capture`: only a browser can produce it (a mesh must be RENDERED,
 *    and this engine has no renderer). The thumb of such a model is therefore the
 *    one thing the server cannot self-heal, which is why the refusal has to name
 *    the gear that can.
 *  - `null`: the model has no posterframe at all.
 */
export const POSTERFRAME_WRITER_BY_MODEL: Readonly<
	Record<MediaModel, 'server_frame_extract' | 'client_capture' | null>
> = {
	component_image: null,
	component_pdf: null,
	component_svg: null,
	component_av: 'server_frame_extract',
	component_3d: 'client_capture',
};

/**
 * How an operator gets a posterframe the ENGINE cannot mint — the operator-facing
 * half of the census above, and the text every refusal ends with. Non-null
 * exactly for the `client_capture` models (the tripwire holds the two maps to it).
 */
export const CLIENT_POSTERFRAME_REMEDY: Readonly<Record<MediaModel, string | null>> = {
	component_image: null,
	component_pdf: null,
	component_svg: null,
	component_av: null,
	component_3d:
		"open the record's 3D viewer and use the media-versions panel's thumb gear: it renders the live scene to a canvas and uploads that as the posterframe (there is no server-side mesh renderer in this engine)",
};

/**
 * THE POSTERFRAME MODELS — the models whose THUMB IS A PICTURE OF THEIR
 * POSTERFRAME, and never a derivative of the media file itself. DERIVED from
 * THUMB_SOURCE_BY_MODEL: one census, not two lists to keep in step.
 *
 * The posterframe is not a quality: it lives in its own `posterframe` sub-folder
 * beside the quality dirs (`{folder}{initial}/posterframe{bucket}/{id}.jpg`), is
 * never scanned into files_info, and reaches the client as `posterframe_url`
 * (media/component_emit.ts). The THUMB tier is the resize of it — which is what
 * `DEDALO_QUALITY_THUMB` documents in so many words: "AV | Will render the
 * posterframe", "3d | Will render the posterframe" (config/catalog/media.ts).
 *
 * IT IS A CENSUS BECAUSE THE THUMB BUILDER HAS TO BRANCH ON IT. Neither model's
 * own file can be handed to ImageMagick: an mp4 would put a video in the thumb
 * tier, and a mesh has no decode delegate at all. MEASURED on the shipped code,
 * the media-versions panel's thumb gear on a .glb answered `identify: no decode
 * delegate for this image format .../3d/web/0/test26_test3_207.glb` — the generic
 * image branch had fed the model file to the raster thumbnailer.
 *
 * The two models differ ONLY in who writes the posterframe: ffmpeg extracts the
 * av one from a frame (createAvPosterframe), while a 3d posterframe can only be
 * a snapshot of a RENDERED scene — this engine has no mesh renderer, so the
 * browser's WebGL canvas captures it and uploads it (component_3d.js
 * create_posterframe → dd_component_3d_api::move_file_to_dir).
 */
export const POSTERFRAME_MODELS: ReadonlySet<MediaModel> = new Set<MediaModel>(
	(Object.keys(THUMB_SOURCE_BY_MODEL) as MediaModel[]).filter(
		(model) => THUMB_SOURCE_BY_MODEL[model] === 'posterframe',
	),
);

/** Whether this model's thumb is built from its posterframe (see POSTERFRAME_MODELS). */
export function hasPosterframe(model: MediaModel): boolean {
	return POSTERFRAME_MODELS.has(model);
}

/**
 * List qualities per type: `[default_quality, thumb_quality]` — THE SAME PAIR FOR
 * EVERY TYPE, because that is what the projection law says.
 *
 * PHP `component_media_common::get_list_value` builds
 * `$ar_quality_to_include = [get_default_quality(), get_thumb_quality()]`
 * (frozen class.component_media_common.php:1554) with no per-type branch at all.
 * The per-type switch this replaces carried one exception — svg returned the
 * default alone — which was the same missing-thumb assumption `hasThumb` carried
 * (see THUMB_IS_UNIVERSAL), not a projection rule.
 *
 * ADDING THE THUMB EMITS NOTHING BY ITSELF: `media_list_value.ts` drops any
 * quality with no existing file, so a record gains a thumb entry exactly when a
 * thumb file appears on disk — which is what PHP did too. It restores parity
 * rather than diverging: the divergence was TS refusing to project a tier PHP
 * always projected.
 */
function listQualitiesFor(_folder: MediaTypeFolder, cfg: MediaTypeConfig): string[] {
	return [cfg.defaultQuality, config.media.thumb.quality];
}

/**
 * EVERY media type builds a thumbnail — the census, stated once.
 *
 * The thumb is NOT part of a type's configured ladder for most of them: it is
 * appended beyond it (files_info.ts, PHP get_files_info :1347), which is why
 * `hasThumb` exists as a field of its own rather than as `qualities.includes`.
 * The value is a CONSTANT rather than a per-type predicate because there is no
 * longer a type that lacks one, and a `folder => boolean` function whose body is
 * `true` invites someone to "restore" an exception without the evidence below.
 *
 * SVG WAS THE EXCEPTION AND THAT WAS A REWRITE GAP (fixed 2026-08-08). PHP built
 * one: `component_svg::create_thumb` (frozen class.component_svg.php:353)
 * rasterizes the default-quality file into the thumb path, and its own
 * `get_ar_quality` says so — "the 'thumb' raster quality is handled separately by
 * the base class and does not appear in this list". Everything downstream still
 * assumed it: `MEDIA_SPEC §4.4`, the fixture corpus (§11 "svg fixture | web raster
 * thumb"), `buildVersionCore`'s own comment about "the component_pdf /
 * component_svg thumb gears", and the client's list view, which PREFERS the thumb
 * jpg over re-rendering the vector (view_default_list_svg.js:145). With the flag
 * false, `assertValidQuality` refused the tier before any of that could run, so
 * the media-versions panel's thumb gear answered "Unknown media quality 'thumb'
 * for component_svg (not in ladder [original, web])" — MEASURED, on every SVG
 * record. The renderer it needs is `engine/svg.ts` (librsvg, NOT ImageMagick).
 */
const THUMB_IS_UNIVERSAL = true;

/**
 * The canonical name of the retouched tier — the BELT, never the primary read.
 * See masterQualitiesFor for why a literal appears here at all.
 */
const CANONICAL_RETOUCHED_TIER = 'modified';

/**
 * The master tiers of one type, HIGHEST PRECEDENCE FIRST — see
 * MediaTypeSpec.masterQualities for what a master IS.
 *
 * Only component_image has a second master (the retouched tier), and only when
 * this install actually put it in the ladder: `DEDALO_IMAGE_QUALITY_RETOUCHED`
 * always has a value ('modified' by default), but an install is free to drop
 * that tier from `DEDALO_IMAGE_AR_QUALITY`. A master that is not in the ladder
 * cannot be uploaded into (assertIngestableQuality refuses it) and is never
 * scanned into files_info (files_info.ts appendNormalizedTwin bails on exactly
 * this test), so treating it as a source would resolve files nothing can ever
 * put there.
 *
 * THE CANONICAL LITERAL RIDES ALONG AS A BELT, exactly as
 * protection.ts masterQualities() carries 'original'/'modified' beside the
 * configured names, and for the same class of reason. The two keys are
 * INDEPENDENT (`DEDALO_IMAGE_QUALITY_RETOUCHED` and `DEDALO_IMAGE_AR_QUALITY`),
 * `../private/.env` is append-only and nothing ties them, so an install that
 * empties or renames the first while the ladder still carries 'modified' would
 * — with a config-only read — reclassify a tier full of HUMAN-AUTHORED masters
 * as a plain derivative: regenerateImage would then overwrite it on the next
 * upload. A tier named 'modified' is never a derivative on any install, so the
 * belt costs nothing and closes that. MEASURED before the belt: the retouch's
 * centre pixel went blue → red (the original) on one ingest.
 *
 * The CONFIGURED name still comes first: precedence is config's to decide, the
 * literal only guarantees the tier is never treated as overwritable.
 */
function masterQualitiesFor(folder: MediaTypeFolder, cfg: MediaTypeConfig): string[] {
	if (folder !== 'image') return [cfg.originalQuality];
	const masters: string[] = [];
	for (const candidate of [config.media.imageQualityRetouched, CANONICAL_RETOUCHED_TIER]) {
		if (candidate === '' || candidate === cfg.originalQuality) continue;
		if (!cfg.qualities.includes(candidate)) continue;
		if (masters.includes(candidate)) continue;
		masters.push(candidate);
	}
	masters.push(cfg.originalQuality);
	return masters;
}

/**
 * The pdf COVER extension: the first page rasterized into the default quality
 * (core/media/processing.ts buildPdfCovers). It is a LITERAL, not a config
 * value — a pdf's default extension is `pdf` (the stored document), so the type
 * has no configured extension for the picture of it, and the cover has been jpg
 * since v6 (create_alternative_version). Alternates are built BESIDE it, never
 * instead of it.
 */
export const PDF_COVER_EXTENSION = 'jpg';

/**
 * The ONE derivative of a type that is built unconditionally, whatever the
 * config says — so nothing may make it conditional on a probe or a list.
 *
 * For pdf it is the jpg cover (v6 create_alternative_version has built one since
 * before the key existed, and it is the only visual a pdf record has in a list
 * view). For every other type the type's own `defaultExtension` plays that role
 * and is never routed through the alternate machinery at all.
 */
export function canonicalCoverExtension(spec: MediaTypeSpec): string | null {
	return spec.typeFolder === 'pdf' ? PDF_COVER_EXTENSION : null;
}

/** Lowercase + de-duplicate, first-seen order kept (the twin of files_info's). */
function uniqueLower(values: readonly string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const value of values) {
		const lower = value.toLowerCase();
		if (!seen.has(lower)) {
			seen.add(lower);
			out.push(lower);
		}
	}
	return out;
}

/** The cover extensions of a type: pdf builds one, nothing else does. */
function coverExtensionsFor(folder: MediaTypeFolder, alternates: readonly string[]): string[] {
	if (folder !== 'pdf') return [];
	return uniqueLower([PDF_COVER_EXTENSION, ...alternates]);
}

const specCache = new Map<MediaModel, MediaTypeSpec>();

/**
 * Resolve a model name to its `MediaTypeSpec`, or null when it is not a media
 * model. Cached (config is frozen at boot). PHP get_media_components membership.
 */
export function mediaTypeOf(model: string): MediaTypeSpec | null {
	const entry = MODEL_TO_TYPE[model as MediaModel];
	if (entry === undefined) return null;
	const cached = specCache.get(model as MediaModel);
	if (cached !== undefined) return cached;
	const cfg = entry.cfg();
	// NARROW THE SPEC AT CONSTRUCTION, and keep what was dropped: a model with no
	// writer (ALTERNATE_BUILDER_BY_MODEL) must not advertise extensions the engine
	// can never produce — scanners, the upload allowlist message and
	// `features.alternative_extensions` all read this list and would otherwise
	// describe files that cannot exist. The refusal is not silent: it is carried
	// in refusedAlternateExtensions and named in the boot log with its config key.
	const configuredAlternates = uniqueLower(cfg.alternateExtensions);
	const hasBuilder = ALTERNATE_BUILDER_BY_MODEL[model as MediaModel] !== null;
	const alternateExtensions = hasBuilder ? configuredAlternates : [];
	const spec: MediaTypeSpec = Object.freeze({
		model: model as MediaModel,
		typeFolder: entry.folder,
		folder: cfg.folder,
		qualities: cfg.qualities,
		defaultQuality: cfg.defaultQuality,
		originalQuality: cfg.originalQuality,
		masterQualities: Object.freeze(masterQualitiesFor(entry.folder, cfg)),
		defaultExtension: cfg.extension,
		allowedExtensions: cfg.allowedExtensions,
		alternateExtensions: Object.freeze(alternateExtensions),
		refusedAlternateExtensions: Object.freeze(hasBuilder ? [] : configuredAlternates),
		alternateExtensionsConfigKey: entry.alternateKey,
		coverExtensions: Object.freeze(coverExtensionsFor(entry.folder, alternateExtensions)),
		// EVERY extension that may exist on disk, default first (see the field).
		// The REFUSED ones are in here on purpose: the engine will not build them,
		// and must still see, copy and soft-delete the ones an install already has.
		managedExtensions: Object.freeze(
			uniqueLower([
				cfg.extension,
				...cfg.allowedExtensions,
				...alternateExtensions,
				...coverExtensionsFor(entry.folder, alternateExtensions),
				...(hasBuilder ? [] : configuredAlternates),
			]),
		),
		listQualities: Object.freeze(listQualitiesFor(entry.folder, cfg)),
		hasThumb: THUMB_IS_UNIVERSAL,
	});
	specCache.set(model as MediaModel, spec);
	return spec;
}

/** Whether `model` is one of the five media models. */
export function isMediaModel(model: string): boolean {
	return model in MODEL_TO_TYPE;
}

/** SEC-065 charset: quality dir names allow only [A-Za-z0-9_\-.]. */
const QUALITY_CHARSET = /^[A-Za-z0-9_\-.]+$/;

/**
 * The transcription-only av derivative quality (16 kHz mono WAV). Off-ladder:
 * built on demand by tool_transcription, never listed by get_files_info. Kept as
 * a named constant so the tool and the quality gate agree on the exact literal.
 */
export const AUDIO_TR_QUALITY = 'audio_tr';

/**
 * Validate a client-or-computed quality string. STRONGER than PHP's
 * sanitize_quality (SEC-065): PHP only checks the charset and silently falls
 * back to the original quality; we require the charset AND membership in the
 * type's ladder, and throw loudly on violation (fail-closed — a bad quality
 * must never reach a filesystem path). Returns the quality unchanged on pass.
 */
export function assertValidQuality(spec: MediaTypeSpec, quality: unknown): string {
	// The rejected value is RAW caller data, so it stays in the log-only
	// `message`/`coordinates`; the wire gets the registry's English (ERRORS_SPEC §2.2).
	if (typeof quality !== 'string' || quality === '') {
		throw new DedaloError('media.invalid_quality', {
			message: `Invalid media quality (empty) for ${spec.model}`,
			coordinates: { model: spec.model },
		});
	}
	if (quality === '.' || quality === '..' || !QUALITY_CHARSET.test(quality)) {
		throw new DedaloError('media.invalid_quality', {
			message: `Invalid media quality '${quality}' for ${spec.model} (charset)`,
			coordinates: { model: spec.model },
		});
	}
	// The thumb tier is a valid quality dir for the types that build one, even
	// though it is appended beyond the base ladder (PHP get_files_info :1347).
	const isThumb = spec.hasThumb && quality === config.media.thumb.quality;
	// audio_tr is the transcription-only 16 kHz mono WAV derivative (PHP
	// tool_transcription build_version('audio_tr')): a real av quality dir that
	// lives OUTSIDE the display ladder (never surfaced by get_files_info).
	const isAudioTr = spec.model === 'component_av' && quality === AUDIO_TR_QUALITY;
	if (!isThumb && !isAudioTr && !spec.qualities.includes(quality)) {
		throw new DedaloError('media.invalid_quality', {
			message: `Unknown media quality '${quality}' for ${spec.model} (not in ladder [${spec.qualities.join(', ')}])`,
			coordinates: { model: spec.model },
		});
	}
	return quality;
}

/**
 * Validate a quality as an INGEST TARGET — stricter than assertValidQuality,
 * and deliberately its neighbour so the two carve-out lists cannot drift.
 *
 * assertValidQuality admits two tiers that are NOT in `spec.qualities`: the
 * thumb tier and `audio_tr`. Both are DERIVED — `scanFilesInfo` walks the thumb
 * tier with the thumb extension ALONE (files_info.ts) and never walks audio_tr
 * at all — so a file uploaded into either is invisible to the record forever,
 * and sync_files cannot repair it (its scan finds nothing to record). PHP placed
 * such a file and lost it silently; we refuse.
 *
 * Any future off-ladder carve-out added above must be considered here too.
 */
export function assertIngestableQuality(spec: MediaTypeSpec, quality: unknown): string {
	const validated = assertValidQuality(spec, quality);
	if (spec.hasThumb && validated === config.media.thumb.quality) {
		// PUBLIC sentence: every value in it (`validated` passed the ladder above,
		// `defaultQuality` is spec data) is ENGINE data, never a raw caller string.
		const reason = `Cannot upload into the '${validated}' tier: it is a generated thumbnail, rebuilt from the ${spec.defaultQuality} file`;
		throw new DedaloError('media.upload_rejected', {
			message: reason,
			publicMessage: reason,
		});
	}
	if (validated === AUDIO_TR_QUALITY) {
		const reason = `Cannot upload into the '${validated}' tier: it is a generated transcription derivative`;
		throw new DedaloError('media.upload_rejected', {
			message: reason,
			publicMessage: reason,
		});
	}
	return validated;
}

/**
 * A DERIVATIVE tier holds NORMALIZED files — one per extension the type builds.
 * An upload into such a tier must therefore carry one of those extensions, or it
 * is SHADOWED: the tier's canonical `<id>.<defaultExtension>` still exists (or
 * gets rebuilt from the old original), the scanner emits it FIRST for that
 * quality, the thumb is regenerated from it, and the record keeps serving the
 * previous image while the upload sits beside it, reported as a success.
 *
 * EVERY MASTER TIER IS EXEMPT (spec.masterQualities), not just the original.
 * A master is not a derivative: nothing regenerates it, so nothing can shadow
 * it — it keeps the raw upload in whatever the allowlist admits, which is the
 * whole point of it. For the ORIGINAL that is the Original law; for the
 * RETOUCHED tier it is the same law for the same reason, because a retouch
 * delivered by a photographer arrives as a .tif or .psd and IS the new master
 * every derived tier is then built from (v6 get_image_source).
 *
 * Refusing a raw extension there was the reported defect: importing with the
 * target quality set to 'modified' failed per file with "Cannot upload a '.tif'
 * file into the 'modified' tier", because the retouched tier was classified as
 * a derivative it never was.
 */
export function assertNormalizedExtensionForTier(
	spec: MediaTypeSpec,
	quality: string,
	extension: string,
): void {
	if (spec.masterQualities.includes(quality)) return;
	const normalized = [spec.defaultExtension, ...spec.alternateExtensions];
	if (!normalized.includes(extension)) {
		// THE ADVICE NAMES THE ARCHIVE, NOT "the other place a .tif fits". Listing
		// every master as an equal destination reads as an invitation to park raw
		// scans in the retouched tier — and a raw scan sitting there OUTRANKS the
		// original as the source of every derived tier, silently inverting the very
		// precedence this tier exists to express. The retouched tier is offered
		// only under its actual meaning: a human retouched this object.
		const retouched = spec.masterQualities.filter((value) => value !== spec.originalQuality);
		const alternative =
			retouched.length === 0
				? ''
				: ` — or into ${retouched.map((value) => `'${value}'`).join(' / ')} if this file IS the human-retouched master`;
		// PUBLIC: the caller reaches this only through `assertAllowedExtension`
		// (process_uploaded_file.ts), so `extension` is one of the type's allowlist
		// values and `quality` one of its tiers — engine data, not a raw string.
		const reason = `Cannot upload a '.${extension}' file into the '${quality}' tier: it holds normalized ${normalized.map((value) => `.${value}`).join(' / ')} files, so the upload would be shadowed by them. Upload into '${spec.originalQuality}' instead${alternative}.`;
		throw new DedaloError('media.upload_rejected', { message: reason, publicMessage: reason });
	}
}

/** Validate an extension against the type's upload allowlist. Throws. */
export function assertAllowedExtension(spec: MediaTypeSpec, extension: unknown): string {
	if (typeof extension !== 'string' || extension === '') {
		throw new DedaloError('media.invalid_extension', {
			message: `Invalid media extension (empty) for ${spec.model}`,
			coordinates: { model: spec.model },
		});
	}
	const normalized = extension.toLowerCase().replace(/^\./, '');
	if (!spec.allowedExtensions.includes(normalized)) {
		throw new DedaloError('media.invalid_extension', {
			message: `Extension '${extension}' not allowed for ${spec.model}`,
			coordinates: { model: spec.model },
		});
	}
	return normalized;
}

/**
 * Image quality → target pixel-area budget (PHP component_image:1850-1899).
 * MB × 350000 = pixel area; the derivative never upscales past the source.
 * Returns null for unbounded tiers (original/modified) or non-MB quality names.
 *
 * convert_quality_to_megabytes semantics (PHP :576): '1.5MB'→1.5, '>100MB'→101,
 * '<1MB'→0.9, 'thumb'/'original'/'modified'→null.
 */
const PIXELS_PER_MEGABYTE = 350000;

export function qualityToMegabytes(quality: string): number | null {
	const match = quality.match(/^([<>]?)([0-9]+(?:\.[0-9]+)?)MB$/);
	if (match === null) return null;
	const value = Number(match[2]);
	if (!Number.isFinite(value)) return null;
	if (match[1] === '>') return value + 1; // '>100MB' → 101
	if (match[1] === '<') return value - 0.1; // '<1MB' → 0.9
	return value;
}

export function pixelAreaBudget(quality: string): number | null {
	const mb = qualityToMegabytes(quality);
	return mb === null ? null : Math.round(mb * PIXELS_PER_MEGABYTE);
}
