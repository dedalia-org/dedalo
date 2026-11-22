// Migrated to the generic `test` TLD 2026-08-20 (AGENTS.md hard rule). The tipos
// here are OPAQUE IDENTIFIERS — this gate builds and inspects a descriptor, it never
// reads a record — so the migration is a rename.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, unlinkSync } from 'node:fs';
import { ragApiActions } from '../../src/ai/rag/api.ts';
import {
	aggregateCategorical,
	RagCharacterizer,
	summarizeDates,
} from '../../src/ai/rag/characterizer.ts';
import { cosineDistance } from '../../src/ai/rag/chunker.ts';
import {
	buildImageContextSummary,
	type ExtractedImage,
	extractImageForEmbedding,
} from '../../src/ai/rag/image_source.ts';
import { defaultRagStore, RagIndexer } from '../../src/ai/rag/indexer.ts';
import {
	DeterministicMultimodalProvider,
	extractVectors,
	type MultimodalEmbeddingProvider,
} from '../../src/ai/rag/multimodal_embedding_provider.ts';
import { ObjectRetrieval } from '../../src/ai/rag/object_retrieval.ts';
import type { Candidate, RecordLocator } from '../../src/ai/rag/types.ts';
import { deleteRecordChunks, getRecordVectors, ragSql } from '../../src/ai/rag/vector_store.ts';
import { config } from '../../src/config/config.ts';
import { mediaTypeOf } from '../../src/core/concepts/media.ts';
import { updateMatrixRecord } from '../../src/core/db/matrix_write.ts';
import { resolveMagick } from '../../src/core/media/engine/imagemagick.ts';
import { runBinary } from '../../src/core/media/engine/spawn.ts';
import { stagingDir } from '../../src/core/media/ingest/add_file.ts';
import { processUploadedFile } from '../../src/core/media/ingest/process_uploaded_file.ts';
import { resolveMediaPathOptions } from '../../src/core/media/ontology_path.ts';
import {
	buildMediaLocation,
	type MediaIdentity,
	type MediaPathOptions,
} from '../../src/core/media/path.ts';
import { getMatrixTableFromTipo } from '../../src/core/ontology/resolver.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import type { Principal } from '../../src/core/security/permissions.ts';
import {
	type AiSpendLimitSnapshot,
	AMPLE_AI_SPEND_LIMITS,
	restoreAiSpendLimits,
	setAiSpendLimits,
	sweepAiSpendLedger,
} from '../helpers/ai_spend_ledger.ts';
import { magickTestEnv } from '../helpers/magick_test_env.ts';
import { cleanScratchRecord } from '../helpers/test_data.ts';

/**
 * Multimodal RAG (Brick 5): the deterministic joint provider, the pure
 * characterizer aggregators, and the object-retrieval + dd_rag_api image actions
 * against the live pgvector DB.
 *
 * THE IMAGE VECTORS ARE NOT HAND-SEEDED. Each scratch record is given a REAL
 * image through the REAL pipeline:
 *
 *   ImageMagick-generated upload → staging dir → processUploadedFile
 *   (add_file → regenerateImage derivatives → files_info)
 *   → RagIndexer.indexRecordImages
 *       → extractImageForEmbedding  (reads the real non-master derivative,
 *                                    downscales it, hashes the encoder bytes)
 *       → buildImageContextSummary  (reads the record's real metadata role)
 *       → upsertEmbeddingRows       (the LIVE pgvector store)
 *
 * The ONE stand-in is the encoder itself: DeterministicMultimodalProvider, so
 * the gate is network-free and needs no CLIP sidecar. It is not semantic, so
 * nothing here asserts VISUAL meaning — what is asserted is that the vectors,
 * their source hash, their source_text and their chunk_meta are the real
 * pipeline's output, and that retrieval/ACL/the API read them back correctly.
 *
 * MEDIA ROOT. The extractor resolves its own location from the ontology
 * (resolveMediaPathOptions) and the CONFIGURED media root — there is no seam to
 * redirect it, so an ingest into a scratch root would leave it finding nothing
 * and the gate asserting nothing. The files therefore land in the configured
 * tree (precedent: media_fallback_listener.test.ts), named after the freshly
 * created scratch records, and afterAll unlinks every quality tier it wrote.
 *
 * PRECONDITIONS — each SKIPS LOUDLY, never silently green: a live pgvector RAG
 * database, ImageMagick on PATH, and a configured MEDIA_PATH.
 */

process.env.DEDALO_RAG_ENABLED = 'true';
process.env.DEDALO_RAG_MEDIA_ENABLED = 'true';

const SECTION_TIPO = 'test2';
/** A REAL component_image tipo in the ontology — the extractor needs a media model. */
const IMAGE_TIPO = 'test99';
/** A REAL non-translatable component_input_text — the context summary's metadata role. */
const CAPTION_TIPO = 'test162';
const MODEL = 'deterministic-multimodal'; // buildMultimodalProvider default (no endpoint)
const MAX_PX = 512; // multimodalConfigFromEnv().imageMaxPx default
const SUPERUSER: Principal = { userId: -1, isGlobalAdmin: true, isDeveloper: true };
const NO_ACCESS: Principal = { userId: 999999, isGlobalAdmin: false, isDeveloper: false };
/** Root's limit keys as they were: the image doors are METERED and an unset limit is 0. */
let rootLimits: AiSpendLimitSnapshot | null = null;
const provider = new DeterministicMultimodalProvider({ model: MODEL, dimension: 64 });
const NOLAN = 'lg-nolan';
const DATA_LANG = 'lg-eng';
const USER_ID = 7;
const KEY_DIR = 'ragimggate';
const IMAGE_SPEC = mediaTypeOf('component_image') as NonNullable<ReturnType<typeof mediaTypeOf>>;

/** Overlapping captions ("roman bronze coin") → the hybrid lexical leg has something real to fuse. */
const OBJECTS = [
	{ caption: 'roman bronze coin obverse laureate head emperor', source: 'gradient:navy-gold' },
	{
		caption: 'roman bronze coin reverse eagle standard legionary',
		source: 'gradient:crimson-white',
	},
];

type Ctx = { requestId: string; session: { userId: number } | null; principal?: Principal };
const rqo = (options: Record<string, unknown>) => ({ options }) as never;

// ─────────────────────────── preconditions (loud skips) ───────────────────────────

const HAVE_MAGICK = existsSync(resolveMagick());
const MEDIA_ROOT = config.media.rootPath;
let HAVE_RAG_DB = false;
try {
	await ragSql.unsafe('SELECT 1 FROM rag_embeddings LIMIT 1');
	HAVE_RAG_DB = true;
} catch {
	console.warn('[rag_multimodal] pgvector RAG database unavailable — the image gates are SKIPPED');
}
if (!HAVE_MAGICK) {
	console.warn('[rag_multimodal] ImageMagick not found — the image gates are SKIPPED');
}
if (MEDIA_ROOT === null) {
	console.warn('[rag_multimodal] MEDIA_PATH is not configured — the image gates are SKIPPED');
}
/** Every precondition of the REAL ingest path. Nothing image-related runs without all three. */
const REAL_INGEST = HAVE_RAG_DB && HAVE_MAGICK && MEDIA_ROOT !== null;

// ─────────────────────────── the real ingest fixture ───────────────────────────

const createdIds: number[] = [];
const extractedByRecord = new Map<number, ExtractedImage>();
let matrixTable = 'matrix_test';
let pathOpts: MediaPathOptions = { initialMediaPath: '', maxItemsFolder: null };

const identityFor = (sectionId: number): MediaIdentity => ({
	componentTipo: IMAGE_TIPO,
	sectionTipo: SECTION_TIPO,
	sectionId,
	lang: null,
});

/**
 * The indexer under test: the REAL store, the REAL extractor, the REAL context
 * summary. Only the section descriptor is a fake — test2's ontology declares no
 * `rag.context`, and this gate is about the ingest path, not about parsing that
 * descriptor (rag_config.test.ts owns it). The TEXT half is a no-op ([] groups).
 */
function buildImageIndexer(multimodal: MultimodalEmbeddingProvider = provider): RagIndexer {
	const ragConfig = {
		getEmbedGroups: async () => [],
		getContextImages: async () => [{ tipo: IMAGE_TIPO, view: 'obverse' }],
		getContextMetadata: async () => ({ caption: CAPTION_TIPO }),
	};
	return new RagIndexer({
		config: ragConfig as never,
		provider: { name: 'unused', model: 'unused-text', embed: async () => [] } as never,
		ontology: {} as never,
		store: defaultRagStore(),
		langs: [DATA_LANG],
		nolan: NOLAN,
		resolveDocs: async () => [],
		recordTitle: async () => '',
		image: {
			provider: multimodal,
			extract: extractImageForEmbedding,
			contextSummary: buildImageContextSummary,
			maxPx: MAX_PX,
			// The deterministic provider is 'local', so this is never consulted —
			// stated explicitly so the gate cannot ship bytes off the host if it changes.
			allowExternal: false,
		},
	});
}

/** The context summary the REAL builder produces for a record (the row's source_text). */
const summaryFor = (caption: string) => `caption: ${caption}`;

/** Write the metadata role the context summary reads (scratch record, `string` column). */
async function writeCaption(sectionId: number, caption: string): Promise<void> {
	await updateMatrixRecord(
		matrixTable,
		SECTION_TIPO,
		sectionId,
		{ string: JSON.stringify({ [CAPTION_TIPO]: [{ id: '1', value: caption, lang: NOLAN }] }) },
		{ rawTextPassthrough: true },
	);
}

/** Stage a real jpg and run the REAL ingest for one record (derivatives + files_info). */
async function ingestImage(sectionId: number, source: string): Promise<void> {
	const dir = stagingDir(USER_ID, KEY_DIR, MEDIA_ROOT as string);
	mkdirSync(dir, { recursive: true });
	const tmpName = `rag_${sectionId}.jpg`;
	await runBinary([resolveMagick(), '-size', '1400x1000', source, `${dir}/${tmpName}`], {
		nice: false,
		env: magickTestEnv(),
	});
	const result = await processUploadedFile({
		spec: IMAGE_SPEC,
		identity: identityFor(sectionId),
		pathOpts,
		userId: USER_ID,
		keyDir: KEY_DIR,
		tmpName,
		extension: 'jpg',
	});
	const qualities = new Set(result.filesInfo.map((entry) => entry.quality));
	if (!qualities.has(IMAGE_SPEC.defaultQuality) || !qualities.has(config.media.thumb.quality)) {
		throw new Error(
			`[rag_multimodal] ingest produced no ${IMAGE_SPEC.defaultQuality}/${config.media.thumb.quality} derivative for ${SECTION_TIPO}/${sectionId} — the extractor would have nothing real to read`,
		);
	}
}

/** Unlink every tier this gate wrote for one record (all qualities × all extensions). */
function removeMediaFiles(sectionId: number): void {
	if (MEDIA_ROOT === null) return;
	const identity = identityFor(sectionId);
	const qualities = new Set([...IMAGE_SPEC.qualities, config.media.thumb.quality]);
	const extensions = new Set([
		IMAGE_SPEC.defaultExtension,
		...IMAGE_SPEC.alternateExtensions,
		config.media.thumb.extension,
	]);
	for (const quality of qualities) {
		for (const extension of extensions) {
			try {
				const location = buildMediaLocation(IMAGE_SPEC, identity, quality, extension, pathOpts);
				if (existsSync(location.absolutePath)) unlinkSync(location.absolutePath);
			} catch {
				// an off-ladder quality/extension combination has no file to remove
			}
		}
	}
}

const indexer = buildImageIndexer();

beforeAll(async () => {
	// Ample limits for root (the budget is ai_spend_budget_native's subject).
	rootLimits = await setAiSpendLimits({ userId: SUPERUSER.userId }, AMPLE_AI_SPEND_LIMITS);
	if (!REAL_INGEST) return;
	matrixTable = (await getMatrixTableFromTipo(SECTION_TIPO)) ?? 'matrix_test';
	// The SAME options the extractor will resolve for itself — by construction,
	// so the ingest cannot write where the real read path would not look.
	pathOpts = await resolveMediaPathOptions(IMAGE_TIPO, SECTION_TIPO);

	for (const object of OBJECTS) {
		const sectionId = await createSectionRecord(SECTION_TIPO, -1);
		createdIds.push(sectionId);
		await writeCaption(sectionId, object.caption);
		await ingestImage(sectionId, object.source);

		const indexed = await indexer.indexRecordImages({ sectionTipo: SECTION_TIPO, sectionId });
		if (!indexed) {
			throw new Error(
				`[rag_multimodal] the REAL image index pass failed for ${SECTION_TIPO}/${sectionId} — refusing to assert against a half-built index`,
			);
		}
		// Re-extract for the assertions: the stored vector must be reproducible
		// from the derivative on disk (the hash-diff skip depends on it).
		const extracted = await extractImageForEmbedding({
			componentTipo: IMAGE_TIPO,
			sectionTipo: SECTION_TIPO,
			sectionId,
			maxPx: MAX_PX,
		});
		if (extracted === null) {
			throw new Error(
				`[rag_multimodal] extractImageForEmbedding found no derivative for ${SECTION_TIPO}/${sectionId} after a successful ingest`,
			);
		}
		extractedByRecord.set(sectionId, extracted);
	}
});

afterAll(async () => {
	if (rootLimits !== null) await restoreAiSpendLimits([rootLimits]);
	await sweepAiSpendLedger([SUPERUSER.userId]);
	for (const id of createdIds) {
		removeMediaFiles(id);
		await deleteRecordChunks(SECTION_TIPO, id);
		await cleanScratchRecord(SECTION_TIPO, id, matrixTable);
	}
	if (MEDIA_ROOT !== null) {
		rmSync(stagingDir(USER_ID, KEY_DIR, MEDIA_ROOT), { recursive: true, force: true });
	}
	await ragSql
		.unsafe(`DROP TABLE IF EXISTS "rag_embeddings_${MODEL.replace(/[^a-z0-9]+/g, '_')}"`)
		.catch(() => {});
	// assigning undefined coerces to the STRING 'undefined' — only delete truly unsets the key
	delete process.env.DEDALO_RAG_ENABLED;
	// assigning undefined coerces to the STRING 'undefined' — only delete truly unsets the key
	delete process.env.DEDALO_RAG_MEDIA_ENABLED;
});

describe('DeterministicMultimodalProvider (joint space)', () => {
	test('identical input → identical vector; shared tokens → high similarity', () => {
		expect(provider.vectorFor('roman bronze coin', 'img')).toEqual(
			provider.vectorFor('roman bronze coin', 'img'),
		);
		// text query through the joint tower is near an image sharing tokens.
		const imgVec = provider.vectorFor('roman bronze coin obverse', 'img');
		const txtVec = provider.vectorFor('roman bronze coin', 'txt');
		const distinct = provider.vectorFor('marble statue greek', 'txt');
		expect(cosineDistance(imgVec, txtVec)).toBeLessThan(cosineDistance(imgVec, distinct));
	});

	test('extractVectors normalises both response shapes; rejects malformed', () => {
		expect(
			extractVectors({
				embeddings: [
					[1, 2],
					[3, 4],
				],
			}),
		).toEqual([
			[1, 2],
			[3, 4],
		]);
		expect(extractVectors({ data: [{ embedding: [5, 6] }] })).toEqual([[5, 6]]);
		expect(extractVectors({ embeddings: [[1, 'x']] })).toEqual([]);
		expect(extractVectors({})).toEqual([]);
	});
});

describe('characterizer aggregators (pure)', () => {
	const cat = (value: string, weight: number) => ({
		value,
		weight,
		sectionTipo: 's',
		sectionId: 1,
		thumbUrl: null,
	});
	test('aggregateCategorical: similarity-weighted vote + confidence share', () => {
		const result = aggregateCategorical([
			cat('denarius', 0.9),
			cat('denarius', 0.6),
			cat('as', 0.3),
		]);
		expect(result.proposal).toBe('denarius');
		expect(result.confidence).toBeCloseTo(1.5 / 1.8, 4);
		expect(result.distribution[0]!.value).toBe('denarius');
	});
	test('summarizeDates: earliest…latest + confidence from midpoint spread', () => {
		const d = (from: number, to: number, label: string, weight: number) => ({
			from,
			to,
			label,
			weight,
			sectionTipo: 's',
			sectionId: 1,
			thumbUrl: null,
		});
		const result = summarizeDates([d(100, 100, '100 AD', 1), d(200, 200, '200 AD', 1)]);
		expect(result.proposal.earliest).toBe('100 AD');
		expect(result.proposal.latest).toBe('200 AD');
		expect(result.confidence).toBeGreaterThanOrEqual(0);
	});
});

describe('RagCharacterizer (injected fakes, no DB)', () => {
	test('aggregates neighbours via their own context metadata', async () => {
		const neighbours: Candidate[] = [
			{
				sectionTipo: SECTION_TIPO,
				sectionId: 2,
				componentTipo: IMAGE_TIPO,
				lang: NOLAN,
				chunkIndex: 0,
				sourceText: null,
				sourceKind: 'image_visual',
				modality: 'image',
				egressClass: 'public',
				parentKey: null,
				chunkMeta: { thumb_path: '/t/2.jpg' },
				rrfScore: 0.9,
			},
		];
		const characterizer = new RagCharacterizer({
			config: {
				getCompareScope: async () => [SECTION_TIPO],
				getContextMetadata: async () => ({ typology: 'test26' }),
			},
			objectRetrieval: { findSimilarObjects: async () => neighbours },
			roleReader: async () => ({ kind: 'categorical', value: 'denarius' }),
		});
		const result = await characterizer.characterize(SUPERUSER, {
			sectionTipo: SECTION_TIPO,
			sectionId: 1,
		} as RecordLocator);
		expect(result.neighboursConsidered).toBe(1);
		const typology = result.proposals.typology;
		expect(typology?.kind).toBe('categorical');
		expect((typology as { proposal: string }).proposal).toBe('denarius');
	});

	test('M3: a role component the caller cannot read yields NO proposal (no cross-component leak)', async () => {
		const neighbours: Candidate[] = [
			{
				sectionTipo: SECTION_TIPO,
				sectionId: 2,
				componentTipo: IMAGE_TIPO,
				lang: NOLAN,
				chunkIndex: 0,
				sourceText: null,
				sourceKind: 'image_visual',
				modality: 'image',
				egressClass: 'public',
				parentKey: null,
				chunkMeta: { thumb_path: '/t/2.jpg' },
				rrfScore: 0.9,
			},
		];
		const characterizer = new RagCharacterizer({
			config: {
				getCompareScope: async () => [SECTION_TIPO],
				getContextMetadata: async () => ({ typology: 'test26' }),
			},
			// The neighbour list is (in production) ACL-filtered on the image component;
			// the fake returns it regardless so we isolate the role-component gate.
			objectRetrieval: { findSimilarObjects: async () => neighbours },
			// The reader would happily return a value — the gate must stop us BEFORE it.
			roleReader: async () => ({ kind: 'categorical', value: 'denarius' }),
		});
		// NO_ACCESS (no profile) has level 0 on test26 in the non-public test section.
		const result = await characterizer.characterize(NO_ACCESS, {
			sectionTipo: SECTION_TIPO,
			sectionId: 1,
		} as RecordLocator);
		expect(result.neighboursConsidered).toBe(1); // neighbour retrieved…
		expect(result.proposals.typology).toBeUndefined(); // …but its restricted role is withheld
	});
});

describe.if(REAL_INGEST)('the stored image row IS the ingest pipeline output', () => {
	test('one vector per image component, reproducible from the derivative on disk', async () => {
		const sectionId = createdIds[0] as number;
		const stored = await getRecordVectors(
			{ sectionTipo: SECTION_TIPO, sectionId } as RecordLocator,
			MODEL,
			'image',
		);
		expect(stored).toHaveLength(1);
		const row = stored[0]!;
		expect(row.chunkIndex).toBe(0);
		expect(row.view).toBe('obverse');
		// source_text is the REAL context summary, read from the record's metadata role.
		expect(row.sourceText).toBe(summaryFor(OBJECTS[0]!.caption));
		// The vector is the encoder's output for the bytes the extractor produced —
		// re-extracting the same derivative reproduces it (what the hash-diff assumes).
		const extracted = extractedByRecord.get(sectionId) as ExtractedImage;
		const [fresh] = await provider.embedImage([extracted.base64]);
		expect(row.embedding).toHaveLength((fresh as number[]).length);
		expect(cosineDistance(row.embedding, fresh as number[])).toBeLessThan(1e-5);
	});

	test('chunk_meta carries the REAL derivative facts retrieval renders', async () => {
		const sectionId = createdIds[0] as number;
		const extracted = extractedByRecord.get(sectionId) as ExtractedImage;
		const rows = (await ragSql.unsafe(
			`SELECT chunk_meta, source_hash, modality, source_kind, parent_key, dimension
			 FROM rag_embeddings
			 WHERE section_tipo = $1 AND section_id = $2 AND model = $3`,
			[SECTION_TIPO, sectionId, MODEL],
		)) as {
			chunk_meta: Record<string, unknown>;
			source_hash: string;
			modality: string;
			source_kind: string;
			parent_key: string;
			dimension: number;
		}[];
		expect(rows).toHaveLength(1);
		const row = rows[0]!;
		expect(row.modality).toBe('image');
		expect(row.source_kind).toBe('image_visual');
		expect(row.parent_key).toBe(`${SECTION_TIPO}_${sectionId}`);
		// The tier actually read: a derivative, NEVER an archival master.
		expect(row.chunk_meta.quality).toBe(IMAGE_SPEC.defaultQuality);
		expect(row.chunk_meta.quality).toBe(extracted.quality);
		expect(row.chunk_meta.media_tipo).toBe(IMAGE_TIPO);
		// Dimensions of the STORED derivative, measured by ImageMagick during ingest.
		expect(row.chunk_meta.width).toBe(extracted.width);
		expect(row.chunk_meta.height).toBe(extracted.height);
		expect(typeof row.chunk_meta.width).toBe('number');
		// The thumb IDENTITY is only stored when the thumb derivative really exists;
		// the URL is never stored — it is derived at read (T2-D03-c).
		expect(row.chunk_meta.thumb_path).toBe(extracted.thumbPath);
		expect(String(row.chunk_meta.thumb_path)).toContain(`/${config.media.thumb.quality}/`);
		expect(Object.keys(row.chunk_meta)).not.toContain('thumb_url');
	});

	test('re-indexing an UNCHANGED image costs no encoder call', async () => {
		let calls = 0;
		const counting: MultimodalEmbeddingProvider = {
			embedImage: async (images) => {
				calls++;
				return provider.embedImage(images);
			},
			embedTextForImageSearch: (texts) => provider.embedTextForImageSearch(texts),
			dimension: () => provider.dimension(),
			model: () => MODEL,
			provider: () => 'local',
			isExternal: () => false,
		};
		const sectionId = createdIds[0] as number;
		const ok = await buildImageIndexer(counting).indexRecordImages({
			sectionTipo: SECTION_TIPO,
			sectionId,
		});
		expect(ok).toBe(true);
		// Same bytes + same context summary ⇒ same source_hash ⇒ skip.
		expect(calls).toBe(0);
	});
});

describe.if(REAL_INGEST)('ObjectRetrieval (live pgvector, real-ingest vectors)', () => {
	test('findSimilarObjects returns the other object, excluding the seed', async () => {
		const objectRetrieval = new ObjectRetrieval(provider);
		const hits = await objectRetrieval.findSimilarObjects(
			SUPERUSER,
			{ sectionTipo: SECTION_TIPO, sectionId: createdIds[0]! } as RecordLocator,
			{ sectionTipos: [SECTION_TIPO], mode: 'visual', topK: 5 },
		);
		expect(hits.every((h) => h.sectionId !== createdIds[0])).toBe(true);
		expect(hits.some((h) => h.sectionId === createdIds[1])).toBe(true);
	});

	test('hybrid mode also fuses the lexical leg over the stored context summary', async () => {
		// Both captions share "roman bronze coin", so the lexical leg over the REAL
		// summaries retrieves the sibling even though the encoder is not semantic.
		const objectRetrieval = new ObjectRetrieval(provider);
		const hits = await objectRetrieval.findSimilarObjects(
			SUPERUSER,
			{ sectionTipo: SECTION_TIPO, sectionId: createdIds[0]! } as RecordLocator,
			{ sectionTipos: [SECTION_TIPO], mode: 'hybrid', topK: 5 },
		);
		expect(hits.some((h) => h.sectionId === createdIds[1])).toBe(true);
		expect(hits[0]!.sourceText).toBe(summaryFor(OBJECTS[1]!.caption));
	});

	test('a denied user gets NOTHING (DoD)', async () => {
		const objectRetrieval = new ObjectRetrieval(provider);
		const hits = await objectRetrieval.findSimilarObjects(
			NO_ACCESS,
			{ sectionTipo: SECTION_TIPO, sectionId: createdIds[0]! } as RecordLocator,
			{ sectionTipos: [SECTION_TIPO], mode: 'visual', topK: 5 },
		);
		expect(hits).toEqual([]);
	});
});

describe.if(REAL_INGEST)('dd_rag_api image actions', () => {
	test('similar_objects returns shaped objects with similarity + thumb_url', async () => {
		const res = await ragApiActions.similar_objects(
			rqo({
				section_tipo: SECTION_TIPO,
				section_id: createdIds[0],
				similarity_mode: 'visual',
				limit: 5,
			}),
			{ principal: SUPERUSER } as Ctx,
		);
		expect(res.body.msg).toBe('ok');
		const hits = res.body.data as { section_id: number; thumb_url: string | null }[];
		expect(hits.some((h) => h.section_id === createdIds[1])).toBe(true);
		// Every thumb_url points at THAT record's real thumb derivative.
		for (const hit of hits) {
			expect(hit.thumb_url).toContain(`/${config.media.thumb.quality}/`);
			expect(hit.thumb_url).toContain(`${IMAGE_TIPO}_${SECTION_TIPO}_${hit.section_id}.`);
		}
	});

	test('search_by_text_image reaches the image partition through the joint tower', async () => {
		// The deterministic encoder is not semantic, so this asserts the PLUMBING —
		// query → joint text tower → ANN over the real image vectors → ACL → shape —
		// not that the caption's meaning matches the pixels.
		const res = await ragApiActions.search_by_text_image(
			rqo({ query: 'roman bronze coin', section_tipo: [SECTION_TIPO], limit: 5 }),
			{ principal: SUPERUSER } as Ctx,
		);
		expect(res.body.msg).toBe('ok');
		const hits = res.body.data as { section_id: number }[];
		expect(hits.length).toBeGreaterThan(0);
		expect(hits.every((h) => createdIds.includes(h.section_id))).toBe(true);
	});

	test('characterize_object returns a proposals envelope', async () => {
		const res = await ragApiActions.characterize_object(
			rqo({ section_tipo: SECTION_TIPO, section_id: createdIds[0], limit: 5 }),
			{ principal: SUPERUSER } as Ctx,
		);
		expect(res.body.msg).toBe('ok');
		expect(res.body.data).toHaveProperty('neighboursConsidered');
	});
});

// The feature-flag gate needs neither media nor vectors, so it never skips.
describe('dd_rag_api image actions (flag gate)', () => {
	test('image actions decline when media is disabled', async () => {
		process.env.DEDALO_RAG_MEDIA_ENABLED = '';
		try {
			// Envelope v2: the decline is a THROW carrying the registry code (the
			// retired compat mirror used to spell it as `errors:['media_disabled']`).
			await expect(
				ragApiActions.search_by_text_image(rqo({ query: 'x' }), {
					principal: SUPERUSER,
				} as Ctx),
			).rejects.toMatchObject({ code: 'rag.media_disabled' });
		} finally {
			process.env.DEDALO_RAG_MEDIA_ENABLED = 'true';
		}
	});
});
