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

import { needs_webgpu_message, run_blocks } from '../../../tools/tool_lang/js/block_runner.js';
import {
	cancel_browser_translation,
	dispose_browser_worker,
	extract_dedalo_marks,
	mark_report_lines,
	translate_component_browser,
	validate_translation,
} from '../../../tools/tool_lang/js/browser_translation.js';
import { BROWSER_MODELS, offered_models } from '../../../tools/tool_lang/js/browser_models.js';
import { marks_in_text_nodes } from '../../../tools/tool_lang/js/markdown_utils.js';
import {
	append_engine_selector,
	selected_browser_options,
} from '../../../tools/tool_lang/js/translator_engine_select.js';
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
	// declared, but no locale: no model can be told this language (A1-02 re-review)
	{ dd_lang: 'lg-nolan' },
];

// the model definition the run is given (the fake worker never loads it). A run without one
// is refused before the worker starts — there is no fallback model.
const TEST_MODEL = offered_models(null).find((model) => model.name === 'opus');

/** The browser's own Worker, taken before any case installs a fake. */
const REAL_WORKER = window.Worker;

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
					mark_patterns: message.options.mark_patterns,
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
 * @param {Object|null} [options.model=TEST_MODEL] - the model definition (null: none offered)
 * @param {Array} [options.alternatives] - the offered models a refusal may suggest
 * @param {string} [options.source_lang='lg-eng']
 * @param {string} [options.target_lang='lg-spa']
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
		source_lang: options.source_lang ?? 'lg-eng',
		target_lang: options.target_lang ?? 'lg-spa',
		model: options.model === undefined ? TEST_MODEL : options.model,
		alternatives: options.alternatives,
		device: options.device,
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

	it('a shielded tag (span / sup) round-trips as the same tag; the model never sees markup', async () => {
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

	it('markup the MODEL writes is never saved — not as markup, not as text: the run is refused (M2)', async () => {
		window.Worker = make_fake_worker({
			translate: async () =>
				'La [[[1]]]ballena<script>x()</script>[[[2]]] nada. <img onerror=y>',
		});

		const run = await run_translation();

		assert.deepEqual(refusal_problems(run, 'the model wrote markup the text did not have'), []);
	});

	it('a Dédalo mark the MODEL writes fails its block (added_mark) — never saved mangled (F2)', async () => {
		window.Worker = make_fake_worker({ translate: async () => '[TC_00:00:05.000_TC] La [[[1]]]ballena blanca[[[2]]] nada. Se sumerge hondo.' });

		const run = await run_translation();

		assert.deepEqual(refusal_problems(run, 'the model wrote a Dédalo mark the text did not have'), []);
	});

	it('a refused block is worded from its CODE: the tool label in the operator\'s language, else English (L4)', async () => {
		const labels = {
			block_added_markup: 'El modelo escribió marcas que el texto no tenía',
			block_lost_text: 'El modelo no devolvió texto para un pasaje que lo tiene',
		};
		for (const [answer, code] of [['La <b>ballena</b>', 'added_markup'], ['', 'lost_text']]) {
			window.Worker = make_fake_worker({ translate: async () => answer });
			dispose_browser_worker();
			const worded = await run_translation({ get_label: (key) => labels[key] ?? null });
			assert.isNull(worded.resolved, code);
			assert.include(worded.status_text, labels[`block_${code}`], code);

			window.Worker = make_fake_worker({ translate: async () => answer });
			dispose_browser_worker();
			const english = await run_translation();
			assert.notInclude(english.status_text, labels[`block_${code}`], code);
			assert.match(english.status_text, code === 'lost_text' ? /model returned no text/ : /model wrote markup/, code);
		}
	});

	it('tag-shaped TEXT of the record itself is kept, escaped, never markup', async () => {
		const source = '<p>La etiqueta &lt;script&gt; y &lt;img onerror=y&gt; del catálogo.</p>';
		window.Worker = make_fake_worker({ translate: async (text) => text.replace('del catálogo', 'of the catalogue') });

		const run = await run_translation({ source });

		assert.isNull(run.rejected, run.status_text);
		assert.equal(saved_value(run.saves), '<p>La etiqueta &lt;script&gt; y &lt;img onerror=y&gt; of the catalogue.</p>');
	});

	it('an empty or tokens-only answer for a passage with text is refused, never saved over the target (H2)', async () => {
		for (const answer of ['', '   ', '[[[1]]][[[2]]]']) {
			window.Worker = make_fake_worker({ translate: async () => answer });
			dispose_browser_worker();

			const run = await run_translation();

			assert.deepEqual(refusal_problems(run, 'the model returned no text for a passage that has some'), [], JSON.stringify(answer));
		}
	});

	it('the record\'s literal * _ ` \\ travel as tokens: the model never sees one, and each comes back where it stood (H1′)', async () => {
		const source = '<p>Peso 2*3*4 g, ref. a__b__c, ceca l`Hospitalet y d`Urgell \\x.</p>';
		const sent = [];
		window.Worker = make_fake_worker({
			translate: async (text) => {
				sent.push(text);
				return text.replace('Peso', 'Weight');
			},
		});

		const run = await run_translation({ source });

		assert.isNull(run.rejected, run.status_text);
		assert.deepEqual(sent.filter((text) => /[*_`\\]/.test(text)), [], 'no literal reaches the model');
		assert.equal(saved_value(run.saves), '<p>Weight 2*3*4 g, ref. a__b__c, ceca l`Hospitalet y d`Urgell \\x.</p>');
	});

	it('a literal touching emphasis keeps its place and the emphasis its letters, whatever stars the model adds (H1′, re-review 5)', async () => {
		// a model that writes a star at a word end, as one that never saw the record's would
		const stars = async (text) => text.replace(/(\p{L}) /u, '$1* ');
		for (const source of [
			'<p>Ceca: <strong>Roma</strong>* (atribución dudosa)</p>',
			'<p><em>a</em>*<em>b</em></p>',
			'<p>Forma reconstruida *<em>kʷékʷlos</em>.</p>',
		]) {
			for (const [name, translate] of [['identity', async (text) => text], ['stars', stars]]) {
				window.Worker = make_fake_worker({ translate });
				dispose_browser_worker();
				const run = await run_translation({ source });
				assert.isNull(run.rejected, `${name} ${source}: ${run.status_text}`);
				// an invented star is a delimiter beyond the source's: deleted
				assert.equal(saved_value(run.saves), source, `${name} ${source}`);
			}
		}
	});

	// --- block structure comes from the SOURCE, never from the model's text (A1-02 re-review) ---

	it('a year-leading paragraph, a dialogue dash and "---" stay paragraphs of text', async () => {
		const source = '<p>1984. The museum opened.</p><p>- Where was it?</p><p>---</p>';
		window.Worker = make_fake_worker({
			translate: async (text) =>
				text.replace('The museum opened.', 'El museo abrió.').replace('Where was it?', '¿Dónde estaba?'),
		});

		const run = await run_translation({ source });

		assert.isNull(run.rejected, run.status_text);
		assert.equal(saved_value(run.saves), '<p>1984. El museo abrió.</p><p>- ¿Dónde estaba?</p><p>---</p>');
	});

	it('Markdown block syntax the MODEL writes is text: a "# …" / "> …" answer never becomes a heading or quote', async () => {
		window.Worker = make_fake_worker({ translate: async (text) => (text === 'May 5' ? '# 5 de mayo' : '> cita') });

		const run = await run_translation({ source: '<p>May 5</p><p>quote</p>' });

		assert.isNull(run.rejected, run.status_text);
		assert.equal(saved_value(run.saves), '<p># 5 de mayo</p><p>&gt; cita</p>');
	});

	it('a heading, a list, a rule and a quote of the SOURCE keep their structure; the model sees none of it', async () => {
		const source =
			'<h2>The whale</h2><ul><li>It swims.</li><li>It dives.</li></ul><hr><blockquote>It sings.</blockquote><p>End.</p>';
		const sent = [];
		window.Worker = make_fake_worker({
			translate: async (text) => {
				sent.push(text);
				return text
					.replace('The whale', 'La ballena')
					.replace('It swims.', 'Nada.')
					.replace('It dives.', 'Bucea.')
					.replace('It sings.', 'Canta.')
					.replace('End.', 'Fin.');
			},
		});

		const run = await run_translation({ source });

		assert.isNull(run.rejected, run.status_text);
		assert.equal(
			saved_value(run.saves),
			'<h2>La ballena</h2><ul><li>Nada.</li><li>Bucea.</li></ul><hr><blockquote>Canta.</blockquote><p>Fin.</p>',
		);
		assert.notMatch(sent.join('\n'), /^\s*(#|-|\d+\.|>)\s/m, 'no Markdown block syntax reaches the model');
		assert.notInclude(sent.join(' '), '---');
	});

	// --- the source's structure survives the shielding exactly (A1-02 re-review 2) ---

	/** a model that answers with its input: the round trip must give the source back */
	const IDENTITY = { translate: async (text) => text };

	it('a word space between two inline elements survives inside a shielded <li>, <h2> and div > p', async () => {
		for (const source of [
			'<ul><li><strong>Roma</strong> <em>antigua</em></li></ul>',
			'<h2><strong>A</strong> <em>B</em></h2>',
			'<div><p><strong>a</strong> <em>b</em></p><p>c</p></div>',
		]) {
			window.Worker = make_fake_worker(IDENTITY);
			dispose_browser_worker();
			const run = await run_translation({ source });
			assert.isNull(run.rejected, run.status_text);
			assert.equal(saved_value(run.saves), source);
		}
	});

	it('an empty spacer paragraph inside a div comes back exactly (a space stays a space, &nbsp; stays &nbsp;)', async () => {
		window.Worker = make_fake_worker(IDENTITY);

		const source = '<div><p> </p><p>&nbsp;</p><p>Texto.</p></div>';
		const run = await run_translation({ source });

		assert.isNull(run.rejected, run.status_text);
		// a paragraph with nothing to translate is one atom: no synthetic &nbsp;, no lost line
		assert.equal(saved_value(run.saves), source);
	});

	it('identity round-trip in the REAL browser: the pipeline gives back what it took (parse5 twin: tool_lang_identity_roundtrip)', async () => {
		// the browser's own reading of an HTML value: what an editor would show and save
		const as_browser = (html) => new DOMParser().parseFromString(html, 'text/html').body.innerHTML;
		for (const source of [
			'<ul>\n  <li>uno <strong>dos</strong></li>\n  <li><p>tres <em>cuatro</em></p><ul><li>anidado</li></ul></li>\n  <li></li>\n</ul>',
			'<blockquote><em><p>Primera frase.</p><p>Segunda frase.</p></em></blockquote>',
			'<ul><li><strong>a <div>b</div> c</strong></li></ul>',
			'<div><strong>uno<p>dos</p></strong><em>x</em></div>',
			'<p>uno <strike>dos</strike> <big>tres</big> <tt>cuatro</tt> cinco</p>',
			'<p>10&nbsp;km y <b>negrita</b> e <i>cursiva</i></p>',
			'<div>\n</div><p class="c"> </p><p>x <!-- comentario --> y</p>',
			'<ul><li>l`Hospitalet</li><li>d`Urgell</li></ul>',
			'<p>&lt;p&gt;texto&lt;/p&gt;</p>',
			'Línea uno<br>línea dos<br><br>línea tres',
			'<p>pua \uE000 \uE007\uE008ib</p>',
			'<table>\n<tr><td> </td><td><strong>a</strong> <em>b</em></td></tr>\n</table>',
			'<p><strong>a</strong>  <em>b</em> y <span class="k">c</span>   <sub>d</sub></p>',
			'<p>Texto <foo>x</foo> fin</p>',
			'<xmp>a\nb  *c*</xmp><p>fin</p>',
			'<p>Verso uno<span style="white-space: pre-wrap">\nverso dos\n  verso tres</span> fin</p>',
			// quirks mode lets a block sit in a <p> (M1′): the paragraph must not split
			'<p>Medidas: <table><tbody><tr><td>3 g</td></tr></tbody></table> fin</p>',
			'<p>a <legend>x</legend> b</p>',
			'<p>a <button><div>x</div></button> b</p>',
			// restored whole, never sent (L1)
			'<p>a <noembed>x <b>y</b></noembed> b <noframes>z</noframes> c</p>',
		]) {
			window.Worker = make_fake_worker(IDENTITY);
			dispose_browser_worker();
			const run = await run_translation({ source });
			assert.isNull(run.rejected, `${source}: ${run.status_text}`);
			assert.equal(as_browser(saved_value(run.saves)), as_browser(source), source);
		}
	});

	it('white-space as THIS browser reads it (CSSOM): the stated answers, and the computed style agrees (L2)', async () => {
		// the reviewer's strings (re-review 5) all keep the breaks; the mirrors collapse them
		const STATED = {
			'white-space: pre-wrap !important': true,
			'WHITE-SPACE: PRE-WRAP': true,
			'white-space: pre-wrap ! important': true,
			'white-space: /*c*/ pre-wrap': true,
			'white-space: preserve nowrap': true,
			'white-space: preserve-breaks wrap': true,
			'white-space:pre !important; white-space:normal': true,
			'white-space: pre; white-space: bogus': true,
			'white-space:-moz-pre-wrap; white-space:pre-wrap': true,
			'white-space:pre-wrap; white-space:-moz-pre-wrap': true,
			'font-family:"a;b"; white-space:pre-wrap': true,
			'white-space: pre !important; white-space: normal !important': false,
			'white-space: normal !important; white-space: pre': false,
			'white-space: nowrap': false,
			'white-space: /* pre */ normal': false,
		};
		for (const [style, keeps] of Object.entries(STATED)) {
			// the browser's own rendering decides, independently of the engine's reading
			const probe = document.createElement('p');
			probe.setAttribute('style', style);
			document.body.appendChild(probe);
			const collapse = getComputedStyle(probe).whiteSpaceCollapse;
			probe.remove();
			assert.equal(['preserve', 'preserve-breaks', 'break-spaces'].includes(collapse), keeps, `computed ${style}: ${collapse}`);

			const source = `<p style='${style}'>uno\ndos <span>tres</span></p>`;
			window.Worker = make_fake_worker({ translate: async (text) => text });
			dispose_browser_worker();
			const run = await run_translation({ source });
			assert.isNull(run.rejected, `${style}: ${run.status_text}`);
			assert.equal(saved_value(run.saves).includes('uno\ndos'), keeps, style);
		}
	});

	it('layout whitespace between list items / cells is kept exactly, never sent', async () => {
		const sent = [];
		window.Worker = make_fake_worker({
			translate: async (text) => {
				sent.push(text);
				return text;
			},
		});

		const source = '<ul>\n  <li>Uno.</li>\n  <li>Dos.</li>\n</ul>';
		const run = await run_translation({ source });

		assert.isNull(run.rejected, run.status_text);
		assert.equal(saved_value(run.saves), source);
		assert.deepEqual(sent, ['Uno.', 'Dos.']);
	});

	it('a 40-item list is 40 segments, each the item text alone — no structural token reaches the model', async () => {
		const items = Array.from({ length: 40 }, (_, i) => `<li>Item ${i} of the long list.</li>`);
		window.Worker = make_fake_worker(IDENTITY);

		const run = await run_translation({ source: `<ul>${items.join('')}</ul>` });

		assert.isNull(run.rejected, run.status_text);
		const blocks = last_worker.posted[0].options.blocks;
		assert.equal(blocks.length, 40);
		assert.deepEqual(
			blocks.map((block) => block.text),
			items.map((_, i) => `Item ${i} of the long list.`),
		);
	});

	it('a div of 6 paragraphs is 6 segments with zero structural tokens', async () => {
		const paragraphs = Array.from({ length: 6 }, (_, i) => `<p>Paragraph ${i} is here.</p>`);
		window.Worker = make_fake_worker(IDENTITY);

		const run = await run_translation({ source: `<div>${paragraphs.join('')}</div>` });

		assert.isNull(run.rejected, run.status_text);
		const texts = last_worker.posted[0].options.blocks.map((block) => block.text);
		assert.deepEqual(texts, paragraphs.map((_, i) => `Paragraph ${i} is here.`));
	});

	it('a line break the MODEL writes inside a shielded item or cell is a space — never a <p> or <br> across the tags', async () => {
		window.Worker = make_fake_worker({ translate: async (text) => (text === 'One.' ? 'Uno.\n\nDos.' : 'x\ny') });

		const run = await run_translation({ source: '<ul><li>One.</li></ul><table><tbody><tr><td>a</td><td>b</td></tr></tbody></table>' });

		assert.isNull(run.rejected, run.status_text);
		assert.equal(
			saved_value(run.saves),
			'<ul><li>Uno. Dos.</li></ul><table><tbody><tr><td>x y</td><td>x y</td></tr></tbody></table>',
		);
	});

	it('structural tags out of their source order REFUSE the run (never <li>a<li></li>b</li>)', async () => {
		// <ul>=1 <li>=2 </li>=3 <li>=4 </li>=5 </ul>=6 ; the worker answers </li> and <li> swapped
		window.Worker = make_fake_worker({
			messages: [
				{
					status: 'end',
					data: {
						accumulated_text: '[[[1]]][[[2]]]a[[[4]]][[[3]]]b[[[5]]][[[6]]]',
						remaining: 0,
						repair_stats: {},
						failed_blocks: [],
					},
				},
			],
		});

		const run = await run_translation({ source: '<ul><li>a</li><li>b</li></ul>' });

		assert.deepEqual(
			refusal_problems(run, 'Translation needs review before saving', '2 tags of the text\'s structure'),
			[],
		);
	});

	it('emphasis INSIDE <code> keeps its tags (never saved as **x**)', async () => {
		const source = '<p>Run <code><b>x</b> = <i>y</i></code> now.</p>';
		window.Worker = make_fake_worker(IDENTITY);

		const run = await run_translation({ source });

		assert.isNull(run.rejected, run.status_text);
		assert.equal(saved_value(run.saves), source);
	});

	it('a paragraph or emphasis with ATTRIBUTES keeps them (alignment, class)', async () => {
		const source = '<p style="text-align:center">Hello <strong class="k">world</strong>.</p><p>End <em title="t">now</em>.</p>';
		window.Worker = make_fake_worker({
			translate: async (text) => text.replace('Hello', 'Hola').replace('world', 'mundo').replace('End', 'Fin').replace('now', 'ya'),
		});

		const run = await run_translation({ source });

		assert.isNull(run.rejected, run.status_text);
		assert.equal(
			saved_value(run.saves),
			'<p style="text-align:center">Hola <strong class="k">mundo</strong>.</p><p>Fin <em title="t">ya</em>.</p>',
		);
	});

	it('a private-use character of the SOURCE (epigraphic font) is never deleted', async () => {
		const glyphs = '';
		const source = `<p>Inscripción ${glyphs} <strong>fin</strong>.</p>`;
		window.Worker = make_fake_worker(IDENTITY);

		const run = await run_translation({ source });

		assert.isNull(run.rejected, run.status_text);
		assert.equal(saved_value(run.saves), source);
	});

	// --- the REAL worker (browser_transformer.js) refuses before loading anything ---

	const WORKER_URL = new URL(
		'../../../tools/tool_lang/translators/browser_transformer/browser_transformer.js',
		import.meta.url,
	);
	const ONE_BLOCK = [{ text: 'Hello.', placeholders: [], restore_map: {}, prefix: '', suffix: '', sep: '' }];

	/** Every message the real worker posts for one options message, within `wait` ms. */
	const real_worker_messages = (options, wait = 1500) =>
		new Promise((resolve) => {
			const live = new REAL_WORKER(WORKER_URL, { type: 'module' });
			const got = [];
			live.onmessage = (event) => got.push(event.data);
			live.onerror = (event) => got.push({ onerror: event.message || String(event) });
			live.postMessage({ options });
			setTimeout(() => {
				live.terminate();
				resolve(got);
			}, wait);
		});

	it('the REAL worker with no model definition (only a name) posts ONE soft error no_model — nothing else', async () => {
		const got = await real_worker_messages({
			blocks: ONE_BLOCK,
			sourceLangCode: 'en',
			targetLangCode: 'es',
			engine: 'nllb',
		});
		assert.deepEqual(got, [
			{
				status: 'error',
				data: {
					message: 'No translation model was chosen: this installation offers none for the browser engine.',
					code: 'no_model',
				},
			},
		]);
	});

	it('the REAL worker with no target language code posts ONE soft error unsupported_lang', async () => {
		const got = await real_worker_messages({
			blocks: ONE_BLOCK,
			sourceLangCode: 'en',
			model: { name: 'opus', shape: 'seq2seq_pair', langs: 'pairs' },
		});
		assert.equal(got.length, 1);
		assert.equal(got[0].data.code, 'unsupported_lang');
	});

	it('the REAL worker, driven through the tool: a WebGPU-only model on CPU is a soft refusal naming OFFERED models — nothing saved', async () => {
		window.Worker = REAL_WORKER;
		const alternatives = [
			{ name: 'qwen', label: 'Qwen3 4B', requires_webgpu: true },
			{ name: 'opus', label: 'Opus-MT', requires_webgpu: false },
		];
		const qwen = offered_models(null).find((model) => model.name === 'qwen');

		const run = await run_translation({ model: qwen, alternatives, device: 'wasm' });

		assert.deepEqual(run.saves, []);
		assert.isNull(run.rejected);
		assert.equal(run.resolved?.code, 'needs_webgpu');
		assert.equal(run.resolved?.msg, needs_webgpu_message('qwen', !!navigator.gpu, alternatives));
		assert.notInclude(run.resolved?.msg, 'NLLB');
		assert.deepEqual(run.target.data.value, [STORED]);
	});

	// --- refused softly before the worker: no model, a language no model can be told ---

	it('NO model offered: refused before the worker starts — nothing saved, value back, no fallback model', async () => {
		window.Worker = make_fake_worker({ translate: async () => MODEL_CLEAN });

		const run = await run_translation({ model: null });

		assert.equal(workers_constructed, 0, 'the worker never started');
		assert.deepEqual(run.saves, []);
		assert.isNull(run.rejected);
		assert.deepEqual(run.resolved, {
			result: false,
			msg: 'Translation not started: this installation offers no browser translation model',
			code: 'no_model',
		});
		assert.deepEqual(run.target.data.value, [STORED]);
		assert.include(run.status_text, 'Nothing was saved');
	});

	it('a TARGET language with no locale is refused (never translated as English): nothing saved', async () => {
		window.Worker = make_fake_worker({ translate: async () => MODEL_CLEAN });

		const run = await run_translation({ target_lang: 'lg-nolan' });

		assert.equal(workers_constructed, 0, 'the worker never started');
		assert.deepEqual(run.saves, []);
		assert.deepEqual(run.resolved, {
			result: false,
			msg: 'Translation not started: the language lg-nolan has no locale code a translation model understands',
			code: 'unsupported_lang',
		});
		assert.deepEqual(run.target.data.value, [STORED]);
	});

	it('a SOURCE language the registry does not know is refused the same way', async () => {
		window.Worker = make_fake_worker({ translate: async () => MODEL_CLEAN });

		const run = await run_translation({ source_lang: 'lg-xxx' });

		assert.equal(workers_constructed, 0);
		assert.deepEqual(run.saves, []);
		assert.equal(run.resolved?.code, 'unsupported_lang');
		assert.include(run.status_text, 'lg-xxx');
	});

	it('the worker is sent the model definition and the OFFERED alternatives — never a bare name', async () => {
		const alternatives = [{ name: 'qwen', label: 'Qwen3 4B', requires_webgpu: true }];
		window.Worker = make_fake_worker({ translate: async () => MODEL_CLEAN });

		const run = await run_translation({ alternatives });

		assert.isNull(run.rejected, run.status_text);
		const posted = last_worker.posted[0].options;
		assert.deepEqual(posted.model, TEST_MODEL);
		assert.deepEqual(posted.alternatives, alternatives);
		assert.equal(posted.sourceLangCode, 'en');
		assert.equal(posted.targetLangCode, 'es');
	});

	it('selected_browser_options: the offered models are the alternatives; a not-offered name resolves to no model', () => {
		const self = {
			translator_models: offered_models(null),
			translator_engine_model_select: { value: 'qwen' },
			get_tool_label: (key) => (key === 'engine_opus' ? 'Opus-MT — ~75 MB, fast' : null),
		};
		const chosen = selected_browser_options(self);
		assert.equal(chosen.model?.name, 'qwen');
		assert.deepEqual(
			chosen.alternatives.map((item) => item.name),
			offered_models(null).map((model) => model.name),
		);
		assert.notInclude(
			chosen.alternatives.map((item) => item.name),
			'nllb',
			'a model listed but not offered is never suggested',
		);
		assert.deepEqual(
			chosen.alternatives.find((item) => item.name === 'opus'),
			{ name: 'opus', label: 'Opus-MT', requires_webgpu: false },
		);
		self.translator_engine_model_select.value = 'nllb';
		assert.isNull(selected_browser_options(self).model, 'not offered → no model → refused');
	});

	it('the rendered selector keeps ONLY the offered definitions: a not-offered model can never be sent', () => {
		const render = (models) => {
			const self = { get_tool_label: () => null, target_translator: 'browser_transformer' };
			append_engine_selector({
				self,
				translator_engine: [{ name: 'browser_transformer', label: 'Browser', type: 'browser', models }],
				parent: document.createElement('div'),
			});
			return self;
		};

		const self = render(structuredClone([...BROWSER_MODELS]));
		const names = self.translator_models.map((model) => model.name);
		assert.notInclude(names, 'nllb', 'NLLB is listed, not offered');
		assert.deepEqual(names, offered_models(null).map((model) => model.name));
		assert.deepEqual(
			Array.from(self.translator_engine_model_select.options).map((option) => option.value),
			names,
		);
		// a forged choice of the listed-but-not-offered model resolves to no definition
		const forged = document.createElement('option');
		forged.value = 'nllb';
		self.translator_engine_model_select.append(forged);
		self.translator_engine_model_select.value = 'nllb';
		assert.isNull(selected_browser_options(self).model);

		// an installation that enables it in its tool config gets it offered (owner ruling Q1)
		const enabled = render(BROWSER_MODELS.map((model) => ({ ...model, offered_by_default: true })));
		assert.include(enabled.translator_models.map((model) => model.name), 'nllb');
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
						// '_' in its syntax: the Markdown conversion would mangle it into text, so
						// the mark is counted where it was written (re-review 6, F2)
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
