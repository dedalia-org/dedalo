/**
 * WHAT A CALLER MAY SAY TO A GEO SERVICE, AND NOTHING ELSE.
 *
 * A geo service takes a handful of well-known parameters (a place name, a
 * coordinate, a bounding box, a cadastral reference). This file is the whole
 * vocabulary a caller can use to fill them: each parameter of each service is a
 * CHECK from here — a closed grammar, not a pass-through — and `checkParams`
 * refuses anything the service's table does not name:
 *
 *   - an unknown key (a caller cannot add `format=xml`, or shadow a fixed
 *     parameter the service sets itself);
 *   - a missing required key;
 *   - a value outside its grammar: text with a control or bidi character, a
 *     token off its pattern, a number out of range or not finite, a list of the
 *     wrong length.
 *
 * A check returns the CANONICAL form of the value, or null. The wire text is
 * built from the canonical form only — numbers are re-formatted, tokens are
 * case-folded — so the caller's spelling never reaches the URL, and (with the
 * query assembled by URLSearchParams in `request.ts`) no value can change the
 * URL's structure. A refusal is `request.invalid_data`, thrown BEFORE any
 * socket is opened or any limiter slot is taken; its text names the parameter,
 * never the rejected value.
 *
 * Pure: no I/O, no clock, no state. The checks are built once, at module load, by
 * the constructors below; a pattern that carries the `g` or `y` flag would make
 * `RegExp.test` stateful across calls, so a constructor refuses one loudly.
 *
 * COST BEFORE MEANING. A check that reads text bounds the RAW input before it does any
 * work that grows faster than the input (`text` and `NFC_SHRINK_LIMIT`): the request body
 * can be hundreds of MiB, and a refusal must cost the single event loop a comparison, not
 * seconds of normalization.
 */

import { DedaloError } from '../errors/index.ts';

/** The canonical form of one accepted value. */
export interface CanonicalParam {
	/** What goes on the wire. */
	readonly wire: string;
	/** The caller-facing form: equals `wire` unless the check maps it (`crs` does). */
	readonly key: string;
	/** The numbers behind the value, for the cross-checks (empty for text). */
	readonly numbers: readonly number[];
}

/** A check: the canonical form of a value, or null when the value is not acceptable. */
export type ParamCheck = (value: unknown) => CanonicalParam | null;

/** One parameter of one service. */
export interface ParamDef {
	/** The key the caller writes. */
	readonly name: string;
	/** The key the provider reads (equal to `name` unless the table says otherwise). */
	readonly wire: string;
	readonly required: boolean;
	readonly check: ParamCheck;
}

/** Reads a validated parameter by its caller-facing name. */
export type ParamReader = (name: string) => CanonicalParam | undefined;

/**
 * A check across parameters (a pixel inside the image, a box under a size
 * ceiling). Returns what is wrong, or null; it runs only after every single
 * parameter passed its own check.
 */
export type Refinement = (read: ParamReader) => string | null;

/** An inclusive numeric range. */
export type Range = readonly [min: number, max: number];

/** Control characters, bidi/format characters and line or paragraph separators. */
const FORBIDDEN_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/** A whole number as plain digits, in the safe range of a coordinate or a pixel. */
const INTEGER_TEXT = /^-?\d{1,9}$/;

/** An accepted value whose caller form is its wire form. */
export function plain(wire: string, numbers: readonly number[] = []): CanonicalParam {
	return { wire, key: wire, numbers };
}

/**
 * A number as plain decimal text, 8 places at most (about a millimetre of
 * longitude), never in exponent form — some providers' parsers do not read it.
 */
export function formatNumber(value: number): string {
	if (Math.abs(value) < 1e-8) return '0';
	return value.toFixed(8).replace(/(?:\.0+|(\.\d*?)0+)$/, '$1');
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

function within(value: unknown, range: Range | undefined): value is number {
	return isFiniteNumber(value) && range !== undefined && value >= range[0] && value <= range[1];
}

/**
 * The most NFC can shrink a string: the longest canonical decomposition in Unicode is
 * four UTF-16 units for one (U+1F82 and its kin), so `n` units normalize to at least `n / 4`.
 * A raw string longer than `maxLength` times this can therefore never normalize into a window
 * of `maxLength`, and `text` refuses it BEFORE `normalize()` — which is QUADRATIC on a long run
 * of combining marks whose classes run against canonical order (measured, Bun 1.4.4: 50,001
 * units took 5.7 s, 100,001 took 23 s, all of it synchronous on the one event loop), while the
 * request body may be hundreds of MiB. Driven over every code point by the gate, so a Unicode
 * table that ever grows past it turns red instead of silently refusing good input.
 */
export const NFC_SHRINK_LIMIT = 4;

/**
 * Free text: NFC, trimmed, a length window, no control or bidi character. The raw length is
 * bounded first (see `NFC_SHRINK_LIMIT`): an oversized string costs a trim and a comparison,
 * never a normalization.
 */
export function text(minLength: number, maxLength: number): ParamCheck {
	return (value) => {
		if (typeof value !== 'string') return null;
		const raw = value.trim();
		if (raw.length > maxLength * NFC_SHRINK_LIMIT) return null;
		const trimmed = raw.normalize().trim();
		const sized = trimmed.length >= minLength && trimmed.length <= maxLength;
		return sized && !FORBIDDEN_TEXT.test(trimmed) ? plain(trimmed) : null;
	};
}

/**
 * A test of provider text against a pattern (anchored or not, no `g`/`y` flag), held in a
 * closure. The table holds the function, never the RegExp: a RegExp cannot be made immutable
 * (`compile` rewrites it even when it is frozen), so one reachable from an exported table
 * could be recompiled into another pattern by anyone who imports it.
 */
export function matching(pattern: RegExp): (text: string) => boolean {
	if (pattern.global || pattern.sticky) {
		throw new DedaloError('internal.invariant', {
			message: 'geo services: a text pattern must not carry the g or y flag',
		});
	}
	return (text) => pattern.test(text);
}

/** `value` with its case folded as asked. */
function folded(value: string, fold: 'upper' | 'lower' | 'none'): string {
	if (fold === 'upper') return value.toUpperCase();
	return fold === 'lower' ? value.toLowerCase() : value;
}

/** A token off a pattern (anchored, no `g`/`y` flag), optionally case-folded first. */
export function token(
	pattern: RegExp,
	maxLength: number,
	fold: 'upper' | 'lower' | 'none' = 'none',
): ParamCheck {
	if (pattern.global || pattern.sticky) {
		throw new DedaloError('internal.invariant', {
			message: 'geo services: a token pattern must not carry the g or y flag',
		});
	}
	return (value) => {
		if (typeof value !== 'string') return null;
		const spelled = folded(value.trim(), fold);
		return spelled.length <= maxLength && pattern.test(spelled) ? plain(spelled) : null;
	};
}

/** A string, or a number or boolean read as its text; null for anything else. */
function scalarText(value: unknown): string | null {
	if (typeof value === 'string') return value;
	return typeof value === 'number' || typeof value === 'boolean' ? String(value) : null;
}

/**
 * One of a closed list. A number or a boolean is read as its text (`1` is `'1'`).
 * `wireOf` maps a caller form onto a different wire form (`EPSG:25830` onto the URN
 * a WFS reads); `key` stays the caller form.
 */
export function choice(
	values: readonly string[],
	wireOf: Readonly<Record<string, string>> = {},
): ParamCheck {
	return (value) => {
		const spelled = scalarText(value);
		if (spelled === null || !values.includes(spelled)) return null;
		const wire = Object.hasOwn(wireOf, spelled) ? (wireOf[spelled] as string) : spelled;
		return { wire, key: spelled, numbers: [] };
	};
}

/** A whole number from a number or from plain digits; NaN for anything else. */
function wholeNumber(value: unknown): number {
	if (typeof value === 'number') return value;
	return typeof value === 'string' && INTEGER_TEXT.test(value) ? Number(value) : Number.NaN;
}

/** A whole number in `[min, max]`, given as a number or as plain digits. */
export function integer(min: number, max: number): ParamCheck {
	return (value) => {
		const number = wholeNumber(value);
		if (!Number.isSafeInteger(number) || number < min || number > max) return null;
		return plain(String(number), [number]);
	};
}

/** One finite number in `[min, max]`. */
export function decimal(min: number, max: number): ParamCheck {
	return (value) => (within(value, [min, max]) ? plain(formatNumber(value), [value]) : null);
}

/**
 * A fixed-length list of numbers, each in its own range, joined by commas — a
 * point (`lon,lat`), a bounding box (`minx,miny,maxx,maxy`). The caller's array is
 * copied once, and the copy is what is checked AND written: a getter or a proxy that
 * answers differently the second time cannot make the wire say what the check did not see.
 */
export function numbers(ranges: readonly Range[]): ParamCheck {
	return (value) => {
		if (!Array.isArray(value) || value.length !== ranges.length) return null;
		const copy: unknown[] = Array.from(value);
		if (!copy.every((entry, at) => within(entry, ranges[at]))) return null;
		const list = copy as number[];
		return plain(list.map(formatNumber).join(','), list);
	};
}

/** A latitude/longitude pair, in that order. */
const LAT_LON: readonly Range[] = [
	[-90, 90],
	[-180, 180],
];

/**
 * 1 to `maxPoints` `[lat, lon]` pairs, joined as `lat,lon|lat,lon`. The numbers the
 * cross-checks see are the pairs flattened.
 */
export function points(maxPoints: number): ParamCheck {
	const pair = numbers(LAT_LON);
	return (value) => {
		if (!Array.isArray(value) || value.length < 1 || value.length > maxPoints) return null;
		const pairs = value.map((entry) => pair(entry));
		if (pairs.some((entry) => entry === null)) return null;
		const checked = pairs as CanonicalParam[];
		return plain(
			checked.map((entry) => entry.wire).join('|'),
			checked.flatMap((entry) => entry.numbers),
		);
	};
}

/** A required parameter. `wire` defaults to the caller's name. Frozen: a definition is not edited. */
export function required(name: string, check: ParamCheck, wire: string = name): ParamDef {
	return Object.freeze({ name, wire, required: true, check });
}

/** An optional parameter. `wire` defaults to the caller's name. Frozen: a definition is not edited. */
export function optional(name: string, check: ParamCheck, wire: string = name): ParamDef {
	return Object.freeze({ name, wire, required: false, check });
}

/** The refusal for a caller's request, named by service and (when it has one) parameter. */
export function invalidRequest(service: string, what: string, param?: string): DedaloError {
	return new DedaloError('request.invalid_data', {
		message: `geo service ${service}: ${what}`,
		coordinates: param === undefined ? { service } : { service, param },
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A caller's key, bounded and quoted, for a log line. */
function quoted(key: string): string {
	return JSON.stringify(key.slice(0, 40));
}

/** Refuse every key of the caller's object the service does not name. */
function refuseUnknownKeys(service: string, defs: readonly ParamDef[], given: object): void {
	const known = new Set(defs.map((def) => def.name));
	for (const key of Object.keys(given)) {
		if (!known.has(key)) throw invalidRequest(service, `parameter ${quoted(key)} is not accepted`);
	}
}

/** The canonical form of one parameter, or undefined when it is absent and optional. */
function canonicalOf(
	service: string,
	def: ParamDef,
	given: Record<string, unknown>,
): CanonicalParam | undefined {
	const value = Object.hasOwn(given, def.name) ? given[def.name] : undefined;
	if (value === undefined || value === null) {
		if (def.required) throw invalidRequest(service, `${def.name} is required`, def.name);
		return undefined;
	}
	const canonical = def.check(value);
	if (canonical === null) throw invalidRequest(service, `${def.name} is not acceptable`, def.name);
	return canonical;
}

/**
 * Validate a caller's parameters against a service's table: the canonical form of
 * every parameter given, in the table's order. Throws `request.invalid_data` for an
 * object that is not a plain record, an unknown key, a missing required key, a
 * value off its grammar, or a failed cross-check.
 */
export function checkParams(
	service: string,
	defs: readonly ParamDef[],
	refine: Refinement | undefined,
	params: unknown,
): ReadonlyMap<string, CanonicalParam> {
	if (!isRecord(params)) throw invalidRequest(service, 'parameters must be an object');
	refuseUnknownKeys(service, defs, params);
	const accepted = new Map<string, CanonicalParam>();
	for (const def of defs) {
		const canonical = canonicalOf(service, def, params);
		if (canonical !== undefined) accepted.set(def.name, canonical);
	}
	const problem = refine?.((name) => accepted.get(name)) ?? null;
	if (problem !== null) throw invalidRequest(service, problem);
	return accepted;
}
