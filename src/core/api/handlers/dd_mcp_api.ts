/**
 * dd_mcp_api — the in-process HTTP bridge between the Dédalo web client's
 * assistant (tools/tool_assistant — TS-native since WC-013, server-driven)
 * and the shared MCP tool registry + agent loop (REWRITE_SPEC §8; work-system
 * MCP foundation Phase 5 + the assistant rewrite).
 *
 * Unlike the PHP oracle's dd_mcp_api (a cURL proxy to a separate MCP server
 * process), this handler serves the JSON-RPC envelope IN PROCESS from the same
 * `TOOL_REGISTRY` the stdio server registers — no child process, no cookie
 * forwarding, no wire to redact.
 *
 * Actions:
 *   mcp_proxy         — the exact legacy `mcp_client.js` contract (kept for
 *                       the PHP tree's tool_assistant copy + external
 *                       consumers): unwrap the JSON-RPC 2.0 envelope in
 *                       rqo.options; allowlisted methods only (initialize,
 *                       notifications/initialized, tools/list, tools/call).
 *                       `initialize` mints an `mcp_session_id`; every other
 *                       method REQUIRES it and a stale/missing id throws
 *                       `mcp.session_invalid`, whose registry message is the
 *                       LITERAL 'No valid MCP session ID provided' the
 *                       client's auto-recovery keys on. A JSON-RPC-level
 *                       failure (method not allowed, unknown tool) keeps the
 *                       JSON-RPC numeric code and carries the envelope-v2
 *                       error body in `error.data`.
 *   agent_models      — the client-safe model catalog projection (id, label,
 *                       egress class, vision) + whether write mode is
 *                       available to THIS principal. Never exposes endpoints,
 *                       key names, or provider-native model ids.
 *   agent_chat        — run the agent loop (question + optional images +
 *                       client-resent history + UI context + catalog model
 *                       choice) under the LOGGED-IN user's principal; write
 *                       mode returns a change plan for confirmation, it never
 *                       writes. JSON, single response.
 *   agent_chat_stream — the SSE twin of agent_chat (the new tool_assistant
 *                       chat): frames `start`/`thinking`/`text`/`tool_use`/
 *                       `tool_result`/`iteration`/`final`/`error` + `: ping`
 *                       heartbeats. Validation failures BEFORE the stream
 *                       opens are normal JSON failure envelopes (thrown, the
 *                       dispatch chokepoint converts; the client branches on
 *                       content-type). The terminal `error` frame's data is
 *                       the envelope-v2 error body (+ registry `hint`) —
 *                       engineering/ERRORS_SPEC.md §5. The response never
 *                       rotates the CSRF token. v1 limitation: a client abort
 *                       stops delivery, not the in-flight loop.
 *   agent_apply       — execute a confirmed change plan (hash-rechecked,
 *                       every gate re-validated) — the endpoint the plan
 *                       confirm card confirms into.
 *
 * EGRESS ("Memory projects"): the conversation's model comes from the
 * server-defined catalog (DEDALO_AGENT_MODELS); when its egress class is
 * 'external' the loop gates every record-content tool call through
 * src/ai/agent/egress.ts (default-deny) — restricted repository content never
 * reaches a third-party provider. The user's own question/images egress by
 * the user's act of picking an external model.
 *
 * Identity: every call runs as `context.principal` — the session user, NEVER
 * the stdio service principal (DEDALO_MCP_USER_ID plays no role here). Session
 * + CSRF gates apply normally (none of these actions is login- or
 * CSRF-exempt).
 *
 * ACCESS (closure Step 3, SEC-3): every action is behind `gateAgentActions` —
 * the switch below AND the caller's `tool_assistant` grant (their profile's
 * tool ACL; global admins included, only the superuser -1 holds every tool).
 *
 * Config (all fail-closed; see docs/administration/configuration/config.md#ai — the section anchor is a NAME,
 * never a number: the old "§12" pointed at a numbering the file never had):
 *   DEDALO_AGENT_HTTP_ENABLED=true   enables this API class's actions at all
 *                                    (and a granted profile is still required);
 *   DEDALO_AGENT_ALLOW_WRITE=true    exposes write tools + change plans;
 *   DEDALO_AGENT_WRITE_SECTIONS=a,b  narrows writable sections;
 *   DEDALO_AGENT_MODELS=[...]        the model catalog (unset ⇒ implicit
 *                                    Anthropic-only iff ANTHROPIC_API_KEY);
 *   DEDALO_AGENT_ALLOW_EXTERNAL_PROVIDER_DEFAULT=true opts record content
 *                                    into external-model conversations;
 *   DEDALO_AGENT_SYSTEM_PROMPT_APPEND adds boot-stable deployment prose.
 * Write capability is DENIED to global-admin principals per request — the
 * same confused-deputy wall the stdio server enforces at startup.
 *
 * The mcp_session_id is STATELESS: sha256("mcp:" + session.csrfToken). It is
 * valid exactly while that session lives; a recycled session yields a new id,
 * the old one fails with the literal message, and the client re-initializes
 * (its documented recovery path). No session schema, no module state.
 */

import { buildAgentEgressPolicy } from '../../../ai/agent/egress.ts';
import type { AgentImage } from '../../../ai/agent/llm_provider.ts';
import type {
	AgentHistoryEntry,
	AgentLoopEvent,
	AgentRunOptions,
	AgentRunResult,
} from '../../../ai/agent/loop.ts';
import {
	type CatalogModel,
	ModelCatalogError,
	modelTurnMaxTokens,
	publicModelList,
	resolveProvider,
} from '../../../ai/agent/model_catalog.ts';
import { type AgentUiContext, buildSystemPrompt } from '../../../ai/agent/system_prompt.ts';
import { asToolResult, ok as structuredOk } from '../../../ai/mcp/envelope.ts';
import {
	getToolSpec,
	type RegistryGates,
	registeredTools,
	runTool,
	toAgentToolDefinition,
} from '../../../ai/mcp/registry.ts';
import { readEnv } from '../../../config/env.ts';
import { readOptionalList } from '../../../config/readers.ts';
import {
	type ApiErrorBody,
	DedaloError,
	isDedaloError,
	logError,
	ok,
	toDedaloError,
	toErrorBody,
	toStreamFrame,
} from '../../errors/index.ts';
import { type AiSpendReservation, reserveAiSpend } from '../../security/ai_spend.ts';
import type { Principal } from '../../security/permissions.ts';
import type { Session } from '../../security/session_store.ts';
import { assertToolGranted } from '../../tools/security.ts';
import type { ActionHandler, ApiRequestContext } from '../handler_context.ts';
import { requirePrincipal } from '../handler_context.ts';

// The literal stale-session message js/mcp_client.js matches on —
// 'No valid MCP session ID provided' — is the REGISTRY message of
// `mcp.session_invalid` (src/core/errors/registry.ts; DO NOT EDIT it there;
// dd_mcp_api.test.ts asserts the literal). The handler throws the code.

/** JSON-RPC methods the bridge serves (the PHP proxy's allowlist, verbatim). */
const ALLOWED_METHODS: ReadonlySet<string> = new Set([
	'initialize',
	'notifications/initialized',
	'tools/list',
	'tools/call',
]);

/** Stateless per-session MCP session id (see module header). */
export function mcpSessionIdFor(session: Session): string {
	const hasher = new Bun.CryptoHasher('sha256');
	hasher.update(`mcp:${session.csrfToken}`);
	return hasher.digest('hex').slice(0, 32);
}

/** The per-request registry gates: write only when enabled AND not an admin. */
function requestGates(context: ApiRequestContext): RegistryGates {
	const principal = requirePrincipal(context);
	const allowWrite = readEnv('DEDALO_AGENT_ALLOW_WRITE') === 'true' && !principal.isGlobalAdmin;
	// readList, NOT a hand-rolled readEnv().split(','): the key is declared
	// `string_list` in the catalog, whose grammar is a JSON array OR a comma
	// list. The v6->v7 migration JSON-encodes v6 PHP arrays, so a raw split
	// would shred `["oh1","rsc197"]` into tokens like `["oh1"` that match no
	// section tipo — this allowlist would silently narrow to nothing.
	// readOptionalList, not readList: it is the ONLY reader that tells UNSET
	// (null -> no narrowing) apart from PRESENT-BUT-EMPTY ([] -> nothing
	// writable). Collapsing the two would silently open every section.
	const configuredSections = readOptionalList('DEDALO_AGENT_WRITE_SECTIONS');
	const writableSections = configuredSections === null ? undefined : new Set(configuredSections);
	return { allowWrite, writableSections };
}

/** The tool whose grant opens the agent door. */
const AGENT_TOOL = 'tool_assistant';

/**
 * THE AGENT DOOR (closure Step 3, SEC-3; WC-2026-09-30-agent-tool-grant) — ONE
 * check, in a fixed order, in front of EVERY action of this class:
 *
 *   1. the install switch — with DEDALO_AGENT_HTTP_ENABLED off every action
 *      answers exactly like an unregistered one (Gate 1's
 *      `request.unknown_action` + `details.action`), so a probe cannot learn the
 *      assistant exists — and nothing below leaks it either;
 *   2. an authenticated principal;
 *   3. the caller's PROFILE authorizes `tool_assistant` (`assertToolGranted` →
 *      `tool.not_authorized`). The assistant is a tool like any other: the
 *      toolbar already hid it from an ungranted profile, but the switch alone
 *      let every logged-in user run the agent loop (model spend, record reads
 *      through the MCP registry, change plans) and the raw MCP bridge. Global
 *      admins are NOT exempt — the tool ACL has no admin flag anywhere; only the
 *      superuser (-1) holds every tool.
 *
 * Out of scope by design: the stdio MCP server (ai/mcp/server.ts) runs as the
 * operator's configured service principal, not a web session.
 */
async function requireAgentAccess(action: string, context: ApiRequestContext): Promise<void> {
	if (readEnv('DEDALO_AGENT_HTTP_ENABLED') !== 'true') {
		throw new DedaloError('request.unknown_action', { details: { action } });
	}
	const principal = requirePrincipal(context);
	await assertToolGranted(principal, AGENT_TOOL);
}

/**
 * Wrap EVERY handler of the class in the agent door BY CONSTRUCTION: an action
 * added to the raw map below is gated without anyone remembering to call a
 * check (the switch used to be a per-handler call). The refusal is thrown
 * before the handler runs — so before `agent_chat_stream` opens its SSE
 * stream, and the client gets a JSON failure envelope.
 */
function gateAgentActions(raw: Record<string, ActionHandler>): Record<string, ActionHandler> {
	const gated: Record<string, ActionHandler> = {};
	for (const [action, handler] of Object.entries(raw)) {
		gated[action] = async (rqo, context) => {
			await requireAgentAccess(typeof rqo.action === 'string' ? rqo.action : action, context);
			return handler(rqo, context);
		};
	}
	return gated;
}

// ---------------------------------------------------------------------------
// agent_chat / agent_chat_stream shared option parsing (handler-level caps)
// ---------------------------------------------------------------------------

const QUESTION_MAX_CHARS = 32_768;
const HISTORY_MAX_ENTRIES = 64;
/**
 * EXPORTED — not for another caller, but because the parse door's per-key budget
 * for `options.history` (`OPTIONS_KEY_BUDGETS` in core/concepts/scalar_bounds.ts)
 * must never be TIGHTER than what this handler declares it accepts, and
 * `rqo_scalar_bound_tripwire` asserts that relation against these very
 * constants. Raising a cap here without raising the budget is then RED, not a
 * silent 400 in production.
 */
export const HISTORY_MAX_BYTES = 262_144;
const IMAGES_MAX = 8;
/** ≈ 5 MiB decoded per image (base64 is ~4/3 of the byte length). */
export const IMAGE_MAX_BASE64_CHARS = 7_000_000;
/** ≈ 15 MiB decoded across all attachments of one turn. */
export const IMAGES_MAX_TOTAL_BASE64_CHARS = 21_000_000;
const CONTEXT_SUMMARY_MAX_CHARS = 2_000;
const IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set([
	'image/jpeg',
	'image/png',
	'image/webp',
	'image/gif',
]);
const TIPO_SHAPE = /^[a-zA-Z0-9_]{1,64}$/;

interface ParsedChatOptions {
	question: string;
	images?: AgentImage[];
	modeRequested: 'read' | 'write';
	modelId?: string;
	history: AgentHistoryEntry[];
	uiContext?: AgentUiContext;
}

/** Parse + cap the chat options; returns an error MESSAGE on any violation. */
function parseAgentChatOptions(
	options: Record<string, unknown>,
): { ok: true; value: ParsedChatOptions } | { ok: false; message: string } {
	const question = typeof options.question === 'string' ? options.question : '';
	if (question === '') return { ok: false, message: 'a question is required' };
	if (question.length > QUESTION_MAX_CHARS) {
		return { ok: false, message: `question exceeds ${QUESTION_MAX_CHARS} chars` };
	}

	const history: AgentHistoryEntry[] = [];
	if (options.history !== undefined) {
		if (!Array.isArray(options.history)) return { ok: false, message: 'history must be an array' };
		if (options.history.length > HISTORY_MAX_ENTRIES) {
			return { ok: false, message: `history exceeds ${HISTORY_MAX_ENTRIES} entries` };
		}
		let bytes = 0;
		for (const entry of options.history) {
			const role = (entry as { role?: unknown }).role;
			const text = (entry as { text?: unknown }).text;
			if ((role !== 'user' && role !== 'assistant') || typeof text !== 'string') {
				return { ok: false, message: 'history entries must be {role:user|assistant, text}' };
			}
			bytes += text.length;
			history.push({ role, text });
		}
		if (bytes > HISTORY_MAX_BYTES) {
			return { ok: false, message: `history exceeds ${HISTORY_MAX_BYTES} bytes` };
		}
	}

	let images: AgentImage[] | undefined;
	if (options.images !== undefined) {
		if (!Array.isArray(options.images)) return { ok: false, message: 'images must be an array' };
		if (options.images.length > IMAGES_MAX) {
			return { ok: false, message: `images exceed ${IMAGES_MAX} attachments` };
		}
		images = [];
		let imageBytes = 0;
		for (const image of options.images) {
			const mediaType = (image as { media_type?: unknown }).media_type;
			const data = (image as { data_base64?: unknown }).data_base64;
			if (
				typeof mediaType !== 'string' ||
				!IMAGE_MEDIA_TYPES.has(mediaType) ||
				typeof data !== 'string' ||
				data === ''
			) {
				return { ok: false, message: 'images must be {media_type: image/*, data_base64}' };
			}
			// Size caps: the global body limit (SERVER_MAX_BODY_BYTES, 256 MiB) is
			// far too generous for a chat turn — an uncapped attachment is a cost
			// and DoS vector on the provider leg. Base64 length ≈ 4/3 of bytes.
			if (data.length > IMAGE_MAX_BASE64_CHARS) {
				return { ok: false, message: `an image exceeds ${IMAGE_MAX_BASE64_CHARS} base64 chars` };
			}
			imageBytes += data.length;
			if (imageBytes > IMAGES_MAX_TOTAL_BASE64_CHARS) {
				return {
					ok: false,
					message: `images exceed ${IMAGES_MAX_TOTAL_BASE64_CHARS} total base64 chars`,
				};
			}
			images.push({ media_type: mediaType as never, data_base64: data });
		}
	}

	let uiContext: AgentUiContext | undefined;
	if (options.context !== undefined && options.context !== null) {
		const raw = options.context as Record<string, unknown>;
		uiContext = {};
		if (typeof raw.section_tipo === 'string' && TIPO_SHAPE.test(raw.section_tipo)) {
			uiContext.section_tipo = raw.section_tipo;
		}
		// NOT a locator comparison — a shape check on the client-sent UI context
		// (the value is rendered into a prompt block, never matched against a
		// stored locator). Bound to a local first so the shape stays out of the
		// locator-law ratchet's inline-matcher patterns (ws_a_tripwires).
		// The door canonicalizes to INT: the digits check already excludes the
		// synthetic tokens and external remote ids that carry no address to render
		// (WC-2026-08-10-section-id-int-canonical).
		const rawSectionId = raw.section_id;
		if (typeof rawSectionId === 'number' || typeof rawSectionId === 'string') {
			const id = String(rawSectionId);
			if (/^[0-9]{1,12}$/.test(id)) uiContext.section_id = Number(id);
		}
		if (typeof raw.component_tipo === 'string' && TIPO_SHAPE.test(raw.component_tipo)) {
			uiContext.component_tipo = raw.component_tipo;
		}
		if (typeof raw.mode === 'string' && /^[a-z_]{1,16}$/.test(raw.mode)) {
			uiContext.mode = raw.mode;
		}
		if (typeof raw.summary === 'string' && raw.summary !== '') {
			uiContext.summary = raw.summary.slice(0, CONTEXT_SUMMARY_MAX_CHARS);
		}
	}

	const modelId =
		typeof options.model === 'string' && options.model !== '' ? options.model : undefined;

	return {
		ok: true,
		value: {
			question,
			...(images !== undefined ? { images } : {}),
			modeRequested: options.mode === 'write' ? 'write' : 'read',
			...(modelId !== undefined ? { modelId } : {}),
			history,
			...(uiContext !== undefined ? { uiContext } : {}),
		},
	};
}

/**
 * Resolve the conversation setup shared by agent_chat and agent_chat_stream:
 * catalog model + provider, effective mode, egress posture, system prompt,
 * and the runAgent options. Throws ModelCatalogError (a public `ai.*` code)
 * for catalog problems — the dispatch chokepoint converts it.
 */
function buildAgentRun(
	parsed: ParsedChatOptions,
	gates: RegistryGates,
): {
	model: CatalogModel;
	provider: ReturnType<typeof resolveProvider>['provider'];
	mode: 'read' | 'write';
	runOptions: AgentRunOptions;
} {
	const { model, provider } = resolveProvider(parsed.modelId);
	if (parsed.images !== undefined && parsed.images.length > 0 && !model.vision) {
		throw new ModelCatalogError('ai.model_no_vision', `model "${model.id}" does not accept images`);
	}
	const mode = parsed.modeRequested === 'write' && gates.allowWrite === true ? 'write' : 'read';
	const external = model.egress === 'external';
	const runOptions: AgentRunOptions = {
		mode,
		writableSections: gates.writableSections,
		history: parsed.history,
		...(parsed.uiContext !== undefined ? { uiContext: parsed.uiContext } : {}),
		egress: { external, policy: buildAgentEgressPolicy() },
		systemPrompt: buildSystemPrompt({
			mode,
			egress: external ? 'external' : 'local',
			deploymentAppend: readEnv('DEDALO_AGENT_SYSTEM_PROMPT_APPEND'),
		}),
	};
	return { model, provider, mode, runOptions };
}

/**
 * Classify a failure of the RUNNING agent loop for the stream's terminal frame.
 *
 * A DedaloError (a catalog refusal, a typed engine failure) passes through —
 * its code decides what the client renders. Anything else is a
 * provider/transport error whose text carries config internals — the
 * Anthropic provider names the env KEY it wanted; the OpenAI-compatible one
 * embeds up to 300 chars of the upstream body — so it becomes
 * `ai.provider_failed` with the original as log-only `cause`. Logged here
 * (the stream has no dispatch catch to do it), never echoed.
 */
function agentRunError(error: unknown, requestId: string): DedaloError {
	const typed = isDedaloError(error)
		? error
		: new DedaloError('ai.provider_failed', {
				cause: error,
				message: toDedaloError(error).message,
			});
	logError(typed, { subsystem: 'dd_mcp_api::agent_chat_stream', requestId });
	return typed;
}

/**
 * The agent stream's terminal `event: error` DATA: the envelope-v2 error body
 * (`code`, `message`, `label_key`, `retryable`, `details?`) plus the registry
 * `hint` — the same object `toStreamFrame` wraps; the SSE event name already
 * says "terminal", so the frame is the body itself (ERRORS_SPEC §5).
 */
function agentErrorFrame(typed: DedaloError): ApiErrorBody & { hint?: string } {
	const body = toStreamFrame(typed).error;
	const hint = typed.spec.hint;
	return hint === undefined ? body : { ...body, hint };
}

/** Bounded display/audit projection of the run transcript (never provider-raw). */
function transcriptSummary(run: AgentRunResult): Record<string, unknown>[] {
	const cap = (text: string) => (text.length > 500 ? `${text.slice(0, 499)}…` : text);
	return run.transcript.map((entry) => {
		if (entry.role === 'user') return { role: 'user', text: cap(entry.text) };
		if (entry.role === 'assistant') {
			return {
				role: 'assistant',
				text: cap(entry.turn.text),
				...(entry.turn.tool_uses.length > 0
					? { tool_calls: entry.turn.tool_uses.map((use) => use.name) }
					: {}),
			};
		}
		return { role: 'tool_results', ok: entry.results.map((result) => !result.is_error) };
	});
}

/**
 * THE AGENT RUN IS METERED (closure Step 3, TOOLS-4; WC-2026-10-01-ai-spend-budget):
 * one run + the run's token reservation (the most output it can produce,
 * `agentRunTokenReservation`) are RESERVED against the caller's daily ledger
 * BEFORE the provider is touched — before `agent_chat_stream` opens its SSE
 * stream, so a refusal (`ai.budget_exhausted`, 429) is a JSON envelope. The
 * caller settles with the run's reported usage in `finally`.
 */
async function reserveAgentRun(
	principal: Principal,
	door: string,
	model: CatalogModel,
	agentRunTokenReservation: (maxTokensPerTurn: number) => number,
): Promise<AiSpendReservation> {
	return reserveAiSpend(principal, {
		door,
		runs: 1,
		tokens: agentRunTokenReservation(modelTurnMaxTokens(model)),
	});
}

/** Build a JSON-RPC 2.0 success body. */
function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
	return { jsonrpc: '2.0', id: id ?? null, result };
}

/**
 * Build a JSON-RPC 2.0 error body. The JSON-RPC layer keeps ITS numeric codes
 * (-32601 method not found, -32602 invalid params for a caller-category
 * failure, -32603 otherwise); the envelope-v2 error body rides in `error.data`
 * so the client has the registry code and label beside the RPC number.
 */
function rpcError(id: unknown, rpcCode: number, error: DedaloError): Record<string, unknown> {
	const data = toErrorBody(error);
	return { jsonrpc: '2.0', id: id ?? null, error: { code: rpcCode, message: data.message, data } };
}

/** JSON-RPC number for a typed failure: caller faults are invalid params, the rest internal. */
function rpcCodeFor(error: DedaloError): number {
	return error.spec.category === 'caller' ? -32602 : -32603;
}

/** The class's actions — each one behind the agent door (gateAgentActions). */
export const mcpApiActions: Record<string, ActionHandler> = gateAgentActions({
	/** The mcp_client.js JSON-RPC bridge (contract documented in the header). */
	mcp_proxy: async (rqo, context) => {
		const principal = requirePrincipal(context);
		const session = context.session as Session;
		const envelope = (rqo.options ?? {}) as {
			jsonrpc?: unknown;
			method?: unknown;
			params?: unknown;
			id?: unknown;
		};
		const method = typeof envelope.method === 'string' ? envelope.method : '';
		if (!ALLOWED_METHODS.has(method)) {
			const refused = new DedaloError('request.invalid', {
				publicMessage: `Method not allowed: ${method}`,
			});
			return {
				status: 200,
				body: ok(rpcError(envelope.id, -32601, refused), { requestId: context.requestId }),
			};
		}

		// initialize mints the (stateless) session id; everything else needs it.
		const expectedId = mcpSessionIdFor(session);
		if (method === 'initialize') {
			return {
				status: 200,
				body: ok(
					rpcResult(envelope.id, {
						protocolVersion: '2025-03-26',
						capabilities: { tools: {} },
						serverInfo: { name: 'dedalo-core', version: '0.0.1' },
					}),
					// mcp_session_id is the one extension key the client reads by name.
					{ requestId: context.requestId, extend: { mcp_session_id: expectedId } },
				),
			};
		}
		const sentId = (rqo as { mcp_session_id?: unknown }).mcp_session_id;
		if (typeof sentId !== 'string' || sentId !== expectedId) {
			// `mcp.session_invalid`: its registry message IS the literal the client's
			// stale-session recovery matches on — envelope v2, converted at the
			// dispatch chokepoint.
			throw new DedaloError('mcp.session_invalid');
		}

		if (method === 'notifications/initialized') {
			// Fire-and-forget acknowledgement (no JSON-RPC id, no result body).
			return { status: 200, body: ok({}, { requestId: context.requestId }) };
		}

		const gates = requestGates(context);
		if (method === 'tools/list') {
			const tools = registeredTools(gates).map((spec) => {
				const definition = toAgentToolDefinition(spec);
				return {
					name: definition.name,
					description: definition.description,
					inputSchema: definition.input_schema,
					annotations: spec.annotations,
				};
			});
			return {
				status: 200,
				body: ok(rpcResult(envelope.id, { tools }), { requestId: context.requestId }),
			};
		}

		// tools/call — the LOGGED-IN user's principal, the registry chokepoint.
		const params = (envelope.params ?? {}) as { name?: unknown; arguments?: unknown };
		const toolName = typeof params.name === 'string' ? params.name : '';
		const spec = getToolSpec(toolName);
		// A write tool on a read-only surface is refused by runTool with a coded
		// envelope; an unknown tool is a JSON-RPC error (the client throws it).
		if (spec === undefined) {
			const refused = new DedaloError('request.invalid', {
				publicMessage: `Unknown tool: ${toolName}`,
			});
			return {
				status: 200,
				body: ok(rpcError(envelope.id, rpcCodeFor(refused), refused), {
					requestId: context.requestId,
				}),
			};
		}
		const structured = await runTool(spec, principal, params.arguments ?? {}, gates);
		return {
			status: 200,
			body: ok(rpcResult(envelope.id, asToolResult(structured)), {
				requestId: context.requestId,
			}),
		};
	},

	/** The client-safe model catalog + write availability for THIS principal. */
	agent_models: async (_rqo, context) => {
		requirePrincipal(context);
		const gates = requestGates(context);
		// A broken catalog THROWS ModelCatalogError (public `ai.*` code): the
		// assistant is disabled with the operator's own sentence on the wire.
		return {
			status: 200,
			body: ok(
				{ models: publicModelList(), write_allowed: gates.allowWrite === true },
				{ requestId: context.requestId },
			),
		};
	},

	/** Run the agent loop as the logged-in user (vision-capable, never writes). */
	agent_chat: async (rqo, context) => {
		const principal = requirePrincipal(context);
		const parsed = parseAgentChatOptions((rqo.options ?? {}) as Record<string, unknown>);
		if (!parsed.ok) {
			throw new DedaloError('request.invalid', { publicMessage: `agent_chat: ${parsed.message}` });
		}
		const gates = requestGates(context);

		const { runAgent, agentRunTokenReservation, reportedRunTokens } = await import(
			'../../../ai/agent/loop.ts'
		);
		// Catalog/config problems throw a public `ai.*` code — dispatch converts.
		const setup = buildAgentRun(parsed.value, gates);
		const reservation = await reserveAgentRun(
			principal,
			'dd_mcp_api.agent_chat',
			setup.model,
			agentRunTokenReservation,
		);
		let run: AgentRunResult | undefined;
		try {
			run = await runAgent(
				principal,
				parsed.value.images !== undefined
					? { text: parsed.value.question, images: parsed.value.images }
					: parsed.value.question,
				setup.provider,
				setup.runOptions,
			);
		} finally {
			// A failed run reports nothing: the reservation stays charged.
			await reservation.settle({ tokens: reportedRunTokens(run?.usage) ?? undefined });
		}
		return {
			status: 200,
			body: ok(
				{
					answer: run.answer,
					stop: run.stop,
					change_plan: run.change_plan ?? null,
					turns: run.transcript.length,
					model: setup.model.id,
					usage: run.usage,
					history: run.history,
				},
				{ requestId: context.requestId },
			),
		};
	},

	/**
	 * The SSE twin of agent_chat — the new tool_assistant chat surface.
	 * Validation failures BEFORE the stream opens are thrown (normal JSON
	 * failure envelopes; the client branches on the response content-type).
	 */
	agent_chat_stream: async (rqo, context) => {
		const principal = requirePrincipal(context);
		const parsed = parseAgentChatOptions((rqo.options ?? {}) as Record<string, unknown>);
		if (!parsed.ok) {
			throw new DedaloError('request.invalid', {
				publicMessage: `agent_chat_stream: ${parsed.message}`,
			});
		}
		const gates = requestGates(context);

		const { runAgent, agentRunTokenReservation, reportedRunTokens } = await import(
			'../../../ai/agent/loop.ts'
		);
		const setup = buildAgentRun(parsed.value, gates);
		const { model, provider, mode, runOptions } = setup;
		// Reserved HERE, before the stream exists: a refusal is a JSON envelope.
		const reservation = await reserveAgentRun(
			principal,
			'dd_mcp_api.agent_chat_stream',
			model,
			agentRunTokenReservation,
		);
		const requestId = context.requestId;
		const parsedValue = parsed.value;

		const encoder = new TextEncoder();
		// Request-scoped state only (module_state discipline).
		let closed = false;
		let heartbeatHandle: ReturnType<typeof setInterval> | undefined;
		const stream = new ReadableStream<Uint8Array>({
			cancel() {
				// Client went away: stop delivering + heartbeating (the in-flight
				// loop still runs to completion — documented v1 limitation).
				closed = true;
				if (heartbeatHandle !== undefined) clearInterval(heartbeatHandle);
			},
			start(controller) {
				const send = (event: string, payload: unknown) => {
					if (closed) return;
					try {
						controller.enqueue(
							encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`),
						);
					} catch {
						closed = true; // client went away — stop delivering (loop still finishes; v1)
					}
				};
				// Assigned to the OUTER handle so cancel() can actually clear it.
				const heartbeat = setInterval(() => {
					if (closed) return;
					try {
						controller.enqueue(encoder.encode(': ping\n\n'));
					} catch {
						closed = true;
					}
				}, 15_000);
				heartbeatHandle = heartbeat;

				send('start', { model: model.id, mode, egress: model.egress });

				const onEvent = (event: AgentLoopEvent) => {
					switch (event.type) {
						case 'text_delta':
							send('text', { delta: event.text });
							break;
						case 'thinking':
							send('thinking', { state: event.state });
							break;
						case 'tool_use':
							send('tool_use', { id: event.id, name: event.name, summary: event.summary });
							break;
						case 'tool_result':
							send('tool_result', {
								id: event.id,
								name: event.name,
								ok: event.ok,
								code: event.code ?? null,
							});
							break;
						case 'iteration':
							send('iteration', { n: event.n, max: event.max });
							break;
						default:
							break; // tool_input_start etc. — the loop's tool_use event follows
					}
				};

				void (async () => {
					let run: AgentRunResult | undefined;
					try {
						run = await runAgent(
							principal,
							parsedValue.images !== undefined
								? { text: parsedValue.question, images: parsedValue.images }
								: parsedValue.question,
							provider,
							{ ...runOptions, onEvent },
						);
						send('final', {
							answer: run.answer,
							stop: run.stop,
							change_plan: run.change_plan ?? null,
							history: run.history,
							transcript_summary: transcriptSummary(run),
							usage: run.usage,
							turns: run.transcript.length,
							model: model.id,
						});
					} catch (error) {
						send('error', agentErrorFrame(agentRunError(error, requestId)));
					} finally {
						// The loop runs to completion even after a client cancel, so the
						// settlement always sees the whole run's reported usage.
						await reservation.settle({ tokens: reportedRunTokens(run?.usage) ?? undefined });
						clearInterval(heartbeat);
						closed = true;
						try {
							controller.close();
						} catch {
							// already closed by a client cancel — nothing to do
						}
					}
				})();
			},
		});

		return {
			status: 200,
			// The stream is the body; the JSON envelope is never sent (streamHeaders win).
			body: ok(null, { requestId: context.requestId }),
			stream,
			streamHeaders: {
				'Content-Type': 'text/event-stream; charset=utf-8',
				'Cache-Control': 'no-cache, must-revalidate',
				'X-Accel-Buffering': 'no',
			},
		};
	},

	/** Execute a HUMAN-CONFIRMED change plan (hash recheck + full re-validation). */
	agent_apply: async (rqo, context) => {
		const principal = requirePrincipal(context);
		const options = (rqo.options ?? {}) as { plan?: unknown; plan_hash?: unknown };
		if (typeof options.plan_hash !== 'string' || options.plan === undefined) {
			throw new DedaloError('request.invalid', {
				publicMessage: 'agent_apply: plan and plan_hash are required',
			});
		}
		const gates = requestGates(context);
		const { applyChangePlan } = await import('../../../ai/agent/change_plan.ts');
		// A plan refused as a WHOLE (write opt-in, hash, validation) THROWS — the
		// failure envelope carries its code; a plan that ran and stopped on an
		// op is a REPORT (applied/failed/skipped) and rides as `data`, wrapped
		// as the MCP structured envelope the plan-confirm card reads.
		const report = await applyChangePlan(principal, options.plan, options.plan_hash, gates);
		return { status: 200, body: ok(structuredOk(report), { requestId: context.requestId }) };
	},
});
