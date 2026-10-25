/**
 * TRIPWIRE — ONE escaper at the render boundary (P2-6 / CARRY-01, XSS-03,
 * CLI-21).
 *
 * The audit's finding: the write engine sanitizes ONE model by a hardcoded
 * string, every other value is stored verbatim, and the client parses those
 * values as HTML through hundreds of ad-hoc `inner_html` / `innerHTML` /
 * `insertAdjacentHTML` sinks with no wire-level escaper. Inert under the app
 * CSP — and the CSP is one header away from being the only control.
 *
 * THE DESIGN THIS GATE PINS. The SERVER decides, once per model, in the
 * descriptor's `render` facet (types.ts RenderClass), and stamps `render_class`
 * on the wire; the CLIENT consults ONE module —
 * client/dedalo/core/common/js/utils/render_escape.js — at every sink. A
 * renderer never escapes locally.
 *
 * CENSUS: TOTAL, derived from the tree — every HTML-parsing sink in `client/`
 * and `tools/` client code, classified by what feeds it:
 *   static   — string literals only (the page's own markup);
 *   label    — get_label / get_tool_label catalogs only (repo-owned strings,
 *              WC-033) — categorically exempt;
 *   escaped  — fed through the ONE escaper (render_value / render_join /
 *              render_fallback_value / escape_html) — the NAME counts only
 *              when the file imports it by that exact name from
 *              render_escape.js and never shadows it, AND the render class it
 *              is handed is the SERVER's (`<…>.render_class`, or a literal
 *              NARROWER than 'html': a literal 'html' is a passthrough by
 *              name) — one hop of SCOPED local data-flow followed: the
 *              NEAREST declaration OR reassignment before the sink that is
 *              VISIBLE from it — visible by FUNCTION (a sibling function's
 *              local is not; a function PARAMETER is the caller's value until
 *              reassigned in that body) and, for a declaration, by BLOCK (an
 *              `if`-block `const` of the same name is a different binding) —
 *              plus every value that MAY ALSO reach the sink: every `x += …`
 *              after it, every visible reassignment textually AFTER the sink
 *              (a loop back-edge carries it round), an assignment inside a
 *              branch the sink is not in (it only ADDS a possible value, it
 *              never overwrites), and an assignment from a nested CALLBACK
 *              that does not rebind the name itself (it runs at a time no
 *              textual scan knows). Also `.join(<static>)`, `x[i]`, an
 *              accumulator filled ONLY by push (≥1 push; `x[i] =`/unshift/
 *              splice/fill/concat make it dynamic). A DOM NODE is inert — only a node FACTORY proves
 *              one: ui.create_dom_element / document.create* / an
 *              `instance.render()` whose receiver came out of get_instance in
 *              scope (`markdown.render(text)` is a string and stays dynamic);
 *   dynamic  — anything else: a value the classifier cannot prove safe.
 *
 * THE INVARIANT, in two tiers:
 *   1. The COMPONENT RENDER SURFACE (client/dedalo/core/component_*, dd_grid,
 *      login) holds ZERO dynamic sinks, bar an ENUMERATED per-entry list with a
 *      reason each — shrink-only.
 *   2. The REMAINDER (areas, section, services, widgets, tools) is a per-file
 *      SHRINK-ONLY ratchet: a count may only go down, and a file not listed
 *      holds zero. The ratchet is exact (a stale higher count is red too), so
 *      every closure is recorded in the same commit.
 *
 * CLASSIFIER HONESTY. The classifier is a TEXTUAL scan, conservative by
 * construction: an expression it cannot resolve is DYNAMIC, never safe. Its
 * known limits, stated as they are:
 *   - conservative (over-flags, never blesses): a value escaped in ANOTHER
 *     module and passed in is a parameter → dynamic; a destructured or
 *     `for…of` binding has no `=` site → dynamic; every value that MAY reach
 *     the sink is folded in, whether or not that branch or callback actually
 *     ran before it;
 *   - the ONE structural blind spot: data flow through an OBJECT or an
 *     ARRAY SLOT (`o.out = raw`, `[out] = …`) is not tracked — the scan
 *     resolves plain identifiers only. A wrapper HELPER that forwards a
 *     caller's string into a sink is counted at its own sink and at the call
 *     sites of the THREE enumerated ui.js forwarders (HELPER_OPTIONS); a NEW
 *     forwarding helper — in ui.js or anywhere else — is counted once, in its
 *     own file, until it is added there. Adding one is the census's price of
 *     admission, not an optional tidy-up.
 * A positive-control offender below proves it flags the shape the audit
 * found, and a positive-control fix proves the escaper clears it — a
 * classifier that stopped seeing sinks or started blessing everything fails
 * here, not silently.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { firstPartyClientFiles } from '../helpers/browser_corpus.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const read = (rel: string): string => readFileSync(join(REPO_ROOT, rel), 'utf8');

const ESCAPER = 'client/dedalo/core/common/js/utils/render_escape.js';
const UTIL = 'client/dedalo/core/common/js/utils/util.js';

// ---------------------------------------------------------------------------
// The census walk — TOTAL over the client trees, never a hand list.
// ---------------------------------------------------------------------------

/** Every first-party client .js file — the corpus is owned by the shared lister. */
const clientFiles = firstPartyClientFiles;

// ---------------------------------------------------------------------------
// Expression extraction + classification.
// ---------------------------------------------------------------------------

type Cls = 'static' | 'label' | 'escaped' | 'dynamic';

interface Sink {
	file: string;
	line: number;
	kind: 'inner_html' | 'value_string' | 'innerHTML' | 'insertAdjacentHTML' | 'helper_option';
	expr: string;
	cls: Cls;
	/** a dynamic piece SPLICED into a built string (see concatenatesDynamic) */
	concat: boolean;
}

const ESCAPER_NAMES = [
	'render_value',
	'render_fallback_value',
	'render_join',
	'escape_html',
] as const;
const ESCAPER_CALL = /^(render_value|render_fallback_value|render_join|escape_html)\s*\(/;
const ESCAPER_IMPORT_RE =
	/import\s*\{([^}]*)\}\s*from\s*['"][^'"]*\/common\/js\/utils\/render_escape\.js['"]/g;

/**
 * The escaper identifiers a source may be TRUSTED on: imported from
 * render_escape.js under their own exact name (`as` renames are not an
 * escaper), and never redeclared, reassigned or shadowed locally. A call to
 * `render_value(` in a file that defines its own `render_value` is a
 * passthrough dressed as the escaper — the classifier must not bless it.
 */
function trustedEscapers(src: string): ReadonlySet<string> {
	const imported = new Set<string>();
	for (const m of src.matchAll(ESCAPER_IMPORT_RE)) {
		for (const spec of (m[1] as string).split(',')) {
			const name = spec.trim();
			if ((ESCAPER_NAMES as readonly string[]).includes(name)) imported.add(name);
		}
	}
	for (const name of [...imported]) {
		const local = new RegExp(
			`(?:\\b(?:const|let|var|function|class)\\s+${name}\\b|(?:^|[^\\w$.])${name}\\s*=(?![=>]))`,
			'm',
		);
		if (local.test(src)) imported.delete(name);
	}
	return imported;
}
const trustedCache = new Map<string, ReadonlySet<string>>();
function escapersOf(src: string): ReadonlySet<string> {
	let set = trustedCache.get(src);
	if (set === undefined) {
		set = trustedEscapers(src);
		trustedCache.set(src, set);
	}
	return set;
}

/**
 * Read one JS expression starting at `i`: balanced over ()[]{} and string /
 * template literals, stopping at a depth-0 terminator (or, for assignment
 * statements, at a newline that ends the expression — the client omits
 * semicolons, so a line continues only through a trailing/leading operator).
 */
function scanExpr(src: string, i: number, terminators: string, stopAtNewline: boolean): string {
	let depth = 0;
	let j = i;
	let out = '';
	while (j < src.length) {
		const c = src[j] as string;
		if (c === '"' || c === "'" || c === '`') {
			let k = j + 1;
			let tdepth = 0;
			while (k < src.length) {
				if (src[k] === '\\') {
					k += 2;
					continue;
				}
				if (c === '`' && src[k] === '$' && src[k + 1] === '{') {
					tdepth++;
					k += 2;
					continue;
				}
				if (c === '`' && tdepth > 0 && src[k] === '}') {
					tdepth--;
					k++;
					continue;
				}
				if (src[k] === c && tdepth === 0) break;
				k++;
			}
			out += src.slice(j, k + 1);
			j = k + 1;
			continue;
		}
		if (c === '/' && src[j + 1] === '/') {
			while (j < src.length && src[j] !== '\n') j++;
			continue;
		}
		if (c === '/' && src[j + 1] === '*') {
			const e = src.indexOf('*/', j + 2);
			j = e < 0 ? src.length : e + 2;
			continue;
		}
		if ('([{'.includes(c)) depth++;
		if (')]}'.includes(c)) {
			if (depth === 0) break;
			depth--;
		}
		if (depth === 0 && terminators.includes(c)) break;
		if (c === '\n' && depth === 0 && stopAtNewline) {
			const t = out.trim();
			const rest = src.slice(j + 1).match(/^\s*([^\s])/);
			const next = rest ? (rest[1] as string) : '';
			if (!/[+?:|&(,=]$/.test(t) && !/[+?:|&.]/.test(next)) break;
		}
		out += c;
		j++;
	}
	return out.trim();
}

function balanced(s: string): boolean {
	let d = 0;
	for (const c of s) {
		if ('([{'.includes(c)) d++;
		if (')]}'.includes(c)) {
			d--;
			if (d < 0) return false;
		}
	}
	return d === 0;
}

function matchBrace(s: string, i: number): number {
	let d = 0;
	for (let j = i; j < s.length; j++) {
		if (s[j] === '{') d++;
		else if (s[j] === '}') {
			d--;
			if (d === 0) return j;
		}
	}
	return s.length;
}

/** The `${…}` pieces of a template literal. */
function templateParts(t: string): string[] {
	const parts: string[] = [];
	let i = t.indexOf('${');
	while (i >= 0) {
		const e = matchBrace(t, i + 1);
		parts.push(t.slice(i + 2, e));
		i = t.indexOf('${', e + 1);
	}
	return parts;
}

/** Worst class wins: one dynamic atom makes the expression dynamic. */
function combine(xs: Cls[]): Cls {
	if (xs.includes('dynamic')) return 'dynamic';
	if (xs.includes('escaped')) return 'escaped';
	if (xs.includes('label')) return 'label';
	return 'static';
}

/**
 * Split an expression into its RENDERED atoms at depth 0. `+`, `||`, `??`
 * and the branches of `? :` are all rendered; the CONDITION of `? :` and
 * the left operand of `&&` are not (a falsy left operand renders as
 * ''/null/false/0/undefined — inert), so they are dropped.
 */
function splitAtoms(expr: string): string[] {
	const atoms: string[] = [];
	let depth = 0;
	let cur = '';
	let i = 0;
	while (i < expr.length) {
		const c = expr[i] as string;
		if (c === '"' || c === "'" || c === '`') {
			let k = i + 1;
			let td = 0;
			while (k < expr.length) {
				if (expr[k] === '\\') {
					k += 2;
					continue;
				}
				if (c === '`' && expr[k] === '$' && expr[k + 1] === '{') {
					td++;
					k += 2;
					continue;
				}
				if (c === '`' && td > 0 && expr[k] === '}') {
					td--;
					k++;
					continue;
				}
				if (expr[k] === c && td === 0) break;
				k++;
			}
			cur += expr.slice(i, k + 1);
			i = k + 1;
			continue;
		}
		if ('([{'.includes(c)) depth++;
		if (')]}'.includes(c)) depth--;
		if (depth === 0) {
			const two = expr.slice(i, i + 2);
			if (two === '||' || two === '??') {
				atoms.push(cur);
				cur = '';
				i += 2;
				continue;
			}
			if (two === '&&') {
				cur = '';
				i += 2;
				continue;
			}
			if (c === '?') {
				cur = '';
				i++;
				continue;
			}
			if (c === '+' || c === ':') {
				atoms.push(cur);
				cur = '';
				i++;
				continue;
			}
		}
		cur += c;
		i++;
	}
	atoms.push(cur);
	return atoms;
}

/** Is index `i` on a comment line? */
function inComment(src: string, i: number): boolean {
	return /^\s*(\*|\/\/)/.test(src.slice(src.lastIndexOf('\n', i) + 1, i));
}

// ---------------------------------------------------------------------------
// Function scopes: a binding is visible at a sink only from a body that
// ENCLOSES the sink, and a PARAMETER is a value the caller chose.
// ---------------------------------------------------------------------------

interface FnScope {
	params: ReadonlySet<string>;
	/** the body's extent [bodyStart, bodyEnd) — brace or expression body */
	bodyStart: number;
	bodyEnd: number;
}

/** The identifiers bound by a parameter list (defaults dropped, rest/destructuring flattened). */
function paramNames(list: string): Set<string> {
	const out = new Set<string>();
	const noStrings = list.replace(/(["'`])(?:\\.|(?!\1).)*\1/gs, '""');
	for (const piece of noStrings.split(',')) {
		const bound = piece.split('=')[0] as string;
		for (const m of bound.matchAll(/[A-Za-z_$][\w$]*/g)) out.add(m[0]);
	}
	return out;
}

/** The `(` … `)` extent starting at `open` (balanced over strings). */
function matchParen(s: string, open: number): number {
	let d = 0;
	for (let j = open; j < s.length; j++) {
		const c = s[j] as string;
		if (c === '"' || c === "'" || c === '`') {
			let k = j + 1;
			while (k < s.length && s[k] !== c) k += s[k] === '\\' ? 2 : 1;
			j = k;
			continue;
		}
		if (c === '(') d++;
		else if (c === ')') {
			d--;
			if (d === 0) return j;
		}
	}
	return s.length;
}

const KEYWORD_HEADS = new Set([
	'if',
	'for',
	'while',
	'switch',
	'with',
	'return',
	'typeof',
	'await',
]);

/**
 * Every function in a source, with its parameter names and body extent:
 * `function name(…) {`, `(…) => {`/`(…) => expr`, `x => {`/`x => expr`,
 * method shorthand `name(…) {` and `catch (e) {` (a binding the caller —
 * the thrown value — chose). Conservative: a form this index cannot read is
 * simply not a scope, and an unrecognised binding stays a plain lookup.
 */
function fnScopes(src: string): FnScope[] {
	const scopes: FnScope[] = [];
	const bodyAt = (i: number): [number, number] => {
		const m = src.slice(i).match(/^\s*/);
		const start = i + (m ? m[0].length : 0);
		if (src[start] === '{') return [start, matchBrace(src, start) + 1];
		return [start, start + scanExpr(src, start, ',;', true).length];
	};
	// function keyword + method shorthand + catch
	for (const m of src.matchAll(
		/\b(?:(async\s+)?function\s*\*?\s*[\w$]*|catch|([A-Za-z_$][\w$]*))\s*\(/g,
	)) {
		const at = m.index as number;
		if (inComment(src, at)) continue;
		const head = m[2];
		if (head !== undefined) {
			if (KEYWORD_HEADS.has(head)) continue;
			// a call `name(...)` is not a definition: require a brace body directly after `)`
		}
		const open = at + m[0].length - 1;
		const close = matchParen(src, open);
		const after = src.slice(close + 1).match(/^\s*\{/);
		if (!after) continue;
		if (head !== undefined && /^\s*=>/.test(src.slice(close + 1))) continue;
		const [bodyStart, bodyEnd] = bodyAt(close + 1);
		scopes.push({ params: paramNames(src.slice(open + 1, close)), bodyStart, bodyEnd });
	}
	// arrows
	for (const m of src.matchAll(/=>/g)) {
		const at = m.index as number;
		if (inComment(src, at)) continue;
		let k = at - 1;
		while (k >= 0 && /\s/.test(src[k] as string)) k--;
		let params: string;
		if (src[k] === ')') {
			let d = 0;
			let j = k;
			for (; j >= 0; j--) {
				if (src[j] === ')') d++;
				else if (src[j] === '(') {
					d--;
					if (d === 0) break;
				}
			}
			params = src.slice(j + 1, k);
		} else {
			let j = k;
			while (j >= 0 && /[\w$]/.test(src[j] as string)) j--;
			params = src.slice(j + 1, k + 1);
		}
		const [bodyStart, bodyEnd] = bodyAt(at + 2);
		scopes.push({ params: paramNames(params), bodyStart, bodyEnd });
	}
	return scopes;
}
const scopeCache = new Map<string, FnScope[]>();
function scopesOf(src: string): FnScope[] {
	let list = scopeCache.get(src);
	if (list === undefined) {
		list = fnScopes(src);
		scopeCache.set(src, list);
	}
	return list;
}
const encloses = (f: FnScope, i: number): boolean => i >= f.bodyStart && i < f.bodyEnd;

/**
 * Is a binding site at `site` visible from `pos`? Only when every function
 * body that contains the site also contains `pos` — a sibling function's
 * local is not this function's value.
 */
function visibleFrom(src: string, site: number, pos: number): boolean {
	for (const f of scopesOf(src)) if (encloses(f, site) && !encloses(f, pos)) return false;
	return true;
}

/** The brace-block extents of a source (comments/strings blanked first). */
function blockRanges(src: string): Array<[number, number]> {
	const code = stripComments(src);
	const out: Array<[number, number]> = [];
	const stack: number[] = [];
	for (let i = 0; i < code.length; i++) {
		const c = code[i] as string;
		if (c === '"' || c === "'" || c === '`') {
			let k = i + 1;
			while (k < code.length && code[k] !== c) k += code[k] === '\\' ? 2 : 1;
			i = k;
			continue;
		}
		if (c === '{') stack.push(i);
		else if (c === '}') {
			const open = stack.pop();
			if (open !== undefined) out.push([open, i + 1]);
		}
	}
	return out;
}
const blockCache = new Map<string, Array<[number, number]>>();
function blocksOf(src: string): Array<[number, number]> {
	let list = blockCache.get(src);
	if (list === undefined) {
		list = blockRanges(src);
		blockCache.set(src, list);
	}
	return list;
}

/**
 * BLOCK scoping for a `const`/`let` site: a declaration inside an `if`/`for`/
 * `try` block is a DIFFERENT binding from the sink's when the sink is outside
 * that block — `let out = raw; if (x) { const out = render_value(…) }
 * sink(out)` must not be blessed by the block-local twin.
 */
function blockVisibleFrom(src: string, site: number, pos: number): boolean {
	let innermost: [number, number] | null = null;
	for (const b of blocksOf(src)) {
		if (site < b[0] || site >= b[1]) continue;
		if (innermost === null || b[0] > innermost[0]) innermost = b;
	}
	return innermost === null || (pos >= innermost[0] && pos < innermost[1]);
}

/**
 * Does a function body that contains `site` but NOT `pos` BIND `name` itself
 * (parameter or own declaration)? Then an assignment there is that function's
 * own value. If it does not, `x = …` inside a callback assigns the binding the
 * sink reads — invisible to a textual "before the sink" scan, so it is folded
 * in as an appended (order-unknown) value instead of being dropped.
 */
function rebindsInOtherScope(src: string, name: string, site: number, pos: number): boolean {
	const esc = name.replace(/\$/g, '\\$');
	const decl = new RegExp(`(?:const|let|var)\\s+${esc}\\b`, 'g');
	for (const f of scopesOf(src)) {
		if (!encloses(f, site) || encloses(f, pos)) continue;
		if (f.params.has(name)) return true;
		decl.lastIndex = 0;
		for (const m of src.slice(f.bodyStart, f.bodyEnd).matchAll(decl)) {
			void m;
			return true;
		}
	}
	return false;
}

/**
 * The innermost enclosing function that binds `name` as a PARAMETER, if any:
 * inside it, `name` is what the caller passed until reassigned in that body.
 */
function paramScope(src: string, name: string, pos: number): FnScope | null {
	let best: FnScope | null = null;
	for (const f of scopesOf(src)) {
		if (!encloses(f, pos) || !f.params.has(name)) continue;
		if (best === null || f.bodyStart > best.bodyStart) best = f;
	}
	return best;
}

/**
 * What `name` holds at `before`: the NEAREST preceding VISIBLE declaration OR
 * plain reassignment (a later `x = raw` overrides an earlier escaped
 * declaration — both are candidates, the nearest wins), plus every `x += …`
 * between that site and the sink (an accumulating append is part of the
 * value). A site inside a function that does not enclose the sink is not a
 * candidate, and a site before `after` (the parameter list that shadows an
 * outer binding) is not either.
 */
function findDecl(
	src: string,
	name: string,
	before: number,
	after = -1,
): { expr: string; pos: number; appended: Array<{ expr: string; pos: number }> } | null {
	const esc = name.replace(/\$/g, '\\$');
	const sites: Array<{ end: number; append: boolean; later: boolean; certain: boolean }> = [];
	const collect = (re: RegExp, append: boolean, kind: 'decl' | 'assign'): void => {
		for (const m of src.matchAll(re)) {
			const at = m.index as number;
			if (at < after) continue;
			if (inComment(src, at)) continue;
			const own = visibleFrom(src, at, before);
			// a DECLARATION binds where it is written: it must be visible by
			// function AND by block, or it is a different variable
			if (kind === 'decl' && (!own || !blockVisibleFrom(src, at, before))) continue;
			// an ASSIGNMENT to a binding the other scope does not rebind reaches
			// the sink's variable — from a callback, at a time no textual scan
			// knows, so it is folded in as an appended value
			if (kind === 'assign' && !own && rebindsInOtherScope(src, esc, at, before)) continue;
			const end = at + m[0].length;
			if (!sites.some((x) => x.end === end))
				sites.push({
					end,
					append,
					later: at >= before || !own,
					// an assignment inside a block the sink is not in ran only if
					// that branch ran: it CANNOT overwrite the earlier value, it can
					// only add to the set of values the sink may see
					certain: kind === 'decl' || blockVisibleFrom(src, at, before),
				});
		}
	};
	collect(new RegExp(`(?:const|let|var)\\s+${esc}\\s*=\\s*`, 'g'), false, 'decl');
	collect(new RegExp(`(^|[^\\w$.])${esc}\\s*=(?![=>])\\s*`, 'gm'), false, 'assign');
	collect(new RegExp(`(^|[^\\w$.])${esc}\\s*\\+=\\s*`, 'gm'), true, 'assign');
	sites.sort((a, b) => a.end - b.end);
	let last = -1;
	for (let i = 0; i < sites.length; i++) {
		const site = sites[i] as { append: boolean; later: boolean; certain: boolean };
		if (!site.append && !site.later && site.certain) last = i;
	}
	if (last < 0) return null;
	const base = sites[last] as { end: number };
	// every site after the nearest declaration flows into the sink: the `+=`
	// appends before it, and ANY visible site textually AFTER it too — a loop
	// back-edge (`for (…) { sink(x); x = raw }`) carries the later value round
	// to the next iteration's sink, so a later reassignment is part of the value
	const appended = sites
		.slice(last + 1)
		.map((x) => ({ expr: scanExpr(src, x.end, ';', true), pos: x.end }));
	return { expr: scanExpr(src, base.end, ';', true), pos: base.end, appended };
}

/** The argument list of a call, split at depth-0 commas (strings respected). */
function splitArgs(inner: string): string[] {
	const args: string[] = [];
	let depth = 0;
	let cur = '';
	let i = 0;
	while (i < inner.length) {
		const c = inner[i] as string;
		if (c === '"' || c === "'" || c === '`') {
			let k = i + 1;
			while (k < inner.length && inner[k] !== c) k += inner[k] === '\\' ? 2 : 1;
			cur += inner.slice(i, k + 1);
			i = k + 1;
			continue;
		}
		if ('([{'.includes(c)) depth++;
		if (')]}'.includes(c)) depth--;
		if (c === ',' && depth === 0) {
			args.push(cur.trim());
			cur = '';
			i++;
			continue;
		}
		cur += c;
		i++;
	}
	if (cur.trim() !== '' || args.length > 0) args.push(cur.trim());
	return args;
}

/** Which argument of each escaper is the render class (escape_html has none). */
const CLASS_ARG_INDEX: Readonly<Record<string, number>> = {
	render_value: 1,
	render_join: 2,
	render_fallback_value: 2,
};

/**
 * Is a render-class argument the SERVER's decision? Yes for: a string literal
 * other than 'html' (a renderer may narrow to text/number/url, never widen to
 * markup); an expression that reads `<…>.render_class` off the wire (the
 * structure context, a grid cell, a column); `undefined`/`null` (→ 'text');
 * an identifier that resolves to one of those in this scope. A literal 'html'
 * is a renderer deciding for itself that a value is markup — the exact
 * passthrough the escaper exists to prevent — and anything unresolved is not
 * trusted either.
 */
function classArgTrusted(arg: string, src: string, pos: number, depth: number): boolean {
	const a = arg.trim();
	if (a === '' || a === 'undefined' || a === 'null') return true;
	const literal = a.match(/^(['"])((?:\\.|(?!\1).)*)\1$/);
	if (literal) return literal[2] !== 'html';
	if (a.startsWith('(') && a.endsWith(')') && balanced(a.slice(1, -1)))
		return classArgTrusted(a.slice(1, -1), src, pos, depth);
	// `x.render_class`, `x?.render_class`, `x.render_class || 'text'` — every
	// rendered branch must itself be trusted
	const branches = splitAtoms(a);
	if (branches.length > 1) return branches.every((b) => classArgTrusted(b, src, pos, depth));
	if (/^[A-Za-z_$][\w$]*(\??\.[A-Za-z_$][\w$]*|\[[^\]]*\])*\??\.render_class$/.test(a)) return true;
	if (/^[A-Za-z_$][\w$]*$/.test(a)) {
		if (depth > 4) return false;
		const param = paramScope(src, a, pos);
		const decl = findDecl(src, a, pos, param === null ? -1 : param.bodyStart);
		if (decl === null || decl.appended.length > 0) return false;
		return classArgTrusted(decl.expr, src, decl.pos, depth + 1);
	}
	return false;
}

const NODE_FACTORY_RE =
	/^(?:await\s+)?(?:ui\.create_dom_element|document\.create(?:Element|DocumentFragment|TextNode))\s*\(/;
/** `await <ident>.render(…)` — a node ONLY when `<ident>` is a component/section INSTANCE. */
const INSTANCE_RENDER_RE = /^(?:await\s+)?([A-Za-z_$][\w$]*)\.render\s*\(/;
const INSTANCE_FACTORY_RE = /^(?:await\s+)?(?:get_instance|instances\.get_instance)\s*\(/;

function classifyAtom(atom: string, src: string, pos: number, depth: number): Cls {
	const a = atom.trim();
	if (a === '') return 'static';
	if (a.startsWith('(') && a.endsWith(')') && balanced(a.slice(1, -1))) {
		return classifyExpr(a.slice(1, -1), src, pos, depth);
	}
	if (/^(['"])(?:\\.|(?!\1).)*\1$/s.test(a)) return 'static';
	if (/^\d+(\.\d+)?$/.test(a) || ['undefined', 'null', 'true', 'false'].includes(a))
		return 'static';
	if (a.startsWith('`') && a.endsWith('`')) {
		if (!a.includes('${')) return 'static';
		return combine(templateParts(a).map((p) => classifyExpr(p, src, pos, depth)));
	}
	// repo-owned label catalogs (WC-033): get_label.x / get_tool_label.x
	if (/^(get_label|get_tool_label)(\.[A-Za-z_$][\w$]*|\[[^\]]*\])+$/.test(a)) return 'label';
	// (!) NOT `self.get_tool_label('key')`: a tool instance's labels are the
	// tools-register RECORD (dd1372, src/core/tools/registry.ts) — a database
	// value an administrator edits, not a repo-owned catalog — so they stay
	// dynamic like any other wire value
	// the ONE escaper — and only when THIS file imports it from render_escape.js
	// under its own name and never shadows it (a local passthrough is not it),
	// AND the render class it is handed is the SERVER's (or a non-'html'
	// literal): `render_value(x, 'html')` is a verbatim passthrough by name
	const call = a.match(ESCAPER_CALL);
	if (
		call &&
		escapersOf(src).has(call[1] as string) &&
		a.endsWith(')') &&
		balanced(a.slice(a.indexOf('(') + 1, -1))
	) {
		const name = call[1] as string;
		const args = splitArgs(a.slice(a.indexOf('(') + 1, -1));
		const classIndex = CLASS_ARG_INDEX[name];
		if (classIndex === undefined) return 'escaped'; // escape_html: no class
		if (args.length <= classIndex) return 'escaped'; // absent → 'text'
		return classArgTrusted(args[classIndex] as string, src, pos, depth) ? 'escaped' : 'dynamic';
	}
	// `<receiver>.join(<sep>)`: the receiver's class, provided the separator
	// is not itself dynamic (a separator is rendered too).
	const joined = a.match(/^(.+)\.join\(([^()]*(?:\([^()]*\))?[^()]*)\)$/);
	if (joined) {
		const sep = classifyExpr(joined[2] as string, src, pos, depth);
		if (sep === 'dynamic') return 'dynamic';
		return combine([classifyAtom(joined[1] as string, src, pos, depth), sep]);
	}
	// a DOM NODE is never parsed: the helper options that accept `string |
	// Node` (attach_to_modal header/body/footer) append a node
	// as-is, and a node's own content was built through sinks this census
	// already counts. Only a call to a node FACTORY is a node here — an
	// instance's `render()` (the wrapper node), ui.create_dom_element,
	// document.createElement / createDocumentFragment / createTextNode.
	if (a.endsWith(')') && balanced(a.slice(a.indexOf('(') + 1, -1))) {
		if (NODE_FACTORY_RE.test(a)) return 'static';
		// `instance.render()` is the wrapper NODE when `instance` came out of
		// get_instance (the client's one instance factory) in this scope — a
		// `markdown.render(text)` (an imported string renderer) does not resolve
		// there and stays dynamic
		const inst = a.match(INSTANCE_RENDER_RE);
		if (inst && depth <= 4) {
			const name = inst[1] as string;
			const param = paramScope(src, name, pos);
			const decl = findDecl(src, name, pos, param === null ? -1 : param.bodyStart);
			if (decl !== null && decl.appended.length === 0 && INSTANCE_FACTORY_RE.test(decl.expr))
				return 'static';
		}
	}
	// `ident[i]` — an element of a list resolves as the list.
	const indexed = a.match(/^([A-Za-z_$][\w$]*)\[[^\]]*\]$/);
	if (indexed) return classifyAtom(indexed[1] as string, src, pos, depth);
	if (/^[A-Za-z_$][\w$]*$/.test(a)) {
		if (depth > 4) return 'dynamic';
		// a PARAMETER of an enclosing function is the caller's value: dynamic
		// unless reassigned inside that body before the sink
		const param = paramScope(src, a, pos);
		const decl = findDecl(src, a, pos, param === null ? -1 : param.bodyStart);
		if (decl === null) return 'dynamic';
		const appended = decl.appended.map((x) => classifyExpr(x.expr, src, x.pos, depth + 1));
		if (appended.includes('dynamic')) return 'dynamic';
		if (/^\[\s*\]$/.test(decl.expr)) {
			// an accumulator: it is what was pushed into it (every push in the
			// file). Any OTHER way of filling it — `x[i] =`, unshift, splice,
			// fill, concat — and a list nothing pushes into (an empty join renders
			// '', but the classifier cannot tell it from a fill it does not read)
			// are dynamic. BOTH halves are load-bearing: the push-count floor
			// catches a list filled ONLY the other way, the fill check catches one
			// that pushes AND fills
			const esc = a.replace(/\$/g, '\\$');
			if (
				new RegExp(
					`\\b${esc}\\s*(\\[[^\\]]*\\]\\s*=(?!=)|\\.(?:unshift|splice|fill|concat)\\s*\\()`,
				).test(src)
			)
				return 'dynamic';
			const pushes = [...src.matchAll(new RegExp(`\\b${esc}\\.push\\(`, 'g'))];
			if (pushes.length === 0) return 'dynamic';
			return combine(
				pushes.map((pm) =>
					classifyExpr(
						scanExpr(src, (pm.index as number) + pm[0].length, ',', false),
						src,
						pm.index as number,
						depth + 1,
					),
				),
			);
		}
		return combine([classifyExpr(decl.expr, src, decl.pos, depth + 1), ...appended]);
	}
	return 'dynamic';
}

function classifyExpr(expr: string, src: string, pos: number, depth = 0): Cls {
	return combine(splitAtoms(expr).map((a) => classifyAtom(a, src, pos, depth)));
}

/**
 * The depth-0 `+` operands of an expression (string / template literals and
 * brackets respected). One element when the expression is not a `+` chain.
 */
function plusOperands(expr: string): string[] {
	const ops: string[] = [];
	let depth = 0;
	let cur = '';
	let i = 0;
	while (i < expr.length) {
		const c = expr[i] as string;
		if (c === '"' || c === "'" || c === '`') {
			let k = i + 1;
			let td = 0;
			while (k < expr.length) {
				if (expr[k] === '\\') {
					k += 2;
					continue;
				}
				if (c === '`' && expr[k] === '$' && expr[k + 1] === '{') {
					td++;
					k += 2;
					continue;
				}
				if (c === '`' && td > 0 && expr[k] === '}') {
					td--;
					k++;
					continue;
				}
				if (expr[k] === c && td === 0) break;
				k++;
			}
			cur += expr.slice(i, k + 1);
			i = k + 1;
			continue;
		}
		if ('([{'.includes(c)) depth++;
		if (')]}'.includes(c)) depth--;
		if (depth === 0 && c === '+' && expr[i + 1] !== '+' && expr[i - 1] !== '+') {
			ops.push(cur);
			cur = '';
			i++;
			continue;
		}
		cur += c;
		i++;
	}
	ops.push(cur);
	return ops.map((o) => o.trim()).filter((o) => o !== '');
}

/**
 * MARKUP CONCATENATION — the shape of the audit's stored-XSS findings
 * (CodeQL #7930 vector_editor `'Layer: ' + layer.user_layer_name + '<br>'`,
 * #7940 render_search `first_item.name + ' ' + label_add.innerHTML`): a
 * string BUILT for an HTML sink by `+`, a `${}` template or a `+=`
 * accumulator, one of whose pieces the classifier cannot prove safe. A bare
 * dynamic value handed to a sink is the ratchet's business; a value SPLICED
 * INTO MARKUP is never legitimate — the markup half is the renderer's own, so
 * the renderer can always build it as nodes and hand the value to
 * text_content. One hop of the same scoped data flow the classifier uses:
 * `inner_html: body` resolves `body`'s nearest visible declaration, and a
 * `body += …` append with a dynamic piece is a concatenation too.
 */
function concatenatesDynamic(expr: string, src: string, pos: number, depth = 0): boolean {
	const e = expr.trim();
	if (e.startsWith('(') && e.endsWith(')') && balanced(e.slice(1, -1)))
		return concatenatesDynamic(e.slice(1, -1), src, pos, depth);
	const ops = plusOperands(e);
	if (ops.length > 1) return ops.some((o) => classifyExpr(o, src, pos) === 'dynamic');
	if (e.startsWith('`') && e.endsWith('`') && e.includes('${'))
		return templateParts(e).some((p) => classifyExpr(p, src, pos) === 'dynamic');
	// the branches of `||` / `??` / `? :` are each rendered: any one of them
	// may be the concatenation
	const atoms = splitAtoms(e);
	if (atoms.length > 1) return atoms.some((a) => concatenatesDynamic(a, src, pos, depth));
	if (/^[A-Za-z_$][\w$]*$/.test(e) && depth < 2) {
		const param = paramScope(src, e, pos);
		const decl = findDecl(src, e, pos, param === null ? -1 : param.bodyStart);
		if (decl === null) return false;
		const esc = e.replace(/\$/g, '\\$');
		const appends = decl.appended.filter((x) =>
			new RegExp(`(^|[^\\w$.])${esc}\\s*\\+=\\s*$`).test(
				src.slice(Math.max(0, x.pos - 200), x.pos),
			),
		);
		if (appends.some((x) => classifyExpr(x.expr, src, x.pos) === 'dynamic')) return true;
		return concatenatesDynamic(decl.expr, src, decl.pos, depth + 1);
	}
	return false;
}

/**
 * The sinks: the `inner_html:` option of ui.create_dom_element, the
 * `value_string:` option of ui.component.build_wrapper_list/mini (it is
 * inserted as HTML), `.innerHTML =`/`+=` and `.outerHTML =`, the payload of
 * insertAdjacentHTML (literal OR variable position), setHTMLUnsafe and
 * createContextualFragment. The `innerHTML` kind stands for every
 * assignment-shaped parser sink.
 */
const SINK_RE =
	/\binner_html\s*:\s*|\bvalue_string\s*:\s*|\.(?:innerHTML|outerHTML)\s*(\+?=)(?!=)\s*|\.insertAdjacentHTML\s*\(\s*(?:(['"])[a-zA-Z]+\2|[^,()]+)\s*,\s*|\.(?:setHTMLUnsafe|createContextualFragment)\s*\(\s*/g;

function censusSource(file: string, src: string): Sink[] {
	const sinks: Sink[] = [];
	const lineOf = (i: number): number => src.slice(0, i).split('\n').length;
	for (const m of src.matchAll(SINK_RE)) {
		if (inComment(src, m.index as number)) continue;
		const kind: Sink['kind'] = m[0].includes('inner_html')
			? 'inner_html'
			: m[0].includes('value_string')
				? 'value_string'
				: /innerHTML|outerHTML|setHTMLUnsafe|createContextualFragment/.test(m[0])
					? 'innerHTML'
					: 'insertAdjacentHTML';
		// the helper's own `value_string` destructuring/option reads are the
		// SINK, not a call site — they are counted as its innerHTML/insert sinks
		if (kind === 'value_string' && file.endsWith('common/js/ui.js')) continue;
		const at = m.index as number;
		const start = at + m[0].length;
		const expr =
			kind === 'innerHTML' ? scanExpr(src, start, ';', true) : scanExpr(src, start, ',', false);
		const cls = classifyExpr(expr, src, at);
		// `.innerHTML += x` IS a concatenation: it splices x into the node's markup
		const concat = cls === 'dynamic' && (m[1] === '+=' || concatenatesDynamic(expr, src, at));
		sinks.push({ file, line: lineOf(at), kind, expr, cls, concat });
	}
	return sinks;
}

/**
 * The HTML-FORWARDING HELPERS of ui.js: an option string a caller hands them
 * reaches `inner_html` / insertAdjacentHTML unchanged, so the CALL SITE is a
 * sink of its own — `ui.attach_to_modal({header|body|footer})`,
 * `ui.build_button({label})` and `ui.update_node_content(node, value)`.
 * (`ui.confirm` left the list 2026-10-25: BOTH its string slots — header and
 * body — are now built with text_content, so a confirm call site hands no
 * string to the parser. Its own `attach_to_modal({header, body})` call is
 * counted in ui.js's ratchet entry, and the OUTCOME — markup in either slot
 * renders as text — is driven by the client gate test_client_xss_escapes.js;
 * a revert to a parsed body goes red there.) A census that stopped at the helper's
 * body would count these once (in ui.js's ratchet) and bless every caller.
 * Shorthand properties (`{ header }`) resolve as the identifier; an options
 * argument that is not an object literal is the whole unread value: dynamic.
 */
const HELPER_OPTIONS: Readonly<Record<string, readonly string[]>> = {
	attach_to_modal: ['header', 'body', 'footer'],
	build_button: ['label'],
};
const HELPER_CALL_RE = /\bui\.(attach_to_modal|build_button|update_node_content)\s*\(/g;

/**
 * Source with comments blanked (strings and regex literals respected), same
 * length. A quote never spans a line (only a template does), and a `/` after
 * an operator, a bracket or a keyword opens a regex literal, not a division.
 */
function stripComments(s: string): string {
	let out = '';
	let i = 0;
	while (i < s.length) {
		const c = s[i] as string;
		if (c === '"' || c === "'" || c === '`') {
			let k = i + 1;
			while (k < s.length && s[k] !== c && (c === '`' || s[k] !== '\n')) k += s[k] === '\\' ? 2 : 1;
			out += s.slice(i, k + 1);
			i = k + 1;
			continue;
		}
		if (c === '/' && s[i + 1] !== '/' && s[i + 1] !== '*') {
			const before = out.replace(/\s+$/, '');
			if (
				before === '' ||
				/[(,=:[!&|?{};+\-*%<>~^]$/.test(before) ||
				/\b(return|typeof|case|in|of)$/.test(before)
			) {
				let k = i + 1;
				let inClass = false;
				while (k < s.length && s[k] !== '\n' && (inClass || s[k] !== '/')) {
					if (s[k] === '\\') k += 2;
					else {
						if (s[k] === '[') inClass = true;
						else if (s[k] === ']') inClass = false;
						k++;
					}
				}
				out += s.slice(i, k + 1);
				i = k + 1;
				continue;
			}
		}
		if (c === '/' && s[i + 1] === '/') {
			while (i < s.length && s[i] !== '\n') {
				out += ' ';
				i++;
			}
			continue;
		}
		if (c === '/' && s[i + 1] === '*') {
			const e = s.indexOf('*/', i + 2);
			const end = e < 0 ? s.length : e + 2;
			out += s.slice(i, end).replace(/[^\n]/g, ' ');
			i = end;
			continue;
		}
		out += c;
		i++;
	}
	return out;
}

/** Balanced over ()[]{} with strings and template literals skipped. */
function balancedCode(s: string): boolean {
	let d = 0;
	let i = 0;
	while (i < s.length) {
		const c = s[i] as string;
		if (c === '"' || c === "'" || c === '`') {
			let k = i + 1;
			while (k < s.length && s[k] !== c) k += s[k] === '\\' ? 2 : 1;
			i = k + 1;
			continue;
		}
		if ('([{'.includes(c)) d++;
		if (')]}'.includes(c)) {
			d--;
			if (d < 0) return false;
		}
		i++;
	}
	return d === 0;
}

function helperSinks(file: string, src: string): Sink[] {
	const sinks: Sink[] = [];
	const lineOf = (i: number): number => src.slice(0, i).split('\n').length;
	const add = (at: number, expr: string): void => {
		const cls = classifyExpr(expr, src, at);
		sinks.push({
			file,
			line: lineOf(at),
			kind: 'helper_option',
			expr,
			cls,
			concat: cls === 'dynamic' && concatenatesDynamic(expr, src, at),
		});
	};
	const code = stripComments(src); // same length: positions hold
	for (const m of code.matchAll(HELPER_CALL_RE)) {
		const at = m.index as number;
		const helper = m[1] as string;
		const open = at + m[0].length - 1;
		const close = matchParen(code, open);
		const args = splitArgs(code.slice(open + 1, close));
		if (helper === 'update_node_content') {
			add(at, args[1] ?? 'undefined');
			continue;
		}
		const keys = HELPER_OPTIONS[helper] as readonly string[];
		const arg = (args[0] ?? '').trim();
		if (!(arg.startsWith('{') && arg.endsWith('}') && balancedCode(arg.slice(1, -1)))) {
			// the options travel as a value this census cannot read: every
			// forwarded key is the caller's own
			for (const key of keys) add(at, arg === '' ? 'undefined' : `${arg}.${key}`);
			continue;
		}
		for (const entry of splitArgs(arg.slice(1, -1))) {
			const e = entry.trim();
			if (e === '') continue;
			const pair = e.match(/^(['"]?)([A-Za-z_$][\w$]*)\1\s*:\s*([\s\S]+)$/);
			if (pair) {
				if (keys.includes(pair[2] as string)) add(at, (pair[3] as string).trim());
				continue;
			}
			if (/^[A-Za-z_$][\w$]*$/.test(e) && keys.includes(e)) add(at, e);
			// a method shorthand or a spread is not one of the forwarded keys
		}
	}
	return sinks;
}

function censusFile(file: string): Sink[] {
	const src = read(file);
	return [...censusSource(file, src), ...helperSinks(file, src)];
}

// ---------------------------------------------------------------------------
// Scope + the two exemption tiers.
// ---------------------------------------------------------------------------

/** The component render surface: every component home, the grid, the login page. */
const RENDER_SURFACE =
	/^client\/dedalo\/core\/(component_[a-z_0-9]+|dd_grid|login)\/js\/[^/]+\.js$/;

/**
 * ENUMERATED exemptions on the render surface — one entry per sink, with the
 * reason it is not (yet) escaper-fed. SHRINK-ONLY: an entry is deleted by the
 * commit that routes its sink through the escaper. Matched by file + a
 * substring of the sink's value expression.
 */
const RENDER_SURFACE_EXEMPTIONS: ReadonlyArray<{ file: string; expr: string; reason: string }> = [
	{
		file: 'client/dedalo/core/component_external/js/external_render.js',
		expr: "render_value(value, 'html')",
		reason:
			"External record entries carry a per-ENTRY kind on the wire, not a per-model class: the ONE 'markup' branch is server-sanitised (src/external/fields_map.ts sanitizeMarkup) and enters the escaper as trusted 'html'; every other kind is a text node. The literal is the wire kind's translation, not a renderer's own decision — routes through a per-entry render_class when the external wire carries one.",
	},
];

/**
 * Per-file SHRINK-ONLY ratchet of dynamic sinks OUTSIDE the render surface —
 * areas, section, services, widgets, ts_object, tools. Exact counts: a
 * commit that escapes a sink lowers its file's count in the same commit, and
 * a file that reaches zero is deleted from the map. A new file, or a higher
 * count, is red. The ONE legitimate raise is a WIDER CENSUS (a sink kind the
 * classifier did not see before — the helper-option kind added the
 * update_code / ui.js / section.js / view_tm_list_section / render_ts_line /
 * tool_diffusion / tool_transcription entries) or a SHARPER classifier (block
 * scoping + callback reassignment took render_tool_indexation from 6 to 7: a
 * record value an `if`-block twin used to bless): both re-measure sinks that
 * were always there, and the commit that widens the census records them.
 */
const REMAINDER_RATCHET: Readonly<Record<string, number>> = {
	'client/dedalo/core/area_graph/js/render_area_graph.js': 2,
	'client/dedalo/core/area_maintenance/js/render_area_maintenance.js': 6,
	'client/dedalo/core/area_maintenance/widgets/ai_models/js/render_ai_models.js': 2,
	'client/dedalo/core/area_maintenance/widgets/build_database_version/js/render_build_database_version.js': 1,
	'client/dedalo/core/area_maintenance/widgets/check_config/js/render_check_config.js': 1,
	'client/dedalo/core/area_maintenance/widgets/diffusion_server_control/js/render_diffusion_server_control.js': 2,
	'client/dedalo/core/area_maintenance/widgets/diffusion_server_control/js/rollup_panel.js': 1,
	'client/dedalo/core/area_maintenance/widgets/export_hierarchy/js/render_export_hierarchy.js': 1,
	'client/dedalo/core/area_maintenance/widgets/make_backup/js/render_make_backup.js': 1,
	'client/dedalo/core/area_maintenance/widgets/media_control/js/render_media_control.js': 2,
	'client/dedalo/core/area_maintenance/widgets/move_lang/js/render_move_lang.js': 1,
	'client/dedalo/core/area_maintenance/widgets/move_locator/js/render_move_locator.js': 1,
	'client/dedalo/core/area_maintenance/widgets/move_tld/js/render_move_tld.js': 1,
	'client/dedalo/core/area_maintenance/widgets/move_to_portal/js/render_move_to_portal.js': 1,
	'client/dedalo/core/area_maintenance/widgets/move_to_table/js/render_move_to_table.js': 1,
	'client/dedalo/core/area_maintenance/widgets/register_tools/js/render_register_tools.js': 1,
	'client/dedalo/core/area_maintenance/widgets/runtime_info/js/render_runtime_info.js': 1,
	// moved out of render_update_ontology.js with the serving readout (2026-09-28), not new
	'client/dedalo/core/area_maintenance/widgets/serve_ontology/js/render_serve_ontology.js': 1,
	'client/dedalo/core/area_maintenance/widgets/update_code/js/render_update_code.js': 1,
	'client/dedalo/core/area_maintenance/widgets/update_ontology/js/render_update_ontology.js': 4,
	'client/dedalo/core/area_thesaurus/js/render_area_thesaurus.js': 4,
	'client/dedalo/core/common/js/dd-modal.js': 1,
	'client/dedalo/core/common/js/render_common.js': 3,
	'client/dedalo/core/common/js/ui.js': 18,
	'client/dedalo/core/common/js/utils/util.js': 1,
	'client/dedalo/core/inspector/js/render_inspector.js': 2,
	'client/dedalo/core/menu/js/menu.js': 1,
	'client/dedalo/core/menu/js/render_menu_mobile.js': 1,
	'client/dedalo/core/menu/js/render_menu_tree.js': 1,
	'client/dedalo/core/page/js/render_page.js': 1,
	'client/dedalo/core/relation_list/js/render_relation_list.js': 1,
	'client/dedalo/core/search/js/render_search.js': 5,
	'client/dedalo/core/section/js/render_open_list_with_direct_relations.js': 2,
	'client/dedalo/core/section/js/view_default_list_section.js': 1,
	'client/dedalo/core/section/js/view_graph_list_section.js': 2,
	'client/dedalo/core/section/js/view_graph_solved_section.js': 1,
	'client/dedalo/core/section_group/js/render_section_group.js': 1,
	'client/dedalo/core/section_record/js/view_mini_section_record.js': 1,
	'client/dedalo/core/section_record/js/view_text_section_record.js': 2,
	'client/dedalo/core/section_tab/js/render_section_tab.js': 1,
	'client/dedalo/core/services/service_autocomplete/js/view_default_autocomplete.js': 2,
	'client/dedalo/core/services/service_ckeditor/js/render_text_editor.js': 2,
	'client/dedalo/core/services/service_upload/js/render_edit_service_upload.js': 2,
	'client/dedalo/core/ts_object/js/render_ts_line.js': 2,
	'client/dedalo/core/widgets/calculation/js/render_calculation.js': 3,
	'client/dedalo/core/widgets/dd/user_activity/js/render_user_activity.js': 5,
	'client/dedalo/core/widgets/dmm/get_archive_states/js/render_get_archive_states.js': 2,
	'client/dedalo/core/widgets/mdcat/sum_dates/js/render_sum_dates.js': 2,
	'client/dedalo/core/widgets/numisdata/get_archive_weights/js/render_get_archive_weights.js': 8,
	'client/dedalo/core/widgets/oh/media_icons/js/render_media_icons.js': 2,
	'client/dedalo/core/widgets/oh/tags/js/render_tags.js': 1,
	'client/dedalo/core/widgets/state/js/render_edit_state.js': 2,
	'client/dedalo/core/widgets/state/js/render_list_state.js': 2,
	'tools/tool_assistant/js/chat_render.js': 2,
	'tools/tool_dd_label/js/render_tool_dd_label.js': 2,
	'tools/tool_dev_template/js/render_tool_dev_template.js': 4,
	'tools/tool_diffusion/js/render_tool_diffusion.js': 2,
	'tools/tool_hierarchy/js/render_tool_hierarchy.js': 5,
	'tools/tool_image_rotation/js/render_tool_image_rotation.js': 5,
	'tools/tool_image_rotation/js/tool_image_rotation.js': 2,
	'tools/tool_import_dedalo_csv/js/render_tool_import_dedalo_csv.js': 7,
	'tools/tool_import_files/js/render_tool_import_files.js': 11,
	'tools/tool_import_rdf/js/render_tool_import_rdf.js': 1,
	'tools/tool_indexation/js/render_tool_indexation.js': 5,
	'tools/tool_indexation/js/tag_note.js': 1,
	'tools/tool_lang/js/browser_translation.js': 4,
	'tools/tool_lang/js/render_tool_lang.js': 9,
	'tools/tool_lang_multi/js/render_tool_lang_multi.js': 4,
	'tools/tool_lang_multi/js/tool_lang_multi.js': 4,
	'tools/tool_media_versions/js/render_tool_media_versions.js': 8,
	'tools/tool_ontology/js/render_tool_ontology.js': 1,
	'tools/tool_ontology_parser/js/render_tool_ontology_parser.js': 11,
	'tools/tool_pdf_extractor/js/render_tool_pdf_extractor.js': 5,
	'tools/tool_posterframe/js/render_tool_posterframe.js': 2,
	'tools/tool_print/js/canvas_tool_print.js': 1,
	'tools/tool_print/js/render_box_tool_print.js': 4,
	'tools/tool_print/js/render_tool_print.js': 10,
	'tools/tool_propagate_component_data/js/render_tool_propagate_component_data.js': 7,
	'tools/tool_qr/js/render_tool_qr.js': 1,
	'tools/tool_sitebuilder/js/sitebuilder_controller.js': 1,
	'tools/tool_subtitles/js/render_tool_subtitles.js': 8,
	'tools/tool_tc/js/render_tool_tc.js': 1,
	'tools/tool_time_machine/js/render_tool_time_machine.js': 3,
	'tools/tool_time_machine/js/tool_time_machine.js': 1,
	'tools/tool_tr_print/js/render_tool_tr_print.js': 7,
	'tools/tool_transcription/js/render_tool_transcription.js': 23,
	'tools/tool_transcription/js/tool_transcription.js': 5,
	'tools/tool_update_cache/js/render_tool_update_cache.js': 7,
};

// ---------------------------------------------------------------------------
// The real escaper, loaded out of the browser module (no DOM needed).
// ---------------------------------------------------------------------------

interface Escaper {
	escape_html: (value: unknown) => string;
	render_value: (value: unknown, cls?: unknown) => string | string[];
	render_join: (values: unknown, separator: unknown, cls?: unknown) => string;
	render_fallback_value: (entries: unknown[], fallback: unknown, cls?: unknown) => string[];
}

function loadEscaper(): Escaper {
	// the real scheme allowlist, as url_sink_allowlist_tripwire loads it
	const util = read(UTIL);
	const safeStart = util.indexOf('export const safe_url');
	const safeBody = util.slice(safeStart, util.indexOf('}//end safe_url') + 1);
	const safe_url = new Function(
		'window',
		'URL',
		`return ${safeBody.slice(safeBody.indexOf('function(value)'))}`,
	)({ location: { origin: 'https://example.org' } }, URL);

	const source = read(ESCAPER)
		.replace(/^\s*import .*$/gm, '')
		.replace(/^export const /gm, 'const ');
	const factory = new Function(
		'safe_url',
		`${source}\nreturn { escape_html, render_value, render_join, render_fallback_value }`,
	);
	return factory(safe_url) as Escaper;
}

// ---------------------------------------------------------------------------

describe('one escaper at the render boundary — the census', () => {
	const files = clientFiles();
	const sinks = files.flatMap(censusFile);
	const byClass = (cls: Cls): Sink[] => sinks.filter((s) => s.cls === cls);
	const describeSink = (s: Sink): string =>
		`${s.file}:${s.line} [${s.kind}] ${s.expr.replace(/\s+/g, ' ').slice(0, 100)}`;

	test('the census is TOTAL and non-vacuous (corpus floors)', () => {
		expect(files.length).toBeGreaterThan(500);
		expect(sinks.length).toBeGreaterThan(1000);
		expect(byClass('escaped').length).toBeGreaterThan(100);
		expect(byClass('label').length).toBeGreaterThan(200);
		expect(byClass('static').length).toBeGreaterThan(150);
		// the terminal sink every inner_html option reaches is IN the census
		expect(
			sinks.some(
				(s) =>
					s.file === 'client/dedalo/core/common/js/ui.js' &&
					s.kind === 'insertAdjacentHTML' &&
					s.expr === 'options.inner_html',
			),
		).toBe(true);
	});

	test('the component render surface holds ZERO unescaped dynamic sinks bar the enumerated list', () => {
		const surface = sinks.filter((s) => RENDER_SURFACE.test(s.file));
		expect(surface.length).toBeGreaterThan(150); // every component home + grid + login
		expect(surface.filter((s) => s.cls === 'escaped').length).toBeGreaterThan(100);
		const isExempt = (s: Sink): boolean =>
			RENDER_SURFACE_EXEMPTIONS.some((e) => e.file === s.file && s.expr.includes(e.expr));
		const offenders = surface.filter((s) => s.cls === 'dynamic' && !isExempt(s));
		expect(
			offenders.map(describeSink),
			'a component value reaches an HTML sink without the ONE escaper (render_escape.js render_value / render_join / render_fallback_value); an escaped value is never re-escaped locally',
		).toEqual([]);
	});

	test('the enumerated exemptions are alive (shrink-only: a routed sink deletes its entry)', () => {
		for (const exemption of RENDER_SURFACE_EXEMPTIONS) {
			expect(exemption.reason.length).toBeGreaterThan(20);
			const alive = sinks.some(
				(s) => s.file === exemption.file && s.cls === 'dynamic' && s.expr.includes(exemption.expr),
			);
			expect(
				alive,
				`${exemption.file} ${exemption.expr}: no longer a dynamic sink — delete the exemption`,
			).toBe(true);
		}
	});

	test('the remainder is a per-file shrink-only ratchet (exact counts)', () => {
		const actual: Record<string, number> = {};
		for (const s of sinks) {
			if (RENDER_SURFACE.test(s.file) || s.cls !== 'dynamic') continue;
			actual[s.file] = (actual[s.file] ?? 0) + 1;
		}
		// RENDER_ESCAPE_DUMP=1 prints the measured map, to paste into the ratchet
		// after a closure (never to raise a count).
		if (process.env.RENDER_ESCAPE_DUMP === '1') console.log(JSON.stringify(actual, null, '\t'));
		if (process.env.RENDER_ESCAPE_DUMP === '2')
			for (const s of sinks)
				if (s.kind === 'helper_option' && s.cls === 'dynamic') console.log(describeSink(s));
		const problems: string[] = [];
		for (const [file, count] of Object.entries(actual)) {
			const allowed = REMAINDER_RATCHET[file];
			if (allowed === undefined) {
				problems.push(
					`${file}: ${count} dynamic sink(s) in a file not in the ratchet — route them through the escaper`,
				);
			} else if (count > allowed) {
				problems.push(
					`${file}: ${count} dynamic sinks, ratchet allows ${allowed} — a new unescaped sink`,
				);
			} else if (count < allowed) {
				problems.push(
					`${file}: ${count} dynamic sinks, ratchet says ${allowed} — lower it (shrink-only, exact)`,
				);
			}
		}
		for (const file of Object.keys(REMAINDER_RATCHET)) {
			if (actual[file] === undefined)
				problems.push(`${file}: zero dynamic sinks — delete it from the ratchet`);
		}
		expect(problems).toEqual([]);
		expect(Object.keys(REMAINDER_RATCHET).length).toBeGreaterThan(50); // the ratchet has a corpus
	});

	test('NO value is concatenated into markup — the whole census, zero, no exemption', () => {
		// MARKUP CONCATENATION (concatenatesDynamic) — the shape of the stored XSS
		// CodeQL found (#7930 vector_editor delete-layer dialog, #7940 render_search
		// label_add): a value the classifier cannot prove safe SPLICED into a string
		// the HTML parser reads. Burned to zero 2026-10-25 (90 sinks: record values,
		// counts, labels — every one rebuilt as nodes / text_content). There is no
		// exemption list on purpose: the markup half is always the renderer's own,
		// so it can always be built as nodes with the value handed to text_content
		// (or render_value with the server's class).
		const offenders = sinks.filter((s) => s.concat).map(describeSink);
		// RENDER_ESCAPE_DUMP=3 lists them
		if (process.env.RENDER_ESCAPE_DUMP === '3') for (const o of offenders) console.log(o);
		expect(
			offenders,
			'a value is spliced into markup: build the markup as nodes and pass the value as text_content',
		).toEqual([]);
	});

	test('positive control: the concatenation shapes CodeQL found are flagged, their fixes are not', () => {
		const at = (code: string): Array<{ cls: Cls; concat: boolean }> =>
			censusSource('positive_control.js', code).map((s) => ({ cls: s.cls, concat: s.concat }));
		// #7930: a user-typed record value spliced between markup
		expect(
			at(
				"ui.create_dom_element({ inner_html: 'Layer: ' + layer.user_layer_name + '<br><br>' + (get_label.sure || 'Sure?') })",
			),
		).toEqual([{ cls: 'dynamic', concat: true }]);
		// #7940: a stored path name prepended by round-tripping innerHTML
		expect(at("label_add.innerHTML = first_item.name +' '+ label_add.innerHTML")).toEqual([
			{ cls: 'dynamic', concat: true },
		]);
		// template, `+=` sink, one hop through a local, a `+=` accumulator, a ternary branch
		expect(at('node.innerHTML = `<b>${row.term}</b>`')).toEqual([{ cls: 'dynamic', concat: true }]);
		expect(at('node.innerHTML += row.term')).toEqual([{ cls: 'dynamic', concat: true }]);
		expect(at("const html = '<i>' + row.term\nnode.innerHTML = html")).toEqual([
			{ cls: 'dynamic', concat: true },
		]);
		expect(at("let html = '<ul>'\nhtml += '<li>' + row.term\nnode.innerHTML = html")).toEqual([
			{ cls: 'dynamic', concat: true },
		]);
		expect(at("ui.create_dom_element({ inner_html: ok ? '<b>' + row.term : '' })")).toEqual([
			{ cls: 'dynamic', concat: true },
		]);
		// a bare dynamic value is the ratchet's, not a concatenation
		expect(at('ui.create_dom_element({ inner_html: row.term })')).toEqual([
			{ cls: 'dynamic', concat: false },
		]);
		// the fixes: escaped pieces, labels and literals concatenate freely
		expect(
			at(
				"import {render_value} from '../../common/js/utils/render_escape.js'\nui.create_dom_element({ inner_html: '<b>' + render_value(row.term, 'text') + '</b>' + (get_label.sure || 'Sure?') })",
			),
		).toEqual([{ cls: 'escaped', concat: false }]);
		// a text sink is not a sink at all
		expect(
			at("ui.create_dom_element({ text_content: 'Layer: ' + layer.user_layer_name })"),
		).toEqual([]);
	});

	test('positive control: the classifier flags the audit shape and clears the escaper', () => {
		const offender = [
			'const label = datalist_item.label',
			"ui.create_dom_element({ element_type: 'span', inner_html: label })",
			'node.innerHTML = current_value.value',
			"wrapper.insertAdjacentHTML('afterbegin', entries.join(self.context.fields_separator))",
			"const value_string = entries.map(i => i.value).join(' | ')",
			'ui.component.build_wrapper_list(self, { value_string: value_string })',
		].join('\n');
		const flagged = censusSource('positive_control.js', offender);
		expect(flagged.map((s) => s.cls)).toEqual(['dynamic', 'dynamic', 'dynamic', 'dynamic']);

		const fixed = [
			"import {render_value, render_join, render_fallback_value, escape_html} from '../../common/js/utils/render_escape.js'",
			'const label = render_value(datalist_item.label, self.context.render_class)',
			"ui.create_dom_element({ element_type: 'span', inner_html: label })",
			"node.innerHTML = render_value(current_value.value, 'text')",
			"wrapper.insertAdjacentHTML('afterbegin', render_join(entries, self.context.fields_separator, 'text'))",
			"const fallback = render_fallback_value(entries, fallback_value, 'text')",
			'const value_string = fallback.join(escape_html(self.context.fields_separator))',
			'ui.component.build_wrapper_list(self, { value_string: value_string })',
			"ui.create_dom_element({ inner_html: (get_label.delete || 'Delete') + ' ' + render_value(id, 'number') })",
			"ui.create_dom_element({ inner_html: get_label.sure || 'Sure?' })",
			'ui.create_dom_element({ inner_html: \'<span class="x">static</span>\' })',
		].join('\n');
		expect(censusSource('positive_control.js', fixed).map((s) => s.cls)).toEqual([
			'escaped',
			'escaped',
			'escaped',
			'escaped',
			'escaped',
			'label',
			'static',
		]);

		// the escaper's NAME is not the escaper: an un-imported call, an `as`
		// rename, a local passthrough shadow, a later raw reassignment and an
		// appended raw fragment are all dynamic
		const IMPORT =
			"import {render_value, render_join} from '../../common/js/utils/render_escape.js'";
		for (const shape of [
			"inner_html: render_value(item.label, 'text')",
			`import {escape_html as render_value} from '../../common/js/utils/render_escape.js'\ninner_html: render_value(item.label, 'text')`,
			`${IMPORT}\nconst render_value = (v) => String(v)\ninner_html: render_value(item.label, 'text')`,
			`${IMPORT}\nfunction render_join(v, s) { return [].concat(v).join(s) }\ninner_html: render_join(items, ' | ', 'text')`,
			`${IMPORT}\nlet out = render_value(item.label, 'text')\nout = item.label\ninner_html: out`,
			`${IMPORT}\nlet out = render_value(item.label, 'text')\nout += item.label\ninner_html: out`,
		]) {
			const list = censusSource('positive_control.js', shape);
			expect(list.at(-1)?.cls, shape).toBe('dynamic');
		}
		// and the same shapes, un-subverted, are escaped (the control is not vacuous)
		for (const shape of [
			`${IMPORT}\ninner_html: render_value(item.label, 'text')`,
			`${IMPORT}\nlet out = render_value(item.label, 'text')\nout = render_value(item.other, 'text')\ninner_html: out`,
			`${IMPORT}\nlet out = render_value(item.label, 'text')\nout += render_value(item.other, 'text')\ninner_html: out`,
		]) {
			const list = censusSource('positive_control.js', shape);
			expect(list.at(-1)?.cls, shape).toBe('escaped');
		}

		// SCOPE: a function PARAMETER is the caller's value — a sibling function's
		// literal of the same name does not make it static (the check_box shape:
		// a `(i, current_value, self)` helper sinking its parameter raw while an
		// earlier sibling declares `const current_value = ''`)
		const SIBLING =
			"const build = (self) => {\n\tconst current_value = ''\n\treturn current_value\n}";
		for (const shape of [
			`${IMPORT}\n${SIBLING}\nconst read = (i, current_value, self) => {\n\tui.create_dom_element({ inner_html: current_value })\n}`,
			`${IMPORT}\n${SIBLING}\nfunction read(i, current_value, self) {\n\tui.create_dom_element({ inner_html: current_value })\n}`,
			`${IMPORT}\n${SIBLING}\nconst read = current_value => ui.create_dom_element({ inner_html: current_value })`,
			`${IMPORT}\n${SIBLING}\nconst read = { render(i, current_value, self) {\n\tui.create_dom_element({ inner_html: current_value })\n} }`,
			`${IMPORT}\n${SIBLING}\nconst read = (i, current_value, self) => {\n\ttry { x() } catch (current_value) { ui.create_dom_element({ inner_html: current_value }) }\n}`,
			// a sibling function's ESCAPED local does not bless an outer raw value either
			`${IMPORT}\nconst build = (self) => {\n\tconst label = render_value(self.label, 'text')\n\treturn label\n}\nconst read = (item) => {\n\tconst label = item.label\n\tui.create_dom_element({ inner_html: label })\n}`,
			// a default parameter is a caller's value too
			`${IMPORT}\n${SIBLING}\nconst read = (i, current_value = '', self) => {\n\tui.create_dom_element({ inner_html: current_value })\n}`,
			// a parameter SHADOWS a module-level static of the same name
			`${IMPORT}\nconst current_value = ''\nconst read = (i, current_value, self) => {\n\tui.create_dom_element({ inner_html: current_value })\n}`,
			// a sibling function's local is not visible at all (no parameter involved)
			`${IMPORT}\n${SIBLING}\nconst read = (i, self) => {\n\tui.create_dom_element({ inner_html: current_value })\n}`,
		]) {
			const list = censusSource('positive_control.js', shape);
			expect(list.at(-1)?.cls, shape).toBe('dynamic');
		}
		// and the parameter reassigned THROUGH the escaper inside the body, or a
		// module-level static visible from the sink, is not (the control is not vacuous)
		for (const [shape, cls] of [
			[
				`${IMPORT}\n${SIBLING}\nconst read = (i, current_value, self) => {\n\tcurrent_value = render_value(current_value, self.context.render_class)\n\tui.create_dom_element({ inner_html: current_value })\n}`,
				'escaped',
			],
			[
				`${IMPORT}\nconst current_value = '<i>static</i>'\nconst read = (i, self) => {\n\tui.create_dom_element({ inner_html: current_value })\n}`,
				'static',
			],
		] as const) {
			const list = censusSource('positive_control.js', shape);
			expect(list.at(-1)?.cls, shape).toBe(cls);
		}

		// THE CLASS ARGUMENT: the escaper's name with a literal 'html' is a
		// verbatim passthrough — only the SERVER's render_class (or a narrower
		// literal) is the escaper
		for (const shape of [
			`${IMPORT}\ninner_html: render_value(item.label, 'html')`,
			`${IMPORT}\ninner_html: render_value(item.label, "html")`,
			`${IMPORT}\ninner_html: render_join(items, ' | ', 'html')`,
			`${IMPORT}\nconst out = render_fallback_value(entries, fallback, 'html')\ninner_html: out.join(' ')`,
			`${IMPORT}\nconst render_class = 'html'\ninner_html: render_value(item.label, render_class)`,
			`${IMPORT}\ninner_html: render_value(item.label, is_rich ? 'html' : 'text')`,
			`${IMPORT}\ninner_html: render_value(item.label, self.context.render_class || 'html')`,
			`${IMPORT}\ninner_html: render_value(item.label, item.kind)`,
			`${IMPORT}\ninner_html: render_value(item.label, get_class(item))`,
			`${IMPORT}\nconst read = (render_class) => ui.create_dom_element({ inner_html: render_value(item.label, render_class) })`,
		]) {
			const list = censusSource('positive_control.js', shape);
			expect(list.at(-1)?.cls, shape).toBe('dynamic');
		}
		for (const shape of [
			`${IMPORT}\ninner_html: render_value(item.label, self.context.render_class)`,
			`${IMPORT}\ninner_html: render_value(item.label, data_item.render_class)`,
			`${IMPORT}\ninner_html: render_value(item.label, column?.render_class)`,
			`${IMPORT}\ninner_html: render_value(item.label, self.context.render_class || 'text')`,
			`${IMPORT}\ninner_html: render_value(item.label)`,
			`${IMPORT}\ninner_html: render_value(item.label, 'number')`,
			`${IMPORT}\ninner_html: render_join(items, ' | ', self.context.render_class)`,
			`${IMPORT}\nconst render_class = self.context.render_class\ninner_html: render_value(item.label, render_class)`,
		]) {
			const list = censusSource('positive_control.js', shape);
			expect(list.at(-1)?.cls, shape).toBe('escaped');
		}

		// every parser sink is a sink: outerHTML, a variable insert position,
		// setHTMLUnsafe, createContextualFragment
		for (const shape of [
			'node.outerHTML = item.label',
			'node.insertAdjacentHTML(position, item.label)',
			'node.setHTMLUnsafe(item.label)',
			'range.createContextualFragment(item.label)',
		]) {
			const [sink] = censusSource('positive_control.js', shape);
			expect(sink?.cls, shape).toBe('dynamic');
		}

		// a classifier that trusts a plain function call, a bare property, an
		// unescaped join separator or a raw array push is no classifier
		for (const shape of [
			'inner_html: strip_tags(item.label)',
			'inner_html: item.label',
			"inner_html: render_value(entries, 'text').join(self.context.fields_separator)",
			'inner_html: `${item.label}`',
			"inner_html: acc.join(' | ')\nconst acc = []\nacc.push(item.label)",
			// an accumulator filled any way but push, or never filled at all
			"const acc = []\nacc[0] = item.label\ninner_html: acc.join('')",
			"const acc = []\nacc.unshift('<b>')\ninner_html: acc.join('')",
			"const acc = []\nacc.splice(0, 0, '<b>')\ninner_html: acc.join('')",
			"const acc = []\ninner_html: acc.join('')",
			// one that pushes an ESCAPED value but is ALSO filled the other way:
			// the push-count floor alone would bless it
			`${IMPORT}\nconst acc = []\nacc.push(render_value(item.label, 'text'))\nacc[0] = item.label\ninner_html: acc.join('')`,
			`${IMPORT}\nconst acc = []\nacc.push(render_value(item.label, 'text'))\nacc.unshift(item.label)\ninner_html: acc.join('')`,
			`${IMPORT}\nconst acc = []\nacc.push(render_value(item.label, 'text'))\nacc.splice(0, 0, item.label)\ninner_html: acc.join('')`,
			`${IMPORT}\nconst acc = []\nacc.push(render_value(item.label, 'text'))\nacc.fill(item.label)\ninner_html: acc.join('')`,
			`${IMPORT}\nconst acc = []\nacc.push(render_value(item.label, 'text'))\nacc.concat(items)\ninner_html: acc.join('')`,
			// a BLOCK-LOCAL twin does not bless the outer raw value, and an
			// assignment inside a branch the sink is not in only ADDS a possible
			// value (the branch may not have run), it never overwrites
			`${IMPORT}\nconst read = (item) => {\n\tlet out = item.label\n\tif (x) { const out = render_value(item.label, 'text') }\n\tui.create_dom_element({ inner_html: out })\n}`,
			`${IMPORT}\nconst read = (item) => {\n\tlet out = item.label\n\tif (x) { out = render_value(item.label, 'text') }\n\tui.create_dom_element({ inner_html: out })\n}`,
			// a CALLBACK reassigns the binding the sink reads, at a time no textual
			// scan knows: it is folded in, not dropped
			`${IMPORT}\nconst read = (item) => {\n\tlet out = render_value(item.label, 'text')\n\titems.forEach((i) => { out = i.label })\n\tui.create_dom_element({ inner_html: out })\n}`,
			// a LOOP BACK-EDGE: the reassignment after the sink is the next
			// iteration's value
			`${IMPORT}\nlet out = render_value(items[0], self.context.render_class)\nfor (const item of items) {\n\tui.create_dom_element({ inner_html: out })\n\tout = item.value\n}`,
			`${IMPORT}\nlet out = render_value(items[0], self.context.render_class)\nfor (const item of items) {\n\tui.create_dom_element({ inner_html: out })\n\tout += item.value\n}`,
		]) {
			const [sink] = censusSource('positive_control.js', shape);
			expect(sink?.cls, shape).toBe('dynamic');
		}
		// and the same accumulator / loop shapes, fed through the escaper, are not
		for (const shape of [
			`${IMPORT}\nconst acc = []\nacc.push(render_value(item.label, 'text'))\ninner_html: acc.join('')`,
			`${IMPORT}\nlet out = render_value(items[0], self.context.render_class)\nfor (const item of items) {\n\tui.create_dom_element({ inner_html: out })\n\tout = render_value(item.value, self.context.render_class)\n}`,
			`${IMPORT}\nconst read = (item) => {\n\tlet out = ''\n\tif (x) { out = render_value(item.a, 'text') } else { out = render_value(item.b, 'text') }\n\tui.create_dom_element({ inner_html: out })\n}`,
			`${IMPORT}\nconst read = (item) => {\n\tlet out = render_value(item.label, 'text')\n\titems.forEach((i) => { out = render_value(i.label, 'text') })\n\tui.create_dom_element({ inner_html: out })\n}`,
			`${IMPORT}\nconst read = (item) => {\n\tconst out = render_value(item.label, 'text')\n\titems.forEach((i) => { let out = i.label; use(out) })\n\tui.create_dom_element({ inner_html: out })\n}`,
			`${IMPORT}\nconst read = (item) => {\n\tconst out = render_value(item.label, 'text')\n\titems.forEach((out) => { out = out.label })\n\tui.create_dom_element({ inner_html: out })\n}`,
		]) {
			const [sink] = censusSource('positive_control.js', shape);
			expect(sink?.cls, shape).toBe('escaped');
		}
	});

	test('positive control: the HTML-forwarding helper options are sinks of their own', () => {
		const IMPORT = "import {render_value} from '../../common/js/utils/render_escape.js'";
		const helpers = (src: string): Sink[] =>
			helperSinks('positive_control.js', src).filter((s) => s.kind === 'helper_option');
		// the reviewer's shapes: a value handed to a helper that parses it
		for (const shape of [
			'ui.attach_to_modal({ header: item.value, body: item.label })',
			'ui.attach_to_modal({ header: item.value, body: item.label, footer: item.other })',
			'ui.build_button({ label: item.value })',
			'ui.update_node_content(self.node, item.value)',
			// shorthand property, resolved as the identifier
			'const header = self.target_section[0].label\nui.attach_to_modal({ header, body })',
			// an options object the census cannot read is the caller\'s own
			'ui.attach_to_modal(options)',
			'ui.attach_to_modal(build_options(self))',
			// a string renderer is not a node factory
			'ui.attach_to_modal({ header: markdown.render(item.value) })',
			'const section = markdown\nui.attach_to_modal({ body: section.render(item.value) })',
			// a comment or a regex before the call does not hide it
			"// don't\nconst x = s.replace(/'/g, '\"')\nui.attach_to_modal({ header: item.value })",
			// the helper inside a nested callback of another helper's options
			"ui.attach_to_modal({ header: 'x', body: node, callback: () => { ui.build_button({ label: item.value }) } })",
		]) {
			const list = helpers(shape);
			expect(list.length, shape).toBeGreaterThan(0);
			expect(
				list.some((s) => s.cls === 'dynamic'),
				shape,
			).toBe(true);
		}
		// counted per forwarded key: header + body + footer, nothing else
		expect(
			helpers('ui.attach_to_modal({ header: a, body: b, footer: c, size: d, on_close: e })').map(
				(s) => s.expr,
			),
		).toEqual(['a', 'b', 'c']);
		// a DOM NODE is inert, a labelled or escaped string is not dynamic
		for (const [shape, cls] of [
			["ui.attach_to_modal({ header: ui.create_dom_element({ element_type: 'div' }) })", 'static'],
			[
				"const body = ui.create_dom_element({ element_type: 'div', inner_html: item.value })\nui.attach_to_modal({ body })",
				'static',
			],
			["ui.attach_to_modal({ body: document.createElement('div') })", 'static'],
			[
				'const section = await get_instance({ tipo })\nconst section_node = await section.render()\nui.attach_to_modal({ body: section_node })',
				'static',
			],
			["ui.attach_to_modal({ header: get_label.warning || 'Warning' })", 'label'],
			[`${IMPORT}\nui.attach_to_modal({ header: render_value(item.label, 'text') })`, 'escaped'],
			[
				`${IMPORT}\nconst header = (get_label.new || 'New') + ' ' + render_value(target_section[0]?.label || '', 'text')\nui.attach_to_modal({ header })`,
				'escaped',
			],
			[
				`${IMPORT}\nui.build_button({ label: render_value(item.label, self.context.render_class) })`,
				'escaped',
			],
			[`${IMPORT}\nui.update_node_content(node, render_value(item.label, 'text'))`, 'escaped'],
		] as const) {
			const list = helpers(shape);
			expect(list.length, shape).toBeGreaterThan(0);
			expect(
				list.map((s) => s.cls),
				shape,
			).toEqual(list.map(() => cls));
		}
		// and the real tree holds them: every ui.attach_to_modal /
		// build_button / update_node_content call site is in the census
		const files = clientFiles();
		const callSites = files.reduce(
			(n, f) => n + [...stripComments(read(f)).matchAll(HELPER_CALL_RE)].length,
			0,
		);
		// 40, not 50: the 15 ui.confirm sites left the list 2026-10-25 (header AND body are text)
		expect(callSites).toBeGreaterThan(40);
		const counted = files.flatMap(censusFile).filter((s) => s.kind === 'helper_option');
		expect(counted.length).toBeGreaterThanOrEqual(callSites);
		expect(counted.filter((s) => s.cls === 'static').length).toBeGreaterThan(30); // node-fed
		expect(counted.filter((s) => s.cls === 'escaped').length).toBeGreaterThan(5); // routed this commit
	});
});

describe('one escaper at the render boundary — the escaper itself', () => {
	const escaper = loadEscaper();

	test('escape_html neutralizes the five HTML metacharacters and nothing else', () => {
		expect(escaper.escape_html(`<script>alert("x")</script> & 'q'`)).toBe(
			'&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;q&#39;',
		);
		expect(escaper.escape_html('plain – ok')).toBe('plain – ok');
		expect(escaper.escape_html(null)).toBe('');
		expect(escaper.escape_html(undefined)).toBe('');
		expect(escaper.escape_html(42)).toBe('42');
	});

	test("the DEFAULT branch escapes — an unknown, absent or misspelt class is 'text'", () => {
		const payload = '<img src=x onerror=alert(1)>';
		expect(escaper.render_value(payload, 'text')).toBe('&lt;img src=x onerror=alert(1)&gt;');
		expect(escaper.render_value(payload, undefined)).toBe('&lt;img src=x onerror=alert(1)&gt;');
		expect(escaper.render_value(payload, 'HTML')).toBe('&lt;img src=x onerror=alert(1)&gt;');
		expect(escaper.render_value(payload, 'markup')).toBe('&lt;img src=x onerror=alert(1)&gt;');
	});

	test("'html' passes the sanitizer's output through (the ONE trusted class)", () => {
		expect(escaper.render_value('<p><b>rich</b></p>', 'html')).toBe('<p><b>rich</b></p>');
		expect(escaper.render_value(null, 'html')).toBe('');
	});

	test("'url' runs the scheme allowlist, then escapes — a refused scheme is TEXT, never blank, never markup", () => {
		expect(escaper.render_value('https://viaf.org/viaf/1?a=1&b="2"', 'url')).toBe(
			'https://viaf.org/viaf/1?a=1&amp;b=&quot;2&quot;',
		);
		// a scheme the allowlist refuses is still the record's value: escaped
		// as text (a text node cannot navigate; the href sinks keep the guard)
		expect(escaper.render_value('javascript:alert("1")<b>', 'url')).toBe(
			'javascript:alert(&quot;1&quot;)&lt;b&gt;',
		);
		expect(escaper.render_value('urn:nbn:de:bvb:12-bsb00012345-6', 'url')).toBe(
			'urn:nbn:de:bvb:12-bsb00012345-6',
		);
		expect(escaper.render_value('ark:/12345/x<y>', 'url')).toBe('ark:/12345/x&lt;y&gt;');
		expect(escaper.render_value(null, 'url')).toBe('');
	});

	test("'number' renders a numeral and escapes anything that is not one", () => {
		expect(escaper.render_value(12.5, 'number')).toBe('12.5');
		expect(escaper.render_value('7', 'number')).toBe('7');
		expect(escaper.render_value('', 'number')).toBe('');
		expect(escaper.render_value('<b>1</b>', 'number')).toBe('&lt;b&gt;1&lt;/b&gt;');
	});

	test('arrays render element-wise; render_join escapes the separator as text', () => {
		expect(escaper.render_value(['<a>', 'b'], 'text')).toEqual(['&lt;a&gt;', 'b']);
		expect(escaper.render_join(['<a>', 'b'], ' <br> ', 'text')).toBe('&lt;a&gt; &lt;br&gt; b');
		expect(escaper.render_join(null, ' | ', 'text')).toBe('');
		expect(escaper.render_join('<x>', ' | ', 'text')).toBe('&lt;x&gt;');
	});

	test('render_fallback_value escapes BEFORE the <mark> wrap', () => {
		const out = escaper.render_fallback_value(
			[{ value: '<i>own</i>' }, undefined],
			[{ value: 'x' }, { value: '<b>fb</b>' }],
			'text',
		);
		expect(out).toEqual(['&lt;i&gt;own&lt;/i&gt;', '<mark>&lt;b&gt;fb&lt;/b&gt;</mark>']);
		// an html-class value keeps its markup inside the mark
		expect(escaper.render_fallback_value([], [{ value: '<b>fb</b>' }], 'html')).toEqual([
			'<mark><b>fb</b></mark>',
		]);
	});

	test('every escaper identifier on the render surface IS the imported escaper (no local twin)', () => {
		// a renderer that calls render_value must import it by that exact name
		// from render_escape.js and define nothing of that name itself — the
		// classifier blesses the name, so the name must be the module's
		const surface = clientFiles().filter((f) => RENDER_SURFACE.test(f));
		const using = surface.filter((f) =>
			new RegExp(`\\b(${ESCAPER_NAMES.join('|')})\\s*\\(`).test(read(f)),
		);
		expect(using.length).toBeGreaterThan(80);
		const problems: string[] = [];
		for (const file of using) {
			const src = read(file);
			const trusted = trustedEscapers(src);
			for (const name of ESCAPER_NAMES) {
				if (!new RegExp(`\\b${name}\\s*\\(`).test(src)) continue;
				if (!trusted.has(name))
					problems.push(
						`${file}: calls ${name}( but does not import it by that name from ${ESCAPER}, or redefines it locally`,
					);
			}
		}
		expect(problems).toEqual([]);
	});

	test('the escaper is the only module the render surface imports for escaping', () => {
		// no renderer ships its own replace(/</g, …) — the audit's "many ad-hoc paths"
		const local = clientFiles()
			.filter((f) => RENDER_SURFACE.test(f))
			.filter((f) => /replace\(\s*\/[<>&"']\/g\s*,\s*['"]&/.test(read(f)));
		expect(local).toEqual([]);
		// and the escaper module itself IS such a replace chain (the check sees escapers)
		expect(/replace\(\s*\/[<>&"']\/g\s*,\s*['"]&/.test(read(ESCAPER))).toBe(true);
	});
});
