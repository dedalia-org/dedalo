/**
 * Gate: the Anthropic wire shape — asserted on the PURE request builder so no
 * API key is needed. Load-bearing invariants:
 *   - NO sampling params (temperature/top_p/top_k: a 400 on every model under API version 2026-10-21, SDK 1.x);
 *   - adaptive thinking, always;
 *   - prompt-caching breakpoints: one on the system block (caches tools +
 *     system), one on the last content block of the last message;
 *   - provider_content is echoed VERBATIM on assistant replay (thinking-block
 *     passback contract for adaptive thinking + tool use);
 *   - images render BEFORE their text block (extends agent_image_flow).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
	buildMessagesRequest,
	defaultMaxTokens,
	toMessages,
} from '../../src/ai/agent/anthropic_provider.ts';
import type { AgentTranscriptEntry } from '../../src/ai/agent/llm_provider.ts';

const TRANSCRIPT: AgentTranscriptEntry[] = [
	{ role: 'user', text: 'question' },
	{
		role: 'assistant',
		turn: {
			text: 'looking',
			tool_uses: [{ id: 't1', name: 'dedalo_resolve', input: { name: 'People' } }],
			stop_reason: 'tool_use',
		},
	},
	{
		role: 'tool_results',
		results: [{ tool_use_id: 't1', content: '{"ok":true}', is_error: false }],
	},
];

function build(transcript: AgentTranscriptEntry[] = TRANSCRIPT) {
	return buildMessagesRequest({
		model: 'claude-opus-4-8',
		maxTokens: 16000,
		system: 'SYSTEM',
		tools: [{ name: 'dedalo_resolve', description: 'd', input_schema: { type: 'object' } }],
		transcript,
	});
}

describe('anthropic request shape (pure builder — no key)', () => {
	test('no sampling params; adaptive thinking; model/max_tokens as given', () => {
		const params = build() as Record<string, unknown>;
		expect(params.temperature).toBeUndefined();
		expect(params.top_p).toBeUndefined();
		expect(params.top_k).toBeUndefined();
		expect(params.thinking).toEqual({ type: 'adaptive' });
		expect(params.model).toBe('claude-opus-4-8');
		expect(params.max_tokens).toBe(16000);
	});

	test('system is a block array with the cache breakpoint (caches tools+system)', () => {
		const params = build();
		expect(params.system).toEqual([
			{ type: 'text', text: 'SYSTEM', cache_control: { type: 'ephemeral' } },
		]);
	});

	test('the LAST content block of the LAST message carries the transcript breakpoint', () => {
		const params = build();
		const messages = params.messages as { content: unknown }[];
		const last = messages[messages.length - 1] as {
			content: { type: string; cache_control?: unknown }[];
		};
		const lastBlock = last.content[last.content.length - 1];
		expect(lastBlock?.cache_control).toEqual({ type: 'ephemeral' });
		// exactly TWO breakpoints in the whole request (system + transcript tail)
		const serialized = JSON.stringify(params);
		expect(serialized.split('"cache_control"').length - 1).toBe(2);
	});

	test('a string-content last message is converted to a block to take the breakpoint', () => {
		const params = build([{ role: 'user', text: 'only question' }]);
		const messages = params.messages as { content: unknown }[];
		expect(messages[0]?.content).toEqual([
			{ type: 'text', text: 'only question', cache_control: { type: 'ephemeral' } },
		]);
	});

	test('provider_content is echoed VERBATIM on assistant replay (thinking passback)', () => {
		const nativeBlocks: unknown = [
			{ type: 'thinking', thinking: '', signature: 'sig-abc' },
			{ type: 'text', text: 'looking' },
			{ type: 'tool_use', id: 't1', name: 'dedalo_resolve', input: { name: 'People' } },
		];
		const messages = toMessages([
			{ role: 'user', text: 'q' },
			{
				role: 'assistant',
				turn: {
					text: 'looking',
					tool_uses: [{ id: 't1', name: 'dedalo_resolve', input: { name: 'People' } }],
					stop_reason: 'tool_use',
					provider_content: nativeBlocks,
				},
			},
		]);
		expect(messages[1]?.content as unknown).toBe(nativeBlocks);
	});

	test('foreign turns (no provider_content) reconstruct from text + tool_uses', () => {
		const messages = toMessages(TRANSCRIPT);
		const assistant = messages[1] as { content: { type: string }[] };
		expect(assistant.content.map((b) => b.type)).toEqual(['text', 'tool_use']);
	});

	test('images render BEFORE their text block; tool results in ONE user message', () => {
		const messages = toMessages([
			{
				role: 'user',
				text: 'what is this?',
				images: [{ media_type: 'image/jpeg', data_base64: 'AAA' }],
			},
			{
				role: 'tool_results',
				results: [
					{ tool_use_id: 'a', content: '1', is_error: false },
					{ tool_use_id: 'b', content: '2', is_error: true },
				],
			},
		]);
		const user = messages[0] as { content: { type: string }[] };
		expect(user.content.map((b) => b.type)).toEqual(['image', 'text']);
		const results = messages[1] as { role: string; content: { type: string }[] };
		expect(results.role).toBe('user');
		expect(results.content.length).toBe(2);
		expect(results.content.every((b) => b.type === 'tool_result')).toBe(true);
	});
});

describe('defaultMaxTokens (DEDALO_AGENT_MAX_TOKENS)', () => {
	const saved = process.env.DEDALO_AGENT_MAX_TOKENS;

	beforeAll(() => {
		// assigning undefined coerces to the STRING 'undefined' — only delete truly unsets the key
		delete process.env.DEDALO_AGENT_MAX_TOKENS;
	});

	afterAll(() => {
		// assigning undefined coerces to the STRING 'undefined' — only delete truly unsets the key
		if (saved === undefined) delete process.env.DEDALO_AGENT_MAX_TOKENS;
		else process.env.DEDALO_AGENT_MAX_TOKENS = saved;
	});

	test('defaults to 16000; env overrides; garbage falls back', () => {
		expect(defaultMaxTokens()).toBe(16000);
		process.env.DEDALO_AGENT_MAX_TOKENS = '32000';
		expect(defaultMaxTokens()).toBe(32000);
		process.env.DEDALO_AGENT_MAX_TOKENS = 'not-a-number';
		expect(defaultMaxTokens()).toBe(16000);
		// assigning undefined coerces to the STRING 'undefined' — only delete truly unsets the key
		delete process.env.DEDALO_AGENT_MAX_TOKENS;
	});
});
