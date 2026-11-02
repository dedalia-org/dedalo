/**
 * QUEUED RENDER MUST ACTUALLY RUN — the concurrency contract of
 *   client/dedalo/core/common/js/common.js  common.prototype.render()
 *
 * WHY THIS FILE EXISTS. render() is a state machine ('built' → 'rendering' →
 * 'rendered'). A second render() arriving while the first is in flight and
 * asking for DIFFERENT params is queued last-write-wins: the options are parked
 * in `_pending_render_options` and the caller gets `_render_waiter`, a promise
 * the `render_<id>` subscriber resolves when the running render publishes.
 *
 * The subscriber then has to put the instance back into a status that render()
 * will actually EXECUTE. It used to restore `previous_status`, captured at the
 * top of the QUEUED call — which is 'rendering', not 'built'. Re-entering with
 * 'rendering' hit the waiter branch again, built a fresh waiter, re-queued the
 * options and returned a promise that only a future `render_<id>` could resolve
 * — while no render was running. The instance's render pipeline wedged forever
 * and the second render (the one carrying the newest options) never happened.
 *
 * `biome.jsonc` excludes `**\/client`, so nothing else looks at this module:
 * without this test the deadlock is silent again. The gate is behavioural — it
 * drives two overlapping renders through the real prototype method and the real
 * event_manager, and fails by TIMING OUT if the queued one never executes.
 */

import { afterAll, beforeAll, expect, mock, test } from 'bun:test';
import { join } from 'node:path';
import { isIsolatedGateChild, mirrorIsolatedGate } from '../helpers/isolated_gate.ts';

// ISOLATED GATE (test/helpers/isolated_gate.ts): this file substitutes client
// modules, which are process-global — in the tier's process it only MIRRORS a
// child run of itself; its body below registers in that child alone.
if (!isIsolatedGateChild(import.meta.path)) mirrorIsolatedGate(import.meta.path);
else {
	const CLIENT_CORE = join(import.meta.dir, '..', '..', 'client', 'dedalo', 'core');

	// ────────────────────────────────────────────────────────────────────────────
	// Module + global seams. Only what render() touches on the 'full' happy path.
	// event_manager is the REAL one: the queue hands off through its events.
	// ────────────────────────────────────────────────────────────────────────────

	mock.module(join(CLIENT_CORE, 'common', 'js', 'ui.js'), () => ({
		ui: { create_dom_element: () => make_node(), activate_tooltips: () => {} },
	}));
	// SPREAD, never truncate: mock.module is process-global and is NOT undone by
	// mock.restore(), so a one-export factory here TRUNCATES css.js for the whole
	// tier and every later file importing component_common.js dies at its
	// `import { set_element_css } from '../../page/js/css.js'`. css.js is inert at
	// import (a Map), so capturing the real module costs nothing.
	const CSS_PATH = join(CLIENT_CORE, 'page', 'js', 'css.js');
	const real_css = await import(CSS_PATH);
	mock.module(CSS_PATH, () => ({ ...real_css, get_inserted_rules: () => [] }));

	const saved_globals: Record<string, unknown> = {};
	const g = globalThis as Record<string, any>;

	function make_node(): Record<string, any> {
		const node: Record<string, any> = {
			nodeType: 1,
			replaceWith: (other: unknown) => {
				node.replaced_with = other;
			},
			appendChild: () => {},
			// a real Element has it: common.render asks a node it replaces whether it
			// is a windowed row (data-index) before the replaceWith
			hasAttribute: () => false,
		};
		return node;
	}

	beforeAll(() => {
		for (const key of [
			'page_globals',
			'Node',
			'get_label',
			'SHOW_DEBUG',
			'SHOW_DEVELOPER',
			'window',
		]) {
			saved_globals[key] = g[key];
		}
		// client modules decorate `window` at import time
		g.window = g.window ?? g;
		g.page_globals = { page_error: null };
		g.Node = { ELEMENT_NODE: 1 };
		g.get_label = {};
		g.SHOW_DEBUG = false;
		g.SHOW_DEVELOPER = false;
	});

	afterAll(() => {
		for (const [key, value] of Object.entries(saved_globals)) {
			if (value === undefined) delete g[key];
			else g[key] = value;
		}
		mock.restore();
	});

	test('a queued (LWW) render executes instead of deadlocking the pipeline', async () => {
		const { common } = await import(join(CLIENT_CORE, 'common', 'js', 'common.js'));

		const rendered: string[] = [];
		// two distinct render modes → the second call is a DIFFERENT request, so it
		// takes the last-write-wins queuing branch rather than joining the first.
		const render_mode_fn = (name: string) => async () => {
			await new Promise((resolve) => setTimeout(resolve, 10));
			rendered.push(name);
			return make_node();
		};

		const self: Record<string, any> = Object.create(common.prototype);
		Object.assign(self, {
			id: 'render_queue_probe',
			tipo: 'test1',
			model: 'component_input_text',
			type: 'component',
			context: { tipo: 'test1', model: 'component_input_text' },
			mode: 'edit',
			permissions: 2,
			status: 'built',
			node: null,
			edit: render_mode_fn('edit'),
			list: render_mode_fn('list'),
		});

		const first = self.render({ render_mode: 'edit' });
		// same tick: the first render is in flight ('rendering') when this arrives
		const queued = self.render({ render_mode: 'list' });

		const deadline = new Promise((_resolve, reject) =>
			setTimeout(() => reject(new Error('queued render never executed (pipeline deadlock)')), 5000),
		);

		const [first_node, queued_node] = (await Promise.race([
			Promise.all([first, queued]),
			deadline,
		])) as unknown[];

		expect(rendered).toEqual(['edit', 'list']);
		expect(first_node).toBeTruthy();
		expect(queued_node).toBeTruthy();
		// the pipeline is left usable, not wedged mid-flight
		expect(self.status).toBe('rendered');
		expect(self._render_waiter).toBeFalsy();
		expect(self._pending_render_options).toBeFalsy();
	});
}
