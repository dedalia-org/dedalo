/**
 * IMAGE SOURCE — turns one media component of one record into the bytes the
 * multimodal embedder consumes, plus the display metadata the vector row keeps.
 *
 * It is the image twin of `embed_source.ts` (which resolves text), and the only
 * place in the RAG subsystem that touches the media tree. Everything it needs
 * from the media subsystem is borrowed, never reimplemented: the quality ladder
 * (`mediaTypeOf`), the path grammar (`buildMediaLocation` + the ontology-driven
 * `resolveMediaPathOptions`), the downscale recipe (`convertImage`), the thumb
 * URL (`mediaThumbUrl`) and — load-bearing — the master-tier blocklist
 * (`filterPublicQualities`).
 *
 * THREE RULES, each of which has a way of going wrong quietly:
 *
 * 1. NEVER read a master. `original` and `modified` are the archival copies:
 *    multi-hundred-MB TIFFs whose bytes must not be shipped to an embedder, and
 *    whose loss is unrecoverable. The forbidden set is not hardcoded here —
 *    installs rename their tiers — it is the same set the web-serving filter
 *    enforces, so the two can never drift apart.
 * 2. The temp file is UNIQUE per call. A deterministic name collides when a
 *    queue drain and a backfill process the same record concurrently: both
 *    write the same path, one unlinks it, the other embeds a truncated file and
 *    stores the resulting garbage vector under a valid-looking hash.
 * 3. The hash covers the ENCODER bytes, not the source file. What the embedder
 *    saw is what determines whether the vector is stale, so changing the
 *    downscale cap must invalidate the cache.
 *
 * Every failure returns null. A missing derivative, an unreadable file, a dead
 * ImageMagick — none of them may fail the record's indexing pass; the image is
 * simply not indexed this time round.
 *
 * But a null that is MISCONFIGURATION is logged as an error naming the component
 * first (a master-only default tier, a non-image tipo in the descriptor, a
 * translatable media component — see embeddingMediaIdentity). The caller cannot
 * tell those from bad luck, and it PRUNES the stored vector either way, so a
 * silent null would be a feature quietly switching itself off.
 */

import { existsSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../../config/config.ts';
import { assertValidQuality, type MediaTypeSpec, mediaTypeOf } from '../../core/concepts/media.ts';
import {
	backgroundForTarget,
	convertImage,
	getDimensions,
} from '../../core/media/engine/imagemagick.ts';
import { resolveMediaPathOptions } from '../../core/media/ontology_path.ts';
import {
	buildMediaLocation,
	type MediaIdentity,
	type MediaPathOptions,
	mediaThumbLocation,
	mediaUrlOf,
} from '../../core/media/path.ts';
import { isMasterQuality } from '../../core/media/protection.ts';
import {
	getMatrixTableFromTipo,
	getModelByTipo,
	getTranslatableByTipo,
} from '../../core/ontology/resolver.ts';
import { runWithRequestLangs } from '../../core/resolve/request_lang.ts';
import { runWithRequestContext } from '../../core/security/request_context.ts';
import { readComponentText } from './component_text.ts';
import { RAG_SYSTEM_PRINCIPAL } from './embed_source.ts';

/**
 * The version tag mixed into every image hash — bump to force a re-embed.
 * img_v2 (T2-D03-c): the thumb IDENTITY joined the key, and a v1 row stored the
 * thumb as a frozen URL (`chunk_meta.thumb_url`, now ignored) — the bump makes
 * the next index pass rewrite every v1 row with its `thumb_path`.
 */
export const IMAGE_HASH_VERSION = 'img_v2';

/** One media component of one record, ready to embed. */
export interface ExtractedImage {
	/** Base64 of the encoder bytes (no `data:` prefix). */
	base64: string;
	/** The derivative tier the bytes came from. */
	quality: string;
	/**
	 * The thumb's media-root-relative path (its IDENTITY — what the index
	 * stores, `chunk_meta.thumb_path`), or null when no thumb exists on disk.
	 */
	thumbPath: string | null;
	/** Thumb URL for live rendering (derived from `thumbPath` on today's base), or null. */
	thumbUrl: string | null;
	/** Dimensions of the STORED derivative (display metadata, not the encoder input). */
	width: number | null;
	height: number | null;
	/** Content hash of the encoder bytes — the staleness key. */
	bytesHash: string;
}

/**
 * Whether a quality tier may be read for embedding: a real tier of this media
 * type, and not an archival master. The master set comes from the media
 * subsystem (`isMasterQuality`), the same one the web-serving filter enforces,
 * so an install that renames its tiers cannot leave one of the two behind.
 * `assertValidQuality` supplies the charset/traversal/ladder-membership half —
 * it throws, so it is answered as a boolean here.
 */
export function qualityIsEmbeddable(spec: MediaTypeSpec, quality: string): boolean {
	if (isMasterQuality(quality)) return false;
	try {
		assertValidQuality(spec, quality);
		return true;
	} catch {
		return false;
	}
}

/**
 * First extension of the tier that actually exists on disk. Installs store a
 * tier as jpg, webp or avif depending on when it was generated, so trying only
 * the type's default extension silently yields "no image" for a whole corpus.
 */
function resolveExistingSource(
	spec: MediaTypeSpec,
	identity: MediaIdentity,
	quality: string,
	options: MediaPathOptions,
): string | null {
	// The MANAGED list, not the built one: this asks "which file is on disk", and
	// an install may hold formats the current config does not build — a v6 legacy
	// twin, a configured-but-refused extension, a pdf cover. Default extension
	// first, so a tier holding both jpg and avif still answers with the jpg.
	const extensions = spec.managedExtensions;
	const seen = new Set<string>();
	for (const extension of extensions) {
		if (extension === '' || seen.has(extension)) continue;
		seen.add(extension);
		const location = buildMediaLocation(spec, identity, quality, extension, options);
		if (existsSync(location.absolutePath)) return location.absolutePath;
	}
	return null;
}

/**
 * The MediaIdentity to read one component's file with, or null when this
 * component cannot be embedded at all.
 *
 * TRANSLATABLE MEDIA ARE REFUSED, LOUDLY, AND ON PURPOSE. A translatable media
 * component stores ONE FILE PER LANGUAGE, and the identifier carries the lang
 * suffix that says which (`path.ts` buildMediaIdentifier: `…_lg-eng`). The
 * indexer's vector row, however, is keyed one-per-component with lang = the
 * no-lang code ("an image has no language"), so there is no honest way to store
 * the several files this component holds: picking one language's file would
 * index an arbitrary subset of the corpus and call it the record's image.
 *
 * Until the image row is lang-keyed, this refuses instead — and SAYS SO. The
 * bug this replaces was the silent version: `lang: null` built an identifier
 * with no suffix, no such file existed, extraction returned "nothing to embed",
 * and the indexer dutifully PRUNED the component's stored vector. A whole class
 * of media went unindexed with not one line of log to explain it.
 */
export function embeddingMediaIdentity(input: {
	componentTipo: string;
	sectionTipo: string;
	sectionId: number;
	translatable: boolean;
}): MediaIdentity | null {
	if (input.translatable) {
		console.error(
			`[rag_image] '${input.componentTipo}' is a TRANSLATABLE media component (one file per lang); image indexing stores one vector per component and cannot represent that — not indexed. Remove it from properties.rag.context.images, or make the component non-translatable.`,
		);
		return null;
	}
	return {
		componentTipo: input.componentTipo,
		sectionTipo: input.sectionTipo,
		sectionId: input.sectionId,
		lang: null,
	};
}

/** A collision-free scratch target for one downscale. */
function scratchTarget(): string {
	return join(tmpdir(), `dedalo_rag_embed_${crypto.randomUUID()}.jpg`);
}

/**
 * Downscale into scratch when the derivative is larger than the encoder needs,
 * else return the source path unchanged. Returns `{path, isTemp}` so the caller
 * knows what to clean up; a convert failure degrades to the full-size source
 * rather than dropping the image.
 */
async function boundedEncoderInput(
	source: string,
	quality: string,
	maxPx: number,
	dimensions: { width: number; height: number } | null,
): Promise<{ path: string; isTemp: boolean }> {
	if (maxPx < 1) return { path: source, isTemp: false };
	if (dimensions !== null && dimensions.width <= maxPx && dimensions.height <= maxPx) {
		return { path: source, isTemp: false };
	}
	const target = scratchTarget();
	try {
		// thumbBox overrides the tier's pixel-area budget with a plain WxH box,
		// shrink-only — exactly the longest-side cap an image encoder wants.
		await convertImage(source, target, {
			quality,
			// The source is a DERIVATIVE tier (qualityIsEmbeddable refuses a master
			// tier), so it was itself produced by a collapsing recipe and holds one
			// image — `representative` is `[0]` on a single-image source, i.e. a no-op
			// that also stays correct if a stray sequence ever reaches this path.
			selection: 'representative',
			// scratchTarget() is always '.jpg', which cannot carry alpha; deriving the
			// value keeps the two facts from drifting apart.
			background: backgroundForTarget(target),
			thumbBox: { width: maxPx, height: maxPx },
			compression: 90,
		});
	} catch (error) {
		// ImageMagick can fail AFTER writing a partial file (resource limit,
		// malformed source), so the scratch target must be cleaned here too —
		// otherwise a class of bad derivatives leaks one temp file per record
		// per drain, forever.
		await unlink(target).catch(() => {});
		console.warn(`[rag_image] downscale failed, embedding full size: ${String(error)}`);
		return { path: source, isTemp: false };
	}
	return existsSync(target) ? { path: target, isTemp: true } : { path: source, isTemp: false };
}

/**
 * Read one media component of one record as embeddable bytes. Returns null when
 * there is nothing to embed — no media model, a master-only tier, no derivative
 * on disk, or an unreadable file.
 */
export async function extractImageForEmbedding(input: {
	componentTipo: string;
	sectionTipo: string;
	sectionId: number;
	maxPx: number;
}): Promise<ExtractedImage | null> {
	const { componentTipo, sectionTipo, sectionId, maxPx } = input;
	try {
		const model = await getModelByTipo(componentTipo);
		if (model === null) return null;
		const spec = mediaTypeOf(model);
		if (spec === null) return null;
		if (spec.model !== 'component_image') {
			// `properties.rag.context.images` is hand-authored JSON with no schema
			// behind it. Every media type resolves through mediaTypeOf, so an AV or
			// PDF tipo listed there would send the engine to read that type's
			// default tier — a whole video — into memory and base64 it to an image
			// embedder. Refuse by NAME rather than trusting the descriptor.
			console.error(
				`[rag_image] '${componentTipo}' is ${spec.model}, not an image component — check properties.rag.context.images`,
			);
			return null;
		}

		const quality = spec.defaultQuality;
		if (!qualityIsEmbeddable(spec, quality)) {
			// Misconfiguration, not bad luck: this install's default derivative IS
			// a master tier, so every read here would ship an archival file.
			console.error(
				`[rag_image] refusing to embed from master tier '${quality}' (${componentTipo})`,
			);
			return null;
		}

		const identity = embeddingMediaIdentity({
			componentTipo,
			sectionTipo,
			sectionId,
			translatable: await getTranslatableByTipo(componentTipo),
		});
		if (identity === null) return null;
		// Record-scoped: the thumb of an image naming its files by properties.image_id
		// is `<stem>.jpg`, not the identifier (T1-10).
		const pathOptions = await resolveMediaPathOptions(componentTipo, sectionTipo, sectionId);
		const source = resolveExistingSource(spec, identity, quality, pathOptions);
		if (source === null) return null;

		// Dimensions describe the STORED derivative — they are display metadata,
		// deliberately not the (possibly downscaled) encoder input.
		let dimensions: { width: number; height: number } | null = null;
		try {
			dimensions = await getDimensions(source);
		} catch {
			dimensions = null;
		}

		const encoder = await boundedEncoderInput(source, quality, maxPx, dimensions);
		try {
			const bytes = new Uint8Array(await Bun.file(encoder.path).arrayBuffer());
			if (bytes.byteLength === 0) return null;

			// Only store a thumb URL that resolves TODAY — a URL to an ungenerated
			// thumb renders as a broken image in every result list.
			const thumbLocation = mediaThumbLocation(spec, identity, pathOptions);
			const thumbPath =
				thumbLocation !== null && existsSync(thumbLocation.absolutePath)
					? thumbLocation.relativePath
					: null;

			return {
				base64: Buffer.from(bytes).toString('base64'),
				quality,
				thumbPath,
				thumbUrl: thumbPath === null ? null : mediaUrlOf(thumbPath),
				width: dimensions?.width ?? null,
				height: dimensions?.height ?? null,
				bytesHash: new Bun.CryptoHasher('sha256').update(bytes).digest('hex'),
			};
		} finally {
			if (encoder.isTemp) await unlink(encoder.path).catch(() => {});
		}
	} catch (error) {
		console.warn(`[rag_image] extraction failed for ${sectionTipo}/${sectionId}: ${String(error)}`);
		return null;
	}
}

/**
 * The thumb URL of a STORED image vector (T2-D03-c): derived at read from the
 * identity the index stores — `chunk_meta.thumb_path`, the media-root-relative
 * path — on TODAY's media web base, so a moved `DEDALO_MEDIA_WEB_BASE` is
 * followed without re-indexing. A legacy `chunk_meta.thumb_url` (a URL frozen
 * on the base of the day it was indexed) is IGNORED: a stored derived value is
 * never served. Null for a row with no thumb identity, or a path that is not a
 * plain root-relative one.
 */
export function storedThumbUrl(meta: Record<string, unknown> | null | undefined): string | null {
	const path = meta?.thumb_path;
	if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) return null;
	if (path.includes('\\') || path.split('/').includes('..')) return null;
	return mediaUrlOf(path);
}

/**
 * The staleness key of an image vector: the encoder bytes, the context summary
 * that rides with them as `source_text`, and the thumb identity the row stores
 * (`chunk_meta.thumb_path`, null when no thumb existed). Editing a typology or
 * period therefore re-embeds the image — correct, because the summary is part
 * of what the row asserts, even though the pixels did not change — and so does
 * a thumb generated (or removed) after the row was written, which would
 * otherwise never reach it.
 */
export function imageSourceHash(
	bytesHash: string,
	contextSummary: string,
	thumbPath: string | null,
): string {
	return new Bun.CryptoHasher('sha256')
		.update(`${IMAGE_HASH_VERSION}|${bytesHash}|${contextSummary}|${thumbPath ?? ''}`)
		.digest('hex');
}

/** Separator between context-summary parts — readable, and rare in real values. */
const SUMMARY_SEPARATOR = ' · ';

/**
 * A short textual description of the object the image depicts, built from the
 * section's declared metadata roles: `typology: Amphora · period: Roman`.
 *
 * It is the image row's `source_text`, which makes it the ONLY thing the hybrid
 * search's lexical leg can match on an image vector — without it, "hybrid" mode
 * silently degrades to visual-only. It is also mixed into the source hash, so a
 * corrected typology re-embeds the image.
 *
 * COHERENCE: resolved under the frozen RAG system principal and an EXPLICIT
 * data lang, exactly like the text path. A vector is a property of the record,
 * never of whoever happened to trigger indexing — reading it as the saver would
 * bake that user's visibility into a shared artifact.
 */
export async function buildImageContextSummary(input: {
	sectionTipo: string;
	sectionId: number;
	metadata: Record<string, string>;
	dataLang: string;
}): Promise<string> {
	const roles = Object.entries(input.metadata);
	if (roles.length === 0) return '';

	return runWithRequestContext(
		{
			principal: RAG_SYSTEM_PRINCIPAL,
			session: null,
			requestId: `rag-image-${input.sectionTipo}-${input.sectionId}`,
			clientIp: '',
		},
		() =>
			runWithRequestLangs(
				{ applicationLang: config.menu.applicationLang, dataLang: input.dataLang },
				async () => {
					const matrixTable = (await getMatrixTableFromTipo(input.sectionTipo)) ?? 'matrix';
					const parts: string[] = [];
					for (const [role, componentTipo] of roles) {
						try {
							const model = await getModelByTipo(componentTipo);
							if (model === null) continue;
							const text = await readComponentText({
								matrixTable,
								componentTipo,
								model,
								sectionTipo: input.sectionTipo,
								sectionId: input.sectionId,
								lang: input.dataLang,
							});
							// Only genuinely empty values are dropped: a metadata value of
							// "0" is a real value (a count, a year, a rank) and is kept.
							const value = text.trim();
							if (value !== '') parts.push(`${role}: ${value}`);
						} catch {
							// One unreadable role must not cost the record its summary.
						}
					}
					return parts.join(SUMMARY_SEPARATOR);
				},
			),
	);
}
