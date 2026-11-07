/**
 * CSS CASCADE PROBE — which declaration of a property WINS for a synthetic
 * element, over a compiled stylesheet. A gate that asks "does the colour reach
 * this element" must ask the cascade, not infer the answer from where one rule
 * sits: a later or heavier rule elsewhere in the sheet flips the outcome while
 * the rule it was inferred from stays exactly where it was.
 *
 * Three small pieces, no DOM and no browser (the unit tier stays hermetic):
 *  - a selector SPECIFICITY calculator (`:is/:not/:has` = max of the arguments,
 *    `:where` = 0);
 *  - a selector MATCHER for a probe chain (root-first array of elements; the
 *    last one is the target), right-to-left with backtracking over descendant
 *    and child combinators; sibling combinators never match (the probe has no
 *    siblings);
 *  - the resolver: every rule that declares the property and has a member
 *    selector matching the probe competes by `!important`, then specificity,
 *    then source order.
 *
 * Honest limits, all deliberately on the SAFE side:
 *  - at-rule conditions are not evaluated: a rule inside `@media` counts as
 *    always applying, so it can only add competitors;
 *  - the probe has a fixed state (enabled, unchecked, unfocused, unhovered):
 *    the state pseudo-classes are decided accordingly;
 *  - a selector feature this matcher cannot decide (`:nth-child()`, `:has()`,
 *    an unknown pseudo) THROWS naming the selector, never guesses.
 * Positive controls for the whole thing live in the gate that uses it.
 */

export type Spec = [number, number, number];

const IDENT = /[\w\-\\]|[^\0-\x7f]/;

/** Split on top-level commas (outside (), [] and quotes). */
export const splitTop = (s: string): string[] => {
	const out: string[] = [];
	let depth = 0;
	let quote = '';
	let cur = '';
	for (const ch of s) {
		if (quote) {
			if (ch === quote) quote = '';
		} else if (ch === '"' || ch === "'") quote = ch;
		else if (ch === '(' || ch === '[') depth++;
		else if (ch === ')' || ch === ']') depth--;
		else if (ch === ',' && depth === 0) {
			out.push(cur.trim());
			cur = '';
			continue;
		}
		cur += ch;
	}
	if (cur.trim()) out.push(cur.trim());
	return out;
};

export const cmpSpec = (a: Spec, b: Spec): number => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
export const fmtSpec = (s: Spec) => `(${s.join(',')})`;

const identEnd = (sel: string, from: number): number => {
	let j = from;
	while (j < sel.length && IDENT.test(sel[j] as string)) j++;
	return j;
};

/** Index of the `)` closing the `(` at `open`. */
const closeParen = (sel: string, open: number): number => {
	let depth = 0;
	let quote = '';
	for (let j = open; j < sel.length; j++) {
		const c = sel[j] as string;
		if (quote) {
			if (c === quote) quote = '';
		} else if (c === '"' || c === "'") quote = c;
		else if (c === '(') depth++;
		else if (c === ')' && --depth === 0) return j;
	}
	return sel.length;
};

/** Index of the `]` closing the `[` at `open` (quotes may hold a `]`). */
const closeBracket = (sel: string, open: number): number => {
	let quote = '';
	for (let j = open + 1; j < sel.length; j++) {
		const c = sel[j] as string;
		if (quote) {
			if (c === quote) quote = '';
		} else if (c === '"' || c === "'") quote = c;
		else if (c === ']') return j;
	}
	return sel.length;
};

/** Specificity of ONE complex selector. :is/:not/:has = max of arguments, :where = 0. */
export const specificity = (sel: string): Spec => {
	const spec: Spec = [0, 0, 0];
	const add = (x: Spec) => {
		spec[0] += x[0];
		spec[1] += x[1];
		spec[2] += x[2];
	};
	let i = 0;
	while (i < sel.length) {
		const ch = sel[i] as string;
		if (ch === '#') {
			spec[0]++;
			i = identEnd(sel, i + 1);
		} else if (ch === '.') {
			spec[1]++;
			i = identEnd(sel, i + 1);
		} else if (ch === '[') {
			spec[1]++;
			i = closeBracket(sel, i) + 1;
		} else if (ch === ':') {
			if (sel[i + 1] === ':') {
				spec[2]++;
				i = identEnd(sel, i + 2);
				continue;
			}
			const end = identEnd(sel, i + 1);
			const name = sel.slice(i + 1, end);
			if (sel[end] === '(') {
				const j = closeParen(sel, end);
				const args = sel.slice(end + 1, j);
				if (name === 'is' || name === 'not' || name === 'has') {
					add(splitTop(args).map(specificity).sort(cmpSpec).pop() ?? [0, 0, 0]);
				} else if (name !== 'where') spec[1]++;
				i = j + 1;
			} else {
				spec[1]++;
				i = end;
			}
		} else if (IDENT.test(ch)) {
			spec[2]++; // type selector
			i = identEnd(sel, i);
		} else i++; // combinator, space, `*`, `&`
	}
	return spec;
};

// ---- selector matching against a probe chain ----

export type ProbeElement = { tag: string; attrs?: Record<string, string>; classes?: string[] };
/** Root-first ancestry; the LAST element is the one whose style is asked. */
export type ProbeChain = ProbeElement[];

type Part = { combinator: ' ' | '>' | '+' | '~'; compound: string };

/** A complex selector as compounds joined by combinators (quotes/brackets/parens respected). */
const parseComplex = (sel: string): Part[] => {
	const parts: Part[] = [];
	let combinator: Part['combinator'] = ' ';
	let cur = '';
	let depth = 0;
	let quote = '';
	const flush = () => {
		if (!cur) return; // nothing open: a pending `>`/`+`/`~` stays for the next compound
		parts.push({ combinator, compound: cur });
		cur = '';
		combinator = ' ';
	};
	for (const ch of sel.trim()) {
		if (quote) {
			if (ch === quote) quote = '';
			cur += ch;
		} else if (ch === '"' || ch === "'") {
			quote = ch;
			cur += ch;
		} else if (ch === '(' || ch === '[') {
			depth++;
			cur += ch;
		} else if (ch === ')' || ch === ']') {
			depth--;
			cur += ch;
		} else if (depth === 0 && (ch === '>' || ch === '+' || ch === '~')) {
			flush();
			combinator = ch;
		} else if (depth === 0 && /\s/.test(ch)) {
			// whitespace ends a compound; with none open it keeps a pending `>`/`+`/`~`
			flush();
		} else cur += ch;
	}
	flush();
	return parts;
};

const unescapeIdent = (s: string) => s.replace(/\\(.)/g, '$1');

/** States the probe is NOT in; everything else a pseudo-class can mean is decided below or throws. */
const STATE_OFF = new Set([
	'hover',
	'active',
	'focus',
	'focus-visible',
	'focus-within',
	'checked',
	'disabled',
	'indeterminate',
	'visited',
	'link',
	'any-link',
	'target',
	'invalid',
	'user-invalid',
	'open',
	'popover-open',
]);
const STATE_ON = new Set([
	'enabled',
	'first-child',
	'last-child',
	'only-child',
	'first-of-type',
	'last-of-type',
	'only-of-type',
]);

const attrValue = (el: ProbeElement, name: string): string | undefined => {
	if (name === 'class') return el.classes?.length ? el.classes.join(' ') : undefined;
	return el.attrs?.[name];
};

const ATTR =
	/^\s*([\w:-]+)\s*(?:([~|^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\s\]]+))\s*([iIsS])?)?\s*$/;

const attrMatches = (el: ProbeElement, inner: string, sel: string): boolean => {
	const m = ATTR.exec(inner);
	if (!m) throw new Error(`css_cascade: cannot parse attribute selector [${inner}] in "${sel}"`);
	const actual = attrValue(el, m[1] as string);
	if (actual === undefined) return false;
	const op = m[2];
	if (!op) return true;
	const ci = m[6] === 'i' || m[6] === 'I';
	const a = ci ? actual.toLowerCase() : actual;
	const raw = m[3] ?? m[4] ?? m[5] ?? '';
	const v = ci ? raw.toLowerCase() : raw;
	switch (op) {
		case '=':
			return a === v;
		case '~=':
			return v !== '' && a.split(/\s+/).includes(v);
		case '|=':
			return a === v || a.startsWith(`${v}-`);
		case '^=':
			return v !== '' && a.startsWith(v);
		case '$=':
			return v !== '' && a.endsWith(v);
		case '*=':
			return v !== '' && a.includes(v);
		default:
			throw new Error(`css_cascade: unknown attribute operator ${op} in "${sel}"`);
	}
};

const matchCompound = (chain: ProbeChain, idx: number, compound: string, sel: string): boolean => {
	const el = chain[idx] as ProbeElement;
	let i = 0;
	if (compound[0] === '*') i = 1;
	else if (IDENT.test(compound[0] as string)) {
		const j = identEnd(compound, 0);
		if (compound.slice(0, j).toLowerCase() !== el.tag) return false;
		i = j;
	}
	while (i < compound.length) {
		const ch = compound[i] as string;
		if (ch === '#') {
			const j = identEnd(compound, i + 1);
			if (el.attrs?.id !== unescapeIdent(compound.slice(i + 1, j))) return false;
			i = j;
		} else if (ch === '.') {
			const j = identEnd(compound, i + 1);
			if (!el.classes?.includes(unescapeIdent(compound.slice(i + 1, j)))) return false;
			i = j;
		} else if (ch === '[') {
			const j = closeBracket(compound, i);
			if (!attrMatches(el, compound.slice(i + 1, j), sel)) return false;
			i = j + 1;
		} else if (ch === ':') {
			if (compound[i + 1] === ':') return false; // a pseudo-element styles a box that is not the element
			const end = identEnd(compound, i + 1);
			const name = compound.slice(i + 1, end);
			if (compound[end] === '(') {
				const j = closeParen(compound, end);
				const args = splitTop(compound.slice(end + 1, j));
				if (name === 'is' || name === 'where' || name === 'matches') {
					if (!args.some((a) => matchComplex(chain, idx, a))) return false;
				} else if (name === 'not') {
					if (args.some((a) => matchComplex(chain, idx, a))) return false;
				} else throw new Error(`css_cascade: cannot decide :${name}() in "${sel}"`);
				i = j + 1;
			} else {
				if (name === 'root') {
					if (idx !== 0) return false;
				} else if (STATE_OFF.has(name)) return false;
				else if (!STATE_ON.has(name))
					throw new Error(`css_cascade: cannot decide :${name} in "${sel}"`);
				i = end;
			}
		} else throw new Error(`css_cascade: cannot parse "${compound}" in "${sel}"`);
	}
	return true;
};

const matchParts = (
	chain: ProbeChain,
	idx: number,
	parts: Part[],
	p: number,
	sel: string,
): boolean => {
	if (!matchCompound(chain, idx, (parts[p] as Part).compound, sel)) return false;
	if (p === 0) return true;
	switch ((parts[p] as Part).combinator) {
		case '>':
			return idx > 0 && matchParts(chain, idx - 1, parts, p - 1, sel);
		case ' ':
			for (let k = idx - 1; k >= 0; k--) if (matchParts(chain, k, parts, p - 1, sel)) return true;
			return false;
		default:
			return false; // sibling combinators: the probe has no siblings
	}
};

/** Does ONE complex selector match the element at `idx` of the probe chain? */
export const matchComplex = (chain: ProbeChain, idx: number, selector: string): boolean => {
	const parts = parseComplex(selector);
	if (!parts.length) return false;
	return matchParts(chain, idx, parts, parts.length - 1, selector);
};

// ---- the cascade ----

export type CascadeRule = { members: string[]; body: string; index: number };

/** Style rules of a compiled sheet, in source order (comments stripped; at-rule wrappers are transparent). */
export const parseRules = (css: string): CascadeRule[] =>
	[...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m, index) => ({
		// a statement at-rule (`@import …;`) before the rule sits in the same capture
		members: splitTop((m[1] as string).slice((m[1] as string).lastIndexOf(';') + 1)),
		body: m[2] as string,
		index,
	}));

export type Winner = {
	value: string;
	important: boolean;
	selector: string;
	specificity: Spec;
	index: number;
};

/** Importance, then specificity, then source order (later wins a tie). */
const outranks = (a: Winner, b: Winner): boolean =>
	(Number(a.important) - Number(b.important) ||
		cmpSpec(a.specificity, b.specificity) ||
		a.index - b.index) > 0;

/**
 * The winning declaration of `property` for the last element of `chain`, or
 * undefined when no rule sets it. Importance, then specificity, then source order.
 */
export const resolveDeclaration = (
	rules: CascadeRule[],
	property: string,
	chain: ProbeChain,
): Winner | undefined => {
	const decl = new RegExp(`(?:^|[;\\s])${property}\\s*:\\s*([^;]*)`, 'g');
	let best: Winner | undefined;
	for (const rule of rules) {
		const found = [...rule.body.matchAll(decl)].pop(); // the last declaration of a block wins
		if (!found) continue;
		const raw = (found[1] as string).trim();
		const important = /!\s*important\s*$/i.test(raw);
		const value = raw.replace(/\s*!\s*important\s*$/i, '');
		for (const selector of rule.members) {
			if (!matchComplex(chain, chain.length - 1, selector)) continue;
			const candidate: Winner = {
				value,
				important,
				selector,
				specificity: specificity(selector),
				index: rule.index,
			};
			if (!best || outranks(candidate, best)) best = candidate;
		}
	}
	return best;
};
