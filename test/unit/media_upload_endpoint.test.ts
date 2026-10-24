/**
 * Phase F gate: the media upload HTTP route on the real server handler.
 * Fail-closed: anonymous → 404 (no leak), bad CSRF → 403; a valid session +
 * CSRF stages a real jpg and returns the file_data descriptor.
 *
 * 2026-08-03 (WC-2026-08-03-chunked-upload-identity) adds the three defects the
 * chunked receive path carried into the day `tool_import_files` starts chunking
 * every upload: colliding staged identities, a head-only re-sniff, and orphaned
 * parts. Every test below stages into the REAL configured media root (that is
 * what makes it an end-to-end gate), so each key_dir is torn down before and
 * after — a leftover `shot.jpg` from a previous run would otherwise be claimed
 * around as `shot-1.jpg` and the assertions would drift.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveMagick } from '../../src/core/media/engine/imagemagick.ts';
import { runBinary } from '../../src/core/media/engine/spawn.ts';
import { stagingDir } from '../../src/core/media/ingest/add_file.ts';
import { createSession, getSession } from '../../src/core/security/session_store.ts';
import { handleRequest } from '../../src/server.ts';
import { magickTestEnv } from '../helpers/magick_test_env.ts';
import { scratchFile } from '../helpers/scratch_dir.ts';

/** Create a session and return { token, csrf }. */
function newSession(userId: number): { token: string; csrf: string } {
	const token = createSession(userId, 'tester', false);
	const session = getSession(token)!;
	return { token, csrf: session.csrfToken };
}

const context = { requestId: 'upload-test', startedAt: 0 };
/** The envelope-v2 error object (engineering/ERRORS_SPEC.md §3). */
interface ApiError {
	code: string;
	message: string;
	category: string;
}
interface ErrBody {
	ok: boolean;
	error: ApiError;
}
const UPLOAD_USER = 3;
/** Every key_dir this file writes into — torn down before and after the run. */
const KEY_DIRS = ['kd_ep', 'kd_chunk', 'kd_collide', 'kd_corrupt', 'kd_badid'];
const clearStaging = (): void => {
	for (const keyDir of KEY_DIRS) {
		rmSync(stagingDir(UPLOAD_USER, keyDir), { recursive: true, force: true });
	}
};
beforeAll(clearStaging);
afterAll(clearStaging);
const API_URL = 'http://localhost/dedalo/core/api/v1/json/';
const HAVE_MAGICK = existsSync(resolveMagick());

async function jpegBlob(): Promise<Blob> {
	const tmp = scratchFile('upload_ep', 'upload_ep.jpg');
	await runBinary([resolveMagick(), '-size', '120x120', 'xc:teal', tmp], {
		nice: false,
		env: magickTestEnv(),
	});
	const bytes = new Uint8Array(await Bun.file(tmp).arrayBuffer());
	return new Blob([bytes as BlobPart], { type: 'image/jpeg' });
}

function multipartRequest(blob: Blob, opts: { cookie?: string; csrf?: string }): Request {
	const form = new FormData();
	form.set('key_dir', 'kd_ep');
	form.set('file_name', 'shot.jpg');
	form.set('chunked', 'false');
	form.set('file_to_upload', blob, 'shot.jpg');
	const headers: Record<string, string> = {};
	if (opts.cookie) headers.Cookie = opts.cookie;
	if (opts.csrf) headers['x-dedalo-csrf-token'] = opts.csrf;
	return new Request(API_URL, { method: 'POST', body: form, headers });
}

describe('media upload endpoint (fail-closed auth/CSRF)', () => {
	test.if(HAVE_MAGICK)('anonymous upload → 404 (no existence leak)', async () => {
		const res = await handleRequest(multipartRequest(await jpegBlob(), {}), context);
		expect(res.status).toBe(404);
		const body = (await res.json()) as ErrBody;
		expect(body.ok).toBe(false);
		expect(body.error.code).toBe('resource.not_found');
	});

	test.if(HAVE_MAGICK)('valid session but missing/blank CSRF → 403', async () => {
		const s = newSession(3);
		const res = await handleRequest(
			multipartRequest(await jpegBlob(), { cookie: `dedalo_ts_session=${s.token}` }),
			context,
		);
		expect(res.status).toBe(403);
		// The rejection body KEY SET is contractual and had no coverage. Envelope
		// v2 (engineering/ERRORS_SPEC.md §3): `error.code` is the machine-readable
		// carrier and `error.message` the sentence; the PHP-era compat mirror
		// (`result`/`msg`/`errors`) was REMOVED on 2026-08-16
		// (WC-2026-08-16-error-envelope-compat-removal). Asserting the key set —
		// not just the presence of `error` — is what stops an undeclared key (the
		// Dropzone-only `error` STRING removed with service_dropzone,
		// WC-2026-08-03-service-dropzone-folded-into-service-upload) coming back,
		// and pins that the retired mirror does not grow back.
		const body = (await res.json()) as Record<string, unknown>;
		expect(Object.keys(body).sort()).toEqual(['error', 'ok', 'request_id']);
		expect(body.ok).toBe(false);
		expect((body.error as ApiError).code).toBe('auth.csrf_failed');
		expect((body.error as ApiError).message).toBe('CSRF validation failed');
	});

	test.if(HAVE_MAGICK)('valid session + CSRF stages the file and returns file_data', async () => {
		const s = newSession(3);
		const res = await handleRequest(
			multipartRequest(await jpegBlob(), {
				cookie: `dedalo_ts_session=${s.token}`,
				csrf: s.csrf,
			}),
			context,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			ok: boolean;
			data: boolean;
			file_data: Record<string, unknown>;
		};
		expect(body.ok).toBe(true);
		// `data` is the boolean outcome and `file_data` a TOP-LEVEL extension key:
		// upload_transport.js gates every part on the outcome flag and reads
		// `api_response.file_data`, so `data` has to be exactly `true`.
		expect(body.data).toBe(true);
		expect(body.file_data.complete).toBe(true);
		expect(body.file_data.extension).toBe('jpg');
		expect(body.file_data.tmp_name).toBe('shot.jpg');
	});
});

describe('chunked upload contract through the real server (the browser flow)', () => {
	test.if(HAVE_MAGICK)(
		'chunk POST echoes chunk_index/total_chunks; join_chunked_files_uploaded assembles',
		async () => {
			const s = newSession(3);
			const blob = await jpegBlob();
			// The client ALWAYS chunks (DEDALO_UPLOAD_SERVICE_CHUNK_FILES > 0); a small
			// image is a single chunk with total_chunks=1.
			const form = new FormData();
			form.set('key_dir', 'kd_chunk');
			form.set('file_name', 'c.jpg');
			form.set('chunked', 'true');
			form.set('chunk_index', '0');
			form.set('total_chunks', '1');
			form.set('file_to_upload', blob, 'c.jpg');
			const chunkReq = new Request(API_URL, {
				method: 'POST',
				body: form,
				headers: {
					Cookie: `dedalo_ts_session=${s.token}`,
					'x-dedalo-csrf-token': s.csrf,
					'X-File-Name': encodeURIComponent('c.jpg'),
				},
			});
			const chunkRes = await handleRequest(chunkReq, context);
			expect(chunkRes.status).toBe(200);
			const chunkBody = (await chunkRes.json()) as { file_data: Record<string, unknown> };
			// The fields the client's completion counter reads (were missing → NaN → hang).
			expect(chunkBody.file_data.chunk_index).toBe(0);
			expect(chunkBody.file_data.total_chunks).toBe(1);
			expect(chunkBody.file_data.tmp_name).toBe('c.jpg');

			// Client fires the join once all chunks are counted.
			const joinRqo = {
				dd_api: 'dd_utils_api',
				action: 'join_chunked_files_uploaded',
				options: { file_data: chunkBody.file_data, files_chunked: ['c.jpg'] },
			};
			const joinRes = await handleRequest(
				new Request(API_URL, {
					method: 'POST',
					body: JSON.stringify(joinRqo),
					headers: {
						'Content-Type': 'application/json',
						Cookie: `dedalo_ts_session=${s.token}`,
						'x-dedalo-csrf-token': s.csrf,
					},
				}),
				context,
			);
			expect(joinRes.status).toBe(200);
			const joinBody = (await joinRes.json()) as {
				data: boolean;
				file_data: Record<string, unknown>;
			};
			expect(joinBody.data).toBe(true);
			expect(joinBody.file_data.tmp_name).toBe('c.jpg');
			expect(joinBody.file_data.extension).toBe('jpg');
			expect(joinBody.file_data.complete).toBe(true);
			// THE TWO COMPLETION PATHS MUST EMIT THE SAME PREVIEW KEY.
			// `receiveUpload` reports complete:false for every chunk, so a chunked
			// transfer's only completion moment is the join — and the join used to
			// omit `thumbnail_url` entirely. service_dropzone never chunked, so the
			// ingest path only ever reached the single-shot branch and the gap was
			// invisible until the import tools moved to the chunking transport:
			// every file over DEDALO_UPLOAD_SERVICE_CHUNK_FILES MB then completed
			// through here and silently lost its preview. Worst on the formats the
			// thumbnail exists FOR — a browser cannot draw a TIFF, so the client's
			// `thumbnail_url || url` fallback had nothing to show and the row
			// rendered blank.
			// Assert the KEY, not a URL: buildThumb spawns an external converter,
			// so a null here is a legitimate environment answer (and the documented
			// one for a non-rasterisable format). An ABSENT key never is.
			expect(Object.hasOwn(joinBody.file_data, 'thumbnail_url')).toBe(true);
		},
	);
});

/**
 * DEFECT 1 — STAGED IDENTITY. `stagedTmpName` is not injective: 'María.jpg' and
 * 'Mar#a.jpg' both sanitize to 'Mar_a.jpg'. Single-shot, that silently
 * overwrote one file with the other (LOSS). Chunked — which is what every
 * upload becomes once tool_import_files moves to the chunking client — the two
 * transfers' parts interleaved under one name and the join concatenated
 * whichever parts won, which the head-only re-sniff then happily accepted
 * (CORRUPTION).
 */
describe('staged identity: colliding client names stay two distinct files', () => {
	/** Post one part and return its file_data. */
	async function post(
		s: { token: string; csrf: string },
		fields: Record<string, string>,
		body: Uint8Array,
	): Promise<{ status: number; body: Record<string, unknown> }> {
		const form = new FormData();
		for (const [key, value] of Object.entries(fields)) form.set(key, value);
		form.set('file_to_upload', new Blob([body as BlobPart]), fields.file_name ?? 'f.bin');
		const res = await handleRequest(
			new Request(API_URL, {
				method: 'POST',
				body: form,
				headers: {
					Cookie: `dedalo_ts_session=${s.token}`,
					'x-dedalo-csrf-token': s.csrf,
					'X-File-Name': encodeURIComponent(fields.file_name ?? 'f.bin'),
				},
			}),
			context,
		);
		return { status: res.status, body: (await res.json()) as Record<string, unknown> };
	}

	/** A minimal but WHOLE jpeg: SOI + a distinguishable body + EOI. */
	const jpegOf = (marker: number, length: number): Uint8Array =>
		new Uint8Array([0xff, 0xd8, 0xff, ...Array.from({ length }, () => marker), 0xff, 0xd9]);

	test('two names that sanitize alike produce two intact staged files (chunked)', async () => {
		const s = newSession(UPLOAD_USER);
		const a = jpegOf(0x41, 600);
		const b = jpegOf(0x42, 400);
		const half = (bytes: Uint8Array, i: number): Uint8Array =>
			i === 0
				? bytes.slice(0, Math.floor(bytes.length / 2))
				: bytes.slice(Math.floor(bytes.length / 2));
		const base = (name: string, index: number): Record<string, string> => ({
			key_dir: 'kd_collide',
			file_name: name,
			chunked: 'true',
			chunk_index: String(index),
			total_chunks: '2',
		});

		// INTERLEAVED, as two concurrent transfers really arrive.
		const a0 = await post(s, base('María.jpg', 0), half(a, 0));
		const b0 = await post(s, base('Mar#a.jpg', 0), half(b, 0));
		const a1 = await post(s, base('María.jpg', 1), half(a, 1));
		const b1 = await post(s, base('Mar#a.jpg', 1), half(b, 1));
		for (const part of [a0, b0, a1, b1]) expect(part.status).toBe(200);
		const aData = a1.body.file_data as Record<string, unknown>;
		const bData = b1.body.file_data as Record<string, unknown>;
		// The two transfers carry DIFFERENT identities even though their staged-name
		// proposals are identical — that is what keeps their parts apart.
		expect(aData.tmp_name).toBe(bData.tmp_name);
		expect(typeof aData.upload_id).toBe('string');
		expect(aData.upload_id).not.toBe(bData.upload_id);

		const joinOne = async (fileData: Record<string, unknown>): Promise<Record<string, unknown>> => {
			const res = await handleRequest(
				new Request(API_URL, {
					method: 'POST',
					body: JSON.stringify({
						dd_api: 'dd_utils_api',
						action: 'join_chunked_files_uploaded',
						options: { file_data: fileData, files_chunked: ['x', 'y'] },
					}),
					headers: {
						'Content-Type': 'application/json',
						Cookie: `dedalo_ts_session=${s.token}`,
						'x-dedalo-csrf-token': s.csrf,
					},
				}),
				context,
			);
			return (await res.json()) as Record<string, unknown>;
		};
		const joinedA = (await joinOne(aData)).file_data as Record<string, unknown>;
		const joinedB = (await joinOne(bData)).file_data as Record<string, unknown>;

		// TWO staged files, not one.
		expect(joinedA.tmp_name).not.toBe(joinedB.tmp_name);
		const dir = stagingDir(UPLOAD_USER, 'kd_collide');
		const readStaged = (name: unknown): Uint8Array =>
			new Uint8Array(readFileSync(resolve(dir, String(name))));
		// BOTH intact: byte-for-byte what was uploaded, no interleaving.
		expect(readStaged(joinedA.tmp_name)).toEqual(a);
		expect(readStaged(joinedB.tmp_name)).toEqual(b);
	});
});

/**
 * DEFECT 2 — the join re-sniff was HEAD-ONLY (8192 bytes), so a valid signature
 * over a corrupt or hostile body passed. The verification now reaches past that
 * prefix in bounded windows (src/core/media/engine/verify_content.ts).
 *
 * HOW FAR it reaches is per content class, and the 2026-08-03 revision narrowed
 * that deliberately: a rule is kept only where no legal file can trip it, because
 * the first version refused real encoder output. The two cases below are the two
 * halves of that — the mechanism still catches a container that is not what it
 * claims (JPEG), and it no longer applies a predicate no consumer enforces (text).
 */
describe('the refusal speaks a DedaloError’s WIRE sentence, never its log-only message (SEC-17)', () => {
	test('a hostile key_dir is refused with the registry sentence; the segment itself (raw client input) stays in the log', async () => {
		// `sanitizeSegment` throws `media.invalid_path` (OPERATOR disclosure) with
		// the rejected segment in the log-only `message`. `rejectedUpload` read
		// `error.message` off it — forwarding whatever a validator keeps for the
		// log (raw input, a path) onto the public `media.upload_rejected` body.
		const s = newSession(UPLOAD_USER);
		const segment = 'kd_zz/../SENTINEL_ESCAPE';
		const form = new FormData();
		form.set('key_dir', segment);
		form.set('file_name', 'x.jpg');
		form.set('chunked', 'false');
		form.set('file_to_upload', new Blob([new Uint8Array([0xff, 0xd8, 0xff]) as BlobPart]), 'x.jpg');
		const res = await handleRequest(
			new Request(API_URL, {
				method: 'POST',
				body: form,
				headers: {
					Cookie: `dedalo_ts_session=${s.token}`,
					'x-dedalo-csrf-token': s.csrf,
					'X-File-Name': encodeURIComponent('x.jpg'),
				},
			}),
			context,
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.ok).toBe(false);
		expect((body.error as ApiError).code).toBe('media.upload_rejected');
		expect((body.error as ApiError).message).toBe('Invalid media path');
		// Everything but the SEC-19 debug block (DEDALO_DEBUG_API_ERRORS collapses
		// the whole ladder by design and is gated on its own): no raw input.
		const { debug: _debug, ...error } = body.error as Record<string, unknown>;
		const wire = JSON.stringify({ ...body, error });
		expect(wire).not.toContain('SENTINEL_ESCAPE');
		expect(wire).not.toContain('Unsafe path segment');
	});
});

describe('join verification reaches past the first 8192 bytes', () => {
	async function upload(
		s: { token: string; csrf: string },
		name: string,
		body: Uint8Array,
	): Promise<{ status: number; body: Record<string, unknown> }> {
		const form = new FormData();
		form.set('key_dir', 'kd_corrupt');
		form.set('file_name', name);
		form.set('chunked', 'false');
		form.set('file_to_upload', new Blob([body as BlobPart]), name);
		const res = await handleRequest(
			new Request(API_URL, {
				method: 'POST',
				body: form,
				headers: {
					Cookie: `dedalo_ts_session=${s.token}`,
					'x-dedalo-csrf-token': s.csrf,
					'X-File-Name': encodeURIComponent(name),
				},
			}),
			context,
		);
		return { status: res.status, body: (await res.json()) as Record<string, unknown> };
	}

	test('a JPEG header over 16 KB of non-JPEG body is REJECTED (and the body shape is pinned)', async () => {
		const s = newSession(UPLOAD_USER);
		// Valid SOI, then 16 KB with no EOI anywhere: the old 8192-byte re-sniff
		// declared this a jpeg.
		const hostile = new Uint8Array([0xff, 0xd8, 0xff, ...new Array(16384).fill(0x00)]);
		const { status, body } = await upload(s, 'hostile.jpg', hostile);
		expect(status).toBe(400);
		// The rejection body KEY SET is pinned: envelope v2 plus the bounded
		// compat trio, and nothing else. The Dropzone-only `error` STRING key was
		// removed with service_dropzone
		// (WC-2026-08-03-service-dropzone-folded-into-service-upload); asserting
		// the key set — not just the presence of the error object — is what stops
		// it, or any other undeclared key, being reintroduced.
		expect(Object.keys(body).sort()).toEqual(['error', 'ok', 'request_id']);
		expect(body.ok).toBe(false);
		expect((body.error as ApiError).code).toBe('media.upload_rejected');
		// The VALIDATOR'S OWN SENTENCE still reaches the curator: the code is
		// public-disclosure, so the refusal reason rides `error.message` instead of
		// a raw exception string.
		expect((body.error as ApiError).message).toContain('verification failed');
		expect(existsSync(resolve(stagingDir(UPLOAD_USER, 'kd_corrupt'), 'hostile.jpg'))).toBe(false);
	});

	/**
	 * A DELIBERATE ACCEPTANCE, pinned so nobody "fixes" it back.
	 *
	 * This case asserted a REJECTION until 2026-08-03: the text class was verified
	 * `full` (no control byte anywhere in the file). That rule was wrong on the
	 * merits, not merely expensive. Control bytes are pervasive in real curator
	 * material:
	 *
	 *   • Excel's "Unicode Text (*.txt)" and many database exports are UTF-16LE,
	 *     so every second byte of an ASCII column IS a NUL — the sniffed prefix
	 *     of a latin-1 CSV can be clean while the rest is full of them;
	 *   • a DOS/CP-M era export ends with 0x1A (the historical EOF character),
	 *     which is exactly the shape of a legacy catalogue dump;
	 *   • OCR transcriptions carry stray 0x7F/0x01 from the scanner software.
	 *
	 * No CSV/XML/JSON consumer enforces the predicate we were enforcing, so the
	 * verifier was more aggressive than the decoder ecosystem it guards — and at
	 * the time a rejected join DELETED the transfer. The 8192-byte head sniff
	 * still classifies the file (that is what cross-checks the extension); what
	 * is gone is the whole-file byte predicate on top of it.
	 * See VERIFICATION_POLICY.text in src/core/media/engine/verify_content.ts.
	 */
	test('a CSV carrying a NUL / 0x1A / 0x7F past the sniffed prefix is ACCEPTED', async () => {
		const s = newSession(UPLOAD_USER);
		const head = new TextEncoder().encode(`id,name\n${'1,ok\n'.repeat(2000)}`);
		expect(head.length).toBeGreaterThan(8192); // the sniffed bound really is passed
		const legacy = new Uint8Array(head.length + 4);
		legacy.set(head, 0);
		// UTF-16 residue, an OCR artefact, and the DOS end-of-file marker.
		legacy.set([0x00, 0x7f, 0x01, 0x1a], head.length);
		const { status, body } = await upload(s, 'legacy.csv', legacy);
		expect(status).toBe(200);
		expect((body.file_data as Record<string, unknown>).complete).toBe(true);
	});

	test('the same content without any control byte is accepted too', async () => {
		const s = newSession(UPLOAD_USER);
		const clean = new TextEncoder().encode(`id,name\n${'1,ok\n'.repeat(2000)}`);
		const { status, body } = await upload(s, 'clean.csv', clean);
		expect(status).toBe(200);
		expect((body.file_data as Record<string, unknown>).complete).toBe(true);
	});
});

/**
 * The client-supplied transfer id is UNTRUSTED input that becomes a path
 * segment. It is REFUSED when malformed — never sanitized into something else,
 * because silently rewriting an identity is how two transfers end up sharing one.
 */
describe('upload_id is validated, not sanitized', () => {
	const hostile: [string, string][] = [
		['traversal', '../../../etc'],
		['slash', 'a/b/c/deadbeef'],
		['nul', 'abcdefgh\u0000'],
		['too short', 'abc'],
		['oversized', 'a'.repeat(4096)],
		['dot', '..'],
	];
	for (const [label, uploadId] of hostile) {
		test(`refuses a ${label} upload_id`, async () => {
			const s = newSession(UPLOAD_USER);
			const form = new FormData();
			form.set('key_dir', 'kd_badid');
			form.set('file_name', 'x.jpg');
			form.set('chunked', 'true');
			form.set('chunk_index', '0');
			form.set('total_chunks', '1');
			form.set('upload_id', uploadId);
			form.set(
				'file_to_upload',
				new Blob([new Uint8Array([0xff, 0xd8, 0xff]) as BlobPart]),
				'x.jpg',
			);
			const res = await handleRequest(
				new Request(API_URL, {
					method: 'POST',
					body: form,
					headers: {
						Cookie: `dedalo_ts_session=${s.token}`,
						'x-dedalo-csrf-token': s.csrf,
						'X-File-Name': encodeURIComponent('x.jpg'),
					},
				}),
				context,
			);
			expect(res.status).toBe(400);
			const body = (await res.json()) as Record<string, unknown>;
			expect(body.ok).toBe(false);
			expect((body.error as ApiError).code).toBe('media.upload_rejected');
			// The refusal REASON, on `error.message` (envelope v2) — never the
			// removed Dropzone-only `error` string
			// (WC-2026-08-03-service-dropzone-folded-into-service-upload).
			expect((body.error as ApiError).message).toContain('invalid upload_id');
			// Nothing was staged under a rewritten id.
			expect(existsSync(stagingDir(UPLOAD_USER, 'kd_badid'))).toBe(false);
		});
	}
});
