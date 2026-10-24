/**
 * TRIPWIRE — the 3D viewer stops when the record closes (P2-31 / CLI-27).
 *
 * `animate` re-scheduled itself UNCONDITIONALLY, there was no `viewer.destroy()`
 * anywhere in the module, and the generic component teardown knows nothing about
 * `self.viewer`. So every 3D record a curator opened left behind a live
 * WebGLRenderer with its GPU textures, an OrbitControls, a Stats panel, an
 * AnimationMixer, a render loop running at display refresh, and an anonymous
 * ResizeObserver stored NOWHERE and therefore never disconnectable — measured by
 * the audit at 12 observers created against 3 disconnected over 18 navigations.
 *
 * Chrome caps live WebGL contexts at ~16, so this has a hard failure mode: after
 * enough records the viewer stops working until the page is reloaded.
 *
 * This survives the refuted retention claim in the audit's own notes: a rAF loop
 * and an undisposed renderer are LIVE WORK, not a garbage-collection question.
 * The loop keeps running whether or not anything still references the viewer.
 *
 * Widened (P2-2 / CLI-19): the destroy-override census is TOTAL and derived
 * from the tree (every `<x>.prototype.destroy = function`), and the search
 * filter model's remove door tears down the whole subtree it removes.
 */

import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '../helpers/strip_comments.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const VIEWER = 'client/dedalo/core/component_3d/js/viewer/viewer.js';
const COMPONENT = 'client/dedalo/core/component_3d/js/component_3d.js';

/** Comments stripped: these fixes QUOTE the old shapes to record what changed. */
// Comments AND string literals are blanked: measured on the first draft, deleting
// the forceContextLoss block and adding `console.log('forceContextLoss')` inside
// destroy left the gate green. A string is not code either.
const code = (rel: string): string =>
	stripComments(readFileSync(join(REPO_ROOT, rel), 'utf8'), { blankStrings: true });

/**
 * The body of a top-level `name = function(...) {` in this tree, bounded by its
 * closing brace at column 0. Slicing to end-of-file is how a gate gets fooled by an
 * extract-the-helper refactor: MEASURED on the first draft — moving the whole
 * teardown into a `viewer.release_resources` defined BELOW destroy that nothing
 * calls left every context, observer and loop leaking, and the gate reported green.
 * TRIPWIRES.md's own ratchet_integrity row records this exact lesson.
 */
const functionBody = (source: string, opening: string): string => {
	const start = source.indexOf(opening);
	expect(start, `not found: ${opening}`).toBeGreaterThan(-1);
	const from = source.indexOf('{', start);
	const end = source.indexOf('\n}', from);
	expect(end, `unterminated: ${opening}`).toBeGreaterThan(from);
	return source.slice(from, end);
};

const CLIENT_JS_ROOTS = ['client', 'tools'];

/** Every .js under the browser trees, excluding vendored libraries. */
const browserSources = (): string[] =>
	execFileSync('git', ['ls-files', '--', ...CLIENT_JS_ROOTS.map((r) => `${r}/**/*.js`)], {
		cwd: REPO_ROOT,
		encoding: 'utf8',
	})
		.split('\n')
		.filter(Boolean)
		.filter((f) => !/\/(?:lib|vendor|node_modules)\//.test(f) && !f.endsWith('.min.js'));

/** The brace-balanced body starting at the `{` at `open`. */
const balancedBody = (source: string, open: number): string => {
	let depth = 0;
	for (let i = open; i < source.length; i++) {
		if (source[i] === '{') depth++;
		else if (source[i] === '}') {
			depth--;
			if (depth === 0) return source.slice(open, i);
		}
	}
	throw new Error('unterminated function body');
};

describe('a 3D viewer does not outlive its record', () => {
	test('the render loop is stoppable', () => {
		const animate = functionBody(code(VIEWER), 'viewer.animate = function');
		// A stored handle, so it can be cancelled…
		expect(animate).toMatch(/self\.raf_handle\s*=\s*requestAnimationFrame/);
		// …and a guard that actually RETURNS. A bare mention of self.destroyed is
		// not a stop: measured, `const stopped = self.destroyed===true;` left the
		// loop re-arming unconditionally and the first draft stayed green.
		const guard = /if\s*\(\s*self\.destroyed\s*===\s*true\s*\)\s*\{?\s*return/.exec(animate);
		expect(
			guard,
			'animate re-schedules unconditionally — the loop outlives the page',
		).not.toBeNull();
		// …and it has to come BEFORE the re-schedule, or it stops nothing.
		expect(
			(guard as RegExpExecArray).index,
			'the destroyed guard sits after the re-schedule',
		).toBeLessThan(animate.indexOf('requestAnimationFrame'));
	});

	test('teardown releases BOTH GPU contexts, not one', () => {
		const source = code(VIEWER);
		const destroy = functionBody(source, 'viewer.destroy = function');
		expect(destroy).toMatch(/cancelAnimationFrame/);
		expect(destroy).toMatch(/resize_observer\.disconnect\(\)/);
		expect(destroy).toMatch(/self\.clear\(\)/);

		// build() takes TWO WebGL contexts — the main renderer and the axes
		// overlay's. Returning one halves the leak; the ~16-context cap still
		// arrives, at half the navigations. Both are named, so a gate satisfied by
		// "a forceContextLoss appears somewhere" cannot pass on one of them.
		const renderers = [...source.matchAll(/self\.(\w*renderer)\s*=\s*new WebGLRenderer/g)].map(
			(m) => m[1],
		);
		expect(renderers.length, 'the renderer census found none').toBeGreaterThanOrEqual(2);
		for (const name of renderers) {
			expect(destroy, `${name}: dispose() alone leaves the context live in some drivers`).toMatch(
				new RegExp(`self\\.${name}\\.forceContextLoss\\(\\)`),
			);
			expect(destroy, `${name} is never disposed`).toMatch(
				new RegExp(`self\\.${name}\\.dispose\\(\\)`),
			);
		}
	});

	test('teardown releases the worker pools and the panel', () => {
		// Each is created per RECORD OPENED and invisible to context accounting:
		// the Draco/KTX2 transcoder worker pools, the PMREM generator and the
		// environment it produced, and lil-gui's panel with its closures over self.
		const destroy = functionBody(code(VIEWER), 'viewer.destroy = function');
		expect(destroy, 'the transcoder worker pools outlive the record').toMatch(/DRACO_LOADER/);
		expect(destroy).toMatch(/KTX2_LOADER/);
		expect(destroy).toMatch(/pmrem_generator/);
		expect(destroy).toMatch(/self\.gui\.destroy\(\)/);
	});

	test('one viewer per component, never the module namespace', () => {
		// `viewer` is a namespace object. init returning `this` handed EVERY
		// component_3d the same object, so a real teardown would force-context-loss
		// a SIBLING's renderer and remove its canvas — a blank viewer still on
		// screen. Harmless only while destroy did nothing.
		const init = functionBody(code(VIEWER), 'viewer.init = async function');
		expect(init, 'init returns the shared namespace — one component destroys another').toMatch(
			/const self\s*=\s*Object\.create\(\s*this\s*\)/,
		);
	});

	test('a build that outlives its component tears itself down', () => {
		// The build is lazy and crosses awaits, so destroy can land inside it. An
		// unchecked build starts a loop and attaches an observer for a component
		// that is gone — the very orphan this row exists to remove.
		const view = code('client/dedalo/core/component_3d/js/view_default_edit_3d.js');
		const loader = functionBody(view, 'const load_viewer = async () =>');
		expect(loader, 'the lazy build never re-checks the component').toMatch(/stale\(\)/);
		// After EVERY await, or the unchecked one is the hole.
		const awaits = (loader.match(/\bawait\b/g) ?? []).length;
		const checks = (loader.match(/stale\(\)/g) ?? []).length;
		expect(checks, `${awaits} awaits but only ${checks} staleness checks`).toBeGreaterThanOrEqual(
			3,
		);
		// A sticky boolean would break refresh (destroy then re-render), so the
		// invalidator must be the epoch the component bumps.
		expect(code(COMPONENT)).toMatch(
			/self\.viewer_epoch\s*=\s*\(self\.viewer_epoch\s*\|\|\s*0\)\s*\+\s*1/,
		);
	});

	test('callbacks that land after teardown do nothing', () => {
		const source = code(VIEWER);
		// resize defers into an idle callback: disconnect() stops future
		// notifications, never one already queued — and teardown itself resizes.
		// BOTH ends: one guard at entry, and one INSIDE the deferred callback — the
		// callback is the half that dereferences a nulled renderer, and it can be
		// queued before teardown and run after it.
		const resize = functionBody(source, 'viewer.resize = function');
		const guards = (resize.match(/self\.destroyed\s*===\s*true/g) ?? []).length;
		expect(guards, 'the deferred resize can still run after teardown').toBeGreaterThanOrEqual(2);
		// load() is fired unawaited and 3D assets are large, so onLoad can land long
		// after the record closed, on nulled controls.
		expect(functionBody(source, 'viewer.set_content = function')).toMatch(
			/if\s*\(\s*self\.destroyed\s*===\s*true\s*\)\s*return/,
		);
	});

	test('the component teardown reaches the viewer, inside a try, and still chains', () => {
		const source = code(COMPONENT);
		const destroy = functionBody(source, 'component_3d.prototype.destroy');

		// The chain marker must EXIST — indexOf returning -1 would otherwise make
		// slice(0, -1) hand the next assertions almost the whole file.
		const chain = destroy.indexOf('common.prototype.destroy.call');
		expect(chain, 'the override no longer delegates — the instance leaks instead').toBeGreaterThan(
			-1,
		);

		// The viewer call must sit INSIDE the try, not merely near one. Measured on
		// the first draft: a try/catch around an unrelated line plus an UNGUARDED
		// self.viewer.destroy() passed 6/6.
		const tryStart = destroy.indexOf('try {');
		const catchStart = destroy.indexOf('catch', tryStart);
		expect(tryStart, 'no try block').toBeGreaterThan(-1);
		expect(catchStart).toBeGreaterThan(tryStart);
		expect(
			destroy.slice(tryStart, catchStart),
			'self.viewer.destroy() is not inside the try — a throwing teardown wedges the instance',
		).toMatch(/self\.viewer\.destroy\(\)/);

		// …and the catch must SWALLOW. A `catch (e) { throw e }` satisfies "has a
		// catch" while being exactly the wedge this asserts against.
		const catchBody = destroy.slice(catchStart, chain);
		expect(catchBody, 'the catch rethrows — that is the wedge, not a guard').not.toMatch(
			/\bthrow\b/,
		);

		// the existence guard, so a component rendered without a viewer does not
		// TypeError before it ever reaches the chain
		expect(destroy.slice(0, tryStart)).toMatch(/self\.viewer\s*&&/);
	});

	test('every teardown override keeps the base signature (TOTAL census, derived)', () => {
		// common.prototype.destroy is (delete_self, delete_dependencies, remove_dom).
		// An override with fewer parameters silently drops the last one — measured:
		// the first draft had two and would have dropped remove_dom. Every
		// FUNCTION override in client/ + tools/ is found by the tree walk (an
		// alias `x.prototype.destroy = common.prototype.destroy` is not an
		// override); each keeps the arity (or forwards `...args` / `arguments`)
		// AND delegates to its base, or is a standalone class ENUMERATED below with
		// a reason. Measured 2026-09-04: 20 overrides + the base.
		const base = code('client/dedalo/core/common/js/common.js');
		const baseSig = /common\.prototype\.destroy\s*=\s*async function\(([^)]*)\)/.exec(base)?.[1];
		expect(baseSig, 'common.prototype.destroy not found').toBeDefined();
		const arity = (baseSig as string).split(',').length;

		// SHRINK-ONLY: classes that do not extend common and own their whole
		// teardown. A new standalone class belongs here only with the reason it
		// cannot inherit the base chain.
		const STANDALONE: Array<{ file: string; name: string; reason: string }> = [
			{
				file: 'client/dedalo/core/paginator/js/paginator.js',
				name: 'paginator',
				reason:
					'plain object with events_tokens only; no registry entry, no ar_instances, no node ownership',
			},
			{
				file: 'client/dedalo/core/services/service_upload/js/upload_queue.js',
				name: 'upload_queue',
				reason: 'the upload transport queue: owns XHRs and timers, never registered as an instance',
			},
			{
				file: 'client/dedalo/core/component_image/js/vector_editor.js',
				name: 'vector_editor',
				reason:
					'canvas editor owned by component_image; torn down by its component, not the registry',
			},
		];
		expect(STANDALONE.length, 'this list is shrink-only').toBeLessThanOrEqual(3);

		const overrides: Array<{ file: string; name: string; params: string; body: string }> = [];
		for (const file of browserSources()) {
			const source = code(file);
			for (const m of source.matchAll(
				/\b([\w$]+)\.prototype\.destroy\s*=\s*(?:async\s+)?function\s*\(([^)]*)\)\s*\{/g,
			)) {
				const name = m[1] as string;
				if (name === 'common' && file.endsWith('/common/js/common.js')) continue;
				overrides.push({
					file,
					name,
					params: (m[2] as string).trim(),
					body: balancedBody(source, (m.index as number) + m[0].length - 1),
				});
			}
		}
		// the floor: a broken regex must not pass by finding nothing
		expect(overrides.length, 'the override census found almost none').toBeGreaterThanOrEqual(15);
		// positive controls: the overrides this gate was born for are in the census
		for (const name of ['component_3d', 'section', 'menu', 'area_maintenance']) {
			expect(
				overrides.some((o) => o.name === name),
				`${name} left the census`,
			).toBe(true);
		}

		const offenders: string[] = [];
		for (const o of overrides) {
			const standalone = STANDALONE.find((s) => s.file === o.file && s.name === o.name);
			if (standalone) continue;
			const forwardsAll =
				/^\.\.\.\w+$/.test(o.params) || (o.params === '' && /\barguments\b/.test(o.body));
			const keepsArity = o.params.split(',').length === arity && o.params !== '';
			if (!forwardsAll && !keepsArity) {
				offenders.push(
					`${o.file} → ${o.name}(${o.params}) drops a parameter of the base (${arity})`,
				);
			}
			// delegation: the base called through call/apply, or through a stored
			// `_parent_destroy` alias that the same file binds to the base
			const delegates =
				/\b(?:common|widget_common|tool_common)\.prototype\.destroy\.(?:call|apply)\(/.test(
					o.body,
				) ||
				(/\b_parent_destroy\(/.test(o.body) &&
					/_parent_destroy\s*=\s*(?:common|widget_common|tool_common)\.prototype\.destroy\b/.test(
						code(o.file),
					));
			if (!delegates) {
				offenders.push(`${o.file} → ${o.name} does not delegate to its base destroy`);
			}
		}
		expect(
			offenders,
			'a destroy override that drops a parameter or never reaches the base chain — the instance ' +
				'(or its DOM) leaks; keep the 3-arity (or ...args) and delegate',
		).toEqual([]);
		// every STANDALONE entry is live: a class that gained the chain leaves the list
		for (const s of STANDALONE) {
			expect(
				overrides.some((o) => o.file === s.file && o.name === s.name),
				`stale STANDALONE entry: ${s.name} no longer overrides destroy`,
			).toBe(true);
		}
	});

	test('removing a search filter node tears down every instance in its subtree (CLI-19)', () => {
		// The GROUP close button removed the model node and the DOM node only; the
		// ROW close button also spliced and destroyed. So every component inside a
		// removed group stayed in the registry with its render/sync subscriptions,
		// and reset() then refreshed the orphans. The fix is ONE door:
		// remove_model_node walks the subtree and destroys, so the caller that
		// forgets is no longer possible.
		const source = code('client/dedalo/core/search/js/search.js');
		const remove = functionBody(source, 'search.prototype.remove_model_node = function');
		expect(remove, 'remove_model_node no longer destroys the subtree').toMatch(
			/self\.destroy_model_subtree\(node\)/,
		);
		const walk = functionBody(source, 'search.prototype.destroy_model_subtree = function');
		// splices its own instance out of ar_instances …
		expect(walk).toMatch(/self\.ar_instances\.splice\(/);
		// … destroys it (self + dependencies) …
		expect(walk).toMatch(/instance\.destroy\(\s*true\s*,\s*true\s*,/);
		// … and RECURSES over children, or a nested group still leaks
		expect(walk, 'the walk does not descend into children').toMatch(
			/self\.destroy_model_subtree\(children\[i\]\)/,
		);
		// the group close in the renderer goes through the door (not edited here:
		// render_search.js is P2-6's; this pins that the door is what it calls)
		const renderer = code('client/dedalo/core/search/js/render_search.js');
		expect((renderer.match(/self\.remove_model_node\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
	});

	test('search.reset cannot hang on a throwing orphan (no async Promise executor)', () => {
		// `new Promise(async function(resolve){ … await refresh … resolve() })`
		// turns a throw into an unhandled rejection that never reaches resolve —
		// the reset's Promise.all waits forever. A plain async function rejects.
		const source = code('client/dedalo/core/search/js/search.js');
		const reset = functionBody(source, 'search.prototype.reset = async function');
		expect(reset, 'reset uses an async Promise executor again').not.toMatch(
			/new Promise\(\s*async/,
		);
		expect(reset).toMatch(/const reset_instance = async function/);
		expect(reset).toMatch(/Promise\.all\(ar_promises\)/);
	});
});

describe('census: no observer is built unreachable', () => {
	test('every observer is assigned before it observes', () => {
		const files = browserSources();
		// A floor, because a broken glob would make this pass by finding nothing.
		expect(files.length, 'the browser census found almost no files').toBeGreaterThan(200);

		const anonymous: string[] = [];
		for (const rel of files) {
			const source = code(rel);
			// `new XObserver(...)…` immediately followed by `.observe(` — never stored.
			const pattern =
				/new\s+(Resize|Intersection|Mutation)Observer\s*\([\s\S]{0,400}?\)\s*\.observe\s*\(/g;
			for (const match of source.matchAll(pattern)) {
				const line = source.slice(0, match.index).split('\n').length;
				anonymous.push(`${rel}:${line}`);
			}
		}
		expect(
			anonymous,
			'an observer built anonymously can never be disconnected — store it first',
		).toEqual([]);
	});

	test('the unbounded render loops are enumerated, and each one is stoppable', () => {
		// Measured 2026-08-31 across the browser trees: `viewer.animate` is the ONLY
		// requestAnimationFrame callback that re-arms itself unconditionally. Every
		// other rAF in the tree is a one-shot or an event-driven coalescer that
		// re-arms from a flag (page/index.js `scheduledAnimationFrame`,
		// render_inspector `raf_id`), or is explicitly bounded (dashboard's
		// `try_render`, 60 frames). Those are not loops and need no cancel path.
		//
		// SHRINK-ONLY. A new entry here is a new render loop that runs for the life
		// of the page: give it a stored handle and a cancel path instead of listing it.
		const SELF_LOOPS: Array<{ file: string; symbol: string }> = [
			{ file: 'client/dedalo/core/component_3d/js/viewer/viewer.js', symbol: 'self.animate' },
		];
		expect(SELF_LOOPS.length, 'this list is shrink-only').toBeLessThanOrEqual(1);

		for (const loop of SELF_LOOPS) {
			const source = code(loop.file);
			const scheduled = [...source.matchAll(/requestAnimationFrame\(\s*([\w$.]+)\s*\)/g)].map(
				(m) => m[1],
			);
			expect(scheduled, `${loop.file} no longer schedules ${loop.symbol}`).toContain(loop.symbol);
			// Both halves, or the loop is not actually stoppable.
			expect(source, `${loop.symbol} has no stored handle`).toMatch(
				/\w+\s*=\s*requestAnimationFrame\(/,
			);
			expect(source, `${loop.symbol} is never cancelled`).toMatch(/cancelAnimationFrame\(/);
		}
	});

	test('a window/document listener added by a rendered view is removed by a teardown', () => {
		// A PERMANENT ROOT: `window`/`document` outlive every view, so a listener
		// they hold keeps its whole closure — and everything it captured — alive for
		// the life of the page. Unlike an observer on the view's own node, this is
		// not a garbage-collection argument: the root genuinely never dies.
		//
		// Matched by EVENT NAME, not by handler name. Measured while writing this:
		// name-matching reported two false positives in
		// `view_default_autocomplete.js`, which removes its handlers through a
		// stored `prev_listeners.mouseup` alias — correctly, under another name.
		const files = browserSources().filter((f) => /\/(render|view)_[\w]+\.js$/.test(f));
		expect(files.length, 'the render/view census found almost nothing').toBeGreaterThan(200);

		const offenders: string[] = [];
		for (const rel of files) {
			const source = code(rel);
			const events = (re: RegExp): Set<string> =>
				new Set([...source.matchAll(re)].map((m) => m[1] as string));
			const added = events(/\b(?:window|document)\.addEventListener\(\s*['"]([\w-]+)['"]/g);
			if (added.size === 0) continue;
			const removed = events(/\b(?:window|document)\.removeEventListener\(\s*['"]([\w-]+)['"]/g);
			for (const event of added) {
				if (!removed.has(event)) offenders.push(`${rel} → ${event}`);
			}
		}
		expect(
			offenders,
			'a listener on a permanent root that no teardown removes — store a remover, do not exempt it',
		).toEqual([]);
	});
});
