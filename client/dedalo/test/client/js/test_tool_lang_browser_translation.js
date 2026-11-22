// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global it, describe, assert, beforeEach, afterEach */
/*eslint no-undef: "error"*/

/**
 * TEST_TOOL_LANG_BROWSER_TRANSLATION
 * Audit row A1-02 (port of v6 d3991c3a66 / 2cd51f17c7 / 55c816b41c / 92da452aa1):
 * tool_lang's browser translation never loses, invents or misplaces a Dédalo mark
 * silently, never writes model-made markup, and never saves a run the operator stopped.
 *
 * Before the fix, the marks of the source value (index / tc / svg … — shielded from the
 * model as placeholder tokens) were put back with a plain replaceAll: a token the model
 * lost made its mark VANISH from the target language, an inverted open/close pair was
 * saved inverted, and both runs reported 'Translation completed'. Ported from v6
 * (repair_placeholders, reorder_inverted_pairs, segmentation + hoisting + the repetition
 * guard), with the TS refusal rule of audit row A1-02: a mark that still cannot be
 * accounted for REFUSES the run (nothing saved); positions we chose are saved WITH A
 * WARNING (owner ruling Q2, 2026-11-22: no accept/discard step).
 *
 * What runs for real: browser_translation.js (the orchestrator: marks + tag shields →
 * tokens → Markdown → 250-char segments → blocks (hoisted, locally renumbered) → … →
 * restore → reorder → validate → save), tr.js (the mark patterns), markdown_utils.js
 * (DOMParser) and block_runner.js (the worker's block loop: normalise, repetition
 * escalation, repair_placeholders, duplicate/invented removal). What is stood in: the
 * MODEL (a deterministic `translate` function per case) and the Worker object that would
 * host block_runner.js — FakeWorker calls the real run_blocks() with that function. Cases
 * that need the worker to have answered something run_blocks never produces (an
 * unplaceable mark, a mark lost after the repair) script the worker's messages instead.
 *
 * What the model sees for SOURCE: the tc mark opens the segment, so it is HOISTED (never
 * sent); the index pair is renumbered locally — 'The [[[1]]]white whale[[[2]]] swims. It
 * dives deep.' — and mapped back to the document-wide tokens [[[2]]] / [[[3]]].
 *
 * No database, no record: the target component is a stand-in that records what it was
 * asked to save (save()'s answer is a v2 success envelope).
 */

import { run_blocks } from '../../../tools/tool_lang/js/block_runner.js';
import {
	cancel_browser_translation,
	dispose_browser_worker,
	extract_dedalo_marks,
	mark_report_lines,
	translate_component_browser,
	validate_translation,
} from '../../../tools/tool_lang/js/browser_translation.js';
import { marks_in_text_nodes } from '../../../tools/tool_lang/js/markdown_utils.js';
import { translation_summary } from '../../../tools/tool_lang_multi/js/tool_lang_multi.js';
import { get_tool_label } from '../../../core/tools_common/js/tool_common.js';

// the record's marks, in the exact syntax tr.js matches
const TC = '[TC_00:00:01.000_TC]';
const INDEX_IN = '[index-n-1-whale-data::data]';
const INDEX_OUT = '[/index-n-1-whale-data::data]';

/** An index pair with its own id (index-n-<id>). */
const index_pair = (id) => ({
	open: `[index-n-${id}-term${id}-data::data]`,
	close: `[/index-n-${id}-term${id}-data::data]`,
});

// the source value and what a faithful translation of it must be saved as
const SOURCE = `<p>${TC}The ${INDEX_IN}white whale${INDEX_OUT} swims. It dives deep.</p>`;
const TRANSLATED = `<p>${TC}La ${INDEX_IN}ballena blanca${INDEX_OUT} nada. Se sumerge hondo.</p>`;

// the target language's existing (human) text, which a refused run must leave alone
const STORED = '<p>Texto humano existente.</p>';

// the model's faithful answer for the one block SOURCE becomes (tc hoisted, the index
// pair renumbered locally)
const MODEL_CLEAN = 'La [[[1]]]ballena blanca[[[2]]] nada. Se sumerge hondo.';

// a looping answer: ≥ 50 chars, a 2-word cycle (block_runner.js detect_repetition)
const LOOP = 'una vez una vez una vez una vez una vez una vez una vez una vez';

const JSON_LANGS = [
	{ dd_lang: 'lg-eng', locale: 'en-US' },
	{ dd_lang: 'lg-spa', locale: 'es-ES' },
];

/** The last FakeWorker constructed, and how many were (a refusal before the run makes none). */
let last_worker = null;
let workers_constructed = 0;

/**
 * FAKEWORKER
 * Stands in for the Worker that hosts block_runner.js. `behaviour.translate` → the REAL
 * run_blocks with that model function (a {cancel:true} message stops it, as in the real
 * worker, unless `behaviour.ignore_cancel`); `behaviour.messages` → those messages,
 * verbatim. Messages are structured-cloned, as postMessage does.
 */
const make_fake_worker = (behaviour) =>
	class FakeWorker {
		constructor() {
			this.onmessage = null;
			this.onerror = null;
			this.posted = [];
			this.cancelled = false;
			last_worker = this;
			workers_constructed++;
		}
		postMessage(message) {
			this.posted.push(message);
			if (message?.cancel) {
				this.cancelled = true;
				return;
			}
			const deliver = (msg) => {
				if (typeof this.onmessage === 'function') {
					this.onmessage({ data: structuredClone(msg) });
				}
			};
			setTimeout(() => {
				if (behaviour.messages) {
					for (const msg of behaviour.messages) {
						deliver(msg);
					}
					return;
				}
				run_blocks({
					blocks: message.options.blocks,
					translate: behaviour.translate,
					post: deliver,
					is_cancelled: () => this.cancelled && !behaviour.ignore_cancel,
				});
			}, 0);
		}
		terminate() {}
	}; //end make_fake_worker

/**
 * RUN_TRANSLATION
 * Drive translate_component_browser once and report what it did.
 * @param {Object} [options]
 * @param {string} [options.source=SOURCE] - the source value
 * @param {Object} [options.target_data] - the target's data (default: STORED in value + entries)
 * @param {Function} [options.get_label] - default: the null resolver (literal fallbacks fire)
 * @return {Promise<{saves, target, status_text, overlay, resolved, rejected}>}
 */
const run_translation = async (options = {}) => {
	const saves = [];
	const target_component = {
		data: options.target_data ?? { value: [STORED], entries: [{ id: 7, value: STORED }] },
		context: { render_class: 'html' },
		save: (items) => {
			saves.push(structuredClone(items));
			return Promise.resolve({ ok: true, data: {} });
		},
		refresh: () => Promise.resolve(true),
	};
	const status_container = document.createElement('div');
	const overlay = document.createElement('div');
	overlay.classList.add('hide');
	const overlay_content = document.createElement('div');

	let resolved = null;
	let rejected = null;
	await translate_component_browser({
		source_component: { data: { entries: [{ id: 7, value: options.source ?? SOURCE }] } },
		target_component: target_component,
		source_lang: 'lg-eng',
		target_lang: 'lg-spa',
		status_container: status_container,
		streaming_overlay: overlay,
		streaming_overlay_content: overlay_content,
		json_langs: JSON_LANGS,
		// the real resolver answers null for a label this harness has no context for,
		// which is what makes the driver's English literals fire
		get_label: options.get_label ?? (() => null),
	}).then(
		(value) => {
			resolved = value;
		},
		(error) => {
			rejected = error;
		},
	);

	return {
		saves,
		target: target_component,
		status_text: status_container.textContent,
		overlay,
		resolved,
		rejected,
	};
}; //end run_translation

/**
 * SAVED_VALUE
 * The value the run asked the target component to store (one save, one item).
 */
const saved_value = (saves) => {
	assert.equal(saves.length, 1, 'expected exactly one save');
	assert.equal(saves[0].length, 1, 'expected one save item');
	return saves[0][0].value.value;
}; //end saved_value

/**
 * REFUSAL_PROBLEMS
 * What is wrong with `run` as a REFUSED run — nothing saved, the promise rejected, the
 * target's own data back, the reason shown — as a list (empty = a proper refusal), so the
 * case asserts it in one line: assert.deepEqual(refusal_problems(run, …), []).
 * @param {Object} run - run_translation() result
 * @param {...string} expected_lines - text the status must show
 * @return {string[]}
 */
const refusal_problems = (run, ...expected_lines) => {
	const problems = [];
	if (run.saves.length !== 0) problems.push('a refused run must never save');
	if (run.resolved !== null) problems.push('the run must REJECT — both callers count a resolve as success');
	if (!(run.rejected instanceof Error)) problems.push('the rejection must be an Error');
	if (JSON.stringify(run.target.data.value) !== JSON.stringify([STORED])) {
		problems.push('the streamed preview must be taken back out (value)');
	}
	if (JSON.stringify(run.target.data.entries) !== JSON.stringify([{ id: 7, value: STORED }])) {
		problems.push('the streamed preview must be taken back out (entries)');
	}
	for (const line of ['Nothing was saved', ...expected_lines]) {
		if (!run.status_text.includes(line)) problems.push(`status lacks: ${line} — got: ${run.status_text}`);
	}
	if (run.status_text.includes('Translation completed')) problems.push('a refusal never says completed');
	return problems;
}; //end refusal_problems

describe('TOOL_LANG BROWSER TRANSLATION — every Dédalo mark accounted for (A1-02)', function () {
	this.timeout(10000);

	let real_worker = null;
	beforeEach(() => {
		real_worker = window.Worker;
		last_worker = null;
		workers_constructed = 0;
		// the worker is a module-level singleton (it caches the model): drop it so the
		// next run constructs the fake installed by the case
		dispose_browser_worker();
	});
	afterEach(() => {
		window.Worker = real_worker;
		dispose_browser_worker();
	});

	// --- saved: clean, or with positions we chose (reported) ---

	it('a clean translation is saved exactly, reported as completed', async () => {
		const sent = [];
		window.Worker = make_fake_worker({
			translate: async (text) => {
				sent.push(text);
				return MODEL_CLEAN;
			},
		});

		const run = await run_translation();

		assert.isNull(run.rejected, 'a clean run must not be refused');
		assert.deepEqual(run.resolved, { result: true, msg: 'OK. Translation completed', warnings: null });
		assert.equal(saved_value(run.saves), TRANSLATED, 'the marks must sit where the model put them');
		assert.include(run.status_text, 'Translation completed');
		// the tc mark at the segment edge never reached the model; the pair is local
		assert.deepEqual(sent, ['The [[[1]]]white whale[[[2]]] swims. It dives deep.']);
	});

	it('tokens the model merely mangled are normalised — saved clean, no warning', async () => {
		window.Worker = make_fake_worker({
			translate: async () => 'La [[ 1 ]]ballena blanca\\[\\[\\[2\\]\\]\\] nada. Se sumerge hondo.',
		});

		const run = await run_translation();

		assert.isNull(run.rejected);
		assert.equal(saved_value(run.saves), TRANSLATED);
		assert.include(run.status_text, 'Translation completed');
	});

	it('a mark the model LOST is repaired back into place, saved, and reported', async () => {
		// the model drops the index close
		window.Worker = make_fake_worker({
			translate: async () => 'La [[[1]]]ballena blanca nada. Se sumerge hondo.',
		});

		const run = await run_translation();

		assert.isNull(run.rejected, 'a repaired mark is not a reason to refuse');
		assert.equal(run.resolved.result, true);
		assert.equal(run.resolved.msg, 'OK. Translation saved with warnings');
		assert.deepEqual(run.resolved.warnings.repaired, ['[[[3]]]'], 'named in document-wide numbering');
		// before the fix the index close was simply gone from the saved value
		assert.equal(saved_value(run.saves), TRANSLATED, 'the close spans as many words as in the source');
		assert.include(run.status_text, 'Translation saved — check the marks');
		assert.include(run.status_text, '1 of 3 marks were repositioned automatically');
		assert.notInclude(run.status_text, 'Translation completed', 'a repair is never a clean completion');
	});

	it('the REAL tool label resolver forwards the counts into %s (get_tool_label → printf)', async () => {
		window.Worker = make_fake_worker({
			translate: async () => 'La [[[1]]]ballena blanca nada. Se sumerge hondo.',
		});
		const tool = {
			context: {
				labels: [
					{ lang: 'lg-spa', name: 'translation_saved_with_warnings', value: 'Traducción guardada: revise las marcas' },
					{ lang: 'lg-spa', name: 'marks_repositioned', value: '%s de %s marcas se recolocaron automáticamente' },
				],
			},
		};

		const run = await run_translation({ get_label: (key, ...args) => get_tool_label.call(tool, key, ...args) });

		assert.isNull(run.rejected);
		assert.include(run.status_text, 'Traducción guardada: revise las marcas');
		assert.include(run.status_text, '1 de 3 marcas se recolocaron automáticamente');
	});

	it('an INVERTED open/close pair is put back in order, saved, and reported', async () => {
		// word order moved: the model emitted the close before the open
		window.Worker = make_fake_worker({
			translate: async () => 'La [[[2]]]ballena blanca[[[1]]] nada. Se sumerge hondo.',
		});

		const run = await run_translation();

		assert.isNull(run.rejected);
		const value = saved_value(run.saves);
		// before the fix '[/index…]ballena blanca[index…]' was saved as is
		assert.isBelow(value.indexOf(INDEX_IN), value.indexOf(INDEX_OUT), 'open before close');
		assert.equal(value, TRANSLATED);
		assert.include(run.status_text, '1 linked marks were reversed by the translation and reordered');
		assert.equal(run.resolved.msg, 'OK. Translation saved with warnings');
	});

	it('NESTED and MULTIPLE inverted pairs are each put back in order and counted', async () => {
		const a = index_pair(1);
		const b = index_pair(2);
		const c = index_pair(3);
		const source = `<p>The ${a.open}big ${b.open}white${b.close} whale${a.close} swims and the ${c.open}sea${c.close} is grey.</p>`;
		// local order: a.open 1, b.open 2, b.close 3, a.close 4, c.open 5, c.close 6;
		// the model reversed the outer pair a and the pair c
		window.Worker = make_fake_worker({
			translate: async () => 'La [[[4]]]gran [[[2]]]blanca[[[3]]] ballena[[[1]]] nada y el [[[6]]]mar[[[5]]] es gris.',
		});

		const run = await run_translation({ source });

		assert.isNull(run.rejected);
		assert.equal(
			saved_value(run.saves),
			`<p>La ${a.open}gran ${b.open}blanca${b.close} ballena${a.close} nada y el ${c.open}mar${c.close} es gris.</p>`,
		);
		assert.include(run.status_text, '2 linked marks were reversed by the translation and reordered');
	});

	it('a shielded tag (span / sup) round-trips byte-identical; the model never sees markup', async () => {
		const source = '<p>The <span style="color:red" data-x="1">white</span> whale<sup>2</sup> swims.</p>';
		const sent = [];
		window.Worker = make_fake_worker({
			translate: async (text) => {
				sent.push(text);
				return text
					.replace('The', 'La')
					.replace('white', 'blanca')
					.replace('whale', 'ballena')
					.replace('swims', 'nada');
			},
		});

		const run = await run_translation({ source });

		assert.isNull(run.rejected);
		assert.equal(
			saved_value(run.saves),
			'<p>La <span style="color:red" data-x="1">blanca</span> ballena<sup>2</sup> nada.</p>',
		);
		assert.notMatch(sent.join(' '), /<|>|style/, 'no markup reaches the model');
	});

	it('a shielded tag pair the model REVERSED is put back in order and reported', async () => {
		const source = '<p>The <span style="color:red">white</span> whale swims.</p>';
		window.Worker = make_fake_worker({
			translate: async () => 'La ballena [[[2]]]blanca[[[1]]] nada.',
		});

		const run = await run_translation({ source });

		assert.isNull(run.rejected);
		assert.equal(saved_value(run.saves), '<p>La ballena <span style="color:red">blanca</span> nada.</p>');
		assert.include(run.status_text, '1 linked marks were reversed by the translation and reordered');
	});

	it('model text is ESCAPED: a translated <script> / <img onerror> is stored as text, never as markup', async () => {
		window.Worker = make_fake_worker({
			translate: async () =>
				'La [[[1]]]ballena<script>x()</script>[[[2]]] nada. <img onerror=y>',
		});

		const run = await run_translation();

		assert.isNull(run.rejected, run.status_text);
		const value = saved_value(run.saves);
		assert.notInclude(value, '<script');
		assert.notInclude(value, '<img');
		assert.include(value, '&lt;script&gt;x()&lt;/script&gt;');
		assert.include(value, '&lt;img onerror=y&gt;');
	});

	// --- many blocks: document-wide numbering ---

	it('a MULTI-BLOCK value (> 1000 chars): local block tokens map back to their own document-wide marks', async () => {
		const paragraphs = [];
		for (let i = 1; i <= 8; i++) {
			const pair = index_pair(i);
			paragraphs.push(
				`<p>[TC_00:00:0${i}.000_TC]Paragraph ${i} tells of the ${pair.open}white whale ${i}${pair.close} that swims across the wide grey sea, far from any shore or harbour we know.</p>`,
			);
		}
		const source = paragraphs.join('');
		assert.isAbove(source.length, 1000);
		window.Worker = make_fake_worker({ translate: async (text) => text.replace(/white whale/g, 'ballena blanca') });

		const run = await run_translation({ source });

		assert.isNull(run.rejected);
		assert.equal(saved_value(run.saves), source.replace(/white whale/g, 'ballena blanca'));
		const blocks = last_worker.posted[0].options.blocks;
		assert.isAbove(blocks.length, 1, 'more than one block');
		// a later block carries LOCAL [[[1]]] for a document-wide token other than [[[1]]]
		const remapped = blocks.filter((block) => block.restore_map['[[[1]]]'] && block.restore_map['[[[1]]]'] !== '[[[1]]]');
		assert.isAbove(remapped.length, 0, 'local ≠ global numbering is exercised');
	});

	it('a pair SPLIT across two blocks keeps both halves where they were', async () => {
		const pair = index_pair(4);
		const filler = 'and the long grey sea rolls on without end beneath a pale and quiet sky';
		const source =
			`<p>First paragraph, ${filler}, while the ${pair.open}white whale swims on, ${filler}.</p>` +
			`<p>Second paragraph, still under way${pair.close} it goes, ${filler}, ${filler}.</p>`;
		window.Worker = make_fake_worker({ translate: async (text) => text.replace(/paragraph/g, 'párrafo') });

		const run = await run_translation({ source });

		assert.isNull(run.rejected);
		const blocks = last_worker.posted[0].options.blocks;
		assert.isAbove(blocks.length, 1);
		assert.equal(saved_value(run.saves), source.replace(/paragraph/g, 'párrafo'));
	});

	// --- refused: nothing saved ---

	it('a token the model DUPLICATED REFUSES the run — no copy is kept at a guessed place', async () => {
		window.Worker = make_fake_worker({
			translate: async () => 'La [[[1]]]ballena blanca[[[2]]] nada.[[[1]]] Se sumerge hondo.',
		});

		const run = await run_translation();

		assert.deepEqual(refusal_problems(run, 'Translation needs review before saving', '1 marks could not be placed', '1 invalid markers were removed'), []);
	});

	it('a mark the worker could NOT place REFUSES the run: nothing saved, stored text intact, review-needed shown', async () => {
		// the worker appended the token it could not place and named it unrepairable
		window.Worker = make_fake_worker({
			messages: [
				{
					status: 'on_chunk',
					data: { remaining: 0, accumulated_text: 'La [[[2]]]ballena blanca[[[3]]] nada.[[[1]]]' },
				},
				{
					status: 'end',
					data: {
						remaining: 0,
						accumulated_text: 'La [[[2]]]ballena blanca[[[3]]] nada. Se sumerge hondo.[[[1]]]',
						repair_stats: { repaired: [], unrepairable: ['[[[1]]]'] },
					},
				},
			],
		});

		const run = await run_translation();

		assert.deepEqual(refusal_problems(run, 'Translation needs review before saving', '1 marks could not be placed'), []);
	});

	it('a refused run on a target that had NO value leaves it with none (the key is deleted, not emptied)', async () => {
		window.Worker = make_fake_worker({
			messages: [
				{ status: 'on_chunk', data: { remaining: 0, accumulated_text: 'La [[[2]]]ballena[[[3]]]' } },
				{
					status: 'end',
					data: {
						remaining: 0,
						accumulated_text: 'La [[[2]]]ballena blanca[[[3]]] nada.[[[1]]]',
						repair_stats: { repaired: [], unrepairable: ['[[[1]]]'] },
					},
				},
			],
		});

		const run = await run_translation({ target_data: {} });

		assert.deepEqual(run.saves, []);
		assert.instanceOf(run.rejected, Error);
		assert.isFalse(Object.hasOwn(run.target.data, 'value'), 'no value key, as before the run');
		assert.isFalse(Object.hasOwn(run.target.data, 'entries'));
	});

	it('a mark missing from the final text REFUSES the run even when the worker reported nothing', async () => {
		// the validation counts marks itself: it does not trust repair_stats alone
		window.Worker = make_fake_worker({
			messages: [
				{
					status: 'end',
					data: {
						remaining: 0,
						accumulated_text: '[[[1]]]La [[[2]]]ballena blanca nada. Se sumerge hondo.',
						repair_stats: { repaired: [], unrepairable: [] },
					},
				},
			],
		});

		const run = await run_translation();

		assert.deepEqual(refusal_problems(run, 'Translation needs review before saving', '1 marks could not be placed'), []);
	});

	it('a shielded TAG token that comes back twice REFUSES the run (the worker invariant broke)', async () => {
		// <span> open = [[[1]]], close = [[[2]]]; no Dédalo mark, so only the token count sees it
		window.Worker = make_fake_worker({
			messages: [
				{
					status: 'end',
					data: {
						remaining: 0,
						accumulated_text: 'La [[[1]]]ballena[[[2]]] [[[1]]]nada.',
						repair_stats: { repaired: [], unrepairable: [] },
					},
				},
			],
		});

		const run = await run_translation({ source: '<p>The <span style="color:red">whale</span> swims.</p>' });

		assert.deepEqual(refusal_problems(run, 'Translation needs review before saving', '1 invalid markers were removed'), []);
	});

	it('a mark the source does not have REFUSES the run', async () => {
		window.Worker = make_fake_worker({
			messages: [
				{
					status: 'end',
					data: {
						remaining: 0,
						accumulated_text: '[[[1]]]La [[[2]]]ballena blanca[[[3]]] nada. [TC_00:00:09.000_TC]Se sumerge hondo.',
						repair_stats: { repaired: [], unrepairable: [] },
					},
				},
			],
		});

		const run = await run_translation();

		assert.deepEqual(refusal_problems(run, '1 marks that are not in the source text appeared in the translation'), []);
	});

	it('a repetition LOOP that survives every escalation loses its block — the run is refused', async () => {
		const calls = [];
		window.Worker = make_fake_worker({
			translate: async (_text, overrides) => {
				calls.push(overrides);
				return LOOP;
			},
		});

		const run = await run_translation();

		assert.equal(calls.length, 3, 'the first attempt, then the two escalations');
		assert.deepEqual(refusal_problems(run, 'Translation refused: the model failed on part of the text (1/1)'), []);
	});

	it('a DEGENERATE result (far longer than its source) is refused even when every mark is present', async () => {
		window.Worker = make_fake_worker({
			messages: [
				{
					status: 'end',
					data: {
						remaining: 0,
						accumulated_text: `[[[1]]]La [[[2]]]ballena blanca[[[3]]] nada. ${'Y se sumerge hondo otra vez. '.repeat(12)}`,
						repair_stats: { repaired: [], unrepairable: [] },
					},
				},
			],
		});

		const run = await run_translation();

		assert.deepEqual(refusal_problems(run, 'The model repeated itself instead of translating.'), []);
	});

	it('source text that LOOKS like a token is refused before the model runs', async () => {
		window.Worker = make_fake_worker({ translate: async () => MODEL_CLEAN });

		const run = await run_translation({ source: `<p>${TC}See note [[[3]]] here.</p>` });

		assert.deepEqual(run.saves, []);
		assert.instanceOf(run.rejected, Error);
		assert.equal(workers_constructed, 0, 'no worker, no model call');
		assert.include(run.status_text, 'the text contains [[[n]]]-like sequences');
		assert.deepEqual(run.target.data.value, [STORED]);
	});

	it('brackets that only become a token around a SHIELDED tag are refused too', async () => {
		window.Worker = make_fake_worker({ translate: async () => MODEL_CLEAN });

		// the source check passes ('[[<sup>5</sup>]]' is no token); its Markdown,
		// '[[[[[1]]]5[[[2]]]]]', would read back as [[[5]]] once the model drops a token
		const run = await run_translation({ source: '<p>Note [[<sup>5</sup>]] here.</p>' });

		assert.deepEqual(run.saves, []);
		assert.instanceOf(run.rejected, Error);
		assert.equal(workers_constructed, 0);
		assert.include(run.status_text, 'the text contains [[[n]]]-like sequences');
	});

	// --- cancellation, worker failures ---

	it('a cancel that arrives during the LAST block ends the run cancelled: nothing saved, value back', async () => {
		window.Worker = make_fake_worker({
			translate: async () => {
				cancel_browser_translation();
				return MODEL_CLEAN;
			},
		});

		const run = await run_translation();

		assert.deepEqual(run.saves, [], 'a stopped run never saves');
		assert.deepEqual(run.resolved, { result: false, msg: 'Translation cancelled' });
		assert.deepEqual(run.target.data.value, [STORED]);
		assert.include(run.status_text, 'Translation cancelled');
	});

	it('an END already in flight when the operator cancelled is NOT saved (main-thread guard)', async () => {
		// a worker that does not see the cancel in time and posts 'end' anyway
		window.Worker = make_fake_worker({
			ignore_cancel: true,
			translate: async () => {
				cancel_browser_translation();
				return MODEL_CLEAN;
			},
		});

		const run = await run_translation();

		assert.deepEqual(run.saves, []);
		assert.deepEqual(run.resolved, { result: false, msg: 'Translation cancelled' });
		assert.deepEqual(run.target.data.value, [STORED]);
	});

	it('an exception in the message handler REJECTS: worker told to stop, value back, overlay down', async () => {
		window.Worker = make_fake_worker({
			messages: [
				{ status: 'on_chunk', data: { remaining: 1, accumulated_text: 'La [[[2]]]ballena[[[3]]]' } },
				// a malformed message: on_chunk without data
				{ status: 'on_chunk', data: null },
			],
		});

		const run = await run_translation();

		assert.deepEqual(run.saves, []);
		assert.isNull(run.resolved);
		assert.instanceOf(run.rejected, Error);
		assert.deepEqual(run.target.data.value, [STORED]);
		assert.isTrue(run.overlay.classList.contains('hide'), 'the streaming overlay is taken down');
		assert.deepInclude(last_worker.posted, { cancel: true }, 'the worker is told to stop');
		assert.include(run.status_text, 'Nothing was saved');
	});

	it('a SOFT worker error (model cannot run here) resolves {result:false, code}: nothing saved, value back', async () => {
		window.Worker = make_fake_worker({
			messages: [{ status: 'error', data: { code: 'needs_webgpu', message: 'This model needs WebGPU' } }],
		});

		const run = await run_translation();

		assert.deepEqual(run.saves, []);
		assert.isNull(run.rejected);
		assert.deepEqual(run.resolved, { result: false, msg: 'This model needs WebGPU', code: 'needs_webgpu' });
		assert.deepEqual(run.target.data.value, [STORED]);
		assert.include(run.status_text, 'This model needs WebGPU');
	});

	// --- the backstops, directly ---

	it('a mark inside MARKUP (an attribute) is not in a text node, and validate refuses it', () => {
		const html = '<p title="[TC_00:00:01.000_TC]">Uno [TC_00:00:02.000_TC]dos</p>';
		assert.deepEqual(marks_in_text_nodes(html, extract_dedalo_marks), ['[TC_00:00:02.000_TC]']);

		const report = validate_translation(SOURCE, TRANSLATED, { outside_text: 1 });
		assert.isTrue(report.refused);
		assert.include(
			mark_report_lines(report, () => null).join(' '),
			'1 marks ended up inside the markup instead of the text',
		);
	});
});

describe('TOOL_LANG_MULTI — the run summary names every language that needs a look (A1-02)', function () {
	const repaired_report = validate_translation(SOURCE, TRANSLATED, { repaired: ['[[[3]]]'] });

	it('a language saved WITH WARNINGS is named, with its lines, and the summary does not auto-hide', () => {
		const summary = translation_summary(
			[
				{ label: 'Español', ok: true, warnings: repaired_report },
				{ label: 'Català', ok: true, warnings: null },
				{ label: 'Français', ok: false, warnings: null },
			],
			() => null,
		);

		assert.include(summary.text, 'Translation completed (2/3)');
		assert.include(summary.text, '✕ Français');
		assert.include(summary.text, '⚠ Translation saved — check the marks: Español');
		assert.notInclude(summary.text, 'Català');
		assert.deepEqual(summary.details, ['Español: 1 of 3 marks were repositioned automatically']);
		assert.isTrue(summary.needs_attention);
	});

	it('a clean run names nobody and may auto-hide', () => {
		const summary = translation_summary(
			[
				{ label: 'Español', ok: true, warnings: null },
				{ label: 'Català', ok: true, warnings: null },
			],
			() => null,
		);

		assert.equal(summary.text, 'Translation completed (2/2)');
		assert.deepEqual(summary.details, []);
		assert.isFalse(summary.needs_attention);
	});

	it('warnings alone (no failure) still keep the summary on screen', () => {
		const summary = translation_summary([{ label: 'Español', ok: true, warnings: repaired_report }], () => null);
		assert.isTrue(summary.needs_attention);
	});
});

// @license-end
