/**
 * The one place this tool turns a component_image identity into a displayable
 * media path, shared by every action that shows one (overlay, gallery, image
 * download, PDF) so they never disagree on the tier. It answers WHERE, never
 * bytes: the web server serves the file (engineering/MEDIA_PROTECTION.md).
 */

import { config } from '../../../src/config/config.ts';
import { DedaloError, ok } from '../../../src/core/errors/index.ts';
import {
	type FileInfoEntry,
	scanContextFromItem,
	scanFilesInfo,
} from '../../../src/core/media/files_info.ts';
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
 * The served version of an ingested component_image: the default quality, else
 * any other browser-renderable tier, never an undrawable master (a `.tif` path
 * would be a broken image with no error). Returns the whole scan too, because
 * `image_overlay.ts` reads the master's georeference from it.
 */
export async function resolveRenderableImage(options: Record<string, unknown>) {
	const { spec, identity, pathOpts, items } = await resolveMediaToolContext(options);
	if (spec.model !== 'component_image') {
		throw new DedaloError('tool.unsupported_target', {
			message: `tool_uca_maps: an image lookup needs a component_image, got '${spec.model}'`,
			publicMessage: 'Only an image component can be used here.',
			coordinates: { component_tipo: identity.componentTipo, model: spec.model },
		});
	}

	const files_info = scanFilesInfo(spec, identity, pathOpts, scanContextFromItem(items[0]));

	// no file at all and no drawable file are different facts: the first is a
	// vanished upload, the second an image this tool cannot show
	const present = files_info.filter(
		(entry) => entry.file_exist && typeof entry.file_path === 'string',
	);
	if (present.length === 0) {
		throw new DedaloError('media.file_not_found', {
			message: `tool_uca_maps: no image file at all for ${identity.componentTipo}_${identity.sectionTipo}_${identity.sectionId}`,
			publicMessage: 'The image is no longer on the server.',
			coordinates: { section_tipo: identity.sectionTipo, section_id: identity.sectionId },
		});
	}

	const renderable = present.filter((entry) =>
		OVERLAY_EXTENSIONS.includes(String(entry.extension ?? '').toLowerCase()),
	);
	const served = renderable.find((entry) => entry.quality === spec.defaultQuality) ?? renderable[0];
	if (!served || typeof served.file_path !== 'string') {
		throw new DedaloError('tool.unsupported_target', {
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
 * The JPEG the PDF report embeds, thumb tier first: the report draws at most
 * 483x320 pt, and the default `1.5MB` tier would put ~45 MB into a 30-image
 * document. An install whose `DEDALO_IMAGE_EXTENSION` is not a JPEG gets
 * 'format', so the document says the format, not that the file is gone.
 */
export async function resolveEmbeddableImage(
	options: Record<string, unknown>,
): Promise<EmbeddableImage | EmbedRefusal> {
	const { spec, identity, pathOpts, files_info } = await resolveRenderableImage(options);

	const jpegs = files_info.filter(
		(entry): entry is FileInfoEntry & { extension: string } =>
			entry.file_exist &&
			EMBEDDABLE_EXTENSIONS.includes(String(entry.extension ?? '').toLowerCase()),
	);
	const [first] = jpegs;
	if (first === undefined) {
		return 'format';
	}

	const thumbQuality = config.media.thumb.quality;
	const chosen =
		jpegs.find((entry) => entry.quality === thumbQuality) ??
		jpegs.find((entry) => entry.quality === spec.defaultQuality) ??
		first;

	const location = buildMediaLocation(spec, identity, chosen.quality, chosen.extension, pathOpts);

	return { absolutePath: location.absolutePath, quality: chosen.quality };
}

/**
 * `get_image_file`: where an ingested image is served from. The options name the
 * IMAGE component, not the map record, so the `record_tipo` gate checks the
 * caller may read THAT section. The client keeps the answer in the object's
 * `properties.uca_maps.images[]` and builds the gallery from it locally.
 */
export async function getImageFile(ctx: ToolActionContext): Promise<ToolResponse> {
	const { served } = await resolveRenderableImage(ctx.options);
	return ok(
		{ file_path: served.file_path, quality: served.quality },
		{ requestId: toolRequestId(ctx) },
	);
}
