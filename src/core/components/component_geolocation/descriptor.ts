/**
 * component_geolocation — geographic point/shape value (PHP
 * core/component_geolocation). Stores its data in the dedicated `geo` column.
 * Not class-translatable.
 *
 * The stored entry is `{id, lat, lon, zoom, alt, lib_data, sources?, legend?}`:
 * lat/lon/zoom are the VIEW, `lib_data` the FEATURES (pure GeoJSON), and
 * `sources` / `legend` the map sources and legend that ride beside them
 * (WC-2026-11-06-geolocation-map-sources-legend). The save-time rules for those
 * two keys live in src/core/geo/ and are reached through the `itemGate` facet
 * (the save) and the `emitHook` facet (what is served) — a signpost, not a copy.
 */
import type { ComponentModel } from '../types.ts';

export const component_geolocation: ComponentModel = {
	model: 'component_geolocation',
	column: 'geo',
	render: 'text',
	importAppend: 'geo_layer',
	monovalue: true,
	sortable: false, // PHP component_geolocation::get_sortable() → false
	importConform: 'geolocation',
	itemGate: 'geo_entry', // sources/legend: validation + server-issued source ids (src/core/geo/entry_gate.ts)
	emitHook: 'geo', // sources/legend on the way OUT: legend re-validated, dropped from list rows (src/core/geo/entry_siblings.ts)
};
