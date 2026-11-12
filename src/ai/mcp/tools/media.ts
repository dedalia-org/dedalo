/**
 * MEDIA tools — upload/attach a file to a media component and read back the
 * stored variants. The upload funnels into the ONE existing ingest engine
 * (receiveUpload sniff+stage → processUploadedFile → persistUploadedMedia):
 * there is no second media write path (review doc D4).
 *
 * File input is a `source` union:
 *   {kind:'path',   path}            — stdio/local agents; the path must
 *     resolve INSIDE DEDALO_MCP_MEDIA_IMPORT_DIR (realpath-checked, symlink
 *     escapes rejected); unset dir ⇒ the path source is DISABLED (fail-closed).
 *   {kind:'base64', data, filename}  — in-app/remote agents; capped at
 *     DEDALO_MCP_MEDIA_MAX_BYTES (default 10 MB) BEFORE decode.
 *
 * Gates: identifier gate → (registry allowlist) → level>=2 on the media
 * component → per-record projects scope. The ingest engine re-validates the
 * extension against the sniffed bytes (SEC-066 lineage), so a mislabeled
 * payload dies in staging.
 */

import { realpathSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import { z } from 'zod';
import { config } from '../../../config/config.ts';
import { readEnv } from '../../../config/env.ts';
import { readMatrixRecord } from '../../../core/db/matrix.ts';
import { DedaloError } from '../../../core/errors/dedalo_error.ts';
import { processUploadedFile } from '../../../core/media/ingest/process_uploaded_file.ts';
import { receiveUpload } from '../../../core/media/ingest/upload.ts';
import { resolveMediaToolContext } from '../../../core/media/tool_support.ts';
import { persistUploadedMedia } from '../../../core/media/tools/files_info_persist.ts';
import {
	getColumnNameByModel,
	getMatrixTableFromTipo,
	getModelByTipo,
} from '../../../core/ontology/resolver.ts';
import { assertValidTipo } from '../../../core/search/identifier_gate.ts';
import type { Principal } from '../../../core/security/permissions.ts';
import { defineTool, type ToolSpec } from '../tool_spec.ts';
import { resolveFieldReference } from './discovery.ts';

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

export type MediaSource =
	| { kind: 'path'; path: string }
	| { kind: 'base64'; data: string; filename: string };

/** Gate + load the bytes of a media source (fail-closed on every branch). */
export async function loadMediaSource(
	source: MediaSource,
): Promise<{ bytes: Uint8Array; fileName: string }> {
	// Fail CLOSED on a misconfigured cap: a non-numeric / non-positive value
	// (e.g. "10MB") must fall back to the default, never to NaN — every
	// `size > NaN` bound is false, which would remove the cap entirely (F1).
	const parsedCap = Number(readEnv('DEDALO_MCP_MEDIA_MAX_BYTES'));
	const maxBytes = Number.isFinite(parsedCap) && parsedCap > 0 ? parsedCap : DEFAULT_MAX_BYTES;

	if (source.kind === 'path') {
		const importDir = readEnv('DEDALO_MCP_MEDIA_IMPORT_DIR');
		if (importDir === undefined || importDir.trim() === '') {
			throw new DedaloError('mcp.media_path_disabled', {
				publicMessage: 'File-path media sources are disabled on this deployment.',
			});
		}
		if (!isAbsolute(source.path)) {
			throw new DedaloError('request.invalid', {
				publicMessage: 'media source.path must be absolute.',
			});
		}
		// Realpath BOTH sides: a symlink inside the import dir pointing outside
		// must not escape; a `..` traversal must not either.
		let realRoot: string;
		let realFile: string;
		try {
			realRoot = realpathSync(resolve(importDir));
			realFile = realpathSync(resolve(source.path));
		} catch {
			throw new DedaloError('resource.not_found', {
				publicMessage: `media source.path does not exist: ${source.path}`,
			});
		}
		if (realFile !== realRoot && !realFile.startsWith(realRoot + sep)) {
			throw new DedaloError('request.invalid', {
				publicMessage: 'media source.path escapes DEDALO_MCP_MEDIA_IMPORT_DIR.',
			});
		}
		const file = Bun.file(realFile);
		if (file.size > maxBytes) {
			throw new DedaloError('mcp.media_too_large', {
				publicMessage: `File is ${file.size} bytes (max ${maxBytes}).`,
			});
		}
		return {
			bytes: new Uint8Array(await file.arrayBuffer()),
			fileName: realFile.split(sep).pop() ?? 'upload.bin',
		};
	}

	// base64: cap BEFORE decode (4/3 expansion bound), then decode.
	if (source.data.length > (maxBytes * 4) / 3 + 4) {
		throw new DedaloError('mcp.media_too_large', {
			publicMessage: `Encoded payload exceeds the ${maxBytes}-byte cap.`,
		});
	}
	let bytes: Uint8Array;
	try {
		bytes = Uint8Array.from(Buffer.from(source.data, 'base64'));
	} catch {
		throw new DedaloError('request.invalid', {
			publicMessage: 'media source.data is not valid base64.',
		});
	}
	if (bytes.byteLength === 0) {
		throw new DedaloError('request.invalid', {
			publicMessage: 'media source.data decoded to zero bytes.',
		});
	}
	if (bytes.byteLength > maxBytes) {
		throw new DedaloError('mcp.media_too_large', {
			publicMessage: `File is ${bytes.byteLength} bytes (max ${maxBytes}).`,
		});
	}
	if (source.filename.trim() === '') {
		throw new DedaloError('request.invalid', {
			publicMessage: 'media source.filename is required for base64.',
		});
	}
	return { bytes, fileName: source.filename };
}

async function assertRecordInScope(
	principal: Principal,
	sectionTipo: string,
	sectionId: number,
): Promise<void> {
	const { principalCanAccessRecord } = await import('../../../core/security/record_scope.ts');
	if (!(await principalCanAccessRecord(sectionTipo, sectionId, principal))) {
		throw new DedaloError('perm.out_of_scope', {
			message: `Record is out of the user scope (${sectionTipo}/${sectionId})`,
			coordinates: { section_tipo: sectionTipo, section_id: sectionId },
		});
	}
}

/**
 * Upload a file and attach it to a media component of a record: stage
 * (sniff-validated), ingest (per-model regenerate — component_image builds
 * its derived qualities; component_av returns a job id to poll), persist the
 * files_info onto the record item.
 */
export async function uploadMedia(
	principal: Principal,
	input: {
		section_tipo: string;
		section_id: number;
		field: string;
		source: MediaSource;
		lang?: string;
	},
): Promise<{
	section_tipo: string;
	section_id: number;
	tipo: string;
	files_info: unknown;
	/**
	 * Non-empty when the file WAS stored and indexed but a derived tier (thumb,
	 * web quality, SVG envelope) could not be built — see
	 * IngestResult.derivativeErrors for why that is not an upload failure. The
	 * agent's channel is the tool result itself: it has no errors[] and must not
	 * be told the upload failed when the record now holds the original.
	 */
	derivative_errors: string[];
	job_id?: unknown;
}> {
	const sectionTipo = assertValidTipo(input.section_tipo, 'mcp.media.section_tipo');
	const fieldTipo = await resolveFieldReference(sectionTipo, input.field);
	// THE WRITE DOOR (closure Step 3): the section floor, the dd128-aware pair,
	// the record scope — the raw section-less getPermissions this door used to
	// read never saw the own-record rule. The id is an INTEGER, never floored.
	const { authorizeRecordAccess } = await import('../../../core/security/write_door.ts');
	const { sectionId } = await authorizeRecordAccess(
		principal,
		{ section_tipo: sectionTipo, component_tipo: fieldTipo, section_id: input.section_id },
		{ mode: 'write', level: 2, sectionFloor: 1, door: 'mcp.upload_media' },
	);

	const { bytes, fileName } = await loadMediaSource(input.source);

	// Stage exactly like the HTTP endpoint's single-shot branch: the receiver
	// sniffs the magic bytes against the extension and confines the write to
	// the per-user staging dir.
	const keyDir = `mcp_${crypto.randomUUID()}`;
	const staged = receiveUpload(
		// csrfToken is the HTTP endpoint's form-field CSRF twin; this in-process
		// caller never crosses a browser boundary, so there is nothing to echo.
		{
			keyDir,
			fileName,
			chunked: false,
			chunkIndex: 0,
			totalChunks: 1,
			blob: bytes,
			// One transfer, one identity: this caller stages the whole file in a
			// single shot, so it supplies its own id rather than letting the receiver
			// derive one from the file name.
			uploadId: crypto.randomUUID().replace(/-/g, ''),
			csrfToken: null,
		},
		principal.userId,
	);
	const tmpName = staged.tmpName;
	const extension = staged.extension;
	if (tmpName === undefined || extension === undefined || extension === '') {
		throw new DedaloError('request.invalid', {
			publicMessage: `Could not stage '${fileName}' (missing extension?).`,
		});
	}

	// Ingest + persist — the same path tool_upload's process_uploaded_file runs.
	const { spec, identity, pathOpts } = await resolveMediaToolContext({
		tipo: fieldTipo,
		section_tipo: sectionTipo,
		section_id: sectionId,
		lang: input.lang,
	});
	const result = await processUploadedFile({
		spec,
		identity,
		pathOpts,
		userId: principal.userId,
		keyDir,
		tmpName,
		extension,
	});
	await persistUploadedMedia({
		sectionTipo: identity.sectionTipo,
		sectionId: identity.sectionId,
		componentTipo: identity.componentTipo,
		lang: identity.lang,
		filesInfo: result.filesInfo,
		originalFileName: result.originalFileName,
		originalNormalizedName: result.originalFileName,
	});
	// AFTER the persist commits: the transcode writes its own files_info back, and
	// must not race the write above (see IngestResult.startTranscode).
	const jobId = result.startTranscode?.() ?? null;
	return {
		section_tipo: sectionTipo,
		section_id: sectionId,
		tipo: fieldTipo,
		files_info: result.filesInfo,
		derivative_errors: result.derivativeErrors.map(
			(message) =>
				`${result.originalFileName}: imported, but a derivative could not be built — ${message}`,
		),
		job_id: jobId,
	};
}

/**
 * Read the stored media variants of a media component: the files_info entries
 * (quality, existence, relative path) plus the server URL of each existing
 * variant.
 *
 * TWO GATES, in order (P1-3 / SEC-06, 2026-09-03): the read door's COMPONENT
 * key on (section_tipo, field) — the SECTION read grant AND the component's
 * own, the pair the human read demands, the read twin of the level >= 2
 * `uploadMedia` asserts — and THEN the record scope. Before, only the scope
 * ran, so a caller holding the section but level 0 on the media component
 * still received every variant's path and a fetch URL; and a caller granted
 * the component WITHOUT its section (SEC-11's shape) was served here what the
 * record page refused. The component key runs FIRST so a denied caller learns
 * nothing about the record's scope.
 */
export async function getMediaInfo(
	principal: Principal,
	input: { section_tipo: string; section_id: number; field: string },
): Promise<{
	items: {
		quality: string;
		url: string | null;
		file_path: string | null;
		extension: string | null;
	}[];
}> {
	const sectionTipo = assertValidTipo(input.section_tipo, 'mcp.media.section_tipo');
	const sectionId = Math.floor(input.section_id);
	const fieldTipo = await resolveFieldReference(sectionTipo, input.field);
	const { authorizeComponentRead } = await import('../../../core/security/read_door.ts');
	await authorizeComponentRead(
		{ principal, door: 'mcp.dedalo_get_media_info' },
		{ sectionTipo, componentTipo: fieldTipo, sectionId },
	);
	await assertRecordInScope(principal, sectionTipo, sectionId);

	const model = (await getModelByTipo(fieldTipo)) ?? '';
	const column = getColumnNameByModel(model);
	const table = await getMatrixTableFromTipo(sectionTipo);
	if (table === null || column === null) {
		throw new DedaloError('resource.not_found', {
			publicMessage: `'${fieldTipo}' does not resolve to stored media.`,
		});
	}
	const record = await readMatrixRecord(table, sectionTipo, sectionId);
	const columnData = record?.columns[column as keyof typeof record.columns];
	const items = (columnData as Record<string, unknown> | null)?.[fieldTipo];
	const entries: {
		quality: string;
		url: string | null;
		file_path: string | null;
		extension: string | null;
	}[] = [];
	for (const item of Array.isArray(items) ? items : []) {
		const filesInfo = (item as { files_info?: unknown } | null)?.files_info;
		for (const entry of Array.isArray(filesInfo) ? filesInfo : []) {
			const info = entry as {
				quality?: string;
				file_exist?: boolean;
				file_path?: string | null;
				extension?: string | null;
				external?: boolean;
			};
			const filePath = info.file_path ?? null;
			entries.push({
				quality: info.quality ?? '',
				file_path: filePath,
				extension: info.extension ?? null,
				url:
					info.file_exist === true && filePath !== null
						? info.external === true
							? filePath
							: `${config.media.webBase}${filePath}`
						: null,
			});
		}
	}
	return { items: entries };
}

// ---------------------------------------------------------------------------
// Specs
// ---------------------------------------------------------------------------

const sourceShape = z.union([
	z.object({
		kind: z.literal('path'),
		path: z
			.string()
			.describe('Absolute file path INSIDE DEDALO_MCP_MEDIA_IMPORT_DIR (else rejected).'),
	}),
	z.object({
		kind: z.literal('base64'),
		data: z.string().describe('Base64-encoded file bytes (size-capped).'),
		filename: z.string().describe('Original file name incl. extension, e.g. "photo.jpg".'),
	}),
]);

export const MEDIA_SPECS: ToolSpec[] = [
	defineTool({
		name: 'dedalo_upload_media',
		title: 'Upload media to a record',
		description:
			'Upload a file (path inside the configured import dir, or base64) and ' +
			'attach it to a media field (image/av/pdf/svg/3d) of a record. Images ' +
			'regenerate their derived qualities synchronously; AV returns a job_id. ' +
			'A non-empty derivative_errors means the file IS stored and indexed but ' +
			'a derived tier is missing (rebuildable) — it is not an upload failure.',
		tier: 'agent',
		write: true,
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: false,
		},
		inputShape: {
			section_tipo: z.string().describe('The record section tipo.'),
			section_id: z.number().describe('The record id.'),
			field: z.string().describe('The media field (tipo or label), e.g. "Image".'),
			source: sourceShape,
			lang: z.string().optional().describe('Language for translatable media (rare).'),
		},
		handler: uploadMedia,
	}),
	defineTool({
		name: 'dedalo_get_media_info',
		title: 'Get media variants',
		description:
			'Read the stored variants of a media field on a record: quality, ' +
			'relative path, and the server URL of each existing file. Use it to ' +
			'verify an upload or fetch a rendering URL.',
		tier: 'agent',
		write: false,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputShape: {
			section_tipo: z.string().describe('The record section tipo.'),
			section_id: z.number().describe('The record id.'),
			field: z.string().describe('The media field (tipo or label).'),
		},
		handler: getMediaInfo,
	}),
];
