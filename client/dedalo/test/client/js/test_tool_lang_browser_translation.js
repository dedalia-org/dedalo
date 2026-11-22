// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global it, describe, assert, beforeEach, afterEach */
/*eslint no-undef: "error"*/

/**
 * TEST_TOOL_LANG_BROWSER_TRANSLATION
 * A1-02 (owner ruling 2026-11-22): tool_lang's browser translation never loses a Dédalo
 * mark silently.
 *
 * Before the fix, the marks of the source value (index / tc / svg … — shielded from the
 * model as placeholder tokens) were put back with a plain replaceAll: a token the model
 * lost made its mark VANISH from the target language, an inverted open/close pair was
 * saved inverted, and both runs reported 'Translation completed'. Ported from v6
 * (d3991c3a66 repair_placeholders, 2cd51f17c7 reorder_inverted_pairs), with the TS
 * ruling that a mark which still cannot be accounted for REFUSES the run.
 *
 * What runs for real: browser_translation.js (the orchestrator: marks → tokens →
 * Markdown → blocks → … → restore → reorder → validate → save), tr.js (the mark
 * patterns), markdown_utils.js (DOMParser) and block_runner.js (the worker's block loop:
 * normalise, corrective retries, repair_placeholders). What is stood in: the MODEL
 * (a deterministic `translate` function per case) and the Worker object that would host
 * block_runner.js — FakeWorker calls the real run_blocks() with that function. Cases that
 * need the worker to have answered something run_blocks never produces (an unplaceable
 * mark, a mark lost after the repair) script the worker's messages instead.
 *
 * No database, no record: the target component is a stand-in that records what it was
 * asked to save (save()'s answer is a v2 success envelope).
 */

import { run_blocks } from '../../../tools/tool_lang/js/block_runner.js';
import {
	dispose_browser_worker,
	translate_component_browser,
} from '../../../tools/tool_lang/js/browser_translation.js';

// the record's marks, in the exact syntax tr.js matches
const TC = '[TC_00:00:01.000_TC]';
const INDEX_IN = '[index-n-1-whale-data::data]';
const INDEX_OUT = '[/index-n-1-whale-data::data]';

// the source value and what a faithful translation of it must be saved as
const SOURCE = `<p>${TC}The ${INDEX_IN}white whale${INDEX_OUT} swims. It dives deep.</p>`;
const TRANSLATED = `<p>${TC}La ${INDEX_IN}ballena blanca${INDEX_OUT} nada. Se sumerge hondo.</p>`;

// the target language's existing (human) text, which a refused run must leave alone
const STORED = '<p>Texto humano existente.</p>';

// the model's faithful answer for the one block SOURCE becomes: the marks are the
// document-order tokens [[[1]]] (tc), [[[2]]] (index open), [[[3]]] (index close)
const MODEL_CLEAN = '[[[1]]]La [[[2]]]ballena blanca[[[3]]] nada. Se sumerge hondo.';

const JSON_LANGS = [
	{ dd_lang: 'lg-eng', locale: 'en-US' },
	{ dd_lang: 'lg-spa', locale: 'es-ES' },
];

/**
 * FAKEWORKER
 * Stands in for the Worker that hosts block_runner.js. `behaviour.translate` → the REAL
 * run_blocks with that model function; `behaviour.messages` → those messages, verbatim.
 * Messages are structured-cloned, as postMessage does.
 */
const make_fake_worker = (behaviour) =>
	class FakeWorker {
		constructor() {
			this.onmessage = null;
			this.onerror = null;
			this.posted = [];
		}
		postMessage(message) {
			this.posted.push(message);
			if (message?.cancel) {
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
				});
			}, 0);
		}
		terminate() {}
	}; //end make_fake_worker

/**
 * RUN_TRANSLATION
 * Drive translate_component_browser once and report what it did.
 * @param {Object} behaviour - {translate} or {messages}, see make_fake_worker
 * @return {Promise<{saves, target, status_text, resolved, rejected}>}
 */
const run_translation = async (behaviour) => {
	const saves = [];
	const target_component = {
		data: { value: [STORED], entries: [{ id: 7, value: STORED }] },
		db_data: { entries: [{ id: 7, value: STORED }] },
		context: { render_class: 'html' },
		save: (items) => {
			saves.push(structuredClone(items));
			return Promise.resolve({ ok: true, data: {} });
		},
		refresh: () => Promise.resolve(true),
	};
	const status_container = document.createElement('div');

	let resolved = null;
	let rejected = null;
	await translate_component_browser({
		source_component: { data: { entries: [{ id: 7, value: SOURCE }] } },
		target_component: target_component,
		source_lang: 'lg-eng',
		target_lang: 'lg-spa',
		status_container: status_container,
		json_langs: JSON_LANGS,
		// the real resolver answers null for a label this harness has no context for,
		// which is what makes the driver's English literals fire
		get_label: () => null,
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

describe('TOOL_LANG BROWSER TRANSLATION — every Dédalo mark accounted for (A1-02)', function () {
	this.timeout(10000);

	let real_worker = null;
	beforeEach(() => {
		real_worker = window.Worker;
		// the worker is a module-level singleton (it caches the model): drop it so the
		// next run constructs the fake installed by the case
		dispose_browser_worker();
	});
	afterEach(() => {
		window.Worker = real_worker;
		dispose_browser_worker();
	});

	it('a clean translation is saved exactly, reported as completed', async () => {
		window.Worker = make_fake_worker({ translate: async () => MODEL_CLEAN });

		const run = await run_translation();

		assert.isNull(run.rejected, 'a clean run must not be refused');
		assert.deepEqual(run.resolved, { result: true, msg: 'OK. Translation completed' });
		assert.equal(saved_value(run.saves), TRANSLATED, 'the marks must sit where the model put them');
		assert.include(run.status_text, 'Translation completed');
		assert.notInclude(run.status_text, 'check the marks', 'nothing was placed by us');
	});

	it('tokens the model merely mangled are normalised — saved clean, no warning', async () => {
		window.Worker = make_fake_worker({
			translate: async () =>
				'[[1]]La [[[ 2 ]]]ballena blanca\\[\\[\\[3\\]\\]\\] nada. Se sumerge hondo.',
		});

		const run = await run_translation();

		assert.isNull(run.rejected);
		assert.equal(saved_value(run.saves), TRANSLATED);
		assert.include(run.status_text, 'Translation completed');
	});

	it('a mark the model LOST is repaired back into place, saved, and reported', async () => {
		// the model drops the tc token on every attempt, retries included
		window.Worker = make_fake_worker({
			translate: async () => 'La [[[2]]]ballena blanca[[[3]]] nada. Se sumerge hondo.',
		});

		const run = await run_translation();

		assert.isNull(run.rejected, 'a repaired mark is not a reason to refuse');
		assert.deepEqual(run.resolved, { result: true, msg: 'OK. Translation saved with warnings' });
		// before the fix the tc mark was simply gone from the saved value
		assert.equal(
			saved_value(run.saves),
			TRANSLATED,
			'the lost tc mark must be back, opening its sentence',
		);
		assert.include(run.status_text, 'Translation saved — check the marks');
		assert.include(run.status_text, '1 of 3 marks were repositioned automatically');
		assert.notInclude(
			run.status_text,
			'Translation completed',
			'a repair is never a clean completion',
		);
	});

	it('an INVERTED open/close pair is put back in order, saved, and reported', async () => {
		// word order moved: the model emitted the close before the open
		window.Worker = make_fake_worker({
			translate: async () => '[[[1]]]La [[[3]]]ballena blanca[[[2]]] nada. Se sumerge hondo.',
		});

		const run = await run_translation();

		assert.isNull(run.rejected);
		const value = saved_value(run.saves);
		// before the fix '[/index…]ballena blanca[index…]' was saved as is
		assert.isBelow(value.indexOf(INDEX_IN), value.indexOf(INDEX_OUT), 'open before close');
		assert.equal(value, TRANSLATED);
		assert.include(
			run.status_text,
			'1 linked marks were reversed by the translation and reordered',
		);
		assert.deepEqual(run.resolved, { result: true, msg: 'OK. Translation saved with warnings' });
	});

	it('a token the model DUPLICATED is kept once; the extra copy is removed and reported', async () => {
		window.Worker = make_fake_worker({
			translate: async () =>
				'[[[1]]]La [[[2]]]ballena blanca[[[3]]] nada.[[[1]]] Se sumerge hondo.',
		});

		const run = await run_translation();

		assert.isNull(run.rejected);
		assert.equal(saved_value(run.saves), TRANSLATED);
		assert.include(run.status_text, '1 invalid markers were removed');
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

		assert.deepEqual(run.saves, [], 'an unplaceable mark must never be saved');
		assert.isNull(run.resolved, 'the run must REJECT — both callers count a resolve as success');
		assert.instanceOf(run.rejected, Error);
		assert.include(run.status_text, 'Translation needs review before saving');
		assert.include(run.status_text, '1 marks could not be placed');
		assert.include(run.status_text, 'Nothing was saved');
		assert.notInclude(run.status_text, 'Translation completed');
		// the streamed preview was taken back out of the live data
		assert.deepEqual(run.target.data.value, [STORED]);
		assert.deepEqual(run.target.data.entries, [{ id: 7, value: STORED }]);
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

		assert.deepEqual(run.saves, []);
		assert.instanceOf(run.rejected, Error);
		assert.include(run.status_text, 'Translation needs review before saving');
		assert.include(run.status_text, '1 marks could not be placed');
		assert.deepEqual(run.target.data.value, [STORED]);
	});

	it('a mark the source does not have REFUSES the run', async () => {
		window.Worker = make_fake_worker({
			messages: [
				{
					status: 'end',
					data: {
						remaining: 0,
						accumulated_text:
							'[[[1]]]La [[[2]]]ballena blanca[[[3]]] nada. [TC_00:00:09.000_TC]Se sumerge hondo.',
						repair_stats: { repaired: [], unrepairable: [] },
					},
				},
			],
		});

		const run = await run_translation();

		assert.deepEqual(run.saves, []);
		assert.instanceOf(run.rejected, Error);
		assert.include(
			run.status_text,
			'1 marks that are not in the source text appeared in the translation',
		);
	});
});

// @license-end
