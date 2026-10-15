/**
 * external_image — `stage_external_image`: an image an object LINKS to on
 * another site (`properties.images[].url`, v6 `check_if_external_images`,
 * `special_tools.js:7765-7875`) is downloaded and staged, so the client hands
 * it to the SAME ingest a picked file takes (`image_upload.js`
 * `ingest_staged_image`): record, derivatives, empty-record cleanup.
 *
 * On by default, as in v6; an install that does not want its server fetching
 * URLs that came inside data sets `external_images_enabled: false`. Any public
 * site — the harvesting door (`harvestFetch`, engineering/OUTBOUND_SPEC.md §3)
 * refuses internal addresses, obeys robots.txt and paces each site, and only a
 * user who may write the map record, pressing the button, sets it off.
 *
 * Only what the associate picker accepts (JPEG, PNG), refused by the door on
 * the declared type before the body is read; the bytes are then sniffed by the
 * receiver against that type (`receiveUpload`), as an upload's are.
 */

import { DedaloError, ok } from '../../../src/core/errors/index.ts';
import { type HarvestDeps, harvestFetch } from '../../../src/core/harvest/harvest.ts';
import { receiveUpload } from '../../../src/core/media/ingest/upload.ts';
import { getToolConfigValue } from '../../../src/core/tools/config.ts';
import {
	type ToolActionContext,
	type ToolResponse,
	toolRequestId,
} from '../../../src/core/tools/module.ts';

/** The tool option that turns the import off: only a JSON `false` does. */
export const EXTERNAL_IMAGES_CONFIG_KEY = 'external_images_enabled';

/** The associate picker's own ceiling (`image_upload.js` IMAGE_UPLOAD_MAX_BYTES). */
export const EXTERNAL_IMAGE_MAX_BYTES = 100_000_000;

/** The staging dir an upload of this tool lands in (`image_upload.js`
 * IMAGE_UPLOAD_KEY_DIR): the ingest reads the file back from there. */
const IMAGE_KEY_DIR = 'image';

/** Declared media type → the extension the receiver sniffs the bytes against. */
const EXTENSION_BY_TYPE: Readonly<Record<string, string>> = {
	'image/jpeg': 'jpg',
	'image/png': 'png',
};

/** Seams: tests script the site and decide the switch without a config row. */
export interface ExternalImageDeps {
	readonly harvest?: HarvestDeps;
	readonly enabled?: () => Promise<boolean>;
}

/** Whether this install allows the import. The fallback covers an install
 * whose registration predates the option. */
export async function externalImagesEnabled(): Promise<boolean> {
	return (await getToolConfigValue('tool_uca_maps', EXTERNAL_IMAGES_CONFIG_KEY, true)) !== false;
}

/** The linked URL, refused unless it is an absolute http(s) address. */
function parseImageUrl(raw: unknown): URL {
	let url: URL | null = null;
	try {
		url = typeof raw === 'string' ? new URL(raw) : null;
	} catch {
		url = null;
	}
	if (url === null || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
		throw new DedaloError('request.invalid_options', {
			coordinates: { tool: 'tool_uca_maps' },
			message: 'stage_external_image needs an absolute http(s) url',
		});
	}
	return url;
}

/**
 * The name the record keeps as its original file name: the URL's last path
 * segment with the extension of what the site actually sent, since a
 * `/foto?id=3` or a `.jpg` that served a PNG would otherwise stage a name the
 * receiver refuses against the bytes.
 */
export function stagedFileName(url: URL, extension: string): string {
	const segment = url.pathname.split('/').pop() ?? '';
	let decoded = segment;
	try {
		decoded = decodeURIComponent(segment);
	} catch {
		// a malformed escape keeps the raw segment; the receiver sanitizes it
	}
	const stem = decoded.replace(/\.[^.]*$/, '').trim();
	return `${stem !== '' ? stem : 'external_image'}.${extension}`;
}

/**
 * STAGE_EXTERNAL_IMAGE — download one linked image into the caller's own
 * staging dir and answer the `file_data` an upload answers.
 *
 * Options: the map component's identity (the `record_tipo` gate, write level:
 * this exists to change that record) + `url`. A non-2xx answer is the site's
 * refusal, a plain failure (same rule as `wms.ts`). The action binds the real
 * door and the real switch.
 */
export async function stageExternalImage(
	ctx: ToolActionContext,
	deps: ExternalImageDeps = {},
): Promise<ToolResponse> {
	if (!(await (deps.enabled ?? externalImagesEnabled)())) {
		throw new DedaloError('tool.method_not_allowed', {
			coordinates: { tool: 'tool_uca_maps' },
			details: { method: 'stage_external_image' },
			message: `stage_external_image is off on this install (tool option "${EXTERNAL_IMAGES_CONFIG_KEY}")`,
		});
	}
	const url = parseImageUrl(ctx.options.url);

	const response = await harvestFetch(
		{
			url: url.toString(),
			hosts: 'public',
			expectContentType: Object.keys(EXTENSION_BY_TYPE),
			maxBytes: EXTERNAL_IMAGE_MAX_BYTES,
		},
		deps.harvest ?? {},
	);
	if (!response.ok) {
		throw new DedaloError('tool.action_failed', {
			coordinates: { tool: 'tool_uca_maps' },
			message: `The linked image answered HTTP ${String(response.status)}`,
		});
	}
	const mediaType = response.contentType.split(';')[0]?.trim() ?? '';
	const extension = EXTENSION_BY_TYPE[mediaType];
	if (extension === undefined) {
		throw new DedaloError('harvest.unexpected_type', {
			coordinates: { tool: 'tool_uca_maps' },
			details: { site: new URL(response.url).origin, content_type: mediaType },
			message: `The linked image was served as '${mediaType}'`,
		});
	}

	// the receiver refuses bytes that are not the declared type itself
	// (`media.upload_rejected`, its reason on the wire), as for an upload
	const staged = receiveUpload(
		{
			keyDir: IMAGE_KEY_DIR,
			fileName: stagedFileName(url, extension),
			chunked: false,
			chunkIndex: 0,
			totalChunks: 1,
			blob: response.bytes,
			uploadId: crypto.randomUUID().replace(/-/g, ''),
			// in-process caller: no browser form to carry a CSRF twin
			csrfToken: null,
		},
		ctx.userId,
		undefined,
		EXTERNAL_IMAGE_MAX_BYTES,
	);
	if (staged.tmpName === undefined) {
		throw new DedaloError('tool.action_failed', {
			coordinates: { tool: 'tool_uca_maps' },
			message: 'The linked image did not stage a file',
		});
	}

	return ok(
		{
			file_data: {
				key_dir: IMAGE_KEY_DIR,
				tmp_name: staged.tmpName,
				name: staged.name ?? null,
				extension: staged.extension ?? extension,
				chunked: false,
				chunk_index: 0,
				total_chunks: 1,
				complete: true,
				upload_id: staged.uploadId ?? null,
			},
		},
		{ requestId: toolRequestId(ctx) },
	);
}
