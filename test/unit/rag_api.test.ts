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
import { defaultOntologyPort, type OntologyPort, RagConfig } from '../../src/ai/rag/config.ts';
import { resolveEmbedDocs } from '../../src/ai/rag/embed_source.ts';
import {
	DeterministicHashProvider,
	getEmbeddingProvider,
} from '../../src/ai/rag/embedding_provider.ts';
import { defaultRagStore, RagIndexer } from '../../src/ai/rag/indexer.ts';
import { deleteRecordChunks } from '../../src/ai/rag/vector_store.ts';
import type { Rqo } from '../../src/core/concepts/rqo.ts';
import { saveComponentData } from '../../src/core/section/record/save_component.ts';
import type { Principal } from '../../src/core/security/permissions.ts';
import {
	type AiSpendLimitSnapshot,
	AMPLE_AI_SPEND_LIMITS,
	restoreAiSpendLimits,
	setAiSpendLimits,
	sweepAiSpendLedger,
} from '../helpers/ai_spend_ledger.ts';
import {
	DOOR_READER_USER_ID,
	installReadDoorIdentityFixture,
	removeReadDoorIdentityFixture,
} from '../helpers/read_door_identity_fixture.ts';
import { cleanScratchRecord, createScratchRecord } from '../helpers/test_data.ts';

/**
 * dd_rag_api handler tests (Brick 4). Exercises the four registered actions end
 * to end against the live pgvector + matrix DBs, and re-asserts the ACL DoD at
 * the API layer: a denied principal gets NOTHING from any action. RAG is
 * enabled for this suite via process.env.
 *
 * THE FIXTURE IS BUILT THROUGH THE PRODUCTION PATH (2026-08-30, audit
 * 2026-08-26 P1-14). Until now the two records were indexed by
 * `indexComponentText` — a door in `retrieval.ts` with NO production caller,
 * carrying its own unchecked `embed()` cast. It is deleted; the records below
 * are written through the real save path and indexed by `RagIndexer`, the class
 * `buildRagIndexer()` wires for the drain and the save queue, over the REAL
 * `resolveEmbedDocs` resolution seam. What the API serves is therefore what a
 * curator's save would have produced, not what a test-only shortcut produced.
 */

// Enable the kill-switch BEFORE any handler runs (readEnv reads process.env).
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
 * The pin is needed on BOTH halves: the index half takes the provider by
 * INJECTION (below), the search half has no seam — `hybridCandidates`
 * (retrieval.ts) calls `getEmbeddingProvider()` itself — so it takes the key.
 * They must agree, because `provider.model` is the store's PARTITION KEY:
 * indexing under `det-hash-v1` and querying under `bge-m3` is not a wrong
 * answer, it is silently zero rows.
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
const NO_ACCESS: Principal = { userId: 999999, isGlobalAdmin: false, isDeveloper: false };
/**
 * The DENIED SPENDER of the metered doors (semantic_search, retrieve): those doors
 * reserve the caller's AI limits before they search, and a user with no record
 * holds no limit (0 refuses), so the access-filter legs need a REAL user that may
 * spend but holds NO grant on test2 — the read-door fixture's READER (dd774 has
 * no test2 entry at all), given ample limits on its own user record.
 */
const DENIED_SPENDER: Principal = {
	userId: DOOR_READER_USER_ID,
	isGlobalAdmin: false,
	isDeveloper: false,
};
/** Root's limit keys as they were (restored after); see DENIED_SPENDER. */
let limitSnapshots: AiSpendLimitSnapshot[] = [];

// Reserved-high scratch twins (test/helpers/test_data.ts conventions): fixed ids
// clear of genuine records and of the sibling gates' bands, so the run is
// reproducible and the shared matrix counter never moves.
const COIN_ID = 906411;
const SHIP_ID = 906412;
const createdIds: number[] = [COIN_ID, SHIP_ID];

const COIN_TEXT =
	'Moneda ibérica de bronce acuñada en la ceca de Abariltur, con jinete y leyenda ibérica.';
const SHIP_TEXT =
	'Naufragio de un barco fenicio con ánforas de aceite frente a la costa de Cartagena.';

type Ctx = { requestId: string; session: { userId: number } | null; principal?: Principal };
const rqo = (options: Record<string, unknown>): Rqo => ({ options }) as unknown as Rqo;

/**
 * The real ontology port with ONE override: the `rag.embed` descriptor that opts
 * `test2` in. Everything else delegates to the live resolver so
 * `resolveEmbedDocs` resolves the ddo_map through the SAME request_config
 * machinery the human read uses.
 *
 * It is injected into THIS FILE'S INDEXER ONLY — never written into
 * `dd_ontology`, which a test must not mutate. The API handlers build their own
 * `RagConfig` over the real port, so `test2` correctly stays "not opted in" for
 * the `embed_groups` assertions at the bottom of this file: the descriptor is
 * the fixture's, not the installation's.
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
 *    prepends it to every chunk's embed text, so a shared section title
 *    injects identical tokens into every record's vector — exactly the noise
 *    that would blunt the vocabulary discrimination the ranking assertions
 *    measure on a bag-of-words embedder.
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

/** Build one record (real write path) and index it (production indexer). */
async function buildAndIndex(indexer: RagIndexer, sectionId: number, text: string): Promise<void> {
	// Clean BEFORE as well as after: a crashed earlier run leaves both a matrix
	// twin and its vectors behind, and an un-swept twin would be re-indexed with
	// stale text under a fixed id — the one way a reserved-high fixture can stop
	// being reproducible.
	await deleteRecordChunks(SECTION_TIPO, sectionId);
	await cleanScratchRecord(SECTION_TIPO, sectionId);
	await createScratchRecord(SECTION_TIPO, sectionId);
	const saved = await saveComponentData({
		componentTipo: TEXT_COMPONENT,
		sectionTipo: SECTION_TIPO,
		sectionId,
		lang: DOC_LANG,
		changedData: [{ action: 'update', id: null, value: { lang: DOC_LANG, value: text } }],
		userId: -1,
	});
	if (!saved.ok) throw new Error(`fixture save failed for ${SECTION_TIPO}/${sectionId}`);
	const indexed = await indexer.indexRecord({ sectionTipo: SECTION_TIPO, sectionId });
	// indexRecord returns false on a RETRYABLE failure and never throws, so an
	// unchecked call would leave every action below asserting against an empty
	// store and blaming the API for it. Fail here, where the cause is visible.
	if (!indexed) throw new Error(`fixture index failed for ${SECTION_TIPO}/${sectionId}`);
}

beforeAll(async () => {
	const indexer = offlineIndexer();
	await buildAndIndex(indexer, COIN_ID, COIN_TEXT);
	await buildAndIndex(indexer, SHIP_ID, SHIP_TEXT);
	await installReadDoorIdentityFixture();
	// Ample limits (the budget is ai_spend_budget_native's subject, not this gate's).
	limitSnapshots = [
		await setAiSpendLimits({ userId: SUPERUSER.userId }, AMPLE_AI_SPEND_LIMITS),
		await setAiSpendLimits({ userId: DENIED_SPENDER.userId }, AMPLE_AI_SPEND_LIMITS),
	];
});

afterAll(async () => {
	await restoreAiSpendLimits(limitSnapshots);
	await sweepAiSpendLedger([SUPERUSER.userId, DENIED_SPENDER.userId]);
	await removeReadDoorIdentityFixture();
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

describe('dd_rag_api semantic_search', () => {
	// The pin is an invariant of this file, not a hope: if the machine's config
	// ever wins again, every action below is embedding against a sidecar and the
	// reds would be blamed on the handlers.
	test('the provider is PINNED deterministic, whatever this machine configures', () => {
		expect(getEmbeddingProvider().model).toBe('det-hash-v1');
	});

	test('superuser gets the vocabulary-matching record first', async () => {
		const res = await ragApiActions.semantic_search(
			rqo({ query: 'moneda de bronce con jinete ceca', limit: 5 }),
			{ principal: SUPERUSER } as Ctx,
		);
		expect(res.body.msg).toBe('ok');
		const hits = res.body.data as { section_id: number; snippet: string }[];
		expect(hits.length).toBeGreaterThan(0);
		expect(hits[0]!.section_id).toBe(COIN_ID);
		expect(hits[0]!.snippet).toContain('Abariltur');
	});

	test('a denied user gets NOTHING (DoD)', async () => {
		const res = await ragApiActions.semantic_search(
			rqo({ query: 'moneda de bronce con jinete ceca', limit: 5 }),
			{ principal: DENIED_SPENDER } as Ctx,
		);
		expect(res.body.msg).toBe('ok');
		expect(res.body.data).toEqual([]);
	});

	test('missing query is rejected', async () => {
		// a refusal is a THROW (the dispatch catch converts it): request.invalid_options
		await expect(
			ragApiActions.semantic_search(rqo({}), { principal: SUPERUSER } as Ctx),
		).rejects.toMatchObject({ code: 'request.invalid_options' });
	});
});

describe('dd_rag_api retrieve / get_agent_context', () => {
	test('retrieve returns passages with chunk_index', async () => {
		const res = await ragApiActions.retrieve(rqo({ query: 'barco fenicio ánforas', limit: 5 }), {
			principal: SUPERUSER,
		} as Ctx);
		expect(res.body.msg).toBe('ok');
		const passages = res.body.data as { section_id: number; chunk_index: number }[];
		expect(passages.length).toBeGreaterThan(0);
		expect(passages[0]!.chunk_index).toBe(0);
	});

	test('get_agent_context uses the agent_context message', async () => {
		const res = await ragApiActions.get_agent_context(
			rqo({ query: 'barco fenicio ánforas', limit: 5 }),
			{ principal: SUPERUSER } as Ctx,
		);
		expect(res.body.msg).toBe('agent_context');
	});

	test('a denied user gets NOTHING from retrieve (DoD)', async () => {
		const res = await ragApiActions.retrieve(rqo({ query: 'barco fenicio ánforas', limit: 5 }), {
			principal: DENIED_SPENDER,
		} as Ctx);
		expect(res.body.msg).toBe('ok');
		expect(res.body.data).toEqual([]);
	});
});

describe('dd_rag_api similar_to', () => {
	test('finds the other record and excludes the seed', async () => {
		const res = await ragApiActions.similar_to(
			rqo({ section_tipo: SECTION_TIPO, section_id: COIN_ID, limit: 5 }),
			{ principal: SUPERUSER } as Ctx,
		);
		const hits = res.body.data as { section_id: number }[];
		expect(hits.every((h) => h.section_id !== COIN_ID)).toBe(true);
		expect(hits.some((h) => h.section_id === SHIP_ID)).toBe(true);
	});

	test('a denied user gets NOTHING from similar_to (DoD)', async () => {
		const res = await ragApiActions.similar_to(
			rqo({ section_tipo: SECTION_TIPO, section_id: COIN_ID, limit: 5 }),
			{ principal: NO_ACCESS } as Ctx,
		);
		expect(res.body.data).toEqual([]);
	});

	test('missing seed is rejected', async () => {
		await expect(
			ragApiActions.similar_to(rqo({ section_tipo: SECTION_TIPO }), {
				principal: SUPERUSER,
			} as Ctx),
		).rejects.toMatchObject({ code: 'request.invalid_options' });
	});
});

describe('dd_rag_api kill-switch', () => {
	test('declines every ACTION when DEDALO_RAG_ENABLED is off', async () => {
		process.env.DEDALO_RAG_ENABLED = '';
		try {
			await expect(
				ragApiActions.semantic_search(rqo({ query: 'x' }), { principal: SUPERUSER } as Ctx),
			).rejects.toMatchObject({ code: 'rag.disabled' });
		} finally {
			process.env.DEDALO_RAG_ENABLED = 'true';
		}
	});

	// The one exception, and the reason for it: embed_groups is the client's
	// CAPABILITY PROBE, fired on every section list render with no user act
	// behind it. A decline there is a red per-navigation alert on an install
	// that deliberately never implemented RAG, so the switch ANSWERS instead.
	//
	// The context carries NO principal and NO session ON PURPOSE — that is what
	// makes this gate see the kill-switch branch and nothing else. Any other
	// empty answer (malformed tipo, denied caller, not opted in) is produced
	// AFTER resolveCaller, so with the switch on this same call throws
	// auth.not_logged; before this change it threw rag.disabled. Only the
	// switch answering FIRST can make it resolve.
	test('embed_groups ANSWERS empty when off, before any caller resolves', async () => {
		const bare = { requestId: 'rag-api-test', session: null } as Ctx;

		await expect(
			ragApiActions.embed_groups(rqo({ section_tipo: 'test6099' }), bare),
		).rejects.toMatchObject({ code: 'auth.not_logged' });

		process.env.DEDALO_RAG_ENABLED = '';
		try {
			const res = await ragApiActions.embed_groups(rqo({ section_tipo: 'test6099' }), bare);
			expect(res.status).toBe(200);
			expect(res.body.ok).toBe(true);
			expect(res.body.data).toEqual({ groups: [] });
		} finally {
			process.env.DEDALO_RAG_ENABLED = 'true';
		}
	});
});

describe('dd_rag_api embed_groups', () => {
	const ctx = (principal: Principal): Ctx => ({
		requestId: 'rag-api-test',
		session: { userId: principal.userId },
		principal,
	});

	// SHAPE ONLY, and the name says so: no repo-owned `test` TLD section_map
	// declares an `rag.embed` group today, so the group-LISTING path (a
	// descriptor resolving to ids) is not covered by this suite. Naming it
	// "opted-in section returns its group ids" claimed coverage that never
	// existed — the fix is a test fixture with a descriptor, not a rename.
	test('a readable section answers the SHAPE (array of slugs) — no descriptor in the test TLD', async () => {
		const res = await ragApiActions.embed_groups(rqo({ section_tipo: 'test6099' }), ctx(SUPERUSER));
		const result = res.body.data as { groups: string[] };
		expect(Array.isArray(result.groups)).toBe(true);
	});

	// `test2` is the "not opted in" arm even though this file INDEXED test2
	// records: the descriptor that opted them in lives in this file's injected
	// ontology port, never in dd_ontology, and these handlers read the real one.
	test('RAG off, not-opted-in, malformed tipo, and DENIED caller are byte-identical empty (no oracle)', async () => {
		const notOpted = await ragApiActions.embed_groups(
			rqo({ section_tipo: 'test2' }),
			ctx(SUPERUSER),
		);
		const malformed = await ragApiActions.embed_groups(
			rqo({ section_tipo: 'x; DROP TABLE--' }),
			ctx(SUPERUSER),
		);
		const denied = await ragApiActions.embed_groups(
			rqo({ section_tipo: 'test6099' }),
			ctx(NO_ACCESS),
		);
		process.env.DEDALO_RAG_ENABLED = '';
		let ragOff: Awaited<ReturnType<typeof ragApiActions.embed_groups>>;
		try {
			ragOff = await ragApiActions.embed_groups(rqo({ section_tipo: 'test6099' }), ctx(SUPERUSER));
		} finally {
			process.env.DEDALO_RAG_ENABLED = 'true';
		}
		expect(notOpted.body.data).toEqual({ groups: [] });
		expect(JSON.stringify(malformed.body)).toBe(JSON.stringify(notOpted.body));
		expect(JSON.stringify(denied.body)).toBe(JSON.stringify(notOpted.body));
		expect(JSON.stringify(ragOff.body)).toBe(JSON.stringify(notOpted.body));
	});
});
