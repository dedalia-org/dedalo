/**
 * MEDIA UPLOAD HTTP ENDPOINT — the multipart branch of the API path.
 *
 * Authenticates the session, enforces CSRF (upload is NOT exempt — SEC-008),
 * receives/stages the chunk(s), and returns the `file_data` descriptor the
 * client hands to tool_upload.process_uploaded_file (PHP two-call flow:
 * dd_utils_api::upload → tool_upload::process_uploaded_file). Fail-closed: no
 * session → 404 (no existence leak), bad CSRF → 403, bad file → 400.
 *
 * ENVELOPE v2 (engineering/ERRORS_SPEC.md §3-4). This route is served by
 * server.ts BEFORE the API dispatcher — it never enters the dispatch
 * chokepoint, so it owns its own Responses. It still builds them through the
 * ONE converter door (`ok` / `toErrorEnvelope`), never by hand.
 *
 * `file_data` stays a TOP-LEVEL EXTENSION KEY and `data` carries the boolean
 * outcome (PHP answered `result:true`): the upload client reads
 * `api_response.file_data` at top level and gates every part on
 * `response_data(api_response) !== true` (upload_transport.js), so `data` has
 * to BE `true` — a payload object there would fail that strict check and hang
 * every transfer.
 */

import { config } from '../../../config/config.ts';
import { DedaloError, ok, toErrorEnvelope, wireMessage } from '../../errors/index.ts';
import type { Session } from '../../security/session_store.ts';
import { verifyCsrf } from '../../security/session_store.ts';
import { createStagedThumbnail } from './staged_thumbnail.ts';
import {
	assertWebImageFormat,
	parseUploadRequest,
	publishWebImage,
	receiveUpload,
	WEB_IMAGE_KEY_DIR,
} from './upload.ts';

/** Build a JSON Response with a status. */
function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	});
}

/** A refusal, converter-made: registry status + the v2 error body. */
function refusal(error: DedaloError, requestId: string): Response {
	const converted = toErrorEnvelope(error, { requestId, surface: 'http' });
	return json(converted.body, converted.status);
}

/**
 * Handle a multipart upload POST. `session` is the resolved TS session (null =
 * anonymous), `csrfCandidate` the header/field token.
 */
export async function handleMediaUpload(
	request: Request,
	session: Session | null,
	csrfCandidate: string | null,
): Promise<Response> {
	// The envelope's correlation id. GENERATED here, and honestly so: this route
	// is served ahead of the dispatch chokepoint, so no request id was minted for
	// it upstream and there is none to reuse. One id per call, shared by every
	// response below.
	const requestId = crypto.randomUUID();

	// Auth: anonymous callers get a 404 (never reveal the endpoint or leak state).
	if (session === null) return refusal(new DedaloError('resource.not_found'), requestId);

	// CSRF: state-changing, constant-time compare. Accepts the header OR the
	// `csrf_token` form field (SEC-008 twin — both upload clients send both; the
	// field covers an intermediary that strips the custom header). Reading the
	// field means parsing the body BEFORE the CSRF verdict, which is safe here
	// because the session gate above already ran and the body is bounded by the
	// transport-level maxRequestBodySize plus the per-part size cap in
	// parseUploadRequest. Fail-closed: a parse failure never reaches the verdict.
	let parsed: Awaited<ReturnType<typeof parseUploadRequest>>;
	try {
		parsed = await parseUploadRequest(request);
	} catch (error) {
		return refusal(rejectedUpload(error), requestId);
	}
	if (!verifyCsrf(session, csrfCandidate) && !verifyCsrf(session, parsed.csrfToken)) {
		return refusal(new DedaloError('auth.csrf_failed'), requestId);
	}
	// Rich-text editor image (CKEditor SimpleUploadAdapter, PHP `case 'web'`): its
	// wire is a bare { url } — the adapter reads `url`, or `error.message` on refusal.
	if (parsed.keyDir === WEB_IMAGE_KEY_DIR) return webImageUpload(parsed, session.userId, requestId);
	try {
		const received = receiveUpload(parsed, session.userId);
		const thumbnailUrl = await stagedThumbnailUrl(session.userId, parsed.keyDir, received);
		return json(
			ok(true, {
				requestId,
				extend: {
					// file_data MUST echo chunk_index + total_chunks: the client counts
					// chunk completion by these (files_chunked[chunk_index]=tmp_name;
					// count === total_chunks → fire join_chunked_files_uploaded). Omitting
					// them made total_chunks NaN → the join never fired → uploads hung.
					file_data: {
						key_dir: parsed.keyDir,
						tmp_name: received.tmpName ?? null,
						// THE HUMAN FILE NAME (PHP file_data->name :1260 — 'My Picture 1.jpg').
						// Restored 2026-08-09 for the CLIENT: the queue row's label, and the
						// PHP wire shape. The ARCHIVE does not get the name from here — the
						// ingest is a LATER request and would depend on the caller relaying
						// this key back, which no ingest caller does. The receiver therefore
						// also persists it beside the staged file and the ingest reads it
						// there (staged_name_record.ts). With neither, the ingest had only
						// `tmp_name` — the SANITIZED staged segment — so a record's
						// `target_filename` field recorded 'Mar_a_Pi_n.jpg' for a file the
						// curator uploaded as 'María Piñón.jpg'.
						name: received.name ?? null,
						extension: received.extension ?? null,
						chunked: parsed.chunked,
						chunk_index: received.chunkIndex ?? 0,
						total_chunks: received.totalChunks ?? 1,
						complete: received.complete,
						// The TRANSFER IDENTITY (WC-2026-08-03-chunked-upload-identity).
						// Echoed so it round-trips: the client forwards the LAST chunk's
						// file_data verbatim into join_chunked_files_uploaded, which is how the
						// join finds exactly THIS transfer's parts instead of guessing from a
						// file name two different uploads can share.
						upload_id: received.uploadId ?? null,
						// PHP dd_utils_api :1269 — null when the format is not previewable.
						thumbnail_url: thumbnailUrl,
					},
				},
			}),
		);
	} catch (error) {
		return refusal(rejectedUpload(error), requestId);
	}
}

/**
 * Preview thumbnail (PHP file_data->thumbnail_url). Only once the whole file is
 * staged — a lone chunk is not an image yet. Best effort: null on any failure,
 * and the client then keeps its own local preview.
 */
async function stagedThumbnailUrl(
	userId: number,
	keyDir: string,
	received: ReturnType<typeof receiveUpload>,
): Promise<string | null> {
	if (!received.complete || !received.tmpName) return null;
	return await createStagedThumbnail(userId, keyDir, received.tmpName, received.extension ?? null);
}

/** The rich-text editor image (key_dir 'web'): publish, answer a bare { url }. */
function webImageUpload(
	parsed: Awaited<ReturnType<typeof parseUploadRequest>>,
	userId: number,
	requestId: string,
): Response {
	try {
		assertWebImageFormat(parsed.fileName);
		const received = receiveUpload({ ...parsed, chunked: false }, userId);
		const path = publishWebImage(userId, received.tmpName ?? '');
		// webBase so the editor shows it at once; the save gate stores it relative
		// (media/web_base_src.ts, TODO-067).
		return json({ url: `${config.media.webBase}/${path}` });
	} catch (error) {
		return refusal(rejectedUpload(error), requestId);
	}
}

/**
 * The staging/validation refusal (bad MIME, traversal, polyglot, malformed
 * upload_id) as ONE typed throw. `media.upload_rejected` is a public-disclosure
 * code, so the validator's own sentence still reaches the curator — but as the
 * envelope's `error.message`, never as a raw exception string assigned to a
 * wire field; the original travels as `cause` for the log.
 */
function rejectedUpload(error: unknown): DedaloError {
	// ONLY A TYPED REFUSAL'S OWN SENTENCE REACHES THE WIRE (P2-8 / SEC-16).
	//
	// `publicMessage` IS a wire field, and this assigned `error.message` to it
	// unconditionally — exactly what the header above says it must never do. The
	// try it serves wraps untried mkdirSync / writeFileSync / renameSync, whose
	// messages embed ABSOLUTE PATHS ("EACCES: permission denied, mkdir
	// '/srv/dedalo/media/…'"), and authorization at this door is session-only, so
	// a consultation-only account reaches it.
	//
	// A DedaloError is the validator SPEAKING DELIBERATELY — through its WIRE
	// sentence (`wireMessage`: registry English, or its own vetted publicMessage
	// under a public code); `.message` is the log-only field (dedalo_error.ts)
	// and may name a path. Anything else is an exception that merely happened,
	// and it travels as `cause` — into the log, never onto the wire.
	const deliberate = error instanceof DedaloError ? wireMessage(error) : null;
	return new DedaloError('media.upload_rejected', {
		publicMessage:
			deliberate ??
			'The upload could not be staged. The server log records why (search the request id).',
		cause: error,
	});
}
