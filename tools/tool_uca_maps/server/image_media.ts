/**
 * image_media — the ONE place this tool turns a component_image identity into
 * a browser-displayable media path, plus the `get_image_file` action that
 * exposes it.
 *
 * TWO CALLERS, ONE ANSWER. `image_overlay.ts` (fila #11, hito 13) needs it to
 * draw a raster on the map; the ASSOCIATED IMAGE of fila #3 ("asociar una
 * imagen al objeto y consultar la galería") needs exactly the same lookup and
 * nothing else — no georeference, no `gdalinfo` run. Splitting the resolution
 * out is what keeps a gallery association from paying for a GDAL probe it has
 * no use for, and keeps the two from drifting on WHICH tier is served.
 *
 * WHAT IS NEVER DONE HERE: serving bytes. The answer is a media-root-relative
 * path the browser then requests from the WEB SERVER, which is the only thing
 * in the file-serving path (engineering/MEDIA_PROTECTION.md hard rule 1). The
 * caller's own session cookie is what authorises that request; this action
 * only answers WHERE, and only for a record its `record_tipo` gate already
 * said the caller may read.
 */

import { config } from '../../../src/config/config.ts';
import { DedaloError, ok } from '../../../src/core/errors/index.ts';
import { scanContextFromItem, scanFilesInfo } from '../../../src/core/media/files_info.ts';
import { buildMediaLocation } from '../../../src/core/media/path.ts';
import { resolveMediaToolContext } from '../../../src/core/media/tool_support.ts';
import {
	type ToolActionContext,
	type ToolResponse,
	toolRequestId,
} from '../../../src/core/tools/module.ts';

/** What a browser can put in an `<img>`. The picture is drawn from ONE of
 * these, never from the raw master (`.tif`/`.psd` render nowhere). */
export const OVERLAY_EXTENSIONS: readonly string[] = ['jpg', 'jpeg', 'png', 'webp', 'avif', 'gif'];

/** A resolved, displayable version of an ingested image. */
export interface RenderableImage {
	/** media-root-relative, the shape `files_info` stores — what the BROWSER
	 * asks the web server for. */
	file_path: string;
	quality: string;
}

/**
 * The served version of an ingested component_image, or a refusal.
 *
 * Prefers the install's DEFAULT quality — the web derivative the ingest built
 * — and only falls back to another existing, browser-renderable tier when it
 * did not. The master is deliberately never a candidate: a `.tif` upload has
 * a perfectly good record and a file the browser cannot draw, and handing its
 * path back would produce a broken image with no error anywhere.
 *
 * Returns the full media context too, because `image_overlay.ts` needs the
 * MASTER from the same scan to read a georeference off it — re-scanning would
 * be a second pass over the same directory for the same record.
 */
export async function resolveRenderableImage(options: Record<string, unknown>) {
	const { spec, identity, pathOpts, items } = await resolveMediaToolContext(options);
	if (spec.model !== 'component_image') {
		throw new DedaloError('request.invalid_model', {
			message: `tool_uca_maps: an image lookup needs a component_image, got '${spec.model}'`,
			publicMessage: 'Only an image component can be used here.',
			coordinates: { component_tipo: identity.componentTipo, model: spec.model },
		});
	}

	const files_info = scanFilesInfo(spec, identity, pathOpts, scanContextFromItem(items[0]));

	const renderable = files_info.filter(
		(entry) =>
			entry.file_exist &&
			typeof entry.file_path === 'string' &&
			OVERLAY_EXTENSIONS.includes(String(entry.extension ?? '').toLowerCase()),
	);
	const served = renderable.find((entry) => entry.quality === spec.defaultQuality) ?? renderable[0];
	if (!served || typeof served.file_path !== 'string') {
		throw new DedaloError('tool.target_not_found', {
			message: `tool_uca_maps: no renderable image file for ${identity.componentTipo}_${identity.sectionTipo}_${identity.sectionId}`,
			publicMessage: 'The uploaded image has no version this browser can display.',
			coordinates: { section_tipo: identity.sectionTipo, section_id: identity.sectionId },
		});
	}

	return {
		spec,
		identity,
		pathOpts,
		files_info,
		served: { file_path: served.file_path, quality: served.quality } as RenderableImage,
	};
}

/** The only format the PDF writer embeds without re-encoding anything. */
const EMBEDDABLE_EXTENSIONS: readonly string[] = ['jpg', 'jpeg'];

/** Why a picture is not in the report — the two facts are different and the
 * document says which. */
export type EmbedRefusal = 'format' | 'missing';

export interface EmbeddableImage {
	absolutePath: string;
	quality: string;
}

/**
 * The version of an ingested image the PDF REPORT embeds — a different
 * question from what a browser displays, and answered differently on purpose.
 *
 * SMALLEST FIRST. `resolveRenderableImage` serves the install's default
 * quality, which is `1.5MB` out of the box — a tier whose name states its own
 * budget. The report draws a picture at most 483x320 pt, so embedding that
 * tier would put ~45 MB into a 30-image document and then base64 it to ~60 MB
 * through one JSON envelope (review finding, hito 16). The thumb tier carries
 * more than enough pixels for the size actually placed, so it is preferred and
 * the default quality is only the fallback.
 *
 * JPEG ONLY, AND IT SAYS SO. `DEDALO_IMAGE_EXTENSION` is operator-configurable;
 * an install that sets it to `png` or `webp` has a perfectly good gallery and
 * a report that can embed none of it. Rather than call that "missing", this
 * returns the reason, so the document can distinguish "this format cannot be
 * embedded" from "this file is gone".
 */
export async function resolveEmbeddableImage(
	options: Record<string, unknown>,
): Promise<EmbeddableImage | EmbedRefusal> {
	const { spec, identity, pathOpts, files_info } = await resolveRenderableImage(options);

	const jpegs = files_info.filter(
		(entry) =>
			entry.file_exist &&
			EMBEDDABLE_EXTENSIONS.includes(String(entry.extension ?? '').toLowerCase()),
	);
	if (jpegs.length === 0) {
		return 'format';
	}

	const thumbQuality = config.media.thumb.quality;
	const chosen =
		jpegs.find((entry) => entry.quality === thumbQuality) ??
		jpegs.find((entry) => entry.quality === spec.defaultQuality) ??
		jpegs[0];
	if (!chosen || typeof chosen.extension !== 'string') {
		return 'missing';
	}

	const location = buildMediaLocation(spec, identity, chosen.quality, chosen.extension, pathOpts);

	return { absolutePath: location.absolutePath, quality: chosen.quality };
}

/**
 * GET_IMAGE_FILE — where an ingested image is served from.
 *
 * Options: `tipo` / `section_tipo` / `section_id` — the IMAGE component's
 * identity (rsc29/rsc170/<new id>), not the map record's, so the
 * `record_tipo` gate asserts the caller may read THAT section. Same gate
 * reasoning as `get_image_overlay`, which this action is the
 * georeference-less half of.
 *
 * The client stores the answer next to the object (fila #3's
 * `properties.uca_maps.images[]`) and rebuilds every gallery thumbnail from
 * it locally, so a gallery of thirty images costs zero further requests.
 */
export async function getImageFile(ctx: ToolActionContext): Promise<ToolResponse> {
	const { served } = await resolveRenderableImage(ctx.options);
	return ok(
		{ file_path: served.file_path, quality: served.quality },
		{ requestId: toolRequestId(ctx) },
	);
}
