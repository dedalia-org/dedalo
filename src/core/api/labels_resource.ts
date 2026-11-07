/**
 * The UI-label dictionary as its own versioned, HTTP-cacheable resource
 * (WC-2026-11-07-labels-separate-resource) — the css_version pattern applied
 * to labels: the environment carries only page_globals.labels_version, and the
 * client fetches the dictionary from here.
 *
 * URL: GET|HEAD /api/v1/labels?lang=<lg-code>&v=<version>
 *      (+ the client-relative twin /dedalo/core/api/v1/labels)
 *
 * PUBLIC (no session): the login page needs labels, and the content is repo
 * data (src/core/labels/). `lang` must be well-formed (isValidLang) or it 404s
 * before any file is read; a well-formed lang outside DEDALO_APPLICATION_LANGS
 * is served the dictionary labelsServingLang picks (the install default) — the
 * same mapping page_globals.labels_version uses, so every lang the environment
 * emits answers 200.
 *
 * Caching: `v` equal to the current version → immutable for a year (the URL
 * changes whenever the dictionary does). `v` absent or stale → `no-cache` +
 * ETag "<version>" (If-None-Match → 304), so a stale URL never pins old text.
 * Body: the plain merged dictionary JSON — a static resource, NOT an envelope.
 */

import { isValidLang } from '../../config/lang_code.ts';
import { toErrorEnvelope } from '../errors/convert.ts';
import { DedaloError } from '../errors/dedalo_error.ts';
import { getLabels, getLabelsVersion, labelsServingLang } from '../labels/catalog.ts';
import { MIN_GZIP_BYTES, SECURITY_HEADERS } from './static_asset.ts';

export const LABELS_PATHS: ReadonlySet<string> = new Set([
	'/api/v1/labels',
	'/dedalo/core/api/v1/labels',
]);

const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';

export async function handleLabelsRequest(
	request: Request,
	url: URL,
	requestId: string = crypto.randomUUID(),
): Promise<Response> {
	const requested = url.searchParams.get('lang');
	if (requested === null || requested === 'all' || !isValidLang(requested)) {
		const converted = toErrorEnvelope(new DedaloError('resource.not_found'), { requestId });
		return new Response(JSON.stringify(converted.body), {
			status: converted.status,
			headers: { 'Content-Type': 'application/json', ...SECURITY_HEADERS },
		});
	}

	const lang = labelsServingLang(requested);
	const version = await getLabelsVersion(lang);
	const etag = `"${version}"`;
	const headers = new Headers({
		...SECURITY_HEADERS,
		'Content-Type': 'application/json; charset=utf-8',
		'Cache-Control': url.searchParams.get('v') === version ? IMMUTABLE_CACHE : 'no-cache',
		ETag: etag,
		Vary: 'Accept-Encoding',
	});
	if (request.headers.get('if-none-match') === etag) {
		return new Response(null, { status: 304, headers });
	}

	const bytes = new TextEncoder().encode(JSON.stringify(await getLabels(lang)));
	const acceptsGzip = (request.headers.get('accept-encoding') ?? '').includes('gzip');
	const body = acceptsGzip && bytes.byteLength > MIN_GZIP_BYTES ? Bun.gzipSync(bytes) : bytes;
	if (body !== bytes) headers.set('Content-Encoding', 'gzip');
	return new Response(request.method === 'HEAD' ? null : (body as BodyInit), { headers });
}
