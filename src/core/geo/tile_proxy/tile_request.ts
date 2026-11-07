/**
 * THE QUERY OF A TILE REQUEST — what the browser may say to the tile proxy
 * (`api/map_tile.ts`), and nothing else.
 *
 * The request NEVER carries a URL, a host, a header or a credential. It names a
 * source the server already holds, in one of three CLOSED shapes, and the place
 * on the map it wants:
 *
 *   stored   section_tipo, section_id, component_tipo, source_id
 *            a source stored in the record's own geolocation value
 *   default  section_tipo, component_tipo, default_id
 *            an ontology default (`properties.map_sources` of the component node)
 *   builtin  section_tipo, component_tipo, builtin
 *            an entry of the core's closed registry (builtin_sources.ts)
 *
 *   + a VIEW:   z, x, y                     a slippy-map tile (xyz sources, and wms
 *                                           sources, whose bbox the SERVER computes)
 *          or   bbox, width, height         a free GetMap image (wms sources only):
 *                                           bbox = minx,miny,maxx,maxy with x the
 *                                           easting / longitude — the server swaps the
 *                                           axes for the CRSs and versions that ask
 *                                           for it
 *
 * The grammar is closed in three ways: a key outside the shape's list is refused
 * (a template language the server does not implement is a hole, so is a parameter
 * it ignores), a key given twice is refused (which one wins differs between
 * parsers), and every value must match its pattern in full. The identifiers are the
 * same grammars the rest of the engine uses (`isValidTipo`; a positive integer id).
 *
 * PURE. A reason names a PARAMETER and never quotes its value (geo/checked.ts).
 */

import { isValidTipo } from '../../concepts/ontology.ts';
import { type Checked, fail, pass } from '../checked.ts';
import { MAP_SOURCE_LIMITS } from '../map_source.ts';

/** The most a free GetMap image may measure on one side, in pixels. */
export const MAX_IMAGE_SIDE = 1024;

/** A tile is always this many pixels square (slippy-map convention). */
export const TILE_PX = 256;

/** Largest id Postgres' `integer` section_id column can hold. */
const MAX_ID = 2_147_483_647;

/** Names of the default / builtin identifiers: the engine's one grammar (map_source_defaults.ts). */
const NAME = /^[a-z][a-z0-9_]{0,47}$/;
/** A whole number without leading zeros. */
const DIGITS = /^(?:0|[1-9][0-9]{0,9})$/;
/** A plain decimal: no exponent, no plus sign, no hex, no spaces. */
const DECIMAL = /^-?[0-9]{1,9}(?:\.[0-9]{1,12})?$/;

export type TileRef =
	| {
			readonly kind: 'stored';
			readonly sectionTipo: string;
			readonly sectionId: number;
			readonly componentTipo: string;
			readonly sourceId: number;
	  }
	| {
			readonly kind: 'default';
			readonly sectionTipo: string;
			readonly componentTipo: string;
			readonly defaultId: string;
	  }
	| {
			readonly kind: 'builtin';
			readonly sectionTipo: string;
			readonly componentTipo: string;
			readonly builtinId: string;
	  };

/** The bbox as the request wrote it: minx, miny, maxx, maxy (x = easting / longitude). */
export type Bbox = readonly [number, number, number, number];

export type TileView =
	| { readonly kind: 'tile'; readonly z: number; readonly x: number; readonly y: number }
	| {
			readonly kind: 'image';
			readonly bbox: Bbox;
			readonly width: number;
			readonly height: number;
	  };

export interface TileRequest {
	readonly ref: TileRef;
	readonly view: TileView;
}

type Shape = TileRef['kind'];
type Values = ReadonlyMap<string, string>;

/** The keys of each source shape, and the key that DISCRIMINATES it. */
const SHAPES: Readonly<Record<Shape, { keys: readonly string[]; discriminator: string }>> = {
	stored: {
		keys: ['section_tipo', 'section_id', 'component_tipo', 'source_id'],
		discriminator: 'source_id',
	},
	default: { keys: ['section_tipo', 'component_tipo', 'default_id'], discriminator: 'default_id' },
	builtin: { keys: ['section_tipo', 'component_tipo', 'builtin'], discriminator: 'builtin' },
};
const SHAPE_NAMES = Object.keys(SHAPES) as Shape[];
const TILE_KEYS = ['z', 'x', 'y'] as const;
const IMAGE_KEYS = ['bbox', 'width', 'height'] as const;

/** Every key the grammar knows — anything else is refused. */
const KNOWN_KEYS: ReadonlySet<string> = new Set([
	...SHAPE_NAMES.flatMap((shape) => SHAPES[shape].keys),
	...TILE_KEYS,
	...IMAGE_KEYS,
]);

/** The values by key, or a reason when a key is unknown or repeats. */
function singleValues(params: URLSearchParams): Checked<Values> {
	const values = new Map<string, string>();
	for (const key of params.keys()) {
		if (!KNOWN_KEYS.has(key)) return fail('an unknown parameter');
		if (values.has(key)) return fail(`${key}: given more than once`);
		values.set(key, params.get(key) ?? '');
	}
	return pass(values);
}

/** A whole number from digits (no leading zeros), or a reason. */
function checkWhole(raw: string | undefined, where: string): Checked<number> {
	if (raw === undefined || !DIGITS.test(raw)) return fail(`${where}: must be a whole number`);
	return pass(Number(raw));
}

/** A positive integer id, or a reason. */
function checkId(raw: string | undefined, where: string): Checked<number> {
	const whole = checkWhole(raw, where);
	if (!whole.ok) return whole;
	return whole.value >= 1 && whole.value <= MAX_ID ? whole : fail(`${where}: out of range`);
}

function checkTipo(raw: string | undefined, where: string): Checked<string> {
	return raw !== undefined && isValidTipo(raw) ? pass(raw) : fail(`${where}: not a valid tipo`);
}

function checkName(raw: string | undefined, where: string): Checked<string> {
	return raw !== undefined && NAME.test(raw) ? pass(raw) : fail(`${where}: not a valid name`);
}

/** Which source shape the keys select: exactly one discriminator may be present. */
function shapeOf(values: Values): Shape | null {
	const selected = SHAPE_NAMES.filter((shape) => values.has(SHAPES[shape].discriminator));
	return selected.length === 1 ? (selected[0] ?? null) : null;
}

/** The keys present are exactly `allowed`: every one required, none extra. */
function hasExactly(values: Values, allowed: readonly string[]): boolean {
	return allowed.length === values.size && allowed.every((key) => values.has(key));
}

/** The source shape and the view kind the keys select, with the key set checked exactly. */
function selection(values: Values): Checked<{ shape: Shape; view: 'tile' | 'image' }> {
	const shape = shapeOf(values);
	if (shape === null) return fail('the source: name exactly one of source_id, default_id, builtin');
	const tile = TILE_KEYS.every((key) => values.has(key));
	const image = IMAGE_KEYS.every((key) => values.has(key));
	if (tile === image) return fail('the view: give z, x, y OR bbox, width, height');
	const viewKeys = tile ? TILE_KEYS : IMAGE_KEYS;
	if (!hasExactly(values, [...SHAPES[shape].keys, ...viewKeys])) {
		return fail('the parameters do not fit the source and view they select');
	}
	return pass({ shape, view: tile ? 'tile' : 'image' });
}

/** The two tipos every shape names. */
function parseTipos(values: Values): Checked<{ sectionTipo: string; componentTipo: string }> {
	const sectionTipo = checkTipo(values.get('section_tipo'), 'section_tipo');
	if (!sectionTipo.ok) return sectionTipo;
	const componentTipo = checkTipo(values.get('component_tipo'), 'component_tipo');
	if (!componentTipo.ok) return componentTipo;
	return pass({ sectionTipo: sectionTipo.value, componentTipo: componentTipo.value });
}

function parseStored(base: { sectionTipo: string; componentTipo: string }, values: Values) {
	const sectionId = checkId(values.get('section_id'), 'section_id');
	if (!sectionId.ok) return sectionId;
	const sourceId = checkId(values.get('source_id'), 'source_id');
	if (!sourceId.ok) return sourceId;
	const ref: TileRef = {
		kind: 'stored',
		...base,
		sectionId: sectionId.value,
		sourceId: sourceId.value,
	};
	return pass(ref);
}

function parseDefault(base: { sectionTipo: string; componentTipo: string }, values: Values) {
	const defaultId = checkName(values.get('default_id'), 'default_id');
	if (!defaultId.ok) return defaultId;
	const ref: TileRef = { kind: 'default', ...base, defaultId: defaultId.value };
	return pass(ref);
}

function parseBuiltin(base: { sectionTipo: string; componentTipo: string }, values: Values) {
	const builtinId = checkName(values.get('builtin'), 'builtin');
	if (!builtinId.ok) return builtinId;
	const ref: TileRef = { kind: 'builtin', ...base, builtinId: builtinId.value };
	return pass(ref);
}

/** The ref of a shape whose key set is already known to be exactly the shape's. */
function parseRef(shape: Shape, values: Values): Checked<TileRef> {
	const base = parseTipos(values);
	if (!base.ok) return base;
	if (shape === 'stored') return parseStored(base.value, values);
	return shape === 'default' ? parseDefault(base.value, values) : parseBuiltin(base.value, values);
}

/** x and y inside the 2^z grid, z within the engine's zoom ceiling. */
function gridRefusal(z: number, x: number, y: number): string | null {
	if (z > MAP_SOURCE_LIMITS.maxZoom) return 'z: above the zoom ceiling';
	const grid = 2 ** z;
	return x < grid && y < grid ? null : 'x, y: outside the tile grid of z';
}

/** `z`, `x`, `y` as a tile. */
function parseTile(values: Values): Checked<TileView> {
	const z = checkWhole(values.get('z'), 'z');
	const x = checkWhole(values.get('x'), 'x');
	const y = checkWhole(values.get('y'), 'y');
	if (!z.ok) return z;
	if (!x.ok) return x;
	if (!y.ok) return y;
	const refusal = gridRefusal(z.value, x.value, y.value);
	if (refusal !== null) return fail(refusal);
	return pass({ kind: 'tile', z: z.value, x: x.value, y: y.value });
}

/** One side of a free image: 1 to the ceiling. */
function checkSide(raw: string | undefined, where: string): Checked<number> {
	const side = checkWhole(raw, where);
	if (!side.ok) return side;
	return side.value >= 1 && side.value <= MAX_IMAGE_SIDE
		? side
		: fail(`${where}: from 1 to ${MAX_IMAGE_SIDE} pixels`);
}

/** `bbox` as four plain decimals. */
function parseBbox(raw: string | undefined): Checked<Bbox> {
	const parts = (raw ?? '').split(',');
	if (parts.length !== 4 || !parts.every((part) => DECIMAL.test(part))) {
		return fail('bbox: must be four plain decimals, minx,miny,maxx,maxy');
	}
	const [minx, miny, maxx, maxy] = parts.map(Number) as [number, number, number, number];
	return pass([minx, miny, maxx, maxy] as const);
}

/** `bbox`, `width` and `height` as a free image. */
function parseImage(values: Values): Checked<TileView> {
	const bbox = parseBbox(values.get('bbox'));
	const width = checkSide(values.get('width'), 'width');
	const height = checkSide(values.get('height'), 'height');
	if (!bbox.ok) return bbox;
	if (!width.ok) return width;
	if (!height.ok) return height;
	return pass({ kind: 'image', bbox: bbox.value, width: width.value, height: height.value });
}

/** The whole request out of a URL's query, or the first reason (which never quotes a value). */
export function parseTileRequest(params: URLSearchParams): Checked<TileRequest> {
	const values = singleValues(params);
	if (!values.ok) return values;
	const chosen = selection(values.value);
	if (!chosen.ok) return chosen;
	const ref = parseRef(chosen.value.shape, values.value);
	if (!ref.ok) return ref;
	const view = chosen.value.view === 'tile' ? parseTile(values.value) : parseImage(values.value);
	return view.ok ? pass({ ref: ref.value, view: view.value }) : view;
}
