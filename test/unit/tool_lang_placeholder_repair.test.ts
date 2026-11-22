/**
 * Audit row A1-02 (port of v6 d3991c3a66 + 55c816b41c / 92da452aa1 / 40bf5eaacf): the
 * WORKER SIDE of tool_lang's browser translation gives back every Dédalo mark the model
 * lost, SAYS which ones it placed itself, and never writes a loop into a record.
 *
 * Before the port the worker re-inserted a dropped `[[n]]` token by a silent character
 * offset guess, left a mangled one (`[[18 ]]`) in the text as literal junk, and reported
 * nothing — the main thread saved whatever came back as a clean success. v6 fixed it in
 * d3991c3a66 (placeholders.js: normalize_placeholders + repair_placeholders, a sentence-
 * and pair-aware placement that names what it placed), then replaced the corrective
 * retries with a repetition guard and 250-char segmentation (55c816b41c, 92da452aa1: the
 * model translates any instruction put into its text, so a "put [[[3]]] back" retry came
 * back translated, into the record). TS ports it as tools/tool_lang/js/placeholders.js +
 * tools/tool_lang/js/block_runner.js (the block loop, taken out of the worker so it runs
 * without the multi-GB model).
 *
 * PURE: block_runner.js imports only placeholders.js and the DOM-free emphasis helpers of
 * markdown_utils.js, so all three load straight from disk — no plugin, no stub. The model
 * is a stand-in `translate` function: what is asserted is what the runner does with what
 * the model returns.
 *
 * Also here, because they need no DOM: markdown_utils' segmentation (the round-trip
 * invariant) and markdown_to_html's escaping of model text; and the in-code model
 * catalogue (browser_models.js) equals both register.json copies.
 *
 * The main-thread half (build_blocks, restore, reorder_inverted_tokens, validate, the
 * refusal of a mark that cannot be accounted for) is the browser suite
 * client/dedalo/test/client/js/test_tool_lang_browser_translation.js — it needs
 * DOMParser (html_to_markdown).
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
	detect_repetition,
	MAX_LENGTH_RATIO,
	process_block,
	REPETITION_ESCALATIONS,
	REPETITION_PENALTY_FIRST,
	run_blocks,
	strip_fences,
	to_global_tokens,
} from '../../tools/tool_lang/js/block_runner.js';
import { BROWSER_MODELS, offered_models } from '../../tools/tool_lang/js/browser_models.js';
import {
	conform_emphasis,
	markdown_to_html,
	restore_wrapping_emphasis,
	segment_markdown,
} from '../../tools/tool_lang/js/markdown_utils.js';
import {
	extract_placeholders,
	normalize_placeholders,
	repair_placeholders,
} from '../../tools/tool_lang/js/placeholders.js';

type Descriptor = { token: string; kind: 'open' | 'close' | 'atom'; pair: string | null };
type Block = {
	text: string;
	placeholders: Descriptor[];
	restore_map: Record<string, string>;
	prefix?: string;
	suffix?: string;
	sep?: string;
};
type Message = { status: string; data: Record<string, unknown> };
type Overrides = Record<string, unknown> | null;
type Translate = (text: string, overrides: Overrides, label: string) => Promise<string>;

/** How many times each token occurs in a text. */
function tokenCounts(text: string): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const token of extract_placeholders(text)) counts[token] = (counts[token] ?? 0) + 1;
	return counts;
}

/** A looping answer, long enough for detect_repetition (≥ 50 chars, a 2-word cycle ×6). */
const LOOP = 'Uno dos Uno dos Uno dos Uno dos Uno dos Uno dos Uno dos Uno dos';

describe('normalize_placeholders — the forms the model mangles come back as [[[n]]]', () => {
	test.each([
		['double brackets', 'Hola [[5]] mundo', 'Hola [[[5]]] mundo'],
		['quad brackets', 'Hola [[[[5]]]] mundo', 'Hola [[[5]]] mundo'],
		['padding', 'Hola [[[ 5 ]]] mundo', 'Hola [[[5]]] mundo'],
		['escaped brackets', 'Hola \\[\\[\\[5\\]\\]\\] mundo', 'Hola [[[5]]] mundo'],
		['Devanagari digits', 'नमस्ते [[[५]]] संसार', 'नमस्ते [[[5]]] संसार'],
		['Arabic-Indic digits', 'مرحبا [[[٥]]]', 'مرحبا [[[5]]]'],
	])('%s', (_name, mangled, expected) => {
		expect(normalize_placeholders(mangled)).toBe(expected);
	});

	test('a well-formed text is unchanged', () => {
		const clean = '[[[1]]]Hola, [[[2]]]¡bienvenido!';
		expect(normalize_placeholders(clean)).toBe(clean);
	});
});

describe('repair_placeholders — a dropped token is put back, and named', () => {
	test('nothing dropped: the text is untouched and nothing is reported', () => {
		const out = repair_placeholders('Hello[[[1]]] world.', 'Hola[[[1]]] mundo.', [
			{ token: '[[[1]]]', kind: 'atom', pair: null },
		]);
		expect(out).toEqual({ text: 'Hola[[[1]]] mundo.', repaired: [], unrepairable: [] });
	});

	test('a dropped atom lands in its own sentence, once', () => {
		// source: the tc mark opens the SECOND sentence; the model dropped it
		const input = 'First sentence here. [[[1]]]Second sentence here.';
		const output = 'Primera frase aquí. Segunda frase aquí.';
		const out = repair_placeholders(input, output, [
			{ token: '[[[1]]]', kind: 'atom', pair: null },
		]);
		expect(out.repaired).toEqual(['[[[1]]]']);
		expect(out.unrepairable).toEqual([]);
		expect(tokenCounts(out.text)).toEqual({ '[[[1]]]': 1 });
		// it opens the second sentence, as in the source — not the first
		expect(out.text.indexOf('[[[1]]]')).toBeGreaterThan(out.text.indexOf('aquí.'));
		expect(out.text.replace('[[[1]]]', '')).toBe(output);
	});

	test('a dropped CLOSE is placed after as many words as its span had in the source', () => {
		const input = 'The [[[1]]]white whale[[[2]]] swims.';
		const output = 'La [[[1]]]ballena blanca nada.';
		const out = repair_placeholders(input, output, [
			{ token: '[[[1]]]', kind: 'open', pair: '[[[2]]]' },
			{ token: '[[[2]]]', kind: 'close', pair: '[[[1]]]' },
		]);
		expect(out.repaired).toEqual(['[[[2]]]']);
		expect(out.text).toBe('La [[[1]]]ballena blanca[[[2]]] nada.');
	});

	test('a dropped OPEN is placed in front of the span its close ends', () => {
		const input = 'The [[[1]]]white whale[[[2]]] swims.';
		const output = 'La ballena blanca[[[2]]] nada.';
		const out = repair_placeholders(input, output, [
			{ token: '[[[1]]]', kind: 'open', pair: '[[[2]]]' },
			{ token: '[[[2]]]', kind: 'close', pair: '[[[1]]]' },
		]);
		expect(out.repaired).toEqual(['[[[1]]]']);
		expect(out.text).toBe('La [[[1]]]ballena blanca[[[2]]] nada.');
	});

	test('both halves dropped: both come back, the open before the close', () => {
		const input = 'The [[[1]]]white whale[[[2]]] swims.';
		const output = 'La ballena blanca nada.';
		const out = repair_placeholders(input, output, [
			{ token: '[[[1]]]', kind: 'open', pair: '[[[2]]]' },
			{ token: '[[[2]]]', kind: 'close', pair: '[[[1]]]' },
		]);
		expect([...out.repaired].sort()).toEqual(['[[[1]]]', '[[[2]]]']);
		expect(tokenCounts(out.text)).toEqual({ '[[[1]]]': 1, '[[[2]]]': 1 });
		expect(out.text.indexOf('[[[1]]]')).toBeLessThan(out.text.indexOf('[[[2]]]'));
	});
});

describe('process_block — one model call, repair what it dropped, refuse what it duplicated', () => {
	const block: Block = {
		text: 'One [[[1]]]two[[[2]]] three.',
		placeholders: [
			{ token: '[[[1]]]', kind: 'open', pair: '[[[2]]]' },
			{ token: '[[[2]]]', kind: 'close', pair: '[[[1]]]' },
		],
		restore_map: { '[[[1]]]': '[[[7]]]', '[[[2]]]': '[[[8]]]' },
	};

	test('a dropped token costs NO second call: it is repaired and named (no corrective retry — the model would translate the instruction)', async () => {
		const calls: Overrides[] = [];
		const out = await process_block(async (_text: string, overrides: Overrides) => {
			calls.push(overrides);
			return 'Uno [[[1]]]dos tres.'; // the close is gone
		}, block);
		expect(calls).toEqual([{ repetition_penalty: REPETITION_PENALTY_FIRST }]);
		expect(out).toEqual({
			text: 'Uno [[[1]]]dos[[[2]]] tres.',
			repaired: ['[[[2]]]'],
			unrepairable: [],
			duplicated: [],
			residual: [],
		});
	});

	test('the model gets the segment and nothing else — no instruction, no correction', async () => {
		const sent: string[] = [];
		await process_block(async (text: string) => {
			sent.push(text);
			return 'Uno dos tres.';
		}, block);
		expect(sent).toEqual([block.text]);
	});

	test('mangled tokens are normalised, not counted as lost', async () => {
		const out = await process_block(async () => 'Uno [[ 1 ]]dos[[2]] tres.', block);
		expect(out.text).toBe('Uno [[[1]]]dos[[[2]]] tres.');
		expect(out.repaired).toEqual([]);
	});

	test('a token written twice: EVERY copy is removed and it is reported — never the first copy kept', async () => {
		const out = await process_block(async () => 'Uno [[[1]]]dos[[[2]]] tres[[[2]]].', block);
		expect(out.duplicated).toEqual(['[[[2]]]']);
		expect(tokenCounts(out.text)).toEqual({ '[[[1]]]': 1 });
		expect(out.text).toBe('Uno [[[1]]]dos tres.');
	});

	test('an INVENTED token is removed and counted as residual', async () => {
		const out = await process_block(async () => 'Uno [[[1]]]dos[[[2]]] tres[[[9]]].', block);
		expect(out.text).toBe('Uno [[[1]]]dos[[[2]]] tres.');
		expect(out.residual).toEqual(['[[[9]]]']);
		expect(out.repaired).toEqual([]);
	});

	test('fences / quotes / a preamble around the answer are unwrapped', async () => {
		const out = await process_block(async () => '<<<Uno [[[1]]]dos[[[2]]] tres.>>>', block);
		expect(out.text).toBe('Uno [[[1]]]dos[[[2]]] tres.');
	});

	test('a block of nothing but tokens never reaches the model', async () => {
		let called = false;
		const tokens_only: Block = { ...block, text: '[[[1]]] [[[2]]]' };
		const out = await process_block(async () => {
			called = true;
			return 'invented';
		}, tokens_only);
		expect(called).toBe(false);
		expect(out.text).toBe('[[[1]]] [[[2]]]');
	});

	test('a LOOP is retried with each escalation in turn; the first that is not a loop is kept', async () => {
		const calls: Overrides[] = [];
		const out = await process_block(async (_text: string, overrides: Overrides) => {
			calls.push(overrides);
			return calls.length < 3 ? LOOP : 'Uno [[[1]]]dos[[[2]]] tres.';
		}, block);
		expect(calls).toEqual([
			{ repetition_penalty: REPETITION_PENALTY_FIRST },
			...REPETITION_ESCALATIONS,
		]);
		expect(out.text).toBe('Uno [[[1]]]dos[[[2]]] tres.');
	});

	test('a block still looping after every escalation THROWS — a loop is never written', async () => {
		let calls = 0;
		await expect(
			process_block(async () => {
				calls++;
				return LOOP;
			}, block),
		).rejects.toThrow('repetition degeneration');
		expect(calls).toBe(1 + REPETITION_ESCALATIONS.length);
	});

	test('a failing translation propagates (the run loop reports the block as lost)', async () => {
		await expect(
			process_block(async () => {
				throw new Error('inference timeout');
			}, block),
		).rejects.toThrow('inference timeout');
	});
});

describe('detect_repetition / strip_fences', () => {
	test('an n-gram cycle is a loop; a short text or ordinary repetition is not', () => {
		expect(detect_repetition(LOOP, 'One two.')).toBe(true);
		expect(detect_repetition('no, no, no', '')).toBe(false); // < 50 chars
		expect(
			detect_repetition(
				'No, no, no, he said, and then he left the house without a word to anyone.',
				'',
			),
		).toBe(false);
	});

	test('an answer wildly longer than its source is degenerate whatever the n-gram scan says', () => {
		const source = 'A short source sentence here.';
		const long = 'x'.repeat(Math.ceil(source.length * MAX_LENGTH_RATIO) + 1);
		expect(detect_repetition(`${long} different words`, source)).toBe(true);
	});

	test.each([
		['<<<Hola mundo>>>', 'Hola mundo'],
		['「Hola mundo」', 'Hola mundo'],
		['Here is the translation: Hola mundo', 'Hola mundo'],
		['Hola mundo', 'Hola mundo'],
	])('strip_fences(%p)', (raw, expected) => {
		expect(strip_fences(raw)).toBe(expected);
	});
});

describe('run_blocks — messages, document-wide tokens, repair_stats', () => {
	const blocks: Block[] = [
		{
			text: 'First [[[1]]]part.',
			placeholders: [{ token: '[[[1]]]', kind: 'atom', pair: null }],
			restore_map: { '[[[1]]]': '[[[1]]]' },
			sep: '',
		},
		{
			text: 'Second [[[1]]]part.',
			placeholders: [{ token: '[[[1]]]', kind: 'atom', pair: null }],
			restore_map: { '[[[1]]]': '[[[2]]]' },
			sep: '\n\n',
		},
	];

	async function run(translate: Translate, run_blocks_list: Block[] = blocks) {
		const messages: Message[] = [];
		await run_blocks({
			blocks: run_blocks_list,
			translate,
			post: (message: Message) => messages.push(structuredClone(message)),
		});
		return messages;
	}

	test('a clean run: one on_chunk per block, then end, joined with each block’s own sep', async () => {
		const messages = await run(async (text) =>
			text.replace('First', 'Primera').replace('Second', 'Segunda'),
		);
		expect(messages.map((m) => m.status)).toEqual(['on_chunk', 'on_chunk', 'end']);
		const end = messages[2]?.data as { accumulated_text: string; repair_stats: unknown };
		expect(end.accumulated_text).toBe('Primera [[[1]]]part.\n\nSegunda [[[2]]]part.');
		expect(end.repair_stats).toEqual({
			repaired: [],
			unrepairable: [],
			duplicated: [],
			residual: [],
		});
	});

	test('a token the model lost in block 2 is back and named in DOCUMENT-WIDE numbering', async () => {
		const messages = await run(async (text) =>
			text.startsWith('Second') ? 'Segunda parte.' : text.replace('First', 'Primera'),
		);
		const data = messages.at(-1)?.data as {
			accumulated_text: string;
			repair_stats: Record<string, string[]>;
		};
		expect(tokenCounts(data.accumulated_text)).toEqual({ '[[[1]]]': 1, '[[[2]]]': 1 });
		expect(data.repair_stats.repaired).toEqual(['[[[2]]]']); // block 2's LOCAL [[[1]]]
	});

	test('a duplicated token is reported document-wide; an invented one only counted', async () => {
		const messages = await run(async (text) =>
			text.startsWith('Second') ? 'Segunda [[[1]]]parte[[[1]]].' : `${text} [[[5]]]`,
		);
		const data = messages.at(-1)?.data as {
			repair_stats: Record<string, string[]>;
			accumulated_text: string;
		};
		expect(data.repair_stats.duplicated).toEqual(['[[[2]]]']);
		expect(data.repair_stats.residual).toEqual(['[[[5]]]']);
		// neither the duplicate nor the invented token reaches the main thread
		expect(tokenCounts(data.accumulated_text)).toEqual({ '[[[1]]]': 1 });
	});

	test('hoisted prefix/suffix are document-wide: attached AFTER the mapping, never remapped', async () => {
		const hoisted: Block[] = [
			{
				text: 'Hola [[[1]]]mundo[[[2]]].',
				placeholders: [
					{ token: '[[[1]]]', kind: 'open', pair: '[[[2]]]' },
					{ token: '[[[2]]]', kind: 'close', pair: '[[[1]]]' },
				],
				restore_map: { '[[[1]]]': '[[[3]]]', '[[[2]]]': '[[[4]]]' },
				prefix: '[[[2]]] ',
				suffix: ' [[[5]]]',
				sep: '',
			},
		];
		const messages = await run(async (text) => text, hoisted);
		const data = messages.at(-1)?.data as { accumulated_text: string };
		expect(data.accumulated_text).toBe('[[[2]]] Hola [[[3]]]mundo[[[4]]]. [[[5]]]');
	});

	test('a block that throws is SKIPPED, listed in failed_blocks; the run still ends', async () => {
		const messages = await run(async (text) => {
			if (text.startsWith('Second')) throw new Error('inference timeout');
			return text.replace('First', 'Primera');
		});
		expect(messages.map((m) => m.status)).toEqual(['on_chunk', 'on_block_error', 'end']);
		expect(messages[1]?.data).toMatchObject({ block: 2, total: 2, message: 'inference timeout' });
		const end = messages[2]?.data as { accumulated_text: string; failed_blocks: unknown[] };
		expect(end.accumulated_text).toBe('Primera [[[1]]]part.');
		expect(end.failed_blocks).toEqual([{ block: 2, total: 2, message: 'inference timeout' }]);
	});

	test('cancel between blocks posts cancelled and stops', async () => {
		const messages: Message[] = [];
		let cancelled = false;
		await run_blocks({
			blocks,
			translate: async (text: string) => {
				cancelled = true;
				return text;
			},
			post: (message: Message) => messages.push(structuredClone(message)),
			is_cancelled: () => cancelled,
		});
		expect(messages.map((m) => m.status)).toEqual(['on_chunk', 'cancelled']);
	});

	test('a cancel that arrives DURING the last block ends the run as cancelled, never end (end saves)', async () => {
		const messages: Message[] = [];
		let cancelled = false;
		await run_blocks({
			blocks,
			translate: async (text: string) => {
				if (text.startsWith('Second')) cancelled = true;
				return text;
			},
			post: (message: Message) => messages.push(structuredClone(message)),
			is_cancelled: () => cancelled,
		});
		expect(messages.map((m) => m.status)).toEqual(['on_chunk', 'on_chunk', 'cancelled']);
	});
});

test('to_global_tokens maps local tokens and DROPS an unmapped one (its number may be another block’s real mark)', () => {
	expect(to_global_tokens('a [[[1]]] b [[[9]]]', { '[[[1]]]': '[[[14]]]' })).toBe('a [[[14]]] b ');
});

describe('markdown_utils — segmentation and model-text escaping (no DOM)', () => {
	const long = `${Array.from(
		{ length: 30 },
		(_, i) => `Sentence ${i} is here, with **bold ${i}** and [[[${i + 1}]]] a mark.`,
	).join(' ')}\n\nSecond paragraph.\nIts second line.`;

	test('segment_markdown: every segment ≤ 250 chars, and sep + text re-joins to the source exactly', () => {
		const segments = segment_markdown(long, 250) as Array<{ text: string; sep: string }>;
		expect(segments.length).toBeGreaterThan(5);
		expect(segments.every((segment) => segment.text.length <= 250)).toBe(true);
		expect(segments.map((segment) => segment.sep + segment.text).join('')).toBe(long);
	});

	test('segment_markdown never splits a token or an emphasis span', () => {
		const segments = segment_markdown(long, 250) as Array<{ text: string }>;
		for (const { text } of segments) {
			expect(text.replace(/\[\[\[\d+\]\]\]/g, '')).not.toMatch(/\[\[|\]\]/);
			expect((text.match(/\*\*/g) ?? []).length % 2).toBe(0);
		}
	});

	test('markdown_to_html ESCAPES model text: a translated <script> / <img onerror> is stored as text', () => {
		const html = markdown_to_html(
			'Hola <script>alert(1)</script> <img src=x onerror=alert(1)> & "x"',
		);
		expect(html).not.toContain('<script');
		expect(html).not.toContain('<img');
		expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
		expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
		expect(html).toContain('&amp; &quot;x&quot;');
	});

	test('markdown_to_html renders only emphasis — a model-written link stays text', () => {
		const html = markdown_to_html('**bold** [a](javascript:alert(1))');
		expect(html).toContain('<strong>bold</strong>');
		expect(html).not.toContain('<a');
	});

	test('conform_emphasis drops emphasis the model invented; restore_wrapping_emphasis restores a dropped wrapper', () => {
		expect(conform_emphasis('The white whale', 'La **ballena** blanca')).toBe('La ballena blanca');
		expect(restore_wrapping_emphasis('**The white whale**', 'La ballena blanca')).toBe(
			'**La ballena blanca**',
		);
	});
});

describe('browser_models.js — the one code copy of the register.json model catalogue', () => {
	const register = JSON.parse(
		readFileSync(resolve(import.meta.dir, '../../tools/tool_lang/register.json'), 'utf8'),
	) as {
		misc: Record<
			string,
			Array<{ value: Record<string, { value: Array<Record<string, unknown>> }> }>
		>;
	};

	test.each(['dd999', 'dd1633'])('equals the %s browser_transformer.models', (column) => {
		const engines = register.misc[column]?.[0]?.value.translator_engine?.value ?? [];
		const browser = engines.find((engine) => engine.name === 'browser_transformer');
		expect(browser?.models).toEqual(structuredClone([...BROWSER_MODELS]));
	});

	test('a model whose licence forbids the use is catalogued but not offered by default, with its reason', () => {
		const withheld = BROWSER_MODELS.filter((model) => model.offered_by_default === false);
		expect(withheld.map((model) => model.name)).toEqual(['nllb']);
		expect(withheld.every((model) => typeof model.not_offered_reason === 'string')).toBe(true);
		expect(offered_models(null).map((model: { name: string }) => model.name)).not.toContain('nllb');
		// an installation that enables it in its tool config gets it offered
		const enabled = BROWSER_MODELS.map((model) => ({ ...model, offered_by_default: true }));
		expect(offered_models(enabled).map((model: { name: string }) => model.name)).toContain('nllb');
	});
});
