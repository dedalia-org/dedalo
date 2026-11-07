/**
 * component_geolocation EMIT HOOK (`emitHook: 'geo'`) — the SERVING door of an
 * entry's `sources` and `legend` (WC-2026-11-06-geolocation-map-sources-legend).
 *
 * The generic literal path hands the stored value to the browser verbatim. For a
 * geolocation entry that is not enough: the legend and the sources' attribution
 * are re-validated where they leave the server and a `list` row drops the map
 * definition altogether (see geo/entry_siblings.ts servedGeoEntry for the rules
 * and the reasons). The hook rewrites the built item's `entries` —
 * `decorateItem`, not `transformValue`, because the save echo (dd_core_api save)
 * runs ONLY `decorateItem`, so the value an editor holds after a save passes the
 * same door as the one it loaded.
 *
 * Nothing is stored here; the record's bytes are never rewritten by a read.
 */

import { servedGeoEntry } from '../../geo/entry_siblings.ts';
import type { ComponentEmitHook } from '../emit_hooks.ts';

export const geoEmitHook: ComponentEmitHook = {
	decorateItem(item, context) {
		const entries = item.entries;
		if (!Array.isArray(entries)) return;
		const served = entries.map((entry) => servedGeoEntry(entry, context.ddoMode));
		// the same array when nothing changed: the overwhelming case allocates one list
		if (served.some((entry, index) => entry !== entries[index])) item.entries = served;
	},
};
