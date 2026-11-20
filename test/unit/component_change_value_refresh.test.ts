/**
 * CHANGE_VALUE → REFRESH — the contract of
 *   client/dedalo/core/component_common/js/component_common.js (change_value)
 *   against the REAL client/dedalo/core/common/js/common.js (refresh)
 *
 * THE GAP THIS CLOSES. `change_value({refresh:true})` held self.status at
 * 'changing' across the whole call, while `common.refresh` REFUSES any status
 * but 'rendered' (it warns "/// destroyed fail" and returns false). So ~30 call
 * sites asked for a refresh that never happened: the value was saved and the
 * component kept rendering the old data until the page was reloaded. The cure
 * restores the real status around the refresh call only, and moves the
 * queue authority off the status string onto `self.changing` — so an
 * overlapping change_value arriving mid-refresh still queues instead of racing
 * the destroy/rebuild.
 *
 * HOW IT RUNS. Both modules are browser ES modules whose leaf imports
 * (event_manager, data_manager, ui, instances, css…) are serving-time seams
 * that need a DOM. As in test/unit/transcription_status_panel.test.ts, a
 * `Bun.plugin` `onResolve` hook redirects each leaf specifier before Bun's
 * resolver runs — here to the real, minimal stub modules in
 * test/unit/fixtures/client_module_stubs/ (a `mock.module` virtual path is NOT
 * usable for these: unlike the panel's non-existent `core/…/ui.js` seam, these
 * specifiers resolve on disk and Bun reads the redirect target, so it must be
 * a real file). `common.js` itself is NOT stubbed: refresh() is the real
 * function under test, driven against a stub instance whose
 * destroy/build/render are spies.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { dirname, join, resolve } from 'node:path';
import { plugin } from 'bun';
import { isIsolatedGateChild, mirrorIsolatedGate } from '../helpers/isolated_gate.ts';

// ISOLATED GATE (test/helpers/isolated_gate.ts): this file substitutes client
// modules, which are process-global — in the tier's process it only MIRRORS a
// child run of itself; its body below registers in that child alone.
if (!isIsolatedGateChild(import.meta.path)) mirrorIsolatedGate(import.meta.path);
else {
	// Repo root derived from this file's location — never a checkout-specific
	// literal. (The literal was another machine's checkout, so on any other clone
	// the file did not load at all and bun reported it as an unnamed failure.)
	// The durable cure the 2026-08-22 note asked for is in place (2026-10-02): this
	// file is an ISOLATED GATE (its own process, test/helpers/isolated_gate.ts) and
	// its child runs with Bun's on-disk transpiler cache OFF — the cache baked
	// plugin-resolved imports into cached module builds and served them to later
	// processes, which is what the old "ENOENT on a file that exists" and "8/8 alone
	// but starves another file" readings were measuring.
	const REPO = join(import.meta.dir, '..', '..');
	const COMPONENT_COMMON_PATH = `${REPO}/client/dedalo/core/component_common/js/component_common.js`;
	const COMMON_PATH = `${REPO}/client/dedalo/core/common/js/common.js`;
	const STUBS = `${REPO}/test/unit/fixtures/client_module_stubs`;

	// ────────────────────────────────────────────────────────────────────────────
	// Leaf stubs: one on-disk module per leaf specifier the two files import.
	// ────────────────────────────────────────────────────────────────────────────

	const CORE = `${REPO}/client/dedalo/core`;

	/**
	 * REAL client module (absolute path) → its stub. Matched on the RESOLVED
	 * TARGET, never on the specifier's spelling: `error_dispatch.js` imports
	 * `./ui.js`, which no `common/js/ui.js` suffix filter saw, so the REAL ui.js
	 * loaded and died on its serving-only `lib/codex-tooltip` import — this file was
	 * red ALONE and green only when an earlier file had already masked ui.js.
	 */
	const LEAF_STUBS = new Map<string, string>([
		[`${CORE}/common/js/utils/index.js`, `${STUBS}/utils_index.js`],
		[`${CORE}/common/js/event_manager.js`, `${STUBS}/event_manager.js`],
		[`${CORE}/common/js/data_manager.js`, `${STUBS}/data_manager.js`],
		[`${CORE}/common/js/instances.js`, `${STUBS}/instances.js`],
		[`${CORE}/common/js/events.js`, `${STUBS}/events.js`],
		[`${CORE}/common/js/ui.js`, `${STUBS}/ui.js`],
		[`${CORE}/common/js/render_common.js`, `${STUBS}/render_common.js`],
		[`${CORE}/page/js/css.js`, `${STUBS}/css.js`],
		[`${CORE}/component_common/js/events_subscription.js`, `${STUBS}/events_subscription.js`],
		[`${CORE}/component_common/js/dataframe.js`, `${STUBS}/dataframe.js`],
	]);

	/**
	 * THE REDIRECT IS LIVE ONLY WHILE THIS FILE RUNS. `Bun.plugin` is
	 * process-global, cannot be unregistered, and survives `bun test --isolate`
	 * (which resets the global object, the module registry and `mock.module`, NOT
	 * plugins). Unconditional, it answered every later file's client imports with
	 * these stubs: `client_relation_move_native` died on a utils stub without
	 * `strip_tags`, `client_tm_list_destroy_race` on an events stub without
	 * `when_in_dom`, and every ui-reading client gate on this ui stub — in whatever
	 * file order a host's readdir produced (the CI image's put this file before
	 * them; the Mac's after). So the hook answers only between this file's
	 * `beforeAll` and `afterAll`, and only for an importer inside the client tree;
	 * otherwise it returns nothing and Bun resolves normally.
	 */
	let redirecting = false;

	beforeAll(() => {
		redirecting = true;
		plugin({
			name: 'component-common-change-value-leaf-stubs',
			setup(build) {
				build.onResolve({ filter: /^\.{1,2}\/.*\.js$/ }, (args) => {
					if (!redirecting || !args.importer.startsWith(`${CORE}/`)) return undefined;
					const stub = LEAF_STUBS.get(resolve(dirname(args.importer), args.path));
					return stub === undefined ? undefined : { path: stub };
				});
			},
		});
	});
	afterAll(() => {
		redirecting = false;
	});

	// biome-ignore lint/suspicious/noExplicitAny: the modules under test are untyped client JS.
	let component_common_module: any;
	// biome-ignore lint/suspicious/noExplicitAny: idem.
	let common_module: any;

	beforeAll(async () => {
		(globalThis as Record<string, unknown>).SHOW_DEBUG = false;
		component_common_module = await import(COMPONENT_COMMON_PATH);
		common_module = await import(COMMON_PATH);
	});

	// ────────────────────────────────────────────────────────────────────────────
	// The stub instance: real change_value + real refresh, spied lifecycle
	// ────────────────────────────────────────────────────────────────────────────

	interface Calls {
		save: number;
		build: number;
		render: number;
		destroy: number;
		/** self.status as refresh() saw it, per call */
		status_at_refresh: string[];
		/** order marker of save starts/ends, to prove serialisation */
		trace: string[];
	}

	// biome-ignore lint/suspicious/noExplicitAny: stub instance mirrors untyped client JS.
	type Instance = any;

	function make_instance(status: string): { instance: Instance; calls: Calls } {
		const calls: Calls = {
			save: 0,
			build: 0,
			render: 0,
			destroy: 0,
			status_at_refresh: [],
			trace: [],
		};

		const instance: Instance = {
			model: 'component_input_text',
			id: 'test_instance',
			id_base: 'test_base',
			lang: 'lg-eng',
			standalone: true, // skips update_datum
			status,
			changing: false,
			change_value_pool: [],
			data: { entries: [], changed_data: [] },
			paginator: null,

			// real functions under test
			change_value: component_common_module.component_common.prototype.change_value,
			refresh: async function (options: Record<string, unknown> = {}) {
				calls.status_at_refresh.push(this.status);
				return common_module.common.prototype.refresh.call(this, options);
			},

			// the value-model update is not what this gate is about
			update_data_value: () => true,

			save: async (_changed_data: unknown) => {
				calls.save = calls.save + 1;
				const marker = `save_${calls.save}`;
				calls.trace.push(`${marker}_start`);
				await Promise.resolve();
				calls.trace.push(`${marker}_end`);
				return { result: true };
			},

			// lifecycle spies used by the REAL common.refresh
			destroy: async function () {
				calls.destroy = calls.destroy + 1;
				this.status = 'destroyed';
				return true;
			},
			build: async function (_autoload: boolean) {
				calls.build = calls.build + 1;
				this.status = 'built';
				return true;
			},
			render: async function (_options: Record<string, unknown>) {
				calls.render = calls.render + 1;
				this.status = 'rendered';
				return {};
			},
		};

		return { instance, calls };
	}

	const changed_data = () => [Object.freeze({ action: 'update', key: 0, value: 'new value' })];

	let warnings: string[] = [];
	let errors: string[] = [];
	const real_warn = console.warn;
	const real_error = console.error;
	beforeEach(() => {
		warnings = [];
		errors = [];
		console.warn = (...args: unknown[]) => {
			warnings.push(args.map(String).join(' '));
		};
		console.error = (...args: unknown[]) => {
			errors.push(args.map(String).join(' '));
		};
	});
	afterAll(() => {
		console.warn = real_warn;
		console.error = real_error;
	});

	/** Let the finally block's queue drain (and the drained call) settle. */
	const settle = async () => {
		for (let i = 0; i < 8; i++) await Promise.resolve();
	};

	// ────────────────────────────────────────────────────────────────────────────

	describe('change_value({refresh:true}) — THE gap', () => {
		test('a rendered instance really rebuilds: refresh runs past its status guard', async () => {
			const { instance, calls } = make_instance('rendered');

			const api_response = await instance.change_value({
				changed_data: changed_data(),
				refresh: true,
			});

			expect(api_response).toEqual({ result: true });
			expect(calls.save, 'the value is saved').toBe(1);
			expect(
				calls.status_at_refresh,
				'refresh must be told the truth: the DOM is rendered',
			).toEqual(['rendered']);
			// The proof the refusal did NOT happen: refresh got all the way to
			// destroy + build + render.
			expect(calls.destroy).toBe(1);
			expect(calls.build, 'THE assertion: the component actually rebuilt').toBe(1);
			expect(calls.render).toBe(1);
			expect(warnings.join(' ')).not.toContain('destroyed fail');
			expect(instance.status).toBe('rendered');
			expect(instance.changing, 'the in-flight flag is always released').toBe(false);
		});

		test('refresh:false still never refreshes (unchanged meaning)', async () => {
			const { instance, calls } = make_instance('rendered');

			await instance.change_value({ changed_data: changed_data(), refresh: false });

			expect(calls.save).toBe(1);
			expect(calls.status_at_refresh).toEqual([]);
			expect(calls.build).toBe(0);
		});

		test('an instance that was never rendered is still refused — no forced refresh', async () => {
			const { instance, calls } = make_instance('built'); // built, never rendered

			await instance.change_value({ changed_data: changed_data(), refresh: true });

			expect(calls.save, 'the save still happens').toBe(1);
			expect(calls.status_at_refresh, 'the real status is stated, not a fabricated one').toEqual([
				'built',
			]);
			expect(calls.destroy, 'refresh refuses a non-rendered instance').toBe(0);
			expect(calls.build).toBe(0);
			expect(warnings.join(' ')).toContain('destroyed fail');
			expect(instance.status).toBe('built');
			expect(instance.changing).toBe(false);
		});
	});

	describe('the queueing invariant survives the fix', () => {
		test('a change_value overlapping the SAVE is queued, not run in parallel', async () => {
			const { instance, calls } = make_instance('rendered');

			const first = instance.change_value({ changed_data: changed_data(), refresh: false });
			// second call arrives while the first is mid-save
			const second = instance.change_value({ changed_data: changed_data(), refresh: false });
			expect(instance.change_value_pool.length, 'the overlapping call was deferred').toBe(1);

			await first;
			await second;
			await Promise.resolve();
			await Promise.resolve();

			// saves never interleave
			expect(calls.trace).toEqual(['save_1_start', 'save_1_end', 'save_2_start', 'save_2_end']);
		});

		test('a change_value overlapping the REFRESH is queued too (the trap)', async () => {
			const { instance, calls } = make_instance('rendered');

			let overlapped: Promise<unknown> | null = null;
			let pool_size_during_refresh = -1;
			let saves_during_refresh = -1;
			const real_build = instance.build;
			instance.build = async function (autoload: boolean) {
				// mid-refresh: the status has been restored to 'rendered', so ONLY the
				// self.changing flag can still make an overlapping call queue.
				if (!overlapped) {
					overlapped = instance.change_value({ changed_data: changed_data(), refresh: false });
					pool_size_during_refresh = instance.change_value_pool.length;
					saves_during_refresh = calls.save;
				}
				return real_build.call(this, autoload);
			};

			await instance.change_value({ changed_data: changed_data(), refresh: true });
			await overlapped;
			await Promise.resolve();
			await Promise.resolve();

			expect(pool_size_during_refresh, 'the mid-refresh call must be deferred, never raced').toBe(
				1,
			);
			expect(saves_during_refresh, 'and it must not have saved yet').toBe(1);
			expect(calls.build, 'the refresh itself ran').toBe(1);
			expect(calls.trace).toEqual(['save_1_start', 'save_1_end', 'save_2_start', 'save_2_end']);
			expect(instance.changing).toBe(false);
		});
	});

	describe('the throwing paths recover (no deadlock, no dropped queued call)', () => {
		test('a save that throws: status restored, changing cleared, the queued call still runs', async () => {
			const { instance, calls } = make_instance('rendered');

			const ok_save = instance.save;
			instance.save = async function (changed: unknown) {
				// only the FIRST save fails; the queued one must still get through
				if (calls.save === 0) {
					calls.save = calls.save + 1;
					calls.trace.push('save_1_start');
					await Promise.resolve();
					calls.trace.push('save_1_throw');
					throw new Error('the network died mid-save');
				}
				return ok_save.call(this, changed);
			};

			const first = instance.change_value({ changed_data: changed_data(), refresh: false });
			// the queued call arrives while the first is inside its throwing path
			const queued = instance.change_value({ changed_data: changed_data(), refresh: false });
			expect(instance.change_value_pool.length, 'the overlapping call was deferred').toBe(1);

			await expect(first).rejects.toThrow('the network died mid-save');
			void queued;
			await settle();

			expect(instance.status, 'a throw must never leave the status stuck').toBe('rendered');
			expect(instance.changing, 'the in-flight flag must be released on the throwing path').toBe(
				false,
			);
			expect(calls.save, 'the queued call was NOT dropped').toBe(2);
			expect(instance.change_value_pool.length, 'the pool drained exactly once').toBe(0);
			expect(calls.trace).toEqual(['save_1_start', 'save_1_throw', 'save_2_start', 'save_2_end']);
		});

		test('a refresh that throws: reported, NOT propagated — the save stands', async () => {
			const { instance, calls } = make_instance('rendered');
			instance.build = async function () {
				calls.build = calls.build + 1;
				this.status = 'built';
				throw new Error('build died mid-rebuild');
			};

			// THE decision: the save is committed, so change_value RESOLVES with the
			// api_response. A rejection here would tell ~30 callers the edit was lost.
			const api_response = await instance.change_value({
				changed_data: changed_data(),
				refresh: true,
			});

			expect(api_response, 'the committed save is still the answer').toEqual({ result: true });
			expect(calls.build, 'the rebuild was attempted').toBe(1);
			expect(
				errors.join(' '),
				'CONVENTIONS §1: a swallowed failure must be REPORTED, never silent',
			).toContain('[component_common] change_value');
			expect(errors.join(' ')).toContain('build died mid-rebuild');
			expect(
				instance.status,
				'a half-destroyed instance must not be left describing itself as destroyed/built',
			).toBe('rendered');
			expect(instance.changing).toBe(false);
			expect(instance.change_value_pool.length).toBe(0);
		});

		test('a queued call arriving while the first is in its THROWING refresh path is not dropped', async () => {
			const { instance, calls } = make_instance('rendered');

			let queued: Promise<unknown> | null = null;
			let pool_size_during_throw = -1;
			instance.build = async function () {
				calls.build = calls.build + 1;
				this.status = 'built';
				if (!queued) {
					queued = instance.change_value({ changed_data: changed_data(), refresh: false });
					pool_size_during_throw = instance.change_value_pool.length;
				}
				throw new Error('build died mid-rebuild');
			};

			await instance.change_value({ changed_data: changed_data(), refresh: true });
			void queued;
			await settle();

			expect(pool_size_during_throw, 'the mid-rebuild call must be deferred').toBe(1);
			expect(calls.save, 'and it must still run after the failure').toBe(2);
			expect(instance.change_value_pool.length, 'the pool drained exactly once').toBe(0);
			expect(instance.status).toBe('rendered');
			expect(instance.changing).toBe(false);
			expect(calls.trace).toEqual(['save_1_start', 'save_1_end', 'save_2_start', 'save_2_end']);
		});
	});

	// ────────────────────────────────────────────────────────────────────────────
	// run_save → broadcast_record_save (open_window on_blur watch, child side)
	// ────────────────────────────────────────────────────────────────────────────

	describe('save() tells the opener window: saving, then saved only on success', () => {
		// biome-ignore lint/suspicious/noExplicitAny: untyped client stub modules.
		let stubs: { utils: any; dm: any };
		beforeAll(async () => {
			stubs = {
				utils: await import(`${STUBS}/utils_index.js`),
				dm: await import(`${STUBS}/data_manager.js`),
			};
		});

		const save_with = async (request: () => Promise<unknown>) => {
			stubs.utils.broadcast_calls.length = 0;
			stubs.dm.data_manager.request = request;
			const instance: Instance = {
				model: 'component_input_text',
				tipo: 'test52',
				section_tipo: 'test3',
				section_id: 1,
				mode: 'list',
				lang: 'lg-eng',
				id: 'test_save_broadcast',
				id_base: 'test_save_broadcast',
				data: { entries: [], changed_data: [] },
				db_data: { entries: [] },
				node: null,
				save: component_common_module.component_common.prototype.save,
			};
			await instance.save([{ action: 'insert', key: 0, value: 'x' }]);
			return [...stubs.utils.broadcast_calls];
		};

		test('success → saving, saved', async () => {
			const calls = await save_with(async () => ({
				ok: true,
				data: { data: [{ tipo: 'test52', section_tipo: 'test3', section_id: 1, entries: [] }] },
			}));
			expect(calls).toEqual(['saving', 'saved']);
		});

		test('failed request → saving, failed (never saved)', async () => {
			// a rejected transport becomes run_save's typed failure envelope
			const calls = await save_with(async () => {
				throw new Error('network down');
			});
			expect(calls).toEqual(['saving', 'failed']);
		});
	});

	// ────────────────────────────────────────────────────────────────────────────
	// the stubbed emptiness rule (common.js get_fallback_value reads it)
	// ────────────────────────────────────────────────────────────────────────────

	describe('the stub answers is_empty_entry as the client does', () => {
		test('a rich-text ghost is EMPTY (the fallback face), real text is not', async () => {
			const { is_empty_entry } = await import(`${STUBS}/utils_index.js`);
			for (const ghost of ['<p></p>', '<p> </p>', '<br data-mce-bogus="1">']) {
				expect(is_empty_entry({ value: ghost }), ghost).toBe(true);
			}
			for (const empty of [undefined, null, {}, { value: '' }, { value: '  ' }, { value: [] }]) {
				expect(is_empty_entry(empty), JSON.stringify(empty)).toBe(true);
			}
			for (const value of ['<p>a</p>', 'a', 0, ['a']]) {
				expect(is_empty_entry({ value }), JSON.stringify(value)).toBe(false);
			}
		});
	});
}
