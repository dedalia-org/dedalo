/**
 * search_places — hito 15, fila #1 ("Buscador de lugares") de
 * `docs/Funcionalidades de tool_leaflet_special_tools.md`: server-side proxy
 * for the OSM/Nominatim toponym search the v6 tool did straight from the
 * browser (`leaflet-control-geocoder`, `render_tool_leaflet_special_tools.js:328`).
 *
 * WHY THIS NEEDS THE SERVER, and why the v6 library is NOT vendored: this
 * app serves `connect-src 'self' blob:` (src/core/api/static_asset.ts
 * APP_CSP). A geocoder library that XHRs `nominatim.openstreetmap.org` from
 * the page is structurally unable to work here — it would fail on every
 * search, silently, exactly the way v6's `try/catch` around the control
 * already fails silently (audit bug #3). The proxy is the same shape the
 * rest of this tool already uses for third-party map services (wms.ts,
 * catastro.ts, administrative_units.ts): one outbound door, guarded.
 *
 * The host is a FIXED literal this file builds itself — the client supplies
 * only the search text and a language — so there is no user-chosen address
 * here (unlike wms.ts). `fetchGuardedText` still carries the transport
 * guarantees (no redirects, timeout, byte cap).
 *
 * Nominatim's usage policy requires an identifying User-Agent, so this
 * handler sends one; the per-second cap is respected in practice because one
 * request costs one deliberate click on the panel's Search button.
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
 * Dédalo lang code → the ISO 639-1 tag Nominatim's `Accept-Language` wants.
 * Only the installer's own catalog (src/core/install/lang_catalog.ts) is
 * mapped; anything else sends no header at all and gets Nominatim's default
 * naming, which is better than guessing a tag and getting silence back.
 *
 * This is what closes audit gap #6 ("la única funcionalidad cuyo texto no
 * pasa por el sistema de traducción"): the panel's own chrome comes from the
 * tool's labels, and the RESULT names come back in the record's language.
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

/**
 * Builds the query URL. EXPORTED for direct unit coverage (no network needed
 * for this half).
 *
 * @param query - the user's search text, already trimmed+length-checked
 * @returns the Nominatim search URL
 */
export function placeSearchUrl(query: string): URL {
	const url = new URL(NOMINATIM_SEARCH);
	url.searchParams.set('q', query);
	url.searchParams.set('format', 'jsonv2');
	url.searchParams.set('limit', String(RESULT_LIMIT));
	url.searchParams.set('addressdetails', '0');
	return url;
}

/**
 * The service answered, but not with something usable. `security.outbound_failed`
 * (503, retryable, operator disclosure) is the class the sibling proxy already
 * uses for the same situation (administrative_units.ts) — NOT a caller fault:
 * `request.invalid_options` would tell the user their input was wrong and leave
 * a third-party outage unclassified in the log.
 */
function outboundFailure(message: string): DedaloError {
	return new DedaloError('security.outbound_failed', { message });
}

/**
 * Reduces Nominatim's JSON array to `PlaceResult[]`. A hit with no usable
 * coordinates is DROPPED rather than returned half-built — the result list is
 * clickable, and a row that cannot move the map is worse than no row.
 *
 * Nominatim's `boundingbox` is [south, north, west, east]; Leaflet's
 * `fitBounds` wants [[south, west], [north, east]]. Reordering here, once,
 * keeps the client from re-deriving the same permutation.
 *
 * PURE — exported for unit coverage with a hand-written fixture, never a
 * live third-party server.
 *
 * @param text - the raw response body
 * @returns the parsed hits, in Nominatim's own relevance order
 */
export function parsePlaceResults(text: string): PlaceResult[] {
	let payload: unknown;
	try {
		payload = JSON.parse(text);
	} catch {
		throw outboundFailure('The place-search service returned an unreadable response.');
	}
	// A REFUSAL IS NOT ZERO RESULTS. Nominatim answers a rejected, rate-limited
	// or blocked request with HTTP 200 and a JSON OBJECT (`{"error": …}`), which
	// `fetchGuardedText` cannot catch. Returning [] here would print "No places
	// found." — the user reads "this toponym does not exist" for what is a
	// service outage, which is audit bug #3 (the mute failure) rebuilt one layer
	// down. Zero hits is `[]`, and only `[]`.
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

/** Nominatim `boundingbox` (4 numeric strings, S/N/W/E) → Leaflet S/W/N/E. */
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
