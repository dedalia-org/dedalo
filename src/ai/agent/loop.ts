/**
 * The Dédalo agent loop (spec §8; DoD: "AI tools denied exactly where humans
 * are denied").
 *
 * A manual tool-use loop over the SAME shared tool registry the MCP server
 * exposes (src/ai/mcp/registry.ts) plus the RAG semantic search — every tool
 * call executes under the caller's `Principal` through `runTool`, so the
 * agent can never read, search, or retrieve anything the human API would deny
 * that user, and every result reaches the model as the same structured
 * envelope (with its model-facing hints) the MCP surfaces emit. Failed tools
 * return `is_error` results (the model can adapt); the loop is capped at
 * MAX_ITERATIONS and returns the transcript for auditability.
 *
 * WRITE MODE (the propose→confirm→apply harness): the model gets the READ
 * tools plus ONE synthetic tool, `propose_change_plan`. NO write ever executes
 * inside the loop — a valid proposal is validated (labels stamped to tipos,
 * every gate dry-run) and ENDS the turn, returning the resolved plan + hash
 * for the human to confirm; the confirmed plan executes later through
 * applyChangePlan (src/ai/agent/change_plan.ts). An invalid proposal comes
 * back to the model as an is_error tool result so it can repair and re-propose.
 *
 * EGRESS (src/ai/agent/egress.ts): when the conversation's model is EXTERNAL,
 * every record-content tool call is gated BEFORE its handler runs and
 * semantic-search hits are filtered per record — restricted repository
 * content never enters an external model context. Local models are never
 * gated; the stdio server and mcp_proxy are unaffected (no model involved).
 *
 * MULTI-TURN is stateless: the caller resends prior user/assistant TEXT
 * (AgentHistoryEntry[]) each turn — tool traffic is never replayed (an
 * untrusted client could spoof tool results, i.e. fabricated grounding), the
 * model re-runs tools when it needs data. The loop returns the ready-to-
 * resend history for the next turn.
 *
 * The LLM side is a seam (llm_provider.ts): the offline gates drive the loop
 * with a deterministic scripted provider; production plugs in the official
 * Anthropic SDK provider (anthropic_provider.ts) or the OpenAI-compatible
 * local provider (openai_compat_provider.ts) via the model catalog.
 */

import { toDedaloError, toStructuredErr } from '../../core/errors/convert.ts';
import { logError } from '../../core/errors/log.ts';
import type { Principal } from '../../core/security/permissions.ts';
import {
	getToolSpec,
	type RegistryGates,
	registeredTools,
	runTool,
	toAgentToolDefinition,
} from '../mcp/registry.ts';
import { retrievePassages, semanticSearch } from '../rag/retrieval.ts';
import { type ValidatedChangePlan, validateChangePlan } from './change_plan.ts';
import {
	type AgentEgressOptions,
	filterEgressHits,
	gateAgentToolCall,
	gateAgentToolResult,
} from './egress.ts';
import type {
	AgentImage,
	AgentLlmProvider,
	AgentToolDefinition,
	AgentToolResult,
	AgentTranscriptEntry,
	AgentTurnDelta,
	AgentTurnUsage,
} from './llm_provider.ts';
import { type AgentUiContext, buildContextBlock, buildSystemPrompt } from './system_prompt.ts';

/** Hard cap on model turns — a runaway-loop backstop, not a tuning knob. */
const MAX_ITERATIONS = 12;

/**
 * The token RESERVATION of one run (security/ai_spend.ts): the most OUTPUT it
 * can produce — the per-turn output limit times MAX_ITERATIONS. Input is not
 * bounded ahead of the run; the reservation is replaced by the reported usage
 * when the run ends (`reportedRunTokens`).
 */
export function agentRunTokenReservation(maxTokensPerTurn: number): number {
	return maxTokensPerTurn * MAX_ITERATIONS;
}

/**
 * A run's reported usage as ONE token count (input + output + cache reads: every
 * token the provider says it processed), or null when the provider reported
 * none — which keeps the full reservation charged.
 */
export function reportedRunTokens(usage: AgentTurnUsage | undefined): number | null {
	if (usage === undefined) return null;
	const parts = [usage.input_tokens, usage.output_tokens, usage.cache_read_input_tokens].filter(
		(value): value is number => typeof value === 'number' && Number.isFinite(value),
	);
	return parts.length === 0 ? null : parts.reduce((sum, value) => sum + value, 0);
}

/** The RAG tools are loop-local (they are not part of the MCP registry). */
const SEMANTIC_SEARCH_TOOL: AgentToolDefinition = {
	name: 'dedalo_semantic_search',
	description:
		'Hybrid semantic + lexical search over indexed record texts — find RECORDS by meaning ' +
		'(cross-lingual). Returns scored snippets with their (section_tipo, section_id). ' +
		'Optionally narrow to sections (section_tipo) or to one embed facet (group, e.g. ' +
		'"card" vs "fulltext"). For the exact passages behind an answer, follow up with ' +
		'dedalo_retrieve_passages.',
	input_schema: {
		type: 'object',
		properties: {
			query: { type: 'string' },
			limit: { type: 'number' },
			section_tipo: {
				description: 'Narrow to these section tipos (string or array).',
				anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
			},
			group: {
				type: 'string',
				description: 'Embed-group facet id (slug) — search only that facet.',
			},
		},
		required: ['query'],
	},
};

/** Passage-level retrieval: the grounding/citation companion to semantic search. */
const RETRIEVE_PASSAGES_TOOL: AgentToolDefinition = {
	name: 'dedalo_retrieve_passages',
	description:
		'Retrieve the exact PASSAGES (chunks) matching a query — use these to ground and CITE ' +
		'answers: each passage carries (section_tipo, section_id, chunk_index) and its text. ' +
		'Prefer a small limit; cite as section_tipo-section_id.',
	input_schema: {
		type: 'object',
		properties: {
			query: { type: 'string' },
			limit: { type: 'number', description: 'Max passages (default 8, cap 20).' },
			section_tipo: {
				description: 'Narrow to these section tipos (string or array).',
				anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
			},
			group: {
				type: 'string',
				description: 'Embed-group facet id (slug) — retrieve only that facet.',
			},
		},
		required: ['query'],
	},
};

/** Group-id slug grammar (api.ts optionGroup parity); invalid ⇒ treated as absent. */
const GROUP_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/** Read the optional scope/group args shared by the two RAG tools. */
function readRagToolArgs(input: Record<string, unknown>): {
	scope: string[] | undefined;
	group: string | undefined;
} {
	const rawScope = input.section_tipo;
	let scope: string[] | undefined;
	if (typeof rawScope === 'string' && rawScope !== '') {
		scope = [rawScope];
	} else if (Array.isArray(rawScope)) {
		const cleaned = rawScope.filter((x): x is string => typeof x === 'string' && x !== '');
		if (cleaned.length > 0) scope = cleaned;
	}
	const rawGroup = typeof input.group === 'string' ? input.group.trim() : '';
	const group = GROUP_SLUG_RE.test(rawGroup) ? rawGroup : undefined;
	return { scope, group };
}

/** The synthetic write-mode tool: propose (never execute) a change plan. */
const PROPOSE_TOOL: AgentToolDefinition = {
	name: 'propose_change_plan',
	description:
		'Propose a change plan for human confirmation. NOTHING is written when ' +
		'you call this — a human reviews the resolved plan first. Each op is one ' +
		'write tool call; {ref: "<op_id>"} chains onto records created by earlier ' +
		'ops. Call it at most once, with the COMPLETE plan.',
	input_schema: {
		type: 'object',
		properties: {
			plan_version: { const: 1 },
			summary: { type: 'string', description: 'What the plan does, one sentence.' },
			ops: {
				type: 'array',
				items: {
					type: 'object',
					properties: {
						op_id: { type: 'string' },
						tool: {
							type: 'string',
							description:
								'A write tool: dedalo_create_record, dedalo_find_or_create, ' +
								'dedalo_set_field, dedalo_portal_link, dedalo_portal_unlink, ' +
								'dedalo_upload_media, dedalo_save_component, dedalo_delete_record, ' +
								'dedalo_duplicate_record.',
						},
						args: { type: 'object' },
						summary: { type: 'string', description: 'Human-readable one-liner for this op.' },
					},
					required: ['op_id', 'tool', 'args', 'summary'],
				},
			},
		},
		required: ['plan_version', 'summary', 'ops'],
	},
};

/**
 * The READ tool surface offered to the model (writes only ever travel the
 * propose→confirm→apply path) plus the RAG semantic search.
 */
export const AGENT_TOOLS: AgentToolDefinition[] = [
	...registeredTools().map(toAgentToolDefinition),
	SEMANTIC_SEARCH_TOOL,
	RETRIEVE_PASSAGES_TOOL,
];

/** Argument keys worth surfacing in a human-readable tool summary. */
const SUMMARY_KEYS = [
	'section_tipo',
	'section_id',
	'component_tipo',
	'tipo',
	'query',
	'name',
	'label',
	'path',
	'filter',
	'limit',
] as const;

/**
 * A short human-readable summary of a tool call for UI activity chips
 * ("dedalo_search_records: section_tipo=oh1 query=Pujol"). Pure; capped.
 */
export function summarizeToolArgs(input: Record<string, unknown>): string {
	const parts: string[] = [];
	for (const key of SUMMARY_KEYS) {
		const value = input[key];
		if (value === undefined || value === null) continue;
		const rendered = typeof value === 'object' ? JSON.stringify(value) : String(value);
		parts.push(`${key}=${rendered}`);
	}
	const summary = parts.join(' ');
	return summary.length > 140 ? `${summary.slice(0, 139)}…` : summary;
}

/**
 * The result of a tool whose own code threw: the ONE converter's structured
 * error (a code and the registry's fixed sentence the model can adapt to) —
 * never the exception's text, which is the server's (a driver message, a path,
 * a host) while a tool result enters the model's context (an EXTERNAL
 * provider's, when one is configured) and the stored transcript. The words go
 * to the log (T2 S09-b; ERRORS_SPEC §2).
 */
function failedToolResult(toolUseId: string, name: string, error: unknown): AgentToolResult {
	logError(toDedaloError(error), { subsystem: `agent/${name}` });
	return {
		tool_use_id: toolUseId,
		content: JSON.stringify(toStructuredErr(error)),
		is_error: true,
	};
}

/** Execute one READ tool call under the principal. Errors become is_error results. */
async function executeTool(
	principal: Principal,
	name: string,
	input: Record<string, unknown>,
	toolUseId: string,
	egress?: AgentEgressOptions,
): Promise<AgentToolResult> {
	if (name === 'dedalo_semantic_search') {
		try {
			const query = String((input as { query: unknown }).query ?? '');
			// Clamp like the registry search tools do (dd_rag_api MAX_TOP_K parity):
			// an injected `limit` would otherwise drive hybridCandidates' over-fetch
			// (limit*4) unbounded.
			const requested = Number((input as { limit?: unknown }).limit ?? 10);
			const limit = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 50) : 10;
			const { scope, group } = readRagToolArgs(input);
			const hits = await semanticSearch(principal, query, limit, scope, group);
			if (egress?.external === true) {
				// Per-hit egress filter (host + CONTRIBUTORS — a group chunk's
				// snippet carries deep-resolved text from other sections):
				// restricted records never enter an external model context; the
				// model is told results were withheld.
				const { allowed, removed } = await filterEgressHits(egress, hits);
				return {
					tool_use_id: toolUseId,
					content: JSON.stringify({ hits: allowed, restricted_hits_removed: removed }),
					is_error: false,
				};
			}
			return { tool_use_id: toolUseId, content: JSON.stringify(hits), is_error: false };
		} catch (error) {
			return failedToolResult(toolUseId, name, error);
		}
	}

	if (name === 'dedalo_retrieve_passages') {
		try {
			const query = String((input as { query: unknown }).query ?? '');
			// Small default/cap: passages are chunk-sized (~450 tokens) and every
			// tool result is re-carried through up to MAX_ITERATIONS resends.
			const requested = Number((input as { limit?: unknown }).limit ?? 8);
			const limit = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 20) : 8;
			const { scope, group } = readRagToolArgs(input);
			// Over-fetch then dedupe: the indexer writes one doc per (group, LANG),
			// so the same chunk appears once per language at adjacent ranks — a
			// limit-N list would otherwise fill with copies of one passage.
			const raw = await retrievePassages(principal, query, Math.min(limit * 3, 50), scope, group);
			const seen = new Set<string>();
			const passages = [];
			for (const passage of raw) {
				const key = `${passage.section_tipo}|${passage.section_id}|${passage.chunk_index}`;
				if (seen.has(key)) continue; // keep the best-scored lang copy (rank order)
				seen.add(key);
				passages.push(passage);
				if (passages.length >= limit) break;
			}
			if (egress?.external === true) {
				const { allowed, removed } = await filterEgressHits(egress, passages);
				return {
					tool_use_id: toolUseId,
					content: JSON.stringify({ passages: allowed, restricted_hits_removed: removed }),
					is_error: false,
				};
			}
			return { tool_use_id: toolUseId, content: JSON.stringify(passages), is_error: false };
		} catch (error) {
			return failedToolResult(toolUseId, name, error);
		}
	}

	const spec = getToolSpec(name);
	// The loop executes only read tools; an unknown OR write-tool name is
	// refused the same way (the model can adapt, nothing executes).
	if (spec === undefined || spec.write) {
		return { tool_use_id: toolUseId, content: `Unknown tool: ${name}`, is_error: true };
	}
	if (egress !== undefined) {
		// External-egress gate BEFORE the handler runs (fail-closed).
		const refusal = await gateAgentToolCall(egress, name, input);
		if (refusal !== null) {
			return { tool_use_id: toolUseId, content: JSON.stringify(refusal), is_error: true };
		}
	}
	const envelope = await runTool(spec, principal, input);
	if (egress !== undefined && envelope.ok) {
		// ...and again on the RESULT: a public record can resolve labels of
		// records in a restricted section through its portals (egress.ts).
		const refusal = await gateAgentToolResult(egress, name, envelope);
		if (refusal !== null) {
			return { tool_use_id: toolUseId, content: JSON.stringify(refusal), is_error: true };
		}
	}
	return {
		tool_use_id: toolUseId,
		content: JSON.stringify(envelope),
		is_error: !envelope.ok,
	};
}

/** The user question: plain text, or text with attached images (vision). */
export type AgentQuestion = string | { text: string; images?: AgentImage[] };

/** One prior conversation turn, resent by the (stateless) caller. TEXT only. */
export interface AgentHistoryEntry {
	role: 'user' | 'assistant';
	text: string;
}

/** Loop progress events, forwarded to the streaming surface. */
export type AgentLoopEvent =
	| AgentTurnDelta
	| { type: 'tool_use'; id: string; name: string; summary: string }
	| { type: 'tool_result'; id: string; name: string; ok: boolean; code?: string }
	| { type: 'iteration'; n: number; max: number };

export interface AgentRunOptions {
	/** 'read' (default) or 'write' — write adds propose_change_plan. */
	mode?: 'read' | 'write';
	/** Write-section allowlist forwarded into plan validation. */
	writableSections?: Set<string>;
	/** Prior conversation turns (client-resent; the server holds no state). */
	history?: AgentHistoryEntry[];
	/** What the user is currently viewing (prepended to THIS turn only). */
	uiContext?: AgentUiContext;
	/** The conversation's egress posture (external models gate record content). */
	egress?: AgentEgressOptions;
	/** Progress sink for the streaming surface. */
	onEvent?: (event: AgentLoopEvent) => void;
	/** Prebuilt system prompt; defaults to buildSystemPrompt(mode, egress). */
	systemPrompt?: string;
}

export interface AgentRunResult {
	/** The model's final text answer. */
	answer: string;
	/** Full transcript (question, turns, tool results) for auditing. */
	transcript: AgentTranscriptEntry[];
	/** Why the loop ended. */
	stop: 'end_turn' | 'max_iterations' | 'refusal' | 'max_tokens' | 'change_plan';
	/** The validated plan awaiting human confirmation (write mode only). */
	change_plan?: ValidatedChangePlan;
	/** Accumulated provider usage across the run's turns (when reported). */
	usage: AgentTurnUsage;
	/** Ready-to-resend text history for the caller's NEXT turn. */
	history: AgentHistoryEntry[];
}

/**
 * Run the agent loop: question → model turn → execute requested tools under
 * the principal → feed results back → repeat until the model stops (or, in
 * write mode, proposes a valid change plan — which ends the turn UNEXECUTED).
 */
export async function runAgent(
	principal: Principal,
	question: AgentQuestion,
	provider: AgentLlmProvider,
	options: AgentRunOptions = {},
): Promise<AgentRunResult> {
	const writeMode = options.mode === 'write';
	const gates: RegistryGates = {
		allowWrite: writeMode,
		writableSections: options.writableSections,
	};
	const questionText = typeof question === 'string' ? question : question.text;
	const images = typeof question === 'string' ? undefined : question.images;

	// The volatile context block rides on THIS turn's text only — never the
	// system prompt (cache prefix), never the resendable history.
	const contextBlock = buildContextBlock(options.uiContext);
	const firstEntry: AgentTranscriptEntry = {
		role: 'user',
		text: `${contextBlock}${questionText}`,
		...(images !== undefined ? { images } : {}),
	};

	// Prior turns (text-only) map onto plain transcript entries — no provider
	// change needed, and byte-identical resends keep the cache prefix warm.
	const transcript: AgentTranscriptEntry[] = [];
	for (const entry of options.history ?? []) {
		transcript.push(
			entry.role === 'user'
				? { role: 'user', text: entry.text }
				: {
						role: 'assistant',
						turn: { text: entry.text, tool_uses: [], stop_reason: 'end_turn' },
					},
		);
	}
	transcript.push(firstEntry);

	const tools = writeMode ? [...AGENT_TOOLS, PROPOSE_TOOL] : AGENT_TOOLS;
	const system =
		options.systemPrompt ??
		buildSystemPrompt({
			mode: writeMode ? 'write' : 'read',
			egress: options.egress?.external === true ? 'external' : 'local',
		});

	const usage: AgentTurnUsage = {};
	const addUsage = (turnUsage?: AgentTurnUsage) => {
		if (turnUsage === undefined) return;
		for (const key of ['input_tokens', 'output_tokens', 'cache_read_input_tokens'] as const) {
			const value = turnUsage[key];
			if (typeof value === 'number') usage[key] = (usage[key] ?? 0) + value;
		}
	};
	const historyOut = (answer: string): AgentHistoryEntry[] => [
		...(options.history ?? []),
		{ role: 'user', text: questionText },
		{ role: 'assistant', text: answer },
	];

	const runOne = async (use: {
		id: string;
		name: string;
		input: Record<string, unknown>;
	}): Promise<AgentToolResult> => {
		options.onEvent?.({
			type: 'tool_use',
			id: use.id,
			name: use.name,
			summary: summarizeToolArgs(use.input),
		});
		const result = await executeTool(principal, use.name, use.input, use.id, options.egress);
		options.onEvent?.({
			type: 'tool_result',
			id: use.id,
			name: use.name,
			ok: !result.is_error,
			...(result.is_error ? { code: extractErrorCode(result.content) } : {}),
		});
		return result;
	};

	for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
		options.onEvent?.({ type: 'iteration', n: iteration + 1, max: MAX_ITERATIONS });
		const turn = await provider.createTurn({ system, tools, transcript }, options.onEvent);
		addUsage(turn.usage);
		transcript.push({ role: 'assistant', turn });

		if (turn.stop_reason !== 'tool_use' || turn.tool_uses.length === 0) {
			return {
				answer: turn.text,
				transcript,
				stop: turn.stop_reason === 'tool_use' ? 'end_turn' : turn.stop_reason,
				usage,
				history: historyOut(turn.text),
			};
		}

		// A proposal ends the turn WITHOUT executing anything — validate it and
		// hand the resolved plan up for human confirmation. An invalid proposal
		// flows back as an is_error result so the model can repair it.
		const proposal = writeMode
			? turn.tool_uses.find((use) => use.name === 'propose_change_plan')
			: undefined;
		if (proposal !== undefined) {
			try {
				const validated = await validateChangePlan(principal, proposal.input, gates);
				const answer = turn.text !== '' ? turn.text : validated.summary;
				return {
					answer,
					transcript,
					stop: 'change_plan',
					change_plan: validated,
					usage,
					history: historyOut(answer),
				};
			} catch (error) {
				// Every tool_use of the turn needs a result (Messages-API contract):
				// the failed proposal becomes is_error; sibling READ calls execute.
				const results = await Promise.all(
					turn.tool_uses.map((use) =>
						use.id === proposal.id
							? Promise.resolve({
									tool_use_id: use.id,
									content: JSON.stringify(toStructuredErr(error)),
									is_error: true,
								})
							: runOne(use),
					),
				);
				transcript.push({ role: 'tool_results', results });
				continue;
			}
		}

		// Execute ALL requested tools (parallel-safe: every handler is read-only
		// and principal-scoped) and feed the results back as one entry.
		const results = await Promise.all(turn.tool_uses.map((use) => runOne(use)));
		transcript.push({ role: 'tool_results', results });
	}

	const cappedAnswer = 'Stopped: the agent reached its iteration cap before finishing.';
	return {
		answer: cappedAnswer,
		transcript,
		stop: 'max_iterations',
		usage,
		history: historyOut(cappedAnswer),
	};
}

/** Pull the envelope error code out of an is_error tool result (best effort). */
function extractErrorCode(content: string): string | undefined {
	try {
		const decoded = JSON.parse(content) as { error?: { code?: unknown } };
		return typeof decoded.error?.code === 'string' ? decoded.error.code : undefined;
	} catch {
		return undefined;
	}
}
