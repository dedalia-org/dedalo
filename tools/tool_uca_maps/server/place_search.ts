/**
 * search_places: the Nominatim search v6 ran from the browser
 * (`leaflet-control-geocoder`), asked through core's `nominatim_search`, which
 * keeps the policy's pacing, cache and User-Agent. The page CSP (`connect-src
 * 'self'`) makes a browser-side geocoder fail on every search, silently.
 */

import { ok } from '../../../src/core/errors/index.ts';
import { getAlpha2FromCode } from '../../../src/core/resolve/lang_names.ts';
import {
	type ToolActionContext,
	type ToolResponse,
	toolRequestId,
} from '../../../src/core/tools/module.ts';
import { askGeoService, geoData, geoParamAccepts } from './geo_call.ts';
import { invalidOptions, sourceUnavailable } from './reasons.ts';

/** v6's own result count for the same control (`leaflet-control-geocoder` default). */
const RESULT_LIMIT = 8;

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
 * Nominatim's JSON array → `PlaceResult[]`, in its relevance order. A hit with
 * no usable coordinates is dropped: a result row that cannot move the map is
 * worse than none. Pure, exported for unit coverage.
 */
export function parsePlaceResults(payload: unknown): PlaceResult[] {
	// A refusal is not zero results: Nominatim answers a rejected or rate-limited
	// request with HTTP 200 and a JSON object (`{"error": …}`). Read as [], the
	// user would be told the toponym does not exist during an outage. Core's
	// shape check refuses it first; this one keeps the parser honest on its own.
	if (!Array.isArray(payload)) {
		throw sourceUnavailable(
			'The place-search service refused the request.',
			'place_search_unavailable',
		);
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
		throw invalidOptions('The search text is required.', 'search_text_required');
	}
	// Nominatim's policy forbids as-you-type search: core's service takes three
	// characters at least, and this says so in the user's words
	if (query.length < 3) {
		throw invalidOptions('The search text is too short.', 'search_text_too_short');
	}
	// a URL query param, not a database key — the cap is about not shipping an
	// unbounded string to a third party, nothing more
	if (query.length > 200) {
		throw invalidOptions('The search text is too long.', 'search_text_too_long');
	}
	// what else core's grammar refuses (a control or bidi character) would come
	// back as a reasonless request.invalid_data: refused here, by core's own rule
	if (!geoParamAccepts('nominatim_search', 'q', query)) {
		throw invalidOptions('The search text holds a character core refuses.', 'search_text_invalid');
	}

	// Nominatim names its results in the record's language; an unmapped lang
	// sends none and gets its default naming rather than a guessed tag
	const iso = getAlpha2FromCode(String(ctx.options.lang ?? ''));
	const answer = await askGeoService(
		'nominatim_search',
		{ q: query, limit: RESULT_LIMIT, addressdetails: '0', ...(iso ? { language: iso } : {}) },
		'place_search_unavailable',
	);

	return ok(
		{ results: parsePlaceResults(geoData(answer)), attribution: answer.attribution },
		{ requestId: toolRequestId(ctx) },
	);
}
