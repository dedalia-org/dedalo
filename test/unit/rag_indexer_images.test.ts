/**
 * The indexer's IMAGE pass, over injected fakes (no vector store, no embedder,
 * no media tree). What is gated here is the convergence and safety behaviour —
 * the parts that fail silently in production if they regress:
 *
 *  - a disabled feature flag never deletes anyone's index;
 *  - a section that stops declaring images prunes, rather than serving stale
 *    vectors forever;
 *  - the egress policy is enforced where bytes would leave the host, and
 *    refusing does NOT destroy the existing index;
 *  - an unchanged image costs no provider call;
 *  - an embed failure writes nothing, prunes nothing, and stays retryable.
 */

import { describe, expect, test } from 'bun:test';
import { type RagImageDeps, RagIndexer, type RagStore } from '../../src/ai/rag/indexer.ts';
import type { EmbeddingRow, RecordLocator } from '../../src/ai/rag/types.ts';

const LOCATOR: RecordLocator = { sectionTipo: 'test3', sectionId: 1 };
const VECTOR = [0.1, 0.2, 0.3];

interface StoreCalls {
	upserts: EmbeddingRow[][];
	stale: Array<[string, string, string, number]>;
	prunedModalities: string[];
}

function fakeStore(existing: Map<string, string> = new Map()): {
	store: RagStore;
	calls: StoreCalls;
} {
	const calls: StoreCalls = { upserts: [], stale: [], prunedModalities: [] };
	const store: RagStore = {
		diffHashes: async () => existing,
		upsertEmbeddingRows: async (rows) => {
			calls.upserts.push(rows);
		},
		deleteStale: async (_locator, componentTipo, lang, model, validCount) => {
			calls.stale.push([componentTipo, lang, model, validCount]);
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

interface ProviderCalls {
	embedded: string[][];
}

function fakeImageDeps(
	overrides: Partial<RagImageDeps> & { external?: boolean; vectors?: number[][] } = {},
): { image: RagImageDeps; calls: ProviderCalls } {
	const calls: ProviderCalls = { embedded: [] };
	const image: RagImageDeps = {
		provider: {
			embedImage: async (images) => {
				calls.embedded.push(images as string[]);
				return overrides.vectors ?? [VECTOR];
			},
			embedTextForImageSearch: async () => [],
			dimension: () => VECTOR.length,
			model: () => 'test-multimodal',
			provider: () => 'local',
			isExternal: () => overrides.external === true,
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
		contextSummary: async () => 'typology: Amphora · period: Roman',
		maxPx: 512,
		allowExternal: false,
		...overrides,
	};
	return { image, calls };
}

/** An indexer whose TEXT half is a no-op, so only the image pass is observed. */
function buildIndexer(input: {
	store: RagStore;
	image?: RagImageDeps;
	images?: Array<{ tipo: string; view: string | null }>;
	metadata?: Record<string, string>;
}): RagIndexer {
	const config = {
		getEmbedGroups: async () => [],
		getContextImages: async () => input.images ?? [{ tipo: 'test88', view: 'obverse' }],
		getContextMetadata: async () => input.metadata ?? { typology: 'test40' },
	};
	return new RagIndexer({
		config: config as never,
		provider: { name: 'stub', model: 'stub-text', embed: async () => [] } as never,
		ontology: {} as never,
		store: input.store,
		langs: ['lg-spa'],
		nolan: 'lg-nolan',
		resolveDocs: async () => [],
		recordTitle: async () => '',
		...(input.image === undefined ? {} : { image: input.image }),
	});
}

describe('indexRecordImages', () => {
	test('media disabled is a no-op that touches nothing', async () => {
		const { store, calls } = fakeStore();
		const indexer = buildIndexer({ store });

		expect(await indexer.indexRecordImages(LOCATOR)).toBe(true);
		// Toggling a feature flag off must never delete an existing index.
		expect(calls.prunedModalities).toEqual([]);
		expect(calls.upserts).toEqual([]);
	});

	test('a section with no declared images prunes its image vectors', async () => {
		const { store, calls } = fakeStore();
		const { image } = fakeImageDeps();
		const indexer = buildIndexer({ store, image, images: [] });

		expect(await indexer.indexRecordImages(LOCATOR)).toBe(true);
		expect(calls.prunedModalities).toEqual(['image']);
	});

	test('an external provider is refused unless the policy allows it', async () => {
		const { store, calls } = fakeStore();
		const { image, calls: provider } = fakeImageDeps({ external: true, allowExternal: false });
		const indexer = buildIndexer({ store, image });

		expect(await indexer.indexRecordImages(LOCATOR)).toBe(true);
		expect(provider.embedded).toEqual([]); // no bytes left the host
		expect(calls.upserts).toEqual([]);
		// Refusing is not destructive: the existing index survives the policy.
		expect(calls.prunedModalities).toEqual([]);
	});

	test('an external provider is allowed once the institution opts in', async () => {
		const { store, calls } = fakeStore();
		const { image, calls: provider } = fakeImageDeps({ external: true, allowExternal: true });
		const indexer = buildIndexer({ store, image });

		expect(await indexer.indexRecordImages(LOCATOR)).toBe(true);
		expect(provider.embedded).toEqual([['b64:test88']]);
		expect(calls.upserts[0]).toHaveLength(1);
	});

	test('writes one image row carrying what retrieval reads back', async () => {
		const { store, calls } = fakeStore();
		const { image } = fakeImageDeps();
		const indexer = buildIndexer({ store, image });

		expect(await indexer.indexRecordImages(LOCATOR)).toBe(true);
		const row = calls.upserts[0]?.[0] as EmbeddingRow;
		expect(row.modality).toBe('image');
		expect(row.sourceKind).toBe('image_visual');
		expect(row.componentTipo).toBe('test88');
		expect(row.lang).toBe('lg-nolan');
		expect(row.chunkIndex).toBe(0);
		expect(row.model).toBe('test-multimodal');
		expect(row.dimension).toBe(VECTOR.length);
		expect(row.parentKey).toBe('test3_1');
		// source_text is the ONLY text an image row has — the hybrid lexical leg.
		expect(row.sourceText).toBe('typology: Amphora · period: Roman');
		// snake_case: read back as chunk_meta.view / chunk_meta.thumb_path.
		expect(row.chunkMeta).toMatchObject({
			media_tipo: 'test88',
			view: 'obverse',
			quality: '1.5MB',
			width: 800,
			height: 600,
		});
		// T2-D03-c: the thumb is stored as its IDENTITY (media-root-relative path);
		// the URL — frozen on today's media web base — is never persisted.
		expect(row.chunkMeta?.thumb_path).toBe('/image/thumb/0/x.jpg');
		expect(Object.keys(row.chunkMeta ?? {})).not.toContain('thumb_url');
	});

	test('an unchanged image costs no provider call and stays alive', async () => {
		const { image: probe } = fakeImageDeps();
		const extracted = await probe.extract({
			componentTipo: 'test88',
			sectionTipo: 'test3',
			sectionId: 1,
			maxPx: 512,
		});
		const { imageSourceHash } = await import('../../src/ai/rag/image_source.ts');
		const stored = imageSourceHash(
			(extracted as NonNullable<typeof extracted>).bytesHash,
			'typology: Amphora · period: Roman',
			(extracted as NonNullable<typeof extracted>).thumbPath,
		);

		const { store, calls } = fakeStore(new Map([['test88|lg-nolan|0', stored]]));
		const { image, calls: provider } = fakeImageDeps();
		const indexer = buildIndexer({ store, image });

		expect(await indexer.indexRecordImages(LOCATOR)).toBe(true);
		expect(provider.embedded).toEqual([]); // the expensive call is skipped
		expect(calls.upserts).toEqual([]);
		expect(calls.stale).toEqual([['test88', 'lg-nolan', 'test-multimodal', 1]]);
	});

	test('an unreadable derivative prunes that component', async () => {
		const { store, calls } = fakeStore();
		const { image } = fakeImageDeps({ extract: async () => null });
		const indexer = buildIndexer({ store, image });

		expect(await indexer.indexRecordImages(LOCATOR)).toBe(true);
		expect(calls.upserts).toEqual([]);
		expect(calls.stale).toEqual([['test88', 'lg-nolan', 'test-multimodal', 0]]);
	});

	test('an embed failure writes nothing, prunes nothing, and is retryable', async () => {
		const { store, calls } = fakeStore();
		// The provider contract is [] on ANY failure — never a partial batch.
		const { image } = fakeImageDeps({ vectors: [] });
		const indexer = buildIndexer({ store, image });

		expect(await indexer.indexRecordImages(LOCATOR)).toBe(false);
		expect(calls.upserts).toEqual([]);
		expect(calls.stale).toEqual([]); // a failed image must not be pruned
	});

	test('a component dropped from the descriptor is swept', async () => {
		const { store, calls } = fakeStore(
			new Map([
				['test88|lg-nolan|0', 'whatever'],
				['test99|lg-nolan|0', 'orphan'],
			]),
		);
		const { image } = fakeImageDeps();
		const indexer = buildIndexer({ store, image });

		expect(await indexer.indexRecordImages(LOCATOR)).toBe(true);
		expect(calls.stale).toContainEqual(['test99', 'lg-nolan', 'test-multimodal', 0]);
	});

	test('a bad locator is refused', async () => {
		const { store } = fakeStore();
		const { image } = fakeImageDeps();
		const indexer = buildIndexer({ store, image });

		expect(await indexer.indexRecordImages({ sectionTipo: 'test3', sectionId: 0 })).toBe(false);
		expect(await indexer.indexRecordImages({ sectionTipo: '', sectionId: 1 })).toBe(false);
	});
});

describe('indexRecord', () => {
	test('runs BOTH halves and fails if either does', async () => {
		const { store } = fakeStore();
		const { image } = fakeImageDeps({ vectors: [] }); // image half fails
		const indexer = buildIndexer({ store, image });

		// The text half is a clean no-op here (no embed groups), so a false
		// result can only come from the image half — and it must not be masked.
		expect(await indexer.indexRecord(LOCATOR)).toBe(false);
	});
});
