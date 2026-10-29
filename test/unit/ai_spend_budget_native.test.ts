/**
 * TOOLS-4 (closure Step 3) — AI SPEND is GRANTED and METERED, per user, per UTC
 * day, in a DB-backed STANDARD-SCHEMA ledger on MASTER-defined tipos, against
 * LIMITS that are user / profile data (owner decisions 2026-09-30 and
 * 2026-10-12; WC-2026-10-01-ai-spend-budget).
 *
 * WHAT WAS WRONG (measured at 45b8c45162): every authenticated user could spend
 * without bound — the agent loop (`dd_mcp_api` agent_chat / agent_chat_stream: up
 * to MAX_ITERATIONS provider turns per call), the generative RAG `ask`, the
 * retrieval query embeddings and the identify vision calls. No grant on the
 * generative answer, no per-user budget, no ledger.
 *
 * WHAT THIS GATE PINS, by outcome:
 *   A. THE MASTER NODES — the ledger (dd660 "AI usage" → matrix_stats, user
 *      dd663 a dd128 locator, day dd664 a component_date, counters dd665-668)
 *      and the limits (dd692-695 on dd128, dd696-699 on dd234) resolve to the
 *      shapes the module writes and reads; a charge stores the user locator and
 *      the day as a dd_date `{start:{year,month,day,time}}`.
 *   B. THE LIMITS — per kind, on its own: the user's value wins over the
 *      profile's; an EMPTY user value inherits the profile's; both empty is 0
 *      (refused); an explicit user 0 refuses although the profile allows; read
 *      per reservation (an administrator's change takes effect at the next
 *      spend); root is refused at 0 like anyone; a stored limit parses
 *      FAIL-CLOSED (only empty inherits — malformed / negative is 0).
 *   C. THE LEDGER — a reservation BEFORE the provider (before an SSE stream
 *      opens); the reported usage REPLACES the token reservation; a missing usage
 *      keeps the FULL reservation; two concurrent reserves at limit 1 admit
 *      exactly one (node lock + FOR UPDATE); an administrator's correction racing
 *      a reservation is never lost; it is DB state (no cache clear resets it); a
 *      ledger or limit set that cannot be used FAILS CLOSED (503
 *      ai.budget_unavailable — proved through the zz-scratch seam, never by
 *      touching master nodes); the seam cannot aim a write at a non-scratch
 *      tipo; nobody is exempt (a global admin and root are refused at 0).
 *   D. THE DOORS — runs limit 1: the second agent_chat is 429 with ZERO provider
 *      calls; the stream variant refuses as JSON, never an opened stream; the
 *      generative `ask` without `tool_rag` is 403 before any provider call, and
 *      its granted twin is served (a grounding miss refunds the run, the query
 *      embedding stays charged); `embed_groups` spends nothing. THE dd_rag_api
 *      CENSUS (refuter-surviving S2, 2026-10-01): the door table equals
 *      `ragApiActions`; with both embedding sidecars at the counting stand-in,
 *      every action is driven once and a model call that moved no ledger is RED;
 *      every door MEASURED spending an embedding gets embed limit 1 — the
 *      second call is 429 with no embedding made.
 *   E. NOT SELF-WRITABLE — a user-manager granted level 2 on the user limits
 *      cannot raise its OWN (the dd128 own-record guard, every door), only
 *      another user's.
 *
 * SCRATCH SURFACES ONLY: the spenders are the authz door fixture's runtime-built
 * users and profiles (installed and purged here); root's own limit keys are
 * snapshotted and restored; the ledger rows of every spender are swept before
 * and after. The provider is a local `Bun.serve` stand-in that COUNTS calls; the
 * RAG embedding provider is the offline stub.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { setField } from '../../src/ai/mcp/tools/fields_write.ts';
import { ragApiActions } from '../../src/ai/rag/api.ts';
import type { MultimodalEmbeddingProvider } from '../../src/ai/rag/multimodal_embedding_provider.ts';
import { dispatchRqo } from '../../src/core/api/dispatch.ts';
import type { ApiRequestContext } from '../../src/core/api/handler_context.ts';
import { coreApiActions } from '../../src/core/api/handlers/dd_core_api.ts';
import {
	buildGetProposals,
	buildIdentifyByImage,
	defaultIdentifyByImageDeps,
	defaultIdentifyProposalsDeps,
} from '../../src/core/api/handlers/dd_identify_api.ts';
import type { Rqo } from '../../src/core/concepts/rqo.ts';
import { encodeForJsonb } from '../../src/core/db/json_codec.ts';
import { runDetachedFromTransaction, sql } from '../../src/core/db/postgres.ts';
import { DedaloError } from '../../src/core/errors/dedalo_error.ts';
import { getMatrixTableFromTipo, getModelByTipo } from '../../src/core/ontology/resolver.ts';
import { persistRecordKeys } from '../../src/core/section_record/record_write.ts';
import {
	AI_SPEND_LEDGER,
	AI_SPEND_LIMITS,
	type AiSpendKind,
	chargeAiSpend,
	readAiSpend,
	reserveAiSpend,
	resolveAiSpendLimits,
	spendDayDate,
	storedLimit,
} from '../../src/core/security/ai_spend.ts';
import {
	clearPermissionsCache,
	clearPrincipalCache,
	getPermissions,
	getRecordComponentPermission,
	type Principal,
	resolvePrincipal,
	resolveProfileId,
} from '../../src/core/security/permissions.ts';
import { createSession, getSession, type Session } from '../../src/core/security/session_store.ts';
import {
	type AiSpendLimitSnapshot,
	type AiSpendLimitTarget,
	type AiSpendLimitValues,
	restoreAiSpendLimits,
	setAiSpendLimits,
	sweepAiSpendLedger,
} from '../helpers/ai_spend_ledger.ts';
import {
	AUTHZ_COMPONENT_ONLY_USER_ID,
	AUTHZ_CONTROL_USER_ID,
	AUTHZ_DD128_ADMIN_USER_ID,
	AUTHZ_LEVEL_1_USER_ID,
	AUTHZ_PROJECT_P,
	AUTHZ_SECTION,
	AUTHZ_SECTION_ONLY_USER_ID,
	AUTHZ_TEXT_ONLY_USER_ID,
	AUTHZ_TOOL_GRANTED_USER_ID,
	AUTHZ_USER_MANAGER_PROFILE_ID,
	AUTHZ_USER_MANAGER_USER_ID,
	type AuthzIdentities,
	createDoorRecord,
	installAuthzDoorFixture,
	removeAuthzDoorFixture,
	resolveAuthzIdentities,
} from '../helpers/authz_door_fixture.ts';
import { DB_READY } from '../helpers/db_ready.ts';
import { registerSessionCleanup } from '../helpers/session_cleanup.ts';

registerSessionCleanup();

const ROOT_USER_ID = -1;
/** Every user whose ledger rows this gate may write — swept before and after. */
const SPENDERS = [
	AUTHZ_COMPONENT_ONLY_USER_ID,
	AUTHZ_CONTROL_USER_ID,
	AUTHZ_SECTION_ONLY_USER_ID,
	AUTHZ_TOOL_GRANTED_USER_ID,
	AUTHZ_LEVEL_1_USER_ID,
	AUTHZ_DD128_ADMIN_USER_ID,
	AUTHZ_TEXT_ONLY_USER_ID,
	ROOT_USER_ID,
];
/** The limits-resolution legs' own user (its fixture profile is its own, N + 10). */
const RESOLVER_USER_ID = AUTHZ_TEXT_ONLY_USER_ID;

const OTHER_KEYS = [
	'DEDALO_AGENT_HTTP_ENABLED',
	'DEDALO_AGENT_ALLOW_WRITE',
	'DEDALO_AGENT_MODELS',
	'ANTHROPIC_API_KEY',
	'DEDALO_RAG_ENABLED',
	'DEDALO_RAG_LLM_ENDPOINT',
	'DEDALO_RAG_LLM_MODEL',
	'DEDALO_RAG_LLM_API_KEY',
	'DEDALO_RAG_EMBEDDING_PROVIDER',
	// The D-census legs arm the embedding sidecars at the counting stand-in.
	'DEDALO_RAG_EMBEDDING_ENDPOINT',
	'DEDALO_RAG_EMBEDDING_MODEL',
	'DEDALO_RAG_MEDIA_ENABLED',
	'DEDALO_RAG_MULTIMODAL_ENDPOINT',
	'DEDALO_RAG_MULTIMODAL_PROVIDER',
	'DEDALO_RAG_MULTIMODAL_MODEL',
];

/** The provider stand-in reports this usage on every turn (3 in + 2 out). */
const TURN_TOKENS = 5;

let ids: AuthzIdentities;
let root: Principal;
let resolverUser: Principal;
let seedId = 0;
let provider: ReturnType<typeof Bun.serve> | null = null;
let providerCalls = 0;
/** Embedding calls the stand-in answered (text sidecar `/embed`, multimodal `/text` + `/image`). */
let embedCalls = 0;
/** The stand-in's embedding paths (sidecar contracts: embedding_provider.ts, multimodal_embedding_provider.ts). */
const EMBED_PATHS: Record<string, string> = {
	'/zzembed/embed': 'input',
	'/zzmm/text': 'input',
	'/zzmm/image': 'images',
};
const savedEnv: Record<string, string | undefined> = {};
const sessions = new Map<number, Session>();

/** The FIRST snapshot per record — what afterAll puts back (root's own keys above all). */
const originals = new Map<string, AiSpendLimitSnapshot>();

async function setLimits(target: AiSpendLimitTarget, values: AiSpendLimitValues): Promise<void> {
	const snapshot = await setAiSpendLimits(target, values);
	const key = JSON.stringify(target);
	const known = originals.get(key);
	if (known === undefined) originals.set(key, snapshot);
	else {
		// Keep the earliest value per kind: that one is the record's own.
		for (const [kind, value] of Object.entries(snapshot.previous)) {
			if (!(kind in known.previous)) known.previous[kind as AiSpendKind] = value;
		}
	}
}

/**
 * Set the four USER-level limits of every spender for one leg (read per
 * reservation, so it takes effect at once). Profiles stay empty: the user value
 * is what applies.
 */
async function budgets(values: {
	runs?: number;
	tokens?: number;
	embeds?: number;
	vision?: number;
}) {
	const limits = {
		runs: values.runs ?? 1000,
		tokens: values.tokens ?? 100_000_000,
		embeds: values.embeds ?? 1000,
		vision: values.vision ?? 1000,
	};
	for (const userId of SPENDERS) await setLimits({ userId }, limits);
}

/** Set (null = empty) one user's and its profile's limits — the resolution legs. */
async function levels(
	principal: Principal,
	user: AiSpendLimitValues,
	profile: AiSpendLimitValues,
): Promise<void> {
	const profileId = await resolveProfileId(principal.userId);
	if (profileId === null) throw new Error(`user ${principal.userId} has no profile`);
	await setLimits({ userId: principal.userId }, user);
	await setLimits({ profileId }, profile);
}

const EMPTY: AiSpendLimitValues = { runs: null, tokens: null, embeds: null, vision: null };

function contextFor(principal: Principal) {
	let session = sessions.get(principal.userId);
	if (session === undefined) {
		const token = createSession(
			principal.userId,
			`zzspend_${principal.userId}`,
			principal.isGlobalAdmin,
		);
		session = getSession(token) as Session;
		sessions.set(principal.userId, session);
	}
	return {
		requestId: crypto.randomUUID(),
		clientIp: '127.0.0.1',
		session,
		csrfCandidate: session.csrfToken,
	};
}

const call = (
	apiClass: string,
	action: string,
	options: Record<string, unknown>,
	principal: Principal,
) =>
	dispatchRqo(
		{ action, dd_api: apiClass, options } as unknown as Rqo,
		contextFor(principal) as never,
	) as Promise<{ status: number; body: unknown; stream?: unknown }>;

const errorCode = (body: unknown) => (body as { error?: { code?: string } }).error?.code;

async function refusalOf(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
		return 'admitted';
	} catch (error) {
		return error instanceof DedaloError ? error.code : `untyped: ${String(error)}`;
	}
}

/** The refusal's `limit` detail (or the outcome when it was not a budget refusal). */
async function refusedAt(promise: Promise<unknown>): Promise<number | string> {
	try {
		await promise;
		return 'admitted';
	} catch (error) {
		if (error instanceof DedaloError && error.code === 'ai.budget_exhausted') {
			return Number((error.details as Record<string, unknown>).limit);
		}
		return error instanceof DedaloError ? error.code : `untyped: ${String(error)}`;
	}
}

describe.if(DB_READY)('TOOLS-4 — AI spend is granted and metered', () => {
	beforeAll(async () => {
		for (const key of OTHER_KEYS) savedEnv[key] = process.env[key];
		provider = Bun.serve({
			port: 0,
			hostname: '127.0.0.1',
			async fetch(request) {
				const field = EMBED_PATHS[new URL(request.url).pathname];
				if (field !== undefined) {
					// An EMBEDDING model call: counted apart from the chat turns, so the
					// existing "zero provider calls" legs keep meaning chat turns.
					embedCalls++;
					const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
					const items = Array.isArray(body[field]) ? (body[field] as unknown[]) : [];
					return Response.json({ embeddings: items.map(() => [1, 0, 0, 0, 0, 0, 0, 0]) });
				}
				providerCalls++;
				const body = (await request.json().catch(() => ({}))) as { stream?: boolean };
				const usage = { prompt_tokens: 3, completion_tokens: 2, total_tokens: TURN_TOKENS };
				if (body.stream === true) {
					const chunk = {
						choices: [{ index: 0, delta: { content: 'zzspend' }, finish_reason: 'stop' }],
						usage,
					};
					return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
						headers: { 'Content-Type': 'text/event-stream' },
					});
				}
				return Response.json({
					choices: [
						{ index: 0, message: { role: 'assistant', content: 'zzspend' }, finish_reason: 'stop' },
					],
					usage,
				});
			},
		});
		process.env.DEDALO_AGENT_HTTP_ENABLED = 'true';
		delete process.env.DEDALO_AGENT_ALLOW_WRITE;
		delete process.env.ANTHROPIC_API_KEY;
		process.env.DEDALO_AGENT_MODELS = JSON.stringify([
			{
				id: 'zzspendmodel',
				label: 'zzspend stub',
				provider: 'openai_compatible',
				model: 'zzspend-native',
				endpoint: `http://127.0.0.1:${provider.port}/v1/chat/completions`,
				egress: 'local',
				max_tokens: 1000,
			},
		]);
		process.env.DEDALO_RAG_ENABLED = 'true';
		process.env.DEDALO_RAG_LLM_ENDPOINT = `http://127.0.0.1:${provider.port}/v1/chat/completions`;
		process.env.DEDALO_RAG_LLM_MODEL = 'zzspend-native';
		delete process.env.DEDALO_RAG_LLM_API_KEY;
		process.env.DEDALO_RAG_EMBEDDING_PROVIDER = 'stub';

		await installAuthzDoorFixture();
		ids = await resolveAuthzIdentities();
		root = await resolvePrincipal(ROOT_USER_ID);
		resolverUser = await resolvePrincipal(RESOLVER_USER_ID);
		seedId = await createDoorRecord(AUTHZ_SECTION, AUTHZ_PROJECT_P);
		await sweepAiSpendLedger(SPENDERS);
		await budgets({});
	});

	afterAll(async () => {
		provider?.stop(true);
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await sweepAiSpendLedger(SPENDERS);
		await restoreAiSpendLimits([...originals.values()]);
		await removeAuthzDoorFixture();
	});

	// ── A. the master nodes ────────────────────────────────────────────────────

	describe('A. the master nodes (ledger + limits)', () => {
		test('the ledger and limit tipos resolve to the shapes the module writes and reads', async () => {
			const models: Record<string, string | null> = {};
			const tipos = [
				AI_SPEND_LEDGER.user,
				AI_SPEND_LEDGER.day,
				AI_SPEND_LEDGER.runs,
				AI_SPEND_LEDGER.tokens,
				AI_SPEND_LEDGER.embeds,
				AI_SPEND_LEDGER.vision,
				...(['user', 'profile'] as const).flatMap((level) =>
					(['runs', 'tokens', 'embeds', 'vision'] as const).map(
						(kind) => AI_SPEND_LIMITS[level][kind],
					),
				),
			];
			for (const tipo of tipos) models[tipo] = await getModelByTipo(tipo);
			expect(models).toEqual({
				dd663: 'component_portal', // stored component_autocomplete; runtime portal
				dd664: 'component_date',
				dd665: 'component_number',
				dd666: 'component_number',
				dd667: 'component_number',
				dd668: 'component_number',
				dd692: 'component_number',
				dd693: 'component_number',
				dd694: 'component_number',
				dd695: 'component_number',
				dd696: 'component_number',
				dd697: 'component_number',
				dd698: 'component_number',
				dd699: 'component_number',
			});
			expect({
				ledger: await getMatrixTableFromTipo(AI_SPEND_LEDGER.section),
				users: await getMatrixTableFromTipo(AI_SPEND_LIMITS.user.section),
				profiles: await getMatrixTableFromTipo(AI_SPEND_LIMITS.profile.section),
			}).toEqual({ ledger: 'matrix_stats', users: 'matrix_users', profiles: 'matrix_profiles' });
		});

		test('a charge stores the user as a dd128 locator and the UTC day as a dd_date', async () => {
			await budgets({});
			await sweepAiSpendLedger([AUTHZ_LEVEL_1_USER_ID]);
			const now = new Date();
			await chargeAiSpend(ids.level1, { door: 'zzspend.shape', vision: 1 }, { now });
			const rows = (await sql.unsafe(
				`SELECT relation->$2 AS users, date->$3 AS days, number->$4 AS vision
				 FROM matrix_stats WHERE section_tipo = $1 AND relation @> $5::text::jsonb`,
				[
					AI_SPEND_LEDGER.section,
					AI_SPEND_LEDGER.user,
					AI_SPEND_LEDGER.day,
					AI_SPEND_LEDGER.vision,
					JSON.stringify({
						[AI_SPEND_LEDGER.user]: [{ section_tipo: 'dd128', section_id: AUTHZ_LEVEL_1_USER_ID }],
					}),
				],
			)) as { users: Record<string, unknown>[]; days: unknown; vision: unknown }[];
			expect(rows.length).toBe(1);
			expect(rows[0]?.users[0]).toMatchObject({
				section_tipo: 'dd128',
				section_id: AUTHZ_LEVEL_1_USER_ID,
				from_component_tipo: AI_SPEND_LEDGER.user,
			});
			const { year, month, day, time } = spendDayDate(now);
			expect({ year, month, day }).toEqual({
				year: now.getUTCFullYear(),
				month: now.getUTCMonth() + 1,
				day: now.getUTCDate(),
			});
			expect(rows[0]?.days).toEqual([{ id: 1, start: { year, month, day, time } }]);
			expect(rows[0]?.vision).toEqual([{ id: 1, value: 1 }]);
			await sweepAiSpendLedger([AUTHZ_LEVEL_1_USER_ID]);
		});
	});

	// ── B. the limits ──────────────────────────────────────────────────────────

	describe('B. the limits (user → profile → 0, per kind)', () => {
		test('the USER value overrides the profile value', async () => {
			await sweepAiSpendLedger([RESOLVER_USER_ID]);
			await levels(resolverUser, { ...EMPTY, runs: 2 }, { ...EMPTY, runs: 5 });
			expect((await resolveAiSpendLimits(resolverUser)).runs).toEqual({ limit: 2, source: 'user' });
			const door = { door: 'zzspend.user_wins', runs: 1 };
			expect(await refusedAt(chargeAiSpend(resolverUser, door))).toBe('admitted');
			expect(await refusedAt(chargeAiSpend(resolverUser, door))).toBe('admitted');
			expect(await refusedAt(chargeAiSpend(resolverUser, door))).toBe(2);
		});

		test('an EMPTY user value inherits the profile value', async () => {
			await sweepAiSpendLedger([RESOLVER_USER_ID]);
			await levels(resolverUser, EMPTY, { ...EMPTY, runs: 1 });
			expect((await resolveAiSpendLimits(resolverUser)).runs).toEqual({
				limit: 1,
				source: 'profile',
			});
			const door = { door: 'zzspend.profile', runs: 1 };
			expect(await refusedAt(chargeAiSpend(resolverUser, door))).toBe('admitted');
			expect(await refusedAt(chargeAiSpend(resolverUser, door))).toBe(1);
		});

		test('BOTH empty is 0 — refused', async () => {
			await sweepAiSpendLedger([RESOLVER_USER_ID]);
			await levels(resolverUser, EMPTY, EMPTY);
			expect(await resolveAiSpendLimits(resolverUser)).toEqual({
				runs: { limit: 0, source: 'none' },
				tokens: { limit: 0, source: 'none' },
				embeds: { limit: 0, source: 'none' },
				vision: { limit: 0, source: 'none' },
			});
			expect(
				await refusedAt(chargeAiSpend(resolverUser, { door: 'zzspend.none', embeds: 1 })),
			).toBe(0);
			expect(await readAiSpend(resolverUser)).toEqual({ runs: 0, tokens: 0, embeds: 0, vision: 0 });
		});

		test('an explicit user 0 REFUSES although the profile allows', async () => {
			await sweepAiSpendLedger([RESOLVER_USER_ID]);
			await levels(resolverUser, { ...EMPTY, vision: 0 }, { ...EMPTY, vision: 5 });
			expect((await resolveAiSpendLimits(resolverUser)).vision).toEqual({
				limit: 0,
				source: 'user',
			});
			expect(
				await refusedAt(chargeAiSpend(resolverUser, { door: 'zzspend.zero', vision: 1 })),
			).toBe(0);
		});

		test('each kind resolves ON ITS OWN, and an exhausted kind blocks only itself', async () => {
			await sweepAiSpendLedger([RESOLVER_USER_ID]);
			await levels(
				resolverUser,
				{ runs: null, tokens: 7, embeds: 3, vision: null },
				{ runs: 1, tokens: 9, embeds: null, vision: null },
			);
			expect(await resolveAiSpendLimits(resolverUser)).toEqual({
				runs: { limit: 1, source: 'profile' },
				tokens: { limit: 7, source: 'user' },
				embeds: { limit: 3, source: 'user' },
				vision: { limit: 0, source: 'none' },
			});
			expect(await refusedAt(chargeAiSpend(resolverUser, { door: 'zzspend.k', runs: 1 }))).toBe(
				'admitted',
			);
			expect(await refusedAt(chargeAiSpend(resolverUser, { door: 'zzspend.k', runs: 1 }))).toBe(1);
			// runs is spent; embeds still admits, vision (0) still refuses.
			expect(await refusedAt(chargeAiSpend(resolverUser, { door: 'zzspend.k', embeds: 1 }))).toBe(
				'admitted',
			);
			expect(await refusedAt(chargeAiSpend(resolverUser, { door: 'zzspend.k', vision: 1 }))).toBe(
				0,
			);
			// A request naming two kinds is refused by the one that would pass its limit.
			expect(
				await refusedAt(chargeAiSpend(resolverUser, { door: 'zzspend.k', embeds: 1, tokens: 8 })),
			).toBe(7);
			expect(await readAiSpend(resolverUser)).toEqual({ runs: 1, tokens: 0, embeds: 1, vision: 0 });
		});

		test('limits are read PER RESERVATION: an administrator raising one admits the next spend', async () => {
			await sweepAiSpendLedger([RESOLVER_USER_ID]);
			await levels(resolverUser, { ...EMPTY, vision: 0 }, EMPTY);
			const door = { door: 'zzspend.raise', vision: 1 };
			expect(await refusedAt(chargeAiSpend(resolverUser, door))).toBe(0);
			await levels(resolverUser, { vision: 1 }, {});
			expect(await refusedAt(chargeAiSpend(resolverUser, door))).toBe('admitted');
			await levels(resolverUser, { vision: null }, { vision: 2 });
			expect(await refusedAt(chargeAiSpend(resolverUser, door))).toBe('admitted');
			expect(await refusedAt(chargeAiSpend(resolverUser, door))).toBe(2);
		});

		test('ROOT is refused at 0 like anyone (its own explicit 0 over an allowing profile)', async () => {
			const profileId = await resolveProfileId(ROOT_USER_ID);
			expect(profileId).not.toBeNull();
			await levels(root, { ...EMPTY, vision: 0 }, { vision: 5 });
			expect((await resolveAiSpendLimits(root)).vision).toEqual({ limit: 0, source: 'user' });
			expect(await refusedAt(chargeAiSpend(root, { door: 'zzspend.root0', vision: 1 }))).toBe(0);
		});

		test('a stored limit parses FAIL-CLOSED: only EMPTY inherits, anything set but unusable is 0', () => {
			const bag = (value: unknown) => ({ zzlimit: [{ id: 1, value }] });
			// EMPTY — inherit the next level (null).
			expect(storedLimit(null, 'zzlimit')).toBeNull();
			expect(storedLimit({}, 'zzlimit')).toBeNull();
			expect(storedLimit({ zzlimit: [] }, 'zzlimit')).toBeNull();
			expect(storedLimit(bag(null), 'zzlimit')).toBeNull();
			expect(storedLimit(bag(''), 'zzlimit')).toBeNull();
			expect(storedLimit(bag('   '), 'zzlimit')).toBeNull();
			// SET but unusable — 0 (refuses), NEVER null (which would inherit a larger one).
			for (const malformed of ['abc', -5, '-5', Number.NaN, {}, { value: 'x' }, true, [5]]) {
				expect({ malformed, limit: storedLimit(bag(malformed), 'zzlimit') }).toEqual({
					malformed,
					limit: 0,
				});
			}
			// Usable — floored integer.
			expect(storedLimit(bag(3), 'zzlimit')).toBe(3);
			expect(storedLimit(bag('3'), 'zzlimit')).toBe(3);
			expect(storedLimit(bag(12.7), 'zzlimit')).toBe(12);
			expect(storedLimit(bag(0), 'zzlimit')).toBe(0);
		});

		test('a MALFORMED or NEGATIVE user limit refuses at 0 — it never inherits the profile; a BLANK one does', async () => {
			await sweepAiSpendLedger([RESOLVER_USER_ID]);
			await levels(
				resolverUser,
				{ runs: 'abc', tokens: -3, embeds: '   ', vision: null },
				{ runs: 5, tokens: 5, embeds: 5, vision: null },
			);
			expect(await resolveAiSpendLimits(resolverUser)).toEqual({
				runs: { limit: 0, source: 'user' },
				tokens: { limit: 0, source: 'user' },
				embeds: { limit: 5, source: 'profile' },
				vision: { limit: 0, source: 'none' },
			});
			expect(await refusedAt(chargeAiSpend(resolverUser, { door: 'zzspend.bad', runs: 1 }))).toBe(
				0,
			);
			expect(await refusedAt(chargeAiSpend(resolverUser, { door: 'zzspend.bad', embeds: 1 }))).toBe(
				'admitted',
			);
			expect(await readAiSpend(resolverUser)).toEqual({ runs: 0, tokens: 0, embeds: 1, vision: 0 });
		});
	});

	// ── C. the ledger ──────────────────────────────────────────────────────────

	describe('C. the ledger', () => {
		const SCRATCH = { ...AI_SPEND_LEDGER };
		const failClosed = async (promise: Promise<unknown>) => {
			try {
				await promise;
				return 'admitted';
			} catch (error) {
				if (!(error instanceof DedaloError)) return `untyped: ${String(error)}`;
				const cause = error.cause instanceof DedaloError ? error.cause.code : null;
				return cause === null ? error.code : `${error.code} <- ${cause}`;
			}
		};

		test('a ledger or limit set that cannot be used FAILS CLOSED: ai.budget_unavailable, nothing written', async () => {
			await budgets({});
			await sweepAiSpendLedger([AUTHZ_LEVEL_1_USER_ID]);
			const ask = { door: 'zzspend.missing', runs: 1 };
			// The zz-scratch seam names a section / component no ontology defines —
			// what a broken install looks like to this module.
			expect(
				await failClosed(
					reserveAiSpend(ids.level1, ask, { ledger: { ...SCRATCH, section: 'zzspend404' } }),
				),
			).toBe('ai.budget_unavailable');
			expect(
				await failClosed(
					reserveAiSpend(ids.level1, ask, { ledger: { ...SCRATCH, user: 'zzspend404' } }),
				),
			).toBe('ai.budget_unavailable');
			expect(
				await failClosed(
					reserveAiSpend(ids.level1, ask, {
						limits: {
							user: AI_SPEND_LIMITS.user,
							profile: { ...AI_SPEND_LIMITS.profile, runs: 'zzspend404' },
						},
					}),
				),
			).toBe('ai.budget_unavailable');
			expect(
				await failClosed(
					reserveAiSpend(ids.level1, ask, {
						limits: {
							user: { ...AI_SPEND_LIMITS.user, section: 'zzspend404' },
							profile: AI_SPEND_LIMITS.profile,
						},
					}),
				),
			).toBe('ai.budget_unavailable');
			expect(await readAiSpend(ids.level1)).toEqual({ runs: 0, tokens: 0, embeds: 0, vision: 0 });
			// …and the shipped ledger, untouched, admits.
			expect(await failClosed(chargeAiSpend(ids.level1, ask))).toBe('admitted');
		});

		test('the seam cannot aim a write at a non-scratch tipo (the dd128 census rests on it)', async () => {
			await budgets({});
			const ask = { door: 'zzspend.aim', runs: 1 };
			expect(
				await failClosed(
					reserveAiSpend(ids.level1, ask, { ledger: { ...SCRATCH, section: 'dd128' } }),
				),
			).toBe('ai.budget_unavailable <- internal.invariant');
			expect(
				await failClosed(
					reserveAiSpend(ids.level1, ask, { ledger: { ...SCRATCH, runs: 'dd692' } }),
				),
			).toBe('ai.budget_unavailable <- internal.invariant');
		});

		test('two CONCURRENT reserves at limit 1 admit exactly one (the node lock + FOR UPDATE)', async () => {
			await budgets({ runs: 1 });
			await sweepAiSpendLedger([AUTHZ_LEVEL_1_USER_ID]);
			let arrived = 0;
			let open: () => void = () => {};
			const barrier = new Promise<void>((resolve) => {
				open = resolve;
			});
			// Both reservations READ the ledger before either writes: without the lock
			// both see 0 used and both are admitted.
			const afterRead = async () => {
				arrived++;
				if (arrived >= 2) open();
				await Promise.race([barrier, new Promise((resolve) => setTimeout(resolve, 500))]);
			};
			const outcomes = await Promise.all([
				refusalOf(
					reserveAiSpend(ids.level1, { door: 'zzspend.concurrent', runs: 1 }, { afterRead }),
				),
				refusalOf(
					reserveAiSpend(ids.level1, { door: 'zzspend.concurrent', runs: 1 }, { afterRead }),
				),
			]);
			expect(outcomes.sort()).toEqual(['admitted', 'ai.budget_exhausted']);
			expect((await readAiSpend(ids.level1)).runs).toBe(1);
		});

		test('an ADMINISTRATOR correction racing a reservation is never lost (the row lock, FOR UPDATE)', async () => {
			// The ledger is a section an administrator may correct by hand (reset a
			// counter). That write does not take the (user, day) node lock — only the
			// ROW lock — so the reservation's read must hold the row: the correction
			// then lands AFTER the reservation commits. Without FOR UPDATE it lands in
			// the window, and the reservation's stale write erases it.
			await budgets({});
			await sweepAiSpendLedger([AUTHZ_COMPONENT_ONLY_USER_ID]);
			await chargeAiSpend(ids.componentOnly, { door: 'zzspend.race.seed', runs: 1 });
			const table = await getMatrixTableFromTipo(AI_SPEND_LEDGER.section);
			if (table === null) throw new Error('the ledger section has no table');
			const rows = (await sql.unsafe(
				`SELECT section_id FROM "${table}" WHERE section_tipo = $1 AND relation @> $2::text::jsonb`,
				[
					AI_SPEND_LEDGER.section,
					JSON.stringify({
						[AI_SPEND_LEDGER.user]: [{ section_id: AUTHZ_COMPONENT_ONLY_USER_ID }],
					}),
				],
			)) as { section_id: number }[];
			expect(rows.length).toBe(1);
			const target = {
				table,
				sectionTipo: AI_SPEND_LEDGER.section,
				sectionId: Number(rows[0]?.section_id),
			};
			let correction: Promise<void> = Promise.resolve();
			await reserveAiSpend(
				ids.componentOnly,
				{ door: 'zzspend.race', runs: 1 },
				{
					afterRead: async () => {
						correction = runDetachedFromTransaction(() =>
							persistRecordKeys(
								target,
								[{ column: 'number', key: AI_SPEND_LEDGER.runs, value: [{ id: 1, value: 0 }] }],
								{ userId: ROOT_USER_ID },
								{ actor: ROOT_USER_ID },
							),
						);
						await Promise.race([correction, new Promise((resolve) => setTimeout(resolve, 400))]);
					},
				},
			);
			await correction;
			expect((await readAiSpend(ids.componentOnly)).runs).toBe(0);
		});

		test('a MISSING usage report keeps the full reservation charged (never settle-to-zero)', async () => {
			await budgets({});
			await sweepAiSpendLedger([AUTHZ_SECTION_ONLY_USER_ID]);
			const reservation = await reserveAiSpend(ids.sectionOnly, {
				door: 'zzspend.nousage',
				runs: 1,
				tokens: 4096,
			});
			await reservation.settle(null);
			expect(await readAiSpend(ids.sectionOnly)).toEqual({
				runs: 1,
				tokens: 4096,
				embeds: 0,
				vision: 0,
			});
		});

		test('a REPORTED usage replaces the reservation; release refunds only an unspent one', async () => {
			await budgets({});
			await sweepAiSpendLedger([AUTHZ_SECTION_ONLY_USER_ID]);
			const used = await reserveAiSpend(ids.sectionOnly, { door: 'zzspend.used', tokens: 4096 });
			await used.settle({ tokens: 17 });
			const refunded = await reserveAiSpend(ids.sectionOnly, {
				door: 'zzspend.refunded',
				runs: 1,
				tokens: 4096,
			});
			await refunded.release();
			expect(await readAiSpend(ids.sectionOnly)).toEqual({
				runs: 0,
				tokens: 17,
				embeds: 0,
				vision: 0,
			});
		});

		test('NOBODY IS EXEMPT: a global admin and root are refused at limit 0', async () => {
			await budgets({ vision: 0, embeds: 0 });
			expect(ids.dd128Admin.isGlobalAdmin).toBe(true);
			expect(
				await refusalOf(chargeAiSpend(ids.dd128Admin, { door: 'zzspend.admin', vision: 1 })),
			).toBe('ai.budget_exhausted');
			expect(await refusalOf(chargeAiSpend(root, { door: 'zzspend.root', embeds: 1 }))).toBe(
				'ai.budget_exhausted',
			);
		});

		test('the refusal names the budget and when it resets (429 details)', async () => {
			await budgets({ vision: 0 });
			try {
				await chargeAiSpend(ids.level1, { door: 'zzspend.details', vision: 1 });
				throw new Error('admitted');
			} catch (error) {
				expect(error).toBeInstanceOf(DedaloError);
				const details = (error as DedaloError).details as Record<string, unknown>;
				expect(details.budget_kind).toBe('vision');
				expect(details.limit).toBe(0);
				expect(String(details.window_resets_at)).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
			}
		});
	});

	// ── D. the doors ───────────────────────────────────────────────────────────

	describe('D. the doors', () => {
		test('agent_chat charges the REPORTED usage, not the reservation', async () => {
			await budgets({});
			await sweepAiSpendLedger([AUTHZ_TOOL_GRANTED_USER_ID]);
			const before = providerCalls;
			const first = await call(
				'dd_mcp_api',
				'agent_chat',
				{ question: 'zzspend one', model: 'zzspendmodel' },
				ids.toolGranted,
			);
			expect(first.status).toBe(200);
			expect(providerCalls).toBe(before + 1);
			expect(await readAiSpend(ids.toolGranted)).toEqual({
				runs: 1,
				tokens: TURN_TOKENS,
				embeds: 0,
				vision: 0,
			});
		});

		test('runs budget 1: the SECOND agent_chat is ai.budget_exhausted (429), with no provider call', async () => {
			await budgets({ runs: 1 });
			const before = providerCalls;
			const second = await call(
				'dd_mcp_api',
				'agent_chat',
				{ question: 'zzspend two', model: 'zzspendmodel' },
				ids.toolGranted,
			);
			expect({ status: second.status, code: errorCode(second.body) }).toEqual({
				status: 429,
				code: 'ai.budget_exhausted',
			});
			expect(providerCalls).toBe(before);
		});

		test('the stream variant refuses with a JSON 429 — no SSE byte is ever sent', async () => {
			await budgets({ runs: 1 });
			const before = providerCalls;
			const result = await call(
				'dd_mcp_api',
				'agent_chat_stream',
				{ question: 'zzspend stream', model: 'zzspendmodel' },
				ids.toolGranted,
			);
			const opened = result.stream !== undefined;
			// Never leave an opened stream (and its loop) running behind a red assertion.
			await (result.stream as ReadableStream | undefined)?.cancel();
			expect(opened).toBe(false);
			expect({ status: result.status, code: errorCode(result.body) }).toEqual({
				status: 429,
				code: 'ai.budget_exhausted',
			});
			expect(providerCalls).toBe(before);
		});

		test('the ledger is DB state: clearing the principal / permission caches resets nothing', async () => {
			await budgets({ runs: 1 });
			clearPrincipalCache();
			clearPermissionsCache();
			const result = await call(
				'dd_mcp_api',
				'agent_chat',
				{ question: 'zzspend after clear', model: 'zzspendmodel' },
				ids.toolGranted,
			);
			expect(errorCode(result.body)).toBe('ai.budget_exhausted');
		});

		test('generative `ask` without the tool_rag grant is tool.not_authorized — before anything is spent', async () => {
			await budgets({});
			await sweepAiSpendLedger([AUTHZ_CONTROL_USER_ID]);
			const before = providerCalls;
			const result = await call(
				'dd_rag_api',
				'ask',
				{ query: 'zzspend ask', section_tipo: AUTHZ_SECTION },
				ids.control,
			);
			expect({ status: result.status, code: errorCode(result.body) }).toEqual({
				status: 403,
				code: 'tool.not_authorized',
			});
			expect(providerCalls).toBe(before);
			expect(await readAiSpend(ids.control)).toEqual({ runs: 0, tokens: 0, embeds: 0, vision: 0 });
		});

		test('its GRANTED twin is served; a grounding miss refunds the run, the query embedding stays charged', async () => {
			await budgets({});
			await sweepAiSpendLedger([AUTHZ_TOOL_GRANTED_USER_ID]);
			const before = providerCalls;
			const result = await call(
				'dd_rag_api',
				'ask',
				{ query: 'zzspend ask granted', section_tipo: AUTHZ_SECTION },
				ids.toolGranted,
			);
			expect(result.status).toBe(200);
			// The suite's vector store holds no passage for this query: the grounding
			// gate refuses BEFORE the model — no provider call, the run refunded.
			expect(providerCalls).toBe(before);
			expect(await readAiSpend(ids.toolGranted)).toEqual({
				runs: 0,
				tokens: 0,
				embeds: 1,
				vision: 0,
			});
		});

		test('embed_groups (the capability probe) spends nothing and needs no grant', async () => {
			await budgets({ embeds: 0 });
			await sweepAiSpendLedger([AUTHZ_CONTROL_USER_ID]);
			const result = await call(
				'dd_rag_api',
				'embed_groups',
				{ section_tipo: AUTHZ_SECTION },
				ids.control,
			);
			expect(result.status).toBe(200);
			expect(await readAiSpend(ids.control)).toEqual({ runs: 0, tokens: 0, embeds: 0, vision: 0 });
		});

		// ── EVERY MODEL CALL A dd_rag_api DOOR MAKES IS METERED (refuter-surviving
		// S2, 2026-10-01). The census is OUTCOME-DERIVED and TOTAL over the action
		// table: both embedding sidecars point at the counting stand-in, every
		// action in ragApiActions is driven once, and a door that made a model
		// call (an embedding or a chat turn) without moving the caller's ledger is
		// RED. A new action without a row here is RED (the table must equal the
		// registry), and every door MEASURED to spend an embedding gets the
		// budget-1 leg below — derived from the census, never a hand list.
		const RAG_DOORS: Record<
			keyof typeof ragApiActions,
			{ options: () => Record<string, unknown>; who: () => Principal }
		> = {
			semantic_search: {
				options: () => ({ query: 'zzspend census', section_tipo: AUTHZ_SECTION }),
				who: () => ids.control,
			},
			retrieve: {
				options: () => ({ query: 'zzspend census', section_tipo: AUTHZ_SECTION }),
				who: () => ids.control,
			},
			get_agent_context: {
				options: () => ({ query: 'zzspend census', section_tipo: AUTHZ_SECTION }),
				who: () => ids.control,
			},
			search_by_text_image: {
				options: () => ({ query: 'zzspend census', section_tipo: [AUTHZ_SECTION] }),
				who: () => ids.control,
			},
			// `ask` is GRANTED (tool_rag): the census drives the granted principal.
			ask: {
				options: () => ({ query: 'zzspend census', section_tipo: AUTHZ_SECTION }),
				who: () => ids.toolGranted,
			},
			embed_groups: { options: () => ({ section_tipo: AUTHZ_SECTION }), who: () => ids.control },
			similar_to: {
				options: () => ({ section_tipo: AUTHZ_SECTION, section_id: seedId }),
				who: () => ids.control,
			},
			similar_objects: {
				options: () => ({ section_tipo: AUTHZ_SECTION, section_id: seedId }),
				who: () => ids.control,
			},
			characterize_object: {
				options: () => ({ section_tipo: AUTHZ_SECTION, section_id: seedId }),
				who: () => ids.control,
			},
		};
		/** The census result: per door, the model calls it made and the ledger it moved. */
		const measured = new Map<string, { modelCalls: number; embeds: number; spent: number }>();
		const armSidecars = () => {
			process.env.DEDALO_RAG_EMBEDDING_PROVIDER = 'sidecar';
			process.env.DEDALO_RAG_EMBEDDING_ENDPOINT = `http://127.0.0.1:${provider?.port}/zzembed`;
			process.env.DEDALO_RAG_EMBEDDING_MODEL = 'zzspend-embed';
			process.env.DEDALO_RAG_MEDIA_ENABLED = 'true';
			process.env.DEDALO_RAG_MULTIMODAL_ENDPOINT = `http://127.0.0.1:${provider?.port}/zzmm`;
			process.env.DEDALO_RAG_MULTIMODAL_PROVIDER = 'local';
			process.env.DEDALO_RAG_MULTIMODAL_MODEL = 'zzspend-mm';
		};
		const disarmSidecars = () => {
			process.env.DEDALO_RAG_EMBEDDING_PROVIDER = 'stub';
			for (const key of [
				'DEDALO_RAG_EMBEDDING_ENDPOINT',
				'DEDALO_RAG_EMBEDDING_MODEL',
				'DEDALO_RAG_MEDIA_ENABLED',
				'DEDALO_RAG_MULTIMODAL_ENDPOINT',
				'DEDALO_RAG_MULTIMODAL_PROVIDER',
				'DEDALO_RAG_MULTIMODAL_MODEL',
			]) {
				delete process.env[key];
			}
		};
		const ledgerTotal = (spend: Awaited<ReturnType<typeof readAiSpend>>) =>
			spend.runs + spend.tokens + spend.embeds + spend.vision;

		test('CENSUS: the door table is the dd_rag_api registry — a new action needs its row', () => {
			expect(Object.keys(RAG_DOORS).sort()).toEqual(Object.keys(ragApiActions).sort());
		});

		test("CENSUS: every dd_rag_api door that calls a model moves the caller's ledger", async () => {
			await budgets({});
			armSidecars();
			try {
				for (const [action, door] of Object.entries(RAG_DOORS)) {
					const principal = door.who();
					await sweepAiSpendLedger([principal.userId]);
					const before = embedCalls + providerCalls;
					const result = await call('dd_rag_api', action, door.options(), principal);
					// Served — a door that answered with an error proved nothing about its spend.
					expect({ action, status: result.status }).toEqual({ action, status: 200 });
					const spend = await readAiSpend(principal);
					measured.set(action, {
						modelCalls: embedCalls + providerCalls - before,
						embeds: spend.embeds,
						spent: ledgerTotal(spend),
					});
				}
			} finally {
				disarmSidecars();
			}
			const unmetered = [...measured]
				.filter(([, row]) => row.modelCalls > 0 && row.spent === 0)
				.map(([action]) => action);
			expect(unmetered).toEqual([]);
			// Non-degeneracy: the census really saw the model doors call a model (a
			// stand-in nobody reached would make every row "no call, no spend").
			const calling = [...measured].filter(([, row]) => row.modelCalls > 0).map(([a]) => a);
			expect(calling).toEqual(
				expect.arrayContaining([
					'semantic_search',
					'retrieve',
					'get_agent_context',
					'search_by_text_image',
					'ask',
				]),
			);
		});

		test('embed budget 1: for EVERY door the census measured spending an embedding, the SECOND call is ai.budget_exhausted (429)', async () => {
			const embedDoors = [...measured].filter(([, row]) => row.embeds > 0).map(([a]) => a);
			// Derived, so it must not be empty (the census ran first, in file order).
			expect(embedDoors).toEqual(
				expect.arrayContaining([
					'semantic_search',
					'retrieve',
					'get_agent_context',
					'search_by_text_image',
				]),
			);
			armSidecars();
			try {
				for (const action of embedDoors) {
					const door = RAG_DOORS[action as keyof typeof RAG_DOORS];
					const principal = door.who();
					await budgets({ embeds: 1 });
					await sweepAiSpendLedger([principal.userId]);
					const first = await call('dd_rag_api', action, door.options(), principal);
					const before = embedCalls;
					const second = await call('dd_rag_api', action, door.options(), principal);
					expect({
						action,
						first: first.status,
						second: second.status,
						code: errorCode(second.body),
						embedsAfterRefusal: embedCalls - before,
						ledger: (await readAiSpend(principal)).embeds,
					}).toEqual({
						action,
						first: 200,
						second: 429,
						code: 'ai.budget_exhausted',
						embedsAfterRefusal: 0,
						ledger: 1,
					});
				}
			} finally {
				disarmSidecars();
			}
		});

		// ── identify: the vision spend (granted by tool_identify — its own gate) ──
		const identifyCtx = (principal: Principal): ApiRequestContext =>
			({ requestId: 'zzspend-vision', clientIp: '127.0.0.1', principal }) as ApiRequestContext;

		test.skip('vision budget 1: the SECOND get_proposals vision run is 429 and the model is NOT asked — SKIPPED: tool_identify is withdrawn from the tool registry (WC-2026-10-29, provisional until its redesign), so the granted caller never reaches the spend', async () => {
			await budgets({ vision: 1 });
			await sweepAiSpendLedger([AUTHZ_TOOL_GRANTED_USER_ID]);
			const calls = { vision: 0 };
			const handler = buildGetProposals({
				...defaultIdentifyProposalsDeps(),
				loadProfile: async () =>
					({ id: 'zzspend', label: 'zzspend', criteria: [], previewComponent: null }) as never,
				runVision: async () => {
					calls.vision++;
					return { declined: { reason: 'no_model' }, proposals: [], model: null } as never;
				},
				runNeighbourVote: async () => ({ proposals: [], skipped: [] }) as never,
			});
			const rqo = {
				action: 'get_proposals',
				options: { section_tipo: AUTHZ_SECTION, section_id: seedId, source: 'vision' },
			} as unknown as Rqo;
			const first = await refusalOf(handler(rqo, identifyCtx(ids.toolGranted)));
			const second = await refusalOf(handler(rqo, identifyCtx(ids.toolGranted)));
			expect({ first, second, modelCalls: calls.vision }).toEqual({
				first: 'admitted',
				second: 'ai.budget_exhausted',
				modelCalls: 1,
			});
		});

		test.skip('identify_by_image, EXTERNAL encoder at vision budget 0: 429 with ZERO embeds — SKIPPED: tool_identify is withdrawn from the tool registry (WC-2026-10-29, provisional until its redesign), so the granted caller never reaches the spend', async () => {
			await budgets({ vision: 0 });
			const calls = { embed: 0 };
			const encoder: MultimodalEmbeddingProvider = {
				embedImage: async () => {
					calls.embed++;
					return [[1, 0, 0]];
				},
				embedTextForImageSearch: async () => [],
				dimension: () => 3,
				model: () => 'zzspend-encoder',
				provider: () => 'zzspend-cloud',
				isExternal: () => true,
			};
			const handler = buildIdentifyByImage({
				...defaultIdentifyByImageDeps(),
				ragEnabled: () => true,
				mediaEnabled: () => true,
				buildProvider: () => encoder,
				queryImagePartition: async () => [],
				filterAccessible: async (_principal, candidates) => candidates,
			});
			const png =
				'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
			const rqo = { action: 'identify_by_image', options: { image: png } } as unknown as Rqo;
			expect({
				code: await refusalOf(handler(rqo, identifyCtx(ids.toolGranted))),
				embeds: calls.embed,
			}).toEqual({ code: 'ai.budget_exhausted', embeds: 0 });
		});
	});

	// ── E. the per-user limits are not self-writable ──────────────────────────

	describe('E. a user cannot raise their OWN limit (the dd128 own-record downgrade)', () => {
		/** The user-limit tipos, from the module's own table — a renamed one cannot slip the guard. */
		const USER_LIMIT_TIPOS = (['runs', 'tokens', 'embeds', 'vision'] as const).map(
			(kind) => AI_SPEND_LIMITS.user[kind],
		);
		let manager: Principal;
		let control: Principal;

		beforeAll(async () => {
			// The departmental user-manager (a non-global-admin) ALSO granted level 2 on the
			// four user-limit components — the role an administrator would hand AI-limit
			// management to. Its profile is fixture-owned: removed with the fixture.
			const grants = USER_LIMIT_TIPOS.map((tipo, index) => ({
				id: 900 + index,
				tipo,
				section_tipo: AI_SPEND_LIMITS.user.section,
				value: 2,
			}));
			await sql.unsafe(
				`UPDATE matrix_profiles SET misc = jsonb_set(misc, '{dd774}', misc->'dd774' || $1::text::jsonb)
				 WHERE section_tipo = $2 AND section_id = $3`,
				[encodeForJsonb(grants), AI_SPEND_LIMITS.profile.section, AUTHZ_USER_MANAGER_PROFILE_ID],
			);
			clearPermissionsCache();
			clearPrincipalCache();
			manager = await resolvePrincipal(AUTHZ_USER_MANAGER_USER_ID);
			control = await resolvePrincipal(AUTHZ_CONTROL_USER_ID);
		});

		test('the grant is REAL (level 2), and the resolution downgrades it to READ on the own record only', async () => {
			expect(manager.isGlobalAdmin).toBe(false);
			for (const tipo of USER_LIMIT_TIPOS) {
				expect({ tipo, matrix: await getPermissions(manager, 'dd128', tipo) }).toEqual({
					tipo,
					matrix: 2,
				});
				expect({
					tipo,
					own: await getRecordComponentPermission(manager, 'dd128', tipo, manager.userId),
					other: await getRecordComponentPermission(manager, 'dd128', tipo, control.userId),
				}).toEqual({ tipo, own: 1, other: 2 });
			}
		});

		const outcome = async (promise: Promise<unknown>): Promise<string> => {
			try {
				const response = (await promise) as { status?: number } | undefined;
				return response?.status === undefined || response.status === 200
					? 'served'
					: `status ${response.status}`;
			} catch (error) {
				return error instanceof DedaloError ? error.code : `untyped: ${String(error)}`;
			}
		};
		const mcpSet = (principal: Principal, sectionId: number, value: number) =>
			setField(principal, {
				section_tipo: 'dd128',
				section_id: sectionId,
				field: AI_SPEND_LIMITS.user.tokens,
				value,
				mode: 'replace',
			});
		const humanSave = (principal: Principal, sectionId: number, value: number) => {
			const handler = coreApiActions.save;
			if (!handler) throw new Error("dd_core_api has no 'save' action registered");
			return handler(
				{
					source: {
						tipo: AI_SPEND_LIMITS.user.tokens,
						section_tipo: 'dd128',
						section_id: sectionId,
						lang: 'lg-nolan',
					},
					data: { changed_data: [{ action: 'set_data', value: [{ id: 1, value }] }] },
				} as unknown as Parameters<typeof handler>[0],
				{
					principal,
					session: { userId: principal.userId },
					clientIp: '127.0.0.1',
					requestId: 'zzspend-self-limit',
				} as unknown as Parameters<typeof handler>[1],
			);
		};

		test('MCP set_field and the human save door REFUSE the own limit, and write nothing', async () => {
			const before = (await resolveAiSpendLimits(manager)).tokens;
			expect(await outcome(mcpSet(manager, manager.userId, 999_999_999))).toBe('perm.denied');
			expect(await outcome(humanSave(manager, manager.userId, 999_999_999))).toBe('perm.denied');
			expect((await resolveAiSpendLimits(manager)).tokens).toEqual(before);
		});

		test("CONTRAST: the same grant writes ANOTHER user's limit (the refusal is the own-record rule, not the grant)", async () => {
			expect(await outcome(mcpSet(manager, control.userId, 4242))).toBe('served');
			expect((await resolveAiSpendLimits(control)).tokens).toEqual({ limit: 4242, source: 'user' });
		});
	});
});
