/**
 * The LEGEND of a component_geolocation entry — `legend` beside `sources`
 * (WC-2026-11-06-geolocation-map-sources-legend):
 *
 *   { title, groups: [ { name, symbols: [ { label, icon? } ] } ] }
 *
 * It is what the editor wants a reader to understand about the drawing: a title,
 * named groups, and per symbol a label and — optionally — a small raster icon.
 *
 * ICONS are the only thing here that is not text, so they are the only thing
 * with a hard security posture. An icon is a `data:` URI of a RASTER format —
 * png, jpeg or webp, base64 — and nothing else: never svg (a document with a
 * script engine), never a URL (the browser would fetch it — the very thing the
 * tile proxy exists to avoid). The MIME the URI declares is checked against the
 * file's own header (geo/icon_image.ts), so a `data:image/png` whose payload is
 * markup is refused. Sizes are capped per icon and per legend, because the legend
 * rides in the record's `geo` column — in BYTES (what travels) and in PIXELS
 * (what the viewer's browser decodes: a few kilobytes of PNG can declare a
 * gigabyte of bitmap, so the header's width and height are bounded too, per icon
 * and for the legend's icons together).
 *
 * THREE LAYERS hold that posture, and none relies on another:
 *   1. SAVE  — the item gate (entry_gate.ts) validates every legend that changed.
 *   2. SERVE — `servedMapLegend` below re-validates a legend on its way out to a
 *      browser and drops what no longer conforms, because bytes reach the column
 *      WITHOUT the save gate: a Time Machine restore and a bulk revert write the
 *      recorded value back directly, an archive restore binds the archived text
 *      verbatim (archive/restore.ts), and the gate itself trusts a legend equal to
 *      the stored one. The serving door is the geolocation emit hook
 *      (components/component_geolocation/emit.ts → geo/entry_siblings.ts).
 *   3. SINK  — the client renders an icon ONLY as the `src` of an `<img>`, and a
 *      label/title/name ONLY as text, never into an HTML string. That is a rule
 *      about client code, which no server-side validator can enforce, so its gate
 *      is a scan of the geolocation client files (test/unit/
 *      geo_contract_guards_native.test.ts): any file that touches a legend or
 *      source value may not use an HTML-string sink at all, and a Leaflet option
 *      that takes HTML (`attribution`, `bindPopup`, `divIcon({html})`) may not be
 *      fed from one; a layer-control name or attribution-control text only through
 *      the client's escaper. A scan is a heuristic — it holds the client to the rule
 *      line by line, it does not prove the rule — which is why layers 1 and 2 never
 *      lean on it.
 *
 * Text (title, names, labels) is rendered as text by contract; a value that
 * reads as the START OF A TAG (`<img`, `</`, `<!`, `<?`) is refused anyway, so
 * a client that slips and puts it into an HTML string as ELEMENT CONTENT still
 * gets inert text. That is the whole of the promise: quotes are legal (a label
 * may say `5" pipe`), so the same text built into an ATTRIBUTE value
 * (`title="${label}"`) is NOT inert — the client rule is that text goes to
 * `textContent`/a text node, never into an HTML string of either kind. A bare
 * `< 50 m` stays legal — legends say that.
 *
 * Pure; the input is never mutated.
 */

import { allOk, type Checked, checkText, fail, isRecord, pass, strayKey } from './checked.ts';
import { hasNoLegendContent } from './geo_entry_keys.ts';
import { type IconSize, type RasterFormat, rasterSize } from './icon_image.ts';

export const LEGEND_LIMITS = {
	maxTitle: 200,
	maxGroups: 16,
	maxName: 200,
	maxSymbolsPerGroup: 64,
	maxLabel: 200,
	/** Characters of ONE icon data URI (64 KiB). */
	maxIconChars: 64 * 1024,
	/** Characters of every icon URI of one legend together (256 KiB). */
	maxIconCharsTotal: 256 * 1024,
	/**
	 * Width and height of ONE icon, in pixels. A legend symbol is a small glyph;
	 * 256 is well past any real one and keeps a single icon under 256 KiB of RGBA.
	 */
	maxIconSide: 256,
	/**
	 * Pixels of every icon of one legend together (1 Mpx: 4 MiB once decoded — a
	 * full legend of 32 x 32 glyphs, or sixteen at the 256 x 256 ceiling).
	 */
	maxIconPixelsTotal: 1024 * 1024,
} as const;

/**
 * The most TEXT characters one valid legend can carry — the title, every group name and every
 * symbol label at their caps (200 + 16 x (200 + 64 x 200) = 208,200). Not a cap of its own: the
 * per-field caps already imply it. The per-value budget of the save gate (entry_gate.ts) is
 * written in it.
 */
export const LEGEND_TEXT_CHARS_MAX =
	LEGEND_LIMITS.maxTitle +
	LEGEND_LIMITS.maxGroups *
		(LEGEND_LIMITS.maxName + LEGEND_LIMITS.maxSymbolsPerGroup * LEGEND_LIMITS.maxLabel);

export interface LegendSymbol {
	label: string;
	icon?: string;
}

export interface LegendGroup {
	name: string;
	symbols: LegendSymbol[];
}

export interface MapLegend {
	title: string;
	groups: LegendGroup[];
}

const LEGEND_KEYS = ['title', 'groups'] as const;
const GROUP_KEYS = ['name', 'symbols'] as const;
const SYMBOL_KEYS = ['label', 'icon'] as const;

const ICON_URI = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/;
const TAG_START = /<[A-Za-z/!?]/;

/** An icon data URI taken apart: the declared format and its base64 payload. */
interface IconParts {
	format: RasterFormat;
	payload: string;
}

/** The shell of an icon: a string within the byte cap, a base64 png/jpeg/webp data URI. */
function parseIconUri(raw: unknown, where: string): Checked<IconParts> {
	if (typeof raw !== 'string') return fail(`${where}: must be a string`);
	if (raw.length > LEGEND_LIMITS.maxIconChars) {
		return fail(`${where}: larger than ${LEGEND_LIMITS.maxIconChars} characters`);
	}
	const match = ICON_URI.exec(raw);
	if (match === null || (match[2] as string).length % 4 !== 0) {
		return fail(`${where}: must be a base64 data URI of a png, jpeg or webp image`);
	}
	return pass({ format: match[1] as RasterFormat, payload: match[2] as string });
}

/** Whether a declared size is one a legend icon may have: at least 1 pixel, at most the side cap. */
function sizeAllowed(size: IconSize): boolean {
	const side = LEGEND_LIMITS.maxIconSide;
	return size.width >= 1 && size.height >= 1 && size.width <= side && size.height <= side;
}

/**
 * One icon data URI: raster, base64, within the byte cap, its header agreeing with
 * the declared MIME (geo/icon_image.ts) and declaring at most maxIconSide pixels
 * a side — the bytes do not bound what the browser decodes, the header does.
 */
export function checkIcon(raw: unknown, where: string): Checked<string> {
	const parts = parseIconUri(raw, where);
	if (!parts.ok) return parts;
	const size = rasterSize(parts.value.format, parts.value.payload);
	if (size === null) return fail(`${where}: the image bytes are not the declared format`);
	const side = LEGEND_LIMITS.maxIconSide;
	return sizeAllowed(size)
		? pass(raw as string)
		: fail(`${where}: must be between 1x1 and ${side}x${side} pixels`);
}

/** The pixels a (valid) icon declares; 0 for anything that is not one. */
function iconPixels(icon: string | undefined): number {
	const match = icon === undefined ? null : ICON_URI.exec(icon);
	if (match === null) return 0;
	const size = rasterSize(match[1] as RasterFormat, match[2] as string);
	return size === null ? 0 : size.width * size.height;
}

/** A label/name/title: bounded text that does not open a tag. */
function checkLegendText(
	raw: unknown,
	where: string,
	max: number,
	allowEmpty: boolean,
): Checked<string> {
	const text = checkText(raw ?? '', where, max, allowEmpty);
	if (text.ok && TAG_START.test(text.value))
		return fail(`${where}: must be plain text, not markup`);
	return text;
}

/** The optional icon of a symbol, joined to its label. */
function checkSymbolIcon(raw: unknown, label: string, where: string): Checked<LegendSymbol> {
	if (raw === undefined || raw === null) return pass({ label });
	const icon = checkIcon(raw, `${where}.icon`);
	return icon.ok ? pass({ label, icon: icon.value }) : icon;
}

function checkSymbol(raw: unknown, where: string): Checked<LegendSymbol> {
	if (!isRecord(raw)) return fail(`${where}: must be an object`);
	const stray = strayKey(raw, SYMBOL_KEYS);
	if (stray !== null) return fail(`${where}: unknown key ${JSON.stringify(stray).slice(0, 60)}`);
	const label = checkLegendText(raw.label, `${where}.label`, LEGEND_LIMITS.maxLabel, false);
	return label.ok ? checkSymbolIcon(raw.icon, label.value, where) : label;
}

/** Every element of `raw` through `check`, in order; the first failure wins. */
function checkEach<T>(
	raw: unknown,
	where: string,
	max: number,
	check: (item: unknown, at: string) => Checked<T>,
): Checked<T[]> {
	if (!Array.isArray(raw)) return fail(`${where}: must be an array`);
	if (raw.length > max) return fail(`${where}: more than ${max} entries`);
	const out: T[] = [];
	for (const [index, item] of raw.entries()) {
		const checked = check(item, `${where}[${index}]`);
		if (!checked.ok) return checked;
		out.push(checked.value);
	}
	return pass(out);
}

function checkGroup(raw: unknown, where: string): Checked<LegendGroup> {
	if (!isRecord(raw)) return fail(`${where}: must be an object`);
	const stray = strayKey(raw, GROUP_KEYS);
	if (stray !== null) return fail(`${where}: unknown key ${JSON.stringify(stray).slice(0, 60)}`);
	const parts = allOk([
		checkLegendText(raw.name, `${where}.name`, LEGEND_LIMITS.maxName, false),
		checkEach(raw.symbols ?? [], `${where}.symbols`, LEGEND_LIMITS.maxSymbolsPerGroup, checkSymbol),
	] as const);
	if (!parts.ok) return parts;
	return pass({ name: parts.value[0], symbols: parts.value[1] });
}

/** The characters of the icon of one symbol, whatever shape the symbol has. */
function symbolIconChars(symbol: unknown): number {
	return isRecord(symbol) && typeof symbol.icon === 'string' ? symbol.icon.length : 0;
}

/** The characters of every icon of one group, whatever shape the group has. */
function groupIconChars(group: unknown): number {
	const symbols: unknown[] = isRecord(group) && Array.isArray(group.symbols) ? group.symbols : [];
	return symbols.reduce<number>((total, symbol) => total + symbolIconChars(symbol), 0);
}

/**
 * The characters of every icon URI of `legend` together, for ANY shape: a stored
 * legend is not necessarily a valid one (a bypass door wrote it), and the
 * per-value budget of the save gate (entry_gate.ts) counts it before judging it.
 */
export function legendIconChars(legend: unknown): number {
	if (!isRecord(legend) || !Array.isArray(legend.groups)) return 0;
	const groups: unknown[] = legend.groups;
	return groups.reduce<number>((total, group) => total + groupIconChars(group), 0);
}

/** The length of `value` when it is a string, else 0 (a malformed field counts nothing here). */
function textChars(value: unknown): number {
	return typeof value === 'string' ? value.length : 0;
}

/** The characters of every label of one group, and its name, whatever shape the group has. */
function groupTextChars(group: unknown): number {
	if (!isRecord(group)) return 0;
	const symbols: unknown[] = Array.isArray(group.symbols) ? group.symbols : [];
	return symbols.reduce<number>(
		(total, symbol) => total + (isRecord(symbol) ? textChars(symbol.label) : 0),
		textChars(group.name),
	);
}

/**
 * The TEXT characters of `legend` — title, group names, symbol labels — for ANY shape, as
 * `legendIconChars` counts icons: the per-value budget counts it before judging it.
 */
export function legendTextChars(legend: unknown): number {
	if (!isRecord(legend)) return 0;
	const groups: unknown[] = Array.isArray(legend.groups) ? legend.groups : [];
	return groups.reduce<number>(
		(total, group) => total + groupTextChars(group),
		textChars(legend.title),
	);
}

/** The icon budget of a validated legend: characters, then pixels, together. */
function checkIconBudget(groups: readonly LegendGroup[], where: string): Checked<true> {
	const budget = LEGEND_LIMITS;
	if (legendIconChars({ groups }) > budget.maxIconCharsTotal) {
		return fail(`${where}: icons together larger than ${budget.maxIconCharsTotal} characters`);
	}
	const pixels = groups
		.flatMap((group) => group.symbols)
		.reduce((total, symbol) => total + iconPixels(symbol.icon), 0);
	return pixels > budget.maxIconPixelsTotal
		? fail(`${where}: icons together larger than ${budget.maxIconPixelsTotal} pixels`)
		: pass(true);
}

/**
 * True for a legend that says nothing: no title and no group. ONE rule, shared
 * with the studio-default repair's "does this item carry a map definition"
 * (geo_entry_keys.ts hasNoLegendContent, which also judges a RAW stored legend).
 */
export function isEmptyLegend(legend: MapLegend): boolean {
	return hasNoLegendContent(legend);
}

/** Validate a `legend`; the normalized legend, or the first reason. */
export function validateMapLegend(raw: unknown, where: string): Checked<MapLegend> {
	if (!isRecord(raw)) return fail(`${where}: must be an object`);
	const stray = strayKey(raw, LEGEND_KEYS);
	if (stray !== null) return fail(`${where}: unknown key ${JSON.stringify(stray).slice(0, 60)}`);
	const parts = allOk([
		checkLegendText(raw.title, `${where}.title`, LEGEND_LIMITS.maxTitle, true),
		checkEach(raw.groups ?? [], `${where}.groups`, LEGEND_LIMITS.maxGroups, checkGroup),
	] as const);
	if (!parts.ok) return parts;
	const [title, groups] = parts.value;
	const budget = checkIconBudget(groups, where);
	return budget.ok ? pass({ title, groups }) : budget;
}

// ---------------------------------------------------------------------------
// SERVING — the legend as it may leave the server
// ---------------------------------------------------------------------------

/** `raw` with every icon `keep` refuses removed — a copy; nothing of `raw` is touched. */
function withIconsWhere(raw: Record<string, unknown>, keep: (icon: unknown) => boolean): unknown {
	const groups = raw.groups;
	if (!Array.isArray(groups)) return raw;
	return {
		...raw,
		groups: groups.map((group) => {
			if (!isRecord(group) || !Array.isArray(group.symbols)) return group;
			return {
				...group,
				symbols: group.symbols.map((symbol) => {
					if (!isRecord(symbol) || symbol.icon === undefined || keep(symbol.icon)) return symbol;
					const { icon: _dropped, ...rest } = symbol;
					return rest;
				}),
			};
		}),
	};
}

/**
 * A stored `legend` as it may LEAVE THE SERVER for a map (see the header, layer 2).
 * Returns the legend to serve, or null when there is nothing safe to serve.
 *
 * Re-validated with today's rules, in widening steps, and the first that passes is
 * served: the legend as stored (the normal case — and what a save echoes back);
 * else with every icon that fails the icon rules dropped (a restored or legacy
 * `data:image/svg+xml`, a URL, a payload that is not the declared image); else
 * with ALL icons dropped (a set that together outgrew the cap). Text that breaks
 * the text rules (a label that opens a tag) is not repaired: the legend is not
 * served. An empty result is null. Pure; the stored value is never touched.
 *
 * It does not rewrite the record: the client loads the served legend, and the
 * next save (REPLACE semantics) stores the clean one — the stored bytes heal when
 * an editor next saves, never silently.
 */
export function servedMapLegend(stored: unknown): MapLegend | null {
	if (!isRecord(stored)) return null;
	const candidates: unknown[] = [
		stored,
		withIconsWhere(stored, (icon) => checkIcon(icon, 'icon').ok),
		withIconsWhere(stored, () => false),
	];
	for (const candidate of candidates) {
		const checked = validateMapLegend(candidate, 'legend');
		if (checked.ok) return isEmptyLegend(checked.value) ? null : checked.value;
	}
	return null;
}
