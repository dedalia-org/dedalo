/**
 * Phase 8 gate: the TS RAG seam — index → hybrid retrieve → ACL.
 *
 * Runs fully OFFLINE on the deterministic hash embedder (no API keys, no
 * sidecar): two real records are BUILT in the disposable test section, indexed
 * through the PRODUCTION indexer, then retrieved with the hybrid (dense +
 * lexical, RRF) search. The ACL gate is the DoD assertion: a user the human API
 * denies gets NOTHING from the same query. Everything created is removed after.
 *
 * TWO DEFECTS THIS FILE CARRIED UNTIL 2026-08-30 (audit 2026-08-26, P1-14).
 *
 * 1. IT INDEXED THROUGH A DOOR PRODUCTION DOES NOT HAVE. `indexComponentText`
 *    lived in retrieval.ts with NO production caller — its only importers were
 *    this file and its two siblings — and it carried its own unchecked
 *    `embed()` cast. A gate that drives a test-only door proves nothing about
 *    the path a curator's save actually takes, and it kept that door (and its
 *    bug) alive in production source. The door is deleted; every index below
 *    now goes through `RagIndexer` — the same class `buildRagIndexer()` wires
 *    for the drain and the save queue — over the REAL `resolveEmbedDocs`
 *    resolution seam, so descriptor → ddo_map → chunk → embed → upsert →
 *    stale-prune is exercised end to end.
 *
 * 2. IT CLAIMED "OFFLINE" AND READ THE MACHINE. The docblock said deterministic
 *    embedder; the code called `getEmbeddingProvider()`, which resolves the
 *    provider from config. This developer's `../private/.env` sets
 *    `DEDALO_RAG_EMBEDDING_PROVIDER=sidecar`, so on a machine whose sidecar is
 *    not running every `embed()` returned `[]` (its documented fail-closed
 *    answer) and the gate wrote NULL embeddings until Postgres refused with an
 *    opaque not-null violation. That is the "tests BUILD the situation they
 *    test" rule broken: the provider is now PINNED, both halves (see below).
 *
 * THE SITUATION IS BUILT, NEVER FOUND: the records are reserved-high scratch
 * twins written through the real save path (`saveComponentData`), and the
 * `rag.embed` descriptor that opts the section in is declared HERE, in the
 * injected ontology port. Nothing is read from whatever the ambient DB holds.
 */
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
import { defaultOntologyPort, type OntologyPort, RagConfig } from '../../src/ai/rag/config.ts';
import { resolveEmbedDocs } from '../../src/ai/rag/embed_source.ts';
import {
	DeterministicHashProvider,
	getEmbeddingProvider,
} from '../../src/ai/rag/embedding_provider.ts';
import { defaultRagStore, RagIndexer } from '../../src/ai/rag/indexer.ts';
import { semanticSearch } from '../../src/ai/rag/retrieval.ts';
import { deleteRecordChunks, ragSql } from '../../src/ai/rag/vector_store.ts';
import { saveComponentData } from '../../src/core/section/record/save_component.ts';
import type { Principal } from '../../src/core/security/permissions.ts';
import { cleanScratchRecord, createScratchRecord } from '../helpers/test_data.ts';

/**
 * THE PROVIDER PIN, HALF ONE — the SEARCH half, which has no injection seam.
 *
 * `hybridCandidates` (retrieval.ts) calls `getEmbeddingProvider()` itself, so
 * the only way to pin the query embedder is the key it reads. Any value other
 * than `sidecar` selects `DeterministicHashProvider`. Set at MODULE level, not
 * in `beforeAll`, because the provider is resolved per call and the pin must
 * already stand for anything this file's imports set in motion.
 *
 * The prior value is captured and RESTORED (not deleted) in `afterAll`: `bun
 * test` runs the files of one tier in a single process, and deleting the key
 * would hand the next file the machine's `../private/.env` sidecar instead of
 * whatever it had. Both halves must agree, because `provider.model` is the
 * vector store's PARTITION KEY — indexing under `det-hash-v1` and querying
 * under `bge-m3` is not a wrong answer, it is silently zero rows.
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

// Reserved-high scratch twins (test/helpers/test_data.ts conventions): fixed ids
// clear of genuine records and of the sibling gates' bands, so the run is
// reproducible and the shared matrix counter never moves.
const COIN_ID = 906401;
const SHIP_ID = 906402;
const createdIds: number[] = [COIN_ID, SHIP_ID];

const COIN_TEXT =
	'Moneda ibérica de bronce acuñada en la ceca de Abariltur, con jinete y leyenda ibérica.';
const SHIP_TEXT =
	'Naufragio de un barco fenicio con ánforas de aceite frente a la costa de Cartagena.';

/**
 * The real ontology port with ONE override: the section_map `rag.embed`
 * descriptor that opts `test2` in. Everything else delegates to the live
 * resolver, so `resolveEmbedDocs` resolves the ddo_map through the SAME
 * request_config machinery the human read uses — the seam whose absence made
 * the deleted test-only door meaningless as coverage.
 *
 * The descriptor is declared here rather than written into `dd_ontology`
 * because a test never mutates the shared ontology (AGENTS.md): the situation
 * is built in the injected port, the DATA is built in the matrix.
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
 * THE PROVIDER PIN, HALF TWO — the INDEX half, which does have a seam, so it
 * gets the provider by INJECTION rather than by environment.
 *
 * This is the PRODUCTION `RagIndexer` class wired by hand. What it SHARES with
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
 *  • `provider` — the injected `DeterministicHashProvider` of this docblock.
 *  • `langs` — `[DOC_LANG]` rather than `config.menu.projectsDefaultLangs`:
 *    the fixture writes exactly one language, and inheriting the machine's
 *    list is the ambient-situation reading this suite forbids.
 *  • `nolan` — the literal `lg-nolan` rather than `readString('DEDALO_DATA_NOLAN')`,
 *    for that same reason.
 *  • `recordTitle` — deliberately EMPTY rather than `getTermByTipo`: the
 *    chunker prepends it to every chunk's embed text, so a shared title
 *    injects the same tokens into every record's vector — and the
 *    deterministic embedder is a bag of words, so that is exactly the noise
 *    that would blunt the vocabulary discrimination this gate measures.
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
	// indexRecord answers FALSE on a retryable failure — the shape this check is
	// for: an unchecked call would leave the gate asserting against an empty store
	// and blaming retrieval for it. Fail here, where the cause is still visible.
	//
	// It is not a total guarantee, and the comment used to claim it was: `embed()`
	// at indexer.ts:369 sits outside every try/catch in `indexRecordText`, so a
	// provider that THROWS (rather than answering short, which is the documented
	// fail-closed contract) propagates straight out. The pinned
	// DeterministicHashProvider never throws, so this gate cannot meet that path —
	// which is precisely why the claim must not be written as if it had.
	if (!indexed) throw new Error(`fixture index failed for ${SECTION_TIPO}/${sectionId}`);
}

beforeAll(async () => {
	const indexer = offlineIndexer();
	// Two records with clearly different vocabularies.
	await buildAndIndex(indexer, COIN_ID, COIN_TEXT);
	await buildAndIndex(indexer, SHIP_ID, SHIP_TEXT);
});

afterAll(async () => {
	for (const id of createdIds) {
		await deleteRecordChunks(SECTION_TIPO, id);
		await cleanScratchRecord(SECTION_TIPO, id);
	}
	if (PRIOR_EMBEDDING_PROVIDER === undefined) {
		delete process.env.DEDALO_RAG_EMBEDDING_PROVIDER;
	} else {
		process.env.DEDALO_RAG_EMBEDDING_PROVIDER = PRIOR_EMBEDDING_PROVIDER;
	}
	// Do NOT close the shared module-level ragSql pool here: other rag test files
	// in the same Bun process use it. Like the matrix `sql` pool, it is left to
	// process teardown. (Closing it mid-suite broke concurrently-running files.)
});

describe('RAG pipeline (Phase 8 gate — offline deterministic provider)', () => {
	// The pin is an invariant of this file, not a hope: if the machine's config
	// ever wins again, everything below is embedding against a sidecar and the
	// reds would be blamed on retrieval.
	test('the provider is PINNED deterministic, whatever this machine configures', () => {
		expect(getEmbeddingProvider().model).toBe('det-hash-v1');
	});

	test('hybrid retrieval ranks the vocabulary-matching record first', async () => {
		const coinHits = await semanticSearch(SUPERUSER, 'moneda de bronce con jinete ceca', 5);
		expect(coinHits.length).toBeGreaterThan(0);
		expect(coinHits[0]?.section_id).toBe(COIN_ID);
		expect(coinHits[0]?.snippet).toContain('Abariltur');

		const shipHits = await semanticSearch(SUPERUSER, 'barco fenicio ánforas naufragio', 5);
		expect(shipHits.length).toBeGreaterThan(0);
		expect(shipHits[0]?.section_id).toBe(SHIP_ID);
	});

	test('a user the human API denies gets NOTHING from the same query (DoD)', async () => {
		const denied = await semanticSearch(NO_ACCESS, 'moneda de bronce con jinete ceca', 5);
		expect(denied).toEqual([]);
	});

	test('re-indexing an unchanged record replaces its chunks (no duplicates)', async () => {
		const indexer = offlineIndexer();
		const ok = await indexer.indexRecord({ sectionTipo: SECTION_TIPO, sectionId: COIN_ID });
		expect(ok).toBe(true);
		const rows = (await ragSql.unsafe(
			'SELECT count(*)::int AS c FROM rag_embeddings WHERE section_tipo = $1 AND section_id = $2',
			[SECTION_TIPO, COIN_ID],
		)) as { c: number }[];
		// one short text → one chunk, replaced not appended. Through the real
		// indexer this now also proves the hash-diff: the second pass finds the
		// stored source_hash unchanged, embeds nothing, and still converges to 1.
		expect(rows[0]?.c).toBe(1);
	});
});

// ────────────────── embed-group pipeline (2026-07-22 descriptor) ──────────────────
//
// The FULL group path over REAL data: the canonical test3 playground record 1
// (matrix_test — test17 text_area + test52 input_text carry lorem-ipsum text) is
// indexed through the descriptor → resolveEmbedDocs (the REAL emitDdoData
// request_config resolution — the seam the virtual-section fix rides on) → the
// live store, then retrieved group-filtered and ACL-gated. This pins the bug the
// redesign fixed: the boolean-era selection indexed ZERO text for descriptor-
// driven sections. (Virtual-tipo keying itself is covered by getSectionMap's
// fallback + the live rsc205 e2e — no scratch dd_ontology writes from tests.)
//
// The index provider is the SAME pinned deterministic one the search half
// resolves (see the pin above), so both live in one model partition.

const T3_SECTION = 'test3';
const T3_RECORD = 1;
const T3_GROUPS_RAW = {
	embed: [
		{
			id: 'card',
			ddo_map: [
				{ tipo: 'test52', section_tipo: 'self', mode: 'list' },
				{ tipo: 'test17', section_tipo: 'self', mode: 'list' },
			],
		},
	],
};

function t3Ontology(): OntologyPort {
	return {
		getProperties: async () => null,
		getModelByTipo: async () => null, // unused by the group path
		getTranslatable: async () => false, // unused (entryUsesLangs is embed_source's)
		getSectionMapRag: async (tipo: string) => (tipo === T3_SECTION ? T3_GROUPS_RAW : null),
	};
}

describe('RAG embed-group pipeline (descriptor → real ddo_map resolution → group retrieval)', () => {
	const ontology = t3Ontology();
	const indexer = new RagIndexer({
		ontology,
		config: new RagConfig(ontology),
		store: defaultRagStore(),
		provider: new DeterministicHashProvider(),
		langs: ['lg-eng'],
		nolan: 'lg-nolan',
		resolveDocs: resolveEmbedDocs,
		recordTitle: async () => 'Test record',
	});

	afterAll(async () => {
		await deleteRecordChunks(T3_SECTION, T3_RECORD);
	});

	test('a descriptor-driven record indexes NON-ZERO group chunks (the boolean era indexed zero)', async () => {
		const ok = await indexer.indexRecord({ sectionTipo: T3_SECTION, sectionId: T3_RECORD });
		expect(ok).toBe(true);
		const rows = (await ragSql.unsafe(
			`SELECT component_tipo, count(*)::int AS c FROM rag_embeddings
			 WHERE section_tipo = $1 AND section_id = $2 GROUP BY 1`,
			[T3_SECTION, T3_RECORD],
		)) as { component_tipo: string; c: number }[];
		const card = rows.find((r) => r.component_tipo === 'rag:card');
		expect(card).toBeDefined();
		expect(card!.c).toBeGreaterThan(0);
	});

	test('group-filtered retrieval finds the record; a non-existent group finds nothing', async () => {
		const hits = await semanticSearch(
			SUPERUSER,
			'Lorem ipsum dolor sit amet',
			5,
			[T3_SECTION],
			'card',
		);
		expect(hits.length).toBeGreaterThan(0);
		expect(hits[0]?.section_id).toBe(T3_RECORD);
		expect(hits[0]?.component_tipo).toBe('rag:card');

		const none = await semanticSearch(
			SUPERUSER,
			'Lorem ipsum dolor sit amet',
			5,
			[T3_SECTION],
			'nope',
		);
		expect(none).toEqual([]);
	});

	test('DoD holds for group chunks: a denied user gets NOTHING (record-level gate)', async () => {
		const denied = await semanticSearch(
			NO_ACCESS,
			'Lorem ipsum dolor sit amet',
			5,
			[T3_SECTION],
			'card',
		);
		expect(denied).toEqual([]);
	});
});
