/**
 * component_geolocation ENTRY — the SIBLING KEYS that ride beside the view and
 * the features (WC-2026-11-06-geolocation-map-sources-legend).
 *
 * A stored entry is `{id, lat, lon, zoom, alt, lib_data, sources?, legend?}`:
 *   lat/lon/zoom  the VIEW (map framing);
 *   lib_data      the FEATURES — pure GeoJSON layers, and nothing else;
 *   sources       the map SOURCES the editor chose to draw tiles from;
 *   legend        the LEGEND that explains the drawing.
 * `sources` and `legend` are siblings of `lib_data`, never inside it: lib_data
 * stays the GeoJSON every consumer (client, diffusion, import) already reads.
 *
 * LEAF module: no imports, so the diffusion subsystem reaches it without
 * pulling the validators (and the SSRF guard they read) into its import graph.
 *
 * PUBLICATION. A source is an upstream URL, possibly carrying a provider token
 * in its template; a legend is up to a quarter-megabyte of embedded icons. The
 * publication contract is therefore a DECISION PER KEY, written here as data and
 * READ by the one diffusion door that copies the stored entry
 * (src/diffusion/resolve/default_value.ts → `withoutUnpublishedGeoKeys`, which
 * strips exactly the keys this table marks `withheld`): both keys are WITHHELD.
 * Opting a key in is setting it to `'published'` here plus a wire-contract
 * addendum; the diffusion gate pins the table, so a flip cannot go unnoticed.
 * Gate: test/unit/geo_sources_legend_diffusion_native.test.ts.
 */

/** The sibling keys, in the order the validators report them. */
export const GEO_SIBLING_KEYS = ['sources', 'legend'] as const;

export type GeoSiblingKey = (typeof GEO_SIBLING_KEYS)[number];

/** What diffusion does with one sibling key. */
export type GeoKeyPublication = 'withheld' | 'published';

/** Per sibling key: does diffusion publish it? Today every key is withheld. */
export const GEO_SIBLING_PUBLICATION = {
	sources: 'withheld',
	legend: 'withheld',
} as const satisfies Readonly<Record<GeoSiblingKey, GeoKeyPublication>>;

/**
 * The entry without the keys diffusion withholds (a copy; the argument is
 * untouched). `table` is the publication decision per key — the real one by
 * default; a parameter so a gate can drive a widened table and prove the table,
 * not a hard-coded list, is what decides.
 */
export function withoutUnpublishedGeoKeys(
	entry: Record<string, unknown>,
	table: Readonly<Record<GeoSiblingKey, GeoKeyPublication>> = GEO_SIBLING_PUBLICATION,
): Record<string, unknown> {
	const published = { ...entry };
	for (const key of GEO_SIBLING_KEYS) {
		if (table[key] === 'withheld') delete published[key];
	}
	return published;
}

/** A title that says nothing: absent, null or blank. Any other type is something. */
function titleSaysNothing(title: unknown): boolean {
	if (title === undefined || title === null) return true;
	return typeof title === 'string' && title.trim() === '';
}

/** Groups that say nothing: absent, null or an empty array. Any other type is something. */
function groupsSayNothing(groups: unknown): boolean {
	if (groups === undefined || groups === null) return true;
	return Array.isArray(groups) && groups.length === 0;
}

/**
 * True when a `legend` OBJECT says nothing: no title (blank counts) and no group,
 * and no other key. ONE rule for the two places that ask — the save gate's normal
 * form (map_legend.ts isEmptyLegend, on a validated legend) and "does a stored
 * item carry a map definition" below (on whatever the column holds). An unknown
 * key or a malformed `groups` is something, not nothing: a rule that called it
 * empty would let a repair delete content it could not read.
 */
export function hasNoLegendContent(legend: object): boolean {
	const { title, groups, ...others } = legend as Record<string, unknown>;
	return Object.keys(others).length === 0 && titleSaysNothing(title) && groupsSayNothing(groups);
}

/** Whether a `sources` value is PRESENT: anything but absent, null or the empty array. */
function carriesSources(sources: unknown): boolean {
	if (sources === undefined || sources === null) return false;
	return !(Array.isArray(sources) && sources.length === 0);
}

/** Whether a `legend` value is PRESENT: anything but absent, null or a legend object that says nothing. */
function carriesLegend(legend: unknown): boolean {
	if (legend === undefined || legend === null) return false;
	if (typeof legend !== 'object' || Array.isArray(legend)) return true;
	return !hasNoLegendContent(legend);
}

/**
 * True when `entry` carries a MAP DEFINITION: a `sources` or a `legend` that is
 * PRESENT — a judgement of presence, not of type. Only the gate's own normal form
 * for "none" counts as nothing (the key absent, null, `[]` for sources, a legend
 * object with no title, no group and no other key). Every other value — a string,
 * an object where a list belongs, an array where an object does, a legend with
 * an unknown key — is content an operator or a restore wrote, and a shape the
 * gate would refuse can still reach the column through the doors that bypass it
 * (Time Machine restore, bulk revert, archive restore): the studio-default repair
 * (scripts/repair_geolocation_studio_default.ts) must not classify such an entry
 * as "default-only" and delete what it cannot read.
 */
export function carriesMapDefinition(entry: Record<string, unknown>): boolean {
	return carriesSources(entry.sources) || carriesLegend(entry.legend);
}
