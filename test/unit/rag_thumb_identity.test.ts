/**
 * THE RAG IMAGE INDEX STORES THE THUMB'S IDENTITY, NEVER ITS URL (T2 D03-c).
 *
 * The indexer persisted `chunk_meta.thumb_url` — a URL composed on the media web
 * base of the day the image was indexed. Moving `DEDALO_MEDIA_WEB_BASE` (a
 * split-origin install, a new media host) left every similar-objects /
 * identify / characterize answer pointing at the old address until a re-embed.
 *
 * Now the index stores `chunk_meta.thumb_path` (the media-root-relative path —
 * the identity) and every reader derives the URL at read through ONE helper
 * (`image_source.storedThumbUrl` → `media/path.ts mediaUrlOf`), on TODAY's base.
 * A legacy stored `thumb_url` is IGNORED: a stored derived value is never served.
 * The indexer half (thumb_path written, thumb_url never) is pinned in
 * rag_indexer_images.test.ts and, on the real ingest, rag_multimodal.test.ts.
 *
 * The web-base half runs in FRESH processes: config freezes at first import, so
 * "change the base" is two processes reading the SAME stored meta.
 * RED before: the helper did not exist and every reader served `thumb_url`
 * verbatim (the stale base; a row carrying only the identity had no thumb).
 */

import { describe, expect, test } from 'bun:test';
import { candidateToNeighbour } from '../../src/ai/identify/propose.ts';
import { shapeObject } from '../../src/ai/rag/api.ts';
import { RagCharacterizer } from '../../src/ai/rag/characterizer.ts';
import type { Candidate, RecordLocator } from '../../src/ai/rag/types.ts';
import { config } from '../../src/config/config.ts';
import type { Principal } from '../../src/core/security/permissions.ts';

const REPO_ROOT = `${import.meta.dir}/../..`;
const THUMB_PATH = '/image/thumb/0/test99_test2_1.jpg';
const LEGACY_URL = 'http://old-media.example.test/dedalo/media/image/thumb/0/test99_test2_1.jpg';
/** What the index stores today — plus a legacy key a pre-fix index left behind. */
const STORED_META = { view: 'obverse', thumb_path: THUMB_PATH, thumb_url: LEGACY_URL };
/** A row indexed before the fix: only the frozen URL. */
const LEGACY_META = { view: 'obverse', thumb_url: LEGACY_URL };

/** storedThumbUrl of each meta, in a fresh process on `webBase`. */
function deriveIn(webBase: string, metas: unknown[]): (string | null)[] {
	const probe = Bun.spawnSync(
		[
			'bun',
			'-e',
			[
				'const { storedThumbUrl } = await import("./src/ai/rag/image_source.ts");',
				`const metas = ${JSON.stringify(metas)};`,
				'console.log(JSON.stringify(metas.map((meta) => storedThumbUrl(meta))));',
				'process.exit(0);',
			].join('\n'),
		],
		{ cwd: REPO_ROOT, env: { ...process.env, DEDALO_MEDIA_WEB_BASE: webBase } },
	);
	if (probe.exitCode !== 0) throw new Error(`child failed: ${probe.stderr.toString()}`);
	return JSON.parse(probe.stdout.toString().trim().split('\n').pop() as string);
}

const candidate = (chunkMeta: Record<string, unknown> | null): Candidate => ({
	sectionTipo: 'test2',
	sectionId: 1,
	componentTipo: 'test99',
	lang: 'lg-nolan',
	chunkIndex: 0,
	sourceText: null,
	sourceKind: 'image_visual',
	modality: 'image',
	egressClass: 'public',
	parentKey: null,
	chunkMeta,
	rrfScore: 0.9,
	distance: 0.1,
});

describe('RAG image thumb: identity stored, URL derived at read (T2-D03-c)', () => {
	test('the SAME stored meta follows a moved media web base', () => {
		const metas = [STORED_META, LEGACY_META];
		expect(deriveIn('http://media-a.example.test/m', metas)).toEqual([
			`http://media-a.example.test/m${THUMB_PATH}`,
			null, // the legacy frozen URL is never served
		]);
		expect(deriveIn('https://media-b.example.test', metas)).toEqual([
			`https://media-b.example.test${THUMB_PATH}`,
			null,
		]);
	});

	test('only a plain root-relative identity derives a URL', () => {
		expect(
			deriveIn('http://media-a.example.test/m', [
				{ thumb_path: '//evil.example.test/x.jpg' },
				{ thumb_path: 'image/thumb/x.jpg' },
				{ thumb_path: '/image/../../etc/x.jpg' },
				{ thumb_path: 42 },
				null,
			]),
		).toEqual([null, null, null, null, null]);
	});

	test('every reader serves the derived URL and ignores the legacy key', async () => {
		const derived = `${config.media.webBase}${THUMB_PATH}`;
		// dd_rag_api similar_objects / search_by_text_image
		expect(shapeObject(candidate(STORED_META)).thumb_url).toBe(derived);
		expect(shapeObject(candidate(LEGACY_META)).thumb_url).toBeNull();
		// identify proposals (image neighbours)
		expect(candidateToNeighbour(candidate(STORED_META)).thumbUrl).toBe(derived);
		expect(candidateToNeighbour(candidate(LEGACY_META)).thumbUrl).toBeNull();
		// characterize_object evidence
		const superuser: Principal = { userId: -1, isGlobalAdmin: true, isDeveloper: true };
		const characterizer = new RagCharacterizer({
			config: {
				getCompareScope: async () => ['test2'],
				getContextMetadata: async () => ({ typology: 'test26' }),
			},
			objectRetrieval: {
				findSimilarObjects: async () => [
					candidate(STORED_META),
					{ ...candidate(LEGACY_META), sectionId: 2 },
				],
			},
			roleReader: async () => ({ kind: 'categorical', value: 'denarius' }),
		});
		const result = await characterizer.characterize(superuser, {
			sectionTipo: 'test2',
			sectionId: 9,
		} as RecordLocator);
		const evidence = (
			result.proposals.typology as { evidence: { sectionId: number; thumbUrl: string | null }[] }
		).evidence;
		expect(evidence.map((item) => [item.sectionId, item.thumbUrl])).toEqual([
			[1, derived],
			[2, null],
		]);
	});
});
