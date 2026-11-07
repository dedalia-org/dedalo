/**
 * CONTRAST RATIO tripwire (DEC-12; audit 2026-08-26 row P1-18, finding CLI-23;
 * WIDENED 2026-09-06 by the CSS coherence audit, DESIGN.md clause 2.c, findings
 * C1 / C4 / C5 / C12).
 *
 * WHAT WAS WRONG, FIRST TIME. The light theme — the DEFAULT for every user who
 * never touches the toggle — shipped text/background pairs down to 1.92:1, the
 * brand orange on white at 2.44:1 in every modal title and on the login button.
 * Nothing in the repo computed a ratio: the theme gate checks that a dark token
 * is PAIRED with a light one, and says in its own words that "a paired-but-
 * unreadable dark token still passes"; the duplication gate asserts WHERE a token
 * may be declared, never what it evaluates to. So the palette could be retuned to
 * any value and every gate stayed green.
 *
 * WHAT WAS WRONG, SECOND TIME. The first version of this gate read ONE file,
 * `main.css`, under TWO palettes. So:
 *   - the 37 runtime-injected tool sheets (334 KB, ~1,800 rules, appended to the
 *     SAME document by `load_style()`) were judged by nothing — 39 sub-AA pairs
 *     in 15 sheets shipped with every gate green, down to 1.61:1
 *     (`tool_print .flow_continuation_badge`) and 1.67:1 (`tool_tc .button_apply`
 *     in dark, `#00e801` on a tool token that dark had re-pointed to white).
 *
 * WHAT THIS ASSERTS. For every SERVED stylesheet — the set is DERIVED from the
 * build (`entrypoints()` in scripts/build_css.ts, the single source of truth for
 * "what is compiled and shipped"; this gate re-globs nothing) — and for every
 * ROOT PALETTE the served bytes declare — DERIVED from every `:root`/`html`
 * selector carrying only `[data-*=…]` attribute constraints, so the theme
 * combinations are read off the CSS, not listed here by name —
 * every rule that declares BOTH a foreground and a background colour meets the
 * WCAG 2.1 relative-luminance contrast ratio of 4.5:1 (3:1 where the same rule
 * declares large text, SC 1.4.3's own exception), scored only under the
 * palettes its selector CAN match (`:not([data-theme="dark"])` is never scored
 * in dark).
 *
 * THE DOCUMENT MODEL, because getting it wrong fills the gate with false reds:
 * a tool sheet is injected into the document that ALREADY carries `main.css`, so
 * its `var()` chains resolve against the core palette PLUS its own root
 * declarations — never against the tool sheet alone (which would resolve most
 * tokens to nothing and judge nothing). The token map is composed in
 * SPECIFICITY-then-SOURCE order across the sheets of the document: a
 * `:root[data-theme="dark"]` from any sheet (0,2,0) outranks a bare `:root`
 * from any sheet (0,1,0) regardless of load order, and between equal
 * specificity the later sheet wins (the tool sheet is appended after main.css).
 * The audit's first measurement overlaid tokens in FILE order, reported 5 false
 * reds and missed 2 real ones (tool_tc, tool_ontology_parser); the positive
 * control below plants exactly that shape and demands the right answer.
 * `main.css` itself is judged as its own document: `css_token_duplication_tripwire`
 * proves no tool re-declares an OWNED palette name, so no injected sheet can
 * re-point a core token under a core rule.
 *
 * THE CORPUS IS THE BUILT CSS, ON PURPOSE. The `.css` is what the browser gets
 * (deploy is a checkout; production never compiles LESS), and it is the only
 * artifact where the pairs that actually CO-OCCUR in one rule are visible — a
 * pure-token derivation can compute ratios for pairs nobody ever writes and
 * cannot see the ones that matter. `css_build_tripwire` proves every served file
 * is a byte-exact compile of its `.less`, so reading the built file is reading
 * the sources; and `css_source_tripwire` proves the sources are tracked.
 *
 * WHAT THIS DOES NOT PROVE — stated because the audit measured it, and because
 * overclaiming in a header is the exact failure it found:
 *   - A rule that declares a colour and INHERITS its background from an ancestor
 *     is not a pair here: no static reading of a stylesheet resolves the cascade.
 *     That is MOST colour rules (366 of 617 in main.css inherit their
 *     background; only ~190 are judgeable per palette). Move `color` to a child
 *     and a failing pair VANISHES from this gate with the pixels unchanged.
 *     That half belongs to the axe pass inside the browser tier
 *     (`client_a11y_budget_tripwire`), which judges the RENDERED tree.
 *   - `color-mix()`, gradients, `background-image`, `opacity` and a TRANSLUCENT
 *     background over an unknown parent are computed by the browser, not here:
 *     such rules are declared UNJUDGEABLE and skipped (the previous version
 *     composited translucent backgrounds over `--bg_app` and reported
 *     `tool_print .rc_btn:hover` at 1.05:1 on an always-white page — a guess is
 *     not a measurement).
 *   - Cascade SHADOWING between rules is not modelled: a pair in a rule that a
 *     higher-specificity rule always overrides is still scored (a false red that
 *     an exemption must name with its proof), and the pair that actually paints
 *     there may go unjudged. `@media` wrappers are transparent — a pair inside
 *     `@media (prefers-color-scheme: dark)` is scored under every palette.
 *   - Whether a sheet is actually loaded into a document, or which document: the
 *     STANDALONE set below is a DECLARATION (JS `load_style()` strings are the
 *     wire; `css_corpus_tripwire` owns the classification).
 *   - Non-text contrast (SC 1.4.11, borders and icons) and focus indication.
 *
 * FLOORS are stated AT the measured corpus (2026-09-06), not far below it, so a
 * refactor that silently empties a leg turns this gate RED instead of green:
 * the set of files read must EQUAL the derived served set (a sheet that stops
 * parsing reds the set check, not a count — 22 of 42 non-main sheets have zero
 * judgeable pairs, so a per-sheet pair floor would be either vacuous or a pin),
 * every derived palette must resolve > 150 tokens, and the pairs judged are
 * floored PER CORPUS (main, tools) — not as one sum a big corpus could hide a
 * vanished small one inside.
 *
 * EXEMPTIONS are enumerated below, keyed (sheet, selector, palette), one reason
 * each (a proven shadow, or an owner-accepted secondary-info pair), shrink-only;
 * an exemption whose pair no longer fails is red.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { entrypoints } from '../../scripts/build_css.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..');
/** The core document sheet: every SPA-injected sheet lands in a document that already carries it. */
const MAIN_CSS = 'client/dedalo/core/page/css/main.css';

/** AA for body text. */
const AA_NORMAL = 4.5;
/** AA for large text (>= 24px, or >= 18.66px bold) — SC 1.4.3's own exception. */
const AA_LARGE = 3.0;

/**
 * Floors, AT the measured corpus (2026-09-06). Each is a "the corpus did not
 * silently shrink" assertion, not a target; lower one only with the commit that
 * legitimately removes what it counted, and say so there.
 */
/** `entrypoints()` derived 45 sheets (main + 39 tools + unit_test + button_common + test_info + 2 pdfjs). */
const MIN_SERVED_SHEETS = 45;
/** main.css parsed into 4,072 rules; the 39 tool sheets together into 1,819. */
const MIN_MAIN_RULES = 4000;
const MIN_TOOL_RULES = 1750;
/** Root palettes derived from the served bytes: light, dark. */
const MIN_PALETTES = 2;
/** Every palette resolves > 220 tokens (measured: light 238, dark 334). */
const MIN_TOKENS_PER_PALETTE = 220;
/** Pairs judged in main.css, summed over its palettes (measured 406: light 200, dark 206). */
const MIN_MAIN_PAIRS = 400;
/** Pairs judged across the 37 tool sheets, summed over the palettes (measured 172). */
const MIN_TOOL_PAIRS = 160;

/**
 * Entrypoints loaded into a document that does NOT carry main.css, so their
 * `var()` chains resolve against their OWN declarations only. Named WITH the
 * document, because no amount of CSS can reveal where its bytes land. The same
 * classification lives in `css_token_duplication_tripwire` (STANDALONE_DOCUMENTS);
 * `css_corpus_tripwire` is where it is owned. A listed entrypoint the build no
 * longer derives is red (a stale declaration).
 */
const STANDALONE_DOCUMENTS: ReadonlyArray<{ entrypoint: string; document: string }> = [
	{
		entrypoint: 'client/dedalo/core/component_pdf/css/pdfjs_default_edit.less',
		document: "the PDF.js viewer iframe's contentDocument (view_default_edit_pdf.js)",
	},
	{
		entrypoint: 'client/dedalo/core/component_pdf/css/pdfjs_default_read_only.less',
		document: "the PDF.js viewer iframe's contentDocument (view_default_edit_pdf.js)",
	},
];

/**
 * ENUMERATED exemptions, shrink-only, one reason each, keyed on the sheet, the
 * selector and the palette it fails under (a selector recurs across sheets and a
 * pair can fail under one palette and pass under another). A listed entry that
 * no longer fails is red: the exemption outlived the pair it excused. The only
 * admissible reasons are (a) a PROVEN shadow — a same-document rule of higher
 * specificity that always paints over this one — cited by file and line, or
 * (b) an OWNER-ACCEPTED sub-AA pair on secondary, non-essential information,
 * stating who decided, when, and the measured ratio. A failing pair is
 * otherwise a FIX (retune the token, consume `--fg_on_brand`).
 */
const TS_BADGE_SELECTOR =
	'.wrap_ts_object > .content_data > .elements_container .button_show_indexations, .wrap_ts_object > .content_data > .elements_container .default';
const TS_BADGE_REASON =
	'(b) owner-accepted 2026-11-07: thesaurus indexation badge (U:N, IMG, M, NA) is secondary info; light theme keeps brand orange + white ink at opacity 0.75 by design (2.44:1 before opacity). Dark theme is AA (--ts_badge_* tint, 5.70:1). Tokens: vars_tokens.less --ts_badge_bg/--ts_badge_fg.';
const EXEMPTIONS: ReadonlyArray<{
	sheet: string;
	selector: string;
	palette: string;
	reason: string;
}> = ['frame', 'lift', 'light', 'margin'].map((palette) => ({
	sheet: 'client/dedalo/core/page/css/main.css',
	selector: TS_BADGE_SELECTOR,
	palette,
	reason: TS_BADGE_REASON,
}));

// ---------------------------------------------------------------------------
// Colour maths (WCAG 2.1 relative luminance / contrast ratio).
// ---------------------------------------------------------------------------

interface Rgba {
	r: number;
	g: number;
	b: number;
	a: number;
}

const NAMED: Record<string, Rgba> = {
	white: { r: 255, g: 255, b: 255, a: 1 },
	black: { r: 0, g: 0, b: 0, a: 1 },
	red: { r: 255, g: 0, b: 0, a: 1 },
	transparent: { r: 0, g: 0, b: 0, a: 0 },
};

function parseColor(raw: string): Rgba | null {
	const value = raw.trim().toLowerCase();
	if (NAMED[value]) return NAMED[value];
	const hex = /^#([0-9a-f]{3,8})$/.exec(value);
	if (hex) {
		const h = hex[1] ?? '';
		const expand = (s: string | undefined) =>
			Number.parseInt((s ?? '0').length === 1 ? `${s}${s}` : (s ?? '00'), 16);
		if (h.length === 3 || h.length === 4) {
			return {
				r: expand(h[0]),
				g: expand(h[1]),
				b: expand(h[2]),
				a: h.length === 4 ? expand(h[3]) / 255 : 1,
			};
		}
		if (h.length === 6 || h.length === 8) {
			return {
				r: Number.parseInt(h.slice(0, 2), 16),
				g: Number.parseInt(h.slice(2, 4), 16),
				b: Number.parseInt(h.slice(4, 6), 16),
				a: h.length === 8 ? Number.parseInt(h.slice(6, 8), 16) / 255 : 1,
			};
		}
	}
	const fn = /^(rgba?)\(([^)]+)\)$/.exec(value);
	if (fn) {
		const parts = (fn[2] ?? '').split(/[,/\s]+/).filter((p) => p !== '');
		if (parts.length < 3) return null;
		const num = (s: string | undefined) =>
			(s ?? '').endsWith('%')
				? (Number.parseFloat(s ?? '0') * 255) / 100
				: Number.parseFloat(s ?? '0');
		const alpha = parts[3] === undefined ? 1 : Number.parseFloat(parts[3]);
		const rgba = {
			r: num(parts[0]),
			g: num(parts[1]),
			b: num(parts[2]),
			a: Number.isFinite(alpha) ? alpha : 1,
		};
		return Number.isFinite(rgba.r) && Number.isFinite(rgba.g) && Number.isFinite(rgba.b)
			? rgba
			: null;
	}
	return null;
}

/** Composite a translucent colour over an opaque one (what the eye actually sees). */
function composite(top: Rgba, bottom: Rgba): Rgba {
	const a = top.a;
	return {
		r: top.r * a + bottom.r * (1 - a),
		g: top.g * a + bottom.g * (1 - a),
		b: top.b * a + bottom.b * (1 - a),
		a: 1,
	};
}

function relativeLuminance(color: Rgba): number {
	const channel = (v: number) => {
		const s = v / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

function contrastRatio(fg: Rgba, bg: Rgba): number {
	const l1 = relativeLuminance(fg);
	const l2 = relativeLuminance(bg);
	const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
	return (hi + 0.05) / (lo + 0.05);
}

// ---------------------------------------------------------------------------
// CSS reading.
// ---------------------------------------------------------------------------

interface CssRule {
	/** The selector list, whitespace-normalised. A keyframe stop is qualified: `@keyframes <name> <stop>`. */
	selector: string;
	declarations: Record<string, string>;
}

/** At-rules whose block holds RULES (transparent wrappers), as opposed to declarations. */
const NESTING_AT_RULES =
	/^@(media|supports|layer|container|document|keyframes|-webkit-keyframes)\b/i;

function parseDeclarations(body: string): Record<string, string> {
	const declarations: Record<string, string> = {};
	for (const decl of body.split(';')) {
		const idx = decl.indexOf(':');
		if (idx === -1) continue;
		const prop = decl.slice(0, idx).trim().toLowerCase();
		const value = decl
			.slice(idx + 1)
			.trim()
			.replace(/\s*!important$/i, '');
		if (prop !== '') declarations[prop] = value;
	}
	return declarations;
}

/**
 * Split a stylesheet into flat rules, nesting-aware. Comments are stripped.
 * Wrapper at-rules (`@media`, `@supports`, `@layer`…) are transparent — their
 * inner rules surface as plain rules. `@keyframes` stops are KEPT, because a
 * `forwards` final stop is painted text, and their selector is qualified with
 * the keyframes name so an exemption can name one unambiguously. At-rules that
 * hold declarations (`@font-face`, `@page`) are not rules and are dropped.
 */
function parseRules(css: string): CssRule[] {
	const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
	const rules: CssRule[] = [];
	/** The at-rule wrappers enclosing the cursor, innermost last ('' for a non-keyframes wrapper). */
	const stack: string[] = [];
	let cursor = 0;
	let preludeStart = 0;
	while (cursor < clean.length) {
		const ch = clean[cursor];
		if (ch === '{') {
			const prelude = clean.slice(preludeStart, cursor).trim().replace(/\s+/g, ' ');
			if (prelude.startsWith('@') && NESTING_AT_RULES.test(prelude)) {
				const kf = /^@(?:-webkit-)?keyframes\s+(\S+)/i.exec(prelude);
				stack.push(kf ? `@keyframes ${kf[1]}` : '');
				cursor += 1;
				preludeStart = cursor;
				continue;
			}
			// a rule (or a declaration-holding at-rule): read to the matching brace
			const close = clean.indexOf('}', cursor);
			const body = close === -1 ? clean.slice(cursor + 1) : clean.slice(cursor + 1, close);
			if (prelude !== '' && !prelude.startsWith('@')) {
				const keyframes = stack.filter((s) => s !== '').at(-1);
				rules.push({
					selector: keyframes === undefined ? prelude : `${keyframes} ${prelude}`,
					declarations: parseDeclarations(body),
				});
			}
			cursor = close === -1 ? clean.length : close + 1;
			preludeStart = cursor;
			continue;
		}
		if (ch === '}') {
			stack.pop();
			cursor += 1;
			preludeStart = cursor;
			continue;
		}
		if (ch === ';') {
			// a statement at-rule (@import, @charset) or stray semicolon between rules
			cursor += 1;
			preludeStart = cursor;
			continue;
		}
		cursor += 1;
	}
	return rules;
}

// ---------------------------------------------------------------------------
// Palettes: derived from the root selectors the served bytes declare.
// ---------------------------------------------------------------------------

/** A palette is the set of `data-*` attributes on `<html>` — `{}` is the default (classic light). */
type Palette = { name: string; attrs: Readonly<Record<string, string>> };

/** One `[data-k=v]` (positive) or `:not([data-k=v])` (negative) constraint read off a selector. */
interface AxisConstraint {
	attr: string;
	value: string;
	negated: boolean;
}

const ATTR_RE = /\[(data-[a-z0-9_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]*))\s*\]/gi;

/** Every axis constraint in a selector (positive and `:not(...)`-negated). */
function axisConstraints(selector: string): AxisConstraint[] {
	const out: AxisConstraint[] = [];
	const negated = selector.replace(/:not\(([^)]*)\)/gi, (_m, inner: string) => {
		for (const m of inner.matchAll(ATTR_RE)) {
			out.push({ attr: m[1] ?? '', value: m[2] ?? m[3] ?? m[4] ?? '', negated: true });
		}
		return '';
	});
	for (const m of negated.matchAll(ATTR_RE)) {
		out.push({ attr: m[1] ?? '', value: m[2] ?? m[3] ?? m[4] ?? '', negated: false });
	}
	return out;
}

/**
 * A PALETTE DECLARATION is a ROOT-ONLY selector: `:root` or `html`, optionally
 * qualified by `[data-*=…]` attribute selectors — nothing else. A token
 * re-pointed under a descendant (`:root:not([data-theme="dark"]) .tool_header
 * { --fg_muted: … }`, the sanctioned scoped-override idiom) is NOT the palette:
 * reading it as one hands every rule in the document a value that only one
 * widget ever sees. Returns the selector's specificity and constraints, or null.
 */
function parseRootSelector(
	part: string,
): { specificity: number; attrs: Record<string, string> } | null {
	const m = /^(:root|html)((?:\[data-[a-z0-9_-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\]\s]*)\s*\])*)$/i.exec(
		part.trim(),
	);
	if (!m) return null;
	const attrs: Record<string, string> = {};
	let count = 0;
	for (const c of axisConstraints(m[2] ?? '')) {
		attrs[c.attr] = c.value;
		count += 1;
	}
	// (0,1,0) for `:root`, (0,0,1) for `html`; each attribute selector adds (0,1,0)
	return { specificity: (m[1]?.toLowerCase() === 'html' ? 1 : 10) + 10 * count, attrs };
}

/** Does an `<html>` carrying `palette.attrs` satisfy this constraint? */
const satisfies = (c: AxisConstraint, palette: Palette): boolean =>
	c.negated ? palette.attrs[c.attr] !== c.value : palette.attrs[c.attr] === c.value;

/**
 * The AXES of a palette set: the attribute names that appear on root palettes
 * (`data-theme` today — derived, never listed).
 * Any other `[data-*=…]` in a selector (`[data-category="…"]`, `[data-state=…]`)
 * is ELEMENT state, not a root axis, and constrains nothing here.
 */
const axesOf = (palettes: Palette[]): Set<string> =>
	new Set(palettes.flatMap((p) => Object.keys(p.attrs)));

/** Can this selector list match ANY element in a document whose root carries the palette's attributes? */
function canMatchUnder(selector: string, palette: Palette, axes: Set<string>): boolean {
	return selector.split(',').some((part) =>
		axisConstraints(part)
			.filter((c) => axes.has(c.attr))
			.every((c) => satisfies(c, palette)),
	);
}

/**
 * A readable, stable name for a palette: `light`, `dark`, `alt-dark`…
 * Any axis this gate does not know about is ordered alphabetically, the theme
 * last — the theme is the axis every combination has a value for, and `light`
 * is its unnamed default.
 */
function paletteName(attrs: Record<string, string>): string {
	const parts = Object.entries(attrs)
		.filter(([attr]) => attr !== 'data-theme')
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([, value]) => value);
	const theme = attrs['data-theme'];
	if (theme !== undefined) parts.push(theme);
	return parts.length === 0 ? 'light' : parts.join('-');
}

/**
 * The root palettes a document declares: one per DISTINCT attribute set on a
 * root-only selector, plus the bare default. Derived, never listed — a new axis
 * or a new value enters the judgement the moment its root block
 * ships, instead of waiting for someone to name it here.
 */
function derivePalettes(sheets: CssRule[][]): Palette[] {
	const byKey = new Map<string, Record<string, string>>([[JSON.stringify([]), {}]]);
	for (const rules of sheets) {
		for (const rule of rules) {
			for (const part of rule.selector.split(',')) {
				const root = parseRootSelector(part);
				if (!root) continue;
				const key = JSON.stringify(Object.entries(root.attrs).sort());
				if (!byKey.has(key)) byKey.set(key, root.attrs);
			}
		}
	}
	return [...byKey.values()]
		.map((attrs) => ({ name: paletteName(attrs), attrs }))
		.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The token map of a DOCUMENT under a palette: every root-only declaration whose
 * selector matches `<html>` with the palette's attributes, composed in
 * SPECIFICITY-then-SOURCE order — `:root[data-theme="dark"]` (0,2,0) from ANY
 * sheet outranks a bare `:root` (0,1,0) from ANY sheet; between equal
 * specificity the later sheet wins (`sheets` is in document order: main.css
 * first, the injected sheet after it). Sort is stable, so source order survives.
 */
function collectTokens(sheets: CssRule[][], palette: Palette): Map<string, string> {
	const declarations: { specificity: number; tokens: [string, string][] }[] = [];
	for (const rules of sheets) {
		for (const rule of rules) {
			// the highest-specificity part that matches is what the browser applies
			let best = -1;
			for (const part of rule.selector.split(',')) {
				const root = parseRootSelector(part);
				if (!root) continue;
				const matches = Object.entries(root.attrs).every(([k, v]) => palette.attrs[k] === v);
				if (matches && root.specificity > best) best = root.specificity;
			}
			if (best === -1) continue;
			const tokens = Object.entries(rule.declarations).filter(([prop]) => prop.startsWith('--'));
			if (tokens.length > 0) declarations.push({ specificity: best, tokens });
		}
	}
	declarations.sort((a, b) => a.specificity - b.specificity);
	const map = new Map<string, string>();
	for (const d of declarations) for (const [prop, value] of d.tokens) map.set(prop, value);
	return map;
}

/** Follow a var() chain to a literal colour. Returns null when it does not resolve to one. */
function resolveColor(raw: string, tokens: Map<string, string>, depth = 0): Rgba | null {
	if (depth > 12) return null;
	const value = raw.trim();
	const varMatch = /^var\(\s*(--[a-z0-9_-]+)\s*(?:,([\s\S]+))?\)$/i.exec(value);
	if (varMatch) {
		const token = tokens.get(varMatch[1] ?? '');
		if (token !== undefined) return resolveColor(token, tokens, depth + 1);
		return varMatch[2] !== undefined ? resolveColor(varMatch[2], tokens, depth + 1) : null;
	}
	// a shorthand background like "var(--x) no-repeat" or "#fff url(...)": take the first colour-ish token
	if (/\s/.test(value) && !/^rgba?\(/i.test(value)) {
		for (const part of value.split(/\s+(?![^(]*\))/)) {
			const resolved = resolveColor(part, tokens, depth + 1);
			if (resolved) return resolved;
		}
		return null;
	}
	return parseColor(value);
}

/** Is this rule's text large enough for the 3:1 threshold? */
function isLargeText(declarations: Record<string, string>): boolean {
	const size = declarations['font-size'];
	const weight = declarations['font-weight'];
	if (!size) return false;
	const px = /^([\d.]+)px$/.exec(size.trim());
	const rem = /^([\d.]+)rem$/.exec(size.trim());
	const value = px
		? Number.parseFloat(px[1] ?? '0')
		: rem
			? Number.parseFloat(rem[1] ?? '0') * 16
			: null;
	if (value === null) return false;
	const bold = weight !== undefined && (weight === 'bold' || Number.parseInt(weight, 10) >= 700);
	return value >= 24 || (bold && value >= 18.66);
}

interface JudgedPair {
	sheet: string;
	selector: string;
	palette: string;
	ratio: number;
	threshold: number;
	fg: string;
	bg: string;
}

/**
 * The judgement of ONE sheet's rules inside ONE document under ONE palette.
 * `document` is the sheets in load order (the judged sheet last); only the
 * judged sheet's rules are scored, the others contribute tokens.
 */
function judgeSheet(
	sheet: string,
	sheetRules: CssRule[],
	document: CssRule[][],
	palette: Palette,
	axes: Set<string>,
): { tokens: number; pairs: JudgedPair[] } {
	const tokens = collectTokens(document, palette);
	const pairs: JudgedPair[] = [];
	for (const rule of sheetRules) {
		// a rule whose selector cannot match under this palette paints nothing here
		if (!canMatchUnder(rule.selector, palette, axes)) continue;
		const fgRaw = rule.declarations.color;
		const bgRaw = rule.declarations['background-color'] ?? rule.declarations.background;
		if (!fgRaw || !bgRaw) continue;
		// `color-mix()` and friends are computed by the browser, not resolvable
		// here: they belong to the axe leg, which reads the RENDERED value.
		if (/color-mix\(|gradient\(/i.test(bgRaw) || /color-mix\(|gradient\(/i.test(fgRaw)) continue;
		// A rule that paints a background-IMAGE over its background-colour is not
		// judgeable from the declarations either: the image is what the eye sees
		// (the tool header's identity band is exactly this shape). The axe leg
		// reads the rendered pixel; this one declines to guess.
		if (rule.declarations['background-image'] !== undefined) continue;
		const fg = resolveColor(fgRaw, tokens);
		const bg = resolveColor(bgRaw, tokens);
		if (!fg || !bg) continue;
		// A background that is not OPAQUE is not a pair: what shows through comes
		// from an ancestor, which no static reading of a stylesheet can resolve.
		// Guessing the ancestor (the old `--bg_app` composite) reported a 1.05:1
		// on an always-white page. That is this gate's stated limit and the axe
		// leg's half of the work.
		if (bg.a < 1) continue;
		const fgOver = fg.a < 1 ? composite(fg, bg) : fg;
		pairs.push({
			sheet,
			selector: rule.selector,
			palette: palette.name,
			ratio: contrastRatio(fgOver, bg),
			threshold: isLargeText(rule.declarations) ? AA_LARGE : AA_NORMAL,
			fg: fgRaw,
			bg: bgRaw,
		});
	}
	return { tokens: tokens.size, pairs };
}

// ---------------------------------------------------------------------------
// The served corpus, derived from the build.
// ---------------------------------------------------------------------------

interface ServedSheet {
	/** repo-relative `.css` path */
	path: string;
	rules: CssRule[];
	/** `main` | `injected` (appended to the main document) | `standalone` (its own document) */
	kind: 'main' | 'injected' | 'standalone';
}

/** The served set: one `.css` per build entrypoint. Derived here, asserted below. */
function readServedCorpus(): ServedSheet[] {
	const standalone = new Set(STANDALONE_DOCUMENTS.map((d) => d.entrypoint));
	return entrypoints().map((lessPath) => {
		const path = lessPath.replace(/\.less$/, '.css');
		const abs = join(REPO_ROOT, path);
		const rules = existsSync(abs) ? parseRules(readFileSync(abs, 'utf8')) : [];
		const kind = path === MAIN_CSS ? 'main' : standalone.has(lessPath) ? 'standalone' : 'injected';
		return { path, rules, kind };
	});
}

/** The whole judgement over the served corpus: every sheet × every palette its document declares. */
function judgeCorpus(corpus: ServedSheet[]): {
	palettes: Palette[];
	tokensPerPalette: Map<string, number>;
	pairs: JudgedPair[];
} {
	const main = corpus.find((s) => s.kind === 'main');
	if (main === undefined) throw new Error(`served corpus has no ${MAIN_CSS}`);
	const mainDocumentSheets = corpus.filter((s) => s.kind !== 'standalone').map((s) => s.rules);
	const palettes = derivePalettes(mainDocumentSheets);
	const axes = axesOf(palettes);
	const tokensPerPalette = new Map<string, number>();
	const pairs: JudgedPair[] = [];
	for (const sheet of corpus) {
		if (sheet.kind === 'standalone') {
			// its own document: its own roots, its own palettes (the bare default at least)
			const own = derivePalettes([sheet.rules]);
			for (const palette of own) {
				pairs.push(
					...judgeSheet(sheet.path, sheet.rules, [sheet.rules], palette, axesOf(own)).pairs,
				);
			}
			continue;
		}
		const document = sheet.kind === 'main' ? [main.rules] : [main.rules, sheet.rules];
		for (const palette of palettes) {
			const result = judgeSheet(sheet.path, sheet.rules, document, palette, axes);
			if (sheet.kind === 'main') tokensPerPalette.set(palette.name, result.tokens);
			pairs.push(...result.pairs);
		}
	}
	return { palettes, tokensPerPalette, pairs };
}

const exemptionKey = (e: { sheet: string; selector: string; palette: string }) =>
	`${e.sheet} ${e.palette}: ${e.selector}`;

const describePair = (p: JudgedPair) =>
	`${exemptionKey(p)} — ${p.ratio.toFixed(2)}:1 (needs ${p.threshold}:1) color:${p.fg} on ${p.bg}`;

describe('contrast_ratio_tripwire', () => {
	const corpus = readServedCorpus();
	const judgement = judgeCorpus(corpus);
	const isTool = (path: string) => path.startsWith('tools/');

	test('the corpus is every SERVED sheet the build derives, and the set did not shrink', () => {
		const served = entrypoints().map((e) => e.replace(/\.less$/, '.css'));
		expect(served.length).toBeGreaterThanOrEqual(MIN_SERVED_SHEETS);
		// files READ == files SERVED: every derived entrypoint has its built `.css`
		// on disk and it parsed into rules. A sheet that stops existing or stops
		// parsing reds the SET, not a count that a bigger sheet could hide.
		expect(corpus.map((s) => s.path).sort()).toEqual([...served].sort());
		const missing = served.filter((p) => !existsSync(join(REPO_ROOT, p)));
		expect(missing, 'served sheets with no built .css on disk').toEqual([]);
		const unparsed = corpus.filter((s) => s.rules.length === 0).map((s) => s.path);
		expect(unparsed, 'served sheets that parsed into zero rules').toEqual([]);
		const main = corpus.find((s) => s.kind === 'main');
		expect(main).toBeDefined();
		expect((main as ServedSheet).rules.length).toBeGreaterThan(MIN_MAIN_RULES);
		const toolRules = corpus.filter((s) => isTool(s.path)).reduce((n, s) => n + s.rules.length, 0);
		expect(toolRules).toBeGreaterThan(MIN_TOOL_RULES);
		// a standalone declaration must still name an entrypoint the build derives
		const stale = STANDALONE_DOCUMENTS.map((d) => d.entrypoint).filter(
			(e) => !entrypoints().includes(e),
		);
		expect(stale, 'STANDALONE_DOCUMENTS entries the build no longer derives').toEqual([]);
	});

	test('the palettes are DERIVED from the served root selectors, and every one resolves a full token map', () => {
		const names = judgement.palettes.map((p) => p.name);
		expect(names.length).toBeGreaterThanOrEqual(MIN_PALETTES);
		// the theme axis the client itself sets (theme.js toggles data-theme)
		// must be present as a root palette — asserted on the ATTRIBUTE, not on a
		// file name
		expect(judgement.palettes.some((p) => Object.keys(p.attrs).length === 0)).toBe(true);
		expect(judgement.palettes.some((p) => p.attrs['data-theme'] === 'dark')).toBe(true);
		for (const palette of judgement.palettes) {
			expect(
				judgement.tokensPerPalette.get(palette.name) ?? 0,
				`tokens resolved under ${palette.name}`,
			).toBeGreaterThan(MIN_TOKENS_PER_PALETTE);
		}
	});

	test('every text-on-background pair any served sheet declares meets WCAG AA under every palette it can paint in', () => {
		const exempt = new Set(EXEMPTIONS.map(exemptionKey));
		const failures = judgement.pairs
			.filter((p) => p.ratio < p.threshold && !exempt.has(exemptionKey(p)))
			.map(describePair)
			.sort();
		// per-corpus floors: a vanished tool leg cannot hide inside main's count
		const mainPairs = judgement.pairs.filter((p) => p.sheet === MAIN_CSS).length;
		const toolPairs = judgement.pairs.filter((p) => isTool(p.sheet)).length;
		expect(mainPairs, 'pairs judged in main.css over all palettes').toBeGreaterThan(MIN_MAIN_PAIRS);
		expect(toolPairs, 'pairs judged across tool sheets over all palettes').toBeGreaterThan(
			MIN_TOOL_PAIRS,
		);
		expect(failures.join('\n')).toBe('');
	});

	test('the maths is the WCAG formula (positive control on known pairs)', () => {
		const white = parseColor('#ffffff') as Rgba;
		const black = parseColor('#000000') as Rgba;
		expect(contrastRatio(white, black)).toBeCloseTo(21, 5);
		expect(contrastRatio(white, white)).toBeCloseTo(1, 5);
		// the finding's own headline pair: the brand orange on white
		expect(contrastRatio(parseColor('#f78a1c') as Rgba, white)).toBeLessThan(2.6);
	});

	test('a planted failing rule IS caught (the detector is not vacuous)', () => {
		const planted = parseRules(
			':root{--brand:#f78a1c;} .planted_offender{color:var(--brand);background-color:#ffffff;}',
		);
		const palettes = derivePalettes([planted]);
		const result = judgeSheet(
			'planted',
			planted,
			[planted],
			palettes[0] as Palette,
			axesOf(palettes),
		);
		const offender = result.pairs.find((p) => p.selector === '.planted_offender');
		expect(offender).toBeDefined();
		expect((offender as JudgedPair).ratio).toBeLessThan(AA_NORMAL);
	});

	test('tokens compose in SPECIFICITY-then-SOURCE order across the document (the file-order overlay is wrong)', () => {
		// main declares a BAD light value and a GOOD dark value; the injected tool
		// sheet declares a GOOD value at bare `:root`. In light the tool's bare root
		// wins by SOURCE (later sheet, equal specificity) → pass. In dark main's
		// `:root[data-theme="dark"]` wins by SPECIFICITY over the tool's bare root,
		// whatever the load order → pass. A file-order overlay would hand dark the
		// tool's value and could not tell these apart.
		const main = parseRules(
			':root{--ink:#aaaaaa;--paper:#ffffff;} :root[data-theme="dark"]{--ink:#ffffff;--paper:#000000;}',
		);
		const tool = parseRules(':root{--ink:#000000;} .t{color:var(--ink);background:var(--paper);}');
		const palettes = derivePalettes([main, tool]);
		const axes = axesOf(palettes);
		const light = palettes.find((p) => p.name === 'light') as Palette;
		const dark = palettes.find((p) => p.name === 'dark') as Palette;
		expect(judgeSheet('tool', tool, [main, tool], light, axes).pairs[0]?.ratio).toBeCloseTo(21, 5);
		expect(judgeSheet('tool', tool, [main, tool], dark, axes).pairs[0]?.ratio).toBeCloseTo(21, 5);
		// and the audit's actual shape: a tool's bare-root token that DARK re-points
		// to a bad value in main (tool_tc's white `--tool_tc`) must FAIL in dark
		const mainBadDark = parseRules(':root[data-theme="dark"]{--paper:#ffffff;}');
		const toolGood = parseRules(
			':root{--paper:#000000;} .apply{color:#ffffff;background-color:var(--paper);}',
		);
		const darkOnly = derivePalettes([mainBadDark, toolGood]).find(
			(p) => p.name === 'dark',
		) as Palette;
		expect(
			judgeSheet('tool', toolGood, [mainBadDark, toolGood], darkOnly, axes).pairs[0]?.ratio,
		).toBeCloseTo(1, 5);
		// the tool sheet judged ALONE resolves nothing: the document model is load-bearing
		const alone = parseRules('.x{color:var(--fg_default);background:var(--bg_surface);}');
		expect(judgeSheet('alone', alone, [alone], light, axes).pairs).toEqual([]);
	});

	test('a rule is scored only under the palettes its selector CAN match', () => {
		const css = parseRules(
			[
				':root{--x:#aaaaaa;} :root[data-theme="dark"]{--x:#aaaaaa;} :root[data-variant="alt"]{--x:#aaaaaa;}',
				':root:not([data-theme="dark"]) .light_only{color:var(--x);background:#fff;}',
				':root[data-theme="dark"] .dark_only{color:var(--x);background:#fff;}',
				':root[data-variant="alt"] .variant_only{color:var(--x);background:#fff;}',
				'.everywhere{color:var(--x);background:#fff;}',
				// element STATE, not a root axis: painted under every palette
				'.chip[data-category="x"]{color:var(--x);background:#fff;}',
			].join(' '),
		);
		const palettes = derivePalettes([css]);
		expect(palettes.map((p) => p.name)).toEqual(['alt', 'dark', 'light']);
		const axes = axesOf(palettes);
		expect([...axes].sort()).toEqual(['data-theme', 'data-variant']);
		const scored = (name: string) =>
			judgeSheet('c', css, [css], palettes.find((p) => p.name === name) as Palette, axes)
				.pairs.map((p) => p.selector)
				.sort();
		expect(scored('light')).toEqual([
			'.chip[data-category="x"]',
			'.everywhere',
			':root:not([data-theme="dark"]) .light_only',
		]);
		expect(scored('dark')).toEqual([
			'.chip[data-category="x"]',
			'.everywhere',
			':root[data-theme="dark"] .dark_only',
		]);
		expect(scored('alt')).toEqual([
			'.chip[data-category="x"]',
			'.everywhere',
			// the variant root carries no data-theme, so a `:not([data-theme="dark"])` rule paints there too
			':root:not([data-theme="dark"]) .light_only',
			':root[data-variant="alt"] .variant_only',
		]);
	});

	test('palettes derive from every root attribute combination, and only from ROOT-ONLY selectors', () => {
		const css = parseRules(
			[
				':root{--a:1;} html{--b:2;} :root[data-theme="dark"]{--a:3;}',
				':root[data-variant="alt"][data-theme="dark"]{--a:4;}',
				// scoped overrides are NOT palettes, and declare no combination
				':root:not([data-theme="dark"]) .tool_header{--a:5;} :root[data-theme="dark"] .menu{--a:6;}',
				'[data-theme="dark"] .x{--a:7;}',
			].join(' '),
		);
		const palettes = derivePalettes([css]);
		expect(palettes.map((p) => p.name)).toEqual(['alt-dark', 'dark', 'light']);
		// `html` (0,0,1) is outranked by `:root` (0,1,0); the alt-dark root inherits
		// the dark root's declarations it does not itself override
		const tokens = collectTokens([css], palettes.find((p) => p.name === 'alt-dark') as Palette);
		expect(tokens.get('--a')).toBe('4');
		expect(tokens.get('--b')).toBe('2');
		const html = parseRules('html{--a:html;} :root{--a:root;}');
		expect(collectTokens([html], { name: 'light', attrs: {} }).get('--a')).toBe('root');
	});

	test('keyframe stops are judged and qualified by their @keyframes name; wrappers are transparent', () => {
		const css = parseRules(
			'@keyframes pulse{to{color:#aaaaaa;background:#ffffff;}} @media (min-width:1px){.inner{color:#aaaaaa;background:#fff;}} @font-face{font-family:x;src:url(a.woff);}',
		);
		expect(css.map((r) => r.selector)).toEqual(['@keyframes pulse to', '.inner']);
		const palettes = derivePalettes([css]);
		const pairs = judgeSheet('k', css, [css], palettes[0] as Palette, axesOf(palettes)).pairs;
		expect(pairs.map((p) => p.selector).sort()).toEqual(['.inner', '@keyframes pulse to']);
		expect(pairs.every((p) => p.ratio < AA_NORMAL)).toBe(true);
	});

	test('a background the eye does not see whole is UNJUDGEABLE, never guessed', () => {
		const css = parseRules(
			[
				'.translucent{color:#fff;background:rgba(0,0,0,0.3);}',
				'.see_through{color:#fff;background-color:transparent;}',
				'.imaged{color:#fff;background-color:#fff;background-image:url(x.png);}',
				'.mixed{color:#fff;background:color-mix(in srgb, #fff, #000);}',
				'.graded{color:#fff;background:linear-gradient(#fff,#000);}',
				'.inherits{color:#fff;}',
			].join(' '),
		);
		const palettes = derivePalettes([css]);
		expect(judgeSheet('u', css, [css], palettes[0] as Palette, axesOf(palettes)).pairs).toEqual([]);
	});

	test('every enumerated exemption still names a pair that fails', () => {
		const failing = new Set(judgement.pairs.filter((p) => p.ratio < p.threshold).map(exemptionKey));
		const stale = EXEMPTIONS.map(exemptionKey).filter((k) => !failing.has(k));
		expect(stale.join(', ')).toBe('');
	});
});
