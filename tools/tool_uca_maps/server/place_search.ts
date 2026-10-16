/**
 * search_places: a server-side proxy for the Nominatim search v6 ran from the
 * browser (`leaflet-control-geocoder`). The page CSP (`connect-src 'self'`)
 * makes a browser-side geocoder fail on every search, silently, so the library
 * is not vendored. The host is fixed; Nominatim's policy wants a User-Agent.
 */

import { DedaloError, ok } from '../../../src/core/errors/index.ts';
import { fetchGuardedText } from '../../../src/core/security/ssrf_guard.ts';
import {
	type ToolActionContext,
	type ToolResponse,
	toolRequestId,
} from '../../../src/core/tools/module.ts';

const NOMINATIM_SEARCH = 'https://nominatim.openstreetmap.org/search';

/** v6's own result count for the same control (`leaflet-control-geocoder` default). */
const RESULT_LIMIT = 8;

const USER_AGENT = 'Dedalo/7 (tool_uca_maps place search)';

/**
 * Dédalo lang code → the ISO 639-1 tag of Nominatim's `Accept-Language`, so
 * the result names come back in the record's language. An unmapped lang sends
 * no header and gets Nominatim's default naming rather than a guessed tag.
 */
const LANG_ISO: Readonly<Record<string, string>> = Object.freeze({
	'lg-eng': 'en',
	'lg-spa': 'es',
	'lg-cat': 'ca',
	'lg-eus': 'eu',
	'lg-fra': 'fr',
	'lg-por': 'pt',
	'lg-deu': 'de',
	'lg-ita': 'it',
	'lg-ell': 'el',
	'lg-nep': 'ne',
});

/** A caller fault — empty or over-long search text. */
function invalidSearchRequest(message: string): DedaloError {
	return new DedaloError('request.invalid_options', { message, publicMessage: message });
}

/** One search hit, already reduced to what the map needs. */
export interface PlaceResult {
	/** Nominatim's own `display_name` — shown verbatim in the result list. */
	name: string;
	/** [lat, lon] of the hit, for the marker-less `setView` fallback. */
	point: [number, number];
	/** [south, west, north, east] — Leaflet `fitBounds` order, or null. */
	bbox: [number, number, number, number] | null;
}

/** The Nominatim query for already vetted search text; exported for unit coverage. */
export function placeSearchUrl(query: string): URL {
	const url = new URL(NOMINATIM_SEARCH);
	url.searchParams.set('q', query);
	url.searchParams.set('format', 'jsonv2');
	url.searchParams.set('limit', String(RESULT_LIMIT));
	url.searchParams.set('addressdetails', '0');
	return url;
}

/**
 * The service answered, but not with something usable: an outbound failure,
 * never `request.invalid_options`, which would tell the user their input was
 * wrong and leave a third-party outage unclassified in the log.
 */
function outboundFailure(message: string): DedaloError {
	return new DedaloError('security.outbound_failed', { message });
}

/**
 * Nominatim's JSON array → `PlaceResult[]`, in its relevance order. A hit with
 * no usable coordinates is dropped: a result row that cannot move the map is
 * worse than none. Pure, exported for unit coverage.
 */
export function parsePlaceResults(text: string): PlaceResult[] {
	let payload: unknown;
	try {
		payload = JSON.parse(text);
	} catch {
		throw outboundFailure('The place-search service returned an unreadable response.');
	}
	// A refusal is not zero results: Nominatim answers a rejected or rate-limited
	// request with HTTP 200 and a JSON object (`{"error": …}`). Read as [], the
	// user would be told the toponym does not exist during an outage.
	if (!Array.isArray(payload)) {
		throw outboundFailure('The place-search service refused the request.');
	}

	const results: PlaceResult[] = [];
	for (const raw of payload) {
		if (typeof raw !== 'object' || raw === null) {
			continue;
		}
		const hit = raw as Record<string, unknown>;
		const lat = Number(hit.lat);
		const lon = Number(hit.lon);
		if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
			continue;
		}
		const name = typeof hit.display_name === 'string' ? hit.display_name.trim() : '';
		results.push({
			name: name || `${lat}, ${lon}`,
			point: [lat, lon],
			bbox: parseBoundingBox(hit.boundingbox),
		});
	}
	return results;
}

/** Nominatim `boundingbox` (4 numeric strings, S/N/W/E) → Leaflet `fitBounds`
 * S/W/N/E, reordered once here so the client never re-derives it. */
function parseBoundingBox(raw: unknown): [number, number, number, number] | null {
	if (!Array.isArray(raw) || raw.length < 4) {
		return null;
	}
	const [south, north, west, east] = raw.slice(0, 4).map((value) => Number(value));
	if (
		south === undefined ||
		north === undefined ||
		west === undefined ||
		east === undefined ||
		!Number.isFinite(south) ||
		!Number.isFinite(north) ||
		!Number.isFinite(west) ||
		!Number.isFinite(east)
	) {
		return null;
	}
	return [south, west, north, east];
}

export async function searchPlaces(ctx: ToolActionContext): Promise<ToolResponse> {
	const query = String(ctx.options.query ?? '').trim();
	if (!query) {
		throw invalidSearchRequest('The search text is required.');
	}
	// a URL query param, not a database key — the cap is about not shipping an
	// unbounded string to a third party, nothing more
	if (query.length > 200) {
		throw invalidSearchRequest('The search text is too long.');
	}

	const iso = LANG_ISO[String(ctx.options.lang ?? '')];
	const headers: Record<string, string> = { 'User-Agent': USER_AGENT };
	if (iso) {
		headers['Accept-Language'] = iso;
	}

	const text = await fetchGuardedText(placeSearchUrl(query).toString(), {
		maxBytes: 1024 * 1024,
		init: { headers },
	});

	return ok({ results: parsePlaceResults(text) }, { requestId: toolRequestId(ctx) });
}
