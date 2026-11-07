/**
 * A MAP SOURCE — one entry of `sources` on a component_geolocation entry
 * (WC-2026-11-06-geolocation-map-sources-legend): the description of a tile
 * service the editor draws the map over. It is DATA the server reads, never code
 * and never a URL the browser fetches: the client names a source by id and the
 * tile proxy builds the upstream request itself, from this record alone.
 *
 *   { id, type: 'xyz' | 'wms', url, params, attribution }
 *
 *   id           a positive integer, minted by the SERVER from the component's
 *                item counter on save (entry_gate.ts) — unique across the
 *                component value, never reused. Here it is only SHAPE-checked
 *                (absent, or a positive integer): whether a number is honoured,
 *                is a copy or is new is the save gate's judgement, because only
 *                it knows what the record stores.
 *   type         'xyz' — a `{z}/{x}/{y}` tile template; 'wms' — an OGC WMS
 *                endpoint the proxy asks for GetMap images of a tile's bbox.
 *   url          map_source_url.ts: http(s) only, no credentials, no private
 *                literal; xyz carries {z},{x},{y}, wms carries none.
 *   params       per type, CLOSED (an unknown key is refused, not dropped):
 *                  xyz  `min_zoom?`, `max_zoom?` — integers 0..22, min <= max;
 *                  wms  `version`, `layers`, `styles`, `format`, `transparent`,
 *                       `crs` — the six values the server needs to ask GetMap.
 *                       The server fixes `service=WMS&request=GetMap` and takes
 *                       bbox/width/height from the tile request; none of those
 *                       is stored.
 *   attribution  PLAIN TEXT, at most 300 characters. `<` and `>` are refused
 *                outright: Leaflet's attribution control renders HTML, so a
 *                client that hands it the attribution reaches an HTML sink, and
 *                text that cannot open a tag is inert there (as element content —
 *                quotes stay legal, so it is NOT inert built into an attribute
 *                string). That control is the ONE sanctioned HTML sink for a map
 *                definition, which is why the rule is held twice: at save (this
 *                validator) and where the sources are SERVED (`servedMapSources`
 *                below), because bytes reach the column without the save gate.
 *
 * The validator NORMALIZES (trimmed strings, `transparent` and `styles` filled,
 * `layers` re-joined) and returns a fresh object; it never mutates its input.
 */

import {
	allOk,
	type Checked,
	checkPlainText,
	checkPositiveInteger,
	fail,
	isRecord,
	pass,
	strayKey,
} from './checked.ts';
import { checkSourceUrl } from './map_source_url.ts';

export const MAP_SOURCE_TYPES = ['wms', 'xyz'] as const;
export type MapSourceType = (typeof MAP_SOURCE_TYPES)[number];

export const WMS_VERSIONS = ['1.1.1', '1.3.0'] as const;
export type WmsVersion = (typeof WMS_VERSIONS)[number];

/** The image formats a tile proxy serves — the same four it accepts back. */
export const WMS_FORMATS = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export type WmsFormat = (typeof WMS_FORMATS)[number];

/**
 * The CRS allowlist. Deliberately narrow: these are the geographic/web-mercator
 * systems a Leaflet client can compute a bbox for without a projection library.
 * Widening it is one line here plus a wire-contract addendum; narrowing it later
 * would orphan stored sources.
 */
export const WMS_CRS = ['EPSG:3857', 'EPSG:4326', 'EPSG:4258'] as const;
export type WmsCrs = (typeof WMS_CRS)[number];

export const MAP_SOURCE_LIMITS = {
	/** Sources per entry. */
	maxSources: 24,
	maxAttribution: 300,
	/** Characters of the whole `layers` / `styles` list. */
	maxLayerList: 512,
	maxLayerCount: 32,
	maxLayerToken: 128,
	maxZoom: 22,
} as const;

export interface WmsParams {
	version: WmsVersion;
	layers: string;
	styles: string;
	format: WmsFormat;
	transparent: boolean;
	crs: WmsCrs;
}

export interface XyzParams {
	min_zoom?: number;
	max_zoom?: number;
}

interface SourceCommon {
	/** Absent on a source that has not been saved yet. */
	id?: number;
	url: string;
	attribution: string;
}

export type MapSourceBody =
	| (SourceCommon & { type: 'wms'; params: WmsParams })
	| (SourceCommon & { type: 'xyz'; params: XyzParams });

/** A SAVED source: the id the proxy request names. */
export type MapSource = MapSourceBody & { id: number };

const SOURCE_KEYS = ['id', 'type', 'url', 'params', 'attribution'] as const;
const WMS_PARAM_KEYS = ['version', 'layers', 'styles', 'format', 'transparent', 'crs'] as const;
const XYZ_PARAM_KEYS = ['min_zoom', 'max_zoom'] as const;

/** A layer/style name: letters, digits and `_ . : / -` and space. No `& # % ? = ;` and no markup. */
const LAYER_TOKEN = /^[\p{L}\p{N}_.:/ -]+$/u;

/** `value` is one of the closed `options`. */
function oneOf<T extends string>(options: readonly T[], raw: unknown, where: string): Checked<T> {
	const match = options.find((option) => option === raw);
	return match === undefined ? fail(`${where}: must be one of ${options.join(', ')}`) : pass(match);
}

/** The optional `id`: absent (undefined/null) or a positive integer. */
function checkSourceId(raw: unknown, where: string): Checked<number | undefined> {
	if (raw === undefined || raw === null) return pass(undefined);
	return checkPositiveInteger(raw, `${where}.id`);
}

/** One comma-separated name list (`layers`, `styles`): bounded, every token on the allowlist. */
function checkNameList(raw: unknown, where: string, allowEmptyItems: boolean): Checked<string> {
	if (typeof raw !== 'string') return fail(`${where}: must be a string`);
	if (raw.length > MAP_SOURCE_LIMITS.maxLayerList) {
		return fail(`${where}: longer than ${MAP_SOURCE_LIMITS.maxLayerList} characters`);
	}
	const tokens = raw.split(',').map((token) => token.trim());
	if (tokens.length > MAP_SOURCE_LIMITS.maxLayerCount) {
		return fail(`${where}: more than ${MAP_SOURCE_LIMITS.maxLayerCount} names`);
	}
	const bad = tokens.find(
		(token) =>
			token.length > MAP_SOURCE_LIMITS.maxLayerToken ||
			(token === '' ? !allowEmptyItems : !LAYER_TOKEN.test(token)),
	);
	return bad === undefined
		? pass(tokens.join(','))
		: fail(`${where}: contains an unsupported name`);
}

function checkTransparent(raw: unknown, where: string): Checked<boolean> {
	if (raw === undefined) return pass(false);
	return typeof raw === 'boolean' ? pass(raw) : fail(`${where}: must be true or false`);
}

/** The six WMS values. `styles` and `transparent` default; the other four are required. */
function checkWmsParams(raw: unknown, where: string): Checked<WmsParams> {
	if (!isRecord(raw)) return fail(`${where}: must be an object`);
	const stray = strayKey(raw, WMS_PARAM_KEYS);
	if (stray !== null) return fail(`${where}: unknown key ${JSON.stringify(stray).slice(0, 60)}`);
	const parts = allOk([
		oneOf(WMS_VERSIONS, raw.version, `${where}.version`),
		checkNameList(raw.layers, `${where}.layers`, false),
		checkNameList(raw.styles ?? '', `${where}.styles`, true),
		oneOf(WMS_FORMATS, raw.format, `${where}.format`),
		checkTransparent(raw.transparent, `${where}.transparent`),
		oneOf(WMS_CRS, raw.crs, `${where}.crs`),
	] as const);
	if (!parts.ok) return parts;
	const [version, layers, styles, format, transparent, crs] = parts.value;
	return pass({ version, layers, styles, format, transparent, crs });
}

/** One optional zoom bound, an integer 0..maxZoom. */
function checkZoom(raw: unknown, where: string): Checked<number | undefined> {
	if (raw === undefined) return pass(undefined);
	const valid = typeof raw === 'number' && Number.isInteger(raw);
	if (!valid || raw < 0 || raw > MAP_SOURCE_LIMITS.maxZoom) {
		return fail(`${where}: must be an integer from 0 to ${MAP_SOURCE_LIMITS.maxZoom}`);
	}
	return pass(raw);
}

/** The two bounds as `params`: only the ones given, and min never above max. */
function zoomRange(
	min: number | undefined,
	max: number | undefined,
	where: string,
): Checked<XyzParams> {
	if (min !== undefined && max !== undefined && min > max) {
		return fail(`${where}: min_zoom is above max_zoom`);
	}
	const params: XyzParams = {};
	if (min !== undefined) params.min_zoom = min;
	if (max !== undefined) params.max_zoom = max;
	return pass(params);
}

/** `{}` or `{min_zoom?, max_zoom?}`; an absent `params` is `{}`. */
function checkXyzParams(raw: unknown, where: string): Checked<XyzParams> {
	if (raw === undefined || raw === null) return pass({});
	if (!isRecord(raw)) return fail(`${where}: must be an object`);
	const stray = strayKey(raw, XYZ_PARAM_KEYS);
	if (stray !== null) return fail(`${where}: unknown key ${JSON.stringify(stray).slice(0, 60)}`);
	const bounds = allOk([
		checkZoom(raw.min_zoom, `${where}.min_zoom`),
		checkZoom(raw.max_zoom, `${where}.max_zoom`),
	] as const);
	return bounds.ok ? zoomRange(bounds.value[0], bounds.value[1], where) : bounds;
}

/** Attribution: plain text, never markup (see the header). */
function checkAttribution(raw: unknown, where: string): Checked<string> {
	return checkPlainText(raw ?? '', where, MAP_SOURCE_LIMITS.maxAttribution, true);
}

/** The record shell: an object, no stray key, a known type. */
function checkSourceFrame(
	raw: unknown,
	where: string,
): Checked<{ source: Record<string, unknown>; type: MapSourceType }> {
	if (!isRecord(raw)) return fail(`${where}: must be an object`);
	const stray = strayKey(raw, SOURCE_KEYS);
	if (stray !== null) return fail(`${where}: unknown key ${JSON.stringify(stray).slice(0, 60)}`);
	const type = oneOf(MAP_SOURCE_TYPES, raw.type, `${where}.type`);
	return type.ok ? pass({ source: raw, type: type.value }) : type;
}

/**
 * Validate one source (saved or not). Returns the NORMALIZED body — `id` only
 * when the input carried one. Pure; the input is not touched.
 */
export function validateMapSource(raw: unknown, where: string): Checked<MapSourceBody> {
	const frame = checkSourceFrame(raw, where);
	if (!frame.ok) return frame;
	const { source, type } = frame.value;
	const parts = allOk([
		checkSourceId(source.id, where),
		checkSourceUrl(type, source.url, `${where}.url`),
		type === 'wms'
			? checkWmsParams(source.params, `${where}.params`)
			: checkXyzParams(source.params, `${where}.params`),
		checkAttribution(source.attribution, `${where}.attribution`),
	] as const);
	if (!parts.ok) return parts;
	const [id, url, params, attribution] = parts.value;
	const body = { ...(id === undefined ? {} : { id }), type, url, params, attribution };
	return pass(body as MapSourceBody);
}

/**
 * The shell of a `sources` array: an array, within the per-entry cap. The one
 * check both the list validator below and the save gate (entry_gate.ts, which
 * judges the elements itself, with their ids) make before looking at an element.
 */
export function checkSourceList(raw: unknown, where: string): Checked<readonly unknown[]> {
	if (!Array.isArray(raw)) return fail(`${where}: must be an array`);
	if (raw.length > MAP_SOURCE_LIMITS.maxSources) {
		return fail(`${where}: more than ${MAP_SOURCE_LIMITS.maxSources} sources`);
	}
	return pass(raw);
}

/**
 * Validate the `sources` array of one entry: bounded, every source valid; first
 * failure wins with its path. IDS ARE NOT JUDGED HERE — an id is a fact about a
 * record (which numbers it stores, which are already claimed), and the one place
 * that knows is the save gate: the same number twice, an unknown number, a
 * number from another record are all its decisions (geo/entry_gate.ts). This
 * list check is for the doors that hold a value before it has a record (the
 * import conform) and only needs each element to be a well-formed source.
 */
export function validateMapSources(raw: unknown, where: string): Checked<MapSourceBody[]> {
	const list = checkSourceList(raw, where);
	if (!list.ok) return list;
	const out: MapSourceBody[] = [];
	for (const [index, item] of list.value.entries()) {
		const checked = validateMapSource(item, `${where}[${index}]`);
		if (!checked.ok) return checked;
		out.push(checked.value);
	}
	return pass(out);
}

// ---------------------------------------------------------------------------
// SERVING — the sources as they may leave the server
// ---------------------------------------------------------------------------

/** `source` as it may leave the server: the same object, or a copy whose attribution is blanked. */
function servedSource(source: Record<string, unknown>): Record<string, unknown> {
	const attribution = source.attribution;
	if (attribution === undefined || checkAttribution(attribution, 'attribution').ok) return source;
	return { ...source, attribution: '' };
}

/**
 * The stored `sources` of an entry as they may LEAVE THE SERVER for a browser (the
 * second layer of the posture the legend has, map_legend.ts — and for the same
 * reason: the save gate trusts a source equal to the stored one, and a Time
 * Machine restore, a bulk revert and an archive restore write the column without
 * it, so pre-gate or restored bytes can hold anything).
 *
 * What a browser does with a source is name it by id and draw its `attribution`
 * through Leaflet's attribution control, an HTML sink. So the attribution is the
 * one field re-judged here: one that fails today's rule (markup, control
 * characters, over the cap, not a string) is served BLANK. Nothing else is touched
 * and no source is dropped for another reason — the browser never fetches `url`
 * (the proxy re-validates it at fetch time), and dropping a legacy-but-trusted
 * source here would let the next save, which REPLACES the entry, delete what the
 * operator never asked to delete. Elements that are not objects cannot be drawn
 * and are dropped. Null when nothing is left to serve.
 *
 * Pure; the stored value is never touched.
 */
export function servedMapSources(stored: unknown): Record<string, unknown>[] | null {
	if (!Array.isArray(stored)) return null;
	const served = stored.filter(isRecord).map(servedSource);
	return served.length === 0 ? null : served;
}
