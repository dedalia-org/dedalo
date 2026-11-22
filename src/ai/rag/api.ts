/**
 * dd_rag_api — the native TS action handlers for the RAG retrieval API (Brick 4;
 * reference `src/ai/rag2/src/rag_api_handler.ts`). Registered in the static
 * ACTION_REGISTRY (core/api/dispatch.ts) as the `dd_rag_api` class, so the
 * class+action allowlist (spec §7.1) admits exactly these actions and no others.
 *
 * Actions (params in rqo.options; retrieval actions also accept `group` — an
 * embed-group facet filter, see config.ts):
 *   semantic_search  { query, section_tipo?, limit?, group? } → best record per hit
 *   retrieve         { query, section_tipo?, limit?, group? } → passages (chunks)
 *   get_agent_context{ query, section_tipo?, limit?, group? } → passages (LLM context)
 *   similar_to       { section_tipo, section_id, limit?, group? } → records like a seed
 *   ask              { query, section_tipo?, limit? }   → grounded cited answer
 *   embed_groups     { section_tipo }                   → the section's embed-group ids
 *   similar_objects / search_by_text_image / characterize_object → image layer
 *     (additionally gated by DEDALO_RAG_MEDIA_ENABLED)
 *
 * Security: every action requires a session (not in NO_LOGIN_ACTIONS) and is
 * CSRF-gated by the dispatcher; the RESULTS are ACL-gated inside retrieval.ts
 * (schema ACL + per-record projects filter — the DoD chokepoint). The global
 * DEDALO_RAG_ENABLED kill-switch declines every action when off — EXCEPT
 * embed_groups, the capability probe, which answers `{groups: []}` instead
 * (see its doc block: a refusal there is a red alert nobody asked for).
 *
 * SPEND (closure Step 3, TOOLS-4; WC-2026-10-01-ai-spend-budget): every action
 * that calls a model is METERED against the caller's daily ledger
 * (core/security/ai_spend.ts) after its request is validated and BEFORE the
 * provider is touched — one query embedding for semantic_search / retrieve /
 * get_agent_context / search_by_text_image; one run + its token reservation +
 * one embedding for `ask`, which is also GRANTED (`tool_rag`: the generative
 * answer is a tool, the retrievals are core search and stay ungranted).
 * similar_to / similar_objects / characterize_object reuse STORED vectors and
 * call no model, so they spend nothing; embed_groups is the capability probe.
 *
 * Types are imported from response.ts (not dispatch.ts) to avoid an import cycle
 * with the registry that mounts these handlers.
 */

import { config } from '../../config/config.ts';
import { envSnapshot } from '../../config/env.ts';
import { readString } from '../../config/readers.ts';
import type { ApiResult } from '../../core/api/response.ts';
import { isValidTipo } from '../../core/concepts/ontology.ts';
import type { Rqo } from '../../core/concepts/rqo.ts';
import { DedaloError, ok } from '../../core/errors/index.ts';
import { chargeAiSpend, reserveAiSpend } from '../../core/security/ai_spend.ts';
import {
	getPermissions,
	type Principal,
	resolvePrincipal,
} from '../../core/security/permissions.ts';
import { assertToolGranted } from '../../core/tools/security.ts';
import { RESTRICTED_MSG, runAsk } from './ask.ts';
import {
	askRuntimeConfigFromEnv,
	buildContributorEgressPolicy,
	buildEgressPolicy,
	buildLlmProvider,
	buildSystemPromptResolver,
	defaultRagEnv,
} from './ask_config.ts';
import { RagCharacterizer } from './characterizer.ts';
import { defaultOntologyPort, RagConfig } from './config.ts';
import { storedThumbUrl } from './image_source.ts';
import {
	buildMultimodalProvider,
	isMediaEnabled,
	type MultimodalRuntimeConfig,
	multimodalConfigFromEnv,
} from './multimodal_config.ts';
import { ObjectRetrieval, type SimilarityMode } from './object_retrieval.ts';
import { isRagEnabled } from './rag_enabled.ts';
import { PassThroughReranker } from './reranker.ts';
import { type RagSearchHit, retrievePassages, semanticSearch, similarTo } from './retrieval.ts';
import { buildRoleReader } from './role_reader.ts';
import type { Candidate } from './types.ts';

/** The slice of the request context the RAG handlers read (structural). */
interface RagApiContext {
	requestId: string;
	session: { userId: number } | null;
	principal?: Principal;
}

const MAX_TOP_K = 50;

/** Clamp a client-supplied limit to PHP's [1, 50] with a default of 10. */
function clampTopK(value: unknown): number {
	const n = typeof value === 'number' ? value : Number(value);
	if (!Number.isFinite(n)) return 10;
	return Math.max(1, Math.min(MAX_TOP_K, Math.trunc(n)));
}

function optionString(options: Record<string, unknown> | undefined, key: string): string {
	const value = options?.[key];
	return typeof value === 'string' ? value.trim() : '';
}

/** Read an optional section-tipo scope (accepts a string or string[]). */
function optionScope(options: Record<string, unknown> | undefined): string[] | undefined {
	const value = options?.section_tipo;
	if (typeof value === 'string' && value !== '') return [value];
	if (Array.isArray(value)) {
		const out = value.filter((x): x is string => typeof x === 'string' && x !== '');
		if (out.length > 0) return out;
	}
	return undefined;
}

/**
 * Read the optional embed-group facet filter ("only transcriptions", "similar
 * by profession"). Validated against the group-id slug grammar — the value
 * becomes a bound `component_tipo = 'rag:'+group` filter, never raw SQL.
 */
function optionGroup(options: Record<string, unknown> | undefined): string | undefined {
	const value = options?.group;
	if (typeof value !== 'string') return undefined;
	const trimmed = value.trim();
	return /^[a-z0-9][a-z0-9_-]{0,39}$/.test(trimmed) ? trimmed : undefined;
}

/**
 * The ok envelope. `msg` is the RAG outcome token the client/tests read
 * (`ok` | `agent_context` | `no_grounded_context` | RESTRICTED_MSG) — an
 * extension key, never a failure signal (a refusal is a THROW below).
 */
function envelope(data: unknown, msg: string, context: RagApiContext): ApiResult {
	return { status: 200, body: ok(data, { requestId: context.requestId, extend: { msg } }) };
}

/**
 * The master kill-switch refusal: every action declines first — except
 * embed_groups, which ANSWERS empty instead (a capability probe is not an act).
 */
const disabled = (): never => {
	throw new DedaloError('rag.disabled');
};
/** A caller-authored option the handler refuses (public: the sentence names the field). */
const badRequest = (sentence: string): never => {
	throw new DedaloError('request.invalid_options', { publicMessage: sentence });
};
/** No principal on the context — the dispatch auth gate guarantees one; this is the backstop. */
const noPrincipal = (): never => {
	throw new DedaloError('auth.not_logged');
};

/** Resolve the caller's authorization identity (session guaranteed by dispatch). */
async function resolveCaller(context: RagApiContext): Promise<Principal | null> {
	if (context.principal) return context.principal;
	if (context.session) return resolvePrincipal(context.session.userId);
	return null;
}

/** semantic_search / (shared record-shape response). */
async function recordSearch(rqo: Rqo, context: RagApiContext): Promise<ApiResult> {
	if (!isRagEnabled()) return disabled();
	const principal = await resolveCaller(context);
	if (principal === null) return noPrincipal();
	const query = optionString(rqo.options, 'query');
	if (query === '') return badRequest('Missing query');
	await chargeAiSpend(principal, { door: 'dd_rag_api.semantic_search', embeds: 1 });
	const hits = await semanticSearch(
		principal,
		query,
		clampTopK(rqo.options?.limit),
		optionScope(rqo.options),
		optionGroup(rqo.options),
	);
	return envelope(hits, 'ok', context);
}

/** retrieve / get_agent_context (shared passage-shape response). */
async function passageSearch(
	rqo: Rqo,
	context: RagApiContext,
	msg: string,
	door: string,
): Promise<ApiResult> {
	if (!isRagEnabled()) return disabled();
	const principal = await resolveCaller(context);
	if (principal === null) return noPrincipal();
	const query = optionString(rqo.options, 'query');
	if (query === '') return badRequest('Missing query');
	await chargeAiSpend(principal, { door, embeds: 1 });
	const passages = await retrievePassages(
		principal,
		query,
		clampTopK(rqo.options?.limit),
		optionScope(rqo.options),
		optionGroup(rqo.options),
	);
	return envelope(passages, msg, context);
}

/** similar_to (records similar to a seed). */
async function similarToAction(rqo: Rqo, context: RagApiContext): Promise<ApiResult> {
	if (!isRagEnabled()) return disabled();
	const principal = await resolveCaller(context);
	if (principal === null) return noPrincipal();
	const sectionTipo = optionString(rqo.options, 'section_tipo');
	const sectionIdRaw = rqo.options?.section_id;
	const sectionId = typeof sectionIdRaw === 'number' ? sectionIdRaw : Number(sectionIdRaw);
	if (sectionTipo === '' || !Number.isFinite(sectionId) || sectionId < 1) {
		return badRequest('Missing or invalid seed (section_tipo, section_id)');
	}
	const hits: RagSearchHit[] = await similarTo(
		principal,
		sectionTipo,
		sectionId,
		clampTopK(rqo.options?.limit),
		optionScope(rqo.options),
		optionGroup(rqo.options),
	);
	return envelope(hits, 'ok', context);
}

/**
 * embed_groups — the section's embed-group ids (the client's facet selector +
 * its "is this section semantic-searchable" gate). This is the ONE action the
 * client fires WITHOUT a user asking for anything (every section list render),
 * so it is the one action the kill-switch answers instead of refusing: a
 * disabled install is a CAPABILITY fact, and a refusal here painted a red
 * per-navigation alert on installs that deliberately never implemented RAG
 * (the operator is told at boot instead — bootstrap.ts). RAG off therefore
 * joins the other empty cases: a malformed tipo, a section the CALLER cannot
 * read, and a section without a rag.embed descriptor ALL return the same
 * `{groups: []}` — byte-identical on purpose, so the gate is never a
 * section-existence oracle (sec review #1; mirrors mcp discovery's not_found
 * shape). Every OTHER action still declines: those need an explicit user act.
 */
async function embedGroupsAction(rqo: Rqo, context: RagApiContext): Promise<ApiResult> {
	// Answered before the principal resolves: a disabled install touches nothing.
	if (!isRagEnabled()) return envelope({ groups: [] }, 'ok', context);
	const principal = await resolveCaller(context);
	if (principal === null) return noPrincipal();
	const sectionTipo = optionString(rqo.options, 'section_tipo');
	if (sectionTipo === '' || !isValidTipo(sectionTipo)) {
		return envelope({ groups: [] }, 'ok', context);
	}
	// Per-section read permission — denial is indistinguishable from "not opted in".
	if ((await getPermissions(principal, sectionTipo, sectionTipo)) < 1) {
		return envelope({ groups: [] }, 'ok', context);
	}
	const ragConfig = new RagConfig(defaultOntologyPort());
	const groups = await ragConfig.getEmbedGroups(sectionTipo);
	return envelope({ groups: groups.map((g) => g.id) }, 'ok', context);
}

/** The tool whose grant opens the GENERATIVE answer (retrieval is core search, ungranted). */
export const GENERATIVE_RAG_TOOL = 'tool_rag';

/** ask — grounded Q&A with citations (or a refusal when no context is found). */
async function askAction(rqo: Rqo, context: RagApiContext): Promise<ApiResult> {
	if (!isRagEnabled()) return disabled();
	const principal = await resolveCaller(context);
	if (principal === null) return noPrincipal();
	// GRANTED before anything else is read: an ungranted caller learns nothing
	// from the validation below (the agent door's order).
	await assertToolGranted(principal, GENERATIVE_RAG_TOOL);
	const query = optionString(rqo.options, 'query');
	if (query === '') return badRequest('Missing query');

	const env = defaultRagEnv();
	const cfg = askRuntimeConfigFromEnv(env);
	const ragConfig = new RagConfig(defaultOntologyPort());
	// METERED: the model run (its most input + output: the context budget and the
	// output cap) is reserved FIRST, so an exhausted run budget refuses before the
	// query is embedded; then the retrieval's one embedding is charged.
	const reservation = await reserveAiSpend(principal, {
		door: 'dd_rag_api.ask',
		runs: 1,
		tokens: cfg.contextTokenBudget + cfg.maxOutputTokens,
	});
	try {
		await chargeAiSpend(principal, { door: 'dd_rag_api.ask', embeds: 1 });
	} catch (error) {
		await reservation.release();
		throw error;
	}
	let modelCalled = true;
	let reportedTokens: number | undefined;
	try {
		const result = await runAsk(
			{
				principal,
				query,
				sectionTipos: optionScope(rqo.options) ?? [],
				topK: clampTopK(rqo.options?.limit),
			},
			{
				llm: buildLlmProvider(env),
				reranker: new PassThroughReranker(),
				egress: buildEgressPolicy(cfg),
				contributorEgress: buildContributorEgressPolicy(cfg),
				systemPrompt: buildSystemPromptResolver(ragConfig, env),
				contextTokenBudget: cfg.contextTokenBudget,
				maxOutputTokens: cfg.maxOutputTokens,
				// A configured HTTP endpoint egresses off-box; the egress gate blocks
				// it for restricted-section passages. The stub (no endpoint) is local.
				llmIsExternal: Boolean(env.DEDALO_RAG_LLM_ENDPOINT),
			},
		);
		// Both refusals are NORMAL envelopes (no external model was called): a
		// grounding miss vs. an egress-restricted record.
		modelCalled = result.grounded;
		reportedTokens = askUsageTokens(result.usage);
		const status = result.grounded
			? 'ok'
			: result.restricted
				? RESTRICTED_MSG
				: 'no_grounded_context';
		return envelope(result, status, context);
	} catch (error) {
		// A TYPED REFUSAL IS ALREADY THE RIGHT ANSWER — pass it through unwrapped.
		//
		// This catch exists so an LLM transport/protocol failure becomes
		// `rag.generation_failed` rather than a fabricated answer, with the raw error
		// as LOG-ONLY cause. It used to wrap EVERYTHING, which quietly defeated the
		// one refusal it most needed to preserve: `rag.embedding_unavailable` (503,
		// retryable, "the embedding sidecar did not answer") arrived at the operator
		// as `rag.generation_failed` (500, "the answer generator failed") — the same
		// outage reported against the wrong subsystem, on the one action where a
		// curator is most likely to be reading. Found by adversarial review
		// 2026-08-30, after P1-14 added that refusal and the manual documented it on
		// an action that could never raise it.
		//
		// A DedaloError is already closed-registry, already carries its disclosure
		// level, and was thrown deliberately; re-labelling it can only ever lose
		// information.
		if (error instanceof DedaloError) throw error;
		throw new DedaloError('rag.generation_failed', { cause: error });
	} finally {
		// No model call (a grounding miss, an egress refusal) refunds the run; a
		// call settles on its reported usage — none reported keeps the reservation.
		if (modelCalled) await reservation.settle({ tokens: reportedTokens });
		else await reservation.release();
	}
}

/** The answer's reported usage as one token count, or undefined when none was reported. */
function askUsageTokens(usage: { inputTokens?: number; outputTokens?: number } | undefined) {
	const parts = [usage?.inputTokens, usage?.outputTokens].filter(
		(value): value is number => typeof value === 'number' && Number.isFinite(value),
	);
	return parts.length === 0 ? undefined : parts.reduce((sum, value) => sum + value, 0);
}

// ─────────────────────────────── multimodal (images) ───────────────────────────────

const mediaDisabled = (): never => {
	throw new DedaloError('rag.media_disabled');
};

function readSeed(options: Record<string, unknown> | undefined): {
	sectionTipo: string;
	sectionId: number;
} | null {
	const sectionTipo = optionString(options, 'section_tipo');
	const raw = options?.section_id;
	const sectionId = typeof raw === 'number' ? raw : Number(raw);
	if (sectionTipo === '' || !Number.isFinite(sectionId) || sectionId < 1) return null;
	return { sectionTipo, sectionId };
}

/**
 * Candidate → API object shape (similarity = 1 - distance, view from chunk_meta,
 * thumb DERIVED from the stored identity — image_source.storedThumbUrl).
 */
export function shapeObject(candidate: Candidate): Record<string, unknown> {
	const meta = candidate.chunkMeta ?? {};
	const distance = candidate.distance;
	return {
		section_tipo: candidate.sectionTipo,
		section_id: candidate.sectionId,
		similarity: distance === undefined ? null : Math.round((1 - distance) * 10000) / 10000,
		score: candidate.rrfScore ?? candidate.score ?? null,
		view: typeof meta.view === 'string' ? meta.view : null,
		thumb_url: storedThumbUrl(meta),
		context: candidate.sourceText,
	};
}

/** Build the multimodal stack (config + provider). Returns null when media is off. */
function buildMediaStack(): {
	cfg: MultimodalRuntimeConfig;
	objectRetrieval: ObjectRetrieval;
} | null {
	// ONE snapshot for both reads (envSnapshot applies the documented precedence:
	// real process environment over ../private/.env). The image keys themselves are
	// read — and declared, and documented — in multimodal_config.ts + catalog/ai.ts;
	// the hand-kept key list this used to assemble was invisible to the config census
	// and is gone.
	const env = envSnapshot();
	if (!isMediaEnabled(env)) return null;
	const cfg = multimodalConfigFromEnv(env);
	return { cfg, objectRetrieval: new ObjectRetrieval(buildMultimodalProvider(cfg)) };
}

/** similar_objects — visual object similarity by a seed record's stored image vectors. */
async function similarObjectsAction(rqo: Rqo, context: RagApiContext): Promise<ApiResult> {
	if (!isRagEnabled()) return disabled();
	const stack = buildMediaStack();
	if (stack === null) return mediaDisabled();
	const principal = await resolveCaller(context);
	if (principal === null) return noPrincipal();
	const seed = readSeed(rqo.options);
	if (seed === null) return badRequest('Missing or invalid seed (section_tipo, section_id)');

	const ragConfig = new RagConfig(defaultOntologyPort());
	const scope = optionScope(rqo.options) ?? (await ragConfig.getCompareScope(seed.sectionTipo));
	// The request may name a mode; when it does not, the installation's default
	// decides (DEDALO_RAG_IMAGE_HYBRID, true ⇒ hybrid — which is what a heritage
	// collection wants, since pure visual similarity confuses a bronze coin with a
	// bronze button).
	const requestedMode = rqo.options?.similarity_mode;
	const mode: SimilarityMode =
		requestedMode === 'visual' || requestedMode === 'hybrid'
			? requestedMode
			: stack.cfg.imageHybrid
				? 'hybrid'
				: 'visual';
	const view = optionString(rqo.options, 'view') || null;
	const nearDup = rqo.options?.near_duplicate === true ? stack.cfg.nearDuplicateSimilarity : null;
	const hits = await stack.objectRetrieval.findSimilarObjects(principal, seed, {
		sectionTipos: scope,
		mode,
		view,
		topK: clampTopK(rqo.options?.limit),
		minSimilarity: nearDup,
	});
	return envelope(hits.map(shapeObject), 'ok', context);
}

/** search_by_text_image — a text query into the image space (joint tower). */
async function searchByTextImageAction(rqo: Rqo, context: RagApiContext): Promise<ApiResult> {
	if (!isRagEnabled()) return disabled();
	const stack = buildMediaStack();
	if (stack === null) return mediaDisabled();
	const principal = await resolveCaller(context);
	if (principal === null) return noPrincipal();
	const query = optionString(rqo.options, 'query');
	if (query === '') return badRequest('Missing query');
	await chargeAiSpend(principal, { door: 'dd_rag_api.search_by_text_image', embeds: 1 });
	const hits = await stack.objectRetrieval.searchByTextImage(principal, query, {
		sectionTipos: optionScope(rqo.options) ?? [],
		topK: clampTopK(rqo.options?.limit),
	});
	return envelope(hits.map(shapeObject), 'ok', context);
}

/** characterize_object — neighbour-aggregated typology/period proposals (no LLM). */
async function characterizeObjectAction(rqo: Rqo, context: RagApiContext): Promise<ApiResult> {
	if (!isRagEnabled()) return disabled();
	const stack = buildMediaStack();
	if (stack === null) return mediaDisabled();
	const principal = await resolveCaller(context);
	if (principal === null) return noPrincipal();
	const seed = readSeed(rqo.options);
	if (seed === null) return badRequest('Missing or invalid seed (section_tipo, section_id)');

	// The SAME bug the rsc92 picker fix killed in core/resolve/component_data.ts (2026-07-09):
	// 'APPLICATION_LANGS' is not a key this engine has — nothing sets it, the installer never
	// writes it, and it is absent from every .env. The real UI-language key is
	// DEDALO_APPLICATION_LANGS and it is a JSON MAP, so a CSV split of it produces garbage.
	// The read therefore ALWAYS fell through to a hardcoded 'lg-spa,lg-cat,lg-eng' literal —
	// i.e. any install whose languages are not Spanish/Catalan/English was silently indexed
	// and searched in the wrong ones. These are DATA languages (they pair with DEDALO_DATA_NOLAN), so
	// they come from config, like every other language list (owner rule, 2026-07-09).
	const langs = config.menu.projectsDefaultLangs;
	const nolan = readString('DEDALO_DATA_NOLAN');
	const characterizer = new RagCharacterizer({
		config: new RagConfig(defaultOntologyPort()),
		objectRetrieval: stack.objectRetrieval,
		roleReader: buildRoleReader(langs, nolan),
	});
	const result = await characterizer.characterize(principal, seed, {
		topK: stack.cfg.characterizeTopK,
	});
	return envelope(result, 'ok', context);
}

/**
 * The dd_rag_api action table, spread into the dispatch ACTION_REGISTRY. Each
 * handler matches the ActionHandler signature structurally (it reads only
 * session + principal from the context).
 */
export const ragApiActions = {
	semantic_search: recordSearch,
	embed_groups: embedGroupsAction,
	retrieve: (rqo: Rqo, context: RagApiContext) =>
		passageSearch(rqo, context, 'ok', 'dd_rag_api.retrieve'),
	get_agent_context: (rqo: Rqo, context: RagApiContext) =>
		passageSearch(rqo, context, 'agent_context', 'dd_rag_api.get_agent_context'),
	similar_to: similarToAction,
	ask: askAction,
	similar_objects: similarObjectsAction,
	search_by_text_image: searchByTextImageAction,
	characterize_object: characterizeObjectAction,
};
