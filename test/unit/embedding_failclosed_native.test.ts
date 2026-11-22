/**
 * TRIPWIRE + BEHAVIOURAL GATE — EVERY EMBEDDING CALL SITE FAILS CLOSED (P1-14,
 * closing AIX-01 and AIX-02 of the 2026-08-26 deep audit).
 *
 * THE CONTRACT THIS GATE IS BUILT ON. `EmbeddingProvider.embed()` (and its
 * multimodal twins `embedImage` / `embedTextForImageSearch`) return EITHER
 * exactly `texts.length` vectors OR `[]`. The empty array is the DOCUMENTED
 * fail-closed answer, not an exception: SidecarEmbeddingProvider returns it on
 * every ordinary hiccup — a non-ok HTTP response, a body whose `embeddings` is
 * not an array, a row that is not all numbers, a fetch throw, an
 * AbortController timeout, or a batch whose length does not match the input
 * ("fail closed: retryable", embedding_provider.ts). "The sidecar is down
 * today" therefore arrives at every call site as an ordinary value, and it is
 * the CALL SITE that decides whether the engine refuses or invents an answer.
 *
 * THE DEFECT (retrieval.ts, until 2026-08-30). `const [queryEmbedding] = await
 * provider.embed([query])` yielded `undefined`; the `as number[]` cast erased
 * it; denseSearch's `JSON.stringify(queryEmbedding)` — `JSON.stringify(
 * undefined)` is the JS value `undefined` — bound SQL NULL into `$1::vector`.
 * That path DOES NOT ERROR: `1 - (embedding <=> NULL::vector)` is NULL for
 * every row, an ORDER BY over all-NULL orders nothing, and Reciprocal Rank
 * Fusion scores by POSITION and never reads the null score. ARBITRARY records
 * entered at the top dense ranks and were presented to a curator — or to an
 * agent that then WRITES — as the answer. Silent, plausible, wrong.
 *
 * TWO LEGS, because either alone is a gate that can be walked around:
 *
 *  1. BEHAVIOURAL. Every call site is DRIVEN with a provider that gives the
 *     documented fail-closed answer, and must produce a REFUSAL (a typed throw)
 *     or a documented retryable no-write — never a result set. Each site also
 *     gets a NEGATIVE CONTROL with a healthy provider: a refusal that fires
 *     always is not a guard, it is an outage, and only the control tells the
 *     two apart.
 *
 *  2. THE CENSUS. The call sites are DERIVED by scanning `src/` and
 *     `tools/*​/server/`, and each one must carry a row with a verdict and a
 *     MECHANICALLY CHECKED guard. This is what stops a fourth call site landing
 *     unguarded next year — the previous shape of this invariant was a sentence
 *     in a docblock, and two of the three sites did not know about it.
 *
 * THE PROVIDER IS PINNED, NEVER INHERITED — AND THE PIN IS PUT BACK. Reading
 * the machine's configured provider WAS the defect: a gate that embeds through
 * whatever happens to be listening on this host is green or red by accident.
 * The three older rag gates (rag_api, rag_ask, rag_pipeline) were fixed for it
 * in this same change set — each now sets DEDALO_RAG_EMBEDDING_PROVIDER =
 * 'deterministic' and restores the prior value. That fix makes their embeddings
 * offline and reproducible; it does not exercise a FAILING provider at all,
 * which is why this file exists: the fail-closed behaviour is proved here
 * rather than assumed there.
 *
 * The pin is DEDALO_RAG_EMBEDDING_PROVIDER/_ENDPOINT/_MODEL at a stub sidecar
 * this file serves itself, so the outcome is a property of the ENGINE. It is
 * set in beforeAll and RESTORED, key by key, in afterAll: `bun test` runs a
 * tier's files in ONE process, so an unrestored assignment at module scope is
 * not a local convenience, it is configuration handed to every file that runs
 * after this one.
 *
 * MUTATION-MEASURED 2026-08-30, re-measured on this revision (green: 28 pass /
 * 0 fail / 69 expect()). Reverting `assertQueryVector` in retrieval.ts to the
 * pre-fix destructure: 7 RED — all six refusal cases plus the census's
 * forbidden-shape check. Deleting the indexer's count check (indexer.ts): 2 RED
 * — the empty-answer behaviour plus the census's guard-present check. Both files
 * restored byte-exactly (sha256 verified before and after). Both legs therefore
 * have teeth on their own, which is the point of having two.
 *
 * NO INSTALLATION SURFACE IS REACHABLE, AND THIS FILE REPOINTS NOTHING TO GET
 * THERE. The vector store is already sealed by the suite seam: `test/preload/
 * rag_db.ts` sets DEDALO_TEST_RAG_DB_NAME unconditionally, which both repoints
 * `ragSql` (vector_store.ts `buildRagSqlOptions`) at the suite's own vector
 * database and arms the marker refusal on every write door (P1-16). This gate
 * inherits that and adds NOTHING of its own — an earlier revision repointed the
 * pool at a per-process database name that could not exist, and because
 * vector_store.ts builds its pool ONCE at import time, every later file in the
 * run inherited a dead pool (measured: this file + rag_ask.test.ts = 2 failures
 * that neither file has alone). A gate that breaks the suite to prove a point
 * is not a gate.
 *
 * So the imports below are static, and none of the refusal cases touches the
 * store at all: `assertQueryVector` throws BEFORE denseSearch is called. Only
 * the two negative controls reach the store, and what they assert is exactly
 * what a control may assert — that the embedding refusal did NOT fire — never
 * anything about what the suite's index happens to contain.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { RagConfig } from '../../src/ai/rag/config.ts';
import {
	DeterministicHashProvider,
	getEmbeddingProvider,
} from '../../src/ai/rag/embedding_provider.ts';
import type { RagImageDeps, RagStore } from '../../src/ai/rag/indexer.ts';
import { RagIndexer } from '../../src/ai/rag/indexer.ts';
import type { MultimodalRuntimeConfig } from '../../src/ai/rag/multimodal_config.ts';
import type { MultimodalEmbeddingProvider } from '../../src/ai/rag/multimodal_embedding_provider.ts';
import { ObjectRetrieval } from '../../src/ai/rag/object_retrieval.ts';
import { retrievePassages, semanticSearch } from '../../src/ai/rag/retrieval.ts';
import type { Candidate, EmbeddingRow, RecordLocator } from '../../src/ai/rag/types.ts';
import type { ApiRequestContext } from '../../src/core/api/dispatch.ts';
import type { IdentifyByImageDeps } from '../../src/core/api/handlers/dd_identify_api.ts';
import { buildIdentifyByImage } from '../../src/core/api/handlers/dd_identify_api.ts';
import type { Rqo } from '../../src/core/concepts/rqo.ts';
import { DedaloError } from '../../src/core/errors/dedalo_error.ts';
import type { Principal } from '../../src/core/security/permissions.ts';

const ROOT = resolve(import.meta.dir, '../..');

/* ───────────────── the stub sidecar, and the pinned environment ──────────── */

/** What the stub sidecar does to the NEXT request (one server, scripted). */
type SidecarMode = 'down' | 'nonNumeric' | 'hole' | 'overCount' | 'healthy';

let sidecarMode: SidecarMode = 'down';
let sidecarRequests = 0;

/** A well-formed vector. Width is irrelevant to the guard (it compares against
 * nothing); it only has to be > 0 and all-finite, so 8 is plenty. */
const HEALTHY_VECTOR = [0.1, -0.2, 0.3, -0.4, 0.5, -0.6, 0.7, -0.8];

const sidecar = Bun.serve({
	port: 0, // an ephemeral port: two agents may run this file at once
	fetch(request) {
		if (!new URL(request.url).pathname.endsWith('/embed')) {
			return new Response('not found', { status: 404 });
		}
		sidecarRequests += 1;
		switch (sidecarMode) {
			// Each arm is one documented way the sidecar hiccups. The first four
			// are what an operator's day looks like; only 'healthy' is the control.
			case 'down':
				return new Response('service unavailable', { status: 503 });
			case 'nonNumeric':
				// A row that is not all numbers → the provider fails closed with [].
				return Response.json({ embeddings: [[0.1, 'x', 0.3]] });
			case 'hole':
				// A right-length batch with a HOLE in it. The provider does NOT fail
				// closed here (an empty row is an Array of no non-numbers), so this
				// case exists to prove the CALL SITE's own width check, the one the
				// indexer has carried all along.
				return Response.json({ embeddings: [[]] });
			case 'overCount':
				// Two vectors for one text: the provider's batch-length mismatch.
				return Response.json({ embeddings: [HEALTHY_VECTOR, HEALTHY_VECTOR] });
			default:
				return Response.json({ embeddings: [HEALTHY_VECTOR] });
		}
	},
});

/**
 * THE PIN, AND ITS RESTORATION. The three keys below decide only which provider
 * `getEmbeddingProvider()` builds — it reads them LIVE, per call (readEnv is not
 * a boot snapshot), so nothing here has to precede an import and every import in
 * this file is static.
 *
 * They are restored key by key, undefined included: a whole tier runs in ONE
 * process, and `delete` where the machine had a value is as much a leak as an
 * unrestored assignment — the next file would then get the catalog default
 * instead of what it had. Note what is NOT here: the vector database. That seam
 * belongs to `test/preload/rag_db.ts`, which arms it for the whole run; a gate
 * that repoints the module-level `ragSql` pool poisons every file after it.
 *
 * `test/` is outside the process.env ban (config_env_tripwire scans src/ and
 * tools/): composing a process environment is what a preload and a seam-pinning
 * gate DO.
 */
const PINNED_ENV: Record<string, string> = {
	DEDALO_RAG_EMBEDDING_PROVIDER: 'sidecar',
	DEDALO_RAG_EMBEDDING_ENDPOINT: `http://127.0.0.1:${sidecar.port}`,
	DEDALO_RAG_EMBEDDING_MODEL: 'failclosed-stub-model',
};
const PRIOR_ENV: Record<string, string | undefined> = {};

beforeAll(() => {
	for (const [key, value] of Object.entries(PINNED_ENV)) {
		PRIOR_ENV[key] = process.env[key];
		process.env[key] = value;
	}
});

afterAll(() => {
	for (const key of Object.keys(PINNED_ENV)) {
		const prior = PRIOR_ENV[key];
		if (prior === undefined) delete process.env[key];
		else process.env[key] = prior;
	}
	sidecar.stop(true);
});

const SUPERUSER: Principal = { userId: -1, isGlobalAdmin: true, isDeveloper: true };

/** The outcome of a call, WITHOUT deciding in advance which one it must be —
 * "it returned rows" is itself one of the answers this gate has to be able to
 * see (it is the pre-fix behaviour). */
type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown };

async function outcomeOf(call: Promise<unknown>): Promise<Outcome> {
	return call.then(
		(value) => ({ ok: true as const, value }),
		(error: unknown) => ({ ok: false as const, error }),
	);
}

/** Assert an outcome is the typed refusal `rag.embedding_unavailable`. */
function expectEmbeddingRefusal(outcome: Outcome, what: string): void {
	if (outcome.ok) {
		// The pre-fix behaviour, stated as the failure message: a RESULT SET here
		// is the defect, whether it is rows or an empty list.
		throw new Error(
			`${what}: expected a refusal, got a RESULT (${JSON.stringify(outcome.value)}). An absent query vector must never become an answer — before the fix this returned arbitrary records at the top dense ranks.`,
		);
	}
	expect(outcome.error).toBeInstanceOf(DedaloError);
	expect((outcome.error as InstanceType<typeof DedaloError>).code).toBe(
		'rag.embedding_unavailable',
	);
}

/* ══════════════════════ LEG 1 — the behavioural gate ══════════════════════ */

describe('the provider is PINNED (this gate reads no machine configuration)', () => {
	test('getEmbeddingProvider() resolves to the stub sidecar, not the machine one', () => {
		const provider = getEmbeddingProvider();
		expect(provider.name).toBe('sidecar');
		expect(provider.model).toBe('failclosed-stub-model');
	});

	test('a 503 sidecar really does produce the documented [] (the premise)', async () => {
		sidecarMode = 'down';
		// If this ever returns vectors the whole file is testing nothing, because
		// every refusal below is a consequence of THIS value.
		expect(await getEmbeddingProvider().embed(['a query'])).toEqual([]);
	});
});

describe('SITE retrieval.ts#embed — the query embedder (the load-bearing one)', () => {
	// Every case here throws BEFORE denseSearch, so no store, no matrix, no ACL.
	const cases: Array<[SidecarMode, string]> = [
		['down', 'the sidecar answers 503'],
		['nonNumeric', 'a row is not all numbers'],
		['overCount', 'the batch length does not match the input'],
		['hole', 'the batch is the right length but the row is zero-width'],
	];

	for (const [mode, why] of cases) {
		test(`semanticSearch REFUSES when ${why}`, async () => {
			sidecarMode = mode;
			const before = sidecarRequests;
			const outcome = await outcomeOf(semanticSearch(SUPERUSER, 'a roman denarius', 5));
			expectEmbeddingRefusal(outcome, `semanticSearch/${mode}`);
			// The provider really ran: the refusal is the engine's answer to a
			// failed embedding, not a short-circuit that never asked.
			expect(sidecarRequests).toBe(before + 1);
		});
	}

	test('retrievePassages REFUSES too (the second door onto the same helper)', async () => {
		sidecarMode = 'down';
		const outcome = await outcomeOf(retrievePassages(SUPERUSER, 'a roman denarius', 5));
		expectEmbeddingRefusal(outcome, 'retrievePassages');
	});

	test('the refusal is a THROW — never an empty result set', async () => {
		sidecarMode = 'down';
		const outcome = await outcomeOf(semanticSearch(SUPERUSER, 'a roman denarius', 5));
		// Stated separately from the code check because "degrade to lexical-only"
		// and "return []" are the two tempting simplifications of this guard, and
		// both are wrong: an empty list is an ANSWER ("nothing matched"), and a
		// curator cannot tell it from an outage.
		expect(outcome.ok).toBe(false);
		expect(Array.isArray((outcome as { value?: unknown }).value)).toBe(false);
	});

	test('NEGATIVE CONTROL: a healthy vector passes the guard, into the store', async () => {
		sidecarMode = 'healthy';
		const before = sidecarRequests;
		// POISONED_LIMIT, the search-path spelling. What makes it a proof of passage
		// is not WHERE `limit` is read — `Math.max(limit * 4, 20)` is an ARGUMENT to
		// hybridCandidates, so the NaN is produced BEFORE the guard runs and merely
		// carried past it — but that it stays INERT until it is bound into the
		// store's LIMIT, deep past the refusal. Nothing between here and there
		// inspects it, so reaching the store's own complaint is only possible if the
		// guard let the call through. So the failure below is
		// the PROOF OF PASSAGE — measured on this machine as the store's own
		// `bigint out of range`, and on a runner with no Postgres it is the pool's
		// connection error, which is the same proof: the query was issued.
		const outcome = await outcomeOf(semanticSearch(SUPERUSER, 'a roman denarius', Number.NaN));
		expect(sidecarRequests).toBe(before + 1);
		expect(outcome.ok, 'a well-formed vector must reach the store leg').toBe(false);
		// And the failure must be the STORE's, never ours: a refusal that fires on a
		// healthy provider too is not a guard, it is an outage, and only this tells
		// the two apart. Nothing here asserts what the suite's index CONTAINS —
		// that is another gate's business, and another agent's in a parallel run.
		expect(
			outcome.ok ? null : outcome.error,
			'a healthy provider must NOT trip the embedding refusal; any failure past the guard belongs to the store',
		).not.toBeInstanceOf(DedaloError);
	}, 20000);
});

/* ─────────────────────────── the indexer's two sites ─────────────────────── */

const LOCATOR: RecordLocator = { sectionTipo: 'test3', sectionId: 1 };
const GROUP = 'default';

interface StoreCalls {
	upserts: EmbeddingRow[][];
	stale: number;
	prunedModalities: string[];
}

function fakeStore(): { store: RagStore; calls: StoreCalls } {
	const calls: StoreCalls = { upserts: [], stale: 0, prunedModalities: [] };
	const store: RagStore = {
		diffHashes: async () => new Map(),
		upsertEmbeddingRows: async (rows) => {
			calls.upserts.push(rows);
		},
		deleteStale: async () => {
			calls.stale += 1;
			return 0;
		},
		deleteRecordModality: async (_locator, modality) => {
			calls.prunedModalities.push(modality);
		},
		deleteRecord: async () => {},
		listSectionIds: async () => [],
	};
	return { store, calls };
}

/** A text provider whose embed() answer is scripted (the whole point). */
function scriptedTextProvider(vectors: number[][]) {
	return {
		name: 'stub',
		model: 'stub-text',
		dimension: 8,
		embed: async () => vectors,
	};
}

function textIndexer(
	provider: { embed: (texts: string[]) => Promise<number[][]> },
	store: RagStore,
) {
	const ontology = {
		getProperties: async () => null,
		getModelByTipo: async (tipo: string) =>
			tipo === LOCATOR.sectionTipo ? 'section' : 'component_input_text',
		getTranslatable: async () => false,
		getSectionMapRag: async () => ({
			embed: [{ id: GROUP, ddo_map: [{ tipo: 'test99', section_tipo: 'self', mode: 'list' }] }],
		}),
	};
	return new RagIndexer({
		config: new RagConfig(ontology as never),
		provider: provider as never,
		ontology: ontology as never,
		store,
		langs: [],
		nolan: 'lg-nolan',
		resolveDocs: async () => [
			{
				group: GROUP,
				lang: 'lg-nolan',
				text: 'A short record about a Roman silver denarius coin.',
				contributors: [{ componentTipo: 'test99', sectionTipos: [LOCATOR.sectionTipo] }],
			},
		],
		recordTitle: async () => 'Test Record',
	});
}

describe('SITE indexer.ts#embed — the record text indexer', () => {
	test('an empty answer writes NOTHING and stays retryable', async () => {
		const { store, calls } = fakeStore();
		const indexer = textIndexer(scriptedTextProvider([]), store);
		// false = "retry me": the queue keeps the marker, so the record converges
		// when the sidecar comes back. A `true` here would silently drop the
		// record out of the index for good.
		expect(await indexer.indexRecordText(LOCATOR)).toBe(false);
		expect(calls.upserts).toEqual([]);
	});

	test('a right-length batch with a HOLE writes NOTHING (the not-null constraint)', async () => {
		const { store, calls } = fakeStore();
		// One chunk, one vector — but zero-width. A hole reaching the store is not
		// a bad vector, it is a NULL one: it violates the embedding not-null
		// constraint and takes the whole record's flush down.
		const indexer = textIndexer(scriptedTextProvider([[]]), store);
		expect(await indexer.indexRecordText(LOCATOR)).toBe(false);
		expect(calls.upserts).toEqual([]);
	});

	test('NEGATIVE CONTROL: a healthy provider indexes normally', async () => {
		const { store, calls } = fakeStore();
		const indexer = textIndexer(new DeterministicHashProvider(8), store);
		expect(await indexer.indexRecordText(LOCATOR)).toBe(true);
		expect(calls.upserts.length).toBeGreaterThan(0);
		const rows = calls.upserts[0] as EmbeddingRow[];
		expect((rows[0] as EmbeddingRow).embedding.length).toBe(8);
	});
});

function imageIndexer(vectors: number[][], store: RagStore) {
	const image: RagImageDeps = {
		provider: {
			embedImage: async () => vectors,
			embedTextForImageSearch: async () => [],
			dimension: () => 3,
			model: () => 'stub-multimodal',
			provider: () => 'local',
			isExternal: () => false,
		},
		extract: async ({ componentTipo }) => ({
			base64: `b64:${componentTipo}`,
			quality: '1.5MB',
			thumbPath: '/image/thumb/0/x.jpg',
			thumbUrl: '/dedalo/media/image/thumb/0/x.jpg',
			width: 800,
			height: 600,
			bytesHash: `hash:${componentTipo}`,
		}),
		contextSummary: async () => 'typology: Amphora',
		maxPx: 512,
		allowExternal: false,
	};
	return new RagIndexer({
		config: {
			getEmbedGroups: async () => [],
			getContextImages: async () => [{ tipo: 'test88', view: 'obverse' }],
			getContextMetadata: async () => ({}),
		} as never,
		provider: scriptedTextProvider([]) as never,
		ontology: {} as never,
		store,
		langs: ['lg-spa'],
		nolan: 'lg-nolan',
		resolveDocs: async () => [],
		recordTitle: async () => '',
		image,
	});
}

describe('SITE indexer.ts#embedImage — the record image indexer', () => {
	test('an empty answer writes NOTHING and prunes NOTHING (retryable)', async () => {
		const { store, calls } = fakeStore();
		expect(await imageIndexer([], store).indexRecordImages(LOCATOR)).toBe(false);
		expect(calls.upserts).toEqual([]);
		// Not pruning matters as much as not writing: an encoder outage must not
		// delete the index an institution already has.
		expect(calls.stale).toBe(0);
	});

	test('a zero-width vector is a hole, not a vector', async () => {
		const { store, calls } = fakeStore();
		expect(await imageIndexer([[]], store).indexRecordImages(LOCATOR)).toBe(false);
		expect(calls.upserts).toEqual([]);
	});

	test('NEGATIVE CONTROL: a healthy encoder indexes the image', async () => {
		const { store, calls } = fakeStore();
		expect(await imageIndexer([[0.1, 0.2, 0.3]], store).indexRecordImages(LOCATOR)).toBe(true);
		expect(calls.upserts.length).toBe(1);
	});
});

/* ───────────── object retrieval: the PENDING site, pinned behaviourally ──── */

function stubMultimodal(vectors: number[][]): MultimodalEmbeddingProvider {
	return {
		embedImage: async () => [],
		embedTextForImageSearch: async () => vectors,
		dimension: () => 3,
		model: () => 'stub-multimodal',
		provider: () => 'local',
		isExternal: () => false,
	};
}

/**
 * A scope whose candidate count the STORE cannot accept. It is how both tests
 * below tell "the guard returned early" from "the query was issued": the value
 * is inert until it is bound into `LIMIT`, deep inside queryDense, so only a
 * call that got past the presence check can be broken by it. Measured here as
 * the store's `bigint out of range`; on a runner with no Postgres it is the
 * pool's connection error instead, which proves the same passage.
 *
 * The discriminator has to come from the CALL, because it may not come from the
 * store: this pool is the suite's shared vector database, and a control that
 * asserted rows would be asserting another gate's fixture.
 */
const POISONED_LIMIT = { candidates: Number.NaN };

describe('SITE object_retrieval.ts#embedTextForImageSearch — text→image', () => {
	test('an empty answer never reaches the store (it degrades to no results)', async () => {
		const outcome = await outcomeOf(
			new ObjectRetrieval(stubMultimodal([])).searchByTextImage(
				SUPERUSER,
				'a coin',
				POISONED_LIMIT,
			),
		);
		// PINNED, not endorsed. This site fails closed in the sense that matters
		// most — no vector is bound into SQL — but it answers with an EMPTY RESULT
		// SET rather than a refusal, so a sidecar outage reads to a curator as
		// "nothing matched". That is the census PENDING row below; when it is
		// fixed to refuse, this expectation must be updated in the same change,
		// which is exactly the visibility a pinned behaviour buys.
		expect(outcome.ok).toBe(true);
		expect(outcome.ok && outcome.value).toEqual([]);
	});

	test('NEGATIVE CONTROL: a healthy vector is passed on to the store', async () => {
		const outcome = await outcomeOf(
			new ObjectRetrieval(stubMultimodal([[0.1, 0.2, 0.3]])).searchByTextImage(
				SUPERUSER,
				'a coin',
				POISONED_LIMIT,
			),
		);
		// The reason both tests carry POISONED_LIMIT: the empty answer above is
		// returned BEFORE queryDense, so the poisoned limit is never seen; a
		// well-formed vector reaches the store, and the store is the only thing that
		// can reject it. The failure IS the proof of passage — and it must not be
		// OUR refusal, which would mean the guard fired on a healthy vector.
		expect(outcome.ok, 'a well-formed vector must reach the store leg').toBe(false);
		expect(outcome.ok ? null : outcome.error).not.toBeInstanceOf(DedaloError);
	}, 20000);
});

/* ─────────────── identify_by_image: the same contract, at the API ───────── */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const IMAGE_BASE64 = Buffer.from(
	new Uint8Array([...PNG_SIGNATURE, ...Buffer.from('roman bronze coin obverse', 'utf8')]),
).toString('base64');

/** One stored image vector, as the store would hand it back. */
const IMAGE_HIT: Candidate = {
	sectionTipo: 'test3',
	sectionId: 1,
	componentTipo: 'test99',
	lang: 'lg-nolan',
	chunkIndex: 0,
	sourceText: 'typology: Amphora',
	sourceKind: 'image_visual',
	modality: 'image',
	egressClass: 'public',
	parentKey: 'test3_1',
	chunkMeta: { view: 'obverse', thumb_path: '/media/thumb/x.jpg', media_tipo: 'test99' },
	distance: 0.1,
};

function identifyConfig(): MultimodalRuntimeConfig {
	return {
		mediaEnabled: true,
		provider: 'local',
		model: 'stub-multimodal',
		endpoint: '',
		apiKey: undefined,
		imageMaxPx: 512,
		imageHybrid: true,
		nearDuplicateSimilarity: 0.93,
		characterizeTopK: 20,
		imageEgressPolicy: 'local_only',
	};
}

function identifyDeps(vectors: number[][], onQuery: () => void): IdentifyByImageDeps {
	return {
		requireToolGrant: async () => {
			throw new Error('a LOCAL encoder spends nothing: the vision grant must never be asked');
		},
		chargeVision: async () => {
			throw new Error('a LOCAL encoder spends nothing: no vision call may be charged');
		},
		ragEnabled: () => true,
		mediaEnabled: () => true,
		config: identifyConfig,
		buildProvider: () => ({
			...stubMultimodal([]),
			embedImage: async () => vectors,
		}),
		queryImagePartition: async (): Promise<Candidate[]> => {
			onQuery();
			// ONE hit, so the healthy control ends in an ANSWER. An empty list is
			// not the control it looks like: the handler declines it as
			// `identify.empty_index` ("nothing has ever been indexed"), and a
			// control that also ends in a decline cannot tell a passing guard from
			// a firing one.
			return [IMAGE_HIT];
		},
		filterAccessible: async (_principal, candidates) => candidates,
		componentGrant: async () => 1,
		scopeRecords: async (records) => records,
		labelComponent: async () => 'test52',
		readValues: async () => null,
		loadProfile: async () => null,
	};
}

const rqo = (options: Record<string, unknown>): Rqo => ({ options }) as unknown as Rqo;
const apiContext = {
	requestId: 'test',
	clientIp: '127.0.0.1',
	session: null,
	csrfCandidate: null,
	principal: SUPERUSER,
} as unknown as ApiRequestContext;

describe('SITE dd_identify_api.ts#embedImage — identify_by_image', () => {
	test('an encoder that returns nothing DECLINES (never an unfiltered search)', async () => {
		let queried = false;
		const outcome = await outcomeOf(
			buildIdentifyByImage(
				identifyDeps([], () => {
					queried = true;
				}),
			)(rqo({ image: IMAGE_BASE64 }), apiContext),
		);
		expect(outcome.ok).toBe(false);
		expect(outcome.ok ? '' : (outcome.error as InstanceType<typeof DedaloError>).code).toBe(
			'identify.embed_failed',
		);
		// "What is this?" answered from an absent vector would be an ANN over
		// nothing dressed as an identification. The store is never asked.
		expect(queried).toBe(false);
	});

	test('a zero-width vector is refused as well (a hole is not an embedding)', async () => {
		let queried = false;
		const outcome = await outcomeOf(
			buildIdentifyByImage(
				identifyDeps([[]], () => {
					queried = true;
				}),
			)(rqo({ image: IMAGE_BASE64 }), apiContext),
		);
		expect(outcome.ok).toBe(false);
		expect(queried).toBe(false);
	});

	test('NEGATIVE CONTROL: a healthy encoder searches normally', async () => {
		let queried = false;
		const outcome = await outcomeOf(
			buildIdentifyByImage(
				identifyDeps([[0.1, 0.2, 0.3]], () => {
					queried = true;
				}),
			)(rqo({ image: IMAGE_BASE64 }), apiContext),
		);
		expect(queried).toBe(true);
		expect(outcome.ok).toBe(true);
	});
});

/* ══════════════════ LEG 2 — the census, DERIVED not enumerated ════════════ */

/**
 * The embedding methods of the two provider contracts. A call to one of these
 * is the only definition of "call site" that cannot be gamed by renaming a
 * variable, a class or a wrapper function.
 *
 * Longest alternative first: `embed` would otherwise match the prefix of
 * `embedImage` and the regex would have to backtrack to find the real method.
 */
const EMBED_CALL = /\.(embedTextForImageSearch|embedImage|embed)\s*\(/g;

type Verdict = 'refuses' | 'retries' | 'PENDING';

interface CensusRow {
	verdict: Verdict;
	/** How many calls of this method the file may contain. Pinned: a SECOND,
	 * unguarded call in an already-guarded file is the way this gate would
	 * otherwise be walked past. */
	occurrences: number;
	/** Source substrings that MUST be present — the guard itself. */
	present: string[];
	/** Source substrings that must be ABSENT — the defect shape that was removed
	 * (for a guarded row), or the fix (for a PENDING one, so landing it FAILS
	 * this gate and forces the row to move). */
	absent: string[];
	reason: string;
}

const CENSUS: Record<string, CensusRow> = {
	'src/ai/rag/retrieval.ts#embed': {
		verdict: 'refuses',
		occurrences: 1,
		present: ['assertQueryVector(', "throw new DedaloError('rag.embedding_unavailable'"],
		// The exact pre-fix line (AIX-01). Its return would restore the SQL-NULL
		// bind, and the census would go on saying the site is guarded.
		absent: ['const [queryEmbedding] = await provider.embed('],
		reason:
			'THE load-bearing site: the query vector. assertQueryVector refuses with a typed rag.embedding_unavailable when the batch is not exactly one vector or that vector is zero-width / not all finite — the indexer’s two-check model, applied BEFORE denseSearch, so nothing is ever fused from a NULL-bound query.',
	},
	'src/ai/rag/indexer.ts#embed': {
		verdict: 'retries',
		occurrences: 1,
		present: ['vectors.length !== toEmbedIdx.length', 'embedFailure = true'],
		absent: [],
		reason:
			'THE REFERENCE IMPLEMENTATION, and it was already correct: count check, then full-width check (a partially-failed provider returns a right-length batch with a hole, and a hole is a NULL that violates the embedding not-null constraint). It sets embedFailure and returns false so the QUEUE retries the record — the right refusal for a background pass, where throwing would only be caught and logged.',
	},
	'src/ai/rag/indexer.ts#embedImage': {
		verdict: 'retries',
		occurrences: 1,
		present: ['vectors.length !== 1 || vector === undefined || vector.length === 0'],
		absent: [],
		reason:
			'the image half of the same pass: presence AND width, writing nothing and PRUNING nothing (an encoder outage must not delete an existing index), record left retryable.',
	},
	'src/core/api/handlers/dd_identify_api.ts#embedImage': {
		verdict: 'refuses',
		occurrences: 1,
		present: ['vector === undefined || vector.length === 0', "'identify.embed_failed'"],
		absent: [],
		reason:
			'"what is this?" for material with no record yet. An absent vector declines with a typed identify.embed_failed at HTTP 200 rather than running an ANN over nothing and dressing the result as an identification.',
	},
	'src/ai/rag/object_retrieval.ts#embedTextForImageSearch': {
		verdict: 'PENDING',
		occurrences: 1,
		present: ['if (!queryVector) return [];'],
		// The width half of the check. Its arrival is the fix, and it must not
		// arrive silently: this row (and the behavioural pin above) then change.
		absent: ['queryVector.length === 0'],
		reason:
			'text→image search checks PRESENCE only. Two residuals, neither the NULL-bind: (a) `[]` is truthy, so a zero-width row passes and reaches pgvector as `\'[]\'::vector`, an opaque dimension error deep in the query; (b) an absent vector returns an EMPTY RESULT SET, which reads to a curator as "nothing matched" rather than "the encoder is down". The correct shape is retrieval.ts’s assertQueryVector — a typed refusal. Behaviour pinned above so the fix cannot land unnoticed.',
	},
};

/** PINNED. Shrink-only: this may go DOWN when a site starts refusing, never up. */
const PENDING_COUNT = 1;

function walk(dir: string, acc: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) walk(path, acc);
		else if (path.endsWith('.ts') && !path.endsWith('.d.ts')) acc.push(path);
	}
	return acc;
}

/** A comment or docblock line: it mentions a call, it does not make one. */
function isProse(line: string): boolean {
	const trimmed = line.trimStart();
	return trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*');
}

/** Every embedding CALL under scan, as `<relative path>#<method>` → count. */
function deriveCallSites(): Map<string, number> {
	const files = [
		...walk(join(ROOT, 'src')),
		...walk(join(ROOT, 'tools')).filter((path) => path.includes('/server/')),
	];
	const sites = new Map<string, number>();
	for (const file of files) {
		const relativePath = relative(ROOT, file);
		for (const line of readFileSync(file, 'utf8').split('\n')) {
			if (isProse(line)) continue;
			for (const match of line.matchAll(EMBED_CALL)) {
				// A receiver is required by the regex's leading dot, so the interface
				// declarations and the `async embed(texts…)` implementations — which
				// are not calls — never enter the census.
				const key = `${relativePath}#${match[1]}`;
				sites.set(key, (sites.get(key) ?? 0) + 1);
			}
		}
	}
	return sites;
}

const derived = deriveCallSites();

describe('the embedding call-site census is TOTAL', () => {
	test('the derivation actually found the known sites (the scan is not empty)', () => {
		// Without this every assertion below is vacuous: a broken walk() or a
		// regex that matches nothing would make an empty census look total.
		expect(derived.size).toBeGreaterThanOrEqual(5);
		for (const key of Object.keys(CENSUS)) {
			expect([...derived.keys()], `the scan lost a known call site: ${key}`).toContain(key);
		}
	});

	test('every derived call site has a census row', () => {
		const missing = [...derived.keys()].filter((key) => CENSUS[key] === undefined);
		expect(
			missing,
			`New embedding call site(s) with no census row:\n  ${missing.join('\n  ')}\nembed()/embedImage()/embedTextForImageSearch() return [] on EVERY ordinary provider failure. Guard the site (retrieval.ts assertQueryVector is the model), then add a row with a verdict, the guard substring, and a written reason.`,
		).toEqual([]);
	});

	test('no census row names a call site that no longer exists (stale rows)', () => {
		const stale = Object.keys(CENSUS).filter((key) => !derived.has(key));
		expect(
			stale,
			`Census row(s) for call sites that are gone:\n  ${stale.join('\n  ')}\nDelete the row — a census that names what is not there stops being a census.`,
		).toEqual([]);
	});

	test('no file grew a SECOND, uncounted call of the same method', () => {
		const grown: string[] = [];
		for (const [key, count] of derived) {
			const row = CENSUS[key];
			if (row !== undefined && count !== row.occurrences) {
				grown.push(`${key}: ${count} calls, census pins ${row.occurrences}`);
			}
		}
		expect(
			grown,
			`Call count changed:\n  ${grown.join('\n  ')}\nA second call in an already-guarded file is invisible to a per-file census. Guard it, then raise the pin deliberately.`,
		).toEqual([]);
	});

	test('the guard every row claims is PRESENT in its file', () => {
		const unguarded: string[] = [];
		for (const [key, row] of Object.entries(CENSUS)) {
			const source = readFileSync(join(ROOT, key.split('#')[0] as string), 'utf8');
			for (const needle of row.present) {
				if (!source.includes(needle)) unguarded.push(`${key}: missing guard \`${needle}\``);
			}
		}
		expect(
			unguarded,
			`The guard a census row claims is gone:\n  ${unguarded.join('\n  ')}\nEither the guard was removed (fix it) or it was rewritten (update the row in the SAME change — a census may not describe code that no longer exists).`,
		).toEqual([]);
	});

	test('the removed defect shape has not come back (and no PENDING fix landed silently)', () => {
		const returned: string[] = [];
		for (const [key, row] of Object.entries(CENSUS)) {
			const source = readFileSync(join(ROOT, key.split('#')[0] as string), 'utf8');
			for (const needle of row.absent) {
				if (source.includes(needle)) returned.push(`${key}: \`${needle}\``);
			}
		}
		expect(
			returned,
			`Forbidden shape present:\n  ${returned.join('\n  ')}\nFor a guarded row this is the pre-fix code returning. For a PENDING row it is the FIX landing — good news that must move the row out of PENDING and update the behavioural pin above.`,
		).toEqual([]);
	});

	test('the PENDING set is pinned and shrink-only', () => {
		const pending = Object.entries(CENSUS).filter(([, row]) => row.verdict === 'PENDING');
		expect(
			pending.length,
			`PENDING is ${pending.length}, pinned at ${PENDING_COUNT}. It may only go DOWN — when it does, lower the pin in the same change. It may NEVER go up: a new call site is guarded before it lands, not ledgered.`,
		).toBe(PENDING_COUNT);
	});

	test('every row carries a real reason (a census of blanks proves nothing)', () => {
		for (const [key, row] of Object.entries(CENSUS)) {
			expect(row.reason.length, `${key} has no written reason`).toBeGreaterThan(80);
			expect(row.present.length + row.absent.length, `${key} checks nothing`).toBeGreaterThan(0);
		}
	});
});
