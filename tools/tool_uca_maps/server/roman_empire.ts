/**
 * Fila #14 del audit ("Imperio Romano"): search the Roman world's three
 * gazetteers and bring a place onto the map.
 *
 * THE THREE SOURCES, WITH THEIR REAL NAMES (audit correction #2 — v6 titles
 * one panel "Pelagios D.A.R.E" although it only searches Pelagios, while the
 * actual DARE query lives in a separate panel):
 *   · Pleiades — a local name→id index, geometry fetched per id from
 *     pleiades.stoa.org (v6 used a GitHub mirror, see `pleiadesPlaceUrl`).
 *   · Pelagios — the local Roman-world layers (places, roads, provinces…).
 *   · DARE — the live `imperium.ahlfeldt.se` API (Lund University).
 * The first two read the local store (`gazetteer_store.ts`) and are therefore
 * capability-gated; the third needs no local data at all.
 *
 * WHY THE SERVER: same reason as every other third-party door in this tool
 * (`wms.ts`, `place_search.ts`) — the app serves `connect-src 'self'`, so the
 * page cannot query these services itself, and a local dataset is not the
 * browser's to read at all.
 */

import { DedaloError, ok } from '../../../src/core/errors/index.ts';
import { fetchGuardedText } from '../../../src/core/security/ssrf_guard.ts';
import {
	type ToolActionContext,
	type ToolResponse,
	toolRequestId,
} from '../../../src/core/tools/module.ts';
import {
	gazetteerUnavailable,
	PELAGIOS_DATASETS,
	pelagiosDatasetPath,
	pleiadesIndexPath,
	resolveGazetteerDir,
} from './gazetteer_store.ts';

/** v6's own result count for all three searches (10 result slots per panel). */
const RESULT_LIMIT = 10;

const DARE_API = 'https://imperium.ahlfeldt.se/api/geojson.php';

/** DARE's two name fields: modern place name / ancient place name. */
const DARE_NAME_TYPES: readonly string[] = Object.freeze(['mss', 'ass']);

/** A caller fault — empty, too short or malformed search input. */
function invalidRequest(message: string): DedaloError {
	return new DedaloError('request.invalid_options', { message, publicMessage: message });
}

/** The third party answered, but not with something usable. */
function outboundFailure(message: string): DedaloError {
	return new DedaloError('security.outbound_failed', { message });
}

/** One hit from any of the three sources, already reduced to what the map needs. */
export interface GazetteerResult {
	/** The place name shown in the result list. */
	name: string;
	/** Pleiades only: the id whose geometry `get_pleiades_place` then fetches. */
	id?: string;
	/** Which dataset a Pelagios hit came from — shown next to the name. */
	dataset?: string;
	/** GeoJSON geometry type, so the list says what will be drawn. */
	geometry_type?: string;
	/** The full GeoJSON Feature, for the sources that already carry it. */
	feature?: unknown;
}

/**
 * Pleiades index (v6 shape: a flat array of [name, id] pairs) → up to
 * `limit` hits. `type` 'name' is a case-insensitive substring search, 'id' an
 * exact id match — v6's own two radio options. PURE, exported for unit
 * coverage against a hand-written fixture.
 */
export function matchPleiadesIndex(
	text: string,
	type: 'name' | 'id',
	value: string,
	limit = RESULT_LIMIT,
): GazetteerResult[] {
	let payload: unknown;
	try {
		payload = JSON.parse(text);
	} catch {
		throw gazetteerUnavailable('The Pleiades index is not readable.');
	}
	if (!Array.isArray(payload)) {
		throw gazetteerUnavailable('The Pleiades index has an unexpected shape.');
	}
	const needle = value.toLowerCase();
	const results: GazetteerResult[] = [];
	if (limit <= 0) {
		return results; // "no room left" is zero hits, not one more (the break below runs AFTER a push)
	}
	for (const entry of payload) {
		if (!Array.isArray(entry) || entry.length < 2) {
			continue;
		}
		const name = String(entry[0] ?? '');
		const id = String(entry[1] ?? '');
		if (name === '' || id === '') {
			continue;
		}
		const hit = type === 'id' ? id === value : name.toLowerCase().includes(needle);
		if (!hit) {
			continue;
		}
		results.push({ name, id });
		if (results.length >= limit) {
			break;
		}
	}
	return results;
}

/**
 * The place-name properties the Pelagios layers use, in v6's own order:
 * `name`/`Name` for the label and boundary layers, `modern` + `latin` for the
 * settlement ones (both are searchable, `modern` is what gets shown).
 */
function pelagiosNames(properties: Record<string, unknown>): {
	label: string;
	searchable: string[];
} {
	const name = typeof properties.name === 'string' ? properties.name : '';
	const upper = typeof properties.Name === 'string' ? properties.Name : '';
	const modern = typeof properties.modern === 'string' ? properties.modern : '';
	const latin = typeof properties.latin === 'string' ? properties.latin : '';
	const label = name || upper || modern || latin;
	return { label, searchable: [name, upper, modern, latin].filter((value) => value !== '') };
}

/**
 * One Pelagios dataset → up to `limit` hits whose name contains `query`.
 * PURE, exported for unit coverage.
 *
 * DIVERGENCE FROM v6, deliberate: v6 keeps at most ONE hit per dataset (its
 * `$exists` check compares the FILE name, not the feature), so searching a
 * layer of 10.000 places answers with its first match and stops. Here every
 * match counts towards the shared limit, which is what a result list of ten
 * slots is for.
 */
export function matchPelagiosFeatures(
	text: string,
	dataset: string,
	query: string,
	limit = RESULT_LIMIT,
): GazetteerResult[] {
	let payload: unknown;
	try {
		payload = JSON.parse(text);
	} catch {
		throw gazetteerUnavailable(`The "${dataset}" dataset is not readable.`);
	}
	const features = (payload as { features?: unknown }).features;
	if (!Array.isArray(features)) {
		throw gazetteerUnavailable(`The "${dataset}" dataset has an unexpected shape.`);
	}
	const needle = query.toLowerCase();
	const results: GazetteerResult[] = [];
	if (limit <= 0) {
		return results;
	}
	for (const feature of features) {
		if (typeof feature !== 'object' || feature === null) {
			continue;
		}
		const typed = feature as { properties?: unknown; geometry?: { type?: unknown } };
		const properties =
			typeof typed.properties === 'object' && typed.properties !== null
				? (typed.properties as Record<string, unknown>)
				: {};
		const { label, searchable } = pelagiosNames(properties);
		if (label === '' || !searchable.some((value) => value.toLowerCase().includes(needle))) {
			continue;
		}
		results.push({
			name: label,
			dataset,
			geometry_type: typeof typed.geometry?.type === 'string' ? typed.geometry.type : undefined,
			feature,
		});
		if (results.length >= limit) {
			break;
		}
	}
	return results;
}

/**
 * Builds the DARE query URL. EXPORTED for unit coverage (no network needed).
 *
 * HTTPS, where v6 calls the same API over plaintext `http://`
 * (`class.tool_leaflet_special_tools.php:853`) — the host answers on both, so
 * there is no reason to ship a cleartext third-party call into v7.
 */
export function dareApiUrl(options: {
	query: string;
	nameType: string;
	typeId?: string;
	country?: string;
}): URL {
	if (!DARE_NAME_TYPES.includes(options.nameType)) {
		throw invalidRequest('Unknown name type.');
	}
	const url = new URL(DARE_API);
	url.searchParams.set(options.nameType, options.query);
	// both filters are DARE's own closed vocabularies (numeric type id, ISO
	// country code); anything else is refused rather than passed through
	if (options.typeId) {
		if (!/^[0-9]{1,4}$/.test(options.typeId)) {
			throw invalidRequest('Unknown site type.');
		}
		url.searchParams.set('typeid', options.typeId);
	}
	if (options.country) {
		if (!/^[A-Z]{2}$/i.test(options.country)) {
			throw invalidRequest('Unknown country.');
		}
		url.searchParams.set('cc', options.country.toUpperCase());
	}
	return url;
}

/**
 * DARE serves UTF-8 text that was itself decoded from UTF-8 bytes as CP1252,
 * so "Cádiz" arrives as "CÃ¡diz" (v6 papers over the same thing with
 * `utf8_decode`). This maps each character back to the CP1252 BYTE it stands
 * for and re-reads the sequence as UTF-8; anything that is not valid UTF-8
 * that way was never mojibake, and is returned untouched.
 */
export function decodeDareText(text: string): string {
	const bytes = new Uint8Array(text.length);
	for (let i = 0; i < text.length; i++) {
		const code = text.codePointAt(i) as number;
		const byte = code < 0x100 ? code : CP1252_HIGH.get(code);
		if (byte === undefined) {
			return text; // not a CP1252-representable string: not this mojibake
		}
		bytes[i] = byte;
	}
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	} catch {
		return text;
	}
}

/** CP1252's own 0x80–0x9F block, where it differs from ISO-8859-1. */
const CP1252_HIGH: ReadonlyMap<number, number> = new Map([
	[0x20ac, 0x80],
	[0x201a, 0x82],
	[0x0192, 0x83],
	[0x201e, 0x84],
	[0x2026, 0x85],
	[0x2020, 0x86],
	[0x2021, 0x87],
	[0x02c6, 0x88],
	[0x2030, 0x89],
	[0x0160, 0x8a],
	[0x2039, 0x8b],
	[0x0152, 0x8c],
	[0x017d, 0x8e],
	[0x2018, 0x91],
	[0x2019, 0x92],
	[0x201c, 0x93],
	[0x201d, 0x94],
	[0x2022, 0x95],
	[0x2013, 0x96],
	[0x2014, 0x97],
	[0x02dc, 0x98],
	[0x2122, 0x99],
	[0x0161, 0x9a],
	[0x203a, 0x9b],
	[0x0153, 0x9c],
	[0x017e, 0x9e],
	[0x0178, 0x9f],
]);

/**
 * DARE's FeatureCollection → up to `limit` hits. PURE, exported for unit
 * coverage. A body that is not a FeatureCollection is a service REFUSAL, not
 * zero results — same law as `place_search.ts` (hito 15 fix): a user must
 * never read "no places found" for an outage.
 */
export function parseDareResults(text: string, limit = RESULT_LIMIT): GazetteerResult[] {
	let payload: unknown;
	try {
		payload = JSON.parse(text);
	} catch {
		throw outboundFailure('The DARE service returned an unreadable response.');
	}
	const features = (payload as { features?: unknown }).features;
	if (!Array.isArray(features)) {
		throw outboundFailure('The DARE service refused the request.');
	}
	const results: GazetteerResult[] = [];
	if (limit <= 0) {
		return results;
	}
	for (const feature of features) {
		if (typeof feature !== 'object' || feature === null) {
			continue;
		}
		const typed = feature as { properties?: { name?: unknown }; geometry?: { type?: unknown } };
		const raw = typeof typed.properties?.name === 'string' ? typed.properties.name.trim() : '';
		if (raw === '') {
			continue;
		}
		// the repaired name also replaces the feature's own, so the OBJECT the
		// user ends up with on the map is not called "CÃ¡diz" either (v6 repairs
		// only the list entry and stores the mojibake verbatim)
		const name = decodeDareText(raw);
		const properties = { ...(typed.properties as Record<string, unknown>), name };
		results.push({
			name,
			geometry_type: typeof typed.geometry?.type === 'string' ? typed.geometry.type : undefined,
			feature: { ...(feature as Record<string, unknown>), properties },
		});
		if (results.length >= limit) {
			break;
		}
	}
	return results;
}

/**
 * The canonical Pleiades place document. v6 reads a third-party GitHub MIRROR
 * (`raw.githubusercontent.com/ryanfb/pleiades-geojson`); this asks Pleiades
 * itself, which answers `/places/<id>/json` directly — one less intermediary
 * to trust and to fall out of date. (Its `/search` endpoint is the one behind
 * an anti-bot wall, which is exactly why the name index stays local.)
 */
export function pleiadesPlaceUrl(id: string): URL {
	return new URL(`https://pleiades.stoa.org/places/${id}/json`);
}

/** The store's directory, or the operator-facing refusal when unset. */
async function requireGazetteerDir(): Promise<string> {
	const dir = await resolveGazetteerDir();
	if (dir === null) {
		throw gazetteerUnavailable(
			'No gazetteer data directory is configured for this install (tool option "gazetteer_data_path").',
		);
	}
	return dir;
}

/** Trimmed, length-checked search text. */
function requireQuery(raw: unknown, minLength: number): string {
	const query = String(raw ?? '').trim();
	if (query.length < minLength) {
		throw invalidRequest(`The search text needs at least ${minLength} characters.`);
	}
	if (query.length > 200) {
		throw invalidRequest('The search text is too long.');
	}
	return query;
}

export async function searchPleiades(ctx: ToolActionContext): Promise<ToolResponse> {
	const type = String(ctx.options.type ?? 'name');
	if (type !== 'name' && type !== 'id') {
		throw invalidRequest('Unknown search type.');
	}
	// v6's own minimums: 3 characters by name, an exact id otherwise
	const value = requireQuery(ctx.options.value, type === 'name' ? 3 : 1);

	const dir = await requireGazetteerDir();
	const path = pleiadesIndexPath(dir);
	if (path === null) {
		throw gazetteerUnavailable('The Pleiades index is missing from the gazetteer data directory.');
	}

	const text = await Bun.file(path).text();
	return ok({ results: matchPleiadesIndex(text, type, value) }, { requestId: toolRequestId(ctx) });
}

export async function getPleiadesPlace(ctx: ToolActionContext): Promise<ToolResponse> {
	const id = String(ctx.options.id ?? '').trim();
	if (!/^[0-9]{1,12}$/.test(id)) {
		throw invalidRequest('A numeric Pleiades id is required.');
	}

	const text = await fetchGuardedText(pleiadesPlaceUrl(id).toString(), {
		maxBytes: 8 * 1024 * 1024,
	});
	let payload: unknown;
	try {
		payload = JSON.parse(text);
	} catch {
		throw outboundFailure('Pleiades returned an unreadable response.');
	}
	// a place document is itself a GeoJSON FeatureCollection
	if (!Array.isArray((payload as { features?: unknown }).features)) {
		throw outboundFailure('Pleiades returned an unexpected document.');
	}

	return ok({ place: payload }, { requestId: toolRequestId(ctx) });
}

export async function searchPelagios(ctx: ToolActionContext): Promise<ToolResponse> {
	const query = requireQuery(ctx.options.query, 2);

	const requested = Array.isArray(ctx.options.datasets) ? ctx.options.datasets.map(String) : [];
	const datasets = requested.filter((name) => PELAGIOS_DATASETS.includes(name));
	if (datasets.length === 0) {
		throw invalidRequest('Select at least one dataset to search.');
	}

	const dir = await requireGazetteerDir();

	const results: GazetteerResult[] = [];
	for (const dataset of datasets) {
		if (results.length >= RESULT_LIMIT) {
			break;
		}
		const path = pelagiosDatasetPath(dir, dataset);
		if (path === null) {
			continue; // an absent layer is not an error: capabilities already said so
		}
		const text = await Bun.file(path).text();
		// cheap pre-filter: a 4 MB layer with no textual match anywhere is
		// never worth parsing (v6 json_decodes every selected file, always)
		if (!text.toLowerCase().includes(query.toLowerCase())) {
			continue;
		}
		results.push(...matchPelagiosFeatures(text, dataset, query, RESULT_LIMIT - results.length));
	}

	return ok({ results }, { requestId: toolRequestId(ctx) });
}

export async function searchDare(ctx: ToolActionContext): Promise<ToolResponse> {
	const query = requireQuery(ctx.options.query, 3);
	const url = dareApiUrl({
		query,
		nameType: String(ctx.options.name_type ?? 'mss'),
		typeId: String(ctx.options.type_id ?? '').trim(),
		country: String(ctx.options.country ?? '').trim(),
	});

	const text = await fetchGuardedText(url.toString(), { maxBytes: 8 * 1024 * 1024 });
	return ok({ results: parseDareResults(text) }, { requestId: toolRequestId(ctx) });
}
