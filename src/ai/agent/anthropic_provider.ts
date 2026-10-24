/**
 * The production LLM provider — official Anthropic SDK (Messages API,
 * manual tool-use shapes). FAIL-CLOSED: constructing it without a configured
 * API key throws, so the agent can never silently run keyless.
 *
 * Always streams internally (client.messages.stream + finalMessage), which
 * both feeds the optional per-delta sink and lifts the non-streaming HTTP
 * timeout ceiling on long adaptive-thinking turns. Thinking is adaptive with
 * the default (omitted) display — thinking deltas surface only as a
 * start/stop indicator, never as text.
 *
 * Replay contract: each assistant turn records its provider-native content
 * blocks (`provider_content`); when the transcript is replayed, those blocks
 * — including thinking blocks — are echoed VERBATIM, as the Messages API
 * requires for adaptive thinking + tool use. Foreign turns (scripted
 * provider, client history) are reconstructed from text/tool_uses as before.
 *
 * API VERSION 2026-10-21 (SDK 1.x, 2026-10-24): the SDK now sends that
 * `anthropic-version` and the key as `Authorization: Bearer` (was X-Api-Key).
 * Under it `temperature`/`top_p`/`top_k` are a 400 on every model, a
 * `document` block in an assistant message is a 400, and so is a user `text`
 * block carrying `citations`. The request below sends none of them — the
 * no-sampling-params leg of agent_anthropic_request_shape pins the first, and
 * replayed assistant content is the model's own output (text / thinking /
 * tool_use). Exactly one credential is passed (`apiKey`), as 1.x requires.
 *
 * The offline gates use the scripted provider instead; this class is the
 * one-module swap the seam exists for.
 */

import Anthropic from '@anthropic-ai/sdk';
import { readEnv } from '../../config/env.ts';
import { readString } from '../../config/readers.ts';
import { DedaloError } from '../../core/errors/index.ts';
import type {
	AgentAssistantTurn,
	AgentLlmProvider,
	AgentToolDefinition,
	AgentToolUse,
	AgentTranscriptEntry,
	AgentTurnDelta,
} from './llm_provider.ts';

/** Default model for the Dédalo agent (override via AGENT_MODEL env). */
const _DEFAULT_MODEL = 'claude-opus-4-8';
/** Default per-turn output cap (override via DEDALO_AGENT_MAX_TOKENS / catalog). */
const DEFAULT_MAX_TOKENS = 16000;

export interface AnthropicProviderOptions {
	/** Provider-native model id (default: AGENT_MODEL env, then claude-opus-4-8). */
	model?: string;
	/** Env KEY NAME holding the API key (default ANTHROPIC_API_KEY). */
	apiKeyEnvKey?: string;
	/** Per-turn output-token cap (default DEDALO_AGENT_MAX_TOKENS, then 16000). */
	maxTokens?: number;
}

export class AnthropicProvider implements AgentLlmProvider {
	readonly name = 'anthropic';
	private readonly client: Anthropic;
	private readonly model: string;
	private readonly maxTokens: number;

	constructor(options: AnthropicProviderOptions = {}) {
		const keyName = options.apiKeyEnvKey ?? 'ANTHROPIC_API_KEY';
		const apiKey = readEnv(keyName);
		if (apiKey === undefined || apiKey === '') {
			throw new DedaloError('ai.provider_failed', {
				message: `AnthropicProvider requires ${keyName} (private/.env or process env). The agent fails closed without credentials.`,
				coordinates: { env_key: keyName },
			});
		}
		this.client = new Anthropic({ apiKey });
		this.model = options.model ?? readString('AGENT_MODEL');
		this.maxTokens = options.maxTokens ?? defaultMaxTokens();
	}

	async createTurn(
		request: {
			system: string;
			tools: AgentToolDefinition[];
			transcript: AgentTranscriptEntry[];
		},
		onDelta?: (delta: AgentTurnDelta) => void,
	): Promise<AgentAssistantTurn> {
		const params = buildMessagesRequest({
			model: this.model,
			maxTokens: this.maxTokens,
			system: request.system,
			tools: request.tools,
			transcript: request.transcript,
		});
		const stream = this.client.messages.stream(params);

		if (onDelta !== undefined) {
			// Track block types by index so stop events can close the indicator.
			const blockTypes = new Map<number, string>();
			stream.on('streamEvent', (event) => {
				if (event.type === 'content_block_start') {
					blockTypes.set(event.index, event.content_block.type);
					if (event.content_block.type === 'thinking') {
						onDelta({ type: 'thinking', state: 'start' });
					} else if (event.content_block.type === 'tool_use') {
						onDelta({ type: 'tool_input_start', name: event.content_block.name });
					}
				} else if (event.type === 'content_block_delta') {
					if (event.delta.type === 'text_delta') {
						onDelta({ type: 'text_delta', text: event.delta.text });
					}
				} else if (event.type === 'content_block_stop') {
					if (blockTypes.get(event.index) === 'thinking') {
						onDelta({ type: 'thinking', state: 'stop' });
					}
				}
			});
		}

		const response = await stream.finalMessage();

		let text = '';
		const toolUses: AgentToolUse[] = [];
		for (const block of response.content) {
			if (block.type === 'text') text += block.text;
			if (block.type === 'tool_use') {
				toolUses.push({
					id: block.id,
					name: block.name,
					input: block.input as Record<string, unknown>,
				});
			}
		}
		const stopReason: AgentAssistantTurn['stop_reason'] =
			response.stop_reason === 'tool_use'
				? 'tool_use'
				: response.stop_reason === 'refusal'
					? 'refusal'
					: response.stop_reason === 'max_tokens'
						? 'max_tokens'
						: 'end_turn';
		return {
			text,
			tool_uses: toolUses,
			stop_reason: stopReason,
			// Echoed verbatim on replay — this is how thinking blocks survive.
			provider_content: response.content,
			usage: {
				input_tokens: response.usage.input_tokens,
				output_tokens: response.usage.output_tokens,
				cache_read_input_tokens: response.usage.cache_read_input_tokens ?? undefined,
			},
		};
	}
}

/** The per-turn output cap from config (shared by catalog-built providers). */
export function defaultMaxTokens(): number {
	const raw = readEnv('DEDALO_AGENT_MAX_TOKENS');
	const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_TOKENS;
}

/**
 * Build the full Messages-API request body. Pure and exported so the offline
 * gate can assert the wire shape (no sampling params, adaptive thinking,
 * cache_control placement) without an API key.
 *
 * Caching layout (prefix rule: tools → system → messages):
 *  - one breakpoint on the system block (caches tools + system together);
 *  - one on the last content block of the last message (incremental reuse of
 *    the growing transcript across loop iterations and resent history).
 */
export function buildMessagesRequest(params: {
	model: string;
	maxTokens: number;
	system: string;
	tools: AgentToolDefinition[];
	transcript: AgentTranscriptEntry[];
}): Anthropic.MessageStreamParams {
	const messages = toMessages(params.transcript);
	markLastBlockCacheBreakpoint(messages);
	return {
		model: params.model,
		max_tokens: params.maxTokens,
		thinking: { type: 'adaptive' },
		system: [
			{
				type: 'text',
				text: params.system,
				cache_control: { type: 'ephemeral' },
			},
		],
		tools: params.tools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			input_schema: tool.input_schema as Anthropic.Tool['input_schema'],
		})),
		messages,
	};
}

/**
 * Map the loop's provider-neutral transcript onto Messages-API messages.
 * Exported for the offline gate: the image-block mapping must be assertable
 * without an API key.
 */
export function toMessages(transcript: AgentTranscriptEntry[]): Anthropic.MessageParam[] {
	const messages: Anthropic.MessageParam[] = [];
	for (const entry of transcript) {
		if (entry.role === 'user') {
			if (entry.images !== undefined && entry.images.length > 0) {
				// Images BEFORE the text block (the Messages-API best practice for
				// vision: the question refers to the image above it).
				const content: Anthropic.ContentBlockParam[] = entry.images.map((image) =>
					'url' in image
						? { type: 'image' as const, source: { type: 'url' as const, url: image.url } }
						: {
								type: 'image' as const,
								source: {
									type: 'base64' as const,
									media_type: image.media_type,
									data: image.data_base64,
								},
							},
				);
				content.push({ type: 'text', text: entry.text });
				messages.push({ role: 'user', content });
			} else {
				messages.push({ role: 'user', content: entry.text });
			}
		} else if (entry.role === 'assistant') {
			if (entry.turn.provider_content !== undefined) {
				// Same-provider replay: echo the native blocks (incl. thinking)
				// verbatim — required by adaptive thinking with tool use.
				messages.push({
					role: 'assistant',
					content: entry.turn.provider_content as Anthropic.ContentBlockParam[],
				});
				continue;
			}
			const content: Anthropic.ContentBlockParam[] = [];
			if (entry.turn.text !== '') {
				content.push({ type: 'text', text: entry.turn.text });
			}
			for (const use of entry.turn.tool_uses) {
				content.push({ type: 'tool_use', id: use.id, name: use.name, input: use.input });
			}
			messages.push({ role: 'assistant', content });
		} else {
			// All tool results of one turn go back in ONE user message.
			messages.push({
				role: 'user',
				content: entry.results.map((result) => ({
					type: 'tool_result' as const,
					tool_use_id: result.tool_use_id,
					content: result.content,
					is_error: result.is_error,
				})),
			});
		}
	}
	return messages;
}

/** Add the transcript cache breakpoint to the last block of the last message. */
function markLastBlockCacheBreakpoint(messages: Anthropic.MessageParam[]): void {
	const last = messages[messages.length - 1];
	if (last === undefined) return;
	if (typeof last.content === 'string') {
		last.content = [{ type: 'text', text: last.content, cache_control: { type: 'ephemeral' } }];
		return;
	}
	const lastBlock = last.content[last.content.length - 1];
	if (lastBlock !== undefined && 'type' in lastBlock) {
		(lastBlock as { cache_control?: { type: 'ephemeral' } }).cache_control = {
			type: 'ephemeral',
		};
	}
}
