/**
 * IMAGE SVG OVERLAY — the edit-view display envelope (PHP component_image
 * create_default_svg_string_node / get_svg_file_path / get_base_svg_url).
 *
 * The client's image EDIT view does not point an <img> at the raster directly —
 * it loads an `<object type="image/svg+xml" data="{base_svg_url}">`, an SVG
 * envelope that embeds the raster via `<image xlink:href="{quality url}">` and
 * anchors the vector annotation layers ("Capas de dibujo"). When the read omits
 * `base_svg_url` (no envelope on disk) the client falls back to the placeholder
 * SVG and shows nothing. So every uploaded/regenerated image MUST also get its
 * SVG envelope, and the read MUST emit its URL.
 *
 * The envelope lives in a literal `svg` sub-folder of the image tree:
 *   MEDIA_PATH + /image + initial_media_path + /svg + additional_path + /<id>.svg
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { config } from '../../config/config.ts';
import { type MediaTypeSpec, mediaTypeOf } from '../concepts/media.ts';
import { DedaloError } from '../errors/dedalo_error.ts';
import { getModelByTipo } from '../ontology/resolver.ts';
import { replaceFirstHtmlTag } from '../resolve/html_text.ts';
import { writeAtomically } from './atomic.ts';
import { getDimensions } from './engine/imagemagick.ts';
import { managedFileSlots, moveToDeleted } from './file_ops.ts';
import { resolveMediaPathOptions } from './ontology_path.ts';
import {
	additionalPath,
	assertInsideMediaRoot,
	buildMediaIdentifier,
	buildMediaLocation,
	type MediaIdentity,
	type MediaPathOptions,
	requireMediaRoot,
} from './path.ts';
import { ENVELOPE_REFUSALS } from './svg_safety.ts';

/** A resolved SVG-envelope location (relative URL/path + absolute FS path). */
export interface SvgLocation {
	/** Media-root-relative path, leading slash (e.g. /image/svg/0/rsc29_rsc170_1.svg). */
	relativePath: string;
	/** Absolute filesystem path, confined inside the media root. */
	absolutePath: string;
}

/** Compute the SVG-envelope location for an image identity (PHP get_svg_file_path). */
export function svgOverlayLocation(
	spec: MediaTypeSpec,
	identity: MediaIdentity,
	pathOpts: MediaPathOptions,
): SvgLocation {
	const identifier = buildMediaIdentifier(identity);
	const bucket =
		pathOpts.additionalPathOverride != null && pathOpts.additionalPathOverride !== ''
			? pathOpts.additionalPathOverride
			: additionalPath(identity.sectionId, pathOpts.maxItemsFolder);
	// folder + initial_media_path + '/svg' + additional_path  (literal 'svg' segment)
	const relativeDir = `${spec.folder}${pathOpts.initialMediaPath}/svg${bucket}`;
	const relativePath = `${relativeDir}/${identifier}.svg`;
	const root = requireMediaRoot(pathOpts.mediaRoot);
	const absolutePath = assertInsideMediaRoot(`${root}${relativePath}`, root);
	return { relativePath, absolutePath };
}

/**
 * Build the default SVG envelope string (PHP create_default_svg_string_node):
 * an <svg> sized to the raster with one <g id="raster"><image xlink:href=…/>.
 * `rasterUrl` is the default-quality raster URL (what the client swaps on a
 * quality change).
 */
export function buildDefaultSvgString(width: number, height: number, rasterUrl: string): string {
	return `<svg version="1.1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0,0,${width},${height}"><g id="raster"><image width="${width}" height="${height}" xlink:href="${rasterUrl}"/></g></svg>`;
}

/** The default-quality raster URL used as the SVG's xlink:href (DEDALO_MEDIA_URL + relative path).
 * Exported for the regenerate drift-fix (media/repair.ts): the PERSISTED envelope must embed
 * exactly this relative URL — v6 regenerate_component rewrites it when it drifted. */
export function defaultRasterUrl(
	spec: MediaTypeSpec,
	identity: MediaIdentity,
	pathOpts: MediaPathOptions,
): string {
	const location = buildMediaLocation(
		spec,
		identity,
		spec.defaultQuality,
		spec.defaultExtension,
		pathOpts,
	);
	return `/dedalo/${config.mediaDir}${location.relativePath}`;
}

/**
 * Ensure the image's SVG envelope is on disk and in step with the raster (PHP
 * create_svg_file via regenerate_component). Reads the default-quality raster's
 * dimensions to size it. No-op (returns null) when that raster is absent.
 *
 * IT NEVER DESTROYS AN EXISTING ENVELOPE. PHP's regenerate_component
 * (class.component_image.php:1501-1513) `unlink`ed the file and wrote the default
 * template back, and the TS port inherited that — so every rebuild of a record's
 * derived tiers (a retouch deleted, a master replaced, a tool "Regenerate", the
 * post-delete tier resync in tools/versions.ts) silently threw away the vector
 * ANNOTATION LAYERS an archivist had drawn on the object. The layer data survives
 * in `lib_data`, so the record is not unrecoverable; what is destroyed is the
 * RENDERED overlay, which on a heritage image is scholarship — a curator's marks
 * on the object itself — and no derivative rebuild has any business deciding it
 * is disposable. Divergence recorded in
 * `engineering/wire_contract/WC-2026-08-09-image-svg-envelope-preserved.md`.
 *
 * So: absent (or unusable) → write the default template; present → keep every
 * layer and only RE-POINT the raster, which is the thing a rebuild can legitimately
 * have changed. The two branches are the same shape `media/repair.ts` already
 * chose for its own sweep; here it is the function's own contract, so no caller
 * can get it wrong by calling the obvious thing.
 */
export async function createDefaultSvgFile(
	spec: MediaTypeSpec,
	identity: MediaIdentity,
	pathOpts: MediaPathOptions,
): Promise<string | null> {
	if (spec.model !== 'component_image') return null;
	const rasterPath = buildMediaLocation(
		spec,
		identity,
		spec.defaultQuality,
		spec.defaultExtension,
		pathOpts,
	).absolutePath;
	if (!existsSync(rasterPath)) return null;

	// An unreadable raster is FATAL here. The previous `.catch(() => ({width:0,
	// height:0}))` wrote a 0x0 envelope, and a 0x0 <svg> renders as a blank edit
	// view — the record looks empty rather than broken, which is the worst of both.
	// The caller (regenerateImage) reports the failure; the record keeps its index.
	let dims: { width: number; height: number };
	try {
		dims = await getDimensions(rasterPath);
	} catch (error) {
		throw new Error(
			`svg envelope: cannot read the dimensions of ${rasterPath}: ${(error as Error).message}`,
		);
	}
	const rasterUrl = defaultRasterUrl(spec, identity, pathOpts);
	const location = svgOverlayLocation(spec, identity, pathOpts);

	const existing = readEnvelope(location.absolutePath);
	const svg =
		existing === null
			? buildDefaultSvgString(dims.width, dims.height, rasterUrl)
			: repointEnvelopeRaster(existing, dims.width, dims.height, rasterUrl);

	// Atomic like every other media write: the client fetches this envelope as an
	// <object>, so a half-written file is a blank edit view for whoever loads it
	// during the write.
	return writeAtomically(location.absolutePath, async (temp) => {
		writeFileSync(temp, svg);
	});
}

/**
 * The envelope currently on disk, or null when there is nothing worth keeping.
 *
 * "Nothing worth keeping" is deliberately narrow: absent, unreadable, or not an
 * `<svg>` root at all. A truncated write or a stray zero-byte file is debris, not
 * scholarship, and leaving it would leave the record's edit view showing the
 * placeholder forever. Anything that IS an svg is treated as authored content.
 */
function readEnvelope(absolutePath: string): string | null {
	if (!existsSync(absolutePath)) return null;
	let content: string;
	try {
		content = readFileSync(absolutePath, 'utf8');
	} catch {
		return null;
	}
	return /<svg[\s>]/i.test(content) ? content : null;
}

/**
 * Re-point an existing envelope at the raster it should depict, keeping every
 * other node — i.e. every annotation layer — byte for byte.
 *
 * Two edits, both on the ROOT `<svg>` and the raster `<image>` only:
 *  - the raster `<image>`'s `xlink:href`/`href` (the file may have moved host or
 *    tier since the envelope was authored: this is v6 regenerate_component's own
 *    drift fix, :1999-2012, and `media/repair.ts` does the same for its sweep);
 *  - the root's `width`/`height`/`viewBox` and the raster `<image>`'s size, when
 *    the rebuilt raster is a different size than the envelope was drawn against.
 *
 * The layer coordinates are NOT rescaled. A layer is drawn in the envelope's own
 * user space, and inventing a transform for it would move a curator's marks off
 * the features they annotate — silently, and with no record of the original
 * position. A size change is reported by the viewBox alone; the marks stay where
 * they were put.
 */
export function repointEnvelopeRaster(
	content: string,
	width: number,
	height: number,
	rasterUrl: string,
): string {
	let out = content;
	// Root <svg …> attributes (the first tag only).
	out = replaceFirstHtmlTag(out, /<svg\b/iy, (tag) => {
		let next = tag;
		next = next.replace(/\swidth="[^"]*"/i, ` width="${String(width)}"`);
		next = next.replace(/\sheight="[^"]*"/i, ` height="${String(height)}"`);
		next = next.replace(/\sviewBox="[^"]*"/i, ` viewBox="0,0,${String(width)},${String(height)}"`);
		return next;
	});
	// The raster <image …>: the FIRST one, which is the envelope's raster group
	// (the default template puts it there and every editor export preserves it).
	out = replaceFirstHtmlTag(out, /<image\b/iy, (tag) => {
		let next = tag;
		next = next.replace(/\swidth="[^"]*"/i, ` width="${String(width)}"`);
		next = next.replace(/\sheight="[^"]*"/i, ` height="${String(height)}"`);
		next = next.replace(/\s(xlink:href|href)="[^"]*"/gi, ` $1="${rasterUrl}"`);
		return next;
	});
	return out;
}

// ---------------------------------------------------------------------------
// Persisting the client's annotation layers
// ---------------------------------------------------------------------------

/**
 * A cap on an envelope, in bytes. It is a drawing over one image, not a corpus —
 * 8 MB is orders of magnitude more than any real layer set and still small enough
 * that a runaway export cannot fill a media volume one save at a time.
 */
const MAX_ENVELOPE_BYTES = 8 * 1024 * 1024;

/**
 * SVG CONSTRUCTS AN ENVELOPE MAY NOT CARRY — the table now lives in ./svg_safety.ts,
 * because the SERVING side needs the same list: the generated Apache/nginx rules and
 * the Bun media route decide from it which SVG population a file belongs to. Two hand
 * -written copies of a security rule drift, and the drift is invisible.
 *
 * The verdict stays DIFFERENT per consumer and that is deliberate: here each entry is
 * REFUSED, not stripped. The envelope is the one file under the media root whose bytes
 * come from a CLIENT (`svg_file_data`, exported by the vector editor); a drawing export
 * contains none of these, so a match means the payload is not what it claims to be —
 * and silently deleting part of an operator's save is exactly the "plausible-but-narrowed
 * result" this codebase forbids. The write fails, loudly, and `lib_data` (the layer
 * source of truth) is untouched either way. The UPLOAD path, by contrast, only notices
 * them: refusing a curator's SVG would be data loss, and the serving-side quarantine is
 * what makes it inert.
 */

/**
 * Persist the vector-editor's SVG string as the record's envelope (PHP
 * component_image::save → create_svg_file, class.component_image.php:119-133).
 *
 * The client's `update_draw_data` / `vector_editor.save_data` put BOTH halves in
 * the saved item: `lib_data` (the layers as JSON — the source of truth, which the
 * editor reloads from) and `svg_file_data` (the same drawing already rendered).
 * Only the first was ever stored: the rendered overlay had no server writer at
 * all, so the annotations existed in the database and nowhere the image itself was
 * shown. This is that writer.
 *
 * Atomic, confined to the media root, and gated by ENVELOPE_REFUSALS above.
 */
export async function writeSvgEnvelope(
	spec: MediaTypeSpec,
	identity: MediaIdentity,
	pathOpts: MediaPathOptions,
	svgString: string,
): Promise<string> {
	if (spec.model !== 'component_image') {
		const reason = `svg envelope: only component_image has one (got ${spec.model})`;
		throw new DedaloError('media.unsupported_operation', {
			message: reason,
			publicMessage: reason,
		});
	}
	if (typeof svgString !== 'string' || svgString.trim() === '') {
		throw new DedaloError('request.invalid_data', { message: 'svg envelope: empty payload' });
	}
	if (Buffer.byteLength(svgString, 'utf8') > MAX_ENVELOPE_BYTES) {
		const reason = `svg envelope: payload is larger than the ${String(MAX_ENVELOPE_BYTES)} byte cap`;
		throw new DedaloError('media.too_large', { message: reason, publicMessage: reason });
	}
	if (!/^\s*<svg[\s>]/i.test(svgString)) {
		throw new DedaloError('request.invalid_data', {
			message: 'svg envelope: payload does not start with an <svg> root element',
		});
	}
	for (const { pattern, what } of ENVELOPE_REFUSALS) {
		if (pattern.test(svgString)) {
			// PUBLIC: `what` is the refusal table's own English, never the payload.
			const reason = `svg envelope: refused — the payload carries ${what}. An annotation overlay is drawing markup only; nothing was written and the layer data in lib_data is unchanged`;
			throw new DedaloError('media.upload_rejected', { message: reason, publicMessage: reason });
		}
	}
	const location = svgOverlayLocation(spec, identity, pathOpts);
	return writeAtomically(location.absolutePath, async (temp) => {
		writeFileSync(temp, svgString);
	});
}

/**
 * The `svg_file_data` a saved component_image item carries, or null. The key is a
 * TEMPORAL CONTAINER (PHP's word): the client ships it inside the item so the
 * drawing needs no second round trip, and the SAVE PATH is what turns it into a
 * file. Exported so the save chokepoint reads it through one definition rather
 * than by string-matching a key it does not own.
 */
export function svgFileDataOf(item: unknown): string | null {
	if (item === null || typeof item !== 'object') return null;
	const value = (item as { svg_file_data?: unknown }).svg_file_data;
	return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * THE SAVE-SIDE WIRING of the two functions above — called from the record-write
 * chokepoint (`section_record/record_write.ts persistRecordKeys`) for every key
 * write it performs, so EVERY save door reaches it: the client API, the MCP
 * tools, the agent change-plan, the CSV/media imports.
 *
 * It is the port of PHP `component_image::save()`
 * (class.component_image.php:119-133), which iterates the component's data and
 * calls `create_svg_file($data_item->svg_file_data)` for every item carrying the
 * key — on EVERY save of the component, not only when the drawing changed, and
 * BEFORE `parent::save()` writes the row. Both properties are kept: the hook runs
 * on the value being persisted, and it runs before the write, so a refused
 * payload fails the save instead of following it.
 *
 * A write of anything other than the `media` column, of a non-image media
 * component, or of items with no `svg_file_data`, is a no-op — which is the
 * overwhelming majority of writes, and why the caller checks the column before
 * importing this module at all.
 */
export async function persistSvgEnvelopesForKeys(
	target: { sectionTipo: string; sectionId: number },
	writes: readonly { column: string; key: string; value: unknown }[],
): Promise<void> {
	for (const write of writes) {
		if (write.column !== 'media' || !Array.isArray(write.value)) continue;
		const model = await getModelByTipo(write.key);
		if (model !== 'component_image') continue;
		const spec = mediaTypeOf(model);
		if (spec === null) continue;
		let pathOpts: MediaPathOptions | null = null;
		for (const item of write.value as unknown[]) {
			const svgString = svgFileDataOf(item);
			if (svgString === null) continue;
			// Resolved once per component, and ONLY when there is something to write:
			// it reads the ontology and (for `additional_path`) the record itself.
			pathOpts ??= await resolveMediaPathOptions(write.key, target.sectionTipo, target.sectionId);
			await writeSvgEnvelope(
				spec,
				{
					componentTipo: write.key,
					sectionTipo: target.sectionTipo,
					sectionId: target.sectionId,
					// A translatable media component stores one item per lang and each
					// has its own identifier on disk (the same fan-out the delete walk
					// makes); the envelope belongs to the item's own lang.
					lang: (item as { lang?: string } | null)?.lang ?? null,
				},
				pathOpts,
				svgString,
			);
		}
	}
}

/**
 * The `base_svg_url` the read emits (PHP get_base_svg_url(test_file=true)):
 * the envelope URL when the file exists, else null (the client then shows the
 * placeholder). URL = DEDALO_MEDIA_URL + the svg relative path.
 */
export function baseSvgUrl(
	spec: MediaTypeSpec,
	identity: MediaIdentity,
	pathOpts: MediaPathOptions,
): string | null {
	if (spec.model !== 'component_image') return null;
	const location = svgOverlayLocation(spec, identity, pathOpts);
	if (!existsSync(location.absolutePath)) return null;
	// Media web base (NOT the relative literal): the envelope is fetched by the
	// BROWSER, so it must point at wherever media is actually served. The href
	// EMBEDDED in the envelope file (defaultRasterUrl) stays relative on purpose
	// — it resolves against the envelope's own fetch origin, keeping the
	// persisted file host-portable.
	return `${config.media.webBase}${location.relativePath}`;
}

/**
 * Whether ANY file of this identity exists on disk — every quality × extension
 * the type manages, thumb included, through `managedFileSlots` (the ONE census
 * behind duplicate, record-delete and record-restore).
 */
export function identityHasMediaFiles(
	spec: MediaTypeSpec,
	identity: MediaIdentity,
	pathOpts: MediaPathOptions,
): boolean {
	return managedFileSlots(spec).some(([quality, extension]) =>
		existsSync(buildMediaLocation(spec, identity, quality, extension, pathOpts).absolutePath),
	);
}

/**
 * THE ENVELOPE OUTLIVES EVERY QUALITY FILE (policy 2026-10-23). It is retired —
 * moved, never unlinked (No-hard-delete law) — to the `svg/…/deleted/` folder
 * only when the record holds NO file at all: not the masters, not the thumb, not
 * an alternate twin. Deleting ONE quality (even the default one) leaves the
 * record with a picture somewhere, and the envelope is its wrapper.
 *
 * PHP unlinked it as soon as the default quality was removed
 * (`component_image::remove_component_media_files :1643-1658`); that is NOT the
 * rule here — the reported defect is that removing every file left the wrapper
 * loading with a dead `<image>` href and the browser painted a broken-image icon
 * inside it (MEASURED on rsc29_rsc170_463937).
 */
export function retireOverlayIfNoMediaFiles(
	spec: MediaTypeSpec,
	identity: MediaIdentity,
	pathOpts: MediaPathOptions,
): string | null {
	if (spec.model !== 'component_image') return null;
	if (identityHasMediaFiles(spec, identity, pathOpts)) return null;
	const overlay = svgOverlayLocation(spec, identity, pathOpts);
	if (!existsSync(overlay.absolutePath)) return null;
	return moveToDeleted(overlay.absolutePath, { mediaRoot: pathOpts.mediaRoot });
}
