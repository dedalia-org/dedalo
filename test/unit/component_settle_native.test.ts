/**
 * EDIT-SAFETY PRIMITIVES — client/dedalo/core/component_common/js/component_common.js
 * + client/dedalo/core/common/js/events.js
 *
 * WHY THIS FILE EXISTS. The row window (contract:
 * engineering/wire_contract/WC-2026-10-30-section-record-row-box.md, addendum
 * "edit-safety primitives") must be able to RELEASE a row, RETIRE a superseded page and DESTROY an owner without
 * ever dropping a pending edit. Before these primitives nothing in the client
 * could answer "is this component done writing?":
 *   - `save()` refused a concurrent call with a plain `false` and kept no promise,
 *     so a caller could not wait for the save that was already on the wire;
 *   - `change_value()` (the path most views commit through) mutated
 *     `self.data.entries` and awaited `save()` WITHOUT touching `changed_data`,
 *     and a failed save re-added the orange 'modified' marker but never
 *     registered the instance — so a failed edit was invisible to the
 *     unsaved-data guard and to `save_unsaved_components` (whose filter is
 *     `changed_data.length>0`);
 *   - any destroy deregistered the instance, so tearing a dirty row down
 *     silently dropped the edit.
 *
 * WHAT IS PINNED (contract, not implementation):
 *  S. `settle()` — the one "finish writing" door:
 *     S1. a `deactivate` racing `settle` (either order) sends exactly ONE save;
 *     S2. it awaits an in-flight save AND the queued change_value pool;
 *     S3. it retries a failed edit with ONE save: false while that retry fails
 *         (still registered), true once it lands (S3b);
 *     S4. it never auto-saves a component that does not save on deactivate
 *         (component_json: only its own Save commits), nor a destroyed one;
 *     S5. a component that never becomes quiet answers false within the bound
 *         (kept alive, never destroyed);
 *     S6. a rejecting pending write or save() never makes it throw.
 *  P. `saving_promise` — present iff a save is pending:
 *     P1. every resolving post-guard exit (invalid changed_data, unresolved
 *         remove, no-change short-circuit, transport success, transport throw,
 *         server failure) resolves it and leaves it null;
 *     P2. the identity-revoked exit and the concurrency-guard exit (both BEFORE
 *         the guard) never replace an in-flight save's promise;
 *     P3. the recovered re-login retry CHAINS: the outer promise stays the
 *         instance's `saving_promise` across the nested call and resolves with
 *         the nested answer.
 *  F. FAILURE REGISTERS: a failed `change_value` save leaves the instance in the
 *     unsaved registry with the failed `changed_data` (so the window's pin 4 and
 *     `settle()` see it, and the sweep retries it); the identity-revoked exit
 *     does the same. A component_password is registered but its value is never
 *     kept in changed_data (only its own Save commits a password).
 *     F4. a later SUCCESSFUL change_value carries the earlier failed items in
 *         the same request (never retires them unsent);
 *     F5. a refresh emptying data.changed_data does not lose the failed edit
 *         (failed_changed_data survives; the sweep retries it);
 *     F6. a newer save of the same field by another live instance supersedes a
 *         sibling's failed edit (no stale retry over it);
 *     F7. SUPERSESSION IS PER ITEM: a newer save of ANOTHER item of the field
 *         never retires a failed edit (only overlapping targets);
 *     F8. SUPERSESSION IS BY HAND-OVER ORDER: a retry of an older failed edit
 *         never supersedes a newer failed one, whatever order the sweep takes;
 *     F9. reverting ANOTHER item keeps a failed edit registered;
 *     F10. reverting the failed item itself retires it (no stale retry).
 *     F11. a successful save retires only what it SENT: an edit the identity
 *          exit refused while that save was on the wire stays failed,
 *          registered and retried.
 *  N. the no-change short-circuit cancels only an all-'update' batch: a batch
 *     that also carries another action is sent.
 *  C. `commit_seq` advances synchronously at the entry of `change_value` and of
 *     `set_changed_data` — and on nothing else (save, update_data_value, settle).
 *  O. ORPHANS — the one way a dirty instance outlives its row:
 *     O1. `orphan_unsaved_instance` takes it out of `caller.ar_instances`, out of
 *         the instance cache (a rebuilt row gets a fresh instance), into
 *         `orphaned_unsaved`, still registered with its `changed_data`;
 *     O2. a fresh instance cached under the orphan's old key is NOT evicted when
 *         the orphan is later destroyed (the orphan no longer owns that key);
 *     O3. `save_unsaved_components` retries orphans (they are not in the cache);
 *     O4. `reset_unsaved_data` (the user's discard) sweeps and destroys them;
 *     O5. a later successful save of the orphan sweeps it;
 *     O6. SUPERSESSION: a live instance of the same field saving a newer value
 *         retires the orphan — the sweep never resends the stale value over it;
 *     O7. an orphan never writes over a live instance's pending edit of the
 *         same field (it is retired, nothing is sent);
 *     O8. the orphan is off the event bus (a sibling's sync_data_ cannot
 *         refresh it and empty its changed_data);
 *     O9. the sweep retires an orphan with nothing left to send (it would pin
 *         the guard forever) — but never a component_password orphan;
 *     O10. orphaning never evicts ANOTHER instance that owns the cache key;
 *     O11. an orphan arms the unsaved guard on its own, even deregistered;
 *     O12–O15. per item: a newer edit of another item (O12), an insert of
 *         another locator (O13) or a live pending edit of another item (O14)
 *         never retires the orphan's item; a whole-field set_data does (O15).
 *  E. events.js snapshots are COPIES: `get_unsaved_instances()` and
 *     `uncommitted_nodes_snapshot()` cannot mutate the registry; the nodes
 *     snapshot drops nodes that left the document (E2).
 *  W. orphaned_unsaved WRITERS are confined: the exported view has no mutators;
 *     the writers leave events.js only as a ONCE-only capability that
 *     component_common.js claims at load (W4: any later claim throws — the
 *     outcome, whatever spelling reaches it). The SOURCE half — no browser
 *     module other than the two owners names a writer in any spelling — is the
 *     indexed tripwire orphaned_unsaved_writers_tripwire.test.ts.
 *
 * NOT GATED HERE (uncovered until the row-window views stage lands its browser
 * suite — see the WC entry above): edit safety on REAL components
 * (typed-not-blurred input_text committed by the window flush, the per-editor
 * synthetic-'change' commit_seq census). This file pins the primitives only, on
 * bare prototype instances.
 *
 * HARNESS. component_common.js, events.js, instances.js, error_dispatch.js and
 * common.js are imported REAL. Only `ui.js` is module-masked (it imports a vendor
 * bundle not resolvable here) — the same harness as client_data_model_guard. The
 * transport is monkey-patched IN PLACE on the real data_manager and restored in
 * afterAll. Instances are bare objects whose prototype is component_common's,
 * exactly as client_data_model_guard builds them. No DB, no server.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { join } from 'node:path';
import { isIsolatedGateChild, mirrorIsolatedGate } from '../helpers/isolated_gate.ts';

// ISOLATED GATE (test/helpers/isolated_gate.ts): this file substitutes a client
// module (ui.js), which is process-global — in the tier's process it only
// MIRRORS a child run of itself; its body below registers in that child alone.
if (!isIsolatedGateChild(import.meta.path)) mirrorIsolatedGate(import.meta.path);
else {
	const CLIENT_ROOT = join(import.meta.dir, '..', '..', 'client', 'dedalo');
	const COMMON_JS = join(CLIENT_ROOT, 'core', 'common', 'js');
	const COMPONENT_COMMON_PATH = join(
		CLIENT_ROOT,
		'core',
		'component_common',
		'js',
		'component_common.js',
	);
	const UI_PATH = join(COMMON_JS, 'ui.js');

	const globals = globalThis as unknown as Record<string, unknown>;
	const saved: Record<string, unknown> = {};

	/** a permissive stand-in for anything the masked ui.js is asked for */
	// biome-ignore lint/suspicious/noExplicitAny: the client module is untyped vanilla JS
	const ui_stub: any = new Proxy((() => {}) as unknown as Record<string, unknown>, {
		get: (_target, prop) => (prop === 'then' ? undefined : ui_stub),
		apply: () => ui_stub,
	});

	// biome-ignore lint/suspicious/noExplicitAny: untyped client modules
	type Any = any;

	let cc: Any; // component_common.js module
	let events: Any; // events.js module
	let instances: Any; // instances.js module
	let dispatch: Any; // error_dispatch.js module
	let common: Any; // common.js module
	let event_manager: Any; // event_manager.js singleton
	let ApiError: Any;
	let data_manager: { request: (options: unknown) => Promise<unknown> };
	let real_request: (options: unknown) => Promise<unknown>;

	/**
	 * THE TRANSPORT. Every request is recorded; its answer is taken from the
	 * `responders` queue (a function, so a test can hold a request open with a
	 * deferred) or, when the queue is empty, a success echoing the record.
	 */
	let requests: Any[] = [];
	let responders: Array<(body: Any) => Promise<unknown> | unknown> = [];

	const success_for = (body: Any) => ({
		ok: true,
		data: {
			data: [
				{
					tipo: body.data.tipo,
					section_tipo: body.data.section_tipo,
					section_id: body.data.section_id,
					entries: body.data.entries,
				},
			],
			context: [],
		},
	});
	const failure = (code: string) => ({ ok: false, error: new ApiError({ code }) });

	const deferred = () => {
		let resolve!: (value: unknown) => void;
		const promise = new Promise((r) => {
			resolve = r;
		});
		return { promise, resolve };
	};

	/** let every pending microtask/timer chain run */
	const tick = () => new Promise((r) => setTimeout(r, 0));

	let errors: unknown[][] = [];
	let real_console_error: typeof console.error;
	let real_console_warn: typeof console.warn;
	let real_console_log: typeof console.log;

	beforeAll(async () => {
		for (const key of [
			'window',
			'SHOW_DEBUG',
			'SHOW_DEVELOPER',
			'DEDALO_CORE_URL',
			'page_globals',
			'get_label',
			'alert',
		]) {
			saved[key] = globals[key];
		}
		globals.window = globals;
		globals.SHOW_DEBUG = false;
		globals.SHOW_DEVELOPER = false;
		globals.DEDALO_CORE_URL = '';
		globals.get_label = {};
		globals.alert = () => {};
		globals.page_globals = { is_logged: true, user_id: 1 };

		mock.module(UI_PATH, () => ({ ui: ui_stub, default: ui_stub }));

		const transport = (await import(join(COMMON_JS, 'data_manager.js'))) as Any;
		data_manager = transport.data_manager;
		real_request = data_manager.request;
		data_manager.request = async (options: Any) => {
			const body = options.body;
			requests.push(structuredClone(body));
			const responder = responders.shift();
			return responder ? responder(body) : success_for(body);
		};

		cc = await import(COMPONENT_COMMON_PATH);
		events = await import(join(COMMON_JS, 'events.js'));
		instances = await import(join(COMMON_JS, 'instances.js'));
		dispatch = await import(join(COMMON_JS, 'error_dispatch.js'));
		common = await import(join(COMMON_JS, 'common.js'));
		event_manager = (await import(join(COMMON_JS, 'event_manager.js'))).event_manager;
		ApiError = (await import(join(COMMON_JS, 'api_error.js'))).ApiError;
	});

	afterAll(() => {
		if (data_manager && real_request) data_manager.request = real_request;
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete globals[key];
			else globals[key] = value;
		}
		mock.restore();
	});

	beforeEach(() => {
		requests = [];
		responders = [];
		errors = [];
		real_console_error = console.error;
		real_console_warn = console.warn;
		real_console_log = console.log;
		console.error = (...args: unknown[]) => {
			errors.push(args);
		};
		console.warn = () => {};
		console.log = () => {};
		dispatch.reset_error_dispatch_state();
		events.reset_unsaved_data();
	});

	afterEach(() => {
		console.error = real_console_error;
		console.warn = real_console_warn;
		console.log = real_console_log;
		dispatch.reset_error_dispatch_state();
	});

	/** a classList-only node: set_changed_data and save() toggle classes on it */
	const fake_node = () => {
		const classes = new Set<string>();
		return {
			classList: {
				add: (...names: string[]) => {
					for (const n of names) classes.add(n);
				},
				remove: (...names: string[]) => {
					for (const n of names) classes.delete(n);
				},
				contains: (name: string) => classes.has(name),
			},
		};
	};

	let serial = 0;
	/** a bare component instance carrying what save/change_value/settle read */
	const make_instance = (overrides: Record<string, unknown> = {}): Any => {
		serial++;
		const instance: Any = {
			__proto__: cc.component_common.prototype,
			id: `component_input_text_test1_test2_${serial}_edit_lg-nolan`,
			id_base: `test2_${serial}_test1`,
			type: 'component',
			model: 'component_input_text',
			tipo: 'test1',
			section_tipo: 'test2',
			section_id: String(serial),
			mode: 'edit',
			lang: 'lg-nolan',
			status: 'rendered',
			standalone: true,
			node: fake_node(),
			saving: false,
			changing: false,
			change_value_pool: [],
			commit_seq: 0,
			permissions: 2,
			caller: null,
			data: {
				tipo: 'test1',
				section_tipo: 'test2',
				section_id: String(serial),
				entries: ['stored'],
				changed_data: [],
			},
			db_data: {
				tipo: 'test1',
				section_tipo: 'test2',
				section_id: String(serial),
				entries: ['stored'],
			},
			// the real teardown, as every concrete component copies it
			destroy: common.common.prototype.destroy,
			...overrides,
		};
		return instance;
	};

	const EDIT = (value: string) => [{ action: 'update', key: 0, value }];

	/** a multi-value field: two stored values, each named by its id */
	const MULTI = () => ({
		entries: [
			{ id: 1, value: 'a' },
			{ id: 2, value: 'b' },
		],
	});
	const ITEM = (id: number, value: string) => ({
		action: 'update',
		id,
		key: id - 1,
		value: { id, value },
	});
	const make_multi = (overrides: Record<string, unknown> = {}): Any => {
		const instance = make_instance(overrides);
		instance.data = { ...instance.data, ...MULTI(), changed_data: [] };
		instance.db_data = { ...instance.db_data, ...MULTI() };
		return instance;
	};
	/** sweep with the given live instances in the cache, in this order */
	const sweep_with = async (...live: Any[]) => {
		for (const instance of live) instances.add_instance(instance.id, instance);
		try {
			await cc.save_unsaved_components();
		} finally {
			for (const instance of live) instances.delete_instance(instance.id);
		}
	};

	/** another live instance of the SAME stored field (a rebuilt row's fresh one) */
	const make_sibling = (of: Any, overrides: Record<string, unknown> = {}): Any =>
		make_instance({
			id_base: of.id_base,
			section_id: of.section_id,
			lang: of.lang,
			data: { ...structuredClone(of.db_data), changed_data: [] },
			db_data: structuredClone(of.db_data),
			...overrides,
		});

	// ──────────────────────────────────────────────────────────────────────────
	describe('S. settle()', () => {
		test('S1a. deactivate then settle: exactly one save reaches the wire', async () => {
			const self = make_instance();
			self.set_changed_data({ action: 'update', key: 0, value: 'typed' });
			// ui.component.deactivate's commit: change_value, NOT awaited (ui.js)
			self.change_value({ changed_data: self.data.changed_data, refresh: false });
			const settled = await self.settle();

			expect(requests.length).toBe(1);
			expect(settled).toBe(true);
			expect(events.get_unsaved_instances()).not.toContain(self);
		});

		test('S1b. settle then deactivate: still exactly one save', async () => {
			const self = make_instance();
			self.set_changed_data({ action: 'update', key: 0, value: 'typed' });
			const settling = self.settle();
			self.change_value({ changed_data: self.data.changed_data, refresh: false });
			const settled = await settling;
			await tick();

			expect(requests.length).toBe(1);
			expect(settled).toBe(true);
		});

		test('S2. settle awaits an in-flight save and the queued change_value pool', async () => {
			const self = make_instance();
			const first = deferred();
			responders.push(async (body) => {
				await first.promise;
				return success_for(body);
			});

			self.change_value({ changed_data: EDIT('one'), refresh: false });
			// overlapping commit: queued into change_value_pool
			self.change_value({ changed_data: EDIT('two'), refresh: false });
			expect(self.change_value_pool.length).toBe(1);

			let done = false;
			const settling = self.settle().then((value: boolean) => {
				done = true;
				return value;
			});
			await tick();
			expect(done, 'settle resolved while a save was still on the wire').toBe(false);

			first.resolve(undefined);
			const settled = await settling;

			expect(requests.length, 'the queued change was not drained before settle resolved').toBe(2);
			expect(requests[1].data.changed_data[0].value).toBe('two');
			expect(self.change_value_pool.length).toBe(0);
			expect(self.saving_promise ?? null).toBe(null);
			expect(self.change_value_promise ?? null).toBe(null);
			expect(settled).toBe(true);
		});

		test('S3. settle answers false while the instance is still registered (failed save)', async () => {
			const self = make_instance();
			responders.push(() => failure('client.aborted'));
			responders.push(() => failure('client.aborted'));
			await self.change_value({ changed_data: EDIT('lost?'), refresh: false });

			const settled = await self.settle();

			// the second responder is settle's ONE retry of the failed edit
			expect(requests.length, 'settle did not retry the failed edit').toBe(2);
			expect(requests[1].data.changed_data).toEqual(EDIT('lost?'));
			expect(settled).toBe(false);
			expect(events.get_unsaved_instances()).toContain(self);
		});

		test('S3b. settle retries a failed edit and, when the retry lands, answers true', async () => {
			const self = make_instance();
			responders.push(() => failure('client.aborted'));
			await self.change_value({ changed_data: EDIT('retried'), refresh: false });
			expect(events.get_unsaved_instances()).toContain(self);

			// next responder: the default success
			const settled = await self.settle();

			expect(requests.length, 'settle did not retry the failed edit').toBe(2);
			expect(requests[1].data.changed_data).toEqual(EDIT('retried'));
			expect(settled).toBe(true);
			expect(events.get_unsaved_instances()).not.toContain(self);
			expect(self.failed_changed_data ?? null).toBe(null);
		});

		test('S4. settle never auto-saves a component that does not save on deactivate', async () => {
			// component_json: only its own Save button commits
			const self = make_instance({ save_on_deactivate: false });
			self.set_changed_data({ action: 'update', key: 0, value: 'half-typed' });

			const settled = await self.settle();

			expect(requests.length, 'settle saved an uncommitted edit').toBe(0);
			expect(settled).toBe(false);
			expect(events.get_unsaved_instances()).toContain(self);
		});

		test('S4b. nor a destroyed one', async () => {
			const self = make_instance();
			self.set_changed_data({ action: 'update', key: 0, value: 'typed' });
			self.status = 'destroyed';

			await self.settle();

			expect(requests.length).toBe(0);
		});

		test('S5. a component that never becomes quiet: settle answers false within its bound', async () => {
			const self = make_instance();
			self.set_changed_data({ action: 'update', key: 0, value: 'typed' });
			// a change_value forever "between two promises": never drains
			self.changing = true;

			const settled = await self.settle();

			expect(settled, 'a never-quiet instance was reported settled').toBe(false);
			expect(requests.length, 'settle flushed while the instance was still changing').toBe(0);
			expect(events.get_unsaved_instances()).toContain(self);
			expect(
				errors.some((args) => String(args[0]).includes('never became quiet')),
				'the never-quiet exit was not reported',
			).toBe(true);
		});

		test('S6a. a rejecting pending write never makes settle throw; it answers from the registry', async () => {
			const self = make_instance();
			self.saving_promise = (async () => {
				await tick();
				self.saving_promise = null;
				throw new Error('boom');
			})();

			const settled = await self.settle();

			expect(settled).toBe(true);
			expect(requests.length).toBe(0);
			expect(errors.some((args) => String(args[0]).includes('a pending write rejected'))).toBe(
				true,
			);
		});

		test('S6b. a rejecting save() never makes settle throw; the edit stays registered', async () => {
			const self = make_instance({
				save: async () => {
					throw new Error('boom');
				},
			});
			self.set_changed_data({ action: 'update', key: 0, value: 'typed' });

			const settled = await self.settle();

			expect(settled).toBe(false);
			expect(events.get_unsaved_instances()).toContain(self);
			expect(errors.some((args) => String(args[0]).includes('settle: save rejected'))).toBe(true);
		});
	});

	// ──────────────────────────────────────────────────────────────────────────
	describe('P. saving_promise', () => {
		/** call save, capture the promise synchronously, await it, check it cleared */
		const run_exit = async (self: Any, changed?: unknown) => {
			const answer = self.save(changed);
			const captured = self.saving_promise;
			expect(captured, 'a post-guard save did not expose saving_promise').toBeInstanceOf(Promise);
			const value = await answer;
			const settled_value = await captured;
			await tick();
			expect(self.saving_promise ?? null, 'saving_promise was not cleared on this exit').toBe(null);
			expect(self.saving).toBe(false);
			return { value, settled_value };
		};

		test('P1a. invalid changed_data exit resolves it', async () => {
			const self = make_instance();
			const { value } = await run_exit(self, []);
			expect(value).toBe(false);
			expect(requests.length).toBe(0);
		});

		test('P1b. unresolved remove exit resolves it', async () => {
			const self = make_instance();
			const { value } = await run_exit(self, [{ action: 'remove', id: null, value: null }]);
			expect(value).toBe(false);
			expect(requests.length).toBe(0);
		});

		test('P1c. no-change short-circuit resolves it', async () => {
			const self = make_instance();
			const { value } = await run_exit(self, EDIT('stored'));
			expect(value).toBe(false);
			expect(requests.length).toBe(0);
		});

		test('P1d. transport success (send_data return → final return) resolves it', async () => {
			const self = make_instance();
			const { value, settled_value } = await run_exit(self, EDIT('new'));
			expect((value as Any).ok).toBe(true);
			expect(settled_value).toBe(value);
			expect(requests.length).toBe(1);
		});

		test('P1e. transport throw (send_data catch) resolves it', async () => {
			const self = make_instance();
			responders.push(() => {
				const error = new Error('aborted');
				error.name = 'AbortError';
				throw error;
			});
			const { value } = await run_exit(self, EDIT('new'));
			expect((value as Any).ok).toBe(false);
		});

		test('P1f. server failure (error branch → final return) resolves it', async () => {
			const self = make_instance();
			responders.push(() => failure('client.aborted'));
			const { value } = await run_exit(self, EDIT('new'));
			expect((value as Any).ok).toBe(false);
		});

		test('P2a. the concurrency-guard exit never replaces an in-flight promise', async () => {
			const self = make_instance();
			const hold = deferred();
			responders.push(async (body) => {
				await hold.promise;
				return success_for(body);
			});
			const first = self.save(EDIT('a'));
			const in_flight = self.saving_promise;
			expect(in_flight).toBeInstanceOf(Promise);

			const second = await self.save(EDIT('b'));
			expect(second).toBe(false);
			expect(self.saving_promise, 'the guard exit replaced the in-flight promise').toBe(in_flight);

			hold.resolve(undefined);
			await first;
			await tick();
			expect(self.saving_promise ?? null).toBe(null);
			expect(requests.length).toBe(1);
		});

		test('P2b. the identity-revoked exit never replaces an in-flight promise', async () => {
			const self = make_instance();
			const hold = deferred();
			responders.push(async (body) => {
				await hold.promise;
				return success_for(body);
			});
			const first = self.save(EDIT('a'));
			const in_flight = self.saving_promise;

			dispatch.revoke_page_identity('differs');
			const second = await self.save(EDIT('b'));
			expect(second).toBe(false);
			expect(self.saving_promise, 'the identity exit replaced the in-flight promise').toBe(
				in_flight,
			);

			dispatch.clear_page_identity_revoked();
			hold.resolve(undefined);
			await first;
			await tick();
			expect(self.saving_promise ?? null).toBe(null);
		});

		test('P2c. the identity-revoked exit with nothing in flight sets no promise', async () => {
			const self = make_instance();
			dispatch.revoke_page_identity('differs');
			const answer = await self.save(EDIT('b'));
			expect(answer).toBe(false);
			expect(self.saving_promise ?? null).toBe(null);
			expect(requests.length).toBe(0);
		});

		test('P3. the recovered re-login retry chains the outer promise', async () => {
			const self = make_instance();
			const hold = deferred();
			responders.push(() => failure('auth.not_logged'));
			responders.push(async (body) => {
				await hold.promise;
				return success_for(body);
			});
			// the overlay "opens" and the page's OWN user logs back in
			const restore = dispatch.set_relogin_renderer_for_test(() => {
				setTimeout(() => dispatch.settle_relogin_attempt({ ok: true, data: true, user_id: 1 }), 0);
			});
			try {
				const answer = self.save(EDIT('retried'));
				const outer = self.saving_promise;
				expect(outer).toBeInstanceOf(Promise);

				// wait until the nested save is on the wire
				for (let i = 0; i < 50 && requests.length < 2; i++) await tick();
				expect(requests.length).toBe(2);
				expect(self.saving, 'the nested save is not in flight').toBe(true);
				expect(self.saving_promise, 'the nested call replaced the outer promise').toBe(outer);

				hold.resolve(undefined);
				const value: Any = await answer;
				expect(value.ok).toBe(true);
				expect(await outer).toBe(value);
				await tick();
				expect(self.saving_promise ?? null).toBe(null);
			} finally {
				restore();
			}
		});
	});

	// ──────────────────────────────────────────────────────────────────────────
	describe('F. a failed save registers the instance', () => {
		test('F1. failed change_value save: registered, changed_data kept, swept later', async () => {
			const self = make_instance();
			responders.push(() => failure('client.aborted'));

			const answer: Any = await self.change_value({ changed_data: EDIT('kept'), refresh: false });

			expect(answer.ok).toBe(false);
			expect(
				events.get_unsaved_instances(),
				'a failed change_value save is invisible to the guard',
			).toContain(self);
			expect((globalThis as Any).window.unsaved_data).toBe(true);
			expect(self.data.changed_data).toEqual(EDIT('kept'));

			// the sweep's filter (changed_data.length>0) now sees it, and retries it
			instances.add_instance(self.id, self);
			try {
				await cc.save_unsaved_components();
			} finally {
				instances.delete_instance(self.id);
			}
			expect(requests.length).toBe(2);
			expect(requests[1].data.changed_data).toEqual(EDIT('kept'));
			expect(events.get_unsaved_instances()).not.toContain(self);
		});

		test('F2. the identity-revoked exit registers the edit it refused to send', async () => {
			const self = make_instance();
			dispatch.revoke_page_identity('differs');
			await self.change_value({ changed_data: EDIT('blocked'), refresh: false });

			expect(requests.length).toBe(0);
			expect(events.get_unsaved_instances()).toContain(self);
			expect(self.data.changed_data).toEqual(EDIT('blocked'));
		});

		test('F3. a failed component_password save registers but never keeps the value for the sweep', async () => {
			// a password is committed only by its own Save, never by the auto-save
			// sweep — a clear-text value left in changed_data would be resent by it
			const self = make_instance({ model: 'component_password' });
			responders.push(() => failure('validation.password_policy'));
			await self.change_value({ changed_data: EDIT('weak'), refresh: false });

			expect(events.get_unsaved_instances()).toContain(self);
			// BOTH stores the sweep reads (has_pending_edit / with_failed_changed_data)
			expect(self.data.changed_data).toEqual([]);
			expect(self.failed_changed_data ?? null).toBe(null);
			expect(requests.length).toBe(1);

			// the outcome: the sweep never resends the clear-text value, and the
			// failure stays registered (only the password's own Save commits it)
			instances.add_instance(self.id, self);
			try {
				await cc.save_unsaved_components();
			} finally {
				instances.delete_instance(self.id);
			}
			expect(requests.length, 'the sweep resent a clear-text password').toBe(1);
			expect(events.get_unsaved_instances()).toContain(self);
		});

		test('F4. a later successful change_value carries the earlier failed items', async () => {
			const self = make_instance();
			const failed_item = { action: 'update', key: 1, value: 'A' };
			responders.push(() => failure('client.aborted'));
			await self.change_value({ changed_data: [failed_item], refresh: false });
			expect(events.get_unsaved_instances()).toContain(self);

			const answer: Any = await self.change_value({ changed_data: EDIT('B'), refresh: false });

			expect(answer.ok).toBe(true);
			expect(requests.length).toBe(2);
			expect(
				requests[1].data.changed_data,
				'the successful save retired a failed edit it never sent',
			).toEqual([failed_item, ...EDIT('B')]);
			expect(events.get_unsaved_instances()).not.toContain(self);
			expect(self.failed_changed_data ?? null).toBe(null);
		});

		test('F5. a refresh emptying data.changed_data does not lose the failed edit', async () => {
			const self = make_instance();
			responders.push(() => failure('client.aborted'));
			await self.change_value({ changed_data: EDIT('kept'), refresh: false });
			// what do_build does on any refresh
			self.data.changed_data = [];

			instances.add_instance(self.id, self);
			try {
				await cc.save_unsaved_components();
			} finally {
				instances.delete_instance(self.id);
			}
			expect(requests.length, 'the failed edit was dropped by the refresh').toBe(2);
			expect(requests[1].data.changed_data).toEqual(EDIT('kept'));
			expect(events.get_unsaved_instances()).not.toContain(self);
		});

		test("F6. a newer save of the same field supersedes a sibling's failed edit", async () => {
			const self = make_instance();
			responders.push(() => failure('client.aborted'));
			await self.change_value({ changed_data: EDIT('older'), refresh: false });
			expect(events.get_unsaved_instances()).toContain(self);

			const sibling = make_sibling(self);
			await sibling.change_value({ changed_data: EDIT('newer'), refresh: false });

			expect(
				events.get_unsaved_instances(),
				'the superseded edit is still registered',
			).not.toContain(self);
			expect(self.failed_changed_data ?? null).toBe(null);
			instances.add_instance(self.id, self);
			try {
				await cc.save_unsaved_components();
			} finally {
				instances.delete_instance(self.id);
			}
			expect(requests.length, 'the stale edit was resent over the newer one').toBe(2);
			expect(requests[1].data.changed_data).toEqual(EDIT('newer'));
		});

		test("F7. a newer save of ANOTHER item of the field never retires a sibling's failed edit", async () => {
			const self = make_multi();
			responders.push(() => failure('client.aborted'));
			await self.change_value({ changed_data: [ITEM(1, 'A1')], refresh: false });

			const sibling = make_sibling(self);
			sibling.data = { ...sibling.data, ...MULTI(), changed_data: [] };
			sibling.db_data = { ...sibling.db_data, ...MULTI() };
			await sibling.change_value({ changed_data: [ITEM(2, 'B2')], refresh: false });

			expect(events.get_unsaved_instances(), 'an edit of another item was retired').toContain(self);
			await sweep_with(self);
			expect(requests.length).toBe(3);
			expect(requests[2].data.changed_data).toEqual([ITEM(1, 'A1')]);
			expect(events.get_unsaved_instances()).not.toContain(self);
		});

		test('F8. a retry never supersedes a NEWER failed edit, whatever order the sweep takes', async () => {
			// two live instances of one field; both saves overlap on the wire and
			// both fail: older's edit was handed over first
			const older = make_instance();
			const newer = make_sibling(older);
			const hold = deferred();
			responders.push(async () => {
				await hold.promise;
				return failure('client.aborted');
			});
			responders.push(async () => {
				await hold.promise;
				return failure('client.aborted');
			});
			const first = older.change_value({ changed_data: EDIT('old'), refresh: false });
			await tick();
			const second = newer.change_value({ changed_data: EDIT('new'), refresh: false });
			await tick();
			hold.resolve(undefined);
			await Promise.all([first, second]);
			expect(events.get_unsaved_instances()).toContain(older);
			expect(events.get_unsaved_instances()).toContain(newer);

			// older FIRST in the cache order
			await sweep_with(older, newer);

			expect(requests.length).toBe(3);
			expect(
				requests[2].data.changed_data,
				'the older retry was sent (and won) over the newer edit',
			).toEqual(EDIT('new'));
			expect(events.get_unsaved_instances()).not.toContain(older);
			expect(events.get_unsaved_instances()).not.toContain(newer);
		});

		test('F9. reverting ANOTHER item keeps the failed edit registered', async () => {
			const self = make_multi();
			responders.push(() => failure('client.aborted'));
			await self.change_value({ changed_data: [ITEM(1, 'A1')], refresh: false });
			expect(events.get_unsaved_instances()).toContain(self);

			// type into value 2, then delete back to the stored value
			expect(self.set_changed_data(ITEM(2, 'x'))).toBe(true);
			expect(self.set_changed_data(ITEM(2, 'b'))).toBe(false);

			expect(
				events.get_unsaved_instances(),
				'the revert of another item deregistered a pending failed edit',
			).toContain(self);
			expect(self.failed_changed_data).toEqual([ITEM(1, 'A1')]);
			await sweep_with(self);
			expect(requests.length).toBe(2);
			expect(requests[1].data.changed_data).toEqual([ITEM(1, 'A1')]);
			expect(events.get_unsaved_instances()).not.toContain(self);
		});

		test('F10. reverting the failed item itself retires it (never retried over the stored value)', async () => {
			const self = make_multi();
			responders.push(() => failure('client.aborted'));
			await self.change_value({ changed_data: [ITEM(1, 'A1')], refresh: false });

			expect(self.set_changed_data(ITEM(1, 'a'))).toBe(false);

			expect(events.get_unsaved_instances()).not.toContain(self);
			expect(self.failed_changed_data ?? null).toBe(null);
			await sweep_with(self);
			expect(requests.length, 'the reverted failed value was resent').toBe(1);
		});

		test('F11. a successful save retires only what it sent, never an edit refused while it was on the wire', async () => {
			const self = make_multi();
			const hold = deferred();
			responders.push(async (body) => {
				await hold.promise;
				return success_for(body);
			});
			// save A (item 1) goes to the wire and is held there
			const first = self.change_value({ changed_data: [ITEM(1, 'A1')], refresh: false });
			await tick();
			expect(requests.length).toBe(1);

			// the identity flips mid-flight: a direct save of item 2 is refused
			dispatch.revoke_page_identity('differs');
			expect(await self.save([ITEM(2, 'B2')])).toBe(false);
			expect(events.get_unsaved_instances()).toContain(self);

			// save A left with the old cookie and succeeds
			hold.resolve(undefined);
			await first;
			await tick();

			expect(
				events.get_unsaved_instances(),
				'save A deregistered an edit it never carried',
			).toContain(self);
			expect(self.failed_changed_data).toEqual([ITEM(2, 'B2')]);
			expect(self.data.changed_data).toEqual([ITEM(2, 'B2')]);

			// a same-user re-login lifts the latch: settle retries the kept edit
			dispatch.clear_page_identity_revoked();
			const settled = await self.settle();
			expect(requests.length, 'the refused edit was never retried').toBe(2);
			expect(requests[1].data.changed_data).toEqual([ITEM(2, 'B2')]);
			expect(settled).toBe(true);
		});

		test('N1. a mixed batch is never cancelled by an unchanged update item', async () => {
			const self = make_instance();
			const answer: Any = await self.save([
				{ action: 'set_data', key: null, value: ['x'] },
				...EDIT('stored'),
			]);
			expect(requests.length, 'the no-change short-circuit dropped a set_data').toBe(1);
			expect(answer.ok).toBe(true);
		});
	});

	// ──────────────────────────────────────────────────────────────────────────
	describe('C. commit_seq', () => {
		test('C1. advances synchronously at the entry of change_value and set_changed_data', async () => {
			const self = make_instance();
			const pending = self.change_value({ changed_data: EDIT('x'), refresh: false });
			expect(self.commit_seq, 'change_value did not advance commit_seq synchronously').toBe(1);
			await pending;

			self.set_changed_data({ action: 'update', key: 0, value: 'y' });
			expect(self.commit_seq, 'set_changed_data did not advance commit_seq').toBe(2);
		});

		test('C2. a queued change_value still advances it at entry', () => {
			const self = make_instance();
			self.changing = true; // a change_value is in flight
			self.change_value({ changed_data: EDIT('q'), refresh: false });
			expect(self.commit_seq).toBe(1);
			self.change_value_pool.length = 0;
			self.changing = false;
		});

		test('C3. and on nothing else: save, update_data_value, settle', async () => {
			const self = make_instance();
			await self.save(EDIT('direct'));
			self.update_data_value({ action: 'update', key: 0, value: 'model only' });
			await self.settle();
			expect(self.commit_seq).toBe(0);
		});
	});

	// ──────────────────────────────────────────────────────────────────────────
	describe('O. orphaned unsaved instances', () => {
		/** a failed-save instance living in a row (cached, in its caller's ar_instances) */
		const make_failed_row_instance = async () => {
			const row = { id: 'section_record_row', ar_instances: [] as Any[] };
			const self = make_instance({ caller: row });
			row.ar_instances.push(self);
			instances.add_instance(self.id, self);
			responders.push(() => failure('client.aborted'));
			await self.change_value({ changed_data: EDIT('dirty'), refresh: false });
			expect(events.get_unsaved_instances()).toContain(self);
			return { row, self, key: self.id as string };
		};

		test('O1. orphan_unsaved_instance: out of ar_instances and the cache, in orphaned_unsaved, still registered', async () => {
			const { row, self, key } = await make_failed_row_instance();

			cc.orphan_unsaved_instance(self);

			expect(row.ar_instances).not.toContain(self);
			expect(instances.get_instance_by_id(key), 'a rebuilt row would re-adopt the orphan').toBe(
				null,
			);
			expect(instances.get_all_instances()).not.toContain(self);
			expect(events.orphaned_unsaved.has(self)).toBe(true);
			expect(events.get_unsaved_instances()).toContain(self);
			expect(self.data.changed_data).toEqual(EDIT('dirty'));
			expect(self.status).not.toBe('destroyed');
			expect((globalThis as Any).window.unsaved_data).toBe(true);
		});

		test("O2. destroying the orphan later never evicts the rebuilt row's fresh instance", async () => {
			const { row, self, key } = await make_failed_row_instance();
			cc.orphan_unsaved_instance(self);

			// the rebuilt row builds a fresh instance under the same key
			const fresh = make_instance({ id: key, caller: row });
			row.ar_instances.push(fresh);
			instances.add_instance(key, fresh);
			try {
				events.reset_unsaved_data();
				await tick();
				expect(self.status).toBe('destroyed');
				expect(
					instances.get_instance_by_id(key),
					'the orphan destroy evicted the fresh instance',
				).toBe(fresh);
				expect(row.ar_instances).toContain(fresh);
			} finally {
				instances.delete_instance(key);
			}
		});

		test('O3. save_unsaved_components retries orphans (they are outside the cache)', async () => {
			const { self } = await make_failed_row_instance();
			cc.orphan_unsaved_instance(self);
			const before = requests.length;

			await cc.save_unsaved_components();
			await tick();

			expect(requests.length, 'the sweep never reached the orphan').toBe(before + 1);
			expect(events.orphaned_unsaved.has(self)).toBe(false);
			expect(events.get_unsaved_instances()).not.toContain(self);
			expect(self.status).toBe('destroyed');
			expect((globalThis as Any).window.unsaved_data).toBe(false);
		});

		test('O4. reset_unsaved_data (the user discarded) sweeps and destroys orphans', async () => {
			const { self } = await make_failed_row_instance();
			cc.orphan_unsaved_instance(self);

			events.reset_unsaved_data();
			await tick();

			expect(events.orphaned_unsaved.size).toBe(0);
			expect(self.status).toBe('destroyed');
			expect((globalThis as Any).window.unsaved_data).toBe(false);
		});

		test('O5. a later successful save of the orphan sweeps it', async () => {
			const { self } = await make_failed_row_instance();
			cc.orphan_unsaved_instance(self);

			const answer: Any = await self.save();
			await tick();

			expect(answer.ok).toBe(true);
			expect(events.orphaned_unsaved.has(self)).toBe(false);
			expect(events.get_unsaved_instances()).not.toContain(self);
			expect(self.status).toBe('destroyed');
		});

		test('O6. a newer save of the same field by the rebuilt row supersedes the orphan', async () => {
			const { row, self, key } = await make_failed_row_instance();
			cc.orphan_unsaved_instance(self);

			// the rebuilt row: a fresh instance under the same key, server value
			const fresh = make_sibling(self, { id: key, caller: row });
			row.ar_instances.push(fresh);
			instances.add_instance(key, fresh);
			try {
				const answer: Any = await fresh.change_value({ changed_data: EDIT('V2'), refresh: false });
				expect(answer.ok).toBe(true);
				await tick();

				expect(events.orphaned_unsaved.has(self), 'the stale orphan survived a newer save').toBe(
					false,
				);
				expect(events.get_unsaved_instances()).not.toContain(self);
				expect(self.status).toBe('destroyed');

				const before = requests.length;
				await cc.save_unsaved_components();
				expect(requests.length, 'the sweep resent the stale orphan value').toBe(before);
				expect(requests[requests.length - 1].data.changed_data).toEqual(EDIT('V2'));
				expect(instances.get_instance_by_id(key)).toBe(fresh);
				expect((globalThis as Any).window.unsaved_data).toBe(false);
			} finally {
				instances.delete_instance(key);
			}
		});

		test("O7. an orphan never writes over a live instance's pending edit of the same field", async () => {
			const { self, key } = await make_failed_row_instance();
			cc.orphan_unsaved_instance(self);

			const fresh = make_sibling(self, { id: key });
			fresh.set_changed_data({ action: 'update', key: 0, value: 'typed later' });
			expect(events.get_unsaved_instances()).toContain(fresh);
			const before = requests.length;

			const answer = await self.save();
			await tick();

			expect(answer).toBe(false);
			expect(requests.length, 'the older orphan edit reached the wire').toBe(before);
			expect(events.orphaned_unsaved.has(self)).toBe(false);
			expect(events.get_unsaved_instances()).not.toContain(self);
			expect(events.get_unsaved_instances()).toContain(fresh);
			expect(self.status).toBe('destroyed');
		});

		test('O8. the orphan is off the event bus', async () => {
			const { self } = await make_failed_row_instance();
			const channel = `sync_data_${self.id_base}_${self.lang}`;
			let calls = 0;
			self.events_tokens = [event_manager.subscribe(channel, () => calls++)];

			cc.orphan_unsaved_instance(self);
			event_manager.publish(channel, { caller: { id: 'another' } });

			expect(calls, 'a sync_data_ still reaches the orphan').toBe(0);
			expect(self.events_tokens).toEqual([]);
			expect(self.data.changed_data).toEqual(EDIT('dirty'));
		});

		test('O9a. the sweep retires an orphan with nothing left to send', async () => {
			const { self } = await make_failed_row_instance();
			cc.orphan_unsaved_instance(self);
			self.data.changed_data = [];
			self.failed_changed_data = null;
			const before = requests.length;

			await cc.save_unsaved_components();
			await tick();

			expect(requests.length).toBe(before);
			expect(events.orphaned_unsaved.has(self), 'an empty orphan pins the guard forever').toBe(
				false,
			);
			expect(events.get_unsaved_instances()).not.toContain(self);
			expect(self.status).toBe('destroyed');
			expect((globalThis as Any).window.unsaved_data).toBe(false);
		});

		test('O9b. but never a component_password orphan (registered without changed_data)', async () => {
			const row = { id: 'section_record_row', ar_instances: [] as Any[] };
			const self = make_instance({ caller: row, model: 'component_password' });
			row.ar_instances.push(self);
			responders.push(() => failure('validation.password_policy'));
			await self.change_value({ changed_data: EDIT('weak'), refresh: false });
			cc.orphan_unsaved_instance(self);

			await cc.save_unsaved_components();
			await tick();

			expect(events.orphaned_unsaved.has(self)).toBe(true);
			expect(self.status).not.toBe('destroyed');
			expect((globalThis as Any).window.unsaved_data).toBe(true);
		});

		test('O10. orphaning never evicts another instance that owns the cache key', async () => {
			const { self, key } = await make_failed_row_instance();
			const fresh = make_sibling(self, { id: key });
			// the cache entry under the key is ALREADY the fresh instance
			instances.add_instance(key, fresh);
			try {
				cc.orphan_unsaved_instance(self);
				expect(instances.get_instance_by_id(key), 'the orphan evicted a fresh instance').toBe(
					fresh,
				);
			} finally {
				instances.delete_instance(key);
			}
		});

		test('O11. an orphan arms the unsaved guard on its own, even deregistered', async () => {
			const { self } = await make_failed_row_instance();
			cc.orphan_unsaved_instance(self);

			events.deregister_unsaved_instance(self);

			expect(events.get_unsaved_instances()).not.toContain(self);
			expect(
				(globalThis as Any).window.unsaved_data,
				'the guard depends on the orphan also being registered',
			).toBe(true);
		});

		/** a failed multi-value instance orphaned from its row */
		const make_multi_orphan = async (changed: Any[]) => {
			const row = { id: 'section_record_row', ar_instances: [] as Any[] };
			const self = make_multi({ caller: row });
			row.ar_instances.push(self);
			responders.push(() => failure('client.aborted'));
			await self.change_value({ changed_data: changed, refresh: false });
			cc.orphan_unsaved_instance(self);
			const fresh = make_sibling(self, { id: self.orphaned_id });
			fresh.data = { ...fresh.data, ...MULTI(), changed_data: [] };
			fresh.db_data = { ...fresh.db_data, ...MULTI() };
			return { self, fresh };
		};

		test('O12. a newer save of ANOTHER item keeps the orphan and its edit', async () => {
			const { self, fresh } = await make_multi_orphan([ITEM(1, 'A1')]);

			await fresh.change_value({ changed_data: [ITEM(2, 'B2')], refresh: false });
			await tick();

			expect(events.orphaned_unsaved.has(self), 'an edit of another item retired the orphan').toBe(
				true,
			);
			const before = requests.length;
			await cc.save_unsaved_components();
			await tick();
			expect(requests.length, 'the orphan edit of item 1 was never sent').toBe(before + 1);
			expect(requests[requests.length - 1].data.changed_data).toEqual([ITEM(1, 'A1')]);
			expect(events.orphaned_unsaved.has(self)).toBe(false);
		});

		test('O13. two inserts of DIFFERENT locators are independent; the same locator supersedes', async () => {
			const LOCATOR = (section_id: string) => ({
				action: 'insert',
				key: null,
				value: { type: 'dd151', section_tipo: 'test3', section_id },
			});
			const x = LOCATOR('7');
			const { self, fresh } = await make_multi_orphan([x]);

			await fresh.save([LOCATOR('8')]);
			await tick();
			expect(events.orphaned_unsaved.has(self), 'an insert of Y retired the insert of X').toBe(
				true,
			);

			await fresh.save([LOCATOR('7')]);
			await tick();
			expect(events.orphaned_unsaved.has(self), 'a newer insert of X left the older one').toBe(
				false,
			);
			const before = requests.length;
			await cc.save_unsaved_components();
			expect(requests.length).toBe(before);
		});

		test("O14. an orphan still sends its item when a live instance's pending edit is on ANOTHER item", async () => {
			const { self, fresh } = await make_multi_orphan([ITEM(1, 'A1')]);
			fresh.set_changed_data(ITEM(2, 'typed later'));
			const before = requests.length;

			const answer: Any = await self.save();
			await tick();

			expect(answer.ok, 'the orphan was retired by an unrelated pending edit').toBe(true);
			expect(requests.length).toBe(before + 1);
			expect(requests[requests.length - 1].data.changed_data).toEqual([ITEM(1, 'A1')]);
			expect(events.get_unsaved_instances()).toContain(fresh);
		});

		test('O15. a whole-field save (set_data) supersedes every item of the orphan', async () => {
			const { self, fresh } = await make_multi_orphan([ITEM(1, 'A1')]);

			await fresh.save([{ action: 'set_data', key: null, value: [{ id: 1, value: 'z' }] }]);
			await tick();

			expect(events.orphaned_unsaved.has(self)).toBe(false);
			expect(self.status).toBe('destroyed');
		});
	});

	// ──────────────────────────────────────────────────────────────────────────
	describe('E. events.js snapshots are copies', () => {
		test('E1. get_unsaved_instances and uncommitted_nodes_snapshot cannot mutate the registry', () => {
			const instance = {};
			const node = {};
			events.register_unsaved_instance(instance);
			events.register_uncommitted_input(node);

			const listed = events.get_unsaved_instances();
			const nodes = events.uncommitted_nodes_snapshot();
			expect(listed).toEqual([instance]);
			expect(nodes).toEqual([node]);

			listed.length = 0;
			nodes.length = 0;
			expect(events.get_unsaved_instances()).toEqual([instance]);
			expect(events.uncommitted_nodes_snapshot()).toEqual([node]);
		});

		test('E2. uncommitted_nodes_snapshot drops a node that left the document', () => {
			const had_document = 'document' in globals;
			const saved_document = globals.document;
			let in_document = true;
			globals.document = { contains: () => in_document };
			try {
				const node = { nodeType: 1 };
				events.register_uncommitted_input(node);
				expect(events.uncommitted_nodes_snapshot()).toEqual([node]);

				in_document = false; // a refresh re-rendered the field
				expect(events.uncommitted_nodes_snapshot(), 'a detached node was listed').toEqual([]);
			} finally {
				if (had_document) globals.document = saved_document;
				else Reflect.deleteProperty(globals, 'document');
			}
		});
	});

	// ──────────────────────────────────────────────────────────────────────────
	describe('W. orphaned_unsaved writers are confined', () => {
		// (the source census over the browser trees lives in
		// orphaned_unsaved_writers_tripwire.test.ts — an indexed tripwire on the
		// shared browser lister; these legs pin the OUTCOME)
		test('W3. the exported view has no mutators and is frozen; the writers are not exported', () => {
			const view = events.orphaned_unsaved;
			expect(Object.isFrozen(view)).toBe(true);
			expect(view.add).toBeUndefined();
			expect(view.delete).toBeUndefined();
			expect(view.clear).toBeUndefined();
			expect(typeof view.has).toBe('function');
			expect(typeof view.size).toBe('number');
			expect(events.add_orphaned_unsaved, 'a writer is exported').toBeUndefined();
			expect(events.delete_orphaned_unsaved, 'a writer is exported').toBeUndefined();
		});

		test('W4. OUTCOME: the writer capability is already claimed — any other module is refused', () => {
			// component_common.js (imported above) claimed it at load: whatever
			// spelling a later module uses to reach the claim, it throws
			expect(typeof events.claim_orphaned_unsaved_writers).toBe('function');
			expect(() => events.claim_orphaned_unsaved_writers()).toThrow(/already claimed/);
		});
	});
}
