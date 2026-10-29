/**
 * CLIENT UPLOAD TRANSPORT — the wire contract of
 * client/dedalo/core/services/service_upload/js/upload_transport.js.
 *
 * WHY THIS FILE EXISTS: the transport is the only client module that builds an
 * XMLHttpRequest, and its multipart shape must stay byte-identical to what
 * src/core/media/ingest/upload.ts parses. Nothing else checks it — biome's
 * `files.includes` excludes `**\/client` (biome.jsonc), so a field renamed or
 * reordered here would ship silently and break every upload in the product.
 * A comment saying "byte-identical" is not a gate; this is (AGENTS.md: an
 * invariant is tripwired or deleted).
 *
 * Pinned here:
 *  - multipart FIELD NAMES and ORDER, chunked and single-shot;
 *  - `upload_id`: present in both modes, one value per FILE (stable across every
 *    part and across a retry of a part), distinct between transfers, and inside
 *    the charset the server REFUSES to sanitise;
 *  - the request HEADERS, including Content-Range only on non-empty chunks;
 *  - `tipo` in single-shot ONLY (the legacy client never sent it on a chunk);
 *  - the SEC-008 CSRF twin (header + form field) read at SEND time.
 *
 * Plus the settlement/pool invariants whose failure mode is invisible in the
 * single-file UI and would only surface once a queue shares one pool.
 *
 * Runs with a fake XMLHttpRequest/FormData: no network, no DOM, no server.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { join } from 'node:path';
import { isIsolatedGateChild, mirrorIsolatedGate } from '../helpers/isolated_gate.ts';

// ISOLATED GATE (test/helpers/isolated_gate.ts): this file substitutes client
// modules, which are process-global — in the tier's process it only MIRRORS a
// child run of itself; its body below registers in that child alone.
if (!isIsolatedGateChild(import.meta.path)) mirrorIsolatedGate(import.meta.path);
else {
	// ────────────────────────────────────────────────────────────────────────────
	// Fake browser surface
	// ────────────────────────────────────────────────────────────────────────────

	interface SentRequest {
		headers: Record<string, string>;
		fields: [string, string][];
	}

	/** What the fake server should do with a request. */
	type Behaviour = (
		record: SentRequest,
		index: number,
	) => {
		kind?: 'error' | 'hang';
		status?: number;
		body?: string;
	};

	/**
	 * THE UPLOAD DOOR'S SUCCESS BODY — envelope v2
	 * (src/core/media/ingest/upload_endpoint.ts: `ok(true, {extend:{file_data}})`).
	 * The transport accepts a part ONLY when `response_data(body) === true`
	 * (api_error.js: the payload is `data`, never the retired `result` mirror), so
	 * the fake server must answer the real shape or every assertion below is a
	 * study of the failure path.
	 */
	function ok_body(extension: Record<string, unknown> = {}): string {
		return JSON.stringify({ ok: true, request_id: 'zzupl', data: true, ...extension });
	}

	/** The failure twin: `toErrorEnvelope` — one `error` object, no compat mirror. */
	function err_body(code: string, message: string): string {
		return JSON.stringify({
			ok: false,
			request_id: 'zzupl',
			error: { code, category: 'caller', message, label_key: 'error', retryable: false },
		});
	}

	const sent: SentRequest[] = [];
	let behaviour: Behaviour = () => ({ status: 200, body: ok_body() });
	/** Every fake XHR created, so a test can assert on abort/release behaviour. */
	const created: FakeXHR[] = [];

	class FakeFormData {
		fields: [string, string][] = [];
		append(key: string, value: unknown) {
			// A Blob/File stands in as '<blob>': the assertions are about the FIELD
			// NAMES and their ORDER, not the bytes.
			this.fields.push([
				key,
				typeof value === 'object' && value !== null ? '<blob>' : String(value),
			]);
		}
	}

	class FakeXHR {
		upload = {
			listeners: {} as Record<string, ((e: unknown) => void)[]>,
			addEventListener: (type: string, fn: (e: unknown) => void) => {
				if (!this.upload.listeners[type]) this.upload.listeners[type] = [];
				this.upload.listeners[type]?.push(fn);
			},
		};
		listeners: Record<string, ((e: unknown) => void)[]> = {};
		headers: Record<string, string> = {};
		status = 0;
		response = '';
		responseText = '';
		sent = false;
		aborted = false;
		errored = false;

		addEventListener(type: string, fn: (e: unknown) => void) {
			if (!this.listeners[type]) this.listeners[type] = [];
			this.listeners[type]?.push(fn);
		}
		open() {}
		setRequestHeader(key: string, value: string) {
			this.headers[key] = value;
		}
		/**
		 * Per XHR spec, once the body is fully sent the upload-complete flag is set
		 * and abort() fires on the XHR, NOT on xhr.upload. The fake reproduces that
		 * exactly — it is the case that used to leak a pool slot forever.
		 */
		abort() {
			this.aborted = true;
			for (const fn of this.listeners.abort ?? []) fn({});
			for (const fn of this.listeners.loadend ?? []) fn({});
		}
		send(formdata: FakeFormData) {
			this.sent = true;
			const record: SentRequest = { headers: this.headers, fields: formdata.fields };
			sent.push(record);
			setTimeout(() => {
				if (this.aborted) return;
				const result = behaviour(record, sent.length);
				if (result.kind === 'hang') return;
				if (result.kind === 'error') {
					this.errored = true;
					for (const fn of this.upload.listeners.error ?? []) fn({});
					for (const fn of this.listeners.loadend ?? []) fn({});
					return;
				}
				this.status = result.status ?? 200;
				this.response = result.body ?? '';
				this.responseText = result.body ?? '';
				for (const fn of this.upload.listeners.progress ?? []) fn({ loaded: 100, total: 100 });
				for (const fn of this.listeners.load ?? []) fn({ target: this });
				for (const fn of this.listeners.loadend ?? []) fn({});
			}, 1);
		}
	}

	/** A minimal File stand-in; only `name`, `size` and `slice` are used. */
	function make_file(size: number, name = 'a.jpg') {
		return {
			name,
			size,
			slice: (start: number, end: number) => ({ size: end - start }),
		};
	}

	const globals = globalThis as unknown as Record<string, unknown>;
	const saved: Record<string, unknown> = {};
	// biome-ignore lint/suspicious/noExplicitAny: the module under test is untyped client JS.
	let transport: any;
	// biome-ignore lint/suspicious/noExplicitAny: ditto.
	let data_manager: any;
	let original_request: unknown;

	beforeAll(async () => {
		for (const key of ['XMLHttpRequest', 'FormData', 'DEDALO_API_URL', 'window', 'page_globals']) {
			saved[key] = globals[key];
		}
		globals.XMLHttpRequest = class extends FakeXHR {
			constructor() {
				super();
				created.push(this);
			}
		};
		globals.FormData = FakeFormData;
		globals.DEDALO_API_URL = '/api/v1/json/';
		globals.window = globalThis;
		globals.page_globals = { csrf_token: 'TOK' };
		(globals.window as Record<string, unknown>).page_globals = globals.page_globals;

		// `data_manager.js` reaches the error RENDERER (render_api_error.js), which
		// imports `common/js/ui.js`, which imports the whole tool machinery
		// (`core/tools_common/js/tool_common.js`) and, through it, browser globals a
		// unit test has no business standing up. Masked here.
		//
		// The mask CANNOT be undone in afterAll (bun's mock.module is process-global
		// and mock.restore() does not revert it), and it does not need to be: ui.js is
		// not importable from disk AT ALL — its module graph touches `window` while it
		// evaluates (the codex-tooltip lib it once pulled statically is now loaded lazily,
		// so that is no longer the reason). So every
		// test that reaches ui.js must mask it (transcription_status_panel,
		// component_change_value_refresh, component_info_widget_client all do); a
		// leaked stub can only replace a module that would otherwise THROW, never a
		// real one. If ui.js ever becomes disk-importable, that changes, and these two
		// masks need snapshot+re-install.
		//
		// (Until 2026-08-16 tool_common.js was itself such a serving-only path —
		// WC-006 moved it into client/dedalo/core/tools_common/, so that half now
		// resolves; the tooltip lib is the remaining one.)
		mock.module(
			join(import.meta.dir, '..', '..', 'client', 'dedalo', 'core', 'common', 'js', 'ui.js'),
			() => ({
				ui: {
					create_dom_element: () => ({
						classList: { add() {}, remove() {} },
						addEventListener() {},
					}),
					show_message: () => {},
				},
			}),
		);

		// Imported AFTER the stubs so nothing binds a real browser global.
		transport = await import(
			'../../client/dedalo/core/services/service_upload/js/upload_transport.js'
		);
		data_manager = (await import('../../client/dedalo/core/common/js/data_manager.js'))
			.data_manager;
		original_request = data_manager.request;
		// The join is a JSON RQO, not multipart; stub it so no fetch is attempted.
		data_manager.request = async () => ({
			ok: true,
			request_id: 'zzupl',
			data: true,
			file_data: { tmp_name: 'a.jpg', complete: true },
		});
	});

	afterAll(() => {
		// bun test shares one process: leaving XMLHttpRequest/window stubbed would
		// bleed into every later test file.
		data_manager.request = original_request;
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete globals[key];
			else globals[key] = value;
		}
	});

	function reset(next: Behaviour) {
		sent.length = 0;
		created.length = 0;
		behaviour = next;
	}

	const ok_chunk = (record: SentRequest) => {
		const index = Number(record.fields.find((f) => f[0] === 'chunk_index')?.[1] ?? 0);
		return {
			status: 200,
			body: ok_body({
				file_data: { chunked: true, chunk_index: index, total_chunks: 3, tmp_name: 'a.jpg' },
			}),
		};
	};

	// ────────────────────────────────────────────────────────────────────────────

	describe('upload_transport wire contract', () => {
		test('chunked part: exact field order, headers, no tipo', async () => {
			reset(ok_chunk);
			const handle = transport.create_transfer({
				file: make_file(2 * 1024 * 1024),
				key_dir: 'image',
				tipo: 'dd1',
				chunk_size_mb: 1,
				pool: transport.create_connection_pool(1),
			});
			await handle.start();

			// The receiver (src/core/media/ingest/upload.ts parseUploadRequest) reads
			// file_to_upload / key_dir / file_name / chunked / chunk_index /
			// total_chunks / csrf_token. start+end are sent but not yet read: Phase 2
			// owns that decision, and dropping them here would be a silent wire change.
			expect(sent[0]?.fields.map((f) => f[0])).toEqual([
				'key_dir',
				'file_name',
				'chunked',
				'start',
				'end',
				'chunk_index',
				'total_chunks',
				'upload_id',
				'file_to_upload',
				'csrf_token',
			]);
			// tipo is single-shot ONLY — the legacy client never sent it on a chunk.
			expect(sent[0]?.fields.some((f) => f[0] === 'tipo')).toBe(false);
			expect(sent[0]?.headers).toEqual({
				'Content-Range': 'bytes 0-1048575/2097152',
				'X-File-Name': 'a.jpg',
				'X-Dedalo-Csrf-Token': 'TOK',
			});
			expect(sent[0]?.fields.find((f) => f[0] === 'chunked')?.[1]).toBe('true');
		});

		test('single-shot: exact field order incl. tipo, and no Content-Range', async () => {
			reset(() => ({
				status: 200,
				body: ok_body({ file_data: { complete: true } }),
			}));
			const handle = transport.create_transfer({
				file: make_file(10),
				key_dir: 'image',
				tipo: 'dd1',
				chunk_size_mb: 0,
			});
			await handle.start();

			expect(sent[0]?.fields.map((f) => f[0])).toEqual([
				'key_dir',
				'file_name',
				'chunked',
				'upload_id',
				'file_to_upload',
				'tipo',
				'csrf_token',
			]);
			expect(sent[0]?.headers).toEqual({
				'X-File-Name': 'a.jpg',
				'X-Dedalo-Csrf-Token': 'TOK',
			});
			expect(sent[0]?.fields.find((f) => f[0] === 'chunked')?.[1]).toBe('false');
		});

		test('X-File-Name is URI-encoded and the CSRF token is read at SEND time', async () => {
			reset(() => ({
				status: 200,
				body: ok_body({ file_data: { complete: true } }),
			}));
			// Rotate the token AFTER the transfer is created: the header must carry the
			// new one. A token captured at init is stale by the time a queued part is
			// admitted, and a stale token is a 403 that looks like a broken upload.
			const handle = transport.create_transfer({
				file: make_file(10, 'año & co.jpg'),
				key_dir: 'image',
				chunk_size_mb: 0,
			});
			(globals.page_globals as Record<string, unknown>).csrf_token = 'ROTATED';
			await handle.start();
			(globals.page_globals as Record<string, unknown>).csrf_token = 'TOK';

			expect(sent[0]?.headers['X-File-Name']).toBe(encodeURIComponent('año & co.jpg'));
			expect(sent[0]?.headers['X-Dedalo-Csrf-Token']).toBe('ROTATED');
			expect(sent[0]?.fields.find((f) => f[0] === 'csrf_token')?.[1]).toBe('ROTATED');
		});

		test('upload_id: one value per FILE, on every part, in the server charset', async () => {
			reset(ok_chunk);
			const handle = transport.create_transfer({
				file: make_file(3 * 1024 * 1024),
				key_dir: 'image',
				chunk_size_mb: 1,
				pool: transport.create_connection_pool(3),
			});
			await handle.start();

			expect(sent.length).toBe(3);
			const ids = sent.map((r) => r.fields.find((f) => f[0] === 'upload_id')?.[1]);
			// The whole point: every part of one file carries the SAME identity, or the
			// receiver stages them under different artifact dirs and the join finds a
			// part missing.
			expect(new Set(ids).size).toBe(1);
			expect(ids[0]).toBe(handle.upload_id());
			// The server VALIDATES this and REFUSES anything else rather than
			// sanitising it, so an id outside the charset is a hard upload failure.
			expect(ids[0]).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
		});

		test('upload_id: single-shot carries it too', async () => {
			reset(() => ({
				status: 200,
				body: ok_body({ file_data: { complete: true } }),
			}));
			const handle = transport.create_transfer({
				file: make_file(10),
				key_dir: 'image',
				chunk_size_mb: 0,
			});
			await handle.start();
			expect(sent[0]?.fields.find((f) => f[0] === 'upload_id')?.[1]).toBe(handle.upload_id());
		});

		test('upload_id: differs between two transfers of the same name', async () => {
			reset(() => ({
				status: 200,
				body: ok_body({ file_data: { complete: true } }),
			}));
			// The exact residue the explicit id closes: two SIMULTANEOUS transfers of
			// the same raw name into the same key_dir, which only a queue makes
			// reachable and which the server's sha256(key_dir, name, total_chunks)
			// fallback cannot separate.
			const one = transport.create_transfer({
				file: make_file(10, 'same.jpg'),
				key_dir: 'image',
				chunk_size_mb: 0,
			});
			const two = transport.create_transfer({
				file: make_file(10, 'same.jpg'),
				key_dir: 'image',
				chunk_size_mb: 0,
			});
			await Promise.all([one.start(), two.start()]);
			expect(one.upload_id()).not.toBe(two.upload_id());
			expect(new Set(sent.map((r) => r.fields.find((f) => f[0] === 'upload_id')?.[1])).size).toBe(
				2,
			);
		});

		test('upload_id: a retried part reuses the SAME id', async () => {
			// First attempt fails at the transport layer, second succeeds. A re-minted
			// id here would put the retry in a different artifact dir.
			let attempts = 0;
			reset(() => {
				attempts++;
				return attempts === 1
					? { kind: 'error' }
					: {
							status: 200,
							body: ok_body({ file_data: { complete: true } }),
						};
			});
			// The retry back-off is a hard-coded 5s; collapse every timer for this test
			// rather than making the suite wait for it.
			const real_set_timeout = globalThis.setTimeout;
			globalThis.setTimeout = ((fn: () => void, delay?: number) =>
				real_set_timeout(fn, Math.min(delay ?? 0, 1))) as typeof globalThis.setTimeout;
			let response: { ok?: boolean };
			try {
				const handle = transport.create_transfer({
					file: make_file(10),
					key_dir: 'image',
					chunk_size_mb: 0,
					max_retry: 1,
				});
				response = await handle.start();
				expect(response.ok).toBe(true);
				expect(sent.length).toBe(2);
				const ids = sent.map((r) => r.fields.find((f) => f[0] === 'upload_id')?.[1]);
				expect(ids[0]).toBe(ids[1]);
				expect(ids[0]).toBe(handle.upload_id());
			} finally {
				globalThis.setTimeout = real_set_timeout;
			}
		});

		test('a zero-byte upload sends no malformed Content-Range', async () => {
			reset(ok_chunk);
			const handle = transport.create_transfer({
				file: make_file(0),
				key_dir: 'image',
				chunk_size_mb: 1,
			});
			await handle.start();
			// `bytes 0--1/0` is not valid RFC 7233. An empty part carries no range.
			expect(sent[0]?.headers['Content-Range']).toBeUndefined();
		});
	});

	describe('upload_transport settlement law', () => {
		test('a transport error settles instead of hanging (D1)', async () => {
			reset(() => ({ kind: 'error' }));
			const handle = transport.create_transfer({
				file: make_file(10),
				key_dir: 'image',
				chunk_size_mb: 0,
				max_retry: 0,
			});
			const response = await handle.start();
			expect(response.ok).toBe(false);
			expect(typeof response.error.message).toBe('string');
			expect(handle.status()).toBe('error');
		});

		test('a chunked transport error settles instead of hanging (D2)', async () => {
			reset(() => ({ kind: 'error' }));
			const handle = transport.create_transfer({
				file: make_file(3 * 1024 * 1024),
				key_dir: 'image',
				chunk_size_mb: 1,
				max_retry: 0,
				pool: transport.create_connection_pool(2),
			});
			const response = await handle.start();
			expect(response.ok).toBe(false);
			expect(handle.status()).toBe('error');
		});

		test("the server's own diagnosis survives a non-2xx refusal", async () => {
			// Envelope v2: the refusal carries ONE machine channel (`error.code`) and
			// one sentence (`error.message`) — the retired `msg`/`errors[]` pair is
			// gone. The upload door refuses on a magic-byte mismatch WITH a 400, so
			// the non-2xx branch (not only the 2xx-with-ok:false one) must read the
			// envelope instead of minting a generic transport message.
			reset(() => ({
				status: 400,
				body: err_body(
					'media.upload_rejected',
					'File signature (jpeg) does not match declared extension',
				),
			}));
			const handle = transport.create_transfer({
				file: make_file(10),
				key_dir: 'image',
				chunk_size_mb: 0,
			});
			const response = await handle.start();
			expect(response.ok).toBe(false);
			expect(response.error.code).toBe('media.upload_rejected');
			expect(response.error.message).toBe(
				'File signature (jpeg) does not match declared extension',
			);
			expect(response.error.status).toBe(400);
		});

		test('a failed chunk cancels its siblings instead of orphaning staging blobs', async () => {
			// Chunk 1 fails; the rest hang so they can only end by being aborted.
			reset((record) => {
				const index = Number(record.fields.find((f) => f[0] === 'chunk_index')?.[1] ?? 0);
				return index === 1 ? { kind: 'error' } : { kind: 'hang' };
			});
			const pool = transport.create_connection_pool(5);
			const percents: number[] = [];
			const handle = transport.create_transfer({
				file: make_file(5 * 1024 * 1024),
				key_dir: 'image',
				chunk_size_mb: 1,
				max_retry: 0,
				pool,
				callbacks: { on_progress: (p: { percent: number }) => percents.push(p.percent) },
			});
			const response = await handle.start();
			expect(response.ok).toBe(false);
			// Not "User aborts upload": a fail-fast cancellation must keep the SERVER's
			// diagnosis, which is why `cancelled` is a flag distinct from `aborted`.
			expect(response.error.message).not.toBe('User aborts upload');
			expect(handle.status()).toBe('error');
			// Every survivor is cancelled. Each one that completed instead would make
			// receiveUpload write a `<i>-<tmp>.blob` that only joinChunkedUpload deletes
			// — and after a failure the join never runs, so they would be permanent
			// orphans on the server's disk.
			expect(created.filter((xhr) => xhr.sent && !xhr.aborted && !xhr.errored).length).toBe(0);
			const before = percents.length;
			await new Promise((r) => setTimeout(r, 30));
			expect(percents.length).toBe(before); // the bar stops climbing after the error
			expect(pool.in_flight()).toBe(0);
			expect(created.every((xhr) => xhr.errored || xhr.aborted)).toBe(true);
		});

		test('abort after the body is sent still releases the pool slot', async () => {
			reset(() => ({ kind: 'hang' }));
			const pool = transport.create_connection_pool(1);
			const handle = transport.create_transfer({
				file: make_file(10),
				key_dir: 'image',
				chunk_size_mb: 0,
				pool,
			});
			const promise = handle.start();
			await new Promise((r) => setTimeout(r, 5));
			expect(pool.in_flight()).toBe(1);
			handle.abort();
			const response = await promise;
			expect(response.ok).toBe(false);
			expect(handle.status()).toBe('aborted');
			// One tick: the slot is released when the part's promise settles, which is
			// a microtask after abort() resolved the caller-facing promise.
			await new Promise((r) => setTimeout(r, 5));
			// Without an `abort` listener on the XHR ITSELF (not xhr.upload) this stays
			// at 1 forever and the shared pool deadlocks.
			expect(pool.in_flight()).toBe(0);
		});

		test('single-shot transfers go through the pool', async () => {
			reset(() => ({
				status: 200,
				body: ok_body({ file_data: { complete: true } }),
			}));
			const pool = transport.create_connection_pool(2);
			let max_open = 0;
			const handles = [];
			for (let i = 0; i < 6; i++) {
				handles.push(
					transport.create_transfer({
						file: make_file(10),
						key_dir: 'image',
						chunk_size_mb: 0,
						pool,
						callbacks: {
							on_progress: () => {
								max_open = Math.max(max_open, pool.in_flight());
							},
						},
					}),
				);
			}
			await Promise.all(handles.map((h) => h.start()));
			// Single-shot is the COMMON queue workload (small files, or chunking off).
			// If it bypasses the pool the window is a no-op exactly where it matters.
			expect(max_open).toBeLessThanOrEqual(2);
			expect(pool.in_flight()).toBe(0);
		});

		test('status is queued until a part reaches the wire', async () => {
			reset(() => ({
				status: 200,
				body: ok_body({ file_data: { complete: true } }),
			}));
			const pool = transport.create_connection_pool(1);
			const blocker = transport.create_transfer({
				file: make_file(10),
				key_dir: 'image',
				chunk_size_mb: 0,
				pool,
			});
			const blocker_promise = blocker.start();
			const waiting = transport.create_transfer({
				file: make_file(10),
				key_dir: 'image',
				chunk_size_mb: 0,
				pool,
			});
			const waiting_promise = waiting.start();
			expect(waiting.status()).toBe('queued');
			await Promise.all([blocker_promise, waiting_promise]);
			expect(waiting.status()).toBe('done');
		});

		test('terminal callbacks fire once, with the same response as the promise', async () => {
			reset(() => ({
				status: 200,
				body: ok_body({ file_data: { complete: true } }),
			}));
			const done: unknown[] = [];
			const errors: unknown[] = [];
			const handle = transport.create_transfer({
				file: make_file(10),
				key_dir: 'image',
				chunk_size_mb: 0,
				callbacks: {
					on_done: (r: unknown) => done.push(r),
					on_error: (r: unknown) => errors.push(r),
				},
			});
			const response = await handle.start();
			handle.abort(); // must not re-settle or re-fire
			expect(done.length).toBe(1);
			expect(errors.length).toBe(0);
			expect(done[0]).toBe(response);
			expect(handle.status()).toBe('done');
		});

		test('a zero-byte file reports 100% progress, not 0%', async () => {
			reset(ok_chunk);
			const percents: number[] = [];
			const handle = transport.create_transfer({
				file: make_file(0),
				key_dir: 'image',
				chunk_size_mb: 1,
				callbacks: { on_progress: (p: { percent: number }) => percents.push(p.percent) },
			});
			const response = await handle.start();
			expect(response.ok).toBe(true);
			// Byte-weighting can only ever yield 0 with no bytes; a progress-driven
			// queue row would leave a successful upload stuck at 0%.
			expect(percents[percents.length - 1]).toBe(100);
		});

		test('progress is byte-weighted and monotonic across unequal chunks', async () => {
			reset(ok_chunk);
			const percents: number[] = [];
			const handle = transport.create_transfer({
				// 2 full 1MB chunks + a 1KB tail: mean-of-percentages would report 66%
				// where byte-weighting reports ~100%.
				file: make_file(2 * 1024 * 1024 + 1024),
				key_dir: 'image',
				chunk_size_mb: 1,
				pool: transport.create_connection_pool(1),
				callbacks: { on_progress: (p: { percent: number }) => percents.push(p.percent) },
			});
			await handle.start();
			expect(percents.length).toBeGreaterThan(0);
			expect(percents[0]).toBeLessThan(100);
			expect(percents[percents.length - 1]).toBe(100);
			for (let i = 1; i < percents.length; i++) {
				expect(percents[i]).toBeGreaterThanOrEqual(percents[i - 1] as number);
			}
		});
	});

	describe('validate_file', () => {
		const file = { name: 'x.weird', size: 10 };

		test('an empty or absent whitelist ALLOWS (D3)', () => {
			// `[].includes(x)` is always false, so the old guard rejected every file
			// for the tools that never configure a list.
			expect(transport.validate_file({ file, allowed_extensions: [] }).valid).toBe(true);
			expect(transport.validate_file({ file }).valid).toBe(true);
		});

		test('a configured whitelist still rejects, with a label KEY not a string', () => {
			const verdict = transport.validate_file({ file, allowed_extensions: ['jpg'] });
			expect(verdict.valid).toBe(false);
			expect(verdict.code).toBe('invalid_extension');
		});

		test('a falsy max_size_bytes means no cap', () => {
			expect(transport.validate_file({ file, max_size_bytes: 0 }).valid).toBe(true);
			expect(transport.validate_file({ file, max_size_bytes: 5 }).code).toBe('filesize_is_too_big');
		});
	});

	describe('create_connection_pool', () => {
		test('honours the window and releases on a throwing task', async () => {
			const pool = transport.create_connection_pool(2);
			let max_open = 0;
			const task = () =>
				new Promise((resolve) => {
					max_open = Math.max(max_open, pool.in_flight());
					setTimeout(resolve, 5);
				});
			await Promise.all([1, 2, 3, 4, 5, 6].map(() => pool.run(task)));
			expect(max_open).toBeLessThanOrEqual(2);
			await pool
				.run(() => {
					throw new Error('boom');
				})
				.catch(() => {});
			expect(pool.in_flight()).toBe(0);
		});

		test('a falsy max_concurrent is unbounded (legacy behaviour)', async () => {
			const pool = transport.create_connection_pool(0);
			let max_open = 0;
			const task = () =>
				new Promise((resolve) => {
					max_open = Math.max(max_open, pool.in_flight());
					setTimeout(resolve, 5);
				});
			await Promise.all([1, 2, 3, 4, 5].map(() => pool.run(task)));
			expect(max_open).toBe(5);
		});
	});
}
