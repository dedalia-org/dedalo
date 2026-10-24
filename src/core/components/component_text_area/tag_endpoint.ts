/**
 * TEXT_AREA TAG ENDPOINT — GET /…/core/component_text_area/tag/?id=<tag>
 *
 * The copied client emits one <img src=".../tag/?id=[TAG]"> per inline tag; this
 * handler answers those requests (PHP core/component_text_area/tag/index.php).
 *
 * Two response classes:
 *   1. DETERMINISTIC BADGES (tc/index/geo/page/person/note/lang/draw) — the badge
 *      is a pure function of the `?id=` string AND of the renderer, so we render a
 *      tiny SVG and serve it PUBLIC, immutable only when the caller pinned the
 *      renderer in the URL (`&v=<fingerprint>`; bare `?id=` revalidates). That,
 *      plus the browser's automatic de-dup of identical ids, is what makes a
 *      text_area with hundreds of tags cost ~0 network in steady state — while a
 *      renderer change still reaches browsers that already cached a badge.
 *      No session needed: the badge only ever shows the
 *      number/label already present in the id the client itself supplied — nothing
 *      from the database.
 *   2. LOCATOR TAGS (`{…}` JSON / the `svg` tag, whose src IS the JSON payload) —
 *      these reference a real component's media file (usually an SVG drawing). We
 *      resolve the file's media URL and 302-REDIRECT to it so media-protection
 *      stays the single enforcement point (the /dedalo/<media>/ route + the
 *      reverse proxy). ACL: a valid session is required; anything unresolved is a
 *      fail-closed 404 that never reveals whether the record/file exists (spec §7).
 */

import { config } from '../../../config/config.ts';
import { mediaTypeOf } from '../../concepts/media.ts';
import { isValidTipo } from '../../concepts/ontology.ts';
import { DedaloError, toErrorEnvelope } from '../../errors/index.ts';
import { resolveMediaPathOptions } from '../../media/ontology_path.ts';
import { buildMediaLocation } from '../../media/path.ts';
import { getModelByTipo } from '../../ontology/resolver.ts';
import { getSession, SESSION_COOKIE } from '../../security/session_store.ts';
import { type LocatorTag, parseTagId, safeDecodeTagId } from './tag_grammar.ts';
import { renderDrawTag, renderSpriteTag } from './tag_render.ts';

/**
 * One year, no revalidation — ONLY for a VERSION-ADDRESSED badge URL, i.e. one
 * carrying the client's renderer token (`&v=<fingerprint>`, built in
 * client/dedalo/core/common/js/tr.js and pinned by
 * test/unit/text_area_tag_grammar.test.ts). Such a URL changes whenever the
 * drawing changes, so promising immutability is TRUE for it.
 */
const VERSIONED_CACHE = 'public, max-age=31536000, immutable';
/**
 * Version-FREE badge URL (stored `<img src>` HTML, list/diffusion emit, any
 * legacy client): the bytes are a function of the id AND of `tag_render.ts`,
 * which does change — WC-2026-08-11-vector-tag-badges replaced every drawing.
 * `immutable` there is a lie that pins the OLD badge in every warm browser for
 * a year, so these responses stay short-lived and revalidating; the ETag is
 * content-hashed, so a revalidation costs one 304 (~3ms).
 */
const REVALIDATE_CACHE = 'public, max-age=3600, must-revalidate';
/** PHP parity for the live/locator responses (3 hours, private). */
const PRIVATE_CACHE = 'private, max-age=10800';
/** Query param carrying the client's badge-renderer fingerprint (cache key only). */
const VERSION_PARAM = 'v';

/**
 * Longest `?id=` the endpoint parses (UTF-16 units, after URL-decoding). A real
 * tag — even a `-data:…:data` draw tag or a locator JSON — is well under 1 KB;
 * the cap is only there so an unauthenticated caller cannot hand the parser an
 * arbitrarily long string (CodeQL #7958: the tag strip was O(n²) on `<<<…`).
 * Over it ⇒ `request.invalid` (400), refused BEFORE any decode or regex runs.
 * Wire: WC-2026-10-25-tag-id-length-cap.
 */
export const MAX_TAG_ID_LENGTH = 4096;

/** A converter-made failure response for this static route. */
function errorResponse(error: DedaloError): Response {
	// Converter-made body (ERRORS_SPEC §4): this is a STATIC route, so it never
	// entered the dispatch chokepoint and has no correlation id to reuse — the
	// envelope gets a fresh one rather than a fake constant.
	const { status, body } = toErrorEnvelope(error, { requestId: crypto.randomUUID() });
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	});
}

/** Fail-closed 404 — generic, no existence leak. */
function notFound(): Response {
	return errorResponse(new DedaloError('resource.not_found'));
}

/**
 * Serve a rendered SVG badge with a content-hashed ETag (honours If-None-Match).
 * Caching depends on whether the URL is version-addressed: `&v=<fingerprint>`
 * ⇒ immutable for a year, bare `?id=` ⇒ short-lived + revalidating.
 */
function svgResponse(svg: string, request: Request, versioned: boolean): Response {
	const etag = `"${Bun.hash(svg).toString(16)}"`;
	const cacheControl = versioned ? VERSIONED_CACHE : REVALIDATE_CACHE;
	if (request.headers.get('if-none-match') === etag) {
		return new Response(null, {
			status: 304,
			headers: { ETag: etag, 'Cache-Control': cacheControl },
		});
	}
	return new Response(svg, {
		status: 200,
		headers: {
			'Content-Type': 'image/svg+xml; charset=utf-8',
			'Cache-Control': cacheControl,
			ETag: etag,
		},
	});
}

/** True when the caller has a valid TS session (locator branch ACL gate). */
function hasValidSession(request: Request): boolean {
	const cookieHeader = request.headers.get('cookie') ?? '';
	const token = cookieHeader
		.split(';')
		.map((pair) => pair.trim())
		.find((pair) => pair.startsWith(`${SESSION_COOKIE}=`))
		?.slice(SESSION_COOKIE.length + 1);
	return token !== undefined && getSession(token) !== null;
}

/**
 * Resolve a locator tag to its component media file URL and 302-redirect.
 * Fail-closed 404 on any miss (unauthenticated, invalid tipo, non-media model,
 * path build failure) — never distinguishes "no access" from "does not exist".
 */
async function resolveLocatorTag(tag: LocatorTag, request: Request): Promise<Response> {
	// ACL: authenticated only. The redirect target enforces media-protection again.
	if (!hasValidSession(request)) return notFound();

	// §7.6 identifier gate before any ontology/path work.
	if (!isValidTipo(tag.section_tipo) || !isValidTipo(tag.component_tipo)) return notFound();
	const sectionId = Number(tag.section_id);
	if (!Number.isInteger(sectionId) || sectionId <= 0) return notFound();

	try {
		const model = await getModelByTipo(tag.component_tipo);
		const spec = model !== null ? mediaTypeOf(model) : null;
		if (spec === null) return notFound(); // not a resolvable media component

		const pathOptions = await resolveMediaPathOptions(tag.component_tipo, tag.section_tipo);
		const location = buildMediaLocation(
			spec,
			{
				componentTipo: tag.component_tipo,
				sectionTipo: tag.section_tipo,
				sectionId,
				lang: null, // media locator files (svg/image) are non-translatable (PHP DEDALO_DATA_NOLAN)
			},
			spec.defaultQuality,
			spec.defaultExtension,
			pathOptions,
		);
		// Media web base: the redirect target is fetched by the BROWSER, so it must
		// point at wherever media is actually served (split-origin dev included).
		const mediaUrl = `${config.media.webBase}${location.relativePath}`;
		return new Response(null, {
			status: 302,
			headers: { Location: mediaUrl, 'Cache-Control': PRIVATE_CACHE },
		});
	} catch {
		return notFound();
	}
}

/**
 * Handle a tag request. `server.ts` routes by path + method; all parsing,
 * rendering, and authorization live here.
 */
export async function handleTagRequest(request: Request, url: URL): Promise<Response> {
	const rawId = url.searchParams.get('id');
	if (rawId === null || rawId === '') return notFound();
	if (rawId.length > MAX_TAG_ID_LENGTH) {
		return errorResponse(
			new DedaloError('request.invalid', {
				publicMessage: `Tag id longer than ${MAX_TAG_ID_LENGTH} characters`,
				coordinates: { route: 'component_text_area/tag', id_length: rawId.length },
			}),
		);
	}

	// SEC-027 JSON-aware xss decode, then classify.
	const parsed = parseTagId(safeDecodeTagId(rawId));
	// The token's VALUE is never trusted or matched — its presence only says the
	// caller built a version-addressed URL, which is what makes `immutable` true.
	const versioned = (url.searchParams.get(VERSION_PARAM) ?? '') !== '';

	switch (parsed.kind) {
		case 'sprite':
			return svgResponse(renderSpriteTag(parsed), request, versioned);
		case 'draw':
			return svgResponse(renderDrawTag(parsed), request, versioned);
		case 'locator':
			return resolveLocatorTag(parsed, request);
		default:
			return notFound();
	}
}
