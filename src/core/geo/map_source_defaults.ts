/**
 * The ONTOLOGY DEFAULT map sources of a component_geolocation node —
 * `properties.map_sources` (WC-2026-11-06-geolocation-map-sources-legend).
 *
 * An installation (or a project's ontology) that wants every geolocation field
 * to offer the same base maps lists them on the component node:
 *
 *   "map_sources": [
 *     { "id": "ign_base", "label": "IGN base map", "type": "wms",
 *       "url": "https://…", "params": { … }, "attribution": "…" }
 *   ]
 *
 * It is a PROPERTIES key the engine reads — not an ontology node, and nothing
 * here creates one. Each entry is the stored-source shape (map_source.ts) with
 * two differences: the `id` is a short NAME (`^[a-z][a-z0-9_]{0,47}$`, unique in
 * the list) because there is no record counter to issue numbers from, and an
 * optional `label` for the picker (default: the id). The proxy request names a
 * default by `{section_tipo, component_tipo, default_id}` — a separate namespace
 * from stored ids by construction (a number against a name), so the two cannot
 * collide.
 *
 * An entry that fails the validator is REJECTED, not dropped quietly: the result
 * lists every rejection with its index and reason, so the caller can log it, and
 * the proxy can tell "that default is broken" from "no such default". Rejected
 * entries are never offered and never fetched.
 *
 * `parseMapSourceDefaults` is pure; `readMapSourceDefaults` is the one accessor
 * that touches the ontology (the cached resolver, hub-coherent after an ontology
 * write).
 */

import { getPropertiesByTipo } from '../ontology/resolver.ts';
import { type Checked, checkPlainText, fail, isRecord, pass } from './checked.ts';
import { type MapSourceBody, validateMapSource } from './map_source.ts';

export const MAP_SOURCE_DEFAULT_LIMITS = {
	maxDefaults: 32,
	maxLabel: 100,
} as const;

const DEFAULT_ID = /^[a-z][a-z0-9_]{0,47}$/;

export interface MapSourceDefault {
	/** The default's name — what `default_id` of a proxy request carries. */
	id: string;
	/** The picker text (the id when the node gives none). Plain text: the validator refuses `<` and `>`. */
	label: string;
	/** The validated source; carries no numeric id. */
	source: MapSourceBody;
}

export interface RejectedMapSourceDefault {
	index: number;
	/** The entry's `id` when it was readable. */
	id?: string;
	reason: string;
}

export interface MapSourceDefaults {
	defaults: MapSourceDefault[];
	rejected: RejectedMapSourceDefault[];
}

/** The id and label of one entry, and the remainder to validate as a source. */
function splitDefault(
	raw: unknown,
	where: string,
): Checked<{ id: string; label: string; rest: Record<string, unknown> }> {
	if (!isRecord(raw)) return fail(`${where}: must be an object`);
	const { id, label, ...rest } = raw;
	if (typeof id !== 'string' || !DEFAULT_ID.test(id)) {
		return fail(`${where}.id: must be a name matching ${DEFAULT_ID.source}`);
	}
	// The label goes into Leaflet's layer control, which writes HTML: plain text, like the attribution.
	const text = checkPlainText(
		label === undefined ? id : label,
		`${where}.label`,
		MAP_SOURCE_DEFAULT_LIMITS.maxLabel,
		false,
	);
	return text.ok ? pass({ id, label: text.value, rest }) : text;
}

function parseOne(raw: unknown, index: number): Checked<MapSourceDefault> {
	const where = `map_sources[${index}]`;
	const parts = splitDefault(raw, where);
	if (!parts.ok) return parts;
	const source = validateMapSource(parts.value.rest, where);
	if (!source.ok) return source;
	return pass({ id: parts.value.id, label: parts.value.label, source: source.value });
}

/** The `id` of a raw entry when it is a string (for a rejection's label). */
function rawIdOf(entry: unknown): string | undefined {
	return isRecord(entry) && typeof entry.id === 'string' ? entry.id : undefined;
}

/** Parse one entry and file it under `defaults` or `rejected` (a repeated name is rejected). */
function settleDefault(
	result: MapSourceDefaults,
	names: Set<string>,
	entry: unknown,
	index: number,
): void {
	const parsed = parseOne(entry, index);
	if (!parsed.ok) {
		result.rejected.push({ index, id: rawIdOf(entry), reason: parsed.reason });
	} else if (names.has(parsed.value.id)) {
		result.rejected.push({
			index,
			id: parsed.value.id,
			reason: `map_sources[${index}].id: appears twice`,
		});
	} else {
		names.add(parsed.value.id);
		result.defaults.push(parsed.value);
	}
}

function parseList(raw: readonly unknown[]): MapSourceDefaults {
	const result: MapSourceDefaults = { defaults: [], rejected: [] };
	const names = new Set<string>();
	for (const [index, entry] of raw.slice(0, MAP_SOURCE_DEFAULT_LIMITS.maxDefaults).entries()) {
		settleDefault(result, names, entry, index);
	}
	if (raw.length > MAP_SOURCE_DEFAULT_LIMITS.maxDefaults) {
		result.rejected.push({
			index: MAP_SOURCE_DEFAULT_LIMITS.maxDefaults,
			reason: `map_sources: more than ${MAP_SOURCE_DEFAULT_LIMITS.maxDefaults} entries`,
		});
	}
	return result;
}

/** `properties.map_sources` of a node's properties, parsed. Absent key = no defaults, no rejection. */
export function parseMapSourceDefaults(properties: unknown): MapSourceDefaults {
	const raw = isRecord(properties) ? properties.map_sources : undefined;
	if (raw === undefined || raw === null) return { defaults: [], rejected: [] };
	if (Array.isArray(raw)) return parseList(raw);
	return { defaults: [], rejected: [{ index: -1, reason: 'map_sources: must be an array' }] };
}

/** The defaults of one component node (the ontology's `properties.map_sources`). */
export async function readMapSourceDefaults(componentTipo: string): Promise<MapSourceDefaults> {
	return parseMapSourceDefaults(await getPropertiesByTipo(componentTipo));
}

/** The default named `defaultId`, or null. */
export function findMapSourceDefault(
	parsed: MapSourceDefaults,
	defaultId: unknown,
): MapSourceDefault | null {
	return parsed.defaults.find((entry) => entry.id === defaultId) ?? null;
}

/**
 * What the client picker is told about one default. Everything the page needs to DRAW the
 * layer and nothing it could use to reach the provider: the name it asks the proxy for, the
 * label, the type, the attribution the licence asks to be shown, and the few numbers that
 * decide which tiles are worth asking for (an xyz source's zoom bounds, a wms source's CRS).
 * The address, the layer names and every other parameter stay on the server, where a
 * provider key may live. Flat keys (no `params` object) on purpose: nothing of a source's
 * `params` is published as such.
 */
export interface MapSourcePickerEntry {
	id: string;
	label: string;
	type: MapSourceBody['type'];
	/** Plain text (the validator refuses `<` and `>`): shown in the map's attribution control. */
	attribution: string;
	/** xyz: the source's own zoom bounds, when it states them. */
	min_zoom?: number;
	max_zoom?: number;
	/** wms: the CRS it declared — a geographic one is relayed from a minimum zoom only. */
	crs?: string;
}

/** The numbers a picker entry carries for `source`, by type. */
function pickerNumbers(source: MapSourceBody): Partial<MapSourcePickerEntry> {
	if (source.type === 'wms') return { crs: source.params.crs };
	const { min_zoom, max_zoom } = source.params;
	return {
		...(min_zoom === undefined ? {} : { min_zoom }),
		...(max_zoom === undefined ? {} : { max_zoom }),
	};
}

/** What the client picker may be told about the defaults: see `MapSourcePickerEntry` — NEVER a URL. */
export function mapSourcePickerEntries(
	defaults: readonly MapSourceDefault[],
): MapSourcePickerEntry[] {
	return defaults.map((entry) => ({
		id: entry.id,
		label: entry.label,
		type: entry.source.type,
		attribution: entry.source.attribution,
		...pickerNumbers(entry.source),
	}));
}
