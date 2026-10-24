/**
 * Runtime parsers — the single-fn families: iri / geo / info / map.
 * Oracles: diffusion/api/v1/lib/parsers/parser_iri.ts, parser_geo.ts,
 * parser_info.ts, parser_map.ts (behavior parity).
 */

import { stripTags } from '../../core/resolve/html_text.ts';
import {
	hasCoordinate,
	isStudioDefault,
	phpNumberFormat16RoundTrip,
	toCoordinate,
} from '../resolve/geo_coordinate.ts';
import type { ItemParserFn, ParserItem } from './types.ts';

// ---------------------------------------------------------------------------
// parser_iri::flat
// ---------------------------------------------------------------------------

/** Stored component_iri entry. */
interface IriValue {
	iri?: string | null;
	title?: string | null;
}

/**
 * Joins {iri,title} records into one flat string: "title, iri" per entry
 * (fields_separator between title and iri), entries joined by
 * records_separator. v6 emits one record PER entry even when empty, so two
 * empty iris diffuse as " | " — empties are included as "".
 */
export const iriFlat: ItemParserFn = (items, options) => {
	if (!items || items.length === 0) return null;

	const fieldsSeparator = (options.fields_separator as string) ?? ', ';
	const recordsSeparator = (options.records_separator as string) ?? ' | ';

	const allFormattedEntries: string[] = [];

	for (const item of items) {
		const raw = item.value;
		if (raw === null || raw === undefined) continue;

		const entries: IriValue[] = Array.isArray(raw) ? (raw as IriValue[]) : [raw as IriValue];
		for (const entry of entries) {
			if (!entry || typeof entry !== 'object') continue;

			// NO trim: v6's component_iri::get_diffusion_value (:672-692) pushes
			// resolve_title()'s result and $value->iri VERBATIM, gating each only on
			// PHP empty(). A stored iri ending in a space is published with it
			// (bibliographic_references.ref_publications_url: ".../docs/2014-1 ").
			const iri = entry.iri ?? '';
			const title = entry.title ?? '';

			const formatted = title && iri ? `${title}${fieldsSeparator}${iri}` : iri || title;
			allFormattedEntries.push(formatted);
		}
	}

	if (allFormattedEntries.length === 0) return null;

	const firstItem = items[0] as ParserItem;
	return [
		{
			id: null,
			value: allFormattedEntries.join(recordsSeparator),
			tipo: firstItem.tipo,
			lang: firstItem.lang,
			section_id: firstItem.section_id,
			section_tipo: firstItem.section_tipo,
		},
	];
};

// ---------------------------------------------------------------------------
// parser_geo::geojson
// ---------------------------------------------------------------------------

/** Stored component_geolocation entry. */
interface GeoValue {
	id?: number;
	alt?: number;
	lat?: string | number;
	lon?: string | number;
	zoom?: number;
	lib_data?: GeoLayer[];
}

/** GeoJSON layer as stored in lib_data / emitted by this parser. */
interface GeoLayer {
	layer_id: number;
	text?: string;
	layer_data: object;
}

/**
 * Emits a GeoJSON layer array per item: lib_data with real features passes
 * through as-is; otherwise a Point FeatureCollection is built from lat/lon
 * (comma decimal separators normalized). No sentinel coordinate: absence is
 * structural (geo_coordinate.ts) — see the GEO LAW there.
 */
export const geoGeojson: ItemParserFn = (items) => {
	if (!items || items.length === 0) return null;

	const result: ParserItem[] = [];

	for (const item of items) {
		// Per-item layer scope (oracle DIFFTS-07 fix: no cross-item accumulation)
		const layerArray: GeoLayer[] = [];

		const raw = item.value;
		if (raw === null || raw === undefined) continue;

		const entries: GeoValue[] = Array.isArray(raw) ? (raw as GeoValue[]) : [raw as GeoValue];
		for (const geoObj of entries) {
			if (!geoObj || typeof geoObj !== 'object') continue;

			// lib_data only wins when it actually carries features
			let hasFeatures = false;
			if (geoObj.lib_data && Array.isArray(geoObj.lib_data)) {
				for (const layer of geoObj.lib_data) {
					const ldata = layer.layer_data as { features?: unknown[] } | undefined;
					if (ldata?.features && Array.isArray(ldata.features) && ldata.features.length > 0) {
						hasFeatures = true;
						break;
					}
				}
			}

			if (hasFeatures) {
				layerArray.push(...(geoObj.lib_data as GeoLayer[]));
			} else {
				const layer = buildGeojsonLayer(geoObj);
				if (layer) layerArray.push(layer);
			}
		}

		if (layerArray.length > 0) {
			result.push({ ...item, value: layerArray });
		}
	}

	return result.length > 0 ? result : null;
};

/**
 * lat/lon → single-Point FeatureCollection layer, or null when there is no
 * coordinate. Same predicate as ddo_fns.ts geojsonPointFallbackLayers: the
 * three geo publication paths must agree.
 *
 * The VIEW publishes. lat/lon is the map framing, and for many records it is the
 * only positional data there is, so publication has always read it and consumers
 * depend on that — it is not dropped when the item also carries drawn features.
 *
 * TWO refusals, and only two:
 *  · no coordinate (null/undefined/''), which is absence — 0 is NOT absence, it
 *    is the equator and the prime meridian. The old guard was falsy-based and
 *    silently dropped both.
 *  · the STUDIO DEFAULT, the factory map position the v6 client wrote on save
 *    whether or not anyone touched the map. It is fabricated wherever it
 *    appears, so it never reaches a consumer as a position.
 */
function buildGeojsonLayer(geoObj: GeoValue): GeoLayer | null {
	if (!hasCoordinate(geoObj.lat) || !hasCoordinate(geoObj.lon)) return null;

	const lat = toCoordinate(geoObj.lat);
	const lon = toCoordinate(geoObj.lon);

	if (isStudioDefault(lat, lon)) return null;

	return {
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
						// v6 widens both through number_format(…,16) + json_decode.
						coordinates: [phpNumberFormat16RoundTrip(lon), phpNumberFormat16RoundTrip(lat)], // GeoJSON order: [longitude, latitude]
					},
				},
			],
		},
	};
}

// ---------------------------------------------------------------------------
// parser_info::widget
// ---------------------------------------------------------------------------

/**
 * Filters component_info widget-dato entries ({widget, id|widget_id, value})
 * by parallel widget_name[i]/select[i] pairs and collects their values;
 * options.keys picks positional entries out of the collected list.
 */
export const infoWidget: ItemParserFn = (items, options) => {
	if (!items || items.length === 0) return null;

	const widgetName = (options.widget_name as string[]) ?? [];
	const select = (options.select as string[]) ?? [];
	const keys = (options.keys as number[]) ?? null;

	const collected: unknown[] = [];

	for (const item of items) {
		const dataArray: unknown[] = Array.isArray(item.value) ? item.value : [item.value];

		for (let i = 0; i < widgetName.length; i++) {
			const currentWidgetName = widgetName[i];
			const currentSelect = select[i] ?? null;

			// Widget outputs carry the selector under `widget_id` (legacy under `id`)
			const matched = dataArray.filter((el) => {
				const e = el as { widget?: string; id?: string; widget_id?: string } | null;
				return (
					e?.widget === currentWidgetName &&
					(e?.id === currentSelect || e?.widget_id === currentSelect)
				);
			});

			for (const el of matched) {
				collected.push((el as { value?: unknown }).value);
			}
		}
	}

	if (collected.length === 0) return null;

	const finalValues = keys
		? keys.filter((i) => i < collected.length).map((i) => collected[i])
		: collected;

	const firstItem = items[0] as ParserItem;
	return finalValues.map((v) => ({ ...firstItem, value: v }));
};

// ---------------------------------------------------------------------------
// parser_info::default
// ---------------------------------------------------------------------------

/**
 * Cleans a component_info string value: strips <mark>/</mark> markers and,
 * when options.keys is set, keeps only the record_separator-split parts whose
 * index is listed (rejoined with the same separator). Empty results drop out.
 */
export const infoDefault: ItemParserFn = (items, options) => {
	if (!items || items.length === 0) return null;

	const keys = Array.isArray(options.keys) ? (options.keys as number[]) : null;
	const recordSeparator = (options.record_separator as string) ?? ', ';

	const result: ParserItem[] = [];

	for (const item of items) {
		const raw = item.value;
		if (raw === null || raw === undefined || raw === '') continue;

		let value = typeof raw === 'string' ? raw : String(raw);
		value = value.replace(/<\/?mark>/g, '');
		if (value === '') continue;

		if (keys !== null) {
			const beats = value.split(recordSeparator);
			const selection = beats.filter((_part, index) => keys.includes(index));
			value = selection.join(recordSeparator);
		}
		if (value === '') continue;

		result.push({ ...item, value });
	}

	return result.length > 0 ? result : null;
};

// ---------------------------------------------------------------------------
// parser_map::custom
// ---------------------------------------------------------------------------

/**
 * Builds a JSON array of objects from a map template (relation_list output):
 * items group by originating (section_id, section_tipo) record; each group
 * resolves the matching template row (literal section_tipo match, or the
 * '${section_tipo}'/absent wildcard) by interpolating ${id} placeholders.
 *
 * Repeated ids apply PER-INDEX so "${b}, ${c}" pairs the i-th surname with
 * the i-th name ("Gomez, Élian, Ugolini, Daniela"), index results joined by
 * ", ". A field whose placeholders ALL resolve empty emits null (v6: a
 * publication with no author), and values are strip_tags(trim())-normalized
 * like v6 get_locator_value. Emits ONE item whose value is the object array.
 */
export const mapCustom: ItemParserFn = (items, options) => {
	if (!items || items.length === 0) return null;

	const mapTemplates = options.map as Record<string, unknown>[] | undefined;
	if (!mapTemplates || !Array.isArray(mapTemplates) || mapTemplates.length === 0) return null;

	// 1. Group items by (section_id, section_tipo); collect id → value list
	const groups = new Map<
		string,
		{ section_id: string; section_tipo: string; idMap: Map<string, string[]> }
	>();

	for (const item of items) {
		if (item.id === null || item.id === undefined) continue;

		const sectionId = String(item.section_id ?? '');
		const sectionTipo = String(item.section_tipo ?? '');
		const key = `${sectionId}__${sectionTipo}`;

		if (!groups.has(key)) {
			groups.set(key, { section_id: sectionId, section_tipo: sectionTipo, idMap: new Map() });
		}
		const group = groups.get(key) as { idMap: Map<string, string[]> };
		const raw = item.value;
		// v6 resolves via get_locator_value → strip_tags(trim($value))
		const str = raw !== null && raw !== undefined ? stripTags(String(raw)).trim() : '';
		const idKey = String(item.id);
		if (group.idMap.has(idKey)) {
			(group.idMap.get(idKey) as string[]).push(str);
		} else {
			group.idMap.set(idKey, [str]);
		}
	}

	if (groups.size === 0) return null;

	// 2. Per-index interpolation of one template field
	const interpolate = (tmplValue: string, idMap: Map<string, string[]>): string | null => {
		const idsUsed = [...tmplValue.matchAll(/\$\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1] as string);
		// Literal template (no placeholders, e.g. table:"publications") → verbatim
		if (idsUsed.length === 0) return tmplValue;

		let repeatCount = 1;
		for (const idName of idsUsed) {
			const arr = idMap.get(idName);
			if (arr && arr.length > repeatCount) repeatCount = arr.length;
		}

		const parts: string[] = [];
		let anyValue = false; // did ANY placeholder resolve non-empty?
		for (let i = 0; i < repeatCount; i++) {
			parts.push(
				tmplValue.replace(/\$\{([a-zA-Z0-9_]+)\}/g, (_match, idName: string) => {
					const arr = idMap.get(idName);
					if (!arr || arr.length === 0) return '';
					const v = arr.length === 1 ? (arr[0] ?? '') : (arr[i] ?? '');
					if (v !== '') anyValue = true;
					return v;
				}),
			);
		}
		// All placeholders empty → only template literals remain → null (v6)
		if (!anyValue) return null;
		return parts.join(', ');
	};

	// 3. Resolve each group against its template row
	const resolvedRows: Record<string, string | null>[] = [];

	for (const { section_id, section_tipo, idMap } of groups.values()) {
		// Built-in ids so templates can reference ${section_id}/${section_tipo}
		idMap.set('section_id', [section_id]);
		idMap.set('section_tipo', [section_tipo]);

		const template = mapTemplates.find((tmpl) => {
			const t = tmpl.section_tipo;
			if (!t || t === '${section_tipo}') return true; // wildcard or missing
			return t === section_tipo;
		});
		if (!template) continue;

		// v6 byte-order: section_tipo first, then section_id, then template fields
		const resolved: Record<string, string | null> = { section_tipo, section_id };

		for (const [key, tmplValue] of Object.entries(template)) {
			if (key === 'section_id' || key === 'section_tipo') continue; // already injected
			if (typeof tmplValue !== 'string') {
				resolved[key] = String(tmplValue);
				continue;
			}
			resolved[key] = interpolate(tmplValue, idMap);
		}

		resolvedRows.push(resolved);
	}

	if (resolvedRows.length === 0) return null;

	// 4. One item whose value is the resolved object array (json output downstream)
	const firstItem = items[0] as ParserItem;
	return [
		{
			id: null,
			value: resolvedRows,
			tipo: firstItem.tipo,
			lang: firstItem.lang ?? null,
			section_id: null,
			section_tipo: null,
		},
	];
};
