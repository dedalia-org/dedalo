/**
 * MEDIA PROCESSING — derivative generation (PHP build_version / regenerate_component).
 *
 * Given an ORIGINAL file, build the default-quality derivative, the thumbnail,
 * and any alternate-extension versions, per type. Uses the binary adapters
 * (imagemagick/ffmpeg/pdf) over the spawn discipline. Every output goes through
 * `./atomic.ts` (temp sibling + rename + debris sweep), so a coexisting reader
 * never sees a partial derivative and a failed run leaves nothing behind
 * (Original law: the original is the source of truth and is never mutated).
 *
 * SCENE SELECTION (2026-08-04): a source can hold N images (Photoshop layers,
 * TIFF/PDF pages, GIF frames). Each recipe here PROBES its source once
 * (`./engine/probe.ts`) and hands the argv layer an explicit scene selection, a
 * flatten background and the CMYK flag. Before that, a layered TIFF made
 * ImageMagick write `<stem>-0.jpg`… instead of the temp, the rename threw ENOENT
 * and the record was left with `matrix.media` NULL.
 *
 * PHP anchors: build_version (:3543), regenerate_component (:3153),
 * component_image build_version (:1461), component_pdf create_alternative_version
 * (:1375), component_av build_version (:1437, async transcode via jobs).
 */

import { existsSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { config } from '../../config/config.ts';
import {
	canonicalCoverExtension,
	isDerivativeSourceExtension,
	type MediaTypeSpec,
} from '../concepts/media.ts';
import { DedaloError } from '../errors/dedalo_error.ts';
import { withTempSibling, writeAtomically } from './atomic.ts';
import { rasterizePdfPage } from './engine/ghostscript.ts';
import {
	assertWritableTargetExtension,
	backgroundForTarget,
	buildThumb,
	convertImage,
	getDimensions,
	type SceneSelection,
	type ThumbOptions,
} from './engine/imagemagick.ts';
import {
	canCarryMetaChannel,
	type ImageSourceProbe,
	probeContentSpread,
	probeImageSource,
	probeMetaChannels,
} from './engine/probe.ts';
import { rasterizeSvg } from './engine/svg.ts';
import { moveToDeleted, renameOldFiles } from './file_ops.ts';
import {
	buildMediaIdentifier,
	buildMediaLocation,
	type MediaIdentity,
	type MediaPathOptions,
	requireMediaRoot,
} from './path.ts';

/**
 * PDF thumbnail rasterization tunables (PHP component_pdf::create_thumb :273-275):
 * the first page is rendered at 72 dpi with jpeg quality 75. These are literals in
 * PHP (not DEDALO_* config), mirrored here verbatim.
 */
const PDF_THUMB_DENSITY = 72;
const PDF_THUMB_QUALITY = 75;

/**
 * Resolve the media root for these path options (scratch override or config).
 * Delegates to `requireMediaRoot` rather than re-reading the catalog, so this
 * module cannot resolve a root the test-media guard never saw.
 */
function _rootOf(pathOpts: MediaPathOptions): string {
	return requireMediaRoot(pathOpts.mediaRoot);
}

/**
 * Turn one probe into the three decisions every image recipe needs: which image
 * of the source to take, what to composite it over, and whether to run the
 * CMYK→sRGB profile pair.
 *
 * `label` names the thing being built (a media identifier, a staging path) and
 * appears in the composite warning — a source with no representative image is
 * the ONE class the measurements do not cover empirically (a PSD saved without
 * a merged composite), so it must be visible in the log rather than inferred
 * later from a wrong-looking derivative.
 *
 * The warning is a LOG line and not a `derivativeErrors` entry on purpose: since
 * the probe rule was corrected (2026-08-04 review) this branch is only reached
 * when scene 0 is a partial patch of a SHARED page — layers of one canvas —
 * where compositing them is the right answer and `-flatten` yields exactly that
 * page. It is a judgement the operator may want to know about, not a derivative
 * that failed. Paged/multi-resolution containers, where compositing WAS
 * destructive, no longer take this branch at all.
 */
async function recipeFromProbe(
	probe: ImageSourceProbe,
	source: string,
	target: string,
	label: string,
): Promise<ThumbOptions> {
	const selection: SceneSelection = probe.hasRepresentativeScene ? 'representative' : 'composite';
	if (probe.sceneCount > 1 && selection === 'composite') {
		console.warn(
			`[media] ${label}: source declares no representative image (${probe.sceneCount} scenes, canvas ${probe.canvasWidth}x${probe.canvasHeight}) — compositing the whole stack`,
		);
	}
	return {
		selection,
		// The background is decided by the TARGET extension, never by the source's
		// alpha: what matters is what the target can store (see backgroundForTarget).
		background: backgroundForTarget(target),
		cmyk: /cmyk/i.test(probe.colorspace),
		applyMetaAlpha: await shouldApplyMetaAlpha(probe, source, selection, label),
	};
}

/**
 * Below this standard deviation a derivative carries no picture at all — it is one
 * flat colour. 0.01 is 1 % of the dynamic range.
 *
 * MEASURED separation on written jpgs (the numbers this threshold sits between):
 *
 *   medal master 440866, correct mask   0.190   ← must pass
 *   medal master 440867, correct mask   0.189   ← must pass
 *   ————————————————————————— 0.01 —————————————————————————
 *   inverted saved selection            0.0038  ← must be refused
 *   empty (all-black) extra sample      0       ← must be refused
 *   spot-ink plate promoted as a mask   0       ← must be refused
 *
 * 19x of headroom below the real masters, 2.6x above the worst destructive case.
 */
const MASK_DEGENERATE_SPREAD = 0.01;

/**
 * Decide whether `-channel-fx meta0=>alpha` belongs in this recipe.
 *
 * WHY IT EXISTS: Photoshop stores a saved selection / layer mask as a TIFF extra
 * sample (a "meta channel"), and ImageMagick does not read that as transparency —
 * it renders the image opaque. On the 2026-08-04 medal masters scene 0's meta
 * channel IS the medal silhouette; unapplied, the retouch paint that sits outside
 * the silhouette survives into every tier (the reported blue blobs). Applied, the
 * derivative is cut at the edge of the medal, which is what the master says.
 *
 * THIS IS AN INFERENCE, NOT A FACT THE FILE STATES. `tiffinfo` on those very
 * masters prints `Extra Samples: 1<unspecified>`: the format declares the plane
 * has NO declared meaning. (When a TIFF does declare an extra sample to be alpha —
 * ExtraSamples 1 or 2 — ImageMagick promotes it to a real alpha plane itself and
 * no meta channel is reported, so a meta channel is by construction always an
 * `unspecified` one.) Photoshop puts other things there, and the rules below plus
 * the post-condition in `writeGuardedAgainstABlankingMask` are what keep a wrong
 * guess from destroying a record. Every refusal is LOUD.
 *
 * THE RULES, each with the measurement that forces it:
 *
 *  - NEVER ON 'composite'. `-channel-fx` COLLAPSES the image list to image 0.
 *    Measured: a 2-scene source (layer 0 red, layer 1 green, both `srgb 4.1`)
 *    flattened WITHOUT the fx gives p(50,50) = srgb(0,128,1), the composited
 *    stack; WITH the fx it gives srgb(254,0,0) — layer 1 silently discarded,
 *    exit 0, one file, and the `-flatten` that follows has nothing left to
 *    composite. The composite selection exists precisely to keep the stack, so the
 *    two are mutually exclusive. v6 agreed: `class.ImageMagick.php:276-281` sets
 *    `$composite = false; $flatten = false;` in this branch.
 *  - EXACTLY ONE META CHANNEL. With two (`srgb 5.2`) `meta0` is whichever plane
 *    the producing application happened to write first. Measured on a master whose
 *    meta0 is a spot-ink plate and whose meta1 is the real silhouette: promoting
 *    meta0 yields a COMPLETELY BLANK white derivative (std 0, mean 1), and simply
 *    reversing the channel order renders correctly. The engine cannot inspect that
 *    order, so a multi-meta source is unknowable and must fall through unmasked.
 *    v6 said the same in a comment ("multiple meta channels are not supported")
 *    but never checked; this refuses, and says so.
 *  - TRUE ALPHA WINS. When image 0 carries a real alpha plane AND a meta channel,
 *    do not apply the fx: it OVERWRITES the alpha plane, so v6's rule would
 *    destroy real transparency with whatever selection a retoucher had saved. The
 *    alpha plane is the unambiguous carrier; the meta channel is only a stand-in
 *    for a source that has none.
 *  - ONLY FOR CONTAINERS THAT CAN CARRY ONE, so the expensive count is never asked
 *    for a JPEG/PNG/GIF. See `probeMetaChannels` for what asking costs.
 *
 * EXPORTED FOR ITS GATE. The 'composite' rule cannot be reached end-to-end with the
 * containers ImageMagick can WRITE on this box — a TIFF does not round-trip page
 * offsets (so its scene 0 is always full-frame and the probe never selects
 * composite) and IM's PSD writer drops meta channels — so the rule is gated here,
 * on the function that owns it, plus a companion gate that reproduces the damage it
 * prevents. A real Photoshop-authored PSD is not bound by IM's writer limits, which
 * is exactly why the rule is not left to chance.
 */
export async function shouldApplyMetaAlpha(
	probe: ImageSourceProbe,
	source: string,
	selection: SceneSelection,
	label: string,
): Promise<boolean> {
	if (selection === 'composite') return false;
	if (probe.scenes[0] === undefined) return false;
	if (!canCarryMetaChannel(probe)) return false;
	// ALPHA IS READ FROM THIS CALL, NOT FROM `probe.scenes[0].hasAlpha`. `-ping`
	// under-reports alpha on a TIFF that stores it as an extra sample — measured
	// `srgb 3.0` under -ping against `srgba 5.1` on a full read, i.e. the -ping
	// probe sees neither the alpha nor the meta channel. Deciding "true alpha wins"
	// from the -ping flag would apply the fx to exactly those files and overwrite a
	// real alpha plane, which is the damage the rule exists to prevent.
	const { metaChannels, hasAlpha } = await probeMetaChannels(source);
	if (hasAlpha) return false;
	if (metaChannels === 1) return true;
	if (metaChannels > 1) {
		// Loud, per the "never silently narrow scope" law: this source HAS a mask the
		// engine is choosing not to apply, and the operator is the only one who can
		// say which plane it is.
		console.warn(
			`[media] ${label}: source carries ${metaChannels} meta channels — cannot tell which is the transparency mask, so NONE is applied and the derivative keeps everything the master shows`,
		);
	}
	return false;
}

/**
 * Write a derivative that may have a promoted meta channel in it, and REFUSE to
 * ship the result if that promotion blanked the picture.
 *
 * WHY THIS EXISTS: "the file has an extra sample" does not mean "the extra sample
 * is a keep-mask". Measured, end-to-end, all exiting 0 with a file written:
 *
 *   - an EMPTY extra sample (a channel Photoshop initialised to black, never
 *     painted) → derivative mean 1.000, std 0 — a pure white rectangle;
 *   - an INVERTED saved selection (the ordinary "select the background, save
 *     selection" workflow) → mean 0.9995, std 0.0038 — the object erased;
 *   - a spot/ink plate in meta0 → mean 1.000, std 0.
 *
 * Without this guard each of those silently replaces a record's default tier, its
 * thumb and its SVG envelope with a blank the moment tool_update_cache sweeps the
 * archive, and nothing anywhere says so. That is the worst failure a heritage
 * engine can have, so the promotion is verified rather than trusted.
 *
 * The fallback is not a failure path: rebuilding WITHOUT the mask yields exactly
 * what this engine shipped before the promotion existed, and exactly what v6
 * shipped for jpg tiers. A genuinely blank master stays blank either way, so the
 * check cannot invent damage — it can only decline to cause it.
 *
 * RESIDUAL, KNOWN-OPEN: this catches a mask that destroys the WHOLE picture, not
 * one that damages part of it. An inverted selection over a busy background leaves
 * a non-uniform derivative and passes here. Detecting that needs a judgement about
 * which region is the subject, which no measurement on this box supports today.
 */
async function writeGuardedAgainstABlankingMask(
	temp: string,
	label: string,
	applyMetaAlpha: boolean,
	build: (applyMetaAlpha: boolean) => Promise<void>,
): Promise<void> {
	await build(applyMetaAlpha);
	if (!applyMetaAlpha) return;
	const spread = await probeContentSpread(temp);
	// A measurement we could not take is NOT evidence of damage: never condemn a
	// derivative on a failed identify.
	if (spread === null || spread >= MASK_DEGENERATE_SPREAD) return;
	console.warn(
		`[media] ${label}: the source's meta channel is not a transparency mask — promoting it left a blank derivative (pixel spread ${spread.toFixed(4)} < ${String(MASK_DEGENERATE_SPREAD)}); rebuilding WITHOUT it, so the tier shows everything the master shows`,
	);
	await build(false);
}

/**
 * Thumbnail an arbitrary image file into an arbitrary target path, atomically.
 *
 * The shared "probe then buildThumb" gear for the three call sites that own a
 * raw path pair rather than a media identity: the staged-upload preview and the
 * two posterframe thumbs. Each of those sources is arbitrary bytes (a layered
 * TIFF upload, a client canvas snapshot), so none of them may assume a single
 * image. Returns the target path.
 */
export async function buildThumbAtomically(
	source: string,
	target: string,
	label: string,
): Promise<string> {
	const probe = await probeImageSource(source);
	const options = await recipeFromProbe(probe, source, target, label);
	return writeAtomically(target, async (temp) => {
		// The guard runs INSIDE the atomic write, against the temp: a blanked thumb is
		// discarded and rebuilt before anything is renamed into place, so no reader
		// ever sees it.
		await writeGuardedAgainstABlankingMask(
			temp,
			label,
			options.applyMetaAlpha === true,
			async (applyMetaAlpha) => {
				await buildThumb(source, temp, { ...options, applyMetaAlpha });
			},
		);
	});
}

/**
 * Locate the best source file for regeneration — THE MASTER, in precedence
 * order (`spec.masterQualities`, highest first), preferring within each tier the
 * raw upload extension, then the normalized default extension, then the
 * allowlist. Returns the absolute path or null when no master is present.
 *
 * ONLY FILES A BUILDER CAN READ ARE CANDIDATES (DERIVATIVE_SOURCE_BY_MODEL,
 * concepts/media.ts): for component_pdf that is the `.pdf` RENDITION alone — the
 * authored `.doc`/`.odt` beside it is an original, never a source. null then
 * means "no derivative source", not "no original".
 *
 * PRECEDENCE IS THE POINT, and it is surprising: for component_image the
 * RETOUCHED master ('modified') OUTRANKS the original, so while a retouch
 * exists EVERY derived tier is built from it — including the tiers rebuilt when
 * a NEW ORIGINAL is ingested. That is deliberate (v6
 * component_image::get_image_source, frozen class.component_image.php:1569): the
 * retouch is a human-authored better look of the image, and silently reverting
 * the web tiers to the raw scan the moment someone re-scans the object would
 * throw that work away. The ingest path names the record in a console.info when
 * this happens — see ingest/process_uploaded_file.ts — because an operator whose
 * new scan did not change the visible image must be able to find out why.
 *
 * A MASTER IS NEVER A BUILD TARGET, so this walk needs no "do not build the
 * original out of the retouch" exception: v6 needed one (get_image_source
 * :1575) because its build_version accepted a master tier as a target and would
 * happily convert modified → original. tool_media_versions' buildVersionCore
 * REFUSES a master target outright (see it), which is the same rule enforced one
 * level up, where it also stops the retouch being rebuilt out of itself.
 */
export function resolveMasterSource(
	spec: MediaTypeSpec,
	identity: MediaIdentity,
	pathOpts: MediaPathOptions,
	rawExtension?: string | null,
): string | null {
	return resolveMaster(spec, identity, pathOpts, rawExtension)?.path ?? null;
}

/**
 * WHICH master tier `resolveMasterSource` resolves to. Exists so the ingest and
 * posterframe paths can SAY SO to the operator (see that function's precedence
 * note) without re-deriving the resolution rule at the call site.
 */
export function resolveMasterQuality(
	spec: MediaTypeSpec,
	identity: MediaIdentity,
	pathOpts: MediaPathOptions,
	rawExtension?: string | null,
): string | null {
	return resolveMaster(spec, identity, pathOpts, rawExtension)?.quality ?? null;
}

/** The ONE master-resolution walk both accessors above read (tier, then extension). */
function resolveMaster(
	spec: MediaTypeSpec,
	identity: MediaIdentity,
	pathOpts: MediaPathOptions,
	rawExtension: string | null | undefined,
): { quality: string; path: string } | null {
	// Filtered through DERIVATIVE_SOURCE_BY_MODEL: a pdf record's authored
	// `.doc`/`.odt` original is never a source, even when the caller names it as
	// the raw just uploaded — its PDF rendition (or nothing) is.
	const candidates = [rawExtension, spec.defaultExtension, ...spec.allowedExtensions].filter(
		(e): e is string => typeof e === 'string' && e !== '' && isDerivativeSourceExtension(spec, e),
	);
	for (const quality of spec.masterQualities) {
		for (const extension of candidates) {
			const loc = buildMediaLocation(spec, identity, quality, extension, pathOpts);
			if (existsSync(loc.absolutePath)) return { quality, path: loc.absolutePath };
		}
	}
	return null;
}

/**
 * SAY IT OUT LOUD when the file just written into `writtenQuality` is NOT the
 * master the derived tiers will be built from.
 *
 * The retouched master outranks the original for as long as it exists, so
 * putting a fresh scan in the archive — by upload, or by writing a new av
 * posterframe — leaves the visible image unchanged. That is the intended domain
 * rule, and it is precisely the kind of outcome an operator cannot deduce from a
 * successful operation, so every path that writes a master names the record.
 *
 * Silent when the tier just written IS the resolved master (the ordinary case),
 * because a line that fires on every upload is a line nobody reads — and then
 * the one occurrence that matters is indistinguishable from the noise.
 */
export function noteOutrankingMaster(
	spec: MediaTypeSpec,
	identity: MediaIdentity,
	pathOpts: MediaPathOptions,
	writtenQuality: string,
	whatWasWritten: string,
): void {
	const resolved = resolveMasterQuality(spec, identity, pathOpts);
	if (resolved === null || resolved === writtenQuality) return;
	console.info(
		`[media] ${spec.model} ${buildMediaIdentifier(identity)}: ${whatWasWritten} into '${writtenQuality}', but the '${resolved}' master outranks it — every derived tier is (re)built from '${resolved}', so the visible image does not change`,
	);
}

/**
 * Build one image quality derivative from the source (PHP component_image
 * convert_quality). Resizes to the quality's pixel-area budget (never upscaling),
 * converting CMYK→sRGB when detected. Writes atomically. Returns the target path.
 *
 * ONE probe supplies all three derived facts (scene selection, CMYK, source
 * dimensions) — it replaces the previous `getColorspace`/`getDimensions` pair,
 * each of which swallowed its own failure (`.catch(() => '')`). Those swallows
 * are gone: an unreadable source silently disabled the CMYK branch and the
 * resize budget, and per the ingest change it no longer costs the record its
 * index to fail here.
 *
 * `extension` defaults to the type's normalized extension and is the ONLY thing
 * that differs between a tier's own file and its alternate TWIN: the recipe is
 * identical, and every extension-dependent decision is already derived from the
 * TARGET PATH inside it — `backgroundForTarget` (an alpha-capable twin keeps its
 * transparency, the jpg is composited onto white) and `compressionForTarget`
 * (png's `-quality` is a zlib/filter code, not a quality). That is why a twin is
 * built through this function and not through a second recipe: two recipes drift.
 */
export async function buildImageVersion(
	spec: MediaTypeSpec,
	identity: MediaIdentity,
	quality: string,
	source: string,
	pathOpts: MediaPathOptions,
	extension: string = spec.defaultExtension,
	/** Explicit `-quality`; the per-target default when omitted (compressionForTarget). */
	compression?: number,
): Promise<string> {
	const target = buildMediaLocation(spec, identity, quality, extension, pathOpts).absolutePath;
	const probe = await probeImageSource(source);
	const label = `${buildMediaIdentifier(identity)} ${quality}`;
	const recipe = await recipeFromProbe(probe, source, target, label);
	return writeAtomically(target, async (temp) => {
		// The guard runs INSIDE the atomic write, against the temp (see
		// writeGuardedAgainstABlankingMask): a mask that blanked the tier is
		// discarded and rebuilt before the rename, so the archive never holds it.
		await writeGuardedAgainstABlankingMask(
			temp,
			label,
			recipe.applyMetaAlpha === true,
			async (applyMetaAlpha) => {
				await convertImage(source, temp, {
					quality,
					selection: recipe.selection,
					background: recipe.background,
					// The CANVAS, not scene 0's raster: a scene at a page offset makes the two
					// differ, and this must describe the file that will actually be written.
					sourceWidth: probe.canvasWidth,
					sourceHeight: probe.canvasHeight,
					cmyk: recipe.cmyk,
					applyMetaAlpha,
					compression,
				});
			},
		);
	});
}

/** Build the thumbnail (PHP create_thumb): dd_thumb recipe, atomic write. */
export async function buildThumbVersion(
	spec: MediaTypeSpec,
	identity: MediaIdentity,
	source: string,
	pathOpts: MediaPathOptions,
): Promise<string> {
	const thumbQuality = config.media.thumb.quality;
	const thumbExtension = config.media.thumb.extension;
	const target = buildMediaLocation(
		spec,
		identity,
		thumbQuality,
		thumbExtension,
		pathOpts,
	).absolutePath;
	if (spec.model === 'component_svg') {
		// PHP component_svg::create_thumb — render the vector at a chosen dpi, then
		// reduce THAT raster to the thumb box.
		//
		// THE RENDER IS NOT IMAGEMAGICK'S (engine/svg.ts owns the why): its SVG
		// renderer emits MVG, which the hardened policy disables, so `magick x.svg`
		// is refused outright on this engine. librsvg draws the vector into an
		// intermediate PNG and the shared thumb recipe takes it from there — so an
		// SVG thumb gets the same box, background, blank-guard and atomic write as
		// every other thumb, and the raster the record actually indexes is still
		// produced under the policy.
		//
		// The intermediate is a full-resolution render of an arbitrary uploaded
		// vector, so it is a TEMP and goes through the temp gear (withTempSibling:
		// unique name, dir ensured, removed on every path including the failures).
		// Named `.png` because a media binary picks its output format from the
		// filename, and invisible to readers while it lives: files_info resolves the
		// thumb tier by EXACT name, never by listing the directory.
		return withTempSibling(target, '.render.png', async (raster) => {
			await rasterizeSvg(source, raster);
			// The shared gear from here on: probe the RASTER (probing the vector
			// tells the thumb recipe nothing it can use), then the standard recipe,
			// blank-guard and atomic rename.
			return buildThumbAtomically(
				raster,
				target,
				`${buildMediaIdentifier(identity)} ${thumbQuality}`,
			);
		});
	}
	if (spec.model === 'component_pdf') {
		// PHP component_pdf::create_thumb — rasterize ONLY the first page, fit to the
		// thumb box. Page 1 is declared by the MODEL here, not discovered by a probe:
		// a pdf is a paged source by definition and page 1 is its cover.
		//
		// THE RENDER IS NOT IMAGEMAGICK'S (engine/ghostscript.ts owns the why, and it
		// is the same shape as the SVG branch above): ImageMagick can only read a PDF
		// by forking Ghostscript as a DELEGATE — a process the engine never sees, and
		// therefore neither bounds nor kills. Measured (MEDIA-01): a 441-byte PDF
		// declaring a 200000x200000-point page kept a gs child running, growing an
		// intermediate towards 120 TB, AFTER the magick we spawned had been killed by
		// the request cap; it reparented to PID 1 and nothing here ever reaped it. The
		// engine spawns gs itself, refuses a page above the configured dimension
		// ceiling before rendering anything, and the shipped policy denies the
		// delegate so this route cannot be bypassed.
		//
		// The PNG is an INTERMEDIATE, exactly like the SVG one: the thumb itself is
		// still produced by the shared ImageMagick recipe, so a pdf thumb keeps the
		// same box, background, blank-guard and atomic write as every other thumb.
		return withTempSibling(target, '.render.png', async (raster) => {
			await rasterizePdfPage(source, raster, PDF_THUMB_DENSITY);
			return writeAtomically(target, async (temp) => {
				await convertImage(raster, temp, {
					quality: thumbQuality,
					selection: 'representative',
					background: backgroundForTarget(target),
					thumbBox: { width: config.media.thumb.width, height: config.media.thumb.height },
					compression: PDF_THUMB_QUALITY,
				});
			});
		});
	}
	return buildThumbAtomically(source, target, `${buildMediaIdentifier(identity)} ${thumbQuality}`);
}

/**
 * Rasterize the PDF's first page into EVERY cover extension the type declares
 * (PHP create_alternative_version). `spec.coverExtensions` is the canonical jpg
 * FIRST, then whatever `DEDALO_PDF_ALTERNATIVE_EXTENSIONS` adds — see that field.
 *
 * THE COVER IS ALWAYS COMPOSITED ONTO WHITE, for every target extension, and
 * that is why this function does NOT call `backgroundForTarget`. Elsewhere the
 * background is decided by what the target can STORE, because the source's alpha
 * is the picture's own. A PDF page has no such alpha: it is glyphs and vectors on
 * the DEVICE background, and the white paper exists only because the rasterizer
 * puts it there. MEASURED through this exact recipe on both pdf masters in this
 * install, as avif covers: rasterized onto 'none' a glyph-sparse page comes out
 * `alpha_mean 0.0496` (media/pdf/original/0/test85_test3_1.pdf) — a 95%-
 * transparent sheet of floating glyphs, illegible over any dark UI — while a page
 * that paints its own background comes out 0.9998
 * (media/pdf/original/0/rsc37_rsc176_4.pdf) and hides the hazard completely.
 * Onto '#ffffff' BOTH measure 0.9998. The number is page-dependent; the rule is
 * not, and a page that happens to be self-opaque is exactly why this must never
 * be decided per file. Today's jpg cover is safe only by accident (jpg is in
 * OPAQUE_TARGET_EXTENSIONS), so generalising the alpha rule here would have
 * shipped blank covers the moment an install configured avif or png.
 *
 * FAILURE POLICY: every cover is attempted and the failures come back as VALUES,
 * so an extension this host cannot encode never costs the record the covers it
 * CAN build — and never turns a pdf build the operator watched succeed into a
 * failure. `regeneratePdf` additionally builds the thumb before this runs.
 */
export async function buildPdfCovers(
	spec: MediaTypeSpec,
	identity: MediaIdentity,
	source: string,
	pathOpts: MediaPathOptions,
): Promise<{ created: string[]; errors: string[] }> {
	const created: string[] = [];
	const errors: string[] = [];
	const canonical = canonicalCoverExtension(spec);
	// ONE RASTERIZATION FOR EVERY COVER EXTENSION, and it is Ghostscript's, not
	// ImageMagick's — see buildThumbVersion's pdf branch and engine/ghostscript.ts
	// for the measured reason (an ImageMagick delegate child is unbounded and
	// survives the kill that ends the request). Rendering page 1 once and encoding
	// the intermediate N times is also what the previous shape did NOT do: it
	// re-rasterized the PDF for every configured extension.
	//
	// A FAILED RENDER IS ONE ERROR, NOT N: with no raster there is no cover in any
	// format, and the failure that matters — "this PDF declares a page above the
	// ceiling" — is a property of the document, not of the extension. The pdf build
	// keeps its copy and its (separately built) thumb, which is the non-fatal
	// contract this function has always had.
	// Nothing to render for a type that declares no cover (every type but pdf):
	// the loop below would be empty anyway, and this keeps the render off a path
	// that has no output to justify it.
	if (spec.coverExtensions.length === 0) return { created, errors };
	const canonicalTarget = buildMediaLocation(
		spec,
		identity,
		spec.defaultQuality,
		canonical ?? (spec.coverExtensions[0] as string),
		pathOpts,
	).absolutePath;
	return withTempSibling(canonicalTarget, '.render.png', async (raster) => {
		try {
			await rasterizePdfPage(source, raster, config.media.imagePrintDpi);
		} catch (error) {
			// THE RAW SENTENCE STAYS IN THE LOG (SEC-18 / error_taxonomy A6). This list
			// travels to the operator panel on an `ok:true` body, and nothing filters
			// `data`: the rasterizer's own message names an absolute media-root path and
			// this install's DEDALO_MAGICK_LIMIT_* ceilings, which is operator
			// disclosure, not a payload sentence. The panel gets the vetted half.
			console.error(
				`buildPdfCovers: cover render failed for ${buildMediaIdentifier(identity)}`,
				error,
			);
			errors.push(
				`cover render of ${buildMediaIdentifier(identity)}: ${coverRenderFailure(error)}`,
			);
			return { created, errors };
		}
		for (const extension of spec.coverExtensions) {
			const target = buildMediaLocation(
				spec,
				identity,
				spec.defaultQuality,
				extension,
				pathOpts,
			).absolutePath;
			try {
				// Refuse a format this host cannot write BEFORE anything is produced: with
				// the coder token an unwritable target fails loudly, but the operator needs
				// to read the config key, not an ImageMagick sentence (see
				// assertWritableTargetExtension).
				//
				// THE CANONICAL COVER IS NEVER PROBED. It is not a configured alternate —
				// it is the type's own output, built since v6 — so gating it on a probe
				// makes a derivative that has no config behind it fail with a sentence
				// naming a config key that does not control it. The probe is also memoized
				// per process, so one transient failure (a full or unwritable tmpdir at the
				// moment of the first probe) would take the jpg cover out for the lifetime
				// of the server. If this host truly cannot write it, the encoder says so
				// loudly through the coder token, which is where that belongs.
				if (extension !== canonical) {
					await assertWritableTargetExtension(
						extension,
						`${spec.alternateExtensionsConfigKey} (the ${spec.model} cover of ${buildMediaIdentifier(identity)})`,
					);
				}
				// Page 1 by model declaration (see buildThumbVersion's pdf branch); the
				// source here is the gs-rendered intermediate, so this is an ordinary
				// raster encode under the hardened policy and the resource bound.
				created.push(
					await writeAtomically(target, async (temp) => {
						await convertImage(raster, temp, {
							quality: spec.defaultQuality,
							selection: 'representative',
							// ALWAYS opaque — see the header. Never backgroundForTarget(target).
							background: '#ffffff',
						});
					}),
				);
			} catch (error) {
				errors.push(
					`${spec.defaultQuality}.${extension} cover of ${buildMediaIdentifier(identity)}: ${(error as Error).message}`,
				);
			}
		}
		return { created, errors };
	});
}

/**
 * The sentence a failed cover render may show the operator panel.
 *
 * A DedaloError's `publicMessage` is the vetted half of the disclosure ladder —
 * "This PDF declares a page too large to be rendered on this server." — and its
 * `.message` is the log half. Anything else is an engine failure with no vetted
 * sentence at all, and the code is what the panel can act on: the detail is one
 * `console.error` away in the server log, keyed by the same media identifier.
 */
function coverRenderFailure(error: unknown): string {
	if (error instanceof DedaloError) {
		return error.publicMessage ?? error.code;
	}
	return 'the page could not be rendered (see the server log)';
}

/**
 * Copy the original to a target quality with the same extension (PHP base
 * build_version copy).
 *
 * ASYNCHRONOUS, and that is load-bearing. The bytes here are a WHOLE MEDIA FILE
 * — a heritage mesh or scanned PDF is routinely hundreds of MB — and this runs on
 * the REQUEST PATH (tool_upload → processUploadedFile). A `copyFileSync` blocks
 * the single Bun event loop for the whole copy, so every other request on the
 * install waits for it (measured: 0 ms on APFS, where the copy is a
 * copy-on-write clone, but 232 ms for a 1 GB file on NVMe — and the shipped path
 * is Linux/ext4, which has no clone).
 *
 * The sync twin it used to use was defended in-comment as avoiding a floating
 * rejection from an unawaited `regenerate3d` at the ingest call site. That
 * defence was stale: every call site already sits inside an async function that
 * awaits its siblings inside a try/catch. The remedy for an unawaited promise is
 * an explicit handler at the call site, never a blocked event loop
 * (gate: test/unit/sync_io_on_request_path_tripwire.test.ts).
 */
export async function copyToQuality(
	spec: MediaTypeSpec,
	identity: MediaIdentity,
	quality: string,
	source: string,
	extension: string,
	pathOpts: MediaPathOptions,
): Promise<string> {
	const target = buildMediaLocation(spec, identity, quality, extension, pathOpts).absolutePath;
	return await writeAtomically(target, async (temp) => {
		await copyFile(source, temp);
	});
}

/**
 * The tiers an alternate TWIN may live in: every DERIVED tier of the ladder.
 *
 * Masters are excluded because a machine-authored file parked in a master tier
 * becomes resolvable AS THE MASTER (`resolveMaster` walks `allowedExtensions`,
 * which holds png/heic/webp) — the engine would then build every derivative from
 * a file it wrote itself. The thumb is excluded because `scanFilesInfo` walks the
 * thumb tier with `config.media.thumb.extension` ALONE, so a twin there is
 * permanently unindexable: it would exist on disk, cost an encode per upload, and
 * be invisible to every reader.
 */
export function derivedTwinQualities(spec: MediaTypeSpec): string[] {
	return spec.qualities.filter(
		(quality) => !spec.masterQualities.includes(quality) && quality !== config.media.thumb.quality,
	);
}

/**
 * A tier the caller believes is a twin target. Masters and the thumb are refused
 * LOUDLY rather than skipped: a caller that passes one has a wrong model of what
 * a twin is, and silently dropping it is how "config read, never honoured" gets
 * recreated one call site at a time.
 */
function assertTwinTier(spec: MediaTypeSpec, quality: string): void {
	if (spec.masterQualities.includes(quality)) {
		// PUBLIC: `quality` is one of the type's own tiers and `spec.model` is
		// engine data — no raw caller string, no path (ERRORS_SPEC §2.2).
		const reason = `buildAlternateVersions: '${quality}' is a MASTER tier of ${spec.model} — a twin there would be resolvable as the master itself (see derivedTwinQualities)`;
		throw new DedaloError('media.unsupported_operation', {
			message: reason,
			publicMessage: reason,
		});
	}
	if (quality === config.media.thumb.quality) {
		const reason = `buildAlternateVersions: '${quality}' is the thumb tier — files_info scans it with the '${config.media.thumb.extension}' extension alone, so a twin there could never be indexed`;
		throw new DedaloError('media.unsupported_operation', {
			message: reason,
			publicMessage: reason,
		});
	}
}

/**
 * The extensions of a type that are TWINS — companions of a derived tier's own
 * file, built by `buildAlternateVersions`.
 *
 * The pdf COVER is deliberately excluded although it is in `alternateExtensions`:
 * a cover is not a companion of the stored `.pdf`, it is the PICTURE of it, so it
 * neither follows the `.pdf` into deleted/ nor is rebuilt beside it (buildPdfCovers
 * owns it). Everything else configured for a model that has a twin builder is one.
 */
function twinExtensions(spec: MediaTypeSpec): string[] {
	return spec.alternateExtensions.filter((extension) => !spec.coverExtensions.includes(extension));
}

/**
 * RETIRE every twin in `qualities` whose companion file is gone — the ⟺
 * invariant's other direction, on the paths that REMOVE a file rather than build
 * one. Returns the '<quality>.<extension>' labels moved into deleted/.
 *
 * WHY IT IS NOT ENOUGH TO DO THIS INSIDE THE RECONCILER. `buildAlternateVersions`
 * runs when a MASTER changed; deleting a derived tier's own file changes no
 * master, so nothing ran at all. MEASURED on the shipped code before this
 * function existed: one `delete_version('1.5MB','jpg')` click left
 * `1.5MB/<id>.avif` on disk, and `scanFilesInfo` then reported the ORPHAN as the
 * 1.5MB entry — so `resolve/relation_list.ts` and `resolve/media_list_value.ts`,
 * which pick a tier by QUALITY ALONE, served an AVIF url for a record whose web
 * version the operator had just deleted. Before this change the state was
 * unreachable except from v6 leftovers; the twin builder made it one click away,
 * which is exactly why the invariant has to be enforced where files are removed.
 *
 * IT NEVER BUILDS. A twin deleted ON ITS OWN is the operator saying "not that
 * format on this record": the tier keeps its file, the panel's build gear (with
 * `target_extension`) brings the twin back, and the next master change rebuilds
 * it. Restoring it here would make the panel's per-file delete a no-op.
 */
export function retireOrphanTwins(
	spec: MediaTypeSpec,
	identity: MediaIdentity,
	pathOpts: MediaPathOptions,
	qualities: readonly string[],
): string[] {
	const retired: string[] = [];
	const extensions = twinExtensions(spec);
	if (extensions.length === 0) return retired;
	for (const quality of qualities) {
		const tierFile = buildMediaLocation(
			spec,
			identity,
			quality,
			spec.defaultExtension,
			pathOpts,
		).absolutePath;
		if (existsSync(tierFile)) continue;
		for (const extension of extensions) {
			const twin = buildMediaLocation(spec, identity, quality, extension, pathOpts).absolutePath;
			if (moveToDeleted(twin, { mediaRoot: pathOpts.mediaRoot })) {
				retired.push(`${quality}.${extension}`);
			}
		}
	}
	return retired;
}

/**
 * Relative aspect-ratio distance above which a tier's own file is NOT a plain
 * resize of the master any more — i.e. an operator rotated or cropped it.
 *
 * MEASURED on this install, master vs every ladder tier through the real recipe:
 * the worst rounding drift is 1.03e-3 (the smallest tier of a 1849x2047 master),
 * and it is 0 wherever the budget does not resize. A 90° rotation of the medal
 * master moves it by 9e-1 — three orders of magnitude away. 2% is ~20x the
 * measured rounding and still catches any rotation of an image whose aspect is
 * outside 0.99–1.01.
 */
const COMPANION_ASPECT_TOLERANCE = 0.02;

/**
 * Is this tier's own file still a faithful derivative of the master? Returns a
 * description of the disagreement, or null when they agree.
 *
 * WHY IT IS ASKED AT ALL. A twin is built FROM THE MASTER (see
 * buildAlternateVersions — it is the only way the alpha survives), and the master
 * knows nothing about a rotation or crop an operator applied to the TIER.
 * MEASURED on the shipped code before this check: rotate 1.5MB by 90° (jpg and
 * avif both become 852x620, correctly — applyRotationCore walks every extension),
 * delete the avif, then recover it with `build_version(target_extension:'avif')`
 * or let tool_update_cache's repair sweep rebuild it, and the tier ends up
 * holding a 852x620 jpg beside a 618x850 avif: two files of one tier, ninety
 * degrees apart, reported by files_info as present and current, with no error.
 * The repair case is the migration case — the first sweep after an install turns
 * the key on manufactures one of those for EVERY already-rotated tier.
 *
 * TRANSCODING THE TIER'S OWN FILE INSTEAD WAS EVALUATED AND REJECTED. It would
 * always produce a geometrically correct companion, but it silently produces a
 * FLATTENED one whenever this heuristic is wrong (the tier's jpg has already been
 * composited onto white — measured PSNR 3.31 against the master vs 44.56 from the
 * master), which is the precise damage the twin exists to avoid. A refusal costs
 * a twin and says so; a wrong source costs the picture and does not.
 *
 * RESIDUAL, STATED NOT NARROWED: dimensions cannot see a 180° rotation, nor a 90°
 * one of an almost-square image, and an EXIF orientation outside the two
 * `getDimensions` swaps would read as a disagreement that is not one (a loud,
 * non-destructive false refusal). The durable fix is the one already ledgered in
 * tools/rotation.ts: store the rotation/crop as RECORD STATE and re-apply it
 * after any rebuild — then a twin is built from the master and transformed like
 * its companion, and no heuristic is needed.
 */
async function companionDisagreesWithMaster(
	master: string,
	tierFile: string,
): Promise<string | null> {
	const [masterDims, tierDims] = await Promise.all([
		getDimensions(master),
		getDimensions(tierFile),
	]);
	if (masterDims.height <= 0 || tierDims.height <= 0) return null; // unmeasurable: never condemn
	const masterAspect = masterDims.width / masterDims.height;
	const tierAspect = tierDims.width / tierDims.height;
	const distance = Math.abs(tierAspect - masterAspect) / masterAspect;
	if (distance <= COMPANION_ASPECT_TOLERANCE) return null;
	return (
		`its ${String(tierDims.width)}x${String(tierDims.height)} file is not a plain resize of the ` +
		`${String(masterDims.width)}x${String(masterDims.height)} master (aspect off by ${(distance * 100).toFixed(1)}%), ` +
		'so it carries a rotation or crop the master does not. A twin built from the master would be a companion ' +
		'of a different picture. Rebuild the tier itself to get both files from the master (that discards the ' +
		'rotation, exactly as any master change already does), then rotate again'
	);
}

/** What one `buildAlternateVersions` pass did. Never throws for a per-file failure. */
export interface AlternateVersionsResult {
	/** Twin files written (absolute paths). */
	created: string[];
	/** Twins moved to deleted/ — '<quality>.<extension>' labels. */
	retired: string[];
	/** Per-file failures, each naming the config key that asked for the format. */
	errors: string[];
}

/**
 * THE ALTERNATE-EXTENSION TWIN RECONCILER — the writer `DEDALO_*_ALTERNATIVE_
 * EXTENSIONS` never had. Before 2026-08-07 the key was read by seven modules and
 * written by NONE: the engine scanned for, indexed and advertised twins that
 * nothing could produce, and the one twin class that did exist (v6-migrated)
 * silently depicted a superseded master.
 *
 * A TWIN IS A PER-TIER COMPANION of that tier's normalized file — same picture,
 * same tier, other container. The invariant, stated in the direction the engine
 * can actually hold at ALL times:
 *
 *     exists(Q/<id>.<E>)  ⇒  exists(Q/<id>.<defaultExtension>)   for every derived Q
 *
 * NO TWIN WITHOUT ITS COMPANION, EVER — enforced here (absent tier file → any
 * twin found is RETIRED to deleted/) and, just as importantly, on the paths that
 * REMOVE a companion rather than build one (`retireOrphanTwins`, called from the
 * delete seam: a delete changes no master, so nothing here would have run).
 *
 * The converse is a RECONCILIATION, not a disk state: with the tier's own file
 * present the twin is (re)built FROM THE MASTER here, but it may legitimately be
 * absent in between — the key can be empty, the format may not be encodable on
 * this host, an operator may have deleted that one file, or the tier may carry a
 * rotation the master does not (see companionDisagreesWithMaster). Every one of
 * those is a case the engine reports rather than a state it silently fixes.
 *
 * THE SOURCE IS THE MASTER, NEVER THE TIER'S SIBLING JPG. Transcoding the jpg
 * would be cheaper and is WRONG: that file has already been composited onto white
 * by `backgroundForTarget`, so the alpha the twin exists to carry is gone before
 * the transcode starts. MEASURED on the layered medal master through this exact
 * recipe — from the MASTER the avif comes out `srgba`, `opaque=False`, PSNR 44.56
 * against the master; from the tier's jpg it comes out `opaque=True`, PSNR 3.31,
 * the cut-out destroyed. Building from the jpg would produce a file that passes
 * every existence check and depicts the wrong thing, which is the defect class
 * this whole subsystem exists to end.
 *
 * `mode`:
 *  - 'reconcile' (a master changed) — build, replace and retire to restore the
 *    invariant;
 *  - 'missing-only' (repair) — build ONLY absent twins, never retire anything.
 *    That is repair's contract: it fixes what is missing and never re-encodes or
 *    removes what an operator may have authored. A STALE twin is therefore NOT
 *    repaired here (it is corrected by the next master change) — stated, not
 *    narrowed: the engine cannot tell a stale twin from an operator-authored one
 *    without per-tier provenance, which is the ledgered gap.
 *
 * NEVER THROWS for a per-file failure. A host with no AVIF delegate must be left
 * honestly twin-LESS rather than stale, which is exactly what the retire branch
 * gives it — today's behaviour, now gated. The failures travel in `errors`, each
 * naming `spec.alternateExtensionsConfigKey`, so an operator reads WHICH key
 * asked for a format this box cannot write.
 */
export async function buildAlternateVersions(
	spec: MediaTypeSpec,
	identity: MediaIdentity,
	pathOpts: MediaPathOptions,
	master: string,
	options: {
		/** The derived tiers to reconcile (see derivedTwinQualities). */
		qualities: readonly string[];
		/** Defaults to every configured alternate of the type. */
		extensions?: readonly string[];
		/** Defaults to 'reconcile'. */
		mode?: 'reconcile' | 'missing-only';
	},
): Promise<AlternateVersionsResult> {
	const result: AlternateVersionsResult = { created: [], retired: [], errors: [] };
	/**
	 * Retire one twin, and REPORT a retirement that could not happen instead of
	 * throwing it. This function's contract is that a per-file failure never
	 * escapes (a box with no delegate must still get its jpg ladder), and a
	 * `moveToDeleted` can itself fail — a read-only quality directory, a full
	 * disk — which would otherwise take the whole pass with it from inside a
	 * catch block.
	 */
	const retire = (twin: string, label: string): void => {
		try {
			if (moveToDeleted(twin, { mediaRoot: pathOpts.mediaRoot })) result.retired.push(label);
		} catch (error) {
			result.errors.push(`${label}: could not be retired — ${(error as Error).message}`);
		}
	};
	const mode = options.mode ?? 'reconcile';
	const extensions = options.extensions ?? twinExtensions(spec);
	const label = buildMediaIdentifier(identity);
	// Asked at most ONCE per tier, and only for a tier that is about to be built
	// into — the check costs one `identify -ping` pair (~20 ms) and the answer
	// cannot change inside one pass. See companionDisagreesWithMaster.
	const companionCheck = new Map<string, string | null>();
	const companionVerdict = async (quality: string, tierFile: string): Promise<string | null> => {
		const cached = companionCheck.get(quality);
		if (cached !== undefined) return cached;
		const verdict = await companionDisagreesWithMaster(master, tierFile);
		companionCheck.set(quality, verdict);
		return verdict;
	};
	for (const extension of extensions) {
		// The tier's own file is not a twin of itself.
		if (extension === spec.defaultExtension) continue;
		// Probed ONCE per extension (and once per magick binary — canWriteImageFormat
		// memoizes), not once per tier: a box without the delegate must report one
		// operator-readable line, not one per quality.
		let capabilityFailure: string | null = null;
		try {
			await assertWritableTargetExtension(
				extension,
				`${spec.alternateExtensionsConfigKey} (${spec.model} ${label})`,
			);
		} catch (error) {
			capabilityFailure = (error as Error).message;
		}
		let capabilityReported = false;
		for (const quality of options.qualities) {
			assertTwinTier(spec, quality);
			const twin = buildMediaLocation(spec, identity, quality, extension, pathOpts).absolutePath;
			const tierFile = buildMediaLocation(
				spec,
				identity,
				quality,
				spec.defaultExtension,
				pathOpts,
			).absolutePath;
			if (!existsSync(tierFile)) {
				// THE OTHER DIRECTION OF THE INVARIANT, and it is not a tidiness rule:
				// one `delete_version('6MB','jpg')` click leaves the twin behind, and
				// nothing would ever touch it again — indexed, openable, depicting a
				// master the tier no longer has. Handling twins only inside the
				// tier-present branch is strictly worse than the code this replaces.
				// 'missing-only' never removes anything (repair's contract).
				if (mode === 'reconcile') retire(twin, `${quality}.${extension}`);
				continue;
			}
			if (mode === 'missing-only' && existsSync(twin)) continue;
			if (capabilityFailure !== null) {
				if (!capabilityReported) {
					result.errors.push(capabilityFailure);
					capabilityReported = true;
				}
				// A twin that cannot be rebuilt must not stay: it depicts the previous
				// master. Honestly twin-less beats quietly stale.
				if (mode === 'reconcile') retire(twin, `${quality}.${extension}`);
				continue;
			}
			// A COMPANION OF WHAT? Refuse to write a twin whose tier file carries a
			// transform the master does not (measured: a recovered twin ninety degrees
			// from its own jpg, silently, in both the panel and the repair sweep). Any
			// twin already there is left ALONE — it was rotated with its companion and
			// is correct.
			const disagreement = await companionVerdict(quality, tierFile);
			if (disagreement !== null) {
				result.errors.push(
					`${quality}.${extension}: not built — ${disagreement} (configured by ${spec.alternateExtensionsConfigKey})`,
				);
				continue;
			}
			try {
				if (shouldBackUpTwin(spec, quality, extension)) {
					renameOldFiles(twin, new Date(), pathOpts.mediaRoot);
				}
				result.created.push(
					await buildImageVersion(spec, identity, quality, master, pathOpts, extension),
				);
			} catch (error) {
				// The write is atomic, so a failure leaves the PREVIOUS twin in place —
				// which is the stale-twin state itself. Retire it, so the failure costs
				// the record a twin and never a lie.
				retire(twin, `${quality}.${extension}`);
				result.errors.push(
					`${quality}.${extension}: ${(error as Error).message} (configured by ${spec.alternateExtensionsConfigKey})`,
				);
			}
		}
	}
	return result;
}

/**
 * Whether a twin about to be replaced is backed up into deleted/ first.
 *
 * HIGHER TIERS ALWAYS, for the same reason their jpg is (see regenerateImage):
 * they are minted on demand and an operator may have curated or rotated them.
 *
 * THE DEFAULT TIER ONLY WHEN THE EXTENSION IS ALSO IN THE UPLOAD ALLOWLIST.
 * That is not a size heuristic — it is the exact test for "could a human have put
 * this file here?". `assertNormalizedExtensionForTier` admits an upload into a
 * derived tier only for `[defaultExtension, ...alternateExtensions]`, and
 * `assertAllowedExtension` additionally requires the upload allowlist, so a twin
 * in the default tier may be an operator's file exactly when its format is in
 * `allowedExtensions`. The default tier is rebuilt on EVERY master ingest, so
 * backing up a machine-authored twin there would turn every upload on the install
 * into deleted/ churn for bytes nobody authored. (!) The SHIPPED default of
 * `DEDALO_IMAGE_EXTENSIONS_SUPPORTED` admits avif (as v6's did), so with the
 * default allowlist an avif twin IS backed up on every ingest — correct by this
 * rule, and removable only by the operator dropping avif from uploads.
 */
function shouldBackUpTwin(spec: MediaTypeSpec, quality: string, extension: string): boolean {
	if (quality !== spec.defaultQuality) return true;
	return spec.allowedExtensions.includes(extension);
}

/**
 * The NORMALIZED MASTER COPY — the browser-viewable `<id>.<defaultExtension>`
 * that sits BESIDE the raw upload in a MASTER tier (Original law,
 * engineering/MEDIA_SPEC.md §2; PHP component_image::check_normalized_files
 * :1686).
 *
 * WHY IT MUST EXIST. The raw master is routinely a `.tif` / `.psd` / `.png` a
 * browser cannot render, and every reader of a tier's picture in this engine
 * addresses it by the type's DEFAULT extension: `files_info.ts` scans that
 * extension FIRST, the client filters its quality selector by
 * `context.features.extension` (render_edit_component_image.js), and
 * tool_media_versions' preview cell does the same. Without the copy an uploaded
 * `.tif` is indexed and downloadable but has NO displayable form in the
 * original quality at all. MEASURED on rsc29/rsc170/1 (2026-10-23): only
 * `original/…_1.tif` on disk, and 'original' had disappeared from the quality
 * selector entirely.
 *
 * IT IS A DISPLAY/INDEX COMPANION, NOT THE SOURCE. The engine builds derivatives
 * from the RAW upload (`resolveMaster` tries the caller's `rawExtension` first),
 * which preserves the alpha a flattened jpg would destroy — the measured reason
 * buildAlternateVersions exists. PHP built its ladder FROM this copy; we do not.
 *
 * THE SOURCE IS THE TIER'S OWN RAW. A retouch in 'modified' must never become
 * the original tier's picture, and an existing copy is never its own source —
 * that would lose a generation on every master change.
 *
 * `rebuild: true` — the ingest just replaced this tier's raw, so a copy depicting
 * the previous master is stale and is replaced. No `deleted/` backup: this file
 * is machine-authored and rebuilt from an upload, exactly like the default tier
 * and the thumb (see regenerateImage), and the RAW beside it — the file that
 * carries the operator's bytes — is the one addFile backs up.
 *
 * IT IS ENCODED AT QUALITY 100 (see the call), not the ladder's 90 default: it is
 * the full-resolution viewable of the archival master.
 *
 * `rebuild: false` — repair's contract: build what is MISSING, never re-encode
 * what is there (repair.ts regenerateMissingDerivatives).
 *
 * Returns null when there is nothing to copy: the tier holds no raw upload (a
 * copy whose raw is gone on a partial-media box), or the raw IS the default
 * extension.
 */
export async function buildMasterNormalizedCopy(
	spec: MediaTypeSpec,
	identity: MediaIdentity,
	quality: string,
	pathOpts: MediaPathOptions,
	options: { rawExtension?: string | null; rebuild: boolean },
): Promise<string | null> {
	if (!spec.masterQualities.includes(quality)) {
		// A machine-authored copy belongs beside a raw master, never in a
		// derivative tier — there it would SHADOW the tier's own file
		// (assertNormalizedExtensionForTier's defect, one level down).
		const reason = `buildMasterNormalizedCopy: '${quality}' is not a MASTER tier of ${spec.model} — a normalized copy lives beside a raw master, never in a derivative tier`;
		throw new DedaloError('media.unsupported_operation', {
			message: reason,
			publicMessage: reason,
		});
	}
	// AN UPLOAD THAT ALREADY CARRIES THE DEFAULT EXTENSION *IS* THE COPY: the
	// caller just said the tier's current raw is `.<defaultExtension>`, so there
	// is nothing to convert — and converting "whatever else this tier holds"
	// would overwrite the operator's fresh upload with a picture of a leftover
	// raw from a previous master.
	if (options.rawExtension?.toLowerCase() === spec.defaultExtension) return null;
	const raw = masterTierRawFile(spec, identity, quality, pathOpts, options.rawExtension);
	if (raw === null) return null;
	if (!options.rebuild) {
		const target = buildMediaLocation(
			spec,
			identity,
			quality,
			spec.defaultExtension,
			pathOpts,
		).absolutePath;
		if (existsSync(target)) return null;
	}
	// COMPRESSION 100 — PHP check_normalized_files passed `quality = 100` for this
	// copy (class.component_image.php:1713), and it is the record's full-resolution
	// viewable: the raw master is untouched, so this file is the only way an
	// operator can inspect or download the original at its real size. The ladder's
	// 90 default is for the web tiers, where bytes are the point.
	return await buildImageVersion(
		spec,
		identity,
		quality,
		raw,
		pathOpts,
		spec.defaultExtension,
		100,
	);
}

/**
 * The RAW upload a master tier holds — the file the normalized copy is made
 * from. The caller's `rawExtension` (the extension just uploaded, or the
 * record's stored normalized name) is authoritative and is tried first; the
 * upload allowlist follows, so a partial-media box still finds a surviving raw
 * of another extension. The DEFAULT extension is NEVER a candidate: that is the
 * copy, and a copy sourced from itself loses a generation per rebuild.
 */
function masterTierRawFile(
	spec: MediaTypeSpec,
	identity: MediaIdentity,
	quality: string,
	pathOpts: MediaPathOptions,
	rawExtension: string | null | undefined,
): string | null {
	const candidates = [rawExtension, ...spec.allowedExtensions].filter(
		(value): value is string => typeof value === 'string' && value !== '',
	);
	for (const extension of candidates) {
		if (extension === spec.defaultExtension) continue;
		const location = buildMediaLocation(spec, identity, quality, extension, pathOpts);
		if (existsSync(location.absolutePath)) return location.absolutePath;
	}
	return null;
}

/**
 * Regenerate the derivatives of an image record from its best master: default
 * quality + thumb + SVG envelope, PLUS a re-encode of every other ladder tier
 * that ALREADY EXISTS on disk. Returns the paths created. No master is touched
 * by THIS path (the one deliberate master mutation in the engine is
 * tool_image_rotation — see tools/rotation.ts, which rotates the retouched
 * master in place on purpose).
 *
 * WHY THE EXISTING HIGHER TIERS ARE RE-ENCODED (2026-08-07): this function runs
 * whenever a MASTER CHANGES — a fresh original or a fresh retouch is ingested, a
 * master is deleted and the surviving one takes over. After such a change every
 * derived tier must depict the new best master, and a '6MB' built from the
 * previous one would keep serving the previous picture forever, with a
 * files_info that reports it as present and current. An absent tier is still NOT
 * created here: tiers are minted on demand by tool_media_versions, and building
 * a 100MB derivative nobody asked for on every upload is a different decision
 * than keeping an existing one honest.
 *
 * WHAT THAT COSTS, AND WHY IT IS RECOVERABLE. A derived tier is not necessarily
 * machine-authored: tool_image_rotation rotates and crops the DERIVED tiers in
 * place, and an operator can park a curated file in any tier by uploading into
 * it. Re-encoding replaces that work. Measured before this pass: a hand-placed
 * blue '6MB' came back green (the new master) with no trace. So every file this
 * loop replaces goes to `deleted/` FIRST (renameOldFiles — the engine's
 * No-hard-delete law, PHP rename_old_files :1193) and the replacement is named
 * in a console.warn. The tiers stay honest AND the operator's bytes survive.
 *
 * The DEFAULT tier and the thumb above are deliberately NOT backed up: they have
 * been rebuilt unconditionally on every master ingest since long before this
 * change, and turning every upload on the install into deleted/ churn is a
 * different decision from making a newly-destructive loop recoverable. That
 * asymmetry is the honest state, not an oversight — see the report gap on
 * per-tier provenance, which is what would let the engine tell "machine-built"
 * from "operator-authored" and stop guessing.
 *
 * IT RETURNS A RESULT OBJECT, NOT A PATH LIST (2026-08-07). The alternate twins
 * are built here, and a twin failure is NON-FATAL by construction (a box with no
 * AVIF delegate must still get its jpg ladder). With a `string[]` return that
 * failure had nowhere to go: `derivativeErrors` was populated at exactly ONE
 * site — the ingest catch — so a host that cannot write the configured format
 * would have reported every upload as a complete success while the format was
 * silently not produced. That is the defect this whole change exists to end, so
 * the channel is part of the signature.
 */
export async function regenerateImage(
	spec: MediaTypeSpec,
	identity: MediaIdentity,
	pathOpts: MediaPathOptions,
	rawExtension?: string | null,
): Promise<RegenerateImageResult> {
	const master = resolveMaster(spec, identity, pathOpts, rawExtension);
	if (master === null) return { created: [], replaced: [], retired: [], errors: [] };
	const source = master.path;
	const created: string[] = [];
	const defaultPath = await buildImageVersion(
		spec,
		identity,
		spec.defaultQuality,
		source,
		pathOpts,
	);
	created.push(defaultPath);
	// THE THUMB'S SOURCE IS THE DEFAULT TIER, NEVER THE RAW ORIGINAL.
	// v6 component_image::create_thumb (class.component_image.php:393-431) reads
	// get_media_filepath(quality_default): single-scene, already composited, already
	// CMYK-converted, so the thumb recipe cannot meet a sequence at all.
	// repair.ts:232-233 already does this and versions.ts:87-100 already prefers it.
	// NON-FATAL, like every other derivative of this pass (the twins below, the pdf
	// covers, the svg thumb). It used to throw straight out of the regenerate, so a
	// thumb this host could not encode also cost the record its SVG ENVELOPE — and
	// without the envelope the edit view renders the placeholder, i.e. a thumbnail
	// failure made the image itself disappear from the form.
	/** Thumb failure — merged into this pass's `errors` beside the tier/twin ones. */
	const thumbErrors: string[] = [];
	try {
		created.push(await buildThumbVersion(spec, identity, defaultPath, pathOpts));
	} catch (error) {
		thumbErrors.push(
			`${config.media.thumb.quality} of ${buildMediaIdentifier(identity)}: ${(error as Error).message}`,
		);
	}
	// The edit view renders the raster through an SVG envelope (PHP
	// component_image regenerate re-creates it); without it the client falls back
	// to the placeholder and the image never shows. Built from the default tier.
	const { createDefaultSvgFile } = await import('./svg_overlay.ts');
	const svgPath = await createDefaultSvgFile(spec, identity, pathOpts);
	if (svgPath !== null) created.push(svgPath);
	// Re-encode the OTHER ladder tiers that already exist (see the header note).
	// Masters are excluded — they are sources, never rebuilt — and so is the thumb
	// (built above, from the default tier, and it has no alternate twin: its
	// extension is fixed by config.media.thumb). derivedTwinQualities states that
	// same exclusion once, for the twin pass below.
	const replaced: string[] = [];
	/** Higher-tier re-encode failures — non-fatal per tier, see the catch below. */
	const tierErrors: string[] = [];
	const twinQualities = derivedTwinQualities(spec);
	for (const quality of twinQualities) {
		if (quality === spec.defaultQuality) continue;
		const existing = buildMediaLocation(
			spec,
			identity,
			quality,
			spec.defaultExtension,
			pathOpts,
		).absolutePath;
		if (existsSync(existing)) {
			// deleted/ FIRST, then rebuild: the operator's previous bytes must
			// survive the replacement (header note). If the rebuild then fails the
			// tier is ABSENT rather than stale — which is the honest of the two
			// states, the re-scan reports it, and the backup is one move away.
			try {
				renameOldFiles(existing, new Date(), pathOpts.mediaRoot);
				created.push(await buildImageVersion(spec, identity, quality, source, pathOpts));
				replaced.push(quality);
			} catch (error) {
				// PER TIER, NOT PER PASS, and it is the ⟺ invariant that forces it: a
				// throw here escaped the whole function, so the twin pass below never
				// ran and the tier was left with NO normalized file and its twin still
				// on disk — indexed, openable, and the first entry files_info reports
				// for that quality. Collecting it instead lets the reconciler retire
				// that twin, and stops one unbuildable higher tier from costing the
				// record every tier after it.
				tierErrors.push(
					`${quality}.${spec.defaultExtension}: ${(error as Error).message} (previous bytes are in deleted/)`,
				);
			}
		}
	}
	// THE ALTERNATE TWINS ARE RECONCILED AGAINST THE NEW MASTER — built where the
	// tier's own file exists, retired where it does not (buildAlternateVersions
	// owns the rule and the measurements). Until 2026-08-07 they could only be
	// RETIRED, because nothing in src/ ever wrote one: a twin on disk came from v6
	// or from an operator, it depicted a master the record no longer had, and
	// files_info reported it present and current — the panel offered a cell that
	// opened the PREVIOUS picture (measured: 6MB.jpg went blue while 6MB.avif
	// stayed red). Retirement survives as the FAILURE branch, so a box that cannot
	// encode the configured format is left honestly twin-less rather than stale.
	//
	// GAP, stated rather than narrowed: files_info also scans the UPLOAD
	// ALLOWLIST in derived tiers, so a legacy '6MB/<id>.tif' goes just as
	// stale and is NOT retired here — only the configured alternate twins are.
	// The durable fix for both is porting an alternate-version builder.
	// [2026-08-07: the twin half of that fix is now HERE; the upload-allowlist
	// half is still open — narrowing the scan was evaluated and REJECTED, because
	// it is a shrink that holdShrink would discard on exactly the migrated records
	// it targets. It stays a ledger row, not a silent narrowing.]
	const alternates = await buildAlternateVersions(spec, identity, pathOpts, source, {
		qualities: twinQualities,
		mode: 'reconcile',
	});
	created.push(...alternates.created);
	const retired = alternates.retired;
	if (replaced.length > 0 || retired.length > 0) {
		// LOUD ON PURPOSE. Everything this line names was replaced or removed by a
		// master change the operator may not connect to it — a rotation or crop
		// that lived only in these tiers is gone from them. Every file is in the
		// sibling deleted/ directory under its `_deleted_<stamp>` name.
		console.warn(
			`[media] ${spec.model} ${buildMediaIdentifier(identity)}: master '${master.quality}' rebuilt the derived tiers.` +
				(replaced.length > 0
					? ` Re-encoded (previous bytes in deleted/): ${replaced.join(', ')}.`
					: '') +
				(retired.length > 0
					? ` Retired to deleted/ — the tier holds no ${spec.defaultExtension} for them to accompany, or this host cannot encode them: ${retired.join(', ')}.`
					: '') +
				' Any rotation or crop applied to those tiers no longer applies to them.',
		);
	}
	const errors = [...thumbErrors, ...tierErrors, ...alternates.errors];
	if (errors.length > 0) {
		// The twin pass and the per-tier re-encode are both non-fatal, so this is the
		// operator's ONLY server-log sighting of them; the same strings ride back to
		// the caller in `errors`.
		console.warn(
			`[media] ${spec.model} ${buildMediaIdentifier(identity)}: derivative(s) NOT built: ${errors.join('; ')}`,
		);
	}
	return { created, replaced, retired, errors };
}

/** What one `regenerateImage` pass did — see that function for why it is an object. */
export interface RegenerateImageResult {
	/** Files written (default tier, thumb, SVG envelope, re-encoded tiers, twins). */
	created: string[];
	/** Higher tiers re-encoded from the new master (previous bytes in deleted/). */
	replaced: string[];
	/** Alternate twins moved to deleted/ — '<quality>.<extension>' labels. */
	retired: string[];
	/** NON-FATAL twin failures, each naming the config key that asked for the format. */
	errors: string[];
}

/** What one `regeneratePdf` pass did — the pdf twin of RegenerateImageResult. */
export interface RegeneratePdfResult {
	/** Files written (web copy, thumb, covers). */
	created: string[];
	/** NON-FATAL cover failures, each naming the config key that asked for the format. */
	errors: string[];
}

/**
 * What the operator must hear when a NON-PDF original (`.doc`, `.odt`…) lands in
 * a pdf record's master tier (owner decision 2026-11-11, D1 = b — coexistence):
 * nothing derived is rebuilt from it, so either the PDF rendition beside it
 * still drives the web copy, thumb and covers — possibly depicting an earlier
 * version of the document — or there is no rendition and no web copy at all.
 * null when the upload IS a derivative source (or the type is not pdf-like).
 */
export function nonSourceOriginalNotice(
	spec: MediaTypeSpec,
	identity: MediaIdentity,
	pathOpts: MediaPathOptions,
	uploadedExtension: string,
): string | null {
	if (isDerivativeSourceExtension(spec, uploadedExtension)) return null;
	const stored = `${buildMediaIdentifier(identity)}.${uploadedExtension.toLowerCase()}`;
	const rendition = resolveMaster(spec, identity, pathOpts, null);
	if (rendition === null) {
		return `${stored} stored as the original; there is no PDF rendition beside it, so the record has no web copy, thumbnail or cover — upload a PDF of the document to build them.`;
	}
	const name = rendition.path.slice(rendition.path.lastIndexOf('/') + 1);
	return `${stored} stored as the original beside the PDF rendition ${name} (${rendition.quality}), which still drives the web copy, thumbnail and covers — upload a new PDF if it depicts an earlier version of the document.`;
}

/**
 * Regenerate a PDF record: web copy + thumb + every cover extension.
 *
 * THE COVERS ARE BUILT LAST, and that order is load-bearing: a configured cover
 * format this host cannot encode must not cost the record its document copy or
 * its thumb — the one derivative every list view depends on. Same law as
 * repair.ts step 6.
 *
 * IT RETURNS A RESULT OBJECT for the same reason regenerateImage does (D9): a
 * cover failure is non-fatal, so with a `string[]` return it had nowhere to go
 * and every caller reported a complete success. It also removes an asymmetry the
 * operator could see — the image path reported SUCCESS with the failure in
 * `errors`, while the pdf path turned a build whose copy, thumb and jpg cover all
 * landed into a red failure.
 */
export async function regeneratePdf(
	spec: MediaTypeSpec,
	identity: MediaIdentity,
	pathOpts: MediaPathOptions,
): Promise<RegeneratePdfResult> {
	const source = resolveMasterSource(spec, identity, pathOpts, 'pdf');
	if (source === null) return { created: [], errors: [] };
	const created: string[] = [];
	created.push(await copyToQuality(spec, identity, spec.defaultQuality, source, 'pdf', pathOpts));
	const errors: string[] = [];
	// NON-FATAL (2026-08-08): an unwrapped throw here took the COVERS with it — the
	// jpg cover is the only visual a pdf record has in a list view, so a thumb
	// failure used to remove the record's picture twice over.
	try {
		created.push(await buildThumbVersion(spec, identity, source, pathOpts));
	} catch (error) {
		errors.push(
			`${config.media.thumb.quality} of ${buildMediaIdentifier(identity)}: ${(error as Error).message}`,
		);
	}
	const covers = await buildPdfCovers(spec, identity, source, pathOpts);
	created.push(...covers.created);
	errors.push(...covers.errors);
	if (covers.errors.length > 0) {
		// The only server-log sighting of a non-fatal cover failure; the same strings
		// ride back to the caller in `errors` (see regenerateImage's twin note).
		console.warn(
			`[media] ${spec.model} ${buildMediaIdentifier(identity)}: cover(s) NOT built: ${covers.errors.join('; ')}`,
		);
	}
	return { created, errors };
}

/** What one `regenerateSvg` pass did — the svg twin of RegeneratePdfResult. */
export interface RegenerateSvgResult {
	/** Files written (web copy, thumb). */
	created: string[];
	/** NON-FATAL thumb failure (no rasterizer on this host, unrenderable vector). */
	errors: string[];
}

/**
 * Regenerate an SVG record: web copy + raster thumb.
 *
 * THE THUMB IS BUILT FROM THE WEB COPY, not from the master, and the copy
 * therefore happens first: they are the same bytes here (an svg derivative is a
 * byte copy), but the thumb of every other type depicts the DELIVERED file, and a
 * future svg pipeline that sanitizes or rewrites the web copy must not leave the
 * thumb depicting something the record does not serve.
 *
 * THE THUMB IS NON-FATAL, like the pdf covers and the image twins. It is the one
 * step here that needs an external renderer that an install may not have
 * (engine/svg.ts — librsvg), and the web copy has already landed: reporting the
 * whole regeneration as failed would hide a record whose deliverable file is
 * perfectly in place. The failure travels as a VALUE so the caller can put it in
 * front of the operator (this used to be a silent no-op: `regenerateSvg` never
 * built a thumb at all, which is what left every SVG record without one).
 */
export async function regenerateSvg(
	spec: MediaTypeSpec,
	identity: MediaIdentity,
	pathOpts: MediaPathOptions,
): Promise<RegenerateSvgResult> {
	const source = resolveMasterSource(spec, identity, pathOpts, 'svg');
	if (source === null) return { created: [], errors: [] };
	const created: string[] = [];
	created.push(await copyToQuality(spec, identity, spec.defaultQuality, source, 'svg', pathOpts));
	try {
		created.push(await buildThumbVersion(spec, identity, created[0] as string, pathOpts));
	} catch (error) {
		const message = `${spec.defaultQuality} thumb of ${buildMediaIdentifier(identity)}: ${(error as Error).message}`;
		console.warn(`[media] ${spec.model} thumb NOT built: ${message}`);
		return { created, errors: [message] };
	}
	return { created, errors: [] };
}

/** Regenerate a 3D record: web copy (converters are ledgered PHP-dead — naive copy). */
export async function regenerate3d(
	spec: MediaTypeSpec,
	identity: MediaIdentity,
	pathOpts: MediaPathOptions,
	rawExtension: string,
): Promise<string[]> {
	const source = resolveMasterSource(spec, identity, pathOpts, rawExtension);
	if (source === null) return [];
	return [
		await copyToQuality(
			spec,
			identity,
			spec.defaultQuality,
			source,
			spec.defaultExtension,
			pathOpts,
		),
	];
}
