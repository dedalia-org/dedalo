/**
 * THE RELATION MOVE CONTRACT — P0-11 (audit CLI-02 + CLI-03).
 *
 * WHY THIS FILE EXISTS. Two client flows moved or replaced a curated relation by
 * DESTROYING the value they held BEFORE the step that could fail, and neither one
 * read the answer of the step that could fail:
 *
 *   FLOW 1 — cross-portal move, drag_and_drop.js `on_drop`. It called
 *   `self.link_record(locator)` WITHOUT awaiting it, discarded the answer, and then
 *   called `source_instance.unlink_record(locator)` unconditionally.
 *   `link_records` never throws — it ANSWERS `{linked, refused, total}` and names
 *   every locator that did not land (data_limit, duplicate, api_error, not_stored,
 *   refused_by_server). On any refusal the relation was gone from the SOURCE portal
 *   and had never been created in the TARGET one, and the operator saw nothing.
 *
 *   FLOW 2 — `data_limit:1` picker replace, component_portal.js `link_terms_handler`.
 *   It looped `await self.delete_locator(locator)` over every stored locator, never
 *   inspected a single answer, and only then called `link_records`. A refused pick
 *   (non-selectable term, target outside the caller's declared sections, unreadable
 *   target, expired session) therefore left the single-valued field EMPTY, and the
 *   alert named only the pick refusal, never the destruction. On the HAPPY path the
 *   same code computed `landed = total_after - total_before` = 0 for a 1-out/1-in
 *   replace, reported a stored change as `duplicate`, and returned before the refresh.
 *
 * These records are irreplaceable cultural-heritage curation. A silent destruction is
 * the worst defect class this system has, because nobody is told to look.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS GATE PROVES, and it runs the REAL client modules — not re-implementations:
 *
 *  A. FLOW 1, SERVER ACCEPTANCE: the real `on_drop` drives the real
 *     `component_portal.prototype.link_records` on the target and the real
 *     `component_portal.prototype.unlink_record` on a source instance registered in
 *     the REAL instance registry (`instances.js` add_instance). The move lands in the
 *     target and the source is unlinked by a remove that NAMES the item id.
 *  B. FLOW 1, SERVER REFUSAL: the target's save refuses the insert. THE SOURCE
 *     RELATION STILL EXISTS — the source's save door is never called at all — and the
 *     operator is alerted.
 *  C. FLOW 1, the P0-8 reachable path: a dragged locator with no usable id never
 *     reaches the wire as `{action:'remove', id:null}`.
 *  D. FLOW 2, SERVER ACCEPTANCE: one save, `changed_data` = removes THEN inserts, the
 *     new value is stored, `linked.length===1`, nothing refused, and the component IS
 *     refreshed (the mis-report regression).
 *  E. FLOW 2, ORDERING IS LOAD-BEARING: the same batch emitted inserts-first against
 *     the same selection cap destroys the value. This is why D asserts an order.
 *  F. FLOW 2, SERVER REFUSAL: the insert is refused. The refusal is reported as
 *     `replace_failed — …` (never as `duplicate`), and THE PREVIOUS VALUE IS BACK in
 *     the store via the compensating re-link. A second case pins the honest failure
 *     of that compensation.
 *  G. FLOW 2, the P0-8 reachable path: a `replace_entries` entry without a usable id
 *     is refused with `replace_entry_without_id` and ZERO saves are issued.
 *  H. THE CENSUS (total, derived): no call site of `link_record` / `link_records`
 *     anywhere under `client/` or `tools/ ** /js` discards the return value, except a
 *     SHRINK-ONLY list with a reason per entry.
 *  I. THE DELEGATED DRAG CORE (engineering/wire_contract/WC-2026-10-30-section-record-row-box.md,
 *     stage-3 addendum):
 *     the pure `decide_drop` (page-2 keys ABSOLUTE, `source_id` not `tipo` decides
 *     REORDER, declared order / view_order → null, foreign → null, a superseded window
 *     generation → stale), the one-function gates, the `on_drop` adapter (absolute keys
 *     with `index`; a kind-less pre-window payload is foreign and `options.paginated_key`
 *     names no target since stage 5; a foreign drop returns false without preventDefault; a reorder whose
 *     sort_data throws is reported UNCONFIRMED, never "not saved"), every drag notice
 *     asserted in the text the page RENDERS — the served label table loaded, English
 *     and Spanish, so a borrowed code whose derived label overrides the sentence is
 *     red — and the binders on a
 *     counting fake DOM: one listener set on content_data (none on rows) removed by
 *     the window signal, a window retired mid-drag releasing tmp + its hold (and only
 *     its own), the portal payload under its MIME type, foreign dragover/drop
 *     bubbling to an ancestor, a stale DROP consumed + one `resource.conflict` notice +
 *     nothing sent, the move-to-position hold/release, the wrapper MOVE drop executed
 *     (link, then unlink by id) and an own-reorder / foreign drop on the wrapper not
 *     consumed, touch_pick `peek()` deciding before anything is consumed, the tool
 *     payload text/plain only, the declared_order single reader, and the LEGACY
 *     symbol set: every top-level binding classified (total), the legacy set equal
 *     to the WC entry's list (growth is a contract edit).
 *
 * THE SERVER DOOR IS THE REAL ONE WHERE IT MATTERS. Every `changed_data` this gate's
 * fake save receives is first passed through the ACTUAL server-side refusal predicate
 * `unnamedRemoveRefusal` (src/core/section/record/save_component.ts), so C and G are
 * not checked against a hand-written idea of the contract — they are checked against
 * the function the API door calls. The gate additionally pins, by reading the source,
 * that `save_component.ts` still refuses an id-less remove: if that ever relaxes back
 * into "clear ALL entries in all languages", the premise of the client's id guards is
 * gone and this gate says so.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS GATE DOES **NOT** PROVE — stated plainly, because a gate that overclaims
 * is worse than a missing one:
 *
 *  - NOT the real HTTP save. `change_value` is replaced by an in-memory store that
 *    applies `changed_data` the way `save_component.ts` does (in order, over one
 *    mutating array, a refused relation insert DROPPED rather than failing the save)
 *    and enforces a resulting-count selection cap the way `relations/save.ts` does.
 *    That is a MODEL of two server rules. It is anchored to the real
 *    `unnamedRemoveRefusal` and to source assertions, but it is not the server.
 *  - NOT rendering. `refresh()` here re-reads the store; it draws no DOM. Whether the
 *    new value is VISIBLE after an accepted move is not decided here.
 *  - NOT the real browser gesture: the binders run on a fake DOM with synthetic events
 *    (no real DragEvent/DataTransfer, no layout, no row window lifecycle), and no view
 *    calls them yet. Stage 5 of WC-2026-10-30-section-record-row-box wires them and
 *    adds the browser suite `test_portal_row_drag` then; it does NOT exist yet. Nor
 *    that `alert()` or the stale/failed-reorder toast reaches a human (the notices
 *    are observed on the `notification` event they publish, not on screen).
 *  - NOT the dataframe cascade: `save_component.ts` removeDataframeDataById destroys
 *    paired frames on a remove and no compensating re-link brings them back. The
 *    client comment says so; nothing here exercises it.
 *
 * CLOSING THAT GAP is a `bun run test:client` spec (Mocha in headless Chrome, real
 * server, real DOM). It is writable: the generic `test` TLD already ships a compatible
 * portal pair — `src/core/test_data/test_tld_ontology.json` carries
 * `properties.draggable_to` on test1611 ↔ test1613 (73 nodes have the property). It is
 * NOT in this change: this agent was instructed not to run the client suite, and an
 * unexecuted browser spec asserting a destruction path is exactly the gate that proves
 * nothing. The behavioural defect itself was pure control flow inside these two
 * functions, which is why it is decidable — and mutation-proved — at this seam.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { plugin } from 'bun';
import { CLIENT_LIB_URL_PREFIX, resolveClientLibPath } from '../../src/core/client_libs/serving.ts';
import { unnamedRemoveRefusal } from '../../src/core/section/record/save_component.ts';
import { resolveClientModuleOverride } from '../helpers/client_module_overrides.ts';
import { isIsolatedGateChild, mirrorIsolatedGate } from '../helpers/isolated_gate.ts';

// ISOLATED GATE (test/helpers/isolated_gate.ts): this file substitutes client
// modules, which are process-global — in the tier's process it only MIRRORS a
// child run of itself; its body below registers in that child alone.
if (!isIsolatedGateChild(import.meta.path)) mirrorIsolatedGate(import.meta.path);
else {
	const REPO_ROOT = resolve(import.meta.dir, '..', '..');
	const CLIENT_ROOT = join(REPO_ROOT, 'client');
	const TOOLS_ROOT = join(REPO_ROOT, 'tools');

	/**
	 * THE SERVING ALIAS, reproduced for the module loader ONLY.
	 *
	 * The client's import specifiers are browser URLs, not filesystem paths: `/dedalo/lib/*`
	 * is served out of node_modules (src/core/client_libs/registry.ts — there is no
	 * `client/dedalo/lib/` on disk) and `/dedalo/tools/*` out of the repo's top-level
	 * `tools/` (src/core/tools/serving.ts), which then imports back into
	 * `client/dedalo/core/`. Without this, importing component_portal.js under Bun dies on
	 * `Cannot find module '../../../lib/codex-tooltip/dist/tooltip.js'`.
	 *
	 * SAFETY: the hook fires only for importers inside client/ or tools/, and only AFTER
	 * plain relative resolution has been tried and the file does not exist — so it can
	 * never shadow normal resolution for the rest of the suite. It rewrites nothing else.
	 */
	const SERVE_ALIAS: ReadonlyArray<readonly [RegExp, string]> = [
		[/(?:^|\/)core\/(.+)$/, `${join(CLIENT_ROOT, 'dedalo', 'core')}/`],
		[/(?:^|\/)lib\/(.+)$/, `${join(REPO_ROOT, 'node_modules')}/`],
		[/(?:^|\/)tools\/(.+)$/, `${TOOLS_ROOT}/`],
	];
	plugin({
		name: 'dedalo-client-serve-alias',
		setup(build) {
			// A ROOT-RELATIVE lib URL (`/dedalo/lib/<id>/<subpath>` — the spelling the
			// client uses since WC-2026-09-04 moved lz-string out of the client tree)
			// resolves through the SERVER'S OWN resolver, so the module the test loads
			// is the file the engine would serve, allowlist and confinement included.
			build.onResolve({ filter: /^\/dedalo\/lib\// }, (args) => {
				// A deliberate substitution another gate registered wins over this
				// plugin's own resolution: Bun plugins are global and first-match-wins,
				// so without this the answer would depend on which file ran first.
				const overridden = resolveClientModuleOverride(args.path);
				if (overridden !== null) return { path: overridden };
				const importer = args.importer ?? '';
				if (!importer.startsWith(CLIENT_ROOT) && !importer.startsWith(TOOLS_ROOT)) return undefined;
				const rest = args.path.slice(CLIENT_LIB_URL_PREFIX.length);
				const slash = rest.indexOf('/');
				if (slash < 0) return undefined;
				const path = resolveClientLibPath(rest.slice(0, slash), rest.slice(slash + 1));
				return path === null ? undefined : { path };
			});
			build.onResolve({ filter: /^\.\.?\// }, (args) => {
				// See the sibling hook: the shared registry answers first.
				const overridden = resolveClientModuleOverride(args.path);
				if (overridden !== null) return { path: overridden };
				const importer = args.importer ?? '';
				if (!importer.startsWith(CLIENT_ROOT) && !importer.startsWith(TOOLS_ROOT)) return undefined;
				const direct = resolve(dirname(importer), args.path);
				if (existsSync(direct)) return { path: direct };
				for (const [pattern, base] of SERVE_ALIAS) {
					const matched = args.path.match(pattern);
					if (matched && existsSync(base + matched[1])) return { path: base + matched[1] };
				}
				return undefined;
			});
		},
	});

	// ── the page globals the two modules read at RUNTIME (never at import time) ──────────
	const globals = globalThis as unknown as Record<string, unknown>;
	const saved_globals: Record<string, unknown> = {};
	let alerts: string[] = [];

	// ── the modules under test, imported for real ───────────────────────────────────────
	type Locator = {
		id?: number | string | null;
		section_tipo: string;
		section_id: string;
		from_component_tipo?: string;
		paginated_key?: number;
		tag_id?: string;
		tag_type?: string;
	};
	type LinkOutcome = {
		linked: Locator[];
		refused: Array<{ locator: Locator | null; reason: string }>;
		total: number | null;
	};
	type PortalInstance = {
		id: string;
		tipo: string;
		model: string;
		mode: string;
		total: number;
		data: { entries: Locator[]; pagination?: unknown };
		context: { properties: Record<string, unknown> };
		node: { classList: { add(c: string): void; remove(c: string): void } };
		change_value: (options: { changed_data: ChangedData }) => Promise<unknown>;
		refresh: (options?: unknown) => Promise<unknown>;
		link_records: (values: Locator[], options?: Record<string, unknown>) => Promise<LinkOutcome>;
		unlink_record: (locator: Locator) => Promise<boolean>;
	};
	type ChangedData = ReadonlyArray<{ action: string; id: number | string | null; value: unknown }>;

	let component_portal: { prototype: PortalInstance };
	let on_drop: (
		node: unknown,
		event: unknown,
		options: { caller: PortalInstance; paginated_key?: number },
	) => Promise<boolean>;
	let add_instance: (key: string, instance: unknown) => void;
	let delete_instance: (key: string) => unknown;
	// the delegated drag core (WC-2026-10-30-section-record-row-box, stage-3 addendum)
	type Decision =
		| { kind: 'reorder'; value: Locator; source_key: number; target_key: number }
		| { kind: 'move'; locator: Locator }
		| { kind: 'stale' }
		| null;
	let dnd: {
		PORTAL_ROW_MIME: string;
		PORTAL_ROW_KIND: string;
		TOOL_ROW_SOURCES: ReadonlyMap<string, string>;
		decide_drop: (self: unknown, payload: unknown, target_index?: number) => Decision;
		is_portal_payload: (payload: unknown) => boolean;
		can_reorder: (self: unknown) => boolean;
		can_drag_out: (self: unknown) => boolean;
		can_view_sort: (self: unknown, column: unknown) => boolean;
		can_save_view_order: (self: unknown) => boolean;
		can_tool_source: (self: unknown) => boolean;
		get_row_transfer_data: (options: {
			caller: unknown;
			index: number;
			caller_name?: string;
		}) => Record<string, unknown> | null;
		move_to_position_decision: (
			self: unknown,
			entry: unknown,
			position: number | string,
		) => { value: unknown; source_key: number; target_key: number } | null;
		bind_row_drag: (
			self: unknown,
			content_data: unknown,
			options?: Record<string, unknown>,
		) => boolean;
		bind_tool_row_drag: (
			self: unknown,
			content_data: unknown,
			options?: { caller_name?: string },
		) => boolean;
		bind_portal_drop: (self: unknown, wrapper: unknown) => boolean;
		release_drag_source: (self?: unknown) => boolean;
	};
	// the toast channel handle_api_error publishes on (render_api_error.js
	// render_error_toast → event_manager 'notification'): the notices are observed
	// here, never on screen
	let event_manager: {
		subscribe: (name: string, fn: (data: Record<string, unknown>) => void) => unknown;
		unsubscribe: (token: unknown) => unknown;
	};
	let touch_pick: {
		pick: (data: string, label: string) => void;
		peek: () => string | null;
		active: () => boolean;
		cancel: () => void;
		as_drop_event: () => unknown;
	};

	beforeAll(async () => {
		for (const key of [
			'window',
			'SHOW_DEBUG',
			'SHOW_DEVELOPER',
			'DEDALO_CORE_URL',
			'get_label',
			'alert',
		])
			saved_globals[key] = globals[key];
		globals.window = globalThis;
		globals.SHOW_DEBUG = false;
		globals.SHOW_DEVELOPER = false;
		globals.DEDALO_CORE_URL = '/dedalo/core';
		// THE SERVED LABELS, not `{}`: render_api_error `error_text` renders
		// get_label[label_key] BEFORE the English message, so an empty table would test
		// a fallback the logged-in page never takes (the label → message precedence is
		// part of what a notice assertion proves).
		globals.get_label = served_labels('eng');
		globals.alert = (message: string) => {
			alerts.push(String(message));
		};

		const portal_module = await import(
			join(CLIENT_ROOT, 'dedalo/core/component_portal/js/component_portal.js')
		);
		component_portal = portal_module.component_portal;
		const dnd_module = await import(
			join(CLIENT_ROOT, 'dedalo/core/component_portal/js/drag_and_drop.js')
		);
		on_drop = dnd_module.on_drop;
		dnd = dnd_module as unknown as typeof dnd;
		touch_pick = (await import(
			join(CLIENT_ROOT, 'dedalo/core/common/js/touch_pick.js')
		)) as unknown as typeof touch_pick;
		event_manager = (await import(join(CLIENT_ROOT, 'dedalo/core/common/js/event_manager.js')))
			.event_manager;
		const instances_module = await import(join(CLIENT_ROOT, 'dedalo/core/common/js/instances.js'));
		add_instance = instances_module.add_instance;
		delete_instance = instances_module.delete_instance;
	});

	afterAll(() => {
		for (const key of Object.keys(saved_globals)) {
			if (saved_globals[key] === undefined) delete globals[key];
			else globals[key] = saved_globals[key];
		}
	});

	// ────────────────────────────────────────────────────────────────────────────────────
	// THE FAKE SAVE DOOR.
	//
	// A model of the two server rules this contract turns on, and of nothing else:
	//
	//   1. `save_component.ts` applies `changed_data` IN ORDER over one mutating `items`
	//      array (remove at :1265, insert below it), and it DROPS a refused relation insert
	//      (`if (validated === null) continue;`) instead of failing the save. That drop is
	//      exactly what makes "destroy, then fail to create" reachable in one transaction.
	//   2. `relations/save.ts` refuseByPickerConstraint judges the count the set would
	//      RESULT in against the selection limit — which is why removes-first passes a
	//      `data_limit:1` replace and inserts-first does not.
	//
	// Everything it receives is first run through the REAL `unnamedRemoveRefusal`, the
	// predicate the API door itself calls, so an id-less remove is refused here by the
	// production function and not by a local guess.
	// ────────────────────────────────────────────────────────────────────────────────────
	class FakeSaveDoor {
		items: Array<{ id: number; locator: Locator }> = [];
		next_id = 100;
		/** Every `changed_data` batch this door received, in order. */
		batches: ChangedData[] = [];
		/** Model of a server-side pick refusal (non-selectable term, unreadable target…). */
		refuse_insert: (locator: Locator) => boolean = () => false;
		/** Model of relations/save.ts gate 4; null = uncapped. */
		selection_limit: number | null = null;
		/** Set when the REAL unnamedRemoveRefusal rejected a batch. */
		door_refusals: string[] = [];

		constructor(public tipo: string) {}

		seed(locator: Locator, id: number): Locator {
			this.items.push({ id, locator: { ...locator, id } });
			if (id >= this.next_id) this.next_id = id + 1;
			return { ...locator, id };
		}

		entries(): Locator[] {
			return this.items.map((item) => ({ ...item.locator, id: item.id }));
		}

		/** Applies one batch. Returns the data_manager envelope shape the client reads. */
		apply(changed_data: ChangedData): unknown {
			this.batches.push(changed_data);

			// THE REAL SERVER DOOR, called first, exactly as the API handler calls it.
			const refusal = unnamedRemoveRefusal(
				changed_data as unknown as Parameters<typeof unnamedRemoveRefusal>[0],
			);
			if (refusal !== null) {
				this.door_refusals.push(refusal);
				return { ok: false, data: null };
			}

			for (const change of changed_data) {
				if (change.action === 'remove') {
					const index = this.items.findIndex((item) => item.id === Number(change.id));
					// save_component.ts:1293 — PHP fails the save when the id does not exist.
					if (index === -1) return { ok: false, data: null };
					this.items.splice(index, 1);
					continue;
				}
				if (change.action === 'insert') {
					const locator = change.value as Locator;
					// relations/save.ts gate 4: the RESULTING count is what is judged.
					if (this.selection_limit !== null && this.items.length + 1 > this.selection_limit)
						continue;
					if (this.refuse_insert(locator)) continue;
					this.items.push({ id: this.next_id++, locator: { ...locator, id: this.next_id - 1 } });
				}
			}
			return {
				ok: true,
				data: { data: [{ tipo: this.tipo, pagination: { total: this.items.length } }] },
			};
		}
	}

	/**
	 * A portal instance carrying the REAL prototype. Only the two seams a unit gate cannot
	 * own are replaced: `change_value` (the network) and `refresh` (the render layer, here
	 * a re-read of the store so the compensating re-link sees post-save truth, which is
	 * what the production refresh gives it).
	 */
	function make_portal(options: {
		id: string;
		tipo: string;
		door: FakeSaveDoor;
		properties?: Record<string, unknown>;
	}): PortalInstance {
		const instance = Object.create(component_portal.prototype) as PortalInstance;
		instance.id = options.id;
		instance.tipo = options.tipo;
		instance.model = 'component_portal';
		instance.mode = 'edit';
		// a writable MOVE target (decide_drop: `self.permissions>=2`)
		(instance as unknown as { permissions: number }).permissions = 2;
		instance.context = { properties: options.properties ?? {} };
		instance.node = { classList: { add: () => undefined, remove: () => undefined } };
		instance.data = { entries: options.door.entries() };
		instance.total = options.door.items.length;
		instance.change_value = async ({ changed_data }) => options.door.apply(changed_data);
		instance.refresh = async () => {
			instance.data.entries = options.door.entries();
			instance.total = options.door.items.length;
			return true;
		};
		return instance;
	}

	/**
	 * The label table the page receives for `lang`: master.json under the lang's
	 * catalog overrides (src/core/labels/catalog.ts serving order, WC-033).
	 */
	function served_labels(lang: string): Record<string, string> {
		const labels_root = join(REPO_ROOT, 'src/core/labels');
		const master = JSON.parse(readFileSync(join(labels_root, 'master.json'), 'utf8'));
		const catalog_path = join(labels_root, 'catalog', `lg-${lang}.json`);
		const catalog = existsSync(catalog_path) ? JSON.parse(readFileSync(catalog_path, 'utf8')) : {};
		return { ...master, ...catalog };
	}

	/** Runs `fn` with the page's label table switched to `lang`, restored after. */
	async function with_labels<T>(lang: string, fn: () => Promise<T>): Promise<T> {
		const previous = globals.get_label;
		globals.get_label = served_labels(lang);
		try {
			return await fn();
		} finally {
			globals.get_label = previous;
		}
	}

	function drag_event(payload: unknown) {
		return {
			preventDefault: () => undefined,
			stopPropagation: () => undefined,
			dataTransfer: { getData: () => JSON.stringify(payload) },
		};
	}
	const drop_node = { classList: { remove: () => undefined, add: () => undefined } };

	const registered_keys: string[] = [];
	function register(key: string, instance: unknown): void {
		add_instance(key, instance);
		registered_keys.push(key);
	}
	afterEach(() => {
		while (registered_keys.length > 0) delete_instance(registered_keys.pop() as string);
		alerts = [];
	});

	// ────────────────────────────────────────────────────────────────────────────────────
	describe('P0-11 flow 1 — cross-portal move (drag_and_drop.on_drop)', () => {
		function build() {
			const source_door = new FakeSaveDoor('zzrelmv_source');
			const target_door = new FakeSaveDoor('zzrelmv_target');
			const stored = source_door.seed({ section_tipo: 'zzrelmv10', section_id: '5' }, 7);
			const source = make_portal({
				id: 'source_instance',
				tipo: 'zzrelmv_source',
				door: source_door,
			});
			const target = make_portal({
				id: 'target_instance',
				tipo: 'zzrelmv_target',
				door: target_door,
			});
			register('zz_client_relation_move_source', source);
			return { source_door, target_door, source, target, stored };
		}
		function drop_payload(locator: Locator) {
			return {
				kind: dnd.PORTAL_ROW_KIND,
				source_tipo: 'zzrelmv_source',
				source_id: 'source_instance',
				draggable_to: ['zzrelmv_target'],
				locator: locator,
				paginated_key: 0,
			};
		}

		test('ACCEPTANCE: the record lands in the target and the source is unlinked by ID', async () => {
			const { source_door, target_door, target, stored } = build();

			const result = await on_drop(drop_node, drag_event(drop_payload({ ...stored })), {
				caller: target,
			});

			expect(result).toBe(true);
			// the new value is stored in the target…
			expect(target_door.items).toHaveLength(1);
			expect(target_door.items[0]?.locator.section_id).toBe('5');
			expect(target_door.items[0]?.locator.from_component_tipo).toBe('zzrelmv_target');
			// …and the source no longer holds it, removed by a change that NAMES the id.
			expect(source_door.items).toHaveLength(0);
			expect(source_door.batches).toHaveLength(1);
			expect(source_door.batches[0]).toEqual([{ action: 'remove', id: 7, value: null }]);
			// the real server door accepted every batch — no id-less remove was ever sent.
			expect(source_door.door_refusals).toEqual([]);
			expect(alerts).toEqual([]);
		});

		test('REFUSAL: THE SOURCE RELATION STILL EXISTS and the operator is told', async () => {
			const { source_door, target_door, target, stored } = build();
			// the target's save refuses the insert (non-selectable target, cap, …)
			target_door.refuse_insert = () => true;

			const result = await on_drop(drop_node, drag_event(drop_payload({ ...stored })), {
				caller: target,
			});

			expect(result).toBe(false);
			// THE ASSERTION THIS WHOLE FILE EXISTS FOR.
			expect(source_door.items).toHaveLength(1);
			expect(source_door.items[0]?.id).toBe(7);
			expect(source_door.items[0]?.locator.section_id).toBe('5');
			// the destructive door was never even opened
			expect(source_door.batches).toHaveLength(0);
			// nothing was created in the target either
			expect(target_door.items).toHaveLength(0);
			// and the gesture is not left looking successful
			expect(alerts).toHaveLength(1);
		});

		test('a dragged locator with NO id never reaches the wire as an id-less remove', async () => {
			const { source_door, target_door, target, stored } = build();
			const id_less = { ...stored };
			id_less.id = null;

			const result = await on_drop(drop_node, drag_event(drop_payload(id_less)), {
				caller: target,
			});

			expect(result).toBe(false);
			// the link DID land — this is the belt-and-braces half: the target holds it…
			expect(target_door.items).toHaveLength(1);
			// …and the source was never asked to remove anything at all.
			expect(source_door.batches).toHaveLength(0);
			expect(source_door.items).toHaveLength(1);
			expect(source_door.door_refusals).toEqual([]);
		});

		/** A type-AWARE transfer: each drag type answers its own channel, '' when absent. */
		function typed_drag_event(channels: Record<string, string>) {
			return {
				preventDefault: () => undefined,
				stopPropagation: () => undefined,
				dataTransfer: {
					types: Object.keys(channels),
					getData: (type: string) => channels[type] ?? '',
				},
			};
		}
		function delegated_payload(locator: Locator) {
			return {
				...drop_payload(locator),
				kind: dnd.PORTAL_ROW_KIND,
				index: 0,
				window_generation: 1,
			};
		}

		test('ACCEPTANCE with the delegated portal payload (kind) on the portal MIME channel', async () => {
			const { source_door, target_door, target, stored } = build();
			// the MIME channel carries the payload; text/plain carries foreign text
			const result = await on_drop(
				drop_node,
				typed_drag_event({
					[dnd.PORTAL_ROW_MIME]: JSON.stringify(delegated_payload({ ...stored })),
					'text/plain': 'not json',
				}),
				{ caller: target },
			);

			expect(result).toBe(true);
			expect(target_door.items).toHaveLength(1);
			expect(source_door.batches[0]).toEqual([{ action: 'remove', id: 7, value: null }]);
		});

		test('the portal MIME channel WINS over a different text/plain payload', async () => {
			const { source_door, target_door, target, stored } = build();
			const decoy = delegated_payload({ ...stored, section_id: '99', id: 99 } as Locator);
			const result = await on_drop(
				drop_node,
				typed_drag_event({
					[dnd.PORTAL_ROW_MIME]: JSON.stringify(delegated_payload({ ...stored })),
					'text/plain': JSON.stringify(decoy),
				}),
				{ caller: target },
			);

			expect(result).toBe(true);
			expect(target_door.items).toHaveLength(1);
			expect(target_door.items[0]?.locator.section_id).toBe('5');
			expect(source_door.batches[0]).toEqual([{ action: 'remove', id: 7, value: null }]);
		});

		test('MIME channel absent: the text/plain twin is the fallback', async () => {
			const { source_door, target_door, target, stored } = build();
			const result = await on_drop(
				drop_node,
				typed_drag_event({ 'text/plain': JSON.stringify(delegated_payload({ ...stored })) }),
				{ caller: target },
			);

			expect(result).toBe(true);
			expect(target_door.items).toHaveLength(1);
			expect(target_door.items[0]?.locator.section_id).toBe('5');
			expect(source_door.batches[0]).toEqual([{ action: 'remove', id: 7, value: null }]);
		});
	});

	// ────────────────────────────────────────────────────────────────────────────────────
	describe('P0-11 flow 2 — data_limit:1 picker replace (component_portal.link_records)', () => {
		function build() {
			const door = new FakeSaveDoor('zzrelmv_portal');
			door.selection_limit = 1;
			const stored = door.seed({ section_tipo: 'zzrelmv10', section_id: '5' }, 11);
			const portal = make_portal({
				id: 'portal_instance',
				tipo: 'zzrelmv_portal',
				door,
				properties: { data_limit: 1 },
			});
			let refreshes = 0;
			const real_refresh = portal.refresh;
			portal.refresh = async (opts?: unknown) => {
				refreshes++;
				return real_refresh(opts);
			};
			const picked: Locator = { section_tipo: 'zzrelmv10', section_id: '9' };
			return { door, portal, stored, picked, refreshed: () => refreshes };
		}

		test('ACCEPTANCE: one save, removes THEN inserts, new value stored, nothing refused', async () => {
			const { door, portal, stored, picked, refreshed } = build();

			const outcome = await portal.link_records([picked], {
				enforce_client_data_limit: false,
				replace_entries: [stored],
			});

			expect(outcome.refused).toEqual([]);
			expect(outcome.linked).toHaveLength(1);
			// ONE save carried the whole replace, removes first.
			expect(door.batches).toHaveLength(1);
			expect((door.batches[0] as ChangedData).map((c) => c.action)).toEqual(['remove', 'insert']);
			expect((door.batches[0] as ChangedData)[0]?.id).toBe(11);
			// the new value is what the component now holds
			expect(door.items).toHaveLength(1);
			expect(door.items[0]?.locator.section_id).toBe('9');
			// and the view was refreshed — the mis-report regression returned before this.
			expect(refreshed()).toBeGreaterThan(0);
		});

		test('the removes-first ORDER is load-bearing: inserts-first destroys the value', async () => {
			// Not a test of the client — a test of the reason the client emits that order.
			// The same batch, reordered, against the same resulting-count selection cap.
			const door = new FakeSaveDoor('zzrelmv_portal');
			door.selection_limit = 1;
			door.seed({ section_tipo: 'zzrelmv10', section_id: '5' }, 11);

			door.apply([
				{ action: 'insert', id: null, value: { section_tipo: 'zzrelmv10', section_id: '9' } },
				{ action: 'remove', id: 11, value: null },
			]);

			// the insert was refused as over-cap (resulting count 2 > 1), the remove stood.
			expect(door.items).toHaveLength(0);
		});

		test('REFUSAL: reported as replace_failed, and THE PREVIOUS VALUE IS BACK', async () => {
			const { door, portal, stored, picked } = build();
			// the server refuses the picked term only
			door.refuse_insert = (locator) => locator.section_id === '9';

			const outcome = await portal.link_records([picked], {
				enforce_client_data_limit: false,
				replace_entries: [stored],
			});

			expect(outcome.linked).toEqual([]);
			expect(outcome.refused).toHaveLength(1);
			// never 'duplicate': what happened is a deletion, and it must be named as one.
			expect(outcome.refused[0]?.reason.startsWith('replace_failed')).toBe(true);
			expect(outcome.refused[0]?.reason).toContain('the previous value was restored');
			// THE CURATED RELATION IS STILL THERE (re-linked; a NEW item id, by design —
			// the client strips `id` so the server mints one it owns).
			expect(door.items).toHaveLength(1);
			expect(door.items[0]?.locator.section_id).toBe('5');
		});

		test('REFUSAL whose compensation also fails is reported as unrestorable, not silent', async () => {
			const { door, portal, stored, picked } = build();
			// nothing can be inserted any more — the old target became unreadable too.
			door.refuse_insert = () => true;

			const outcome = await portal.link_records([picked], {
				enforce_client_data_limit: false,
				replace_entries: [stored],
			});

			expect(outcome.linked).toEqual([]);
			expect(outcome.refused[0]?.reason).toContain('COULD NOT BE RESTORED');
			expect(door.items).toHaveLength(0);
		});

		test('a replace_entry without a usable id is refused BEFORE anything is written', async () => {
			for (const bad_id of [null, undefined, 0, '', 'x']) {
				const { door, portal, stored, picked } = build();
				const bad_entry = { ...stored, id: bad_id as number | string | null };

				const outcome = await portal.link_records([picked], {
					enforce_client_data_limit: false,
					replace_entries: [bad_entry],
				});

				expect(outcome.linked).toEqual([]);
				expect(outcome.refused.map((r) => r.reason)).toEqual(['replace_entry_without_id']);
				// ZERO saves: the guard fires before the wire, not after.
				expect(door.batches).toHaveLength(0);
				expect(door.items).toHaveLength(1);
			}
		});
	});

	// ────────────────────────────────────────────────────────────────────────────────────
	// TEXT AREA TAGS. A tags portal (tags_reference / tags_draw) stores one locator per
	// text tag, and one record may be linked by several tags. The server dedup key
	// includes tag_id (relations/save.ts normalizeRelationInsert); the client level-1
	// check compared section_tipo + section_id only, so the second tag got 'duplicate'
	// and render_reference stamped a reference over a link the database never held.
	describe('tag_id is part of the value identity (text area tags portal)', () => {
		function build() {
			const door = new FakeSaveDoor('zzrelmv_tags');
			door.seed(
				{ section_tipo: 'zzrelmv10', section_id: '1', tag_id: '3', tag_type: 'reference' },
				21,
			);
			door.seed({ section_tipo: 'zzrelmv10', section_id: '2' }, 22);
			const portal = make_portal({ id: 'tags_instance', tipo: 'zzrelmv_tags', door });
			return { door, portal };
		}

		test('the same record linked by ANOTHER tag is a new value, not a duplicate', async () => {
			const { door, portal } = build();

			const outcome = await portal.link_records([
				{ section_tipo: 'zzrelmv10', section_id: '1', tag_id: '4', tag_type: 'reference' },
			]);

			expect(outcome.refused).toEqual([]);
			expect(outcome.linked).toHaveLength(1);
			expect(door.items.map((item) => item.locator.tag_id)).toEqual(['3', undefined, '4']);
		});

		test('the same record by the SAME tag is still a duplicate, refused before the wire', async () => {
			const { door, portal } = build();

			const outcome = await portal.link_records([
				{ section_tipo: 'zzrelmv10', section_id: '1', tag_id: '3', tag_type: 'reference' },
			]);

			expect(outcome.linked).toEqual([]);
			expect(outcome.refused.map((r) => r.reason)).toEqual(['duplicate']);
			expect(door.batches).toHaveLength(0);
		});

		test('a plain locator (no tag_id) keeps the section_tipo + section_id identity', async () => {
			const { door, portal } = build();

			const outcome = await portal.link_records([{ section_tipo: 'zzrelmv10', section_id: '2' }]);

			expect(outcome.refused.map((r) => r.reason)).toEqual(['duplicate']);
			expect(door.batches).toHaveLength(0);
		});
	});

	// ────────────────────────────────────────────────────────────────────────────────────
	// THE DELEGATED DRAG CORE (WC-2026-10-30-section-record-row-box, stage-3 addendum).
	//
	// The bugs these legs pin, each RED on the pre-stage-3 drag_and_drop.js:
	//   - REORDER target_key = paginated_key + paginator.offset: paginated_key is
	//     already ABSOLUTE (relation_core.ts stamps index + offset), so page 2+ counted
	//     the offset twice and wrote to the wrong position (or out of range);
	//   - REORDER was decided by `tipo`, so a second INSTANCE of the same portal tipo
	//     (another record's portal, a tool's copy) was treated as "this list";
	//   - every drop called preventDefault/stopPropagation and JSON.parse'd blindly:
	//     a foreign drop (file, thesaurus node, text) threw and never reached its
	//     owner (ts_object term, outer portal);
	//   - there was no window generation, so a drag that outlived its page wrote
	//     keys addressed to rows that had been replaced.
	// ────────────────────────────────────────────────────────────────────────────────────

	const PAGE2_ENTRIES: Locator[] = [
		{ id: 10, section_tipo: 'zzrelmv10', section_id: '110', paginated_key: 9 },
		{ id: 11, section_tipo: 'zzrelmv10', section_id: '111', paginated_key: 10 },
		{ id: 12, section_tipo: 'zzrelmv10', section_id: '112', paginated_key: 11 },
	];

	type FakeWindow = {
		size: number;
		generation: number;
		signal: AbortSignal;
		controller: AbortController;
		entry_of: (i: number) => Locator | undefined;
		is_built: (i: number) => boolean;
		hold: (i: number, reason: string) => void;
		unhold: (i: number, reason: string) => void;
		holds: string[];
	};
	function fake_window(entries: Locator[], generation: number): FakeWindow {
		const controller = new AbortController();
		const holds: string[] = [];
		const rows = Object.freeze(entries.map((e) => Object.freeze({ ...e })));
		return {
			size: rows.length,
			generation,
			signal: controller.signal,
			controller,
			entry_of: (i) => rows[i] as Locator | undefined,
			is_built: (i) => i >= 0 && i < rows.length,
			hold: (i, reason) => holds.push(`hold:${i}:${reason}`),
			unhold: (i, reason) => holds.push(`unhold:${i}:${reason}`),
			holds,
		};
	}

	/** An edit portal on PAGE 2 (offset 9) with a live row window. */
	function page2_portal(overrides: Record<string, unknown> = {}) {
		const sort_calls: Array<Record<string, unknown>> = [];
		const record_window = fake_window(PAGE2_ENTRIES, 5);
		const self: Record<string, unknown> = {
			id: 'portal_p2',
			tipo: 'zzrelmv_portal',
			model: 'component_portal',
			mode: 'edit',
			permissions: 2,
			total: 12,
			paginator: { offset: 9 },
			properties: { draggable_to: ['zzrelmv_other'] },
			context: { properties: {} },
			data: { entries: PAGE2_ENTRIES.map((e) => ({ ...e })) },
			node: { classList: { add: () => undefined, remove: () => undefined } },
			record_windows: { rows: record_window },
			sort_data: async (options: Record<string, unknown>) => {
				sort_calls.push(options);
				return { ok: true, data: {} };
			},
			...overrides,
		};
		return { self, sort_calls, record_window };
	}

	function row_payload(self: Record<string, unknown>, index: number, generation: number) {
		const entry = PAGE2_ENTRIES[index] as Locator;
		return {
			kind: dnd.PORTAL_ROW_KIND,
			locator: { ...entry },
			paginated_key: entry.paginated_key,
			index,
			source_id: self.id,
			source_tipo: self.tipo,
			draggable_to: ['zzrelmv_other'],
			window_generation: generation,
		};
	}

	/** A DragEvent-shaped spy: records preventDefault/stopPropagation. */
	function spy_event(payload_text: string, types: string[] = []) {
		const seen = { prevented: false, stopped: false };
		return {
			seen,
			event: {
				preventDefault: () => {
					seen.prevented = true;
				},
				stopPropagation: () => {
					seen.stopped = true;
				},
				dataTransfer: { types, getData: () => payload_text },
			},
		};
	}

	/**
	 * Collects the notices handle_api_error publishes (toast action →
	 * render_error_toast → event_manager 'notification'). `stop()` unsubscribes.
	 */
	function collect_notices() {
		const notices: Array<{ code: unknown; msg: unknown }> = [];
		const token = event_manager.subscribe('notification', (data) => {
			const api_error = data.api_error as { code?: unknown } | null;
			notices.push({ code: api_error?.code ?? null, msg: data.msg });
		});
		return { notices, stop: () => event_manager.unsubscribe(token) };
	}

	/** Lets the un-awaited async chains a listener started (perform_drop, link_records…) finish. */
	async function settle(rounds = 5): Promise<void> {
		for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
	}

	describe('decide_drop — the ONE pure decision', () => {
		test('page-2 REORDER keys are ABSOLUTE (paginated_key, the offset is never added)', () => {
			const { self } = page2_portal();
			// drag row 1 (key 10) onto row 0 (key 9) on page 2 (offset 9)
			const decision = dnd.decide_drop(self, row_payload(self, 1, 5), 0);
			expect(decision).toEqual({
				kind: 'reorder',
				value: { ...(PAGE2_ENTRIES[1] as Locator) },
				source_key: 10,
				target_key: 9, // NOT 9 + offset 9 = 18
			});
		});

		test('source_id, never tipo, decides REORDER', () => {
			const { self } = page2_portal();
			// same tipo, ANOTHER instance, no draggable_to naming it → not ours
			const twin = { ...row_payload(self, 1, 5), source_id: 'another_instance', draggable_to: [] };
			expect(dnd.decide_drop(self, twin, 0)).toBeNull();
			// the same twin naming this tipo in draggable_to is a MOVE, never a REORDER
			const moving = { ...twin, draggable_to: ['zzrelmv_portal'] };
			expect(dnd.decide_drop(self, moving, 0)?.kind).toBe('move');
		});

		test('same position / missing target row / unwritable → null', () => {
			const { self } = page2_portal();
			expect(dnd.decide_drop(self, row_payload(self, 1, 5), 1)).toBeNull();
			expect(dnd.decide_drop(self, row_payload(self, 1, 5), 3)).toBeNull();
			expect(dnd.decide_drop(self, row_payload(self, 1, 5), undefined)).toBeNull();
			const { self: readonly } = page2_portal({ permissions: 1 });
			expect(dnd.decide_drop(readonly, row_payload(readonly, 1, 5), 0)).toBeNull();
			const { self: children } = page2_portal({ reorderable: false });
			expect(dnd.decide_drop(children, row_payload(children, 1, 5), 0)).toBeNull();
		});

		test('declared order (server context.declared_order) and view_order → null', () => {
			const { self: declared } = page2_portal({
				context: { properties: {}, declared_order: [{ tipo: 'zzrelmv_date', direction: 'ASC' }] },
			});
			expect(dnd.decide_drop(declared, row_payload(declared, 1, 5), 0)).toBeNull();
			const { self: viewing } = page2_portal({
				view_order: { tipo: 'zzrelmv_date', direction: 'DESC' },
			});
			expect(dnd.decide_drop(viewing, row_payload(viewing, 1, 5), 0)).toBeNull();
		});

		test('a foreign payload → null (and the tool-mosaic payload is foreign)', () => {
			const { self } = page2_portal();
			for (const foreign of [
				null,
				'text',
				42,
				[],
				{},
				{ id: 'ts_object_node', parent: 'x' },
				{ kind: 'something_else', locator: { section_tipo: 'a', section_id: '1' } },
				{ ...row_payload(self, 1, 5), kind: undefined },
				{ ...row_payload(self, 1, 5), locator: null },
				{ ...row_payload(self, 1, 5), draggable_to: 'zzrelmv_portal' },
				{ ...row_payload(self, 1, 5), paginated_key: '10' },
			]) {
				expect(dnd.decide_drop(self, foreign, 0)).toBeNull();
			}
			const tool_payload = dnd.get_row_transfer_data({ caller: self, index: 1 });
			expect(tool_payload).not.toBeNull();
			expect('kind' in (tool_payload as object)).toBe(false);
			expect(dnd.is_portal_payload(tool_payload)).toBe(false);
			expect(dnd.decide_drop(self, tool_payload, 0)).toBeNull();
		});

		test('a generation mismatch → {kind:"stale"}, incl. a payload of a SUPERSEDED window', () => {
			const { self, record_window } = page2_portal();
			// the live window is generation 5
			expect(dnd.decide_drop(self, row_payload(self, 1, 4), 0)).toEqual({ kind: 'stale' });
			expect(
				dnd.decide_drop(self, { ...row_payload(self, 1, 5), window_generation: undefined }, 0),
			).toEqual({
				kind: 'stale',
			});
			// the owner-monotonic counter moved on twice (page turn, refresh destroy:true):
			// the payload addressed generation 5's rows → stale, never sent
			record_window.generation = 7;
			expect(dnd.decide_drop(self, row_payload(self, 1, 5), 0)).toEqual({ kind: 'stale' });
			// a payload from the live generation is a reorder (control)
			expect(dnd.decide_drop(self, row_payload(self, 1, 7), 0)?.kind).toBe('reorder');
		});

		test('MOVE needs a writable target named in draggable_to; no target row needed', () => {
			const { self } = page2_portal();
			const foreign_source = {
				...row_payload(self, 1, 99),
				source_id: 'other_portal_instance',
				source_tipo: 'zzrelmv_other',
				draggable_to: ['zzrelmv_portal'],
			};
			expect(dnd.decide_drop(self, foreign_source, undefined)).toEqual({
				kind: 'move',
				locator: foreign_source.locator,
			});
			// a declared-order portal is still a MOVE target (link appends, the chokepoint sorts)
			const { self: declared } = page2_portal({
				context: { properties: {}, declared_order: [{ tipo: 'x', direction: 'ASC' }] },
			});
			expect(dnd.decide_drop(declared, foreign_source, undefined)?.kind).toBe('move');
			const { self: readonly } = page2_portal({ permissions: 1 });
			expect(dnd.decide_drop(readonly, foreign_source, undefined)).toBeNull();
			expect(dnd.decide_drop(self, { ...foreign_source, draggable_to: [] }, undefined)).toBeNull();
		});
	});

	describe('the gates (one function each)', () => {
		test('can_reorder / can_drag_out carry !declared_order && !view_order', () => {
			const { self } = page2_portal();
			expect(dnd.can_reorder(self)).toBe(true);
			expect(dnd.can_drag_out(self)).toBe(true);
			for (const off of [
				{ mode: 'list' },
				{ permissions: 1 },
				{ reorderable: false },
				{ view_order: { tipo: 'x', direction: 'ASC' } },
				{ context: { properties: {}, declared_order: [{ tipo: 'x', direction: 'ASC' }] } },
			]) {
				const { self: gated } = page2_portal(off);
				expect(dnd.can_reorder(gated)).toBe(false);
				expect(dnd.can_drag_out(gated)).toBe(false);
			}
			expect(dnd.can_reorder(page2_portal({ paginator: null }).self)).toBe(false);
			expect(dnd.can_drag_out(page2_portal({ properties: {} }).self)).toBe(false);
		});

		test('can_view_sort / can_save_view_order / can_tool_source', () => {
			const { self } = page2_portal();
			expect(dnd.can_view_sort(self, { sort_by_column: true })).toBe(true);
			expect(dnd.can_view_sort(self, { sort_by_column: 'yes' })).toBe(false);
			expect(dnd.can_save_view_order(self)).toBe(false);
			expect(dnd.can_save_view_order(page2_portal({ view_order: { tipo: 'x' } }).self)).toBe(true);
			expect(
				dnd.can_save_view_order(
					page2_portal({
						view_order: { tipo: 'x' },
						context: { properties: {}, declared_order: [{ tipo: 'x', direction: 'ASC' }] },
					}).self,
				),
			).toBe(false);
			expect([...dnd.TOOL_ROW_SOURCES.keys()].sort()).toEqual([
				'coins_mosaic',
				'tool_cataloging_mosaic',
			]);
			for (const reason of dnd.TOOL_ROW_SOURCES.values()) expect(reason.length).toBeGreaterThan(20);
			expect(dnd.can_tool_source({ view: 'tool_cataloging_mosaic' })).toBe(true);
			expect(dnd.can_tool_source({ view: 'mosaic' })).toBe(false);
		});

		test('move-to-position: clamped to [0, total-1], absolute keys', () => {
			const { self } = page2_portal();
			const entry = PAGE2_ENTRIES[1] as Locator; // key 10
			expect(dnd.move_to_position_decision(self, entry, 1)).toEqual({
				value: entry,
				source_key: 10,
				target_key: 0,
			});
			expect(dnd.move_to_position_decision(self, entry, 999)?.target_key).toBe(11);
			expect(dnd.move_to_position_decision(self, entry, -4)?.target_key).toBe(0);
			expect(dnd.move_to_position_decision(self, entry, 11)).toBeNull(); // = its own position
			expect(dnd.move_to_position_decision(self, entry, 'x')).toBeNull();
		});
	});

	describe('on_drop — the adapter', () => {
		test('REORDER with index on a page-2 portal sends ABSOLUTE keys (not +offset)', async () => {
			const { self, sort_calls } = page2_portal();
			const result = await on_drop(drop_node, drag_event(row_payload(self, 2, 5)), {
				caller: self as unknown as PortalInstance,
				index: 0,
			} as never);
			expect(result).toBe(true);
			expect(sort_calls).toEqual([
				{ value: { ...(PAGE2_ENTRIES[2] as Locator) }, source_key: 11, target_key: 9 },
			]);
		});

		test('a kind-less pre-window payload is FOREIGN (no upgrade): false, left wholly alone', async () => {
			// the stage-5 removal: the per-node listeners emitted {locator, paginated_key,
			// source_tipo, source_id, draggable_to} without `kind`, upgraded here until no
			// view emitted it. It is now a payload this module does not own.
			const { self, sort_calls } = page2_portal();
			const legacy = {
				locator: { ...(PAGE2_ENTRIES[1] as Locator) },
				paginated_key: 10,
				source_tipo: self.tipo,
				source_id: self.id,
				draggable_to: [],
			};
			const { seen, event } = spy_event(JSON.stringify(legacy));
			const result = await on_drop(drop_node, event, {
				caller: self as unknown as PortalInstance,
				index: 0,
			} as never);
			expect(result).toBe(false);
			expect(seen).toEqual({ prevented: false, stopped: false });
			expect(sort_calls).toEqual([]);
		});

		test('options.paginated_key no longer names a target (only options.index does)', async () => {
			const { self, sort_calls } = page2_portal();
			const { seen, event } = spy_event(JSON.stringify(row_payload(self, 2, 5)));
			const result = await on_drop(drop_node, event, {
				caller: self as unknown as PortalInstance,
				paginated_key: 9,
			} as never);
			expect(result).toBe(false);
			// own payload, no target row: the default text drop is blocked, NOT stopped
			expect(seen).toEqual({ prevented: true, stopped: false });
			expect(sort_calls).toEqual([]);
		});

		/**
		 * Drops `row_payload(self, 2, 5)` on page row 0 of a portal whose sort_data is
		 * `sort_data`, under the `lang` label table; returns the notices published.
		 */
		async function reorder_notices(
			lang: string,
			sort_data: (options: Record<string, unknown>) => Promise<unknown>,
		) {
			const { self } = page2_portal({ sort_data });
			const { notices, stop } = collect_notices();
			const errors: unknown[] = [];
			const original = console.error;
			console.error = (...args: unknown[]) => errors.push(args);
			let result: boolean | undefined;
			try {
				result = await with_labels(lang, async () => {
					const answer = await on_drop(drop_node, drag_event(row_payload(self, 2, 5)), {
						caller: self as unknown as PortalInstance,
						index: 0,
					} as never);
					await settle();
					return answer;
				});
			} finally {
				console.error = original;
				stop();
			}
			return { result, notices, errors };
		}

		test('a reorder whose sort_data THROWS after the save is UNCONFIRMED, never "not saved" — in the label the page renders', async () => {
			// sort_data = change_value (the save, committed) THEN an uncaught refresh: a
			// rebuild failing after a committed save throws out of sort_data. "Not saved"
			// would be false and invite a repeat of a move the database already holds.
			// The label table is LOADED: a `client.*` code would derive a transport label
			// ("unreadable response") that error_text renders over the message.
			for (const lang of ['eng', 'spa']) {
				const saved: Array<Record<string, unknown>> = [];
				const { result, notices, errors } = await reorder_notices(lang, async (options) => {
					saved.push(options); // the save committed…
					throw new Error('build() failed mid-rebuild'); // …the refresh did not
				});
				const labels = served_labels(lang);
				expect(result).toBe(false);
				expect(saved).toHaveLength(1);
				expect(notices).toHaveLength(1);
				expect(notices[0]?.code).toBe('idempotency.outcome_unknown');
				expect(notices[0]?.msg).toBe(labels.drag_order_unconfirmed);
				expect(String(notices[0]?.msg)).not.toBe(labels.error_client_bad_response);
				expect(errors).toHaveLength(1);
			}
			// the English sentence says what is true in both outcomes, and asks for a reload
			const eng = served_labels('eng').drag_order_unconfirmed as string;
			expect(eng).toMatch(/could not be confirmed/i);
			expect(eng).toMatch(/reload/i);
			expect(eng).not.toMatch(/not saved/i);
			// a TRANSLATED label, not the English one copied (labels_tripwire owns coverage)
			expect(served_labels('spa').drag_order_unconfirmed).not.toBe(eng);
		});

		test('a reorder the save path answers WITHOUT an envelope error is said "not saved" — in the label the page renders', async () => {
			for (const lang of ['eng', 'spa']) {
				// the save guard's `false` (nothing reached the server; nothing shown yet)
				const { result, notices } = await reorder_notices(lang, async () => false);
				expect(result).toBe(false);
				expect(notices).toHaveLength(1);
				expect(notices[0]?.code).toBe('record.save_failed');
				expect(notices[0]?.msg).toBe(served_labels(lang).drag_order_not_saved);
			}
			// an envelope failure was already shown by the save path: never twice. The
			// empty notice list is only meaningful when the save door WAS reached (once)
			// and the refusal was taken as a refusal — not a success, not a no-op.
			const envelope_calls: Array<Record<string, unknown>> = [];
			const { result, notices } = await reorder_notices('eng', async (options) => {
				envelope_calls.push(options);
				return {
					ok: false,
					error: { is_api_error: true, code: 'perm.denied', message: 'denied' },
				};
			});
			expect(envelope_calls).toHaveLength(1);
			expect(result).toBe(false);
			expect(notices).toEqual([]);
		});

		test('a foreign payload returns false WITHOUT throwing and is NOT consumed', async () => {
			const { self, sort_calls } = page2_portal();
			for (const text of ['', 'not json', '{"id":"ts_object_node"}', 'null', '[1,2]']) {
				const { seen, event } = spy_event(text);
				const result = await on_drop(drop_node, event, {
					caller: self as unknown as PortalInstance,
					index: 0,
				} as never);
				expect(result).toBe(false);
				expect(seen).toEqual({ prevented: false, stopped: false });
			}
			expect(sort_calls).toEqual([]);
		});

		test('the same tipo from ANOTHER instance is not a REORDER', async () => {
			const { self, sort_calls } = page2_portal();
			const { seen, event } = spy_event(
				JSON.stringify({
					...row_payload(self, 1, 5),
					source_id: 'another_instance',
					draggable_to: [],
				}),
			);
			const result = await on_drop(drop_node, event, {
				caller: self as unknown as PortalInstance,
				index: 0,
			} as never);
			expect(result).toBe(false);
			expect(sort_calls).toEqual([]);
			// own payload, refused: default text drop blocked, NOT stopped
			expect(seen).toEqual({ prevented: true, stopped: false });
		});

		test('an OWN payload refused over an editable control: default text drop blocked, nothing sent', async () => {
			// engineering/wire_contract/WC-2026-10-30-section-record-row-box.md (stage-3
			// addendum, FOREIGN GUARD split): a same-row drop, a declared-order portal and
			// a view_order portal all decide null for the portal's OWN payload. Unless the
			// drop is preventDefault'ed the browser inserts the payload JSON into the
			// <input> under the pointer, and the component saves it.
			const cases: Array<{
				name: string;
				arrange: (self: Record<string, unknown>) => void;
				index: number;
			}> = [
				{ name: 'same row', arrange: () => undefined, index: 2 },
				{
					name: 'declared order',
					arrange: (self) => {
						(self.context as Record<string, unknown>).declared_order = [
							{ tipo: 'zzrelmv_date', direction: 'ASC' },
						];
					},
					index: 0,
				},
				{
					name: 'view_order',
					arrange: (self) => {
						self.view_order = { tipo: 'zzrelmv_date', direction: 'ASC' };
					},
					index: 0,
				},
			];
			for (const { name, arrange, index } of cases) {
				const { self, sort_calls } = page2_portal();
				const payload = JSON.stringify(row_payload(self, 2, 5));
				arrange(self as unknown as Record<string, unknown>);
				// on_drop (legacy per-node listener), MIME present and MIME absent
				for (const types of [[dnd.PORTAL_ROW_MIME, 'text/plain'], ['text/plain']]) {
					const { seen, event } = spy_event(payload, types);
					const result = await on_drop(drop_node, event, {
						caller: self as unknown as PortalInstance,
						index,
					} as never);
					expect([name, result]).toEqual([name, false]);
					expect([name, seen]).toEqual([name, { prevented: true, stopped: false }]);
				}
				// the delegated row listener: the drop lands on the row's <input>
				const { content_data, inputs, ancestor_seen } = fake_list(
					self as unknown as Record<string, unknown>,
				);
				dnd.bind_row_drag(self, content_data, { source: 'handle' });
				const dt = new FakeDataTransfer([dnd.PORTAL_ROW_MIME, 'text/plain'], {
					[dnd.PORTAL_ROW_MIME]: payload,
					'text/plain': payload,
				});
				const drop = dispatch(new FakeEvent('drop', inputs[index] as FakeEl, dt));
				expect([name, drop.prevented, drop.stopped]).toEqual([name, true, false]);
				expect([name, ancestor_seen]).toEqual([name, ['drop']]);
				await settle();
				expect([name, sort_calls]).toEqual([name, []]);
			}
		});
	});

	// ── a minimal counting DOM: enough for row_of, delegated listeners and bubbling ──────
	class FakeClassList {
		private set = new Set<string>();
		add(...names: string[]) {
			for (const n of names) this.set.add(n);
		}
		remove(...names: string[]) {
			for (const n of names) this.set.delete(n);
		}
		contains(name: string) {
			return this.set.has(name);
		}
	}
	type Listener = (event: FakeEvent) => void;
	class FakeEl {
		nodeType = 1;
		classList = new FakeClassList();
		dataset: Record<string, string> = {};
		attributes: Record<string, string> = {};
		children: FakeEl[] = [];
		parentElement: FakeEl | null = null;
		listeners = new Map<string, Listener[]>();
		textContent = '';
		className = '';
		constructor(
			public tag = 'div',
			classes: string[] = [],
		) {
			for (const c of classes) this.classList.add(c);
		}
		appendChild(child: FakeEl) {
			child.parentElement = this;
			this.children.push(child);
			return child;
		}
		remove() {
			if (this.parentElement) {
				this.parentElement.children = this.parentElement.children.filter((c) => c !== this);
				this.parentElement = null;
			}
		}
		setAttribute(name: string, value: string) {
			this.attributes[name] = value;
		}
		contains(other: FakeEl | null): boolean {
			for (let n = other; n; n = n.parentElement) if (n === this) return true;
			return false;
		}
		private matches(selector: string): boolean {
			return selector
				.split(',')
				.map((s) => s.trim())
				.some((s) => {
					if (s.startsWith('.')) return this.classList.contains(s.slice(1));
					if (s.startsWith('[')) {
						const m = /^\[([\w-]+)="([^"]*)"\]$/.exec(s);
						return m !== null && this.attributes[m[1] as string] === m[2];
					}
					return this.tag === s;
				});
		}
		closest(selector: string): FakeEl | null {
			for (let n: FakeEl | null = this; n; n = n.parentElement) if (n.matches(selector)) return n;
			return null;
		}
		/** Only the `:scope > .a, :scope > .b` form the module uses. */
		querySelectorAll(selector: string): FakeEl[] {
			const classes = selector.split(',').map((s) => s.replace(':scope >', '').trim().slice(1));
			return this.children.filter((c) => classes.some((cls) => c.classList.contains(cls)));
		}
		/** A capture listener is kept under `<type>:capture` (dispatch runs those root → target first). */
		addEventListener(
			type: string,
			fn: Listener,
			options?: { signal?: AbortSignal; capture?: boolean },
		) {
			if (options?.signal?.aborted) return;
			const key = options?.capture === true ? `${type}:capture` : type;
			const list = this.listeners.get(key) ?? [];
			list.push(fn);
			this.listeners.set(key, list);
			options?.signal?.addEventListener('abort', () => {
				this.listeners.set(
					key,
					(this.listeners.get(key) ?? []).filter((l) => l !== fn),
				);
			});
		}
		listener_count(): number {
			let n = 0;
			for (const list of this.listeners.values()) n += list.length;
			return n;
		}
		/** Live listeners per event type (types with none omitted). */
		listener_types(): Record<string, number> {
			const out: Record<string, number> = {};
			for (const [type, list] of this.listeners) if (list.length > 0) out[type] = list.length;
			return out;
		}
	}
	class FakeEvent {
		prevented = false;
		stopped = false;
		relatedTarget: FakeEl | null = null;
		key?: string;
		constructor(
			public type: string,
			public target: FakeEl,
			public dataTransfer: FakeDataTransfer | null = null,
		) {}
		preventDefault() {
			this.prevented = true;
		}
		stopPropagation() {
			this.stopped = true;
		}
	}
	class FakeDataTransfer {
		data = new Map<string, string>();
		effectAllowed = '';
		dropEffect = '';
		constructor(types: string[] = [], seed: Record<string, string> = {}) {
			for (const t of types) this.data.set(t, seed[t] ?? '');
		}
		get types() {
			return [...this.data.keys()];
		}
		setData(type: string, value: string) {
			this.data.set(type, value);
		}
		getData(type: string) {
			return this.data.get(type) ?? '';
		}
	}
	/** Captures root → target, then bubbles target → root, as the browser does. */
	function dispatch(event: FakeEvent): FakeEvent {
		const path: FakeEl[] = [];
		for (let n: FakeEl | null = event.target; n; n = n.parentElement) path.push(n);
		for (const n of path.reverse()) {
			if (event.stopped) return event;
			for (const fn of [...(n.listeners.get(`${event.type}:capture`) ?? [])]) fn(event);
		}
		for (let n: FakeEl | null = event.target; n && !event.stopped; n = n.parentElement) {
			for (const fn of [...(n.listeners.get(event.type) ?? [])]) fn(event);
		}
		return event;
	}

	/** wrapper > content_data > 3 rows, each `.section_record[data-index] > .column_id > .drag`. */
	function fake_list(self: Record<string, unknown>) {
		const ancestor = new FakeEl('div', ['ts_object_term']);
		const wrapper = ancestor.appendChild(new FakeEl('div', ['wrapper_component']));
		const content_data = wrapper.appendChild(new FakeEl('div', ['content_data']));
		const rows: FakeEl[] = [];
		const handles: FakeEl[] = [];
		const inputs: FakeEl[] = [];
		for (let i = 0; i < 3; i++) {
			const row = content_data.appendChild(new FakeEl('div', ['section_record']));
			row.dataset.index = String(i);
			const column = row.appendChild(new FakeEl('div', ['column', 'column_section_id']));
			handles.push(column.appendChild(new FakeEl('span', ['drag', 'icon'])));
			inputs.push(row.appendChild(new FakeEl('input')));
			rows.push(row);
		}
		const ancestor_seen: string[] = [];
		for (const type of ['dragover', 'drop', 'click']) {
			ancestor.addEventListener(type, (e) => ancestor_seen.push(e.type));
		}
		self.node = wrapper;
		return { ancestor, wrapper, content_data, rows, handles, inputs, ancestor_seen };
	}

	/** The ONE listener set bind_row_drag registers: exactly one per type. */
	const ROW_DRAG_TYPES = {
		dragstart: 1,
		dragover: 1,
		dragleave: 1,
		drop: 1,
		dragend: 1,
		dblclick: 1,
		keydown: 1,
		click: 1, // touch PICK (bubble: after the row's own controls)
		'click:capture': 1, // touch PLACE (capture: a cell that swallows its click cannot hide the row)
	};

	/**
	 * Nests a second list inside outer row 0, as a row rendering an edit-mode portal
	 * does: row > content_data > section_record[0] > column > .drag. The inner list
	 * is left UNBOUND (a legacy view, or one whose source is switched off): its
	 * gestures bubble to the outer content_data unstopped.
	 */
	function nest_list(outer_row: FakeEl) {
		const inner_content = outer_row.appendChild(new FakeEl('div', ['content_data']));
		const inner_row = inner_content.appendChild(new FakeEl('div', ['section_record']));
		inner_row.dataset.index = '0';
		const column = inner_row.appendChild(new FakeEl('div', ['column', 'column_section_id']));
		const inner_handle = column.appendChild(new FakeEl('span', ['drag', 'icon']));
		return { inner_content, inner_row, inner_handle };
	}

	describe('bind_row_drag — delegated, one listener set, on the window signal', () => {
		afterEach(() => {
			dnd.release_drag_source();
		});

		test('dragstart from the handle writes the portal payload (MIME + text/plain) and holds the row', () => {
			const { self, record_window } = page2_portal();
			const { content_data, rows, handles } = fake_list(self);
			expect(dnd.bind_row_drag(self, content_data, { source: 'handle' })).toBe(true);
			// ONE listener set on content_data (exactly one per type), NONE on any row
			expect(content_data.listener_types()).toEqual(ROW_DRAG_TYPES);
			for (const row of rows) expect(row.listener_count()).toBe(0);

			const dt = new FakeDataTransfer();
			const event = dispatch(new FakeEvent('dragstart', handles[1] as FakeEl, dt));
			expect(event.prevented).toBe(false);
			const payload = JSON.parse(dt.getData(dnd.PORTAL_ROW_MIME));
			expect(dt.getData('text/plain')).toBe(dt.getData(dnd.PORTAL_ROW_MIME));
			expect(payload).toEqual({
				kind: dnd.PORTAL_ROW_KIND,
				locator: { ...(PAGE2_ENTRIES[1] as Locator) },
				paginated_key: 10,
				index: 1,
				source_id: 'portal_p2',
				source_tipo: 'zzrelmv_portal',
				draggable_to: ['zzrelmv_other'],
				window_generation: 5,
			});
			expect(record_window.holds).toEqual(['hold:1:drag']);
			expect(rows[1]?.classList.contains('dragging')).toBe(true);

			// dragend: marks gone, row unheld
			dispatch(new FakeEvent('dragend', handles[1] as FakeEl, dt));
			expect(rows[1]?.classList.contains('dragging')).toBe(false);
			expect(record_window.holds).toEqual(['hold:1:drag', 'unhold:1:drag']);
		});

		test('a second bind on the same content_data under the same window is refused, loudly: one drop saves once', async () => {
			const { self, sort_calls, record_window } = page2_portal();
			const { content_data, rows, handles } = fake_list(self);
			const open_position = () => undefined;
			expect(dnd.bind_row_drag(self, content_data, { source: 'handle', open_position })).toBe(true);
			expect(content_data.listener_types()).toEqual(ROW_DRAG_TYPES);
			const errors: unknown[] = [];
			const original = console.error;
			console.error = (...args: unknown[]) => errors.push(args);
			try {
				expect(dnd.bind_row_drag(self, content_data, { source: 'handle', open_position })).toBe(
					false,
				);
				// the tool binder shares the claim: never a second delegated set either
				expect(dnd.bind_tool_row_drag(self, content_data)).toBe(false);
			} finally {
				console.error = original;
			}
			expect(errors).toHaveLength(2);
			expect(content_data.listener_types()).toEqual(ROW_DRAG_TYPES);

			// one own-row drop → exactly one save
			const dt = new FakeDataTransfer();
			dispatch(new FakeEvent('dragstart', handles[2] as FakeEl, dt));
			dispatch(new FakeEvent('drop', rows[0] as FakeEl, dt));
			await settle();
			expect(sort_calls).toHaveLength(1);
			dnd.release_drag_source();

			// a replaced window (re-render) aborted the old set: its re-bind is allowed
			record_window.controller.abort();
			const successor = fake_window(PAGE2_ENTRIES, 6);
			self.record_windows = { rows: successor };
			expect(dnd.bind_row_drag(self, content_data, { source: 'handle' })).toBe(true);
			expect(content_data.listener_types()).toEqual(ROW_DRAG_TYPES);
		});

		test('handle mode: a dragstart that is not on a handle is left alone (text selection)', () => {
			const { self } = page2_portal();
			const { content_data, inputs } = fake_list(self);
			dnd.bind_row_drag(self, content_data, { source: 'handle' });
			const dt = new FakeDataTransfer();
			const event = dispatch(new FakeEvent('dragstart', inputs[0] as FakeEl, dt));
			expect(event.prevented).toBe(false);
			expect(dt.types).toEqual([]);
		});

		test('the source gate is re-checked AT the event (view_order set after render)', () => {
			const { self } = page2_portal();
			const { content_data, handles } = fake_list(self);
			dnd.bind_row_drag(self, content_data, { source: 'handle' });
			self.view_order = { tipo: 'zzrelmv_date', direction: 'ASC' };
			const dt = new FakeDataTransfer();
			const event = dispatch(new FakeEvent('dragstart', handles[0] as FakeEl, dt));
			expect(event.prevented).toBe(true);
			expect(dt.types).toEqual([]);
		});

		test('foreign dragover/drop (no portal MIME type) are not consumed and reach the ancestor', () => {
			const { self, sort_calls } = page2_portal();
			const { content_data, rows, ancestor_seen } = fake_list(self);
			dnd.bind_row_drag(self, content_data, { source: 'handle' });
			for (const type of ['dragover', 'drop']) {
				const dt = new FakeDataTransfer(['Files', 'text/plain'], { 'text/plain': 'x' });
				const event = dispatch(new FakeEvent(type, rows[0] as FakeEl, dt));
				expect(event.prevented).toBe(false);
				expect(event.stopped).toBe(false);
			}
			expect(ancestor_seen).toEqual(['dragover', 'drop']);
			expect(sort_calls).toEqual([]);
		});

		test('own row: dragover marks the target row, drop sends ABSOLUTE keys and is consumed', async () => {
			const { self, sort_calls } = page2_portal();
			const { content_data, rows, handles, ancestor_seen } = fake_list(self);
			dnd.bind_row_drag(self, content_data, { source: 'handle' });
			const dt = new FakeDataTransfer();
			dispatch(new FakeEvent('dragstart', handles[2] as FakeEl, dt));

			const over = dispatch(new FakeEvent('dragover', rows[0] as FakeEl, dt));
			expect(over.prevented).toBe(true);
			expect(rows[0]?.classList.contains('dragover')).toBe(true);

			const drop = dispatch(new FakeEvent('drop', rows[0] as FakeEl, dt));
			expect(drop.prevented).toBe(true);
			expect(drop.stopped).toBe(true);
			await Promise.resolve();
			expect(sort_calls).toEqual([
				{ value: { ...(PAGE2_ENTRIES[2] as Locator) }, source_key: 11, target_key: 9 },
			]);
			expect(rows[0]?.classList.contains('dragover')).toBe(false);
			expect(ancestor_seen).toEqual([]);
		});

		test('every target the drop refuses is refused at dragover too (never highlighted)', async () => {
			// twin of the retired legacy on_dragover leg, over the delegated binder: the
			// same refusal list, judged by the ONE decide_drop at dragover AND at drop
			type Built = {
				self: Record<string, unknown>;
				content_data: FakeEl;
				target: FakeEl;
				dt: FakeDataTransfer;
			};
			const own_drag = (index: number) => {
				const page = page2_portal();
				const list = fake_list(page.self);
				dnd.bind_row_drag(page.self, list.content_data, { source: 'handle' });
				const dt = new FakeDataTransfer();
				dispatch(new FakeEvent('dragstart', list.handles[index] as FakeEl, dt));
				expect(dt.types.length, 'the drag started').toBeGreaterThan(0);
				return { ...page, ...list, dt };
			};
			const foreign_drag = (source_overrides: Record<string, unknown>) => {
				const { self: source } = page2_portal(source_overrides);
				const source_list = fake_list(source);
				dnd.bind_row_drag(source, source_list.content_data, { source: 'handle' });
				const page = page2_portal();
				const list = fake_list(page.self);
				dnd.bind_row_drag(page.self, list.content_data, { source: 'handle' });
				const dt = new FakeDataTransfer();
				dispatch(new FakeEvent('dragstart', source_list.handles[0] as FakeEl, dt));
				expect(dt.types.length, 'the drag started').toBeGreaterThan(0);
				return { ...page, ...list, dt };
			};
			const refused: Array<[string, () => Built & { sort_calls: unknown[] }]> = [
				[
					'declared order',
					() => {
						const built = own_drag(2);
						(built.self.context as Record<string, unknown>).declared_order = [
							{ tipo: 'zzrelmv_date', direction: 'ASC' },
						];
						return { ...built, target: built.rows[0] as FakeEl };
					},
				],
				[
					'active view_order',
					() => {
						const built = own_drag(2);
						built.self.view_order = { tipo: 'zzrelmv_date', direction: 'ASC' };
						return { ...built, target: built.rows[0] as FakeEl };
					},
				],
				[
					'own row onto itself',
					() => {
						const built = own_drag(2);
						return { ...built, target: built.rows[2] as FakeEl };
					},
				],
				[
					'own reorder over the list (no target row)',
					() => {
						const built = own_drag(2);
						return { ...built, target: built.content_data };
					},
				],
				[
					'another instance of the SAME tipo not naming it',
					() => {
						const built = foreign_drag({ id: 'portal_p2_twin' });
						return { ...built, target: built.rows[0] as FakeEl };
					},
				],
				[
					'another portal whose draggable_to does not name this tipo',
					() => {
						const built = foreign_drag({
							id: 'other_instance',
							tipo: 'zzrelmv_other',
							properties: { draggable_to: ['zzrelmv_elsewhere'] },
						});
						return { ...built, target: built.rows[0] as FakeEl };
					},
				],
			];
			for (const [label, build] of refused) {
				const { content_data, target, dt, sort_calls } = build();
				const over = dispatch(new FakeEvent('dragover', target, dt));
				const highlighted = content_data.children.some((n) => n.classList.contains('dragover'));
				expect([label, over.prevented, over.stopped, highlighted]).toEqual([
					label,
					false,
					false,
					false,
				]);
				// …and the drop it would have invited is refused by the same decision
				const drop = dispatch(new FakeEvent('drop', target, dt));
				await Promise.resolve();
				expect([label, drop.stopped, sort_calls]).toEqual([label, false, []]);
				dnd.release_drag_source();
			}
		});

		test('a stale drop (window superseded mid-drag) is consumed, never sent, and said once', async () => {
			const { self, sort_calls, record_window } = page2_portal();
			const { content_data, rows, handles, ancestor_seen } = fake_list(self);
			dnd.bind_row_drag(self, content_data, { source: 'handle' });
			const dt = new FakeDataTransfer();
			dispatch(new FakeEvent('dragstart', handles[2] as FakeEl, dt));
			record_window.generation = 6; // the list was replaced under the drag
			const { notices, stop } = collect_notices();
			try {
				// dragover: accepted (does not bubble to an ancestor), no notice per tick
				const over = dispatch(new FakeEvent('dragover', rows[0] as FakeEl, dt));
				expect(over.prevented).toBe(true);
				await settle();
				expect(notices).toEqual([]);
				// drop: consumed, nothing sent, ONE resource.conflict notice
				const drop = dispatch(new FakeEvent('drop', rows[0] as FakeEl, dt));
				expect(drop.prevented).toBe(true);
				expect(drop.stopped).toBe(true);
				await settle();
			} finally {
				stop();
			}
			expect(ancestor_seen).toEqual([]);
			expect(sort_calls).toEqual([]);
			expect(notices.map((n) => n.code)).toEqual(['resource.conflict']);
			// its OWN label, rendered — never the generic conflict sentence
			expect(notices[0]?.msg).toBe(served_labels('eng').drag_list_changed);
		});

		test("the stale notice renders in the user's language (label_key passed, not English)", async () => {
			const { self, record_window } = page2_portal();
			const { content_data, rows, handles } = fake_list(self);
			dnd.bind_row_drag(self, content_data, { source: 'handle' });
			const dt = new FakeDataTransfer();
			dispatch(new FakeEvent('dragstart', handles[2] as FakeEl, dt));
			record_window.generation = 6;
			const { notices, stop } = collect_notices();
			try {
				await with_labels('spa', async () => {
					dispatch(new FakeEvent('drop', rows[0] as FakeEl, dt));
					await settle();
				});
			} finally {
				stop();
			}
			const spa = served_labels('spa').drag_list_changed;
			expect(spa).not.toBe(served_labels('eng').drag_list_changed);
			expect(notices.map((n) => n.msg)).toEqual([spa]);
		});

		test('move-to-position: dblclick / Enter on the handle HOLD the row until release', () => {
			const { self, record_window } = page2_portal();
			const { content_data, rows, handles } = fake_list(self);
			const opened: Array<{ index: number; entry: unknown; total: unknown; release: () => void }> =
				[];
			dnd.bind_row_drag(self, content_data, {
				source: 'handle',
				open_position: (
					index: number,
					ctx: { entry: unknown; total: unknown; release: () => void },
				) => opened.push({ index, ...ctx }),
			});

			// not on a handle → nothing opened, nothing held
			dispatch(new FakeEvent('dblclick', rows[0] as FakeEl));
			expect(opened).toHaveLength(0);
			expect(record_window.holds).toEqual([]);

			const dbl = dispatch(new FakeEvent('dblclick', handles[1] as FakeEl));
			expect(dbl.prevented).toBe(true);
			expect(dbl.stopped).toBe(true);
			expect(opened).toHaveLength(1);
			expect(opened[0]?.index).toBe(1);
			expect(opened[0]?.entry).toEqual({ ...(PAGE2_ENTRIES[1] as Locator) });
			expect(opened[0]?.total).toBe(12);
			expect(record_window.holds).toEqual(['hold:1:position']);
			opened[0]?.release();
			opened[0]?.release(); // idempotent: one unhold only
			expect(record_window.holds).toEqual(['hold:1:position', 'unhold:1:position']);

			// Enter on a handle reached by Tab: the same path
			const enter = new FakeEvent('keydown', handles[2] as FakeEl);
			enter.key = 'Enter';
			dispatch(enter);
			const other = new FakeEvent('keydown', handles[2] as FakeEl);
			other.key = 'a';
			dispatch(other);
			expect(opened).toHaveLength(2);
			expect(opened[1]?.index).toBe(2);
			opened[1]?.release();
			expect(record_window.holds.slice(2)).toEqual(['hold:2:position', 'unhold:2:position']);

			// a declared/view order switches reorder off: nothing opens, nothing is held
			self.view_order = { tipo: 'zzrelmv_date', direction: 'ASC' };
			dispatch(new FakeEvent('dblclick', handles[0] as FakeEl));
			expect(opened).toHaveLength(2);
			expect(record_window.holds).toHaveLength(4);
		});

		test("move-to-position: a dblclick / Enter on a NESTED list's handle never opens the outer row", () => {
			const { self, record_window } = page2_portal();
			const { content_data, rows, ancestor_seen } = fake_list(self);
			const { inner_handle } = nest_list(rows[0] as FakeEl);
			const opened: number[] = [];
			dnd.bind_row_drag(self, content_data, {
				source: 'handle',
				open_position: (index: number) => opened.push(index),
			});
			const dbl = dispatch(new FakeEvent('dblclick', inner_handle));
			const enter = new FakeEvent('keydown', inner_handle);
			enter.key = 'Enter';
			dispatch(enter);
			expect(dbl.stopped).toBe(false);
			expect(dbl.prevented).toBe(false);
			expect(opened).toEqual([]);
			expect(record_window.holds).toEqual([]);
			// the nested list's own drag start is not the outer row's either
			const dt = new FakeDataTransfer();
			const start = dispatch(new FakeEvent('dragstart', inner_handle, dt));
			expect(start.stopped).toBe(false);
			expect(dt.types).toEqual([]);
			expect(ancestor_seen).toEqual([]); // dblclick/keydown/dragstart: not listened to there
		});

		test('the window signal removes every listener (retire/destroy)', () => {
			const { self, record_window } = page2_portal();
			const { content_data } = fake_list(self);
			dnd.bind_row_drag(self, content_data, { source: 'row' });
			expect(content_data.listener_count()).toBeGreaterThan(0);
			record_window.controller.abort();
			expect(content_data.listener_count()).toBe(0);
		});

		test('no row window → nothing bound, loudly', () => {
			const { self } = page2_portal({ record_windows: null });
			const { content_data } = fake_list(self);
			const errors: unknown[] = [];
			const original = console.error;
			console.error = (...args: unknown[]) => errors.push(args);
			try {
				expect(dnd.bind_row_drag(self, content_data, {})).toBe(false);
			} finally {
				console.error = original;
			}
			expect(content_data.listener_count()).toBe(0);
			expect(errors).toHaveLength(1);
		});
	});

	// ── a window retired MID-DRAG releases the drag (tmp + hold) ───────────────────────
	// Retire aborts record_window.signal, which removes the dragend listener: the abort
	// itself must release, or tmp outlives the window (payload, owner, a dead window).
	describe('retire mid-drag releases the drag source', () => {
		afterEach(() => {
			dnd.release_drag_source();
		});

		test('bind_row_drag: abort → tmp cleared, hold released; a successor window keeps its own drag', () => {
			const { self, record_window } = page2_portal();
			const { content_data, handles } = fake_list(self);
			dnd.bind_row_drag(self, content_data, { source: 'handle' });
			dispatch(new FakeEvent('dragstart', handles[1] as FakeEl, new FakeDataTransfer()));
			expect(record_window.holds).toEqual(['hold:1:drag']);
			record_window.controller.abort();
			expect(record_window.holds).toEqual(['hold:1:drag', 'unhold:1:drag']);
			expect(dnd.release_drag_source()).toBe(false); // nothing left held (tmp cleared with it)

			// the successor window of the SAME owner: the old window's abort is spent,
			// and retiring ANOTHER window never releases this one's drag
			const successor = fake_window(PAGE2_ENTRIES, 6);
			self.record_windows = { rows: successor };
			const { content_data: next_content, handles: next_handles } = fake_list(self);
			dnd.bind_row_drag(self, next_content, { source: 'handle' });
			dispatch(new FakeEvent('dragstart', next_handles[0] as FakeEl, new FakeDataTransfer()));
			const unrelated = page2_portal();
			dnd.bind_row_drag(unrelated.self, fake_list(unrelated.self).content_data, {
				source: 'handle',
			});
			unrelated.record_window.controller.abort();
			expect(successor.holds).toEqual(['hold:0:drag']);
			expect(dnd.release_drag_source(self)).toBe(true);
		});

		test('bind_tool_row_drag: abort → hold released, tmp cleared', () => {
			const { self, record_window } = page2_portal({ view: 'tool_cataloging_mosaic' });
			const { content_data, rows } = fake_list(self);
			dnd.bind_tool_row_drag(self, content_data);
			dispatch(new FakeEvent('dragstart', rows[2] as FakeEl, new FakeDataTransfer()));
			expect(record_window.holds).toEqual(['hold:2:drag']);
			record_window.controller.abort();
			expect(record_window.holds).toEqual(['hold:2:drag', 'unhold:2:drag']);
			expect(dnd.release_drag_source()).toBe(false);
		});
	});

	describe('touch_pick tap-tap: peek decides, a foreign pick survives', () => {
		const touch_globals: Record<string, unknown> = {};
		beforeAll(() => {
			for (const key of ['matchMedia', 'document']) touch_globals[key] = globals[key];
			globals.matchMedia = () => ({ matches: true });
			const body = new FakeEl('body');
			globals.document = {
				body,
				createElement: (tag: string) => new FakeEl(tag),
			};
		});
		// every case starts with no pick held, whichever case failed before it
		afterEach(() => {
			touch_pick.cancel();
		});
		afterAll(() => {
			touch_pick.cancel();
			for (const key of Object.keys(touch_globals)) {
				if (touch_globals[key] === undefined) delete globals[key];
				else globals[key] = touch_globals[key];
			}
		});

		test('peek() reads the pick without consuming it; as_drop_event() consumes', () => {
			touch_pick.pick('{"a":1}', 'x');
			expect(touch_pick.peek()).toBe('{"a":1}');
			expect(touch_pick.peek()).toBe('{"a":1}');
			expect(touch_pick.active()).toBe(true);
			touch_pick.as_drop_event();
			expect(touch_pick.active()).toBe(false);
			expect(touch_pick.peek()).toBeNull();
		});

		test('a FOREIGN pick tapped on a portal row is not consumed and reaches the ancestor', () => {
			const { self, sort_calls } = page2_portal();
			const { content_data, rows, ancestor_seen } = fake_list(self);
			dnd.bind_row_drag(self, content_data, { source: 'handle' });
			// a cataloging card (tool payload: no kind) is held
			const card = JSON.stringify(dnd.get_row_transfer_data({ caller: self, index: 0 }));
			touch_pick.pick(card, '110');
			const event = dispatch(new FakeEvent('click', rows[1] as FakeEl));
			expect(event.stopped).toBe(false);
			expect(touch_pick.active()).toBe(true);
			expect(touch_pick.peek()).toBe(card);
			expect(ancestor_seen).toEqual(['click']);
			expect(sort_calls).toEqual([]);
		});

		test('own pick: tap the handle picks, tap a row places with ABSOLUTE keys', async () => {
			const { self, sort_calls } = page2_portal();
			const { content_data, rows, handles } = fake_list(self);
			dnd.bind_row_drag(self, content_data, { source: 'handle' });
			dispatch(new FakeEvent('click', handles[1] as FakeEl));
			expect(touch_pick.active()).toBe(true);
			expect(JSON.parse(touch_pick.peek() as string).kind).toBe(dnd.PORTAL_ROW_KIND);

			const place = dispatch(new FakeEvent('click', rows[2] as FakeEl));
			expect(place.stopped).toBe(true);
			expect(touch_pick.active()).toBe(false);
			await Promise.resolve();
			await Promise.resolve();
			expect(sort_calls).toEqual([
				{ value: { ...(PAGE2_ENTRIES[1] as Locator) }, source_key: 10, target_key: 11 },
			]);
		});

		test('PLACE on a cell that swallows its own click still places (capture phase)', async () => {
			const { self, sort_calls } = page2_portal();
			const { content_data, rows, handles } = fake_list(self);
			dnd.bind_row_drag(self, content_data, { source: 'handle' });
			// a list-mode component cell: its own click stops propagation (activate_edit_in_list)
			const cell = (rows[2] as FakeEl).appendChild(new FakeEl('div', ['wrapper_component']));
			const cell_clicks: string[] = [];
			cell.addEventListener('click', (e) => {
				cell_clicks.push(e.type);
				e.stopPropagation();
			});
			dispatch(new FakeEvent('click', handles[1] as FakeEl));
			expect(touch_pick.active()).toBe(true);
			const place = dispatch(new FakeEvent('click', cell));
			expect(place.stopped).toBe(true);
			expect(cell_clicks, 'the placing tap also activated the cell').toEqual([]);
			expect(touch_pick.active()).toBe(false);
			await Promise.resolve();
			await Promise.resolve();
			expect(sort_calls).toEqual([
				{ value: { ...(PAGE2_ENTRIES[1] as Locator) }, source_key: 10, target_key: 11 },
			]);
			// control: without a pick the cell keeps its own click
			dispatch(new FakeEvent('click', cell));
			expect(cell_clicks).toEqual(['click']);
		});

		test('PLACE inside a nested BOUND list is left to that list (capture runs outer-first)', async () => {
			const outer = page2_portal();
			const inner = page2_portal({ id: 'portal_inner' });
			const { content_data, rows, handles } = fake_list(outer.self);
			const { inner_content, inner_row } = nest_list(rows[0] as FakeEl);
			dnd.bind_row_drag(outer.self, content_data, { source: 'handle' });
			dnd.bind_row_drag(inner.self, inner_content, { source: 'handle' });
			// an OUTER pick tapped on the inner row: the inner list refuses a foreign
			// portal row it is not a MOVE target of, the outer must not take it either
			dispatch(new FakeEvent('click', handles[1] as FakeEl));
			expect(touch_pick.active()).toBe(true);
			const tap = dispatch(new FakeEvent('click', inner_row));
			expect(tap.stopped).toBe(false);
			expect(touch_pick.active()).toBe(true);
			await Promise.resolve();
			expect(outer.sort_calls).toEqual([]);
			expect(inner.sort_calls).toEqual([]);
			// control: the same pick placed on an outer row of its own
			dispatch(new FakeEvent('click', rows[2] as FakeEl));
			expect(touch_pick.active()).toBe(false);
			await Promise.resolve();
			await Promise.resolve();
			expect(outer.sort_calls.length).toBe(1);
		});

		test("a tap on a NESTED list's handle never picks the outer row (it bubbles on)", () => {
			const { self, sort_calls } = page2_portal();
			const { content_data, rows, handles, ancestor_seen } = fake_list(self);
			const { inner_handle } = nest_list(rows[0] as FakeEl);
			dnd.bind_row_drag(self, content_data, { source: 'handle' });
			const tap = dispatch(new FakeEvent('click', inner_handle));
			expect(tap.stopped).toBe(false);
			expect(touch_pick.active()).toBe(false);
			expect(ancestor_seen).toEqual(['click']);
			// the outer row's OWN handle still picks (the refusal is ownership, not a dead binder)
			dispatch(new FakeEvent('click', handles[0] as FakeEl));
			expect(touch_pick.active()).toBe(true);
			expect(JSON.parse(touch_pick.peek() as string).index).toBe(0);
			expect(sort_calls).toEqual([]);
		});

		test('row source: a tap on a control inside the row never picks', () => {
			const { self } = page2_portal();
			const { content_data, inputs } = fake_list(self);
			dnd.bind_row_drag(self, content_data, { source: 'row' });
			dispatch(new FakeEvent('click', inputs[0] as FakeEl));
			expect(touch_pick.active()).toBe(false);
		});
	});

	describe('bind_tool_row_drag / bind_portal_drop', () => {
		afterEach(() => {
			dnd.release_drag_source();
		});

		test('tool mosaic: text/plain ONLY (never the portal MIME), gate re-checked at the event', () => {
			const { self, record_window } = page2_portal({ view: 'tool_cataloging_mosaic' });
			const { content_data, rows } = fake_list(self);
			expect(dnd.bind_tool_row_drag(self, content_data)).toBe(true);
			const dt = new FakeDataTransfer();
			const event = dispatch(new FakeEvent('dragstart', rows[1] as FakeEl, dt));
			expect(event.prevented).toBe(false);
			expect(dt.types).toEqual(['text/plain']);
			const payload = JSON.parse(dt.getData('text/plain'));
			expect(dnd.is_portal_payload(payload)).toBe(false);
			expect(payload.locator).toEqual({ ...(PAGE2_ENTRIES[1] as Locator) });
			expect(record_window.holds).toEqual(['hold:1:drag']);
			dispatch(new FakeEvent('dragend', rows[1] as FakeEl, dt));
			expect(record_window.holds).toEqual(['hold:1:drag', 'unhold:1:drag']);
			// no caller_name: the payload names no caller (ts_object publishes nothing)
			expect('caller' in payload).toBe(false);

			self.view = 'mosaic'; // not a tool source any more
			const refused = dispatch(
				new FakeEvent('dragstart', rows[1] as FakeEl, new FakeDataTransfer()),
			);
			expect(refused.prevented).toBe(true);
		});

		test('tool mosaic caller_name: the payload names its caller (ts_add_child_<caller> links the record)', () => {
			const { self } = page2_portal({ view: 'tool_cataloging_mosaic' });
			const { content_data, rows } = fake_list(self);
			expect(dnd.bind_tool_row_drag(self, content_data, { caller_name: 'tool_cataloging' })).toBe(
				true,
			);
			const dt = new FakeDataTransfer();
			dispatch(new FakeEvent('dragstart', rows[1] as FakeEl, dt));
			const payload = JSON.parse(dt.getData('text/plain'));
			expect(payload.caller).toBe('tool_cataloging');
			expect(dnd.is_portal_payload(payload)).toBe(false);
			expect(
				dnd.get_row_transfer_data({ caller: self, index: 0, caller_name: 'tool_cataloging' })
					?.caller,
			).toBe('tool_cataloging');
			expect('caller' in (dnd.get_row_transfer_data({ caller: self, index: 0 }) ?? {})).toBe(false);
		});

		test('wrapper zone: MOVE only; a reorder or a foreign drag bubbles on', () => {
			const { self } = page2_portal();
			const { wrapper, ancestor_seen } = fake_list(self);
			expect(dnd.bind_portal_drop(self, wrapper)).toBe(true);
			expect(dnd.bind_portal_drop(self, wrapper)).toBe(false); // idempotent

			// a MOVE from another portal naming this tipo
			const { self: source } = page2_portal({
				id: 'other_instance',
				tipo: 'zzrelmv_other',
				properties: { draggable_to: ['zzrelmv_portal'] },
			});
			const { content_data: source_content, handles } = fake_list(source);
			dnd.bind_row_drag(source, source_content, { source: 'handle' });
			const dt = new FakeDataTransfer();
			dispatch(new FakeEvent('dragstart', handles[0] as FakeEl, dt));
			const over = dispatch(new FakeEvent('dragover', wrapper, dt));
			expect(over.prevented).toBe(true);
			expect(wrapper.classList.contains('drop_target')).toBe(true);
			dnd.release_drag_source();

			// own reorder payload over the wrapper (no row): not the wrapper's business
			const { content_data, handles: own_handles } = fake_list(self);
			dnd.bind_row_drag(self, content_data, { source: 'handle' });
			const own = new FakeDataTransfer();
			dispatch(new FakeEvent('dragstart', own_handles[0] as FakeEl, own));
			ancestor_seen.length = 0;
			wrapper.classList.remove('drop_target');
			const own_over = dispatch(new FakeEvent('dragover', wrapper, own));
			expect(own_over.prevented).toBe(false);
			expect(wrapper.classList.contains('drop_target')).toBe(false);
			// a foreign file drag
			const file_over = dispatch(
				new FakeEvent('dragover', wrapper, new FakeDataTransfer(['Files'])),
			);
			expect(file_over.prevented).toBe(false);
			expect(ancestor_seen).toEqual(['dragover', 'dragover']);
		});
	});

	describe('bind_portal_drop — the wrapper DROP executes the MOVE', () => {
		afterEach(() => {
			dnd.release_drag_source();
		});

		/** A real-prototype target bound on a wrapper, and a registered real-prototype source. */
		function wrapper_move() {
			const source_door = new FakeSaveDoor('zzrelmv_source');
			const target_door = new FakeSaveDoor('zzrelmv_target');
			const stored = source_door.seed({ section_tipo: 'zzrelmv10', section_id: '5' }, 7);
			const source = make_portal({
				id: 'source_instance',
				tipo: 'zzrelmv_source',
				door: source_door,
			});
			const target = make_portal({
				id: 'target_instance',
				tipo: 'zzrelmv_target',
				door: target_door,
			});
			register('zz_client_relation_move_wrapper_source', source);
			const ancestor = new FakeEl('div', ['ts_object_term']);
			const wrapper = ancestor.appendChild(new FakeEl('div', ['wrapper_component']));
			const ancestor_seen: string[] = [];
			for (const type of ['dragover', 'drop']) {
				ancestor.addEventListener(type, (e) => ancestor_seen.push(e.type));
			}
			expect(dnd.bind_portal_drop(target, wrapper)).toBe(true);
			const payload = {
				kind: dnd.PORTAL_ROW_KIND,
				locator: { ...stored },
				paginated_key: 0,
				index: 0,
				source_id: 'source_instance',
				source_tipo: 'zzrelmv_source',
				draggable_to: ['zzrelmv_target'],
				window_generation: 1,
			};
			return { source_door, target_door, stored, wrapper, ancestor_seen, payload };
		}
		function portal_transfer(payload: unknown) {
			const json = JSON.stringify(payload);
			return new FakeDataTransfer([dnd.PORTAL_ROW_MIME, 'text/plain'], {
				[dnd.PORTAL_ROW_MIME]: json,
				'text/plain': json,
			});
		}

		test('a MOVE dropped on the wrapper links into the target, then unlinks the source BY ID', async () => {
			const { source_door, target_door, wrapper, ancestor_seen, payload } = wrapper_move();
			wrapper.classList.add('drop_target');
			const drop = dispatch(new FakeEvent('drop', wrapper, portal_transfer(payload)));
			expect(drop.prevented).toBe(true);
			expect(drop.stopped).toBe(true);
			expect(wrapper.classList.contains('drop_target')).toBe(false);
			await settle();
			expect(target_door.items).toHaveLength(1);
			expect(target_door.items[0]?.locator.section_id).toBe('5');
			expect(target_door.items[0]?.locator.from_component_tipo).toBe('zzrelmv_target');
			expect(source_door.batches).toEqual([[{ action: 'remove', id: 7, value: null }]]);
			expect(source_door.items).toHaveLength(0);
			expect(source_door.door_refusals).toEqual([]);
			expect(ancestor_seen).toEqual([]);
			expect(alerts).toEqual([]);
		});

		test('a refused MOVE on the wrapper leaves the source untouched', async () => {
			const { source_door, target_door, wrapper, payload } = wrapper_move();
			target_door.refuse_insert = () => true;
			const drop = dispatch(new FakeEvent('drop', wrapper, portal_transfer(payload)));
			expect(drop.prevented).toBe(true);
			await settle();
			expect(target_door.items).toHaveLength(0);
			expect(source_door.batches).toHaveLength(0);
			expect(source_door.items).toHaveLength(1);
			expect(alerts).toHaveLength(1);
		});

		test('an own-reorder, a foreign-portal or a non-portal drop on the wrapper is NOT stopped', async () => {
			const { source_door, target_door, wrapper, ancestor_seen, payload } = wrapper_move();
			const drops = [
				// the target's OWN row (a reorder needs a row: not the wrapper's business)
				portal_transfer({
					...payload,
					source_id: 'target_instance',
					source_tipo: 'zzrelmv_target',
				}),
				// another portal that does not name this tipo
				portal_transfer({ ...payload, draggable_to: ['zzrelmv_elsewhere'] }),
				// the same JSON WITHOUT the portal MIME type (a file / text drag)
				new FakeDataTransfer(['text/plain'], { 'text/plain': JSON.stringify(payload) }),
			];
			// the two portal-MIME drops are OURS: the default text drop is blocked
			// (prevented) but never stopped; the MIME-less one is foreign: untouched
			const expected_prevented: boolean[] = [true, true, false];
			drops.forEach((dt, i) => {
				const drop = dispatch(new FakeEvent('drop', wrapper, dt));
				expect([i, drop.prevented, drop.stopped]).toEqual([
					i,
					expected_prevented[i] === true,
					false,
				]);
			});
			await settle();
			expect(ancestor_seen).toEqual(['drop', 'drop', 'drop']);
			expect(target_door.batches).toHaveLength(0);
			expect(source_door.batches).toHaveLength(0);
		});
	});

	// ── LEGACY drag symbols: SHRINK-ONLY (empty since stage 5 of the row-box WC) ──
	// (engineering/wire_contract/WC-2026-10-30-section-record-row-box.md, stage-3
	// addendum). The kind-less payload upgrade accepts a weaker shape than the
	// delegated core; if stage 5 slips, this list is where it shows.
	//  - THE BANK IS THE CONTRACT, not this file: the legacy set must EQUAL the WC
	//    entry's "Legacy, removed at stage 5" list, so growing it is a wire-contract
	//    edit (engineering/WIRE_CONTRACT.md), never a one-line test change. A removed
	//    symbol leaves both in the same change.
	//  - THE CLASSIFICATION IS TOTAL, not a name prefix: every top-level binding of
	//    drag_and_drop.js — any declaration form (`function`, `const`/`let`/`var` of a
	//    function, an arrow or a value, `class`) and any name — is classified exactly
	//    once as DELEGATED_CORE_EXPORTS, CORE_INTERNALS or LEGACY_DRAG_SYMBOLS. An
	//    unclassified binding is red, so a new legacy helper cannot hide under an
	//    off-convention name or shape.
	// Empty since stage 5: every legacy symbol left with its last caller. Shrink-only —
	// a new entry is a WC edit first.
	const LEGACY_DRAG_SYMBOLS: ReadonlyMap<string, string> = new Map([]);
	/**
	 * The delegated (stage-3) export surface of drag_and_drop.js — NOT legacy. A new
	 * export must be added here (core) or to LEGACY_DRAG_SYMBOLS (legacy): the census
	 * below compares the REAL module namespace against the union, both ways.
	 */
	const DELEGATED_CORE_EXPORTS: ReadonlySet<string> = new Set([
		'PORTAL_ROW_MIME',
		'PORTAL_ROW_KIND',
		'TOOL_ROW_SOURCES',
		'can_reorder',
		'can_view_sort',
		'can_save_view_order',
		'declared_order_of', // the ONE reader of context.declared_order (gates + O2 order indicator)
		'can_drag_out',
		'can_tool_source',
		'is_portal_payload',
		'decide_drop',
		'get_row_transfer_data',
		'release_drag_source',
		'bind_row_drag',
		'bind_tool_row_drag',
		'bind_portal_drop',
		'move_to_position_decision',
		'on_drop', // the ONE drop adapter (touch_pick)
	]);
	/** The non-exported core helpers of drag_and_drop.js (the rest of the total classification). */
	const CORE_INTERNALS: ReadonlySet<string> = new Set([
		'tmp',
		'has_declared_order',
		'draggable_to_of',
		'parse_payload',
		'has_portal_type',
		'row_window_of',
		'target_entry',
		'build_row_payload',
		'event_element',
		'clear_marks',
		'set_drag_source',
		'release_window_drag',
		'notify_stale',
		'perform_drop',
		'is_tap_on_control',
		'resolve_source_row',
		'own_handle',
		'bound_row_windows',
		'innermost_row_binding',
		'claim_row_binding',
		'bound_drop_wrappers',
		'drop_decision_of',
	]);

	/**
	 * Every TOP-LEVEL binding a module declares, by any declaration form. Comments,
	 * strings and template literals are blanked, nested scopes dropped (brace/paren/
	 * bracket depth, `${…}` aware); a top-level destructuring is reported in
	 * `unparsed`, and so is a multi-binding `const a = 1, b = 2` (the gate refuses
	 * both rather than missing their names).
	 */
	function top_level_bindings(src: string): { names: string[]; unparsed: string[] } {
		let out = '';
		let depth = 0;
		let mode: 'code' | 'tpl' = 'code';
		const tpl_return: number[] = [];
		for (let i = 0; i < src.length; i++) {
			const c = src[i] as string;
			const next = src[i + 1];
			if (mode === 'tpl') {
				if (c === '\\') {
					i++;
				} else if (c === '`') {
					mode = 'code';
					out += ' ';
				} else if (c === '$' && next === '{') {
					tpl_return.push(depth);
					depth++;
					i++;
					mode = 'code';
				} else {
					out += c === '\n' ? '\n' : ' ';
				}
				continue;
			}
			if (c === '/' && next === '/') {
				const end = src.indexOf('\n', i);
				i = end === -1 ? src.length : end - 1;
			} else if (c === '/' && next === '*') {
				const end = src.indexOf('*/', i + 2);
				const stop = end === -1 ? src.length : end + 2;
				out += src.slice(i, stop).replace(/[^\n]/g, ' ');
				i = stop - 1;
			} else if (c === "'" || c === '"') {
				let j = i + 1;
				while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
				out += ' ';
				i = j;
			} else if (c === '`') {
				mode = 'tpl';
				out += ' ';
			} else if (c === '{' || c === '(' || c === '[') {
				out += depth === 0 ? c : ' ';
				depth++;
			} else if (c === '}' || c === ')' || c === ']') {
				depth--;
				if (c === '}' && tpl_return.length > 0 && depth === tpl_return[tpl_return.length - 1]) {
					tpl_return.pop();
					mode = 'tpl';
				}
				out += depth === 0 && mode === 'code' ? c : ' ';
			} else {
				out += depth === 0 || c === '\n' ? c : ' ';
			}
		}
		const names: string[] = [];
		const unparsed: string[] = [];
		for (const m of out.matchAll(
			/(?<=^|[;\s])(?:export\s+)?(?:async\s+)?(?:function\s*\*?\s*(\w+)\s*\(|class\s+(\w+))/g,
		))
			names.push((m[1] ?? m[2]) as string);
		for (const m of out.matchAll(
			/(?<=^|[;\s])(?:export\s+)?(?:const|let|var)\s+([^=;\n]*?)(?=\s*(?:=|;|$))/gm,
		)) {
			const bound = (m[1] as string).trim();
			if (/^\w+$/.test(bound)) names.push(bound);
			else unparsed.push(bound || '(destructuring)');
		}
		// a top-level comma is a multi-binding declaration (`const a = 1, b = 2`): its
		// later names would be missed, so it is refused as well
		for (const line of out.split('\n')) if (line.includes(',')) unparsed.push(line.trim());
		return { names, unparsed };
	}

	/** The WC entry's "Legacy, removed at stage 5" list (the bank of the legacy set). */
	function wc_legacy_list(): string[] {
		const wc = readFileSync(
			join(REPO_ROOT, 'engineering/wire_contract/WC-2026-10-30-section-record-row-box.md'),
			'utf8',
		);
		const start = wc.indexOf('**Legacy, removed at stage 5:**');
		const end = wc.indexOf('— pinned shrink-only', start);
		expect(start).toBeGreaterThan(-1);
		expect(end).toBeGreaterThan(start);
		return [...wc.slice(start, end).matchAll(/`(\w+)`/g)].map((m) => m[1] as string);
	}

	describe('LEGACY drag symbols are pinned shrink-only', () => {
		const drag_source = () =>
			readFileSync(join(CLIENT_ROOT, 'dedalo/core/component_portal/js/drag_and_drop.js'), 'utf8');

		test('the binding scanner sees every declaration form (positive control)', () => {
			const probe = [
				'\timport {x} from "./x.js"',
				'const a = 1',
				'function named(p) { const inner = {k: [1, 2]}; return inner }',
				'export const arrow = (p) => { let nested = `t ${ {o: 1}.o } }` }',
				'let plain',
				'var v = "a // not a comment { "',
				'/* const in_comment = 1 */ class K {}',
				'export async function af() {}',
				'// const commented = 2',
				'const x2 = function() {}, y2 = 3',
				'let {d1, d2} = obj',
			].join('\n');
			const { names, unparsed } = top_level_bindings(probe);
			expect(names.sort()).toEqual(['K', 'a', 'af', 'arrow', 'named', 'plain', 'v', 'x2'].sort());
			// the multi-binding line and the destructuring are refused, not missed
			expect(unparsed).toHaveLength(2);
		});

		test('every top-level binding of drag_and_drop.js is classified exactly once (total)', () => {
			const { names, unparsed } = top_level_bindings(drag_source());
			expect(unparsed).toEqual([]);
			// the scanner is not blind: every real export is among what it found
			for (const name of Object.keys(dnd))
				expect([name, names.includes(name)]).toEqual([name, true]);
			const classes = (name: string) =>
				[
					DELEGATED_CORE_EXPORTS.has(name),
					CORE_INTERNALS.has(name),
					LEGACY_DRAG_SYMBOLS.has(name),
				].filter(Boolean).length;
			for (const name of names) expect([name, classes(name)]).toEqual([name, 1]);
			// …and no list names a binding that no longer exists (a removal shrinks it)
			const declared = new Set(names);
			for (const name of [
				...DELEGATED_CORE_EXPORTS,
				...CORE_INTERNALS,
				...LEGACY_DRAG_SYMBOLS.keys(),
			])
				expect([name, declared.has(name)]).toEqual([name, true]);
			expect(new Set(names).size).toBe(names.length); // no double declaration
		});

		test('the legacy set EQUALS the wire-contract bank (growth is a WC edit)', () => {
			expect([...LEGACY_DRAG_SYMBOLS.keys()].sort()).toEqual(wc_legacy_list().sort());
			for (const reason of LEGACY_DRAG_SYMBOLS.values()) expect(reason.length).toBeGreaterThan(20);
		});

		test('the module export set equals DELEGATED_CORE_EXPORTS ∪ exported legacy symbols (growth is red)', () => {
			const exported = Object.keys(dnd).sort();
			const source = drag_source();
			const exported_legacy = [...LEGACY_DRAG_SYMBOLS.keys()].filter((name) =>
				new RegExp(`^export const ${name} = `, 'm').test(source),
			);
			const expected = [...DELEGATED_CORE_EXPORTS, ...exported_legacy].sort();
			expect(exported).toEqual(expected);
			// the two lists are disjoint: a symbol is core OR legacy, never both
			for (const name of LEGACY_DRAG_SYMBOLS.keys())
				expect([name, DELEGATED_CORE_EXPORTS.has(name)]).toEqual([name, false]);
		});
	});

	// ── declared order: the server's `context.declared_order` is read in ONE place ──────
	// drag_and_drop.js `declared_order_of` (and `has_declared_order` over it) is the client's
	// one authority for "this portal's order is the ontology's" (engineering/wire_contract/WC-2026-10-31-portal-order-model.md).
	// Any other read of `declared_order` under client/ or tools/ ** /js is a second,
	// driftable copy of that predicate: red. Comments are prose, not reads.
	describe('declared_order is read only by declared_order_of', () => {
		/** Code lines (comment lines dropped) that mention `declared_order`. */
		function declared_order_reads(text: string): string[] {
			return text.split('\n').filter((line) => {
				const trimmed = line.trim();
				if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*'))
					return false;
				return /\bdeclared_order\b/.test(line.replace(/\/\/.*$/, ''));
			});
		}

		/**
		 * The ONE named writer outside the module: the browser suite BUILDS the declared-order
		 * situation by injecting the server field on a live instance's context (no ontology node
		 * may be created for it — engineering/wire_contract/WC-2026-10-30-section-record-row-box.md,
		 * stage 5). It never reads the field: declared_order_of still decides. Shrink-only; a
		 * listed file that no longer mentions the field is red.
		 */
		const DECLARED_ORDER_SITUATION_WRITERS = new Map([
			[
				'client/dedalo/test/client/js/test_portal_row_drag.js',
				'injects context.declared_order to build the no-source-under-declared-order situation',
			],
			[
				'client/dedalo/test/client/js/test_portal_order.js',
				'injects context.declared_order to build the declared-order indicator / no-save / no-source situation (stage O2)',
			],
		]);

		test('no client/tools file outside drag_and_drop.js reads declared_order', () => {
			const dnd_path = join(CLIENT_ROOT, 'dedalo/core/component_portal/js/drag_and_drop.js');
			const offenders: string[] = [];
			const writers_seen = new Set<string>();
			for (const file of census_files()) {
				if (file === dnd_path) continue;
				const reads = declared_order_reads(readFileSync(file, 'utf8'));
				const repo_path = relative(REPO_ROOT, file);
				if (DECLARED_ORDER_SITUATION_WRITERS.has(repo_path)) {
					if (reads.length > 0) writers_seen.add(repo_path);
					// a writer may only ASSIGN the field, never read it: the line is an
					// assignment AND nothing right of its `=` mentions the field
					const non_assignments = reads.filter((line) => {
						const match = /\.declared_order\s*=(?!=)/.exec(line);
						if (!match) return true;
						const rhs = line.slice(match.index + match[0].length);
						return declared_order_reads(rhs).length > 0;
					});
					if (non_assignments.length > 0)
						offenders.push(`${repo_path}: ${non_assignments[0]?.trim()}`);
					continue;
				}
				if (reads.length > 0) offenders.push(`${repo_path}: ${reads[0]?.trim()}`);
			}
			expect(offenders).toEqual([]);
			expect([...writers_seen].sort()).toEqual([...DECLARED_ORDER_SITUATION_WRITERS.keys()].sort());
		});

		test('the situation-writer list is shrink-only and every entry is reasoned', () => {
			expect(DECLARED_ORDER_SITUATION_WRITERS.size, 'shrink-only').toBeLessThanOrEqual(2);
			for (const reason of DECLARED_ORDER_SITUATION_WRITERS.values())
				expect(reason.length).toBeGreaterThan(20);
		});

		test('inside drag_and_drop.js, only the declared_order_of body reads it', () => {
			const source = readFileSync(
				join(CLIENT_ROOT, 'dedalo/core/component_portal/js/drag_and_drop.js'),
				'utf8',
			);
			const start = source.indexOf('export const declared_order_of = function');
			const end = source.indexOf('}//end declared_order_of');
			expect(start).toBeGreaterThan(-1);
			expect(end).toBeGreaterThan(start);
			// the predicate really reads it…
			expect(declared_order_reads(source.slice(start, end)).length).toBeGreaterThan(0);
			// …and nothing else in the module does
			const outside = source.slice(0, start) + source.slice(end);
			expect(declared_order_reads(outside)).toEqual([]);
		});
	});

	// ────────────────────────────────────────────────────────────────────────────────────
	describe('the server premise the client id-guards rest on', () => {
		// If this relaxes, the client guards above stop being belt-and-braces and become
		// the only thing between a curator and an emptied component. A comment that states
		// a false premise is a defect here, so the premise is pinned mechanically.
		test("save_component.ts still refuses an id-less 'remove'", () => {
			expect(unnamedRemoveRefusal([{ action: 'remove', id: null, value: null }])).toContain(
				'must name the item id',
			);
			expect(
				unnamedRemoveRefusal([{ action: 'remove', id: undefined, value: null }]),
			).not.toBeNull();
			expect(unnamedRemoveRefusal([{ action: 'remove', id: '', value: null }])).not.toBeNull();
			expect(unnamedRemoveRefusal([{ action: 'remove', id: 7, value: null }])).toBeNull();
		});
	});

	// ────────────────────────────────────────────────────────────────────────────────────
	// THE CENSUS — TOTAL over client/ and tools/ ** /js, derived from the tree, never a list.
	//
	// A `link_record` / `link_records` call whose answer is thrown away is the P0-11 shape
	// in miniature: both functions REPORT refusals instead of throwing, so a discarded
	// return value is a refusal nobody will ever see. The rule is mechanical: the call
	// expression may not START a statement.
	// ────────────────────────────────────────────────────────────────────────────────────

	/**
	 * SHRINK-ONLY. Every entry is a live discarded-answer call site that this change did
	 * not own. A file whose count DROPS is red too — fix it and delete its row.
	 */
	const DISCARDED_ANSWER_EXEMPTIONS: ReadonlyArray<{
		path: string;
		count: number;
		reason: string;
	}> = [];

	/** Every .js file under client/, plus tools/ ** /js/. Derived by walking the tree. */
	function census_files(): string[] {
		const found: string[] = [];
		const walk = (dir: string, keep: (file: string) => boolean): void => {
			for (const entry of readdirSync(dir)) {
				const full = join(dir, entry);
				if (statSync(full).isDirectory()) {
					walk(full, keep);
					continue;
				}
				if (entry.endsWith('.js') && keep(full)) found.push(full);
			}
		};
		walk(CLIENT_ROOT, () => true);
		walk(TOOLS_ROOT, (file) => file.includes(`${'/'}js${'/'}`));
		return found.sort();
	}

	/**
	 * Does this line DISCARD the answer? Yes when the call expression starts the statement:
	 * the trimmed line, with a leading `await ` removed, begins with the callee chain.
	 * A line that opens with `const`, `let`, `return`, `if (`, `=`, … consumes it.
	 */
	const CALL_RE = /\.link_records?\s*\(/;
	const DISCARDS_RE = /^[\w$.?()[\]'"]*\.link_records?\s*\(/;
	function discards(line: string): boolean {
		const trimmed = line.trim();
		// comments and docblocks are prose, not call sites
		if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*'))
			return false;
		if (!CALL_RE.test(trimmed)) return false;
		const statement = trimmed.startsWith('await ') ? trimmed.slice(6).trim() : trimmed;
		return DISCARDS_RE.test(statement);
	}

	describe('census: no link_record/link_records call site discards its answer', () => {
		test('the census is total and the exemption list is exactly the live discards', () => {
			const counts = new Map<string, number>();
			for (const file of census_files()) {
				const lines = readFileSync(file, 'utf8').split('\n');
				let n = 0;
				for (const line of lines) if (discards(line)) n++;
				if (n > 0) counts.set(relative(REPO_ROOT, file), n);
			}

			const declared = new Map(DISCARDED_ANSWER_EXEMPTIONS.map((e) => [e.path, e.count]));
			const unexpected = [...counts].filter(([path, n]) => (declared.get(path) ?? 0) !== n);
			const stale = [...declared].filter(([path, n]) => (counts.get(path) ?? 0) !== n);

			expect({ unexpected, stale }).toEqual({ unexpected: [], stale: [] });
		});

		test('the census actually scans the files that hold the fixed call sites', () => {
			// A census that silently matched nothing would be green and worthless.
			const files = census_files().map((f) => relative(REPO_ROOT, f));
			expect(files).toContain('client/dedalo/core/component_portal/js/drag_and_drop.js');
			expect(files).toContain('client/dedalo/core/component_portal/js/component_portal.js');
			expect(files.some((f) => f.startsWith('tools/'))).toBe(true);
			// and that its discard rule can actually fire
			expect(discards('\t\t\tself.caller?.link_record(value)')).toBe(true);
			expect(discards('\t\t\tawait component_tags_reference.link_record(new_locator);')).toBe(true);
			expect(discards('\t\t\tconst outcome = await self.link_records([data_parse.locator])')).toBe(
				false,
			);
			expect(
				discards('*  - Default (no custom event): calls self.caller.link_record(locator)'),
			).toBe(false);
		});
	});
}
