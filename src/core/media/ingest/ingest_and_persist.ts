/**
 * THE INGEST DOOR — every upload route ingests a staged file through here.
 *
 * An upload is three steps in a fixed order, and before this module every
 * caller (tool_upload, the MCP `upload_media` tool, tool_import_files,
 * tool_import_zotero, the two acquisition tools) wrote them out itself:
 *
 *  1. `processUploadedFile` — move the staged file into the media tree and
 *     build the derivatives. For av it also CLAIMS the component's build slot
 *     (A1-01, `claimAvBuildTarget`): one build per component;
 *  2. `persistUploadedMedia` — write the fresh files_info onto the record;
 *  3. start the deferred av transcode, AFTER step 2 commits (both write the
 *     same jsonb key — see IngestResult.startTranscode).
 *
 * The claim taken in step 1 is held until the transcode adopts it in step 3. A
 * caller whose step 2 threw never reached step 3, and a forgotten release left
 * the component refusing every upload and build until the process restarted —
 * tool_import_files had exactly that bug. So the release lives HERE, in a
 * `finally`, once. `ingest_door_tripwire` holds that nothing else imports
 * `processUploadedFile`.
 *
 * Two shapes:
 *  - `ingestAndPersist` — the three steps at once (every one-file door);
 *  - `ingestAndPersistDeferred` — steps 1-2 now, step 3 handed back as a
 *    `DeferredTranscode` the caller MUST settle (`start` or `release`, in a
 *    `finally`): for a batch whose transcodes may start only once every file
 *    is in (tool_numisdata_acquisition — a face rolled back must not transcode).
 */

import { type MediaNameKeys, persistUploadedMedia } from '../tools/files_info_persist.ts';
import {
	type IngestInput,
	type IngestResult,
	processUploadedFile,
} from './process_uploaded_file.ts';

/** What the record half (persistUploadedMedia) needs beyond the ingest's own result. */
export interface IngestRecordOptions {
	/** The name the curator recognises; absent or '' → the stored file name. */
	originalFileName?: string;
	/** Which name trio the upload stamps (nameKeysForQuality); absent → 'original'. */
	nameKeys?: MediaNameKeys;
}

/** The ingest's result without its job starters (they are this module's business). */
export type IngestedUpload = Omit<IngestResult, 'startTranscode' | 'releaseBuildClaim'>;

/** `ingestAndPersist`'s answer: the ingest plus the av transcode it started (or null). */
export interface PersistedUpload extends IngestedUpload {
	transcodeJobId: string | null;
}

/** The av transcode of a deferred ingest, settled by the caller (see the module header). */
export interface DeferredTranscode {
	/** Start it (adopts the build claim); null when the ingest offered none. Releases the claim even when the start throws. */
	start(): string | null;
	/** Give the build claim back. Idempotent; a no-op after `start`. */
	release(): void;
}

/** Step 2: the record half, from the ingest's result. */
async function persistIngested(
	input: IngestInput,
	result: IngestResult,
	record: IngestRecordOptions,
): Promise<void> {
	await persistUploadedMedia({
		sectionTipo: input.identity.sectionTipo,
		sectionId: input.identity.sectionId,
		componentTipo: input.identity.componentTipo,
		lang: input.identity.lang,
		filesInfo: result.filesInfo,
		originalFileName: record.originalFileName || result.originalFileName,
		originalNormalizedName: result.originalFileName,
		...(record.nameKeys === undefined ? {} : { nameKeys: record.nameKeys }),
	});
}

/** The result a caller sees: no starters, so none can be called twice or forgotten. */
function withoutStarters(result: IngestResult): IngestedUpload {
	const { startTranscode: _start, releaseBuildClaim: _release, ...rest } = result;
	return rest;
}

/** Ingest, persist, then start the av transcode — the build claim released whatever happens. */
export async function ingestAndPersist(
	input: IngestInput,
	record: IngestRecordOptions = {},
): Promise<PersistedUpload> {
	const result = await processUploadedFile(input);
	try {
		await persistIngested(input, result, record);
		// AFTER the persist commits: the transcode writes its own files_info back.
		const transcodeJobId = result.startTranscode?.() ?? null;
		return { ...withoutStarters(result), transcodeJobId };
	} finally {
		result.releaseBuildClaim();
	}
}

/** Ingest and persist now; hand the av transcode back for the caller to settle. */
export async function ingestAndPersistDeferred(
	input: IngestInput,
	record: IngestRecordOptions = {},
): Promise<IngestedUpload & { transcode: DeferredTranscode }> {
	const result = await processUploadedFile(input);
	try {
		await persistIngested(input, result, record);
	} catch (error) {
		result.releaseBuildClaim();
		throw error;
	}
	const transcode: DeferredTranscode = {
		start: () => {
			try {
				return result.startTranscode?.() ?? null;
			} finally {
				result.releaseBuildClaim();
			}
		},
		release: () => result.releaseBuildClaim(),
	};
	return { ...withoutStarters(result), transcode };
}
