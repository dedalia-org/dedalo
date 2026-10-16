/**
 * Search the Roman world's three gazetteers: Pleiades (local name→id index,
 * geometry per id from pleiades.stoa.org), Pelagios (local layers) and DARE (the
 * live `imperium.ahlfeldt.se` API). v6 titles its Pelagios panel "Pelagios
 * D.A.R.E" though DARE is a separate query. Server-side because the page serves
 * `connect-src 'self'` and the local data is not the browser's to read.
 */

import { DedaloError, ok } from '../../../src/core/errors/index.ts';
import { type HarvestDeps, harvestFetch } from '../../../src/core/harvest/harvest.ts';
import { fetchGuardedText } from '../../../src/core/security/ssrf_guard.ts';
import {
	type ToolActionContext,
	type ToolResponse,
	toolRequestId,
} from '../../../src/core/tools/module.ts';
import {
	GAZETTEER_CONFIG_KEY,
	gazetteerUnavailable,
	PELAGIOS_DATASETS,
	pelagiosDatasetPath,
	pleiadesIndexPath,
	resolveGazetteerDir,
} from './gazetteer_store.ts';
import { WIN_ANSI_HIGH } from './pdf_writer.ts';

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
 * Pleiades index (v6 shape: a flat array of [name, id] pairs) → up to `limit`
 * hits. `type` 'name' is a case-insensitive substring search, 'id' an exact id
 * match: v6's own two radio options.
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
 * One Pelagios dataset → up to `limit` hits whose name contains `query`. Every
 * match counts towards the shared limit, where v6 keeps one hit per dataset
 * (its `$exists` check compares the FILE name, not the feature).
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
		if (!searchable.some((value) => value.toLowerCase().includes(needle))) {
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
 * The DARE query URL, over HTTPS where v6 uses plaintext `http://`
 * (`class.tool_leaflet_special_tools.php`): the host answers on both.
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
 * DARE serves UTF-8 that was decoded as CP1252 upstream, so "Cádiz" arrives as
 * "CÃ¡diz" (v6 papers over it with `utf8_decode`). Each character goes back to
 * its CP1252 byte and the bytes are re-read as UTF-8; text that is not valid
 * UTF-8 that way was never mojibake and is returned untouched.
 */
export function decodeDareText(text: string): string {
	const bytes = new Uint8Array(text.length);
	for (let i = 0; i < text.length; i++) {
		const code = text.codePointAt(i) as number;
		const byte = code < 0x100 ? code : WIN_ANSI_HIGH.get(code);
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

/**
 * DARE's FeatureCollection → up to `limit` hits. A body that is not a
 * FeatureCollection is a service refusal, not zero results (as in
 * `place_search.ts`): a user must never read "no places found" for an outage.
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
 * Pleiades itself, where v6 reads a GitHub mirror (`ryanfb/pleiades-geojson`):
 * one intermediary less to trust or to fall out of date. Its `/search` sits
 * behind an anti-bot wall, which is why the name index stays local.
 */
const PLEIADES_HOST = 'pleiades.stoa.org';

function pleiadesPlaceUrl(id: string): URL {
	return new URL(`https://${PLEIADES_HOST}/places/${id}/json`);
}

/** The store's directory, or the operator-facing refusal when unset. */
async function requireGazetteerDir(): Promise<string> {
	const dir = await resolveGazetteerDir();
	if (dir === null) {
		throw gazetteerUnavailable(
			`No gazetteer data directory is configured for this install (tool option "${GAZETTEER_CONFIG_KEY}").`,
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

/** `deps` scripts the site in tests; the action binds the real door. */
export async function getPleiadesPlace(
	ctx: ToolActionContext,
	deps: HarvestDeps = {},
): Promise<ToolResponse> {
	const id = String(ctx.options.id ?? '').trim();
	if (!/^[0-9]{1,12}$/.test(id)) {
		throw invalidRequest('A numeric Pleiades id is required.');
	}

	return ok({ place: await fetchPleiadesPlace(id, deps) }, { requestId: toolRequestId(ctx) });
}

/**
 * One place document from Pleiades, a GeoJSON FeatureCollection. A non-2xx
 * answer (an unknown id) is a plain failure, not a retryable transport one.
 * `deps` scripts the site in tests.
 */
async function fetchPleiadesPlace(id: string, deps: HarvestDeps = {}): Promise<unknown> {
	const response = await harvestFetch(
		{
			url: pleiadesPlaceUrl(id).toString(),
			hosts: [PLEIADES_HOST],
			requireHttps: true,
			maxBytes: 8 * 1024 * 1024,
			timeoutMs: 15_000,
		},
		deps,
	);
	if (!response.ok) {
		throw new DedaloError('tool.action_failed', {
			coordinates: { tool: 'tool_uca_maps' },
			message: `Pleiades answered HTTP ${String(response.status)}`,
		});
	}
	const text = response.text();
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
	return payload;
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
