/**
 * A1-02 (owner ruling 2026-11-22): the WORKER SIDE of tool_lang's browser translation
 * gives back every Dédalo mark the model lost, and SAYS which ones it placed itself.
 *
 * Before the port the worker re-inserted a dropped `[[n]]` token by a silent character
 * offset guess, left a mangled one (`[[18 ]]`) in the text as literal junk, and reported
 * nothing — the main thread saved whatever came back as a clean success. v6 fixed it in
 * d3991c3a66 (placeholders.js: normalize_placeholders + repair_placeholders, a sentence-
 * and pair-aware placement that names what it placed); TS ported it as
 * tools/tool_lang/js/placeholders.js (verbatim) + tools/tool_lang/js/block_runner.js (the
 * block loop, taken out of the worker so it runs without the multi-GB model).
 *
 * PURE: both modules are import-free leaves of the worker (placeholders.js has no import,
 * block_runner.js imports only placeholders.js), so they load straight from disk — no
 * plugin, no stub. The model is a stand-in `translate` function: what is asserted is
 * what the runner does with what the model returns.
 *
 * The main-thread half (restore, reorder_inverted_pairs, the refusal of a mark that
 * cannot be accounted for) is the browser suite client/dedalo/test/client/js/
 * test_tool_lang_browser_translation.js — it needs tr.js and markdown_utils.js (DOM).
 */

import { describe, expect, test } from 'bun:test';
import {
	MAX_PLACEHOLDER_RETRIES,
	process_block,
	run_blocks,
	to_global_tokens,
} from '../../tools/tool_lang/js/block_runner.js';
import {
	extract_placeholders,
	normalize_placeholders,
	repair_placeholders,
} from '../../tools/tool_lang/js/placeholders.js';

type Descriptor = { token: string; kind: 'open' | 'close' | 'atom'; pair: string | null };
type Block = { text: string; placeholders: Descriptor[]; restore_map: Record<string, string> };
type Message = { status: string; data: Record<string, unknown> };

/** How many times each token occurs in a text. */
function tokenCounts(text: string): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const token of extract_placeholders(text)) counts[token] = (counts[token] ?? 0) + 1;
	return counts;
}

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
		const out = repair_placeholders(input, output, [{ token: '[[[1]]]', kind: 'atom', pair: null }]);
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

describe('process_block — escalation: normalise → ask again → repair and report', () => {
	const block: Block = {
		text: 'One [[[1]]]two[[[2]]] three.',
		placeholders: [
			{ token: '[[[1]]]', kind: 'open', pair: '[[[2]]]' },
			{ token: '[[[2]]]', kind: 'close', pair: '[[[1]]]' },
		],
		restore_map: { '[[[1]]]': '[[[7]]]', '[[[2]]]': '[[[8]]]' },
	};

	test('a model that keeps dropping a token is asked MAX_PLACEHOLDER_RETRIES times, then the token is REPAIRED and named', async () => {
		const calls: unknown[] = [];
		const out = await process_block(async (_text: string, retry: unknown) => {
			calls.push(retry);
			return 'Uno [[[1]]]dos tres.'; // the close is gone, every time
		}, block);
		expect(calls.length, 'first attempt + every corrective retry').toBe(1 + MAX_PLACEHOLDER_RETRIES);
		expect(calls[0], 'the first call is not a retry').toBeNull();
		expect(out.repaired).toEqual(['[[[2]]]']);
		expect(out.unrepairable).toEqual([]);
		expect(out.text).toBe('Uno [[[1]]]dos[[[2]]] tres.');
	});

	test('a retry that recovers the token is kept — nothing repaired', async () => {
		let call = 0;
		const out = await process_block(async () => {
			call++;
			return call === 1 ? 'Uno [[[1]]]dos tres.' : 'Uno [[[1]]]dos[[[2]]] tres.';
		}, block);
		expect(call).toBe(2);
		expect(out).toEqual({ text: 'Uno [[[1]]]dos[[[2]]] tres.', repaired: [], unrepairable: [] });
	});

	test('a retry that loses MORE is discarded: the better attempt is what gets repaired', async () => {
		let call = 0;
		const out = await process_block(async () => {
			call++;
			return call === 1 ? 'Uno [[[1]]]dos tres.' : 'Uno dos tres.';
		}, block);
		// the first attempt kept the open; a retry that lost it too must not replace it
		expect(out.repaired).toEqual(['[[[2]]]']);
		expect(out.text).toBe('Uno [[[1]]]dos[[[2]]] tres.');
	});

	test('mangled tokens are normalised, not counted as lost — no retry, no repair', async () => {
		let call = 0;
		const out = await process_block(async () => {
			call++;
			return 'Uno [[ 1 ]]dos[[2]] tres.';
		}, block);
		expect(call).toBe(1);
		expect(out).toEqual({ text: 'Uno [[[1]]]dos[[[2]]] tres.', repaired: [], unrepairable: [] });
	});

	test('a failing FIRST translation propagates (the run loop reports the block as lost)', async () => {
		await expect(
			process_block(async () => {
				throw new Error('inference timeout');
			}, block),
		).rejects.toThrow('inference timeout');
	});
});

describe('run_blocks — messages, document-wide tokens, repair_stats', () => {
	const blocks: Block[] = [
		{
			text: 'First [[[1]]]part.',
			placeholders: [{ token: '[[[1]]]', kind: 'atom', pair: null }],
			restore_map: { '[[[1]]]': '[[[1]]]' },
		},
		{
			text: 'Second [[[1]]]part.',
			placeholders: [{ token: '[[[1]]]', kind: 'atom', pair: null }],
			restore_map: { '[[[1]]]': '[[[2]]]' },
		},
	];

	async function run(translate: (text: string) => Promise<string>) {
		const messages: Message[] = [];
		await run_blocks({
			blocks,
			translate,
			post: (message: Message) => messages.push(structuredClone(message)),
		});
		return messages;
	}

	test('a clean run: one on_chunk per block, then end, nothing repaired', async () => {
		const messages = await run(async (text) => text.replace('First', 'Primera').replace('Second', 'Segunda'));
		expect(messages.map((m) => m.status)).toEqual(['on_chunk', 'on_chunk', 'end']);
		const end = messages[2]?.data as { accumulated_text: string; repair_stats: unknown };
		expect(end.accumulated_text).toBe('Primera [[[1]]]part.\n\nSegunda [[[2]]]part.');
		expect(end.repair_stats).toEqual({ repaired: [], unrepairable: [] });
	});

	test('a token the model lost in block 2 is back in the text and named in DOCUMENT-WIDE numbering', async () => {
		const messages = await run(async (text) =>
			text.startsWith('Second') ? 'Segunda parte.' : text.replace('First', 'Primera'),
		);
		const end = messages.at(-1) as Message;
		expect(end.status).toBe('end');
		const data = end.data as { accumulated_text: string; repair_stats: Record<string, string[]> };
		expect(tokenCounts(data.accumulated_text)).toEqual({ '[[[1]]]': 1, '[[[2]]]': 1 });
		// block 2's LOCAL [[[1]]] is the document's [[[2]]]
		expect(data.repair_stats.repaired).toEqual(['[[[2]]]']);
		expect(data.repair_stats.unrepairable).toEqual([]);
	});

	test('a block that throws is skipped and reported; the run still ends', async () => {
		const messages = await run(async (text) => {
			if (text.startsWith('Second')) throw new Error('inference timeout');
			return text.replace('First', 'Primera');
		});
		expect(messages.map((m) => m.status)).toEqual(['on_chunk', 'on_block_error', 'end']);
		expect(messages[1]?.data).toMatchObject({ block: 2, total: 2, message: 'inference timeout' });
		const end = messages[2]?.data as { accumulated_text: string };
		expect(end.accumulated_text).toBe('Primera [[[1]]]part.');
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
});

test('to_global_tokens maps local tokens and leaves an INVENTED one for the main thread to strip', () => {
	expect(to_global_tokens('a [[[1]]] b [[[9]]]', { '[[[1]]]': '[[[14]]]' })).toBe('a [[[14]]] b [[[9]]]');
});
