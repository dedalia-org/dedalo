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
	collapse_model_breaks,
	detect_repetition,
	MAX_LENGTH_RATIO,
	needs_webgpu_message,
	process_block,
	REPETITION_ESCALATIONS,
	REPETITION_PENALTY_FIRST,
	run_blocks,
	run_precondition,
	smaller_model_advice,
	strip_fences,
	to_global_tokens,
	too_large_message,
} from '../../tools/tool_lang/js/block_runner.js';
import {
	BROWSER_MODELS,
	is_offered,
	offered_models,
} from '../../tools/tool_lang/js/browser_models.js';
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

	// A1-02 re-review: block structure comes from the source (shielded tags), never from text
	// the model wrote. Each of these was a list / rule / heading / quote / table before.
	test.each([
		[
			'a year-leading paragraph',
			'1984. El museo abrió sus puertas.',
			'<p>1984. El museo abrió sus puertas.</p>',
		],
		['a dialogue dash', '- ¿Dónde estaba?', '<p>- ¿Dónde estaba?</p>'],
		['an asterisk bullet', '* uno', '<p>* uno</p>'],
		['a rule', '---', '<p>---</p>'],
		['a heading hash', '# 5 de mayo', '<p># 5 de mayo</p>'],
		['a quote', '> cita', '<p>&gt; cita</p>'],
		['a pipe table', '| a | b |\n|---|---|', '<p>| a | b |<br>|---|---|</p>'],
		['a code fence', '```\ncode\n```', '<p>```<br>code<br>```</p>'],
		['a dash on a second line', 'Dijo:\n- Sí.', '<p>Dijo:<br>- Sí.</p>'],
	])('markdown_to_html infers NO block from model text: %s', (_name, md, html) => {
		expect(markdown_to_html(md)).toBe(html);
	});

	test('markdown_to_html never DELETES a private-use character of the text (epigraphic fonts)', () => {
		const pua = '\uE000\uE001\uE006\uE007\uE008\uE009';
		expect(markdown_to_html(`a${pua}b`)).toBe(`<p>a${pua}b</p>`);
		expect(markdown_to_html(`**a\uE007b** \`c\uE000\` x\ny`)).toBe(
			'<p><strong>a\uE007b</strong> <code>c\uE000</code> x<br>y</p>',
		);
		// a text that LOOKS like our stand-ins (code span index, escape) stays text
		expect(markdown_to_html('\uE0070\uE007 \uE008a')).toBe('<p>\uE0070\uE007 \uE008a</p>');
	});

	test('markdown_to_html: a shielded block token keeps its own structure (no <p> wrapper)', () => {
		expect(markdown_to_html('[[[1]]]uno[[[2]]]', { block_tokens: new Set(['[[[1]]]']) })).toBe(
			'[[[1]]]uno[[[2]]]',
		);
	});

	test('markdown_to_html: a code span is set aside — emphasis never reaches into or across it', () => {
		expect(markdown_to_html('**a `b** c`')).toBe('<p>a <code>b** c</code></p>');
		expect(markdown_to_html('x `**y**` z')).toBe('<p>x <code>**y**</code> z</p>');
		expect(markdown_to_html('**a** `*b*` *c*')).toBe(
			'<p><strong>a</strong> <code>*b*</code> <em>c</em></p>',
		);
	});

	// A1-02 re-review: block tag edges are mandatory cuts (block_kinds)
	const list_md = (items: number) => {
		// [[[1]]] <ul>, then per item an <li> open/close pair, then [[[last]]] </ul>
		const kinds = new Map<string, string>([['[[[1]]]', 'open']]);
		let md = '[[[1]]]';
		for (let i = 0; i < items; i++) {
			const open = `[[[${2 + 2 * i}]]]`;
			const close = `[[[${3 + 2 * i}]]]`;
			kinds.set(open, 'open');
			kinds.set(close, 'close');
			md += `${open}Item ${i} of the list, with **bold** words.${close}`;
		}
		const last = `[[[${2 + 2 * items}]]]`;
		kinds.set(last, 'close');
		return { md: md + last, kinds };
	};

	test('segment_markdown cuts at every block tag edge: one segment per list item, structural tokens only at its edges', () => {
		const { md, kinds } = list_md(40);
		const segments = segment_markdown(md, 250, { block_kinds: kinds }) as Array<{
			text: string;
			sep: string;
		}>;
		expect(segments.length).toBe(40);
		expect(segments.map((segment) => segment.sep + segment.text).join('')).toBe(md);
		for (const [i, { text }] of segments.entries()) {
			const body = text.replace(/^(?:\[\[\[\d+\]\]\])+/, '').replace(/(?:\[\[\[\d+\]\]\])+$/, '');
			expect(body).toBe(`Item ${i} of the list, with **bold** words.`);
		}
		// without the block kinds it is one line of tokens cut at arbitrary sentences
		expect(segment_markdown(md, 250).length).toBeLessThan(40);
	});

	test('segment_markdown: a div of paragraphs is one segment per paragraph; open→open, close→close and inline tokens are no cut', () => {
		const kinds = new Map<string, string>([
			['[[[1]]]', 'open'],
			['[[[14]]]', 'close'],
		]);
		let md = '[[[1]]]';
		for (let i = 0; i < 6; i++) {
			const open = `[[[${2 + 2 * i}]]]`;
			const close = `[[[${3 + 2 * i}]]]`;
			kinds.set(open, 'open');
			kinds.set(close, 'close');
			md += `${open}Paragraph ${i}.${close}`;
		}
		md += '[[[14]]]';
		const segments = segment_markdown(md, 250, { block_kinds: kinds }) as Array<{ text: string }>;
		expect(segments.map((segment) => segment.text)).toEqual([
			'[[[1]]][[[2]]]Paragraph 0.[[[3]]]',
			'[[[4]]]Paragraph 1.[[[5]]]',
			'[[[6]]]Paragraph 2.[[[7]]]',
			'[[[8]]]Paragraph 3.[[[9]]]',
			'[[[10]]]Paragraph 4.[[[11]]]',
			'[[[12]]]Paragraph 5.[[[13]]][[[14]]]',
		]);
		// an inline pair (span) inside a paragraph is never a cut
		const inline = segment_markdown('[[[1]]]A [[[2]]]b[[[3]]] c.[[[4]]]', 250, {
			block_kinds: new Map([
				['[[[1]]]', 'open'],
				['[[[4]]]', 'close'],
			]),
		}) as Array<{ text: string }>;
		expect(inline.map((segment) => segment.text)).toEqual(['[[[1]]]A [[[2]]]b[[[3]]] c.[[[4]]]']);
	});

	test("segment_markdown: '|' and '```' are text now — a long line that starts with one is cut at sentences", () => {
		const sentences = Array.from(
			{ length: 12 },
			(_, i) => `Sentence ${i} is long enough to count.`,
		).join(' ');
		for (const md of [`| ${sentences}`, `\`\`\`\n${sentences}\n\`\`\``]) {
			const segments = segment_markdown(md, 120) as Array<{ text: string }>;
			expect(segments.length, md.slice(0, 5)).toBeGreaterThan(2);
		}
	});

	test('a line break the model wrote into a segment that had none is ONE space', () => {
		expect(collapse_model_breaks('uno', 'uno\n\ndos')).toBe('uno dos');
		expect(collapse_model_breaks('uno', ' uno \n dos\n')).toBe('uno dos');
		expect(collapse_model_breaks('uno', 'uno dos')).toBe('uno dos');
		// a segment that carries a break keeps the model's
		expect(collapse_model_breaks('a\nb', 'x\ny')).toBe('x\ny');
	});

	test('process_block applies it: a shielded item never comes back as two paragraphs', async () => {
		const outcome = await process_block(async () => 'Uno.\n\nDos.', {
			text: 'One. Two.',
			placeholders: [],
			restore_map: {},
		});
		expect(outcome.text).toBe('Uno. Dos.');
	});

	test('conform_emphasis drops emphasis the model invented; restore_wrapping_emphasis restores a dropped wrapper', () => {
		expect(conform_emphasis('The white whale', 'La **ballena** blanca')).toBe('La ballena blanca');
		expect(restore_wrapping_emphasis('**The white whale**', 'La ballena blanca')).toBe(
			'**La ballena blanca**',
		);
	});
});

describe('the worker refuses before loading: no model, no language code (A1-02 re-review)', () => {
	const model = { name: 'opus', requires_webgpu: false };
	const ok = { model, sourceLangCode: 'en', targetLangCode: 'es' };

	test('a complete run passes', () => {
		expect(run_precondition(ok)).toBeNull();
	});

	test.each([
		['no model at all', { ...ok, model: undefined }],
		['only an engine name (no fallback lookup)', { ...ok, model: undefined, engine: 'nllb' }],
		['a model without a name', { ...ok, model: {} }],
	])('no_model: %s', (_name, options) => {
		expect(run_precondition(options)?.code).toBe('no_model');
	});

	test.each([
		['no source code', { ...ok, sourceLangCode: undefined }, 'source'],
		['no target code', { ...ok, targetLangCode: null }, 'target'],
		['an empty target code', { ...ok, targetLangCode: '' }, 'target'],
	])('unsupported_lang: %s — never an en/es guess', (_name, options, side) => {
		const refusal = run_precondition(options);
		expect(refusal?.code).toBe('unsupported_lang');
		expect(refusal?.message).toContain(`The ${side} language`);
	});

	test('smaller_model_advice names only OFFERED models that run without WebGPU, never the current one', () => {
		const alternatives = [
			{ name: 'qwen', label: 'Qwen3 4B', requires_webgpu: true },
			{ name: 'madlad', label: 'MADLAD-400 3B', requires_webgpu: true },
			{ name: 'opus', label: 'Opus-MT', requires_webgpu: false },
		];
		expect(smaller_model_advice(alternatives, 'qwen')).toBe(' Try a smaller model: Opus-MT.');
		expect(smaller_model_advice(alternatives, 'opus')).toBe('');
		expect(smaller_model_advice(undefined, 'qwen')).toBe('');
		// the old fixed advice named NLLB — listed, NOT offered: only an offered list is read
		expect(smaller_model_advice(alternatives, 'qwen')).not.toContain('NLLB');
		expect(smaller_model_advice([{ name: 'x', requires_webgpu: false }], 'qwen')).toBe(
			' Try a smaller model: x.',
		);
	});

	test('the refusal messages carry the advice from the OFFERED list (the real worker is driven by the client suite)', () => {
		const alternatives = [
			{ name: 'qwen', label: 'Qwen3 4B', requires_webgpu: true },
			{ name: 'opus', label: 'Opus-MT', requires_webgpu: false },
		];
		expect(needs_webgpu_message('qwen', false, alternatives)).toBe(
			"The 'qwen' model needs WebGPU (GPU). This browser has no WebGPU available, so this model cannot run here. Try a smaller model: Opus-MT.",
		);
		expect(needs_webgpu_message('qwen', true, alternatives)).toBe(
			'The \'qwen\' model needs WebGPU (GPU). Turn off the "more compatible / CPU" option to use it.',
		);
		expect(too_large_message('qwen', alternatives)).toBe(
			"The 'qwen' model is too large to load on this device. Try a smaller model: Opus-MT.",
		);
		expect(too_large_message('opus', alternatives)).toBe(
			"The 'opus' model is too large to load on this device.",
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

	test('offered_by_default is a STRICT boolean: absent or true offers, anything else does not', () => {
		const base = BROWSER_MODELS[0]!;
		expect(is_offered({ ...base, offered_by_default: true })).toBe(true);
		const { offered_by_default: _dropped, ...absent } = base;
		expect(is_offered(absent as typeof base)).toBe(true);
		for (const value of [false, 'false', 'true', 0, 1, null]) {
			expect(
				is_offered({ ...base, offered_by_default: value as unknown as boolean }),
				String(value),
			).toBe(false);
		}
		const configured = [
			{ ...base, name: 'a', offered_by_default: 'false' },
			{ ...base, name: 'b', offered_by_default: true },
		] as unknown as typeof BROWSER_MODELS;
		expect(offered_models(configured).map((model: { name: string }) => model.name)).toEqual(['b']);
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
