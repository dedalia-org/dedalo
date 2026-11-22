/**
 * Full-record RAG indexer (TEXT path). 2026-07-22: extraction is GROUP-based —
 * the section_map `rag.embed` descriptor (config.ts) names ddo_map GROUPS, and
 * embed_source.ts resolves each into ONE composite document per (group, lang)
 * through the read path's request_config machinery (deep relation resolution
 * included), under the system index-time context. The IMAGE/multimodal path is
 * a later brick and is not built here.
 *
 * indexRecord(locator) orchestrates one record's text ingestion:
 *   1. gate on the section's descriptor (RagConfig.getEmbedGroups — virtual-aware),
 *   2. RESOLVE each group's per-lang document (embed_source.resolveEmbedDocs),
 *   3. chunk (structure-aware semantic; chunker.ts) under the group's config,
 *   4. hash-diff against the stored source_hash — skip unchanged chunks,
 *   5. embed only the changed chunks (injected provider; skip on failure),
 *   6. atomic upsert (store.upsertEmbeddingRows), then prune stale tails AND
 *      whole groups the descriptor no longer declares.
 *
 * Chunks store component_tipo = `rag:<group>` (the facet unit retrieval's group
 * filter and record-level ACL key on) and chunk_meta.contributors (which
 * components/sections fed the doc — the ask-path egress input).
 *
 * All failures are SOFT: a read/embed/store error returns false so the queue
 * retries; nothing throws into the caller. No module-global mutable state — every
 * dependency is injected; `buildRagIndexer()` wires the production defaults.
 */

import { config } from '../../config/config.ts';
import { readString } from '../../config/readers.ts';
import { getTermByTipo } from '../../core/ontology/resolver.ts';
import { type Chunk, type ChunkOpts, chunk } from './chunker.ts';
import { defaultOntologyPort, type OntologyPort, RAG_GROUP_PREFIX, RagConfig } from './config.ts';
import { type EmbedDoc, type ResolveEmbedDocsInput, resolveEmbedDocs } from './embed_source.ts';
import { type EmbeddingProvider, getEmbeddingProvider } from './embedding_provider.ts';
import {
	buildImageContextSummary,
	type ExtractedImage,
	extractImageForEmbedding,
	imageSourceHash,
} from './image_source.ts';
import {
	buildMultimodalProvider,
	isMediaEnabled,
	multimodalConfigFromEnv,
} from './multimodal_config.ts';
import type { MultimodalEmbeddingProvider } from './multimodal_embedding_provider.ts';
import type { EmbeddingRow, RecordLocator } from './types.ts';
import {
	deleteRecordModality,
	deleteStale,
	diffHashes,
	listSectionIds,
	deleteRecord as storeDeleteRecord,
	upsertEmbeddingRows,
} from './vector_store.ts';

/** The vector-store surface the indexer needs (injectable for unit tests). */
export interface RagStore {
	diffHashes(
		locator: RecordLocator,
		model: string,
		modality?: string,
	): Promise<Map<string, string>>;
	upsertEmbeddingRows(rows: EmbeddingRow[]): Promise<void>;
	deleteStale(
		locator: RecordLocator,
		componentTipo: string,
		lang: string,
		model: string,
		validCount: number,
		modality?: string,
	): Promise<number>;
	deleteRecordModality(locator: RecordLocator, modality: string): Promise<void>;
	deleteRecord(locator: RecordLocator): Promise<void>;
	listSectionIds(sectionTipo: string): Promise<number[]>;
}

export interface RagIndexerDeps {
	config: RagConfig;
	provider: EmbeddingProvider;
	ontology: OntologyPort;
	store: RagStore;
	/** Data langs a lang-sensitive group resolves in. */
	langs: readonly string[];
	/** No-lang code for lang-independent groups (DEDALO_DATA_NOLAN). */
	nolan: string;
	/**
	 * Resolve the record's embed documents (embed_source.resolveEmbedDocs in
	 * production — the ddo_map/system-scope resolution seam; a stub in tests).
	 */
	resolveDocs: (input: ResolveEmbedDocsInput) => Promise<EmbedDoc[]>;
	/** Best-effort record display label for the chunker's contextual header. */
	recordTitle: (sectionTipo: string, lang: string) => Promise<string>;
	/**
	 * The IMAGE half. Absent when media indexing is switched off, in which case
	 * the image pass is a no-op that touches nothing. Injected (rather than read
	 * from env here) so the indexer stays env-free and unit-testable.
	 */
	image?: RagImageDeps;
}

/** Everything the image pass needs, all injectable. */
export interface RagImageDeps {
	provider: MultimodalEmbeddingProvider;
	extract: (input: {
		componentTipo: string;
		sectionTipo: string;
		sectionId: number;
		maxPx: number;
	}) => Promise<ExtractedImage | null>;
	contextSummary: (input: {
		sectionTipo: string;
		sectionId: number;
		metadata: Record<string, string>;
		dataLang: string;
	}) => Promise<string>;
	/** Longest-side cap for the encoder input. */
	maxPx: number;
	/** Whether this install permits images to reach an EXTERNAL provider. */
	allowExternal: boolean;
}

export class RagIndexer {
	constructor(private readonly deps: RagIndexerDeps) {}

	/**
	 * Index one record: text and images are INDEPENDENT halves, both always
	 * attempted, and the record only succeeds when both do. A failing image
	 * embedder must not stop text from converging, and vice versa — but either
	 * failing must keep the queue marker so the record is retried.
	 */
	async indexRecord(locator: RecordLocator): Promise<boolean> {
		const textOk = await this.indexRecordText(locator);
		const imageOk = await this.indexRecordImages(locator);
		return textOk && imageOk;
	}

	/**
	 * Index one record's IMAGES: one vector per declared media component, in the
	 * multimodal model's own partition. Returns true on success or a clean no-op,
	 * false on a RETRYABLE failure.
	 *
	 * Structurally the twin of {@link indexRecordText}: embed OUTSIDE any
	 * transaction, then one short flush. The two never collide because their
	 * models differ, and `model` is the partition key.
	 */
	async indexRecordImages(locator: RecordLocator): Promise<boolean> {
		if (locator.sectionId < 1 || locator.sectionTipo === '') return false;

		const image = this.deps.image;
		// Media off: leave whatever is stored alone. Toggling a feature flag must
		// never be a destructive operation on someone's index.
		if (image === undefined) return true;

		const declared = await this.deps.config.getContextImages(locator.sectionTipo);
		if (declared.length === 0) {
			// Not opted in — or the descriptor lost its images. Converge by pruning.
			try {
				await this.deps.store.deleteRecordModality(locator, 'image');
				return true;
			} catch {
				return false;
			}
		}

		// The institution's egress policy, applied where bytes would actually
		// leave the host. Refusing here (rather than pruning) keeps an existing
		// index intact while the policy is off.
		if (image.provider.isExternal() && !image.allowExternal) {
			console.warn(
				`[rag_image] skipping ${locator.sectionTipo}/${locator.sectionId}: external provider not permitted by policy`,
			);
			return true;
		}

		const model = image.provider.model();
		const metadata = await this.deps.config.getContextMetadata(locator.sectionTipo);

		let existingHashes: Map<string, string>;
		let contextSummary: string;
		try {
			existingHashes = await this.deps.store.diffHashes(locator, model, 'image');
			contextSummary = await image.contextSummary({
				sectionTipo: locator.sectionTipo,
				sectionId: locator.sectionId,
				metadata,
				dataLang: this.deps.langs[0] ?? this.deps.nolan,
			});
		} catch {
			return false; // retryable: matrix/store read failed
		}

		// Phase 1: extract + embed (slow) OUTSIDE any transaction.
		const pendingUpserts: EmbeddingRow[] = [];
		const pendingStale: Array<[string, string, number]> = [];
		const liveKeys = new Set<string>();
		let embedFailure = false;

		for (const declaredImage of declared) {
			const componentTipo = declaredImage.tipo;
			const lang = this.deps.nolan; // an image has no language
			liveKeys.add(`${componentTipo}|${lang}`);

			const extracted = await image.extract({
				componentTipo,
				sectionTipo: locator.sectionTipo,
				sectionId: locator.sectionId,
				maxPx: image.maxPx,
			});
			if (extracted === null) {
				// No readable derivative — prune anything stored for it before. The
				// extractor logs the cases that are misconfiguration rather than
				// bad luck (master-only tier, non-image tipo, translatable media),
				// because this prune cannot distinguish them and must not be the
				// only trace a component left.
				pendingStale.push([componentTipo, lang, 0]);
				continue;
			}

			const sourceHash = imageSourceHash(extracted.bytesHash, contextSummary, extracted.thumbPath);
			const key = `${componentTipo}|${lang}|0`;
			if (existingHashes.get(key) === sourceHash) {
				// Unchanged: no provider call, no write — just keep it alive.
				pendingStale.push([componentTipo, lang, 1]);
				continue;
			}

			const vectors = await image.provider.embedImage([extracted.base64]);
			const vector = vectors[0];
			if (vectors.length !== 1 || vector === undefined || vector.length === 0) {
				// The provider returns [] rather than a partial batch on any failure.
				embedFailure = true; // retry the record; write nothing, prune nothing
				continue;
			}

			pendingUpserts.push({
				sectionTipo: locator.sectionTipo,
				sectionId: locator.sectionId,
				componentTipo,
				lang,
				chunkIndex: 0, // one vector per image component
				provider: image.provider.provider(),
				model,
				dimension: vector.length,
				embedding: vector,
				sourceHash,
				// The only text an image row carries — the hybrid lexical leg.
				sourceText: contextSummary,
				tokenCount: null,
				modality: 'image',
				sourceKind: 'image_visual',
				egressClass: 'public',
				parentKey: `${locator.sectionTipo}_${locator.sectionId}`,
				// snake_case: these keys are read back by the retrieval and API
				// layers (chunk_meta.view; chunk_meta.thumb_path through
				// image_source.storedThumbUrl). The thumb is stored as its IDENTITY
				// (media-root-relative path), never as a URL: the URL is derived at
				// read on the current media web base (T2-D03-c).
				chunkMeta: {
					media_tipo: componentTipo,
					view: declaredImage.view ?? null,
					quality: extracted.quality,
					thumb_path: extracted.thumbPath,
					width: extracted.width,
					height: extracted.height,
				},
			});
			pendingStale.push([componentTipo, lang, 1]);
		}

		// Orphan sweep: image components dropped from the descriptor.
		for (const storedKey of existingHashes.keys()) {
			const [ct, lg] = storedKey.split('|', 2) as [string, string];
			if (!liveKeys.has(`${ct}|${lg}`)) pendingStale.push([ct, lg, 0]);
		}

		if (pendingUpserts.length === 0 && pendingStale.length === 0) {
			return !embedFailure;
		}

		// Phase 2: flush.
		try {
			if (pendingUpserts.length > 0) {
				await this.deps.store.upsertEmbeddingRows(pendingUpserts);
			}
			for (const [ct, lg, cnt] of pendingStale) {
				await this.deps.store.deleteStale(locator, ct, lg, model, cnt, 'image');
			}
		} catch {
			return false; // retryable: the vector store write failed
		}

		return !embedFailure;
	}

	/**
	 * Index one record's text. Returns true on success (or a clean no-op when the
	 * section is not RAG-enabled), false on a RETRYABLE failure.
	 */
	async indexRecordText(locator: RecordLocator): Promise<boolean> {
		if (locator.sectionId < 1 || locator.sectionTipo === '') return false;

		const groups = await this.deps.config.getEmbedGroups(locator.sectionTipo);
		if (groups.length === 0) {
			// Not opted in — or the descriptor was removed. Prune any prior text
			// vectors so an edited-out section converges (no-op when none exist).
			try {
				await this.deps.store.deleteRecordModality(locator, 'text');
				return true;
			} catch {
				return false;
			}
		}

		const model = this.deps.provider.model;

		let docs: EmbedDoc[];
		let existingHashes: Map<string, string>;
		try {
			docs = await this.deps.resolveDocs({
				sectionTipo: locator.sectionTipo,
				sectionId: locator.sectionId,
				groups,
				langs: this.deps.langs,
				nolan: this.deps.nolan,
			});
			existingHashes = await this.deps.store.diffHashes(locator, model, 'text');
		} catch {
			return false; // retryable: matrix/store read failed
		}

		const documentTitle = await this.recordTitle(locator);

		// Phase 1: chunk + hash-diff + embed (slow) OUTSIDE any transaction.
		const pendingUpserts: EmbeddingRow[] = [];
		const pendingStale: Array<[string, string, number]> = []; // [componentTipo, lang, validCount]
		// Every (component_tipo|lang) this pass produced or pruned — the survivors.
		const liveKeys = new Set<string>();
		let embedFailure = false;

		for (const doc of docs) {
			const storageTipo = `${RAG_GROUP_PREFIX}${doc.group}`;
			const ragCfg = await this.deps.config.getGroupRagConfig(locator.sectionTipo, doc.group);
			const chunks = chunk(doc.text, {
				...(ragCfg.chunk?.maxTokens !== undefined ? { maxTokens: ragCfg.chunk.maxTokens } : {}),
				...(ragCfg.chunk?.minTokens !== undefined ? { minTokens: ragCfg.chunk.minTokens } : {}),
				// the group's authored chunking mode/strategy (auto-detect when absent)
				...(ragCfg.mode !== undefined ? { mode: ragCfg.mode as ChunkOpts['mode'] } : {}),
				...(ragCfg.strategy !== undefined
					? { strategy: ragCfg.strategy as ChunkOpts['strategy'] }
					: {}),
				documentTitle,
			});

			if (chunks.length === 0) {
				// doc became empty → prune all chunks for this group/lang
				pendingStale.push([storageTipo, doc.lang, 0]);
				liveKeys.add(`${storageTipo}|${doc.lang}`);
				continue;
			}

			// determine which chunks changed (hash differs from stored)
			const toEmbedIdx: number[] = [];
			for (let i = 0; i < chunks.length; i++) {
				const c = chunks[i] as Chunk;
				const key = `${storageTipo}|${doc.lang}|${c.chunkIndex}`;
				if (existingHashes.get(key) === c.sourceHash) continue; // unchanged: skip
				toEmbedIdx.push(i);
			}

			if (toEmbedIdx.length > 0) {
				const embedTexts = toEmbedIdx.map((i) => (chunks[i] as Chunk).embedText);
				const vectors = await this.deps.provider.embed(embedTexts);
				if (vectors.length !== toEmbedIdx.length) {
					embedFailure = true; // do not write garbage; queue retries the record
					continue;
				}
				const dimension = vectors[0]?.length ?? 0;
				// The COUNT matching is not enough: a provider can return a
				// right-length batch with a hole in it (a sidecar that partially
				// failed), and a hole reaching the store is not a bad vector but a
				// NULL one — it violates the embedding not-null constraint and takes
				// the whole record's flush down with it. Every vector must be a
				// full-width row or the record is retried.
				const usable = vectors.every(
					(vector) => Array.isArray(vector) && vector.length === dimension && dimension > 0,
				);
				if (!usable) {
					embedFailure = true;
					continue;
				}
				for (let v = 0; v < toEmbedIdx.length; v++) {
					const c = chunks[toEmbedIdx[v] as number] as Chunk;
					pendingUpserts.push({
						sectionTipo: locator.sectionTipo,
						sectionId: locator.sectionId,
						componentTipo: storageTipo,
						lang: doc.lang,
						chunkIndex: c.chunkIndex,
						provider: this.deps.provider.name,
						model,
						dimension,
						embedding: vectors[v] as number[],
						sourceHash: c.sourceHash,
						sourceText: c.text,
						tokenCount: c.tokenCount,
						modality: 'text',
						sourceKind: c.sourceKind,
						egressClass: 'public',
						parentKey: c.parentKey,
						// contributors ride on every chunk: which components fed this
						// group's doc and which sections their text came from — the
						// ask-path egress gate's input for deep-resolved text.
						chunkMeta: {
							...(c.chunkMeta as Record<string, unknown>),
							contributors: doc.contributors,
						},
					});
				}
			}

			pendingStale.push([storageTipo, doc.lang, chunks.length]);
			liveKeys.add(`${storageTipo}|${doc.lang}`);
		}

		// Orphan sweep: stored (component_tipo|lang) pairs this pass did NOT
		// produce — groups renamed/removed in the descriptor, langs dropped from
		// config, and any pre-group-era rows. Without this, editing the descriptor
		// would leave stale facets forever retrievable.
		const orphanKeys = new Set<string>();
		for (const key of existingHashes.keys()) {
			const [ct, lg] = key.split('|', 2) as [string, string];
			const pairKey = `${ct}|${lg}`;
			if (!liveKeys.has(pairKey)) orphanKeys.add(pairKey);
		}
		for (const pairKey of orphanKeys) {
			const [ct, lg] = pairKey.split('|', 2) as [string, string];
			pendingStale.push([ct, lg, 0]);
		}

		if (pendingUpserts.length === 0 && pendingStale.length === 0) {
			return !embedFailure;
		}

		// Phase 2: flush all writes for this record ATOMICALLY (embedding already done).
		try {
			if (pendingUpserts.length > 0) {
				await this.deps.store.upsertEmbeddingRows(pendingUpserts);
			}
			for (const [ct, lg, cnt] of pendingStale) {
				await this.deps.store.deleteStale(locator, ct, lg, model, cnt, 'text');
			}
		} catch {
			return false; // retryable: the vector store write failed
		}

		return !embedFailure;
	}

	/** Remove every vector for a record. Returns false on a retryable failure. */
	async deleteRecord(locator: RecordLocator): Promise<boolean> {
		try {
			await this.deps.store.deleteRecord(locator);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Reconcile a section: detect record-id PRESENCE drift between the matrix and
	 * the vector store and enqueue corrections. matrix-only ids → index; vector-only
	 * ids → delete. The matrix id source is injected (no @dedalo/search coupling).
	 */
	async reconcileSection(
		sectionTipo: string,
		matrixIds: () => Promise<number[]>,
		enqueue: (locator: RecordLocator, op: 'index' | 'delete') => Promise<void>,
	): Promise<{ missing: number; orphan: number }> {
		const out = { missing: 0, orphan: 0 };
		if (!(await this.deps.config.sectionIsRagEnabled(sectionTipo))) return out;

		const matrixSet = new Set(await matrixIds());
		const vectorRows = await this.deps.store
			.listSectionIds(sectionTipo)
			.catch(() => [] as number[]);
		const vectorSet = new Set(vectorRows);

		for (const id of matrixSet) {
			if (!vectorSet.has(id)) {
				await enqueue({ sectionTipo, sectionId: id }, 'index');
				out.missing++;
			}
		}
		for (const id of vectorSet) {
			if (!matrixSet.has(id)) {
				await enqueue({ sectionTipo, sectionId: id }, 'delete');
				out.orphan++;
			}
		}
		return out;
	}

	/** Best-effort record display label for the chunker's contextual header. */
	private async recordTitle(locator: RecordLocator): Promise<string> {
		try {
			return await this.deps.recordTitle(
				locator.sectionTipo,
				this.deps.langs[0] ?? this.deps.nolan,
			);
		} catch {
			return '';
		}
	}
}

/** The production vector-store bundle (functional exports as one object). */
export function defaultRagStore(): RagStore {
	return {
		diffHashes,
		upsertEmbeddingRows,
		deleteStale,
		deleteRecordModality,
		deleteRecord: storeDeleteRecord,
		listSectionIds,
	};
}

/**
 * Wire the production RagIndexer: ontology port + config over the resolver,
 * the ddo_map/system-scope resolution seam (embed_source), the
 * deterministic/env-selected embedder, and the live vector store. Data langs
 * and nolan come from config (env-overridable).
 */
export function buildRagIndexer(): RagIndexer {
	const ontology = defaultOntologyPort();
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
	return new RagIndexer({
		config: new RagConfig(ontology),
		provider: getEmbeddingProvider(),
		ontology,
		store: defaultRagStore(),
		langs,
		nolan,
		resolveDocs: resolveEmbedDocs,
		recordTitle: async (sectionTipo, lang) => (await getTermByTipo(sectionTipo, lang)) ?? '',
		...(buildImageDeps() ?? {}),
	});
}

/**
 * The image half of the indexer, or nothing when media indexing is off. Spread
 * into the deps so a disabled install carries no image dependency at all rather
 * than a half-built one.
 */
function buildImageDeps(): { image: RagImageDeps } | null {
	if (!isMediaEnabled()) return null;
	const cfg = multimodalConfigFromEnv();

	let provider: MultimodalEmbeddingProvider;
	try {
		// Throws when the configured provider is external but the institution's
		// policy is local_only — a configuration error, stated loudly.
		provider = buildMultimodalProvider(cfg);
	} catch (error) {
		// Disable the IMAGE half only. A misconfigured image policy must not
		// stop text indexing: that would turn a narrow config mistake into a
		// silent, total loss of search.
		console.error(`[rag] image indexing disabled — ${String(error)}`);
		return null;
	}

	return {
		image: {
			provider,
			extract: extractImageForEmbedding,
			contextSummary: buildImageContextSummary,
			maxPx: cfg.imageMaxPx,
			// The institution's decision, not ours. Kept as a runtime check too:
			// the build-time assert only sees the CONFIGURED provider, and this
			// is the last gate before bytes are handed over.
			allowExternal: cfg.imageEgressPolicy === 'allow_external',
		},
	};
}
