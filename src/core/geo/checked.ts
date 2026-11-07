/**
 * The result type and the few text/shape helpers the geo validators share.
 *
 * Every validator in src/core/geo/ is PURE and answers with a `Checked<T>`: the
 * normalized value, or ONE reason naming the offending path (`sources[2].url`)
 * and the rule it broke. A reason NEVER echoes a value — a source template may
 * carry a provider token, and a refusal that quoted it would put the token in
 * the log (engineering/CONVENTIONS.md: a full URL is never logged).
 */

export type Checked<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly reason: string };

export function pass<T>(value: T): Checked<T> {
	return { ok: true, value };
}

export function fail(reason: string): { readonly ok: false; readonly reason: string } {
	return { ok: false, reason };
}

/** The value types of a tuple of `Checked` results, in order. */
export type CheckedValues<T extends readonly Checked<unknown>[]> = {
	-readonly [K in keyof T]: T[K] extends Checked<infer V> ? V : never;
};

/**
 * All of `parts` passed → their values as a tuple; otherwise the FIRST failure.
 * Every part is computed before this runs (a check has no side effect), so the
 * reported reason is the first in source order, not the first to be noticed.
 */
export function allOk<T extends readonly Checked<unknown>[]>(parts: T): Checked<CheckedValues<T>> {
	for (const part of parts) {
		if (!part.ok) return part;
	}
	return pass(parts.map((part) => (part as { value: unknown }).value) as CheckedValues<T>);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The first key of `value` that `allowed` does not name, or null. */
export function strayKey(
	value: Record<string, unknown>,
	allowed: readonly string[],
): string | null {
	return Object.keys(value).find((key) => !allowed.includes(key)) ?? null;
}

/** C0, DEL, the C1 block, and the Unicode line/paragraph separators. */
function isControlCode(code: number): boolean {
	if (code <= 0x1f) return true;
	if (code >= 0x7f && code <= 0x9f) return true;
	return code === 0x2028 || code === 0x2029;
}

/**
 * True when `text` holds a control character (see isControlCode). A scan, not a
 * regex literal — a control character in a pattern is what the linter (rightly)
 * distrusts.
 */
export function hasControlChars(text: string): boolean {
	for (const char of text) {
		if (isControlCode(char.codePointAt(0) ?? 0)) return true;
	}
	return false;
}

/**
 * A free-text field: a string of at most `max` characters, trimmed, without
 * control characters. `allowEmpty` admits the empty string (a legend title may
 * be blank; an attribution may be blank for a source that asks for none).
 */
export function checkText(
	raw: unknown,
	where: string,
	max: number,
	allowEmpty: boolean,
): Checked<string> {
	if (typeof raw !== 'string') return fail(`${where}: must be a string`);
	const text = raw.trim();
	if (text === '' && !allowEmpty) return fail(`${where}: must not be empty`);
	if (text.length > max) return fail(`${where}: longer than ${max} characters`);
	if (hasControlChars(text)) return fail(`${where}: contains control characters`);
	return pass(text);
}

/**
 * A free-text field that a page puts into an HTML sink (Leaflet's layer control and
 * attribution control write `innerHTML`): `checkText` AND no `<` or `>`. One rule for every
 * such field — a source's attribution and an ontology default's label — so the two cannot
 * drift apart (a label was once judged by `checkText` alone). The page escapes the same two
 * characters again before the sink: this check is the save/read-time half of "held twice".
 */
export function checkPlainText(
	raw: unknown,
	where: string,
	max: number,
	allowEmpty: boolean,
): Checked<string> {
	const text = checkText(raw, where, max, allowEmpty);
	if (text.ok && /[<>]/.test(text.value)) {
		return fail(`${where}: must be plain text, without < or >`);
	}
	return text;
}

/** A positive safe integer, or a reason. */
export function checkPositiveInteger(raw: unknown, where: string): Checked<number> {
	if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 1) {
		return fail(`${where}: must be a positive integer`);
	}
	return pass(raw);
}
