/**
 * The RAG image source — the two decisions that must never regress silently:
 * which derivative tier may be read, and what makes a stored image vector stale.
 *
 * `extractImageForEmbedding` itself needs a real media tree, so it is covered by
 * the end-to-end ingest test rather than here; what lives here is the pure logic
 * that guards the archival masters and the cache key.
 */
// Migrated to the generic `test` TLD 2026-08-20 (AGENTS.md hard rule). The tipos
// here are OPAQUE IDENTIFIERS — this gate builds and inspects a descriptor, it never
// reads a record — so the migration is a rename.

import { describe, expect, test } from 'bun:test';
import {
	embeddingMediaIdentity,
	IMAGE_HASH_VERSION,
	imageSourceHash,
	qualityIsEmbeddable,
} from '../../src/ai/rag/image_source.ts';
import { endpointIsLocal } from '../../src/ai/rag/multimodal_config.ts';
import { config } from '../../src/config/config.ts';
import { mediaTypeOf } from '../../src/core/concepts/media.ts';
import { mediaThumbLocation, mediaThumbUrl } from '../../src/core/media/path.ts';
import { filterPublicQualities, masterQualities } from '../../src/core/media/protection.ts';

describe('qualityIsEmbeddable', () => {
	const spec = mediaTypeOf('component_image') as NonNullable<ReturnType<typeof mediaTypeOf>>;

	test('refuses the archival master tiers', () => {
		// Shipping these to an embedder means reading a multi-hundred-MB TIFF
		// that must never leave the archive.
		expect(qualityIsEmbeddable(spec, 'original')).toBe(false);
		expect(qualityIsEmbeddable(spec, 'modified')).toBe(false);
		expect(qualityIsEmbeddable(spec, config.media.image.originalQuality)).toBe(false);
		expect(qualityIsEmbeddable(spec, config.media.imageQualityRetouched)).toBe(false);
	});

	test('accepts the derivative tier images are actually served from', () => {
		expect(qualityIsEmbeddable(spec, spec.defaultQuality)).toBe(true);
		expect(qualityIsEmbeddable(spec, config.media.thumb.quality)).toBe(true);
	});

	test('refuses traversal, malformed and off-ladder tier names', () => {
		expect(qualityIsEmbeddable(spec, '../original')).toBe(false);
		expect(qualityIsEmbeddable(spec, '')).toBe(false);
		expect(qualityIsEmbeddable(spec, '1.5MB/../original')).toBe(false);
		expect(qualityIsEmbeddable(spec, 'not_a_tier')).toBe(false);
	});

	test('the master set is shared with the web-serving filter', () => {
		// The point of isMasterQuality(): one definition, so an install that
		// renames its original tier cannot protect one path and not the other.
		for (const master of masterQualities()) {
			expect(qualityIsEmbeddable(spec, master)).toBe(false);
			expect(filterPublicQualities([`image/${master}`])).toEqual([]);
		}
	});
});

describe('embeddingMediaIdentity (which media components are indexable at all)', () => {
	const input = { componentTipo: 'test99', sectionTipo: 'test3', sectionId: 42 };

	test('a plain media component reads its file with no lang suffix', () => {
		expect(embeddingMediaIdentity({ ...input, translatable: false })).toEqual({
			componentTipo: 'test99',
			sectionTipo: 'test3',
			sectionId: 42,
			lang: null,
		});
	});

	test('a TRANSLATABLE media component is refused LOUDLY, naming the component', () => {
		// The bug this pins: lang was hardcoded null, so the identifier lost the
		// `_lg-xxx` suffix a translatable component's files actually carry
		// (path.ts buildMediaIdentifier). No file matched, extraction reported
		// "nothing to embed", and the indexer PRUNED the stored vector — a whole
		// class of media silently unindexed, with not one line of log.
		const errors: string[] = [];
		const original = console.error;
		console.error = (...args: unknown[]) => {
			errors.push(args.map(String).join(' '));
		};
		try {
			expect(embeddingMediaIdentity({ ...input, translatable: true })).toBeNull();
		} finally {
			console.error = original;
		}
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain('test99');
		expect(errors[0]).toContain('TRANSLATABLE');
	});
});

describe('imageSourceHash', () => {
	const bytes = 'a'.repeat(64);

	test('is stable for the same bytes and summary', () => {
		expect(imageSourceHash(bytes, 'period: Roman', null)).toBe(
			imageSourceHash(bytes, 'period: Roman', null),
		);
		expect(imageSourceHash(bytes, '', null)).toHaveLength(64);
	});

	test('changes when the pixels change', () => {
		expect(imageSourceHash(bytes, 'x', null)).not.toBe(imageSourceHash('b'.repeat(64), 'x', null));
	});

	test('changes when the context summary changes', () => {
		// The summary rides the row as source_text, so it is part of what the
		// vector asserts — an edited typology must re-embed.
		expect(imageSourceHash(bytes, 'period: Roman', null)).not.toBe(
			imageSourceHash(bytes, 'period: Iberian', null),
		);
	});

	test('is versioned, so the tag can force a corpus-wide re-embed', () => {
		const tagged = new Bun.CryptoHasher('sha256')
			.update(`${IMAGE_HASH_VERSION}|${bytes}|s|/image/thumb/0/x.jpg`)
			.digest('hex');
		expect(imageSourceHash(bytes, 's', '/image/thumb/0/x.jpg')).toBe(tagged);
	});

	test('changes when the stored thumb identity changes (T2-D03-c)', () => {
		// The row stores chunk_meta.thumb_path, so a thumb generated (or removed)
		// after indexing must refresh the row — and a v1 row (frozen thumb_url)
		// is rewritten by the version bump.
		expect(imageSourceHash(bytes, 's', null)).not.toBe(
			imageSourceHash(bytes, 's', '/image/thumb/0/x.jpg'),
		);
		expect(IMAGE_HASH_VERSION).not.toBe('img_v1');
	});
});

describe('endpointIsLocal (the image egress gate)', () => {
	test('treats loopback and private networks as on-premises', () => {
		for (const endpoint of [
			'http://127.0.0.1:11434/api',
			'http://localhost:8000',
			'http://[::1]:9000',
			'http://10.0.0.5/embed',
			'http://192.168.1.20:8080',
			'http://172.16.4.4/v1',
		]) {
			expect(endpointIsLocal(endpoint)).toBe(true);
		}
		// No endpoint means nothing is transmitted at all.
		expect(endpointIsLocal('')).toBe(true);
	});

	test('treats a hosted vendor as external even when the provider label says local', () => {
		// The label is optional and defaults to 'local', so an operator who sets
		// only the endpoint would otherwise ship every photograph off-site under
		// a local_only policy.
		expect(endpointIsLocal('https://api.some-vendor.com/v1')).toBe(false);
		expect(endpointIsLocal('https://11434.example.net/api')).toBe(false);
	});

	test('fails closed on an unparseable endpoint', () => {
		expect(endpointIsLocal('not a url')).toBe(false);
		expect(endpointIsLocal('127.0.0.1:11434')).toBe(false); // no scheme ⇒ not parseable
	});

	test('is not fooled by a hostname that merely contains a private range', () => {
		expect(endpointIsLocal('https://10.0.0.5.evil.com/api')).toBe(false);
		expect(endpointIsLocal('https://localhost.attacker.net/api')).toBe(false);
	});
});

describe('mediaThumbUrl', () => {
	const identity = {
		componentTipo: 'test88',
		sectionTipo: 'test3',
		sectionId: 1,
		lang: null,
	};
	const options = { initialMediaPath: '', maxItemsFolder: null };

	test('builds from the configured web base and thumb tier, never a literal', () => {
		const spec = mediaTypeOf('component_image');
		const url = mediaThumbUrl(spec as NonNullable<typeof spec>, identity, options);
		expect(url).not.toBeNull();
		expect(url?.startsWith(config.media.webBase)).toBe(true);
		expect(url).toContain(`/${config.media.thumb.quality}/`);
		expect(url?.endsWith(`.${config.media.thumb.extension}`)).toBe(true);
		expect(url).toContain('test88_test3_1');
	});

	test('url and location agree on one resolved path', () => {
		const spec = mediaTypeOf('component_image') as NonNullable<ReturnType<typeof mediaTypeOf>>;
		const location = mediaThumbLocation(spec, identity, options);
		expect(location).not.toBeNull();
		expect(mediaThumbUrl(spec, identity, options)).toBe(
			`${config.media.webBase}${location?.relativePath}`,
		);
	});
});
