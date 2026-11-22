// Migrated to the generic `test` TLD 2026-08-20 (AGENTS.md hard rule). That
// migration WAS a rename of opaque identifiers; since the 2026-08-30 port to
// `RagIndexer` (audit 2026-08-26, P1-14) it is not, because the gate now
// MATERIALISES a matrix row (`createScratchRecord` + `saveComponentData`) and
// resolves it back through the production `resolveEmbedDocs` seam. What the two
// tipos below must satisfy — MEASURED by mutating this file on 2026-08-30, not
// reasoned from the names:
//   • `SECTION_TIPO` must be a real `model: section`. Point it at the
//     section_group `test45`, or at a tipo that does not exist, and the fixture
//     save refuses: `fixture save failed for <tipo>/<id>`.
//   • `TEXT_COMPONENT` must be a component tipo the write path accepts for that
//     section; an unknown one refuses identically. Its MODEL is NOT pinned
//     here — `test17` (component_text_area) and `test22` (component_number)
//     both go green — because the embed group's `ddo_map` is declared by THIS
//     FILE's injected ontology port, not read from `test2`'s own
//     request_config (which happens to list `test52` as well).
// So neither rename is silent, but neither is free. And emptiness is caught on
// its own: aim the descriptor at a tipo nothing resolves for and the retrieval
// assertions go red on an empty store rather than passing on nothing.
//
// One ontological oddity, since the names suggest otherwise: `test52` is NOT a
// child of `test2`. Its ONLY defining node in
// `src/core/test_data/test_tld_ontology.json` is
// `{tipo: test52, parent: test45, model: component_input_text}`, and `test45`
// is the `components a-z` section_group of the OTHER test section, `test3`
// (every other `test52` occurrence in that file is a REFERENCE, not a second
// definition — mostly ddo_map and `relations`, plus a few property spellings:
// test118's section_list_thesaurus_indexation, test137's section_map term, and
// test212's component_info widget source). The pairing holds because the descriptor names the component
// explicitly with `section_tipo: 'self'` — it is a reuse, not a parentage.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ragApiActions } from '../../src/ai/rag/api.ts';
import { type AskDeps, fitTokenBudget, RESTRICTED_MSG, runAsk } from '../../src/ai/rag/ask.ts';
import { defaultOntologyPort, type OntologyPort, RagConfig } from '../../src/ai/rag/config.ts';
import { resolveEmbedDocs } from '../../src/ai/rag/embed_source.ts';
import {
	DeterministicHashProvider,
	getEmbeddingProvider,
} from '../../src/ai/rag/embedding_provider.ts';
import { defaultRagStore, RagIndexer } from '../../src/ai/rag/indexer.ts';
import { StubLlmProvider } from '../../src/ai/rag/llm_provider.ts';
import { PassThroughReranker } from '../../src/ai/rag/reranker.ts';
import type { RagPassageHit } from '../../src/ai/rag/retrieval.ts';
import { deleteRecordChunks } from '../../src/ai/rag/vector_store.ts';
import { saveComponentData } from '../../src/core/section/record/save_component.ts';
import type { Principal } from '../../src/core/security/permissions.ts';
import {
	type AiSpendLimitSnapshot,
	restoreAiSpendLimits,
	setAiSpendLimits,
	sweepAiSpendLedger,
} from '../helpers/ai_spend_ledger.ts';
import { cleanScratchRecord, createScratchRecord } from '../helpers/test_data.ts';

/**
 * ask grounded-Q&A pipeline (Brick 5). Runs offline (deterministic embedder +
 * stub LLM) against the live DBs. Asserts the load-bearing invariants: grounded
 * answer + citations; the grounding gate refuses with NO model call; token-budget
 * keeps ≥1 passage; an LLM transport failure maps to generation_failed.
 *
 * THE GROUNDING FIXTURE IS BUILT THROUGH THE PRODUCTION PATH (2026-08-30, audit
 * 2026-08-26 P1-14). Until now the record was indexed by `indexComponentText` —
 * a door in `retrieval.ts` with NO production caller and its own unchecked
 * `embed()` cast. It is deleted; the record below is written through the real
 * save path and indexed by `RagIndexer`, the class `buildRagIndexer()` wires for
 * the drain and the save queue, over the REAL `resolveEmbedDocs` seam. So the
 * passages the ask pipeline grounds on — including their `contributors`, which
 * the egress gate reads — are the ones a curator's save would have produced.
 */

process.env.DEDALO_RAG_ENABLED = 'true';

/**
 * PIN THE EMBEDDING PROVIDER — the file claimed offline and read the machine.
 *
 * `getEmbeddingProvider()` resolves from config, and this developer's
 * `../private/.env` sets `DEDALO_RAG_EMBEDDING_PROVIDER=sidecar`. With no
 * sidecar listening, `SidecarEmbeddingProvider.embed()` returns `[]` — its
 * documented fail-closed answer — and this gate wrote NULL embeddings until
 * Postgres refused with an opaque not-null violation on
 * `rag_embeddings_bge_m3`. Any value but `sidecar` selects the deterministic
 * hash provider, which is offline and reproducible.
 *
 * Both halves need the pin: the index half takes the provider by INJECTION
 * (below); the search half has no seam — `hybridCandidates` (retrieval.ts)
 * calls `getEmbeddingProvider()` itself — so it takes the key. They must agree,
 * because `provider.model` is the store's PARTITION KEY: indexing under
 * `det-hash-v1` and querying under `bge-m3` is not a wrong answer, it is
 * silently zero rows — which here reads as "not grounded", the exact assertion
 * this file makes about DENIED users.
 *
 * The prior value is RESTORED, not deleted: `bun test` runs a tier's files in
 * one process, and deleting the key would hand the next file the machine's
 * sidecar config instead of what it had.
 */
const PRIOR_EMBEDDING_PROVIDER = process.env.DEDALO_RAG_EMBEDDING_PROVIDER;
process.env.DEDALO_RAG_EMBEDDING_PROVIDER = 'deterministic';

const SECTION_TIPO = 'test2';
/**
 * The component this gate embeds: `component_input_text`, defined under
 * `test45` — see the header for why that is NOT a child of `test2` and why the
 * pairing works anyway. A literal leaf, so `emitDdoData` hands it a plain
 * string `entries[].value`, which is what `resolveEmbedDocs` harvests.
 */
const TEXT_COMPONENT = 'test52';
const DOC_LANG = 'lg-eng';
/** The embed group this gate declares; chunks store under `rag:<id>`. */
const EMBED_GROUP = 'probe';
const SUPERUSER: Principal = { userId: -1, isGlobalAdmin: true, isDeveloper: true };
/**
 * The `ask` door is METERED (ai_spend.ts) and an unset limit is 0, so root gets
 * explicit user-level AI limits for this gate's door legs (ample — the limits
 * are ai_spend_budget_native's subject), restored after with its ledger swept.
 */
let rootLimits: AiSpendLimitSnapshot | null = null;
const NO_ACCESS: Principal = { userId: 999999, isGlobalAdmin: false, isDeveloper: false };

// Reserved-high scratch twin (test/helpers/test_data.ts conventions): a fixed id
// clear of genuine records and of the sibling gates' bands, so the run is
// reproducible and the shared matrix counter never moves.
const COIN_ID = 906421;
const createdIds: number[] = [COIN_ID];

const COIN_TEXT =
	'Moneda ibérica de bronce acuñada en la ceca de Abariltur, con jinete y leyenda ibérica.';

type Ctx = { requestId: string; session: { userId: number } | null; principal?: Principal };
const askRqo = (options: Record<string, unknown>) => ({ options }) as never;

const passage = (over: Partial<RagPassageHit> = {}): RagPassageHit => ({
	section_tipo: 'test2',
	section_id: 1,
	component_tipo: 'testmint1002',
	lang: 'lg-spa',
	chunk_index: 0,
	snippet: 'x'.repeat(40),
	score: 1,
	...over,
});

const baseDeps = (llm: AskDeps['llm']): AskDeps => ({
	llm,
	reranker: new PassThroughReranker(),
	egress: async () => 'restricted' as const,
	systemPrompt: async () => 'system prompt',
});

/**
 * The real ontology port with ONE override: the `rag.embed` descriptor that opts
 * `test2` in. Everything else delegates to the live resolver so
 * `resolveEmbedDocs` resolves the ddo_map through the SAME request_config
 * machinery the human read uses. Injected into THIS FILE'S INDEXER ONLY — never
 * written into `dd_ontology`, which a test must not mutate.
 */
function probeOntology(): OntologyPort {
	const real = defaultOntologyPort();
	return {
		getProperties: (tipo) => real.getProperties(tipo),
		getModelByTipo: (tipo) => real.getModelByTipo(tipo),
		getTranslatable: (tipo) => real.getTranslatable(tipo),
		getSectionMapRag: async (tipo) =>
			tipo === SECTION_TIPO
				? {
						embed: [
							{
								id: EMBED_GROUP,
								ddo_map: [{ tipo: TEXT_COMPONENT, section_tipo: 'self', mode: 'list' }],
							},
						],
					}
				: null,
	};
}

/**
 * The PRODUCTION `RagIndexer` class, wired by hand. What it SHARES with
 * `buildRagIndexer()` (indexer.ts) is the load-bearing half: the real
 * `defaultRagStore()` and the real `resolveEmbedDocs` seam, so descriptor →
 * ddo_map → chunk → embed → upsert → stale-prune runs here exactly as it does
 * for the drain and the save queue.
 *
 * SIX constructor deps differ in value from `buildRagIndexer()` — `config`,
 * `ontology`, `provider`, `langs`, `nolan`, `recordTitle` — and the gate also
 * omits production's `...buildImageDeps()` entirely, since nothing here indexes
 * an image. The list below is what matters; treat it as the enumeration, not the
 * arithmetic. (An earlier revision said FIVE and folded `config` into `ontology`
 * in the same breath, which is exactly how an unlisted difference becomes an
 * untested one.)
 *  • `ontology` (and the `config` built over it) — the descriptor-bearing port
 *    above, so `test2` is opted in without mutating `dd_ontology`.
 *  • `provider` — an INJECTED `DeterministicHashProvider` rather than
 *    `getEmbeddingProvider()`: this half has a seam, so the pin is a dep and
 *    not an env read (the search half has none — see the provider-pin note).
 *  • `langs` — `[DOC_LANG]` rather than `config.menu.projectsDefaultLangs`:
 *    the fixture writes exactly one language, and inheriting the machine's
 *    list is the ambient-situation reading this suite forbids.
 *  • `nolan` — the literal `lg-nolan` rather than `readString('DEDALO_DATA_NOLAN')`,
 *    for that same reason.
 *  • `recordTitle` — deliberately EMPTY rather than `getTermByTipo`: the chunker
 *    prepends it to every chunk's embed text, and a section title shared by
 *    every chunk is pure noise in the one vector this gate grounds on.
 *
 * And one production dep is OMITTED: `buildRagIndexer()` spreads
 * `...(buildImageDeps() ?? {})`. This gate indexes text only, so it carries no
 * image half at all — the same shape an install with media indexing off gets.
 */
function offlineIndexer(): RagIndexer {
	const ontology = probeOntology();
	return new RagIndexer({
		ontology,
		config: new RagConfig(ontology),
		store: defaultRagStore(),
		provider: new DeterministicHashProvider(),
		langs: [DOC_LANG],
		nolan: 'lg-nolan',
		resolveDocs: resolveEmbedDocs,
		recordTitle: async () => '',
	});
}

beforeAll(async () => {
	// Clean BEFORE as well as after: a crashed earlier run leaves both a matrix
	// twin and its vectors behind, and an un-swept twin would be re-indexed with
	// stale text under a fixed id — the one way a reserved-high fixture can stop
	// being reproducible.
	await deleteRecordChunks(SECTION_TIPO, COIN_ID);
	await cleanScratchRecord(SECTION_TIPO, COIN_ID);
	await createScratchRecord(SECTION_TIPO, COIN_ID);
	const saved = await saveComponentData({
		componentTipo: TEXT_COMPONENT,
		sectionTipo: SECTION_TIPO,
		sectionId: COIN_ID,
		lang: DOC_LANG,
		changedData: [{ action: 'update', id: null, value: { lang: DOC_LANG, value: COIN_TEXT } }],
		userId: -1,
	});
	if (!saved.ok) throw new Error(`fixture save failed for ${SECTION_TIPO}/${COIN_ID}`);
	const indexed = await offlineIndexer().indexRecord({
		sectionTipo: SECTION_TIPO,
		sectionId: COIN_ID,
	});
	// indexRecord returns false on a RETRYABLE failure and never throws, so an
	// unchecked call would leave every grounding assertion below testing an empty
	// store — which reads as "not grounded", i.e. a FALSE GREEN on the refusal
	// tests and an unexplained red on the rest. Fail here instead.
	if (!indexed) throw new Error(`fixture index failed for ${SECTION_TIPO}/${COIN_ID}`);
	rootLimits = await setAiSpendLimits(
		{ userId: SUPERUSER.userId },
		{ runs: 1000, tokens: 100_000_000, embeds: 1000, vision: 1000 },
	);
});

afterAll(async () => {
	if (rootLimits !== null) await restoreAiSpendLimits([rootLimits]);
	await sweepAiSpendLedger([SUPERUSER.userId]);
	for (const id of createdIds) {
		await deleteRecordChunks(SECTION_TIPO, id);
		await cleanScratchRecord(SECTION_TIPO, id);
	}
	// assigning undefined coerces to the STRING 'undefined' — only delete truly unsets the key
	delete process.env.DEDALO_RAG_ENABLED;
	if (PRIOR_EMBEDDING_PROVIDER === undefined) {
		delete process.env.DEDALO_RAG_EMBEDDING_PROVIDER;
	} else {
		process.env.DEDALO_RAG_EMBEDDING_PROVIDER = PRIOR_EMBEDDING_PROVIDER;
	}
});

describe('fitTokenBudget', () => {
	// The pin is an invariant of this file, not a hope: if the machine's config
	// ever wins again, every grounding assertion is embedding against a sidecar.
	test('the provider is PINNED deterministic, whatever this machine configures', () => {
		expect(getEmbeddingProvider().model).toBe('det-hash-v1');
	});

	test('keeps at least the top passage even when it exceeds the budget', () => {
		const kept = fitTokenBudget([passage(), passage({ chunk_index: 1 })], 'sys', 'q', 0);
		expect(kept.length).toBe(1);
	});
	test('empty passages → empty', () => {
		expect(fitTokenBudget([], 'sys', 'q', 100)).toEqual([]);
	});
});

describe('runAsk grounding gate', () => {
	test('a denied principal refuses WITHOUT calling the LLM', async () => {
		const stub = new StubLlmProvider();
		const result = await runAsk(
			{ principal: NO_ACCESS, query: 'moneda de bronce', sectionTipos: [SECTION_TIPO], topK: 5 },
			baseDeps(stub),
		);
		expect(result.grounded).toBe(false);
		expect(result.answer).toBe('');
		expect(stub.calls.length).toBe(0); // NO model call on refusal
	});

	test('an LLM transport failure propagates (caller maps to generation_failed)', async () => {
		const throwing: AskDeps['llm'] = {
			model: () => 'boom',
			generate: async () => {
				throw new Error('boom');
			},
		};
		await expect(
			runAsk(
				{ principal: SUPERUSER, query: 'moneda de bronce', sectionTipos: [SECTION_TIPO], topK: 5 },
				baseDeps(throwing),
			),
		).rejects.toThrow();
	});
});

describe('runAsk egress gate', () => {
	test('a restricted passage BLOCKS an external provider (no generate call, restricted refusal)', async () => {
		const external = new StubLlmProvider(); // stands in for the off-box provider
		const result = await runAsk(
			{ principal: SUPERUSER, query: 'moneda de bronce', sectionTipos: [SECTION_TIPO], topK: 5 },
			{ ...baseDeps(external), llmIsExternal: true }, // egress:'restricted' from baseDeps
		);
		expect(external.calls.length).toBe(0); // restricted content never egressed
		expect(result.grounded).toBe(false);
		expect(result.restricted).toBe(true);
		expect(result.answer).toBe('');
		expect(result.provenance.length).toBeGreaterThan(0); // sources still surfaced
	});

	test('a restricted passage falls back to the injected local provider', async () => {
		const external = new StubLlmProvider({ model: 'external' });
		const local = new StubLlmProvider({ model: 'local' });
		const result = await runAsk(
			{ principal: SUPERUSER, query: 'moneda de bronce', sectionTipos: [SECTION_TIPO], topK: 5 },
			{ ...baseDeps(external), llmIsExternal: true, localLlm: local },
		);
		expect(external.calls.length).toBe(0); // external still not called
		expect(local.calls.length).toBe(1); // local served it instead
		expect(result.grounded).toBe(true);
		expect(result.restricted).toBeUndefined();
	});

	test('a local (non-external) provider generates even when restricted', async () => {
		const local = new StubLlmProvider();
		const result = await runAsk(
			{ principal: SUPERUSER, query: 'moneda de bronce', sectionTipos: [SECTION_TIPO], topK: 5 },
			baseDeps(local), // llmIsExternal defaults false; egress:'restricted'
		);
		expect(local.calls.length).toBe(1);
		expect(result.grounded).toBe(true);
	});
});

describe('dd_rag_api ask', () => {
	test('superuser gets a grounded answer with citations', async () => {
		const res = await ragApiActions.ask(
			askRqo({ query: 'moneda de bronce con jinete', limit: 5 }),
			{
				principal: SUPERUSER,
			} as Ctx,
		);
		expect(res.body.msg).toBe('ok');
		// envelope v2: the payload is `data` (the `result` compat key was removed 2026-08-16)
		const result = res.body.data as {
			grounded: boolean;
			answer: string;
			citations: unknown[];
		};
		expect(result.grounded).toBe(true);
		expect(result.answer.length).toBeGreaterThan(0);
		expect(result.citations.length).toBeGreaterThan(0);
	});

	// The ACL half (a caller who reads nothing gets the NORMAL no_grounded_context
	// envelope) is runAsk's, pinned above with the same NO_ACCESS principal. At the
	// DOOR that caller holds no `tool_rag` grant (TOOLS-4, WC-2026-10-01-ai-spend-budget):
	// it is refused before anything is read or spent — ai_spend_budget_native drives
	// the granted / ungranted pair with real fixture profiles.
	test('a caller without the tool_rag grant is refused tool.not_authorized at the door', async () => {
		await expect(
			ragApiActions.ask(askRqo({ query: 'moneda de bronce con jinete', limit: 5 }), {
				principal: NO_ACCESS,
			} as Ctx),
		).rejects.toMatchObject({ code: 'tool.not_authorized' });
	});

	test('a dead LLM endpoint maps to generation_failed', async () => {
		process.env.DEDALO_RAG_LLM_ENDPOINT = 'http://127.0.0.1:1/nope'; // connection refused
		// Permit external egress so the (dead) endpoint is actually reached — the
		// egress gate otherwise blocks the external provider before any transport.
		process.env.DEDALO_RAG_ALLOW_EXTERNAL_PROVIDER_DEFAULT = 'true';
		try {
			// a transport failure is the typed rag.generation_failed THROW (never a fabricated answer)
			await expect(
				ragApiActions.ask(askRqo({ query: 'moneda de bronce', limit: 5 }), {
					principal: SUPERUSER,
				} as Ctx),
			).rejects.toMatchObject({ code: 'rag.generation_failed' });
		} finally {
			// assigning undefined coerces to the STRING 'undefined' — only delete truly unsets the key
			delete process.env.DEDALO_RAG_LLM_ENDPOINT;
			// assigning undefined coerces to the STRING 'undefined' — only delete truly unsets the key
			delete process.env.DEDALO_RAG_ALLOW_EXTERNAL_PROVIDER_DEFAULT;
		}
	});

	test('an external endpoint is NOT reached for restricted content (egress gate)', async () => {
		// Endpoint configured (external) but external egress NOT permitted by default
		// ⇒ every passage is restricted ⇒ the gate must refuse WITHOUT transport, so
		// a connection-refused endpoint never produces generation_failed.
		process.env.DEDALO_RAG_LLM_ENDPOINT = 'http://127.0.0.1:1/nope';
		try {
			const res = await ragApiActions.ask(askRqo({ query: 'moneda de bronce', limit: 5 }), {
				principal: SUPERUSER,
			} as Ctx);
			expect(res.body.msg).toBe(RESTRICTED_MSG);
			// no transport happened ⇒ NOT the rag.generation_failed throw, i.e. a success envelope
			expect(res.body.ok).toBe(true);
			expect((res.body.data as { restricted?: boolean }).restricted).toBe(true);
		} finally {
			// assigning undefined coerces to the STRING 'undefined' — only delete truly unsets the key
			delete process.env.DEDALO_RAG_LLM_ENDPOINT;
		}
	});
});
