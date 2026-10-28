/**
 * tool_upload server module — process_uploaded_file (PHP tool_upload).
 *
 * Consumes a staged upload (already received + validated by the upload endpoint)
 * and ingests it: add_file into the requested quality tier (the original tier
 * unless the client's `quality` says otherwise) + per-type regenerate. Gates
 * level>=2 on the record (write). The staged tmp_name/key_dir come from the
 * upload receiver; the extension is re-validated in add_file, the quality in
 * assertValidQuality.
 */

import { existsSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { NO_LANG } from '../../../src/config/data_langs.ts';
import { DedaloError, ok } from '../../../src/core/errors/index.ts';
import { sanitizeSegment, stagingDir } from '../../../src/core/media/ingest/add_file.ts';
import { processUploadedFile } from '../../../src/core/media/ingest/process_uploaded_file.ts';
import { buildMediaIdentifier } from '../../../src/core/media/path.ts';
import { resolveMediaToolContext } from '../../../src/core/media/tool_support.ts';
import {
	nameKeysForQuality,
	persistUploadedMedia,
} from '../../../src/core/media/tools/files_info_persist.ts';
import { getModelByTipo, getTranslatableByTipo } from '../../../src/core/ontology/resolver.ts';
import { currentDataLang } from '../../../src/core/resolve/request_lang.ts';
import { saveComponentData } from '../../../src/core/section/record/save_component.ts';
import { MEDIA_JOB_STATUS_ACTION } from '../../../src/core/tools/job_status.ts';
import {
	type ToolActionContext,
	type ToolResponse,
	type ToolServerModule,
	toolRequestId,
} from '../../../src/core/tools/module.ts';

/**
 * component_json (PHP component_json::add_file + process_uploaded_file): the staged
 * .json file's parsed content REPLACES the component value, then the staged file is
 * deleted. No media tier, no files_info. Invalid JSON is refused and writes nothing.
 */
async function processUploadedJson(
	ctx: ToolActionContext,
	componentTipo: string,
): Promise<ToolResponse> {
	const fileData = (ctx.options.file_data ?? {}) as Record<string, unknown>;
	const extension = String(fileData.extension ?? '').toLowerCase();
	if (extension !== 'json') {
		const reason = `Only .json files can be uploaded into this field (got '.${extension}')`;
		throw new DedaloError('media.upload_rejected', { message: reason, publicMessage: reason });
	}
	const dir = stagingDir(ctx.userId, String(fileData.key_dir ?? ctx.options.key_dir ?? ''));
	const source = resolve(dir, sanitizeSegment(String(fileData.tmp_name ?? '')));
	if (!existsSync(source)) {
		throw new DedaloError('media.file_not_found', {
			message: 'Staged upload not found',
			publicMessage: 'Staged upload not found',
			coordinates: { source },
		});
	}
	const originalFileName = String(fileData.name ?? fileData.tmp_name ?? '');
	let value: unknown;
	try {
		value = JSON.parse(await Bun.file(source).text());
	} catch {
		const reason = `${originalFileName}: the content is not valid JSON`;
		throw new DedaloError('media.upload_rejected', { message: reason, publicMessage: reason });
	}
	const sectionTipo = String(ctx.options.section_tipo ?? '');
	const sectionId = Number(ctx.options.section_id);
	const save = await saveComponentData({
		componentTipo,
		sectionTipo,
		sectionId,
		lang: (await getTranslatableByTipo(componentTipo)) ? currentDataLang() : NO_LANG,
		userId: ctx.userId,
		changedData: [{ action: 'set_data', value: [{ id: 1, value }] }],
	});
	if (!save.ok) {
		throw new DedaloError('record.save_failed', {
			message: 'tool_upload: saving the uploaded JSON failed',
			coordinates: {
				component_tipo: componentTipo,
				section_tipo: sectionTipo,
				section_id: sectionId,
			},
			cause: save,
		});
	}
	unlinkSync(source);
	return ok(
		{ original_file_name: originalFileName, extension, derivative_errors: [] },
		{ requestId: toolRequestId(ctx) },
	);
}

async function processUploaded(ctx: ToolActionContext): Promise<ToolResponse> {
	const componentTipo = String(ctx.options.tipo ?? ctx.options.component_tipo ?? '');
	if ((await getModelByTipo(componentTipo)) === 'component_json') {
		return processUploadedJson(ctx, componentTipo);
	}
	const { spec, identity, pathOpts } = await resolveMediaToolContext(ctx.options);
	const fileData = (ctx.options.file_data ?? {}) as Record<string, unknown>;
	const userId = ctx.userId;
	// The tier the client asked for (tool_upload.js :224 —
	// caller.context.target_quality, else features.default_target_quality).
	// null/absent means the original tier; processUploadedFile validates it.
	const quality = typeof ctx.options.quality === 'string' ? ctx.options.quality : undefined;
	const result = await processUploadedFile({
		spec,
		identity,
		pathOpts,
		userId,
		keyDir: String(fileData.key_dir ?? ctx.options.key_dir ?? ''),
		tmpName: String(fileData.tmp_name ?? ''),
		extension: String(fileData.extension ?? ''),
		quality,
	});
	// Persist the fresh files_info + the name keys to the record so the client
	// renders the NEW image (not the stale/placeholder). Without this the upload
	// only touched the disk; the stored media data stayed on the old file.
	await persistUploadedMedia({
		sectionTipo: identity.sectionTipo,
		sectionId: identity.sectionId,
		componentTipo: identity.componentTipo,
		lang: identity.lang,
		filesInfo: result.filesInfo,
		originalFileName: String(fileData.tmp_name ?? result.originalFileName),
		originalNormalizedName: `${buildMediaIdentifier(identity)}.${result.extension}`,
		// Provenance follows the tier the file landed in (PHP :778).
		nameKeys: nameKeysForQuality(spec, quality),
	});
	// AFTER the persist commits: the transcode writes its own files_info back,
	// and must not race the write above (see IngestResult.startTranscode).
	const jobId = result.startTranscode?.() ?? null;

	// Activity audit (PHP logger 'UPLOAD COMPLETE' code 11,
	// tool_upload :49). PHP serializes the whole file_data blob into the
	// payload as a JSON STRING — mirrored here, including the shape.
	{
		const { logActivity, hostFromClientIp } = await import(
			'../../../src/core/api/handlers/activity_log.ts'
		);
		await logActivity({
			what: 'UPLOAD COMPLETE',
			tipo: identity.componentTipo,
			userId,
			host: hostFromClientIp(ctx.clientIp),
			data: {
				msg: 'Upload file complete. Processing uploaded file',
				file_data: JSON.stringify(fileData),
			},
		});
	}
	// A derivative failure does NOT fail the upload: add_file has already moved
	// the staged file and the persist above indexed it, so `result:false` here
	// would tell the operator nothing landed while the record says otherwise
	// (see IngestResult.derivativeErrors). It is still a real failure, so it
	// must reach the screen. Envelope v2 has no success `msg`, so it rides in
	// the payload as `derivative_errors` — the client half of this contract
	// (render_tool_upload.js, which used to read response.msg) is the client
	// sweeper's.
	const derivativeErrors = result.derivativeErrors.map(
		(message) =>
			`${result.originalFileName}: imported, but a derivative could not be built — ${message}`,
	);
	// `job_id` stays a TOP-LEVEL extension key (the transcode poll handle the
	// client reads by name); the rest is payload.
	return ok(
		{
			original_file_name: result.originalFileName,
			extension: result.extension,
			files_info: result.filesInfo,
			derivative_errors: derivativeErrors,
		},
		{ requestId: toolRequestId(ctx), extend: { job_id: jobId } },
	);
}

export const tool: ToolServerModule = {
	name: 'tool_upload',
	apiActions: {
		// record_tipo (closure Step 3 review r7; WC-2026-09-30-media-pair-scope): the
		// handler writes ONE component — the master file and the files_info of
		// options.tipo / component_tipo — so the gate asks the (section, COMPONENT)
		// pair at write level, not only the section: a profile explicitly denied the
		// media component can no longer replace its file through the section grant.
		// The kind refuses a payload whose tipo and component_tipo disagree, so the
		// component resolveMediaToolContext acts on IS the authorized one.
		process_uploaded_file: { permission: 'record_tipo', minLevel: 2, handler: processUploaded },
		// DEC-22a: poll the transcode job started by process_uploaded_file (the
		// job_id in its response) — serves the client-shaped status frame().
		get_job_status: MEDIA_JOB_STATUS_ACTION,
	},
};
