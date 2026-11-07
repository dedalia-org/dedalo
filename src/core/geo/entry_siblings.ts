/**
 * The SHAPE check of an entry's sibling keys — `sources` and `legend` — for the
 * doors that hold a value before it has a record: the CSV/JSON import conform
 * (tools/import_conform.ts). The save gate (geo/entry_gate.ts) builds on the
 * same two validators and adds what only a stored record can answer (which ids
 * already exist, which must be minted).
 *
 * It also holds the SERVING half, `servedGeoEntry`: what a stored entry looks
 * like when it leaves the server for a browser (the geolocation emit hook,
 * components/component_geolocation/emit.ts).
 *
 * NORMAL FORM. Absence is the empty state: `sources` undefined, null or `[]`, and
 * a `legend` that is null or says nothing (no title, no group), all mean "none"
 * and come back as NO key. An import that names `sources: []` therefore stores
 * the same bytes as one that omits it.
 */

import { type Checked, isRecord, pass } from './checked.ts';
import { isEmptyLegend, type MapLegend, servedMapLegend, validateMapLegend } from './map_legend.ts';
import { type MapSourceBody, servedMapSources, validateMapSources } from './map_source.ts';

export interface EntrySiblings {
	sources?: MapSourceBody[];
	legend?: MapLegend;
}

/** `sources` of an entry: undefined when it says none, else the validated list. */
function siblingSources(raw: unknown): Checked<MapSourceBody[] | undefined> {
	if (raw === undefined || raw === null) return pass(undefined);
	if (Array.isArray(raw) && raw.length === 0) return pass(undefined);
	return validateMapSources(raw, 'sources');
}

/** `legend` of an entry: undefined when it says nothing, else the validated legend. */
function siblingLegend(raw: unknown): Checked<MapLegend | undefined> {
	if (raw === undefined || raw === null) return pass(undefined);
	const checked = validateMapLegend(raw, 'legend');
	if (!checked.ok) return checked;
	return pass(isEmptyLegend(checked.value) ? undefined : checked.value);
}

/** The siblings of `entry`, validated and in normal form; the first reason otherwise. */
export function validateEntrySiblings(entry: Record<string, unknown>): Checked<EntrySiblings> {
	const sources = siblingSources(entry.sources);
	if (!sources.ok) return sources;
	const legend = siblingLegend(entry.legend);
	if (!legend.ok) return legend;
	const siblings: EntrySiblings = {};
	if (sources.value !== undefined) siblings.sources = sources.value;
	if (legend.value !== undefined) siblings.legend = legend.value;
	return pass(siblings);
}

/** True when the siblings carry anything to store. */
export function hasEntrySiblings(siblings: EntrySiblings): boolean {
	return siblings.sources !== undefined || siblings.legend !== undefined;
}

/**
 * A stored entry as it LEAVES THE SERVER for a browser in `mode`.
 *
 *  - `list` rows carry the VIEW and the features only: a grid reads lat/lon, and
 *    a map definition (up to a quarter-megabyte of legend icons per row, on
 *    pages of up to 1000 rows) has no consumer there. This is what bounds the
 *    list payload — the caps alone bounded one entry, not a page.
 *  - every other mode carries the map definition RE-VALIDATED on the way out,
 *    because bytes can reach the column without the save gate (restore, revert,
 *    archive restore): the legend through map_legend.ts servedMapLegend (what no
 *    longer conforms is dropped) and the sources through map_source.ts
 *    servedMapSources (a stored template is held by the browser — everyone who
 *    can read the field reads it, a secret belongs in an ontology default, never
 *    here — but the attribution, which reaches an HTML sink, is served blank
 *    when it no longer conforms).
 *
 * The entry itself is returned untouched when it carries neither key, so the
 * overwhelming case costs one property lookup. Never mutates its argument.
 */
export function servedGeoEntry(entry: unknown, mode: string): unknown {
	if (!isRecord(entry) || !('sources' in entry || 'legend' in entry)) return entry;
	const { sources, legend, ...served } = entry;
	return mode === 'list' ? served : withServedMapDefinition(served, sources, legend);
}

/** `served` plus the sources and the legend, each only if something safe is left of it. */
function withServedMapDefinition(
	served: Record<string, unknown>,
	sources: unknown,
	legend: unknown,
): Record<string, unknown> {
	const sourcesServed = servedMapSources(sources);
	if (sourcesServed !== null) served.sources = sourcesServed;
	const legendServed = servedMapLegend(legend);
	if (legendServed !== null) served.legend = legendServed;
	return served;
}
