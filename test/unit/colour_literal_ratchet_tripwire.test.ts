/**
 * COLOUR LITERAL RATCHET tripwire (DEC-12; CSS coherence audit 2026-09, clause 2.d,
 * findings C9 / C18 / S1 / S3 / S10).
 *
 * WHAT IS WRONG. A colour written as a literal — `#f78a1c`, `rgb(255 255 255 / 80%)`,
 * `'#006ed2'` in a JS style string — is a paint that CANNOT follow the palette. When
 * the brand orange was retuned on 2026-09-05 every `var(--color_orange_dedalo)` site
 * moved and every literal copy of the same orange stayed where it was, silently
 * becoming a second, private brand. Nothing in the repo counted them: the duplication
 * gate asserts WHO may declare a token, the contrast gate judges the fg/bg pair a rule
 * declares, the palette-axis gate asserts a NAME is declared for every axis. A literal
 * belongs to none of those questions and is invisible to all three.
 *
 * WHY THIS IS A RATCHET AND NOT A PROHIBITION. Many literals are legitimately
 * non-tokenizable — a mask-image stop, an SVG fill inside a `data:` URI, a shadow
 * `rgba()` where only the alpha varies, a QR module colour, a third-party widget
 * override. "No literals" is therefore not a true rule, and a gate that asserted it
 * would be exempted into meaninglessness. What IS true is that the number must never
 * grow without a decision. So: classify, bank, shrink-only.
 *
 * WHY NOT THE AUDIT'S RAW CENSUS. The audit's first instrument was
 * a `grep -oiE '#[0-9a-f]{3,8}'` over every `.less` → 429 across 59 files (seed S1), and
 * its own verifier refuted it as a defect measure (C18):
 *   - it counts COMMENTS (48 of the 429) — the census "improves" when prose is deleted;
 *   - it counts NON-COLOURS: `ul#dd1` id selectors, multi-line gradient stops;
 *   - it counts HTML ENTITIES on the JS side (13 of the raw 120), and issue references
 *     (`see ckeditor5#1341`, `#7429`) which are hex-shaped and mean nothing;
 *   - it MISSES `%23` inside `data:` URIs, every `rgb()`/`hsl()` call and every named
 *     colour, so it is not even a complete count of its own subject;
 *   - it can be "improved" by re-spelling `#fff` as `white`.
 * A count of spellings is a spelling. This gate therefore measures over the COMPILED,
 * SERVED bytes (`buildOne()`, the build's own compiler, over `entrypoints()`, the
 * build's own corpus) where comments are gone, LESS `darken()`/`fade()` are already
 * evaluated to the colour that ships, and `@import`ed partials are resolved. A rename
 * of a variable, a file or a class changes nothing here; deleting a comment changes
 * nothing here.
 *
 * WHAT "DRIFT" MEANS — the seed's definition, reproduced by the gate itself.
 * A literal is DRIFT when it has, or should have, a token, decided mechanically:
 *   HAS_TOKEN   a bare literal in a paint position whose value, normalised to 8-bit
 *               RGBA, EQUALS a value some custom property declared on a global root of
 *               the same served document already carries (in either theme). It is by construction swappable for that `var()` today with
 *               zero pixel change — and it is exactly the site that will NOT move on
 *               the next retune.
 *   STALE_FB    `var(--x, <literal>)` where `--x` IS declared on a root of the document
 *               and the literal is not among the values declared for it. The literal is
 *               documentation that lies: 27 sites still carry the `#7f7f7f`
 *               `--fg_muted` was, 6 the pre-2026-09-05 brand orange (S10).
 *   UNDECL_FB   `var(--x, <literal>)` where `--x` is declared NOWHERE in the document.
 *               The fallback is then the painted colour in EVERY axis — a light literal
 *               under dark — and the name promises a token that does not exist.
 * Everything else is NOT counted as drift: a fallback whose literal matches its token
 * (duplication, not divergence) and an UNMATCHED literal (no token carries that value —
 * the shadow alphas, the identity hues, the QR modules). They are still counted in the
 * outer budget below, so they cannot grow unseen either.
 *
 * THE OUTER BUDGET EXISTS BECAUSE THE INNER ONE HAS A HOLE. HAS_TOKEN is defined by
 * equality with a palette value, so a palette retune that moves a token AWAY from a
 * literal silently reclassifies that site as UNMATCHED — the drift becomes invisible at
 * the exact moment it becomes real. So the total number of literals in a paint position
 * (drift + coherent + unmatched) is banked too. A retune cannot move a site out of that
 * one, and a shrink in either bank must be recorded by lowering it.
 *
 * THE SEED, RE-MEASURED ON THIS TREE 2026-09-23, and recomputed on every run — no number
 * below is read from a file, so the derivation IS the gate. (The 2026-09-06 seed had
 * drifted: nothing ASSERTS this prose, so its class breakdown had stopped summing to its
 * own total — 27+38+5+71+141 = 282, never 274. Every figure here was printed by the
 * gate's own classifier.)
 *   corpus   45 served documents (`entrypoints()`, compiled by `buildOne()`), 6539 rules,
 *            268 root-declared colour tokens carrying 278 distinct values, 1141 colour
 *            literals in all positions — of which 834 are the palette declaring itself
 *            and the rest are grammar-exempt (url()/gradient/mask/filter);
 *   CSS      273 literals in a paint position = 27 HAS_TOKEN + 38 STALE_FB
 *            + 5 UNDECL_FB (drift: 70) + 68 coherent fallbacks + 135 unmatched;
 *   JS       776 files under client/ + tools/ minus lib/, 21 of them carrying a colour;
 *            74 literals in strings = 27 HAS_TOKEN + 6 STALE_FB + 0 UNDECL_FB (drift: 33)
 *            + 8 coherent + 33 unmatched.
 *   INCLUDES named colours (`white`, `black`, `green` — 16 CSS paint sites the audit's
 *            hex regex could not see), `rgb()`/`hsl()`/`rgba()` in every syntax, the
 *            fallback inside a NESTED `var(--a, var(--b, #fff))`, `@media print` rules,
 *            and `ui.css_var('--x', '#hex')` calls in JS.
 *   EXCLUDES comments (gone at compile time), selectors (so `ul#dd1` and `#f5` are not
 *            colours), everything inside `url()` (so `%23ff0000` in a data URI is not
 *            one either), HTML entities (`&#39;` is not hex-shaped), gradient stops,
 *            mask images and filters, the values of the palette's own `--x:`
 *            declarations, `color-mix()` (the browser computes it), `transparent` and
 *            `currentColor` (references, not colours), `client/**` under `lib/`
 *            (vendored), and a bare named colour in JS outside a `:` declaration —
 *            that rule drops 9 of the 12 bare-name matches on this tree: 7 are class
 *            names (`classList.add('white')`, `' green'`) and 2 are genuine paints
 *            passed as a bare argument (`style.backgroundColor = 'black'`,
 *            `.attr('stroke', 'white')`) which this leg therefore does not see.
 *
 * SHRINK-ONLY, BOTH WAYS. Each banked number is asserted EQUAL to the measurement:
 * growth is a regression, and a shrink that leaves the bank untouched is refused too —
 * a stale bank hides the progress and re-opens the room to regress into.
 *
 * ANTI-VACUITY. Every corpus size is floored AT what it measures today. If someone
 * empties the entrypoint list, breaks the LESS compile, deletes the palette harvest or
 * narrows the JS glob, the classified counts all fall to zero — which a naive
 * shrink-only gate would report as an improvement. Here it is red: the document count,
 * the rule count, the harvested token count, the total literal count and the JS file
 * count all have floors, and the class partition must add up to the total.
 *
 * DOES NOT PROVE.
 *   - That any counted literal is a DEFECT. A budget is not a judgement: the QR timing
 *     colours, the colorpicker defaults and the d3 series palette are content, not
 *     chrome, and the audit's decision (clause 2.d) is that the honest instrument for
 *     those is a browser assertion that the widget's fills differ between a light and a
 *     dark render. They are inside the bank because a bank that excludes what is hard to
 *     judge is a bank you can hide in — not because each is wrong.
 *   - That the uncounted literals are FINE. UNMATCHED means "no token carries this
 *     value", not "this colour is correct"; a theme-blind slab painted in a colour the
 *     palette never had is judged by the theme-blind-surface law, not here.
 *   - Anything about legibility (`contrast_ratio_tripwire`), about a token being
 *     declared for every axis (`palette_axis_parity_tripwire`), or about which
 *     documents are served at all (`css_corpus_tripwire`, whose corpus this one reuses).
 *   - That a JS literal is ever painted. The JS leg reads STRING literals with a lexer
 *     approximation (comments stripped, template literals honoured); it cannot tell a
 *     colour assigned to `style.background` from one written into a canvas, and a regex
 *     literal containing a quote can shift its string boundaries. It is a budget over
 *     "colours spelled in shipped JS", nothing finer.
 *   - Numbers here do NOT reproduce the audit's, and must not be reconciled with them:
 *     the audit classified `var()` fallbacks against the three palette FILES, this gate
 *     against what the served DOCUMENT declares — so `tool_assistant`'s 35 names, which
 *     the files never declare in light but the sheet itself declares under
 *     `[data-theme="dark"]`, are STALE here and "undeclared" there.
 *
 * COST: compiles the 45 entrypoints (~1s) and reads the client/tools JS tree. DB-less,
 * network-less → hermetic tier.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildOne, entrypoints } from '../../scripts/build_css.ts';
import { browserSources } from '../helpers/browser_corpus.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..');

/** The entrypoint whose bytes are in the SPA document every other sheet is injected into. */
const MAIN_ENTRYPOINT = 'client/dedalo/core/page/css/main.less';

/**
 * Entrypoints served into a document that does NOT carry main.css, so main's palette is
 * not in scope for them and every `var()` they use must be their own. Same record, same
 * reason as `css_token_duplication_tripwire`'s STANDALONE_DOCUMENTS — kept here rather
 * than imported because a test importing another test's private constant couples two
 * gates that must be able to disagree.
 */
const STANDALONE_DOCUMENTS: Record<string, string> = {
	'client/dedalo/core/component_pdf/css/pdfjs_default_edit.less':
		"the PDF.js viewer iframe's contentDocument (view_default_edit_pdf.js)",
	'client/dedalo/core/component_pdf/css/pdfjs_default_read_only.less':
		"the PDF.js viewer iframe's contentDocument (view_default_edit_pdf.js)",
};

// ---------------------------------------------------------------------------
// THE BANK. Measured on this tree, 2026-09-06, by the code below — every number is
// recomputed on each run, never read from a file. Lower an entry when the work that
// lowers the measurement lands; there is no path that raises one without a decision.
// ---------------------------------------------------------------------------

const BANK = {
	css: {
		/** bare paint literals whose value a root token already carries */
		has_token: 27,
		/** `var(--declared, literal)` where the literal is not a value of that token */
		stale_fallback: 38,
		/** `var(--undeclared, literal)` — the literal paints in every axis */
		undeclared_fallback: 4,
		/** OUTER budget: every literal in a paint position, drift or not (retune-stable) */
		// 2026-10-12: 267 — the browser installer's installer.less left with it.
		// 2026-10-29: 266 — tool_common dead .node_info_save_msg styles removed (52d85b3dc2).
		paint_literals: 266,
	},
	js: {
		has_token: 27,
		stale_fallback: 6,
		undeclared_fallback: 0,
		/** OUTER budget: every colour literal spelled in a shipped JS string */
		// 2026-09-27: 72 — dd-modal window-button fallbacks now name theme tokens.
		// 2026-09-29: 74 — RAISED by decision: test_component_dataframe_tm_read_only.js
		// asserts a rating chip paints its datalist colour, so it needs one concrete
		// colour as FIXTURE DATA ('#ff0000' in, 'rgb(255, 0, 0)' out). Not a paint site.
		// 2026-10-12: 70 — the browser installer's render_installer.js left with it.
		string_literals: 70,
	},
} as const;

/**
 * Floors, each AT the measurement it guards (stated in the comment), so an emptied
 * corpus is red instead of green. They are not the bank: these numbers may grow freely.
 */
const FLOOR = {
	/** served documents compiled — 45 today, and asserted equal to entrypoints() */
	documents: 45,
	/** CSS rules parsed across the corpus — 6539 today */
	rules: 5900,
	/** root-declared custom properties resolving to a colour, in main.css — 268 today */
	token_names: 260,
	/** distinct 8-bit RGBA values those tokens carry — 278 today */
	token_values: 270,
	/** literals on the right of a `--x:` — the palette defining itself — 834 today */
	token_declaration_literals: 650,
	/** colour literals seen anywhere in the compiled corpus, any position — 1141 today */
	css_literals_seen: 1040,
	/** JS files scanned under client/ + tools/, minus lib/ — 820 today */
	js_files: 760,
	/** of those, files carrying at least one colour literal — 21 today */
	js_files_with_colour: 20,
};

// ---------------------------------------------------------------------------
// Colour parsing. Same maths as contrast_ratio_tripwire's parser (hex 3/4/6/8, rgb(),
// rgba(), plus hsl() which that gate does not need), normalised to an 8-bit RGBA key so
// `#fff`, `#ffffff`, `white` and `rgb(255,255,255)` are ONE value — a re-spelling must
// not move a number here.
// ---------------------------------------------------------------------------

interface Rgba {
	r: number;
	g: number;
	b: number;
	a: number;
}

/**
 * The CSS named colours. The whole table, not a sample: `#fff` → `white` is the
 * cheapest way to "improve" a hex census, and the audit's own instrument was blind to
 * every one of these. `transparent` and `currentcolor` are deliberately absent — they
 * are not frozen colours, they are references to what is behind or inherited.
 */
const NAMED: Record<string, string> = Object.fromEntries(
	(
		'aliceblue:f0f8ff antiquewhite:faebd7 aqua:00ffff aquamarine:7fffd4 azure:f0ffff beige:f5f5dc ' +
		'bisque:ffe4c4 black:000000 blanchedalmond:ffebcd blue:0000ff blueviolet:8a2be2 brown:a52a2a ' +
		'burlywood:deb887 cadetblue:5f9ea0 chartreuse:7fff00 chocolate:d2691e coral:ff7f50 ' +
		'cornflowerblue:6495ed cornsilk:fff8dc crimson:dc143c cyan:00ffff darkblue:00008b ' +
		'darkcyan:008b8b darkgoldenrod:b8860b darkgray:a9a9a9 darkgreen:006400 darkgrey:a9a9a9 ' +
		'darkkhaki:bdb76b darkmagenta:8b008b darkolivegreen:556b2f darkorange:ff8c00 ' +
		'darkorchid:9932cc darkred:8b0000 darksalmon:e9967a darkseagreen:8fbc8f darkslateblue:483d8b ' +
		'darkslategray:2f4f4f darkslategrey:2f4f4f darkturquoise:00ced1 darkviolet:9400d3 ' +
		'deeppink:ff1493 deepskyblue:00bfff dimgray:696969 dimgrey:696969 dodgerblue:1e90ff ' +
		'firebrick:b22222 floralwhite:fffaf0 forestgreen:228b22 fuchsia:ff00ff gainsboro:dcdcdc ' +
		'ghostwhite:f8f8ff gold:ffd700 goldenrod:daa520 gray:808080 green:008000 greenyellow:adff2f ' +
		'grey:808080 honeydew:f0fff0 hotpink:ff69b4 indianred:cd5c5c indigo:4b0082 ivory:fffff0 ' +
		'khaki:f0e68c lavender:e6e6fa lavenderblush:fff0f5 lawngreen:7cfc00 lemonchiffon:fffacd ' +
		'lightblue:add8e6 lightcoral:f08080 lightcyan:e0ffff lightgoldenrodyellow:fafad2 ' +
		'lightgray:d3d3d3 lightgreen:90ee90 lightgrey:d3d3d3 lightpink:ffb6c1 lightsalmon:ffa07a ' +
		'lightseagreen:20b2aa lightskyblue:87cefa lightslategray:778899 lightslategrey:778899 ' +
		'lightsteelblue:b0c4de lightyellow:ffffe0 lime:00ff00 limegreen:32cd32 linen:faf0e6 ' +
		'magenta:ff00ff maroon:800000 mediumaquamarine:66cdaa mediumblue:0000cd mediumorchid:ba55d3 ' +
		'mediumpurple:9370db mediumseagreen:3cb371 mediumslateblue:7b68ee mediumspringgreen:00fa9a ' +
		'mediumturquoise:48d1cc mediumvioletred:c71585 midnightblue:191970 mintcream:f5fffa ' +
		'mistyrose:ffe4e1 moccasin:ffe4b5 navajowhite:ffdead navy:000080 oldlace:fdf5e6 olive:808000 ' +
		'olivedrab:6b8e23 orange:ffa500 orangered:ff4500 orchid:da70d6 palegoldenrod:eee8aa ' +
		'palegreen:98fb98 paleturquoise:afeeee palevioletred:db7093 papayawhip:ffefd5 ' +
		'peachpuff:ffdab9 peru:cd853f pink:ffc0cb plum:dda0dd powderblue:b0e0e6 purple:800080 ' +
		'rebeccapurple:663399 red:ff0000 rosybrown:bc8f8f royalblue:4169e1 saddlebrown:8b4513 ' +
		'salmon:fa8072 sandybrown:f4a460 seagreen:2e8b57 seashell:fff5ee sienna:a0522d silver:c0c0c0 ' +
		'skyblue:87ceeb slateblue:6a5acd slategray:708090 slategrey:708090 snow:fffafa ' +
		'springgreen:00ff7f steelblue:4682b4 tan:d2b48c teal:008080 thistle:d8bfd8 tomato:ff6347 ' +
		'turquoise:40e0d0 violet:ee82ee wheat:f5deb3 white:ffffff whitesmoke:f5f5f5 yellow:ffff00 ' +
		'yellowgreen:9acd32 '
	)
		.trim()
		.split(' ')
		.map((entry) => {
			const [name, hex] = entry.split(':');
			return [name as string, `#${hex}`];
		}),
);

function parseHex(value: string): Rgba | null {
	const match = /^#([0-9a-f]{3,8})$/i.exec(value);
	if (!match) return null;
	const hex = (match[1] ?? '').toLowerCase();
	const expand = (s: string) => Number.parseInt(s.length === 1 ? `${s}${s}` : s, 16);
	if (hex.length === 3 || hex.length === 4) {
		return {
			r: expand(hex[0] as string),
			g: expand(hex[1] as string),
			b: expand(hex[2] as string),
			a: hex.length === 4 ? expand(hex[3] as string) / 255 : 1,
		};
	}
	if (hex.length === 6 || hex.length === 8) {
		return {
			r: Number.parseInt(hex.slice(0, 2), 16),
			g: Number.parseInt(hex.slice(2, 4), 16),
			b: Number.parseInt(hex.slice(4, 6), 16),
			a: hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1,
		};
	}
	// 5 and 7 digits are not colours: a truncated hex must not be read as one.
	return null;
}

function parseFunctional(value: string): Rgba | null {
	const match = /^(rgba?|hsla?)\(([^()]*)\)$/i.exec(value.trim());
	if (!match) return null;
	const fn = (match[1] ?? '').toLowerCase();
	// both the legacy comma form and the modern space/slash form
	const parts = (match[2] ?? '').split(/[,/\s]+/).filter((p) => p !== '');
	if (parts.length < 3) return null;
	const alphaRaw = parts[3];
	const alpha =
		alphaRaw === undefined
			? 1
			: alphaRaw.endsWith('%')
				? Number.parseFloat(alphaRaw) / 100
				: Number.parseFloat(alphaRaw);
	if (fn.startsWith('rgb')) {
		const channel = (s: string) =>
			s.endsWith('%') ? (Number.parseFloat(s) * 255) / 100 : Number.parseFloat(s);
		const rgba = {
			r: channel(parts[0] as string),
			g: channel(parts[1] as string),
			b: channel(parts[2] as string),
			a: Number.isFinite(alpha) ? alpha : 1,
		};
		return [rgba.r, rgba.g, rgba.b].every(Number.isFinite) ? rgba : null;
	}
	const h = Number.parseFloat(parts[0] as string) / 360;
	const s = Number.parseFloat(parts[1] as string) / 100;
	const l = Number.parseFloat(parts[2] as string) / 100;
	if (![h, s, l].every(Number.isFinite)) return null;
	const f = (n: number) => {
		const k = (n + h * 12) % 12;
		const a = s * Math.min(l, 1 - l);
		return l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
	};
	return {
		r: Math.round(f(0) * 255),
		g: Math.round(f(8) * 255),
		b: Math.round(f(4) * 255),
		a: Number.isFinite(alpha) ? alpha : 1,
	};
}

function parseColour(raw: string): Rgba | null {
	const value = raw.trim().toLowerCase();
	const named = NAMED[value];
	if (named !== undefined) return parseHex(named);
	return parseHex(value) ?? parseFunctional(value);
}

/** The identity of a colour: two spellings of the same paint share one key. */
const colourKey = (c: Rgba): string =>
	`${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)},${c.a.toFixed(3)}`;

/**
 * Colour-shaped text: a hex, a colour function, or a named colour. `\b` after the hex
 * digits refuses `#f78a1cff9`; the functional form is matched without nested parens
 * because CSS colour functions do not nest (a `color-mix()` is deliberately NOT matched
 * — the browser computes it, so it is not a frozen colour); the named colours carry
 * `(?<![\w-])`/`(?![\w-])` guards so `var(--color-white)` and `--fg_on_brand` are not
 * read as the colours their NAMES contain.
 */
const COLOUR_RE = new RegExp(
	`(#[0-9a-f]{3,8}\\b|\\b(?:rgba?|hsla?)\\([^()]*\\)|(?<![\\w-])(?:${Object.keys(NAMED).join('|')})(?![\\w-]))`,
	'gi',
);

/**
 * ONE occurrence of a colour in a value: either a bare literal, or the fallback of a
 * named token. Every counted literal is exactly one of these — that is what makes the
 * class partition (asserted below) add up to the raw match count.
 */
type Occurrence = { kind: 'bare'; text: string } | { kind: 'fallback'; name: string; text: string };

/**
 * Split a declaration value into occurrences, walking `var(` with BALANCED parens rather
 * than a regex. A regex cannot read `var(--a, var(--b, #fff))` — it stops at the first
 * `)` — and the naive version of this scanner silently dropped such literals from the
 * count while the class totals still "looked" complete. Nesting recurses, so the inner
 * literal is attributed to the inner token, and a fallback that is a SHORTHAND
 * (`var(--x, 1px solid #ccc)`) has its colour read out of the shorthand.
 */
function scanValue(value: string): Occurrence[] {
	const out: Occurrence[] = [];
	const lower = value.toLowerCase();
	const bare = (text: string) => {
		for (const match of text.matchAll(COLOUR_RE)) out.push({ kind: 'bare', text: match[0] });
	};
	let i = 0;
	while (i < value.length) {
		const at = lower.indexOf('var(', i);
		if (at === -1) {
			bare(value.slice(i));
			break;
		}
		bare(value.slice(i, at));
		let depth = 0;
		let end = -1;
		for (let j = at + 3; j < value.length; j++) {
			const c = value[j];
			if (c === '(') depth++;
			else if (c === ')') {
				depth--;
				if (depth === 0) {
					end = j;
					break;
				}
			}
		}
		if (end === -1) {
			// unbalanced (a truncated value): read the rest as plain text rather than lose it
			bare(value.slice(at));
			break;
		}
		const inner = value.slice(at + 4, end);
		const comma = inner.indexOf(',');
		const name = (comma === -1 ? inner : inner.slice(0, comma)).trim();
		const fallback = comma === -1 ? '' : inner.slice(comma + 1).trim();
		if (/^--[a-z0-9_-]+$/i.test(name) && fallback !== '') {
			if (parseColour(fallback) !== null) out.push({ kind: 'fallback', name, text: fallback });
			else out.push(...scanValue(fallback));
		}
		i = end + 1;
	}
	return out;
}

// ---------------------------------------------------------------------------
// CSS reading.
// ---------------------------------------------------------------------------

interface CssRule {
	selector: string;
	declarations: [string, string][];
}

/**
 * Flat rules out of compiled CSS. Comments are stripped first — the whole point of
 * reading the compiled bytes is that a comment is not a colour. At-rule WRAPPERS
 * (`@media`, `@keyframes`) are transparent: their inner rules are real served
 * declarations and are judged, `@media print` included (a print sheet is served CSS;
 * the audit's print carve-out belongs to the theme-blind law, not to a budget).
 */
function parseRules(css: string): CssRule[] {
	const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
	const rules: CssRule[] = [];
	for (const match of clean.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
		let selector = (match[1] ?? '').replace(/\s+/g, ' ').trim();
		// `[^{}]*` swallows back to the previous `}`, so a STATEMENT at-rule
		// (`@charset …;`) above a rule lands in the selector capture and would make the
		// root unrecognisable — emptying the palette and turning the gate green.
		const lastSemicolon = selector.lastIndexOf(';');
		if (lastSemicolon !== -1) selector = selector.slice(lastSemicolon + 1).trim();
		const declarations: [string, string][] = [];
		for (const decl of (match[2] ?? '').split(';')) {
			const idx = decl.indexOf(':');
			if (idx === -1) continue;
			const property = decl.slice(0, idx).trim().toLowerCase();
			const value = decl
				.slice(idx + 1)
				.trim()
				.replace(/\s*!important$/i, '');
			if (property !== '') declarations.push([property, value]);
		}
		if (selector !== '' && !selector.startsWith('@')) rules.push({ selector, declarations });
	}
	return rules;
}

/**
 * A GLOBAL ROOT selector — the only place a declaration reaches the whole document.
 * Same grammar as `css_token_duplication_tripwire`: `body`/`*` count, attribute
 * qualifiers (`[data-theme="dark"]`) count, a descendant
 * (`:root .tool_x`) does not — a scoped override is bounded by its selector and is not
 * the palette.
 */
const GLOBAL_ROOT_TOKEN = /^(?::root|html|body|\*)(?:\[[^\]]*\])*$/;
const isRootSelector = (selector: string): boolean =>
	selector
		.split(',')
		.map((s) => s.trim())
		.some((part) => {
			const atoms = part.split(/\s+/).filter(Boolean);
			return atoms.length > 0 && atoms.every((a) => GLOBAL_ROOT_TOKEN.test(a));
		});

/**
 * The document's palette: every custom property declared on a global root, with EVERY
 * value it takes across every axis the sheet declares (light `:root`, the dark root). A name is "declared" if any axis declares it; a literal "matches" the
 * name if it equals any of those values — deliberately generous, because a literal that
 * equals the dark value and not the light one is coherent with a real decision
 * somewhere, and the drift this bank is about is the literal nobody can point at.
 */
function collectPalette(rules: CssRule[]): Map<string, Set<string>> {
	const raw = new Map<string, string[]>();
	for (const rule of rules) {
		if (!isRootSelector(rule.selector)) continue;
		for (const [property, value] of rule.declarations) {
			if (!property.startsWith('--')) continue;
			const existing = raw.get(property);
			if (existing) existing.push(value);
			else raw.set(property, [value]);
		}
	}
	// A token may point at another token (`--fg_on_brand: var(--color_black)`), so follow
	// the chain; a chain that never reaches a colour contributes nothing.
	const resolve = (value: string, depth: number): string[] => {
		if (depth > 10) return [];
		const text = value.trim();
		const varMatch = /^var\(\s*(--[a-z0-9_-]+)\s*(?:,([\s\S]+))?\)$/i.exec(text);
		if (varMatch) {
			const values = raw.get(varMatch[1] ?? '') ?? [];
			const out: string[] = [];
			for (const v of values) out.push(...resolve(v, depth + 1));
			if (values.length === 0 && varMatch[2] !== undefined) {
				out.push(...resolve(varMatch[2], depth + 1));
			}
			return out;
		}
		const colour = parseColour(text);
		return colour ? [colourKey(colour)] : [];
	};
	const palette = new Map<string, Set<string>>();
	for (const [name, values] of raw) {
		const keys = new Set<string>();
		for (const value of values) for (const k of resolve(value, 0)) keys.add(k);
		if (keys.size > 0) palette.set(name, keys);
	}
	return palette;
}

/**
 * Structurally non-tokenizable paint. Judged on the GRAMMAR of the declaration, never
 * on a file or class name:
 *   - anything inside `url()` — an SVG fill in a `data:` URI (`%23ff0000`) cannot be a
 *     custom property, and this is also what keeps `%23` out of the census;
 *   - gradient stops, mask images and filters — the audit's own carve-out list.
 */
const stripUrls = (value: string): string => value.replace(/url\([^)]*\)/gi, 'url()');
const isNonTokenizable = (property: string, value: string): boolean =>
	/gradient\(/i.test(value) || /^(?:-webkit-)?mask/.test(property) || property === 'filter';

type CssClass =
	| 'has_token'
	| 'stale_fallback'
	| 'undeclared_fallback'
	| 'coherent_fallback'
	| 'unmatched';

interface CssCensus {
	rules: number;
	/** every colour-shaped match, wherever it sits — the anti-vacuity total */
	literals_seen: number;
	/** literals on the right of a `--x:` declaration: the palette defining itself */
	token_declaration_literals: number;
	/** literals excluded by grammar (url/gradient/mask/filter) */
	non_tokenizable: number;
	counts: Record<CssClass, number>;
	sites: Record<CssClass, string[]>;
}

const emptyCssCensus = (): CssCensus => ({
	rules: 0,
	literals_seen: 0,
	token_declaration_literals: 0,
	non_tokenizable: 0,
	counts: {
		has_token: 0,
		stale_fallback: 0,
		undeclared_fallback: 0,
		coherent_fallback: 0,
		unmatched: 0,
	},
	sites: {
		has_token: [],
		stale_fallback: [],
		undeclared_fallback: [],
		coherent_fallback: [],
		unmatched: [],
	},
});

/**
 * Classify one served document. Exported shape so the planted controls below can drive
 * the SAME function the corpus goes through — a control that exercises a copy proves
 * nothing about the gate.
 */
function classifyStylesheet(
	css: string,
	label: string,
	palette: Map<string, Set<string>>,
	into: CssCensus,
): void {
	const rules = parseRules(css);
	into.rules += rules.length;
	const documentPalette = new Map(palette);
	for (const [name, values] of collectPalette(rules)) documentPalette.set(name, values);
	const paletteValues = new Set<string>();
	for (const values of documentPalette.values()) for (const k of values) paletteValues.add(k);

	const record = (klass: CssClass, where: string) => {
		into.counts[klass] += 1;
		into.sites[klass].push(where);
	};

	for (const rule of rules) {
		for (const [property, rawValue] of rule.declarations) {
			const value = stripUrls(rawValue);
			// The raw match count, computed INDEPENDENTLY of the classifier: the partition
			// assertion below compares the two, so a class that silently stops receiving
			// occurrences cannot lower the drift count unnoticed.
			const seen = [...value.matchAll(COLOUR_RE)].filter((m) => parseColour(m[0]) !== null);
			if (seen.length === 0) continue;
			into.literals_seen += seen.length;
			// The palette declaring itself is not drift: `--color_white: #fff` is the
			// definition every other site is supposed to point at. Whether those values
			// are RIGHT is the contrast gate's and the palette-axis gate's question.
			if (property.startsWith('--')) {
				into.token_declaration_literals += seen.length;
				continue;
			}
			if (isNonTokenizable(property, value)) {
				into.non_tokenizable += seen.length;
				continue;
			}
			for (const occurrence of scanValue(value)) {
				const literal = parseColour(occurrence.text);
				if (!literal) continue; // `var(--modal_radius, 7px)` is not a colour
				if (occurrence.kind === 'bare') {
					const where = `${label} | ${rule.selector} | ${property}: ${occurrence.text}`;
					record(paletteValues.has(colourKey(literal)) ? 'has_token' : 'unmatched', where);
					continue;
				}
				const where = `${label} | ${rule.selector} | ${property}: var(${occurrence.name}, ${occurrence.text})`;
				const declared = documentPalette.get(occurrence.name);
				if (declared === undefined) record('undeclared_fallback', where);
				else if (!declared.has(colourKey(literal))) record('stale_fallback', where);
				else record('coherent_fallback', where);
			}
		}
	}
}

// ---------------------------------------------------------------------------
// JS reading. Colours in JS live in STRINGS (`el.style.background = '#f78a1c'`, a
// `<style>` template, a canvas fillStyle), so the corpus is string literals with
// comments removed — which is also what keeps the three corrupting match classes out:
// an issue reference (`see ckeditor5#1341`) is in a comment, an HTML entity (`&#39;`)
// is not hex-shaped past two digits, and an id selector (`'#dd1'`) parses to a colour
// no token carries and lands in UNMATCHED, never in the drift bank.
// ---------------------------------------------------------------------------

/**
 * NAMED colours need a CSS context to be colours in JS. In a stylesheet, `white` in a
 * declaration value can only be a paint; in JS the same word is far more often a CLASS
 * NAME — measured on this tree, 7 of the 12 bare name matches are
 * `classList.add('white')` / `class_name: 'button link grey'`, the same phantom class
 * the audit's hex census hit with `#dd1` id selectors. So a bare name counts here ONLY
 * when it sits right after a `:`, i.e. inside a CSS declaration the string carries;
 * everything else is blanked before scanning, which keeps the raw count and the class
 * partition reading the same text. The price is stated in the header: a paint passed as
 * a bare argument (`.attr('stroke', 'white')`, 2 sites) is not counted at all.
 */
const NAMED_WORD_RE = new RegExp(`(?<![\\w-])(?:${Object.keys(NAMED).join('|')})(?![\\w-])`, 'gi');
function prepareJsString(text: string): string {
	return text.replace(NAMED_WORD_RE, (match, offset: number) => {
		const before = text.slice(0, offset).trimEnd();
		return before.endsWith(':') ? match : '·'.repeat(match.length);
	});
}

interface JsString {
	text: string;
	line: number;
}

/**
 * A lexer approximation: enough to know string from comment, honouring escapes and
 * template literals (a `//` inside a template is content, which matters — `dd-modal.js`
 * ships a whole `<style>` block with CSS comments in it). A regex literal containing a
 * quote can shift the boundaries; that limit is stated in the header.
 */
function jsStrings(source: string): JsString[] {
	const out: JsString[] = [];
	let i = 0;
	let line = 1;
	let inLineComment = false;
	let inBlockComment = false;
	while (i < source.length) {
		const c = source[i] as string;
		if (c === '\n') {
			line++;
			inLineComment = false;
			i++;
			continue;
		}
		if (inLineComment) {
			i++;
			continue;
		}
		if (inBlockComment) {
			if (c === '*' && source[i + 1] === '/') {
				inBlockComment = false;
				i += 2;
			} else i++;
			continue;
		}
		if (c === '/' && source[i + 1] === '/') {
			inLineComment = true;
			i += 2;
			continue;
		}
		if (c === '/' && source[i + 1] === '*') {
			inBlockComment = true;
			i += 2;
			continue;
		}
		if (c === '"' || c === "'" || c === '`') {
			const quote = c;
			const startLine = line;
			let j = i + 1;
			let text = '';
			while (j < source.length) {
				const d = source[j] as string;
				if (d === '\\') {
					text += source[j + 1] ?? '';
					j += 2;
					continue;
				}
				if (d === quote) break;
				if (d === '\n') {
					line++;
					if (quote !== '`') break; // an unterminated quote does not span lines
				}
				text += d;
				j++;
			}
			out.push({ text, line: startLine });
			i = j + 1;
			continue;
		}
		i++;
	}
	return out;
}

type JsClass =
	| 'has_token'
	| 'stale_fallback'
	| 'undeclared_fallback'
	| 'coherent_fallback'
	| 'unmatched';

interface JsCensus {
	files: number;
	files_with_colour: number;
	literals_seen: number;
	counts: Record<JsClass, number>;
	sites: Record<JsClass, string[]>;
}

const emptyJsCensus = (): JsCensus => ({
	files: 0,
	files_with_colour: 0,
	literals_seen: 0,
	counts: {
		has_token: 0,
		stale_fallback: 0,
		undeclared_fallback: 0,
		coherent_fallback: 0,
		unmatched: 0,
	},
	sites: {
		has_token: [],
		stale_fallback: [],
		undeclared_fallback: [],
		coherent_fallback: [],
		unmatched: [],
	},
});

/**
 * `ui.css_var('--name', '<fallback>')` — the client's own token reader, whose second
 * argument is a fallback exactly like the CSS one and drifts exactly the same way
 * (`css_var('--color_primary', '#3b82f6')` names a colour the palette does not have).
 * Matched on the CALL because the call IS the interface; a rename of the helper moves
 * these sites into the plain-literal class, where the outer budget still holds them.
 */
const CSS_VAR_CALL_RE = /css_var\(\s*['"](--[a-z0-9_-]+)['"]\s*,\s*['"]([^'"]+)['"]\s*\)/gi;

function classifyJsSource(
	source: string,
	label: string,
	palette: Map<string, Set<string>>,
	into: JsCensus,
): void {
	const paletteValues = new Set<string>();
	for (const values of palette.values()) for (const k of values) paletteValues.add(k);
	const before = into.literals_seen;
	const record = (klass: JsClass, where: string) => {
		into.counts[klass] += 1;
		into.sites[klass].push(where);
	};
	const judgeFallback = (name: string, literalText: string, where: string): void => {
		const literal = parseColour(literalText);
		if (!literal) return;
		const declared = palette.get(name);
		if (declared === undefined) record('undeclared_fallback', where);
		else if (!declared.has(colourKey(literal))) record('stale_fallback', where);
		else record('coherent_fallback', where);
	};

	// The `css_var('--x', '#hex')` calls are judged FIRST and then blanked out of the
	// source, because their second argument is itself a string literal: scanned twice,
	// one site would be counted as both a fallback and a bare literal.
	for (const call of source.matchAll(CSS_VAR_CALL_RE)) {
		const literalText = (call[2] as string).trim();
		if (parseColour(literalText) === null) continue;
		into.literals_seen += 1;
		judgeFallback(call[1] as string, literalText, `${label} | css_var(${call[1]}, ${call[2]})`);
	}
	const rest = source.replace(CSS_VAR_CALL_RE, 'css_var()');

	for (const raw of jsStrings(rest)) {
		const str = { text: prepareJsString(raw.text), line: raw.line };
		into.literals_seen += [...str.text.matchAll(COLOUR_RE)].filter(
			(m) => parseColour(m[0]) !== null,
		).length;
		for (const occurrence of scanValue(str.text)) {
			const literal = parseColour(occurrence.text);
			if (!literal) continue;
			if (occurrence.kind === 'bare') {
				record(
					paletteValues.has(colourKey(literal)) ? 'has_token' : 'unmatched',
					`${label}:${str.line} | ${occurrence.text}`,
				);
				continue;
			}
			judgeFallback(
				occurrence.name,
				occurrence.text,
				`${label}:${str.line} | var(${occurrence.name}, ${occurrence.text})`,
			);
		}
	}
	if (into.literals_seen > before) into.files_with_colour += 1;
}

// ---------------------------------------------------------------------------
// The measurement over the real corpus. Done once, at module scope, because both the
// CSS compile and the JS walk are the expensive part and every test reads the result.
// ---------------------------------------------------------------------------

const SERVED = entrypoints();
const compiled = new Map<string, string>();
for (const entry of SERVED) compiled.set(entry, (await buildOne(entry)).css);

// The palette lives in main.css. If the entrypoint discovery stops finding it, every
// literal in the app becomes "tokenless" and the drift count collapses to zero — so this
// is a hard, loud failure at load time rather than a quietly emptied Map.
const mainCss = compiled.get(MAIN_ENTRYPOINT);
if (mainCss === undefined) {
	throw new Error(
		`colour_literal_ratchet: ${MAIN_ENTRYPOINT} is not among the ${SERVED.length} entrypoints — the corpus is not the app's.`,
	);
}
const mainPalette = collectPalette(parseRules(mainCss));

const cssCensus = emptyCssCensus();
for (const entry of SERVED) {
	// A sheet injected into the SPA document inherits main.css's palette; a standalone
	// document has only its own. Getting this backwards would invent tokens for the
	// pdf.js iframes and hide literals there.
	const palette =
		STANDALONE_DOCUMENTS[entry] === undefined ? mainPalette : new Map<string, Set<string>>();
	classifyStylesheet(compiled.get(entry) as string, entry, palette, cssCensus);
}

const jsCensus = emptyJsCensus();
// The served first-party browser trees, from the ONE place their roots are named
// (test/helpers/browser_corpus.ts). Vendored `lib/` is not ours to tokenize, and
// the helper already drops it along with vendor/ and minified bundles.
const jsSources = browserSources();
for (const file of jsSources) {
	jsCensus.files += 1;
	classifyJsSource(readFileSync(join(REPO_ROOT, file), 'utf8'), file, mainPalette, jsCensus);
}

const cssPaintLiterals =
	cssCensus.counts.has_token +
	cssCensus.counts.stale_fallback +
	cssCensus.counts.undeclared_fallback +
	cssCensus.counts.coherent_fallback +
	cssCensus.counts.unmatched;
const jsLiterals =
	jsCensus.counts.has_token +
	jsCensus.counts.stale_fallback +
	jsCensus.counts.undeclared_fallback +
	jsCensus.counts.coherent_fallback +
	jsCensus.counts.unmatched;

/** Shrink-only in both directions, with the two failures told apart. */
function expectRatchet(name: string, measured: number, banked: number, sites: string[]): void {
	const listed = sites.slice(0, 40).join('\n');
	const more = sites.length > 40 ? `\n… and ${sites.length - 40} more` : '';
	const detail = sites.length > 0 ? `\n\nSites:\n${listed}${more}` : '';
	const message =
		measured > banked
			? `${name} GREW: ${measured} > banked ${banked}. A new colour literal shipped. Point it at the token that already carries that value (or, if none does, declare one for every axis) — this number does not go up.${detail}`
			: `${name} SHRANK: ${measured} < banked ${banked}. Good — now lower the bank to ${measured} in test/unit/colour_literal_ratchet_tripwire.test.ts. A stale bank hides the progress and re-opens the room to regress into.${detail}`;
	expect(measured, message).toBe(banked);
}

describe('colour_literal_ratchet_tripwire', () => {
	test('the corpus is the built, served set — and it is not empty', () => {
		// Derived from the build's own entrypoint discovery, never a glob of this gate's.
		expect(compiled.size).toBe(SERVED.length);
		expect(compiled.size).toBeGreaterThanOrEqual(FLOOR.documents);
		expect(cssCensus.rules).toBeGreaterThanOrEqual(FLOOR.rules);
		expect(cssCensus.literals_seen).toBeGreaterThanOrEqual(FLOOR.css_literals_seen);
		// The palette harvest is what makes "has a token" decidable: if it empties, every
		// literal looks tokenless and the drift count falls to zero on its own.
		expect(mainPalette.size).toBeGreaterThanOrEqual(FLOOR.token_names);
		const values = new Set<string>();
		for (const set of mainPalette.values()) for (const k of set) values.add(k);
		expect(values.size).toBeGreaterThanOrEqual(FLOOR.token_values);
		// The palette must be found where the palette lives: main.css declares it.
		expect(cssCensus.token_declaration_literals).toBeGreaterThanOrEqual(
			FLOOR.token_declaration_literals,
		);
	});

	test('every standalone-document entry still names a served entrypoint', () => {
		// The record says which sheets do NOT inherit main.css's palette. An entry that
		// stopped being an entrypoint is a stale exemption: it would keep hiding a
		// document's literals from the palette comparison for a file nobody serves.
		const stale = Object.keys(STANDALONE_DOCUMENTS).filter((e) => !SERVED.includes(e));
		expect(stale.join(', ')).toBe('');
	});

	test('the JS corpus is the shipped client, and it is not empty', () => {
		// the walk itself, floored where it is bound: an empty corpus is RED, not a
		// green census over nothing
		expect(jsSources.length).toBeGreaterThan(760);
		expect(jsCensus.files).toBeGreaterThanOrEqual(FLOOR.js_files);
		expect(jsCensus.files_with_colour).toBeGreaterThanOrEqual(FLOOR.js_files_with_colour);
	});

	test('every literal lands in exactly one class (the partition is complete)', () => {
		// If a class silently stopped receiving occurrences, the drift count would fall
		// without anything being fixed. The totals must add up, on both sides.
		expect(
			cssCensus.literals_seen,
			'CSS literals seen must equal token declarations + non-tokenizable + the five paint classes',
		).toBe(cssCensus.token_declaration_literals + cssCensus.non_tokenizable + cssPaintLiterals);
		expect(jsCensus.literals_seen).toBe(jsLiterals);
	});

	test('CSS colour-literal drift does not grow (shrink-only ratchet)', () => {
		expectRatchet(
			'CSS has_token (a bare literal a root token already carries)',
			cssCensus.counts.has_token,
			BANK.css.has_token,
			cssCensus.sites.has_token,
		);
		expectRatchet(
			'CSS stale_fallback (var(--declared, literal) whose literal is not that token)',
			cssCensus.counts.stale_fallback,
			BANK.css.stale_fallback,
			cssCensus.sites.stale_fallback,
		);
		expectRatchet(
			'CSS undeclared_fallback (var(--nowhere-declared, literal) — the literal paints in every axis)',
			cssCensus.counts.undeclared_fallback,
			BANK.css.undeclared_fallback,
			cssCensus.sites.undeclared_fallback,
		);
	});

	test('the outer CSS budget does not grow either (a retune cannot hide a site)', () => {
		// has_token is defined by equality with a palette value, so a retune that moves a
		// token away from a literal reclassifies that site as unmatched. This number does
		// not move when that happens: every literal in a paint position is in it.
		expectRatchet(
			'CSS paint_literals (every colour literal in a paint position)',
			cssPaintLiterals,
			BANK.css.paint_literals,
			[],
		);
	});

	test('JS colour-literal drift does not grow (shrink-only ratchet)', () => {
		expectRatchet(
			'JS has_token (a colour spelled in shipped JS that a root token already carries)',
			jsCensus.counts.has_token,
			BANK.js.has_token,
			jsCensus.sites.has_token,
		);
		expectRatchet(
			'JS stale_fallback (var()/css_var() fallback naming a colour the palette has since changed)',
			jsCensus.counts.stale_fallback,
			BANK.js.stale_fallback,
			jsCensus.sites.stale_fallback,
		);
		expectRatchet(
			'JS undeclared_fallback (a fallback for a token no served document declares)',
			jsCensus.counts.undeclared_fallback,
			BANK.js.undeclared_fallback,
			jsCensus.sites.undeclared_fallback,
		);
	});

	test('the outer JS budget does not grow either', () => {
		expectRatchet(
			'JS string_literals (every colour literal spelled in a shipped JS string)',
			jsLiterals,
			BANK.js.string_literals,
			[],
		);
	});

	test('the classifier catches each drift class (planted positive control)', () => {
		const planted = [
			':root{--brand:#f78a1c;--fg_x:var(--brand);}',
			':root[data-theme="dark"]{--brand:#ffa54a;}',
			'.planted_bare{color:#f78a1c;}', // equals the light brand → has_token
			'.planted_bare_dark{color:#ffa54a;}', // equals the dark brand → has_token
			'.planted_stale{color:var(--brand,#ad5e0d);}', // the retired orange → stale
			'.planted_undeclared{color:var(--nowhere,#123456);}', // no such token → undeclared
			'.planted_coherent{color:var(--brand,#f78a1c);}', // duplication, not drift
			'.planted_unmatched{box-shadow:0 0 2px rgba(3,4,5,0.11);}', // no token has it
		].join('\n');
		const census = emptyCssCensus();
		classifyStylesheet(planted, 'planted', new Map(), census);
		expect(census.counts.has_token).toBe(2);
		expect(census.counts.stale_fallback).toBe(1);
		expect(census.counts.undeclared_fallback).toBe(1);
		expect(census.counts.coherent_fallback).toBe(1);
		expect(census.counts.unmatched).toBe(1);

		const js = emptyJsCensus();
		classifyJsSource(
			[
				"node.style.background = '#f78a1c';",
				"node.style.color = ui.css_var('--brand', '#ad5e0d');",
				"node.style.borderColor = 'var(--nowhere, #123456)';",
			].join('\n'),
			'planted.js',
			new Map([['--brand', new Set([colourKey(parseColour('#f78a1c') as Rgba)])]]),
			js,
		);
		expect(js.counts.has_token).toBe(1);
		expect(js.counts.stale_fallback).toBe(1);
		expect(js.counts.undeclared_fallback).toBe(1);
	});

	test('the three corrupting match classes are NOT counted (negative control)', () => {
		// C18: a naive hex census banks phantoms. Each of these would be a match for
		// `grep -oE '#[0-9a-f]{3,8}'` and none of them is a colour this gate counts.
		const css = [
			'ul#dd1 li, #f5 span{margin:0;}', // id selectors: a selector is never scanned
			'.icon{background:url("data:image/svg+xml,%3Csvg fill=\'%23ff0000\'%3E%3C/svg%3E") no-repeat;}',
			'/* the brand used to be #ad5e0d here */ .commented{margin:0;}',
		].join('\n');
		const census = emptyCssCensus();
		classifyStylesheet(css, 'phantoms', new Map(), census);
		expect(census.literals_seen).toBe(0);

		const js = emptyJsCensus();
		classifyJsSource(
			[
				'// destroy the UI components (see ckeditor5#1341, #7429).',
				'/* the old brand was #ad5e0d */',
				"const quote = '&#39;' + '&#x2014;';",
			].join('\n'),
			'phantoms.js',
			new Map(),
			js,
		);
		expect(js.literals_seen).toBe(0);
	});

	test('a re-spelling does not move a number (the census is on values, not text)', () => {
		// `#fff` → `white` → `rgb(255,255,255)` is the cheapest way to "improve" a hex
		// census. All three normalise to one key here, so the ratchet does not move.
		const palette = new Map([['--paper', new Set([colourKey(parseColour('#ffffff') as Rgba)])]]);
		for (const spelling of [
			'#fff',
			'#FFFFFF',
			'white',
			'rgb(255,255,255)',
			'rgb(255 255 255 / 1)',
		]) {
			const census = emptyCssCensus();
			classifyStylesheet(`.x{background:${spelling};}`, 'spelling', palette, census);
			expect(census.counts.has_token, `${spelling} must count as the same colour`).toBe(1);
		}
	});
});
