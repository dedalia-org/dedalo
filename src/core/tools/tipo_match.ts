/**
 * TIPO MEMBERSHIP (PHP tipo_in_array, shared/core_functions.php:2385) — the
 * matcher a tool's `affected_tipos` (dd1350) list is compiled into (T2-O11-2).
 *
 * A value matches a tipo when it is:
 *   - a `<tld>*` WILDCARD sharing the tipo's TLD — both sides read through
 *     `getTldFromTipo` (ontology/tld.ts, the one TLD rule), so `ontology*`
 *     matches `ontology40` and not `ontologytype14`. A value naming no TLD
 *     (a bare `*`) matches nothing;
 *   - a `/pattern/flags` REGEX (PHP preg_match, translated to a JS RegExp);
 *   - the EXACT tipo.
 *
 * COMPILED ONCE. The registry compiles each tool's list when it builds its
 * (cached) rows, so a pattern is parsed once per registry load, not per element
 * tested — and a MALFORMED one (unbalanced, unknown flag, a `/` that is not a
 * delimited pattern) is reported once, at that moment, naming its owner, and
 * then never matches (PHP's failed preg_match). Flags are the PHP∩JS set
 * (i, m, s, u): a stateful `g`/`y` is malformed, so a matcher is stateless. A non-string entry is reported
 * and skipped the same way.
 *
 * Pure: no SQL, no config, no request state, no module caches.
 */

import { getTldFromTipo } from '../ontology/tld.ts';

/** A compiled `affected_tipos` list. */
export interface TipoMatcher {
	/**
	 * True when the list names nothing — every entry is `''`/null (PHP
	 * `empty($affected_tipos[0])`, minus its `'0'`-is-empty quirk): the caller's
	 * "no restriction". `['']` (a cleared editor field) restricts nothing; an
	 * UNUSABLE entry (malformed pattern, non-string) still restricts — fail
	 * closed: the tool then matches nowhere, and the compile report says why.
	 */
	readonly isEmpty: boolean;
	matches(tipo: string): boolean;
}

/** A delimited PHP-style pattern: `/body/flags`. */
const DELIMITED_PATTERN = /^\/(.*)\/([a-z]*)$/s;

/**
 * The flags both engines read alike (PHP preg modifiers ∩ JS RegExp flags).
 * Any other is MALFORMED: PHP rejects `g`/`y`, and on a compiled, SHARED
 * RegExp they would carry `lastIndex` from one request's test into the next
 * (true, false, true… for the same tipo); `d`/`v` are JS-only.
 */
const PORTABLE_FLAGS = /^[imsu]*$/;

/** One compiled form of one list value. */
type CompiledValue =
	| { readonly kind: 'tld'; readonly tld: string }
	| { readonly kind: 'regex'; readonly regex: RegExp }
	| { readonly kind: 'never' };

/** Report a value that can never match (once, at compile time). */
function reportUnusable(owner: string, value: unknown, why: string): void {
	console.warn(`[tools] ${owner}: affected_tipos value ${JSON.stringify(value)} ignored (${why})`);
}

/** The regex of a `/body/flags` value, or null when it is not a valid one. */
function compileRegex(value: string): RegExp | null {
	const delimited = DELIMITED_PATTERN.exec(value);
	if (delimited === null) return null;
	if (!PORTABLE_FLAGS.test(delimited[2] as string)) return null;
	try {
		return new RegExp(delimited[1] as string, delimited[2]);
	} catch {
		return null;
	}
}

/** The wildcard/regex form of one string value (exact matching is the list's own). */
function compileValue(value: string, owner: string): CompiledValue | null {
	if (value.includes('*')) {
		const tld = getTldFromTipo(value);
		return tld === null ? { kind: 'never' } : { kind: 'tld', tld };
	}
	if (!value.includes('/')) return null;
	const regex = compileRegex(value);
	if (regex !== null) return { kind: 'regex', regex };
	reportUnusable(owner, value, 'malformed /pattern/flags');
	return { kind: 'never' };
}

/** Does one compiled form admit `tipo`? */
function admits(compiled: CompiledValue, tipo: string): boolean {
	if (compiled.kind === 'tld') return getTldFromTipo(tipo) === compiled.tld;
	if (compiled.kind === 'regex') return compiled.regex.test(tipo);
	return false;
}

/**
 * Compile an `affected_tipos` list. `owner` names the list's owner (the tool)
 * in the compile-time reports.
 */
export function compileTipoMatcher(values: readonly unknown[], owner: string): TipoMatcher {
	const exact = new Set<string>();
	const forms: CompiledValue[] = [];
	const named = values.filter(namesSomething);
	for (const value of named) {
		if (typeof value !== 'string') {
			reportUnusable(owner, value, 'not a string');
			continue;
		}
		exact.add(value);
		const compiled = compileValue(value, owner);
		if (compiled !== null) forms.push(compiled);
	}
	return {
		isEmpty: named.length === 0,
		matches: (tipo) => exact.has(tipo) || forms.some((form) => admits(form, tipo)),
	};
}

/** A list entry that names something (`''` / null — a cleared field — names nothing). */
function namesSomething(value: unknown): boolean {
	return value !== '' && value !== null && value !== undefined;
}
