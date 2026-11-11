/**
 * Custom ddo fns — the three publication fns the numisdata domain configures on
 * dd1190 field nodes (DIFFUSION_SPEC §4.1 stage D, custom-fn dispatch):
 *
 * - parse_tag_to_html   (PHP diffusion/class.diffusion_fn.php :367-404): a
 *   text_area value with Dédalo tags ([svg..], [geo..], [note..], …) rendered
 *   to publication HTML via TR::add_tag_img_on_the_fly (shared/class.TR.php
 *   :254-437), then html_entity_decode'd by the component_text_area
 *   get_diffusion_data override (class.component_text_area.php :2441-2453);
 * - get_geojson_data    (PHP class.component_text_area.php :1612-1665 +
 *   build_geolocation_data :1697-1830 + component_geolocation::
 *   get_diffusion_value_as_geojson :362-433): the PAIRED component_geolocation
 *   lib_data layers as [{layer_id, text:'', layer_data}] — the single-point
 *   lat/lon fallback included;
 * - get_diffusion_iconography (PHP class.component_portal.php :477-529): the
 *   3-level portal walk (record → scene records → inner autocomplete_hi terms)
 *   joined per lang with the ddo separators.
 *
 * Everything here is PURE (no I/O) except parse_tag_to_html's svg marks, whose
 * URL is the locator's media path (core media/tag_locator.ts — ontology reads,
 * plus one record read where `additional_path` is declared). The resolver reads
 * the matrix slices and resolves terms/ontology pairs, this module owns the
 * byte-level shaping.
 */

// The tag→HTML converter LIVES IN CORE (the list emit hook needs it and core
// must never import src/diffusion/**); re-exported here so diffusion consumers
// keep their historical import site.
import {
	createSvgTagPathMemo,
	renderTagsWithResolvedSvg,
	type SvgTagPathMemo,
	type TagRenderOptions,
} from '../../core/components/component_text_area/tag_html.ts';
import { decodeHtmlEntities } from './default_value.ts';
import {
	hasCoordinate,
	isStudioDefault,
	phpNumberFormat16RoundTrip,
	toCoordinate,
} from './geo_coordinate.ts';

// ---------------------------------------------------------------------------
// parse_tag_to_html — TR::add_tag_img_on_the_fly twin (moved to
// src/core/components/component_text_area/tag_html.ts)
// ---------------------------------------------------------------------------

export {
	addTagImgOnTheFly,
	createSvgTagPathMemo,
	type SvgTagLocator,
	type SvgTagPathMemo,
	type TagRenderOptions,
} from '../../core/components/component_text_area/tag_html.ts';

/**
 * The full parse_tag_to_html value transform for ONE stored text value: tags
 * to HTML, then the component_text_area get_diffusion_data override's
 * html_entity_decode (class.component_text_area.php :2441-2453) over the whole
 * string — which deliberately UNDOES the SEC-028 attribute escaping (PHP does
 * exactly this: the fn output goes through the decode pass), so published
 * attributes carry the raw single-quoted locator text the old engine emitted.
 */
export async function parseTagValueToHtml(
	raw: string,
	memo: SvgTagPathMemo = createSvgTagPathMemo(),
	options: Omit<TagRenderOptions, 'svgUrl'> = {},
): Promise<string> {
	// PUBLISHED audience: svg glyphs root on `/dedalo/<mediaDir>`, never on the
	// application's origin (WC-042); the path is the locator's full media path
	// (T0-10). `memo` is the run's (RunContext.svgTagPathMemo) — a bare call gets
	// a throwaway one.
	return decodeHtmlEntities(await renderTagsWithResolvedSvg(raw, 'published', memo, options));
}

// ---------------------------------------------------------------------------
// get_geojson_data — build_geolocation_data(geojson=true) + point fallback
// ---------------------------------------------------------------------------

/** One published geo layer (v5 diffusion format: text is ALWAYS ''). */
export interface GeojsonLayer {
	layer_id: unknown;
	text: '';
	layer_data: unknown;
}

/** A stored component_geolocation item ({id, alt, lat, lon, zoom, lib_data}). */
export interface StoredGeolocationItem {
	lat?: unknown;
	lon?: unknown;
	lib_data?: { layer_id?: unknown; layer_data?: unknown }[] | null;
	[extra: string]: unknown;
}

/**
 * component_geolocation::get_diffusion_value_as_geojson (PHP :362-433) as a
 * layer list: the single-point FeatureCollection built from the stored
 * lat/lon. Returns [] when there is no point to build.
 *
 * DIVERGES from the PHP oracle by law, not by accident:
 * - no sentinel. The Valencia pair PHP treated as "no location set" is an
 *   ordinary coordinate; the client no longer fabricates a camera position
 *   into the stored value, so absence is representable directly;
 * - absence is structural (geo_coordinate.ts): PHP's `!empty()` coerced
 *   ''/null to the literal 0 and published Greenwich. Only a real coordinate
 *   publishes now, and 0 is one.
 *
 * Number formatting parity is unchanged: PHP number_format((float)$v,16,'.','')
 * is within half-ulp of the double, so the JSON round-trip reproduces the
 * original number — Number() + JSON.stringify is the byte-equivalent.
 */
export function geojsonPointFallbackLayers(
	item: StoredGeolocationItem | undefined,
): GeojsonLayer[] {
	if (item === undefined || item === null) return [];
	if (!hasCoordinate(item.lat) || !hasCoordinate(item.lon)) return [];
	// The STUDIO DEFAULT never publishes: it is the factory map position the v6
	// client wrote on save, not a position anyone chose. Absence and the default
	// are the only two refusals — 0 is a real coordinate (see geo_coordinate.ts).
	if (isStudioDefault(toCoordinate(item.lat), toCoordinate(item.lon))) return [];
	// Key order is the PHP JSON literal's: type, properties, geometry.
	return [
		{
			layer_id: 1,
			text: '',
			layer_data: {
				type: 'FeatureCollection',
				features: [
					{
						type: 'Feature',
						properties: {},
						geometry: {
							type: 'Point',
							coordinates: [
								phpNumberFormat16RoundTrip(toCoordinate(item.lon)),
								phpNumberFormat16RoundTrip(toCoordinate(item.lat)),
							],
						},
					},
				],
			},
		},
	];
}

/**
 * component_text_area::get_geojson_data (:1612-1665): the paired
 * component_geolocation's lib_data layers kept VERBATIM as
 * [{layer_id, text:'', layer_data}] (build_geolocation_data geojson=true,
 * :1765-1799 — text is always '', v5 diffusion format parity); when lib_data
 * is absent, the single-point fallback above. [] when nothing resolves.
 */
export function buildGeojsonLayers(geoItems: unknown[] | null): GeojsonLayer[] {
	const first = (geoItems ?? [])[0] as StoredGeolocationItem | undefined;
	const libData = first?.lib_data;
	if (Array.isArray(libData) && libData.length > 0) {
		return libData.map((layer) => ({
			layer_id: layer?.layer_id ?? null,
			text: '' as const,
			layer_data: layer?.layer_data ?? null,
		}));
	}
	return geojsonPointFallbackLayers(first);
}

// ---------------------------------------------------------------------------
// get_diffusion_iconography — separators + join semantics
// ---------------------------------------------------------------------------

/** The ddo options with PHP defaults (class.component_portal.php :479-482). */
export interface IconographyOptions {
	innerTipo: string;
	termSeparator: string;
	fieldsSeparator: string;
	sceneSeparator: string;
}

/**
 * THE ONE INSTALL-NAMED CONSTANT IN THE ENGINE, and it is inherited, not chosen.
 *
 * PHP's component_portal (:479-482) defaults `inner_relation` to this literal —
 * a component of the `numisdata` installation, meaningful nowhere else. On any
 * other install a ddo that omits `inner_relation` therefore reads a component
 * that does not exist and resolves NOTHING, silently.
 *
 * It is kept, named, and ledgered rather than deleted because removing it is a
 * WIRE change: the only element known to use `get_diffusion_iconography` is that
 * installation's, and if its ddo relies on the implicit default, dropping it
 * would empty a published column. The durable fix is on the ONTOLOGY side — that
 * ddo declares `inner_relation` explicitly — after which this constant, and the
 * baseline entry naming it, both go.
 */
const PHP_DEFAULT_INNER_RELATION = 'numisdata722';

/** Read the fn ddo's options, PHP defaults applied. */
export function iconographyOptionsOf(ddo: Record<string, unknown> | undefined): IconographyOptions {
	return {
		innerTipo:
			typeof ddo?.inner_relation === 'string' ? ddo.inner_relation : PHP_DEFAULT_INNER_RELATION,
		termSeparator: typeof ddo?.term_separator === 'string' ? ddo.term_separator : ' | ',
		fieldsSeparator: typeof ddo?.fields_separator === 'string' ? ddo.fields_separator : ', ',
		sceneSeparator: typeof ddo?.scene_separator === 'string' ? ddo.scene_separator : ' | ',
	};
}

/**
 * The per-lang join (PHP :503-521): within a term the resolved value list is
 * imploded by term_separator (a null term value still contributes its EMPTY
 * string — PHP `!empty([null])` is true and `implode` of [null] is ''); terms
 * of one scene join by fields_separator (scenes with NO terms are skipped);
 * scenes join by scene_separator. Null when no scene produced anything.
 */
export function joinIconographyScenes(
	sceneTermValues: (string | null)[][],
	options: IconographyOptions,
): string | null {
	const scenes: string[] = [];
	for (const termValues of sceneTermValues) {
		const terms: string[] = [];
		for (const value of termValues) {
			// get_locator_value always returns a one-element array here
			// (show_parents=false): implode(term_sep, [v]) === v ?? ''.
			terms.push(value ?? '');
		}
		if (terms.length > 0) scenes.push(terms.join(options.fieldsSeparator));
	}
	return scenes.length > 0 ? scenes.join(options.sceneSeparator) : null;
}
