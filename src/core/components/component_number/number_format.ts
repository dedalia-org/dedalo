/**
 * component_number's FORMAT LAW — the ONE copy of how a number node's
 * `properties.type` / `properties.precision` shape a stored value (T1-40 / O06,
 * OX2). Ported from PHP `component_number::set_format_form_type` (frozen v7
 * `class.component_number.php:258-307`, v6 `:192-235`):
 *
 *   - no `type` (PHP `empty()`: absent, null, '', 0, '0', false, []) → the value
 *     unchanged — PHP `(float)$v`, NO rounding;
 *   - `type: 'int'` → truncated toward zero (PHP `(int)`);
 *   - any other `type` ('float', the legacy object form `{"float":2}`, …) →
 *     rounded half away from zero to `precision` (default 2) decimals (PHP
 *     `round($v, $precision)`; a negative precision rounds the integer part).
 *
 * Empty semantics follow v6, not the frozen-v7 regression: `0` is a number and
 * stays `0` (frozen v7's `empty($v) && $v!==0` also nulled `"0"` and `0.0`).
 * A `precision` that is not an integer is refused LOUDLY (`ontology.invalid_node`)
 * — PHP fatalled on it under strict_types; a silent default would narrow scope.
 * The refusal is LAZY, as PHP's was (T1-40 review): a door hands the law a
 * {@link NumberFormatSource} thunk and the format is resolved only when a
 * finite number is about to be formatted — a clear, a null slot or a tree level
 * with no order value never meets a malformed node's refusal.
 *
 * Rounding is DECIMAL, on the value's shortest decimal representation — never
 * `toFixed` (binary: 1.005 → "1.00") and never a `toPrecision(15)` helper
 * (loses digits at precision ≥ 15). A value already within `precision` decimals
 * is returned unchanged, bit for bit.
 *
 * Callers: the save door's value gates (`section/record/write_value_gates.ts`),
 * the import conform (`tools/import_conform.ts` conformNumber) and the tree's
 * order read (`ts_object/node_repository.ts` formatNumberValue). Pure — no
 * module state, no I/O.
 */

import { DedaloError } from '../../errors/dedalo_error.ts';

export interface NumberFormat {
	/** 'none' = untyped node: stored as given. */
	readonly kind: 'int' | 'float' | 'none';
	/** Decimals kept by a 'float' format (ignored otherwise). */
	readonly precision: number;
}

/** The untyped format (no `properties.type`). */
export const NUMBER_FORMAT_NONE: NumberFormat = Object.freeze({ kind: 'none', precision: 2 });

/** PHP `empty()` over a scalar `properties.type` value. */
const EMPTY_TYPES: ReadonlySet<unknown> = new Set([undefined, null, '', '0', 0, false]);

/** PHP `empty()` over a `properties.type` value (an empty array is empty too). */
function isEmptyType(type: unknown): boolean {
	return EMPTY_TYPES.has(type) || (Array.isArray(type) && type.length === 0);
}

type NumberProperties = { type?: unknown; precision?: unknown };

/** A node's `properties`, as an object (anything else reads as no properties). */
function propsOf(properties: unknown): NumberProperties {
	const isRecord =
		properties !== null && typeof properties === 'object' && !Array.isArray(properties);
	return isRecord ? (properties as NumberProperties) : {};
}

/** The sentence refusing a typed node's non-integer `precision`, or null when it is valid. */
function precisionRefusal(props: NumberProperties, tipo: string): string | null {
	if (isEmptyType(props.type) || props.type === 'int') return null;
	const precision = props.precision ?? 2;
	if (typeof precision === 'number' && Number.isInteger(precision)) return null;
	return `component_number '${tipo}': properties.precision must be an integer, received ${typeof precision} ${JSON.stringify(precision)}`;
}

/**
 * Why `properties` cannot format a number (a non-integer `precision` on a
 * typed node), or null when it can. For a door that reports per item (the
 * import's cell failure) instead of throwing.
 */
export function numberFormatRefusal(properties: unknown, tipo: string): string | null {
	return precisionRefusal(propsOf(properties), tipo);
}

/**
 * The format a number node declares. `properties` is the node's raw
 * `properties` (anything); `tipo` only names the node in a refusal. THROWS
 * `ontology.invalid_node` on a non-integer `precision` (see
 * {@link numberFormatRefusal}).
 */
export function numberFormatOf(properties: unknown, tipo: string): NumberFormat {
	const props = propsOf(properties);
	if (isEmptyType(props.type)) return NUMBER_FORMAT_NONE;
	if (props.type === 'int') return { kind: 'int', precision: 0 };
	const refusal = precisionRefusal(props, tipo);
	if (refusal !== null) {
		throw new DedaloError('ontology.invalid_node', { message: refusal, coordinates: { tipo } });
	}
	return { kind: 'float', precision: (props.precision ?? 2) as number };
}

/**
 * A format, or a thunk that resolves one (it may throw — see
 * {@link numberFormatOf}). The thunk is called only when a value needs
 * formatting, at most once per {@link formatNumberItems} call.
 */
export type NumberFormatSource = NumberFormat | (() => NumberFormat);

/** The format `source` names (a thunk is called). */
export function resolveNumberFormat(source: NumberFormatSource): NumberFormat {
	return typeof source === 'function' ? source() : source;
}

/** `-0` → `0` (JSON has no negative zero; a stored value never carries one). */
function unsignedZero(value: number): number {
	return value === 0 ? 0 : value;
}

/** The shortest decimal representation of a non-negative finite number, unexponented. */
function plainDecimal(abs: number): { int: string; frac: string } {
	const text = String(abs);
	const exponentAt = text.indexOf('e');
	if (exponentAt === -1) {
		const [int = '0', frac = ''] = text.split('.');
		return { int, frac };
	}
	const mantissa = text.slice(0, exponentAt);
	const exponent = Number(text.slice(exponentAt + 1));
	const pointAt = mantissa.indexOf('.');
	const digits = mantissa.replace('.', '');
	const point = (pointAt === -1 ? mantissa.length : pointAt) + exponent;
	if (point <= 0) return { int: '0', frac: '0'.repeat(-point) + digits };
	if (point >= digits.length) return { int: digits + '0'.repeat(point - digits.length), frac: '' };
	return { int: digits.slice(0, point), frac: digits.slice(point) };
}

/** A decimal digit string + 1 ('' + 1 = '1'; '99' + 1 = '100'). */
function incrementDigits(digits: string): string {
	const chars = digits.split('');
	for (let index = chars.length - 1; index >= 0; index--) {
		if (chars[index] !== '9') {
			chars[index] = String(Number(chars[index]) + 1);
			return chars.join('');
		}
		chars[index] = '0';
	}
	return `1${chars.join('')}`;
}

/** Round half away from zero to `precision` decimals, on the decimal representation. */
function roundDecimal(value: number, precision: number): number {
	const { int, frac } = plainDecimal(Math.abs(value));
	const all = int + frac;
	const keep = int.length + precision;
	if (keep >= all.length) return value; // already within precision: exact
	if (keep < 0) return 0;
	const magnitude = roundedMagnitude(all, keep, precision);
	return unsignedZero(value < 0 ? -magnitude : magnitude);
}

/**
 * The magnitude `all` (a digit string) rounds to when its first `keep` digits
 * are kept, half away from zero, scaled back by `precision` decimals.
 */
function roundedMagnitude(all: string, keep: number, precision: number): number {
	const kept = all.slice(0, keep);
	const rounded = (all[keep] ?? '0') >= '5' ? incrementDigits(kept) : kept;
	return rounded === '' ? 0 : Number(`${rounded}e${-precision}`);
}

/** Apply `format` to one finite number. */
export function formatNumber(value: number, format: NumberFormat): number {
	if (!Number.isFinite(value)) return value;
	switch (format.kind) {
		case 'int':
			return unsignedZero(Math.trunc(value));
		case 'float':
			return roundDecimal(value, format.precision);
		default:
			return unsignedZero(value);
	}
}

/**
 * Apply `source`'s format to the `value` of every item that carries a finite
 * number; every other item (null slot, absent value, a non-object) and every
 * other field (`id`, `id_key`, `lang`, …) is kept. A thunk `source` is resolved
 * on the first finite number only — items with none never resolve it. Returns
 * the SAME array when nothing changed.
 */
export function formatNumberItems<T>(items: readonly T[], source: NumberFormatSource): T[] {
	let format: NumberFormat | null = null;
	let changed = false;
	const out = items.map((item) => {
		if (item === null || typeof item !== 'object') return item;
		const current = (item as { value?: unknown }).value;
		if (typeof current !== 'number' || !Number.isFinite(current)) return item;
		format ??= resolveNumberFormat(source);
		const formatted = formatNumber(current, format);
		if (Object.is(formatted, current)) return item;
		changed = true;
		return { ...item, value: formatted };
	});
	return changed ? out : (items as T[]);
}
