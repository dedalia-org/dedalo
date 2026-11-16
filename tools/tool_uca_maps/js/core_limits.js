// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*eslint no-undef: "error"*/



/**
* CORE_LIMITS
* The core's rules for a map source and a legend (`src/core/geo/map_source.ts`,
* `map_source_url.ts`, `map_legend.ts`) that the panels check before saving: a value the
* server would refuse blocks the whole geolocation save, drawings included. Also the
* core's words the tool repeats (a provider's credit). The core's
* modules are not served to the browser, so they are mirrored here, in one place, and
* test/unit/tool_uca_maps_core_limits.test.ts fails when one drifts.
*
* @module core_limits
*/



/** WMS versions a stored source may carry (`WMS_VERSIONS`). */
export const WMS_VERSIONS = ['1.1.1', '1.3.0']

/** CRSs a stored WMS source may carry (`WMS_CRS`), in the panel's order of preference:
* the map's own projection first. */
export const WMS_CRS = ['EPSG:3857', 'EPSG:4326', 'EPSG:4258']

/** The one format the panel saves a WMS layer in; one of `WMS_FORMATS`. */
export const WMS_SAVED_FORMAT = 'image/png'

/** The placeholders an XYZ template carries, all of them and no other (`XYZ_PLACEHOLDERS`). */
export const XYZ_PLACEHOLDERS = ['{z}', '{x}', '{y}']

/** An attribution's ceiling, in characters (`MAP_SOURCE_LIMITS.maxAttribution`). */
export const MAX_ATTRIBUTION_LENGTH = 300

/** The highest zoom of an XYZ source (`MAP_SOURCE_LIMITS.maxZoom`). */
export const MAX_SOURCE_ZOOM = 22

/** A legend's caps (`LEGEND_LIMITS`): texts in characters, icons in characters and pixels. */
export const LEGEND_LIMITS = {
	maxTitle			: 200,
	maxGroups			: 16,
	maxName				: 200,
	maxSymbolsPerGroup	: 64,
	maxLabel			: 200,
	maxIconChars		: 64 * 1024,
	maxIconCharsTotal	: 256 * 1024,
	maxIconSide			: 256,
	maxIconPixelsTotal	: 1024 * 1024
}

/** The raster formats a legend icon may be (`RasterFormat`, `ICON_URI`). */
export const ICON_RASTER_FORMATS = ['png', 'jpeg', 'webp']

/** A legend text that reads as the start of a tag is refused (`map_legend.ts` TAG_START). */
export const LEGEND_TAG_START = /<[A-Za-z/!?]/

/** C0, DEL, C1 and the Unicode line/paragraph separators: what the core's `checkText`
* refuses in a text (`checked.ts` isControlCode). */
export const is_control_code = (code) => code<=0x1f || (code>=0x7f && code<=0x9f) || code===0x2028 || code===0x2029



// @license-end

/** Core's credit for Catastro (`src/core/geo_services/table.ts` GEO_ORIGINS.catastro). */
export const CATASTRO_CREDIT = 'Dirección General del Catastro (Spain)'
