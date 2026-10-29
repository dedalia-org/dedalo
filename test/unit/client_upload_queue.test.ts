/**
 * CLIENT UPLOAD QUEUE + DROPPED FILES — the contract of
 *   client/dedalo/core/services/service_upload/js/upload_queue.js
 *   client/dedalo/core/services/service_upload/js/dropped_files.js
 *
 * WHY THIS FILE EXISTS: biome's `files.includes` excludes `**\/client`
 * (biome.jsonc:86), so NOTHING lints, type-checks or otherwise looks at these two
 * modules. Every invariant below is one whose regression is SILENT in the
 * product — a truncated folder ingest, two scans staged over one path, an import
 * RQO that throws on JSON.stringify — and a comment saying so is not a gate
 * (AGENTS.md: an invariant is tripwired or deleted). This is the gate.
 *
 * Pinned here:
 *  - the collision-rename defect of the code being replaced (remove-then-re-add
 *    handed out a name that already existed → one file overwrote another);
 *  - `readEntries` re-called until empty, so a >100-entry folder arrives WHOLE;
 *  - entries stay JSON.stringify-safe (the File and the transport handle live in
 *    module-private WeakMaps, never on the entry);
 *  - the `entries` array IDENTITY survives add/remove/clear (it IS the tools'
 *    `files_data`, constructed once and held forever);
 *  - an empty allowed_extensions ALLOWS; a real list rejects as `invalid`,
 *    without alerting and without blocking the other files;
 *  - aggregate progress does not regress while a batch runs, and a second batch
 *    does not reset the sent-bytes counter to zero;
 *  - `staged` is always paired with a truthy url;
 *  - `destroy()` leaves nothing in flight.
 *
 * Runs with a fake File/DataTransfer/XMLHttpRequest: no network, no DOM, no
 * server. Every global is saved and restored in afterAll — bun test shares one
 * process and a leaked XMLHttpRequest stub breaks every later file.
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

	/** What the fake server should do with a request. */
	type Behaviour = (index: number) => { kind?: 'error' | 'hang'; status?: number; body?: string };

	/**
	 * THE UPLOAD DOOR'S SUCCESS BODY — envelope v2
	 * (src/core/media/ingest/upload_endpoint.ts: `ok(true, {extend:{file_data}})`).
	 * `upload_transport` accepts a part ONLY when `response_data(body) === true`
	 * (api_error.js: the payload is `data`; the `result` mirror is retired), so the
	 * fake server must answer the real shape or every queue assertion below would
	 * be a study of the failure path.
	 */
	function ok_body(extension: Record<string, unknown> = {}): string {
		return JSON.stringify({ ok: true, request_id: 'zzque', data: true, ...extension });
	}

	/** The failure twin: `toErrorEnvelope` — one `error` object, no compat mirror. */
	function err_body(code: string, message: string): string {
		return JSON.stringify({
			ok: false,
			request_id: 'zzque',
			error: { code, category: 'caller', message, label_key: 'error', retryable: false },
		});
	}

	let behaviour: Behaviour = () => ({
		status: 200,
		body: ok_body({ file_data: { tmp_name: 'staged', complete: true } }),
	});
	const created: FakeXHR[] = [];
	let sent_count = 0;

	class FakeFormData {
		fields: [string, unknown][] = [];
		append(key: string, value: unknown) {
			this.fields.push([key, value]);
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
		done = false;

		addEventListener(type: string, fn: (e: unknown) => void) {
			if (!this.listeners[type]) this.listeners[type] = [];
			this.listeners[type]?.push(fn);
		}
		open() {}
		setRequestHeader(key: string, value: string) {
			this.headers[key] = value;
		}
		abort() {
			this.aborted = true;
			for (const fn of this.listeners.abort ?? []) fn({});
			for (const fn of this.listeners.loadend ?? []) fn({});
		}
		send(_formdata: FakeFormData) {
			this.sent = true;
			sent_count++;
			const index = sent_count;
			setTimeout(() => {
				if (this.aborted) return;
				const result = behaviour(index);
				if (result.kind === 'hang') return;
				if (result.kind === 'error') {
					for (const fn of this.upload.listeners.error ?? []) fn({});
					for (const fn of this.listeners.loadend ?? []) fn({});
					return;
				}
				this.status = result.status ?? 200;
				this.response = result.body ?? '';
				this.responseText = result.body ?? '';
				for (const fn of this.upload.listeners.progress ?? []) fn({ loaded: 50, total: 100 });
				for (const fn of this.upload.listeners.progress ?? []) fn({ loaded: 100, total: 100 });
				this.done = true;
				for (const fn of this.listeners.load ?? []) fn({ target: this });
				for (const fn of this.listeners.loadend ?? []) fn({});
			}, 1);
		}
	}

	/** A minimal File stand-in; only `name`, `size` and `slice` are ever touched. */
	function make_file(name: string, size = 10) {
		return { name, size, slice: (start: number, end: number) => ({ size: end - start }) };
	}

	// ── FileSystem entry fakes (the directory-drop surface) ──────────────────────

	interface FakeEntry {
		isFile: boolean;
		isDirectory: boolean;
		name: string;
		fullPath: string;
		file?: (ok: (f: unknown) => void, err: (e: unknown) => void) => void;
		createReader?: () => { readEntries: (ok: (e: FakeEntry[]) => void, err: () => void) => void };
	}

	function fake_file_entry(name: string, path: string, fail = false): FakeEntry {
		return {
			isFile: true,
			isDirectory: false,
			name,
			fullPath: path,
			file: (ok, err) => {
				// Async, exactly like the real one — a synchronous fake would hide an
				// ordering bug in the traversal.
				setTimeout(() => (fail ? err(new Error('permission denied')) : ok(make_file(name))), 0);
			},
		};
	}

	/**
	 * A directory whose reader hands out entries in batches of `batch` and only
	 * signals completion with an EMPTY array — i.e. the real Chromium behaviour that
	 * silently truncates a folder when readEntries is called once.
	 */
	function fake_dir_entry(
		name: string,
		path: string,
		children: FakeEntry[],
		batch = 100,
	): FakeEntry {
		return {
			isFile: false,
			isDirectory: true,
			name,
			fullPath: path,
			createReader: () => {
				let cursor = 0;
				return {
					readEntries: (ok: (e: FakeEntry[]) => void) => {
						const slice = children.slice(cursor, cursor + batch);
						cursor += slice.length;
						setTimeout(() => ok(slice), 0);
					},
				};
			},
		};
	}

	function fake_data_transfer(entries: FakeEntry[]) {
		return {
			items: entries.map((entry) => ({
				kind: 'file',
				webkitGetAsEntry: () => entry,
				getAsFile: () => (entry.isFile ? make_file(entry.name) : null),
			})),
			files: [],
		};
	}

	// ────────────────────────────────────────────────────────────────────────────

	const globals = globalThis as unknown as Record<string, unknown>;
	const saved: Record<string, unknown> = {};
	// biome-ignore lint/suspicious/noExplicitAny: the modules under test are untyped client JS.
	let queue_module: any;
	// biome-ignore lint/suspicious/noExplicitAny: ditto.
	let dropped_module: any;
	// biome-ignore lint/suspicious/noExplicitAny: ditto.
	let data_manager: any;
	let original_request: unknown;
	const api_calls: { action: string; options: Record<string, unknown> }[] = [];

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
		queue_module = await import(
			'../../client/dedalo/core/services/service_upload/js/upload_queue.js'
		);
		dropped_module = await import(
			'../../client/dedalo/core/services/service_upload/js/dropped_files.js'
		);
		data_manager = (await import('../../client/dedalo/core/common/js/data_manager.js'))
			.data_manager;
		original_request = data_manager.request;
		data_manager.request = async (options: { body: { action: string; options: unknown } }) => {
			api_calls.push({
				action: options.body.action,
				options: options.body.options as Record<string, unknown>,
			});
			return { ok: true, request_id: 'zzque', data: true };
		};
	});

	afterAll(() => {
		data_manager.request = original_request;
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete globals[key];
			else globals[key] = value;
		}
	});

	function reset(next?: Behaviour) {
		created.length = 0;
		api_calls.length = 0;
		sent_count = 0;
		behaviour =
			next ??
			(() => ({
				status: 200,
				body: ok_body({
					file_data: { tmp_name: 'staged.jpg', key_dir: 'image', extension: 'jpg' },
				}),
			}));
	}

	// biome-ignore lint/suspicious/noExplicitAny: untyped client module.
	function make_queue(options: Record<string, unknown> = {}): any {
		return new queue_module.upload_queue({
			key_dir: 'image',
			chunk_size_mb: 0,
			...options,
		});
	}

	const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

	// ────────────────────────────────────────────────────────────────────────────

	describe('upload_queue — collision rename', () => {
		test('remove-then-re-add never reuses a live name (the defect being replaced)', () => {
			reset();
			const files_data: unknown[] = [];
			const queue = make_queue({ entries: files_data });

			// Queue a.jpg three times → a.jpg, a (1).jpg, a (2).jpg
			queue.add(make_file('a.jpg'));
			const second = queue.add(make_file('a.jpg'));
			queue.add(make_file('a.jpg'));
			expect(files_data.map((e) => (e as { name: string }).name)).toEqual([
				'a.jpg',
				'a (1).jpg',
				'a (2).jpg',
			]);

			// Remove the MIDDLE one. The replaced code suffixed with the array LENGTH
			// (now 2) and only ever compared against the ORIGINAL name, so the next
			// a.jpg became 'a (2).jpg' — which already existed. Both rows then staged
			// to one path and a scan was silently overwritten.
			queue.remove(second.id);
			queue.add(make_file('a.jpg'));

			const names = files_data.map((e) => (e as { name: string }).name);
			expect(names).toEqual(['a.jpg', 'a (2).jpg', 'a (1).jpg']);
			expect(new Set(names).size).toBe(names.length);
		});

		test('no two entries ever share a name across a long churn', () => {
			reset();
			const queue = make_queue();
			for (let i = 0; i < 30; i++) queue.add(make_file('scan.tif'));
			// Remove every other one, then refill.
			const ids = queue.entries
				.filter((_e: unknown, i: number) => i % 2 === 0)
				.map((e: { id: string }) => e.id);
			for (const id of ids) queue.remove(id);
			for (let i = 0; i < 20; i++) queue.add(make_file('scan.tif'));

			const names = queue.entries.map((e: { name: string }) => e.name);
			expect(new Set(names).size).toBe(names.length);
		});

		test('a staged file pushes a new upload of the same name aside', () => {
			reset();
			const queue = make_queue();
			// A restored row is ALREADY on disk. If a fresh a.jpg kept its name it
			// would be staged straight over the restored file.
			queue.add_staged({ name: 'a.jpg', url: '/dedalo/upload_tmp/image/a.jpg', size: 5 });
			const added = queue.add(make_file('a.jpg'));
			expect(added.name).toBe('a (1).jpg');
		});

		test('collision is judged on the SERVER-sanitised name, not the display name', () => {
			reset();
			const queue = make_queue();
			// stagedTmpName() maps anything outside [A-Za-z0-9_.-] to '_', so these two
			// distinct-looking names stage to the SAME file.
			queue.add(make_file('DSC 001.jpg'));
			const second = queue.add(make_file('DSC_001.jpg'));
			expect(second.name).not.toBe('DSC_001.jpg');
			expect(second.name).toBe('DSC_001 (1).jpg');
		});
	});

	describe('upload_queue — the entry is a wire object', () => {
		test('entries stay JSON.stringify-safe with no cycle', async () => {
			reset();
			const queue = make_queue();
			queue.add(make_file('a.jpg', 100));
			queue.add_staged({ name: 'b.jpg', url: '/u/b.jpg', size: 4 });
			queue.start();
			await settle();

			// tool_import_marc21 / tool_import_zotero send files_data VERBATIM inside an
			// RQO. A File or a transport handle on the entry would be a cycle and this
			// would THROW inside data_manager — the import dying before the network.
			const json = JSON.stringify(queue.entries);
			expect(typeof json).toBe('string');
			const parsed = JSON.parse(json);
			expect(parsed[0].name).toBe('a.jpg');
			expect(parsed[0].status).toBe('done');
			// The staged identity the importer looks the file up by.
			expect(parsed[0].tmp_name).toBe('staged.jpg');
		});

		test('the entries array identity survives add / remove / clear', async () => {
			reset();
			const files_data: unknown[] = [];
			const queue = make_queue({ entries: files_data });
			expect(queue.entries).toBe(files_data);

			const one = queue.add(make_file('a.jpg'));
			queue.add(make_file('b.jpg'));
			expect(files_data.length).toBe(2);
			await queue.remove(one.id);
			expect(queue.entries).toBe(files_data);
			expect(files_data.length).toBe(1);

			queue.clear();
			// (!) splice in place. `self.entries = []` would leave every tool holding a
			// detached array and every import would silently send zero files.
			expect(queue.entries).toBe(files_data);
			expect(files_data.length).toBe(0);
		});
	});

	describe('upload_queue — validation never blocks', () => {
		test('an empty allowed_extensions allows everything', () => {
			reset();
			const queue = make_queue({ allowed_extensions: [] });
			expect(queue.add(make_file('x.weird')).status).toBe('pending');
			// Absent list too — the import tools never assign one.
			expect(make_queue().add(make_file('x.weird')).status).toBe('pending');
		});

		test('a real list rejects as `invalid`, without alerting and without blocking', () => {
			reset();
			// A global alert() would throw here if anything called it: it is not defined
			// in this environment, and the queue is DOM-free by contract.
			const queue = make_queue({ allowed_extensions: ['jpg', 'tif'] });
			const good = queue.add(make_file('a.jpg'));
			const bad = queue.add(make_file('b.exe'));
			const also_good = queue.add(make_file('c.tif'));

			expect(bad.status).toBe('invalid');
			expect(typeof bad.error).toBe('string');
			expect(bad.error_code).toBe('invalid_extension');
			// The other 2 of a 3-file drop are unaffected — the whole point.
			expect(good.status).toBe('pending');
			expect(also_good.status).toBe('pending');
		});

		test('an over-size file is invalid, not thrown', () => {
			reset();
			const queue = make_queue({ max_size_bytes: 100 });
			expect(queue.add(make_file('big.jpg', 1000)).status).toBe('invalid');
			expect(queue.add(make_file('small.jpg', 10)).status).toBe('pending');
		});

		test('start() never sends an invalid entry', async () => {
			reset();
			const queue = make_queue({ allowed_extensions: ['jpg'] });
			queue.add(make_file('b.exe'));
			queue.start();
			await settle();
			expect(created.length).toBe(0);
			expect(queue.entries[0].status).toBe('invalid');
		});
	});

	describe('upload_queue — progress', () => {
		test('aggregate progress does not regress, and a second batch keeps the sent bytes', async () => {
			reset();
			const samples: { bytes_total: number; bytes_sent: number; percent: number }[] = [];
			const queue = make_queue({
				max_parallel_files: 2,
				callbacks: { on_progress: (p: never) => samples.push(p) },
			});
			queue.add(make_file('a.jpg', 1000));
			queue.add(make_file('b.jpg', 1000));
			queue.start();
			await settle();
			expect(queue.get_progress().percent).toBe(100);

			const sent_after_batch_one = queue.get_progress().bytes_sent;
			expect(sent_after_batch_one).toBe(2000);

			// Second batch. Dropzone excluded finished files from totalBytes, so the bar
			// jumped BACKWARDS to 0 here — which is why the replaced code had to add the
			// finished sizes back by hand on every tick. `done` counts in BOTH the
			// numerator and the denominator, so the sent bytes never drop.
			queue.add(make_file('c.jpg', 1000));
			expect(queue.get_progress().bytes_sent).toBe(sent_after_batch_one);
			expect(queue.get_progress().percent).toBe(67);
			queue.start();
			await settle();
			expect(queue.get_progress().percent).toBe(100);
			expect(queue.get_progress().bytes_sent).toBe(3000);

			// bytes_sent is monotonic across EVERY sample of the whole run.
			for (let i = 1; i < samples.length; i++) {
				expect(samples[i]?.bytes_sent).toBeGreaterThanOrEqual(samples[i - 1]?.bytes_sent as number);
			}
		});

		test('staged and invalid entries are excluded from both sides of the ratio', () => {
			reset();
			const queue = make_queue({ allowed_extensions: ['jpg'] });
			queue.add_staged({ name: 's.jpg', url: '/u/s.jpg', size: 5000 });
			queue.add(make_file('bad.exe', 5000));
			queue.add(make_file('a.jpg', 100));
			// Counting either one puts a permanent ceiling under 100%.
			expect(queue.get_progress().bytes_total).toBe(100);
		});

		test('max_parallel_files caps the entries in flight', async () => {
			reset(() => ({ kind: 'hang' }));
			const queue = make_queue({ max_parallel_files: 2, max_concurrent: 10 });
			for (let i = 0; i < 8; i++) queue.add(make_file(`f${i}.jpg`));
			queue.start();
			await settle(10);
			const uploading = queue.entries.filter((e: { status: string }) => e.status === 'uploading');
			// Without BOTH caps, 20 files × N chunks opens hundreds of sockets.
			expect(uploading.length).toBe(2);
			queue.destroy();
		});
	});

	describe('upload_queue — statuses and lifecycle', () => {
		test('a staged entry always carries a truthy url', () => {
			reset();
			const queue = make_queue();
			const staged = queue.add_staged({ name: 'a.jpg', url: '/dedalo/upload_tmp/image/a.jpg' });
			expect(staged.status).toBe('staged');
			expect(staged.url).toBeTruthy();
			// A listing row with no url cannot be addressed; presenting it as importable
			// unlocks IMPORT on a file that fails deep in the server.
			const broken = queue.add_staged({ name: 'b.jpg' });
			expect(broken.status).not.toBe('staged');
			expect(
				queue.entries.every(
					(e: { status: string; url: string }) => e.status !== 'staged' || !!e.url,
				),
			).toBe(true);
		});

		test("a server refusal keeps the envelope's own diagnosis, not a generic message", async () => {
			// Envelope v2: the refusal carries ONE sentence (`error.message`) under one
			// machine code, and the row shows THAT — `error_text_from` reads the
			// ApiError the transport normalised, never a retired `msg`/`errors[]` pair.
			reset(() => ({
				status: 400,
				body: err_body(
					'media.upload_rejected',
					'File signature (jpeg) does not match declared extension',
				),
			}));
			const queue = make_queue();
			const entry = queue.add(make_file('a.jpg'));
			queue.start();
			await settle();
			expect(entry.status).toBe('error');
			expect(entry.error).toBe('File signature (jpeg) does not match declared extension');
		});

		test('cancel() marks canceled (not error) and stops the pending ones too', async () => {
			reset(() => ({ kind: 'hang' }));
			const queue = make_queue({ max_parallel_files: 1 });
			const first = queue.add(make_file('a.jpg'));
			const second = queue.add(make_file('b.jpg'));
			queue.start();
			await settle(10);
			expect(first.status).toBe('uploading');
			queue.cancel();
			await settle();
			expect(first.status).toBe('canceled');
			// A cancel that only stopped the in-flight file would let the scheduler
			// immediately admit `b.jpg` — the opposite of what the user asked for.
			expect(second.status).toBe('pending');
			expect(created.every((xhr) => xhr.aborted || xhr.done)).toBe(true);
		});

		test('a canceled entry can be started again', async () => {
			reset(() => ({ kind: 'hang' }));
			const queue = make_queue();
			const entry = queue.add(make_file('a.jpg'));
			queue.start();
			await settle(10);
			queue.cancel();
			await settle();
			expect(entry.status).toBe('canceled');

			reset();
			queue.start(entry.id);
			await settle();
			expect(entry.status).toBe('done');
		});

		test('remove({delete_remote}) deletes staged bytes by their SERVER name', async () => {
			reset();
			const queue = make_queue();
			const staged = queue.add_staged({ name: 'a.jpg', url: '/u/a.jpg', size: 5 });
			await queue.remove(staged.id, { delete_remote: true });
			expect(api_calls.length).toBe(1);
			expect(api_calls[0]?.action).toBe('delete_uploaded_file');
			expect(api_calls[0]?.options).toEqual({ key_dir: 'image', file_name: 'a.jpg' });
			expect(queue.entries.length).toBe(0);
		});

		test('a pending entry never fires a remote delete', async () => {
			reset();
			const queue = make_queue();
			const entry = queue.add(make_file('a.jpg'));
			await queue.remove(entry.id, { delete_remote: true });
			// There is nothing on the server yet; a delete here would 200-no-op at best
			// and race a still-landing chunk at worst.
			expect(api_calls.length).toBe(0);
		});

		test('deleting an absent file is a successful no-op (WC-078)', async () => {
			reset();
			const previous = data_manager.request;
			data_manager.request = async () => ({ ok: true, request_id: 'zzque', data: true });
			const queue = make_queue();
			const staged = queue.add_staged({ name: 'gone.jpg', url: '/u/gone.jpg' });
			const removed = await queue.remove(staged.id, { delete_remote: true });
			data_manager.request = previous;
			expect(removed).toBe(true);
		});

		test('on_queue_complete fires once the batch drains, never on a bare remove', async () => {
			reset();
			let completions = 0;
			const queue = make_queue({ callbacks: { on_queue_complete: () => completions++ } });
			const pending = queue.add(make_file('a.jpg'));
			await queue.remove(pending.id);
			expect(completions).toBe(0);

			queue.add(make_file('b.jpg'));
			queue.start();
			await settle();
			expect(completions).toBe(1);
		});

		test('destroy() leaves nothing in flight', async () => {
			reset(() => ({ kind: 'hang' }));
			const pool = (
				await import('../../client/dedalo/core/services/service_upload/js/upload_transport.js')
			).create_connection_pool(4) as unknown as { in_flight: () => number };
			const queue = make_queue({ pool, max_parallel_files: 4 });
			for (let i = 0; i < 4; i++) queue.add(make_file(`f${i}.jpg`));
			queue.start();
			await settle(10);
			expect(pool.in_flight()).toBe(4);

			queue.destroy();
			await settle();
			expect(created.every((xhr) => xhr.aborted)).toBe(true);
			expect(pool.in_flight()).toBe(0);
			expect(queue.entries.every((e: { status: string }) => e.status !== 'uploading')).toBe(true);
			// A destroyed queue answers nothing.
			expect(queue.add(make_file('late.jpg'))).toBe(null);
		});
	});

	describe('dropped_files — directory traversal', () => {
		test('a folder of >100 entries arrives WHOLE (the readEntries re-call loop)', async () => {
			// (!) THE HIGHEST-VALUE ASSERTION IN THIS FILE. The reader hands out 100
			// entries per call, exactly like Chromium. Calling readEntries ONCE (the
			// intuitive reading of the API) returns 100 of the 250 and NO error at all:
			// the curator sees a successful ingest missing 150 scans.
			const children: FakeEntry[] = [];
			for (let i = 0; i < 250; i++)
				children.push(fake_file_entry(`img_${i}.tif`, `/box1/img_${i}.tif`));
			const root = fake_dir_entry('box1', '/box1', children, 100);

			const files = await dropped_module.files_from_drop(fake_data_transfer([root]));
			expect(files.length).toBe(250);
			expect(files.errors.length).toBe(0);
		});

		test('nested folders recurse and the relative path is preserved', async () => {
			const inner = fake_dir_entry('box1', '/scans/box1', [
				fake_file_entry('img.tif', '/scans/box1/img.tif'),
			]);
			const root = fake_dir_entry('scans', '/scans', [
				inner,
				fake_file_entry('top.tif', '/scans/top.tif'),
			]);

			const files = await dropped_module.files_from_drop(fake_data_transfer([root]));
			expect(files.map((f: { name: string }) => f.name).sort()).toEqual(['img.tif', 'top.tif']);
			// Provenance: a curator dropping scans/box1/img.tif must not lose the box.
			const deep = files.find((f: { name: string }) => f.name === 'img.tif');
			expect(deep.dedalo_relative_path).toBe('scans/box1/img.tif');
			// Non-enumerable: it must never leak into a JSON payload of the file.
			expect(Object.keys(deep)).not.toContain('dedalo_relative_path');
		});

		test('one unreadable entry is SKIPPED and SURFACED, never swallowed', async () => {
			const reported: { code: string; path: string }[] = [];
			const root = fake_dir_entry('box1', '/box1', [
				fake_file_entry('ok.tif', '/box1/ok.tif'),
				fake_file_entry('locked.tif', '/box1/locked.tif', true),
				fake_file_entry('ok2.tif', '/box1/ok2.tif'),
			]);

			const files = await dropped_module.files_from_drop(fake_data_transfer([root]), {
				on_error: (info: { code: string; path: string }) => reported.push(info),
			});
			// The other two survive…
			expect(files.length).toBe(2);
			// …and the loss is REPORTED. Silently dropping a file from a heritage
			// ingest is the exact failure mode this module exists to prevent.
			expect(files.errors.length).toBe(1);
			expect(files.errors[0].path).toBe('box1/locked.tif');
			expect(reported.length).toBe(1);
			expect(reported[0]?.code).toBe('entry_error');
		});

		test('a symlink cycle terminates and is reported', async () => {
			// b/ points back at the same fullPath as its own ancestor.
			const loop: FakeEntry = fake_dir_entry('a', '/a', []);
			const child = fake_dir_entry('a', '/a', [fake_file_entry('x.tif', '/a/x.tif')]);
			(loop.createReader as () => { readEntries: (ok: (e: FakeEntry[]) => void) => void }) = () => {
				let served = false;
				return {
					readEntries: (ok: (e: FakeEntry[]) => void) => {
						const batch = served ? [] : [child];
						served = true;
						setTimeout(() => ok(batch), 0);
					},
				};
			};

			const files = await dropped_module.files_from_drop(fake_data_transfer([loop]));
			expect(files.errors.some((e: { code: string }) => e.code === 'cycle')).toBe(true);
			expect(files.length).toBe(0);
		});

		test('the depth limit is reported, never silent', async () => {
			let deepest: FakeEntry = fake_dir_entry('leaf', '/d0/leaf', [
				fake_file_entry('x.tif', '/d0/leaf/x.tif'),
			]);
			for (let i = 0; i < 6; i++) {
				deepest = fake_dir_entry(`d${i}`, `/d${i}`, [deepest]);
			}
			const files = await dropped_module.files_from_drop(fake_data_transfer([deepest]), {
				max_depth: 3,
			});
			expect(files.length).toBe(0);
			expect(files.errors.some((e: { code: string }) => e.code === 'depth_limit')).toBe(true);
		});

		test('the file budget is reported and flags the list as truncated', async () => {
			const children: FakeEntry[] = [];
			for (let i = 0; i < 20; i++) children.push(fake_file_entry(`f${i}.tif`, `/box/f${i}.tif`));
			const files = await dropped_module.files_from_drop(
				fake_data_transfer([fake_dir_entry('box', '/box', children, 5)]),
				{ max_files: 7 },
			);
			expect(files.length).toBe(7);
			expect(files.truncated).toBe(true);
			expect(files.errors.some((e: { code: string }) => e.code === 'file_limit')).toBe(true);
		});

		test('falls back to data_transfer.files when webkitGetAsEntry is absent', async () => {
			const files = await dropped_module.files_from_drop({
				items: null,
				files: [make_file('a.jpg'), make_file('b.jpg')],
			});
			expect(files.map((f: { name: string }) => f.name)).toEqual(['a.jpg', 'b.jpg']);
		});

		test('a plain-file drop through the entry API still yields the File', async () => {
			const files = await dropped_module.files_from_drop(
				fake_data_transfer([fake_file_entry('a.jpg', '/a.jpg')]),
			);
			expect(files.length).toBe(1);
			expect(files[0].name).toBe('a.jpg');
		});

		test('an empty / malformed drop is an empty list, never a rejection', async () => {
			// A rejected promise here takes the whole ingest down for one bad symlink.
			await expect(dropped_module.files_from_drop(null)).resolves.toHaveLength(0);
			await expect(dropped_module.files_from_drop({})).resolves.toHaveLength(0);
		});
	});

	describe('upload_queue + dropped_files together', () => {
		test('a 120-file folder drop queues 120 uniquely-named entries', async () => {
			reset();
			const children: FakeEntry[] = [];
			// All the same base name: the folder walk AND the collision rename both have
			// to hold, or files are lost twice over.
			for (let i = 0; i < 120; i++)
				children.push(fake_file_entry('scan.tif', `/box/scan_${i}.tif`));
			const files = await dropped_module.files_from_drop(
				fake_data_transfer([fake_dir_entry('box', '/box', children, 100)]),
			);
			expect(files.length).toBe(120);

			const files_data: unknown[] = [];
			const queue = make_queue({ entries: files_data });
			for (const file of files) queue.add(file);
			expect(files_data.length).toBe(120);
			const names = files_data.map((e) => (e as { name: string }).name);
			expect(new Set(names).size).toBe(120);
			expect(() => JSON.stringify(files_data)).not.toThrow();
		});
	});
}
