/**
 * PALETTE-AXIS PARITY tripwire (DEC-12; CSS coherence audit 2026-09-05, DESIGN
 * clause 2.b, findings C2 / C3 / C11 / C15). Subsumes and replaces
 * `theme_token_parity.test.ts` (2026-07-30 → 2026-09-06).
 *
 * WHAT WAS WRONG. A custom property declared ONCE, with a light value, and
 * consumed as a SURFACE, while the ink over it follows the theme: in dark both
 * go near-white and the text disappears. Measured live before the fix:
 * `--tool_identify_soft` #eaf2f4 under the inherited #e5e7ea page ink = 1.09:1,
 * at nine rule sites in two tool sheets — the `.menu_mobile_wrapper` bug the
 * retired gate was written for, third sighting. That gate paired FOUR prefixes
 * across TWO files (`vars_tokens.less` ↔ `theme_dark.less`): a token whose light
 * half lives in `tools/` was never in its corpus, and 72 of the 76 tool-private
 * tokens were invisible to it. The pairing rule for tool sheets was a comment in
 * `theme_dark.less` that nothing read, and `tool_sitebuilder` (born 2026-08-31)
 * reproduced the defect on its first day.
 *
 * WHAT THIS ASSERTS — over the COMPILED, SERVED set: every entrypoint
 * `scripts/build_css.ts` derives, compiled in memory by the same `buildOne` the
 * build runs (so the corpus is exactly what ships, and a stale committed `.css`
 * cannot fake a pass). The root palette COMBINATIONS are DERIVED from the
 * attribute selectors present on the served roots (no non-theme axis today, so
 * the only combination is `base`), never
 * enumerated, so a new axis is judged the day its first `:root[data-…]` ships.
 * The cascade is MODELLED, not asserted: for a given `<html>` attribute set the
 * winning declaration is the most specific applicable one, byte order breaking
 * ties, so a light literal that out-ranks the dark root is read as a RESULT
 * instead of counting lines in a block. Four legs:
 *
 *   1. TWIN PRESENCE. For every colour-valued token and every combination C:
 *      flipping the theme must change WHICH DECLARATION supplies the value
 *      (a distinct dark winner), or the value must be `light-dark()`, or the
 *      value must be a `var()` chain whose referent is itself paired (so
 *      `--tool_cataloging: var(--color_orange_dedalo)` is paired by inheritance
 *      and `--selection_fg: var(--color_black)` needs no copy). A core token
 *      re-declared by a tool on a bare `:root` is NOT flagged: the core dark
 *      twin outranks it whatever the injection order. A tool-private token
 *      (a name the core palette never declares) with no dark value anywhere is.
 *      The remedy for a tool sheet is a twin BESIDE its own `:root` (its own
 *      `:root[data-theme="dark"]`, as tool_print / tool_identify do) or a line
 *      in `theme_dark.less` — never moving the token into the core palette,
 *      which `css_token_duplication_tripwire` forbids. Exempt: THEME_INVARIANT
 *      (reason each; an entry that gains a twin is red) and tokens with no
 *      consumer at all (leg 3 owns those — the honest defect is not "needs a
 *      twin"). A fully transparent value needs no twin: it paints nothing.
 *   2. DARK-ONLY ORPHAN. A token with a dark winner and NO light winner under
 *      the same combination: light computes it to nothing and every consuming
 *      rule drops or paints its fallback (`tool_assistant` paints three
 *      different greens from scattered fallbacks). Carried from the retired
 *      gate, with the vendor register (`--ck-color-*`: CKEditor's own bundle
 *      declares the light half) verified against the vendor file.
 *   3. DECLARED-BUT-UNCONSUMED. A colour token declared on a global root with
 *      zero `var()` consumers in the served CSS and no reader in served JS
 *      (`ui.css_var`, dd-modal's shadow sheet) is red — and a token declared
 *      for light whose every consumer is scoped under the dark root is red as
 *      LIGHT-DEAD (the light theme has a token nobody reads, so its light
 *      surface is painted by something else — `--debug_info_bar_bg`, C10).
 *   4. PRECONDITIONS the model needs: no name is declared at the same
 *      combination by two served sheets with different values (the winner
 *      would depend on `load_style()` injection order, which no static reading
 *      can know), and no colour token sits on a root INSIDE a conditional
 *      at-rule (an OS-keyed `prefers-color-scheme` palette is outside the
 *      attribute axis the client sets and this gate judges).
 *
 * DAY-ONE STATE (2026-09-06) is BANKED, shrink-only, set-equal: the dark-only
 * block (leg 2) has emptied; eight dead tokens (leg 3) and eleven
 * light-dead tokens (leg 3) are live defects in files this change does not own;
 * each is listed with its file and the fix, and an entry that stops failing is
 * red as stale — a bank that is not lowered hides progress and lets it regress.
 *
 * POSITIVE CONTROLS drive the same `analyse()` over synthetic sheets: a planted
 * light-only hex is red; a planted COPIED twin is GREEN here — that pair
 * documents the division of labour with the contrast gate (2.c), which is the
 * only instrument that reads a value's legibility.
 *
 * DOES NOT PROVE. That a twin is LEGIBLE (a dark value chosen badly passes legs
 * 1–3; `contrast_ratio_tripwire` judges the pairs); anything about dimension,
 * duration, shadow or url tokens (they are not colour-valued and are skipped);
 * scoped overrides (`.wrapper_tool.tool_x { --x: … }` is the sanctioned idiom
 * and bounded by its selector — outside the root corpus by design); which FILE
 * carries a twin; a consumer that reaches a token through a name built at
 * runtime (`var(--${x})` in JS) — the JS scan is a substring read; and the
 * cross-element cascade (a `body { --x }` beside a `:root { --x }` is modelled
 * by element depth, not by the DOM). The two PDF.js sheets render into their
 * own document, so a twin in `theme_dark.less` cannot reach them: they are held
 * to an in-sheet twin, and today declare no root token at all — that leg is
 * honestly vacuous until one does.
 *
 * COST: compiles the 45 entrypoints (~1s), reads 820 served JS files and two
 * vendor files. DB-less, network-less → hermetic tier.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildOne, entrypoints } from '../../scripts/build_css.ts';
import { libRoot } from '../../src/core/client_libs/registry.ts';
import { browserSources } from '../helpers/browser_corpus.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..');

/** The SPA document stylesheet — first in cascade order; every other sheet is injected after it. */
const MAIN_LESS = 'client/dedalo/core/page/css/main.less';

/** The attribute the theme axis lives on. Its VALUES are derived from the served roots. */
const THEME_ATTR = 'data-theme';

// ---------------------------------------------------------------------------
// Floors — at the measured corpus (2026-09-06), so a refactor that silently
// empties any population turns the gate RED instead of green.
// ---------------------------------------------------------------------------
/** entrypoints derived by the build: 43 */
const MIN_ENTRYPOINTS = 40;
/** distinct custom-property names declared on a global root across the served set: 413 */
const MIN_ROOT_NAMES = 400;
/** …of which colour-valued: 348 */
const MIN_COLOUR_NAMES = 340;
/** colour-valued names declared by tool sheets (the population the retired gate never saw): 95 */
const MIN_TOOL_COLOUR_NAMES = 90;
/** colour names whose RESOLVED value theme_dark changes relative to base: 265 */
const MIN_THEME_CHANGED = 260;
/** root palette combinations derived from the served selectors: base */
const MIN_COMBINATIONS = 1;
/** `var()` references across the served set (the consumer corpus legs 1 and 3 read): 3897 */
const MIN_VAR_REFS = 3800;
/** served JS files scanned for token readers: 775 */
const MIN_JS_FILES = 700;
/** colour-valued base names under the four prefixes the retired gate paired: 46 */
const MIN_CARRIED_FAMILY_NAMES = 40;

// ---------------------------------------------------------------------------
// Registers. Every exemption is DECLARED, with the token, the file and WHY —
// an undeclared exemption (a prefix skip, a "some tokens are light-only" in
// prose) is exactly what the audit found. Each register is checked for
// staleness below: an entry that no longer describes the tree is red.
// ---------------------------------------------------------------------------

/**
 * Tokens that keep ONE value on both themes on purpose. Leg 1 skips them; the
 * hygiene test asserts each is still declared for light, still consumed, and
 * still has NO dark winner — an exemption that outlives its reason is red.
 */
const THEME_INVARIANT: ReadonlyArray<{ token: string; file: string; reason: string }> = [
	{
		token: '--tool_diffusion',
		file: 'tools/tool_diffusion/css/tool_diffusion.less',
		reason:
			'one deep sage for both themes, declared once in the tool sheet; a dark entry in theme_dark.less would win on specificity and silently reinstate a light bar under white header ink (the tool sheet says so in-file)',
	},
	{
		token: '--tool_assistant',
		file: 'tools/tool_assistant/css/tool_assistant.less',
		reason:
			'the indigo identity hue (#6366f1) the sheet declares as "reads well on both themes": the 4px header edge (3.78:1 on the dark surface, above the 3:1 non-text floor) and the send/apply button fills. Invariant by design; whether white ink on it is AA (4.47:1, measured 2026-09-06) is the contrast gate\'s question, not this one\'s',
	},
	{
		token: '--print_page_bg',
		file: 'tools/tool_print/css/tool_print.less',
		reason:
			'the paper preview: a page that stays white under either theme with its OWN near-black ink (.box_content sets color; flow cells get the inspector colour inline), so nothing on it inherits the theme ink. A dark "paper" would preview a page nobody prints',
	},
];

/**
 * Vendor namespaces: names the served CSS declares or overrides for a library
 * whose OWN stylesheet is the other half — outside the served set, but on disk
 * and registered in `src/core/client_libs/registry.ts`. Leg 2 accepts the
 * vendor as the light declarer, leg 3 as the consumer, ONLY for names the
 * vendor file actually contains: a name the vendor never reads is judged like
 * any other (see `--ck-color-button-default-color` in DEAD_TOKENS).
 */
const VENDOR_NAMESPACES: ReadonlyArray<{
	prefix: string;
	lib: string;
	file: string;
	role: string;
}> = [
	{
		prefix: '--ck-color-',
		lib: 'ckeditor',
		file: 'build/ckeditor.js',
		role: "CKEditor 5's bundle injects its own `:root { --ck-color-* }` light theme and consumes the names in its rules; service_ckeditor.less overrides them under the dark root only",
	},
	{
		prefix: '--mocha-',
		lib: 'mocha',
		file: 'mocha.css',
		role: 'the Mocha browser reporter reads its --mocha-* theme from mocha.css; unit_test.less declares them on both roots for the runner chrome',
	},
];

/**
 * DAY-ONE ORPHANS (leg 2), banked shrink-only. A dark-only token: light has no
 * value, every consumer paints its `var(--x, #literal)` fallback.
 */
const DARK_ONLY_ORPHANS: ReadonlyArray<{ file: string; tokens: string[]; fix: string }> = [
	// EMPTY on purpose, and it stays that way. The day-one bank held the 14
	// `--assistant_*` tokens tool_assistant.less declared under its dark root
	// ONLY; light resolved nothing and 35 call sites painted scattered
	// fallbacks (three different greens for one state). The light half was
	// declared and the fallbacks dropped on 2026-09-06, so the bank emptied.
	// Leg 2 is now a plain invariant: a dark-only colour token is red.
];

/**
 * DAY-ONE DEAD TOKENS (leg 3), banked shrink-only: declared on a global root,
 * consumed by no served rule and read by no served JS. The fix is deletion or a
 * consumer, decided by the file's owner — never a dark twin.
 */
const DEAD_TOKENS: ReadonlyArray<{ token: string; file: string }> = [
	{ token: '--color_purple', file: 'client/dedalo/core/page/css/layout/vars_tokens.less' },
	{ token: '--modal_mini_header_bg', file: 'client/dedalo/core/page/css/layout/vars_tokens.less' },
	{
		token: '--ck-color-button-default-color',
		file: 'client/dedalo/core/services/service_ckeditor/css/service_ckeditor.less (dark root only; CKEditor 5 42.0.1 never reads this name — an orphan AND dead)',
	},
	{ token: '--tool_diffusion_text', file: 'tools/tool_diffusion/css/tool_diffusion.less' },
	{
		token: '--tool_error_report_lighten_5',
		file: 'tools/tool_error_report/css/tool_error_report.less',
	},
	{
		token: '--tool_error_report_border',
		file: 'tools/tool_error_report/css/tool_error_report.less',
	},
	{
		token: '--tool_error_report_lighten_10',
		file: 'tools/tool_error_report/css/tool_error_report.less',
	},
	{ token: '--print_grid_color', file: 'tools/tool_print/css/tool_print.less' },
];

/**
 * DAY-ONE LIGHT-DEAD TOKENS (leg 3), banked shrink-only: declared for light,
 * every consumer under the dark root. In light the surface those consumers
 * paint comes from somewhere else (a literal, an alias) — the shape C10 found
 * under `--debug_info_bar_bg`. The fix is one unconditional consumer per token
 * (and dropping the dark-scoped duplicate), owned by the consuming sheet.
 */
const LIGHT_DEAD_TOKENS: ReadonlyArray<{ token: string; consumer: string }> = [
	{ token: '--selection_bg_blur', consumer: 'theme_dark.less (a dark-root alias)' },
	{ token: '--bg_header', consumer: 'component_geolocation.less dark block' },
	{ token: '--menu_dropdown_text', consumer: 'menu.less dark block' },
	{ token: '--menu_dropdown_bg', consumer: 'menu.less dark block' },
	{ token: '--menu_dropdown_border', consumer: 'menu.less dark block' },
	{ token: '--menu_dropdown_li_border', consumer: 'menu.less dark block' },
	{ token: '--select_bg', consumer: 'component_select.less dark block' },
	{ token: '--select_fg', consumer: 'component_select.less dark block' },
	{
		token: '--toolbar_btn_hover_bg',
		consumer: 'theme_dark.less aliases + a dark-scoped .toolbar_button:hover',
	},
	{
		// Added 2026-09-06 with the contrast day-one fixes. The token is the
		// identity EDGE's rim and is declared on both axes (light here, dark in
		// theme_dark.less:343). Its only consumer is the sheet's own dark block,
		// which aliases it into --tool_transcription_fill_border — because in
		// DARK the identity hue is already light-toned and IS the button fill,
		// so the rim is the hue's rim. In LIGHT the fill is a deepened #ad5510
		// with its own one-step-deeper rim (#8f4409), so the identity rim has
		// nothing to paint. A contrived light consumer would be worse than the
		// asymmetry: the two axes genuinely build the button differently.
		token: '--tool_transcription_border',
		consumer:
			"tool_transcription.less's own dark block (light builds the fill from a deepened hue instead)",
	},
];

/**
 * Sheets rendered into a document WITHOUT main.css (same record as
 * css_token_duplication's STANDALONE_DOCUMENTS): a twin in theme_dark.less
 * cannot reach them, so each must carry its own.
 */
const STANDALONE_SHEETS = [
	'client/dedalo/core/component_pdf/css/pdfjs_default_edit.less',
	'client/dedalo/core/component_pdf/css/pdfjs_default_read_only.less',
];

/** The four prefixes the retired gate paired — kept ONLY as the subsumption proof's anti-vacuity. */
const CARRIED_FAMILIES = ['--menu_', '--debug_info_bar_', '--mosaic_', '--ut_'];

// ---------------------------------------------------------------------------
// CSS reading — compiled space, brace-walked so at-rule nesting is known.
// ---------------------------------------------------------------------------

interface RootDecl {
	file: string;
	/** `:root`, `html`, `body` or `*` — see elementRank */
	element: string;
	/** `attr=value` pairs the selector REQUIRES (`[data-theme="dark"]`); `attr=*` for a bare `[attr]` */
	positive: string[];
	/** `attr=value` pairs the selector FORBIDS (`:not([data-theme="dark"])`) */
	negated: string[];
	/** at-rule conditions enclosing the rule — non-empty means "outside the attribute axis" */
	atRules: string[];
	name: string;
	value: string;
	/** global byte order across the served set — the cascade's tie-breaker */
	order: number;
}

interface Consumer {
	file: string;
	selector: string;
	name: string;
	/** the consuming rule is reachable only under the dark root */
	darkScoped: boolean;
}

interface Sheet {
	file: string;
	css: string;
}

const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** A compound that reaches the whole document: a root element, optionally attribute-qualified. */
const ROOT_COMPOUND = /^(:root|html|body|\*)((?:\[[^\]]*\]|:not\(\[[^\]]*\]\))*)$/;
const ATTR = /\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\]/g;

function parseRootCompound(
	compound: string,
): { element: string; positive: string[]; negated: string[] } | null {
	const m = ROOT_COMPOUND.exec(compound.trim());
	if (!m) return null;
	const qualifiers = m[2] ?? '';
	const negated: string[] = [];
	for (const n of qualifiers.matchAll(/:not\((\[[^\]]*\])\)/g)) {
		for (const a of (n[1] as string).matchAll(ATTR)) negated.push(`${a[1]}=${a[2] ?? '*'}`);
	}
	const positive: string[] = [];
	for (const a of qualifiers.replace(/:not\(\[[^\]]*\]\)/g, '').matchAll(ATTR)) {
		positive.push(`${a[1]}=${a[2] ?? '*'}`);
	}
	return { element: m[1] as string, positive: positive.sort(), negated: negated.sort() };
}

/**
 * Walk one compiled sheet. Rule bodies are flat in compiled CSS; the brace
 * stack is kept so a rule under `@media …` knows it (leg 4) and a `@media`
 * wrapper is never mistaken for a selector. Every `var(--x)` in any body is a
 * consumer; every `--x:` on a root compound is a declaration.
 */
function readSheet(
	sheet: Sheet,
	startOrder: number,
): { decls: RootDecl[]; consumers: Consumer[]; next: number } {
	const decls: RootDecl[] = [];
	const consumers: Consumer[] = [];
	const stack: string[] = [];
	let buf = '';
	let order = startOrder;
	const flushBody = (body: string) => {
		const selector = (stack[stack.length - 1] ?? '').trim().replace(/\s+/g, ' ');
		if (selector === '' || selector.startsWith('@')) return;
		const atRules = stack.slice(0, -1).filter((s) => s.startsWith('@'));
		const parts = selector.split(',').map((s) => s.trim());
		const darkScoped = parts.every((p) =>
			new RegExp(`\\[${THEME_ATTR}=["']?dark["']?\\]`).test(p.replace(/:not\([^)]*\)/g, '')),
		);
		for (const decl of body.split(';')) {
			const idx = decl.indexOf(':');
			if (idx === -1) continue;
			const prop = decl.slice(0, idx).trim();
			const value = decl
				.slice(idx + 1)
				.trim()
				.replace(/\s*!important$/i, '');
			for (const v of value.matchAll(/var\(\s*(--[\w-]+)/g)) {
				consumers.push({ file: sheet.file, selector, name: v[1] as string, darkScoped });
			}
			if (!prop.startsWith('--')) continue;
			for (const part of parts) {
				const root = parseRootCompound(part);
				if (!root) continue;
				decls.push({ file: sheet.file, ...root, atRules, name: prop, value, order: order++ });
			}
		}
	};
	for (const ch of stripComments(sheet.css)) {
		if (ch === '{') {
			// a statement at-rule (`@import …;`) before a rule sits in buf; the selector is after the last `;`
			stack.push((buf.split(';').pop() ?? '').trim());
			buf = '';
		} else if (ch === '}') {
			flushBody(buf);
			stack.pop();
			buf = '';
		} else buf += ch;
	}
	return { decls, consumers, next: order };
}

// ---------------------------------------------------------------------------
// The cascade model. An `<html>` attribute set A (e.g. ["data-theme=dark"]) selects the applicable declarations; the winner is the
// deepest element, then the most specific, then the last in byte order.
// ---------------------------------------------------------------------------

/** `*` matches every element (deepest); `body` is below `html`/`:root`. */
const elementRank = (element: string): number => (element === '*' ? 3 : element === 'body' ? 2 : 1);

const attrApplies = (required: string, A: string[]): boolean =>
	required.endsWith('=*')
		? A.some((a) => a.startsWith(required.slice(0, -1)))
		: A.includes(required);

const applicable = (d: RootDecl, A: string[]): boolean =>
	d.atRules.length === 0 &&
	d.positive.every((p) => attrApplies(p, A)) &&
	!d.negated.some((n) => attrApplies(n, A));

const specificity = (d: RootDecl): number => d.positive.length + d.negated.length;

const isTheme = (attr: string): boolean => attr.startsWith(`${THEME_ATTR}=`);

const COLOUR_FN = /^(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^()]*\)$/i;
const COLOUR_NAMED = new Set([
	'transparent',
	'currentcolor',
	'white',
	'black',
	'red',
	'green',
	'blue',
	'grey',
	'gray',
	'silver',
	'orange',
	'yellow',
	'purple',
]);
const isColourLiteral = (v: string): boolean =>
	/^#[0-9a-f]{3,8}$/i.test(v) || COLOUR_FN.test(v) || COLOUR_NAMED.has(v.toLowerCase());

/** A colour that paints nothing: `transparent`, or a functional/hex colour with alpha 0. */
const isTransparent = (v: string): boolean =>
	v === 'transparent' ||
	/^(rgba?|hsla?)\([^()]*[,/]\s*0(?:\.0+)?%?\s*\)$/i.test(v) ||
	/^#(?:[0-9a-f]{3}0|[0-9a-f]{6}00)$/i.test(v);

class Corpus {
	readonly decls: RootDecl[] = [];
	readonly consumers: Consumer[] = [];
	private readonly byName = new Map<string, RootDecl[]>();
	private readonly consumersByName = new Map<string, Consumer[]>();

	constructor(
		sheets: Sheet[],
		readonly jsText: string,
	) {
		let order = 0;
		for (const sheet of sheets) {
			const read = readSheet(sheet, order);
			order = read.next;
			this.decls.push(...read.decls);
			this.consumers.push(...read.consumers);
		}
		for (const d of this.decls) {
			const list = this.byName.get(d.name) ?? [];
			list.push(d);
			this.byName.set(d.name, list);
		}
		for (const c of this.consumers) {
			const list = this.consumersByName.get(c.name) ?? [];
			list.push(c);
			this.consumersByName.set(c.name, list);
		}
	}

	names(): string[] {
		return [...this.byName.keys()];
	}

	declarationsOf(name: string): RootDecl[] {
		return this.byName.get(name) ?? [];
	}

	consumersOf(name: string): Consumer[] {
		return this.consumersByName.get(name) ?? [];
	}

	/** Every theme VALUE the served roots name (`dark` today). Light is the absence. */
	themeValues(): string[] {
		const out = new Set<string>();
		for (const d of this.decls) {
			for (const a of d.positive) if (isTheme(a) && !a.endsWith('=*')) out.add(a);
		}
		return [...out].sort();
	}

	/** Every non-theme attribute set a served root requires — the palette combinations. */
	combinations(): string[][] {
		const out = new Map<string, string[]>();
		for (const d of this.decls) {
			const c = d.positive.filter((a) => !isTheme(a));
			out.set(c.join('&'), c);
		}
		return [...out.values()].sort(
			(a, b) => a.length - b.length || a.join().localeCompare(b.join()),
		);
	}

	winner(name: string, A: string[]): RootDecl | undefined {
		let best: RootDecl | undefined;
		for (const d of this.declarationsOf(name)) {
			if (!applicable(d, A)) continue;
			if (
				best === undefined ||
				elementRank(d.element) > elementRank(best.element) ||
				(elementRank(d.element) === elementRank(best.element) &&
					(specificity(d) > specificity(best) ||
						(specificity(d) === specificity(best) && d.order > best.order)))
			)
				best = d;
		}
		return best;
	}

	/**
	 * Follow a value to the literal it computes to under A. `light-dark()` picks
	 * by the theme in A; a `var()` fallback is honoured when the name has no
	 * winner. Returns null when the chain ends in nothing (an unset token with no
	 * fallback — the rule is dropped) or is too deep to be a real chain.
	 */
	resolve(value: string, A: string[], depth = 0): string | null {
		if (depth > 16) return null;
		const v = value.trim();
		const ref = /^var\(\s*(--[\w-]+)\s*(?:,([\s\S]+))?\)$/.exec(v);
		if (ref) {
			const w = this.winner(ref[1] as string, A);
			if (w) return this.resolve(w.value, A, depth + 1);
			return ref[2] !== undefined ? this.resolve(ref[2], A, depth + 1) : null;
		}
		const ld = /^light-dark\(([\s\S]+)\)$/i.exec(v);
		if (ld) {
			const args = splitTopLevel(ld[1] as string);
			const pick = A.some(isTheme) ? args[1] : args[0];
			return pick === undefined ? null : this.resolve(pick, A, depth + 1);
		}
		return v.toLowerCase().replace(/\s+/g, '');
	}

	/** Colour-valued: computes to a colour literal under the declaring root, or is a colour function of tokens. */
	isColourValued(d: RootDecl): boolean {
		if (/^(light-dark|color-mix)\(/i.test(d.value.trim())) return true;
		const r = this.resolve(d.value, d.positive);
		return r !== null && isColourLiteral(r);
	}

	/** Names with at least one colour-valued declaration. */
	colourNames(): string[] {
		return this.names().filter((n) => this.declarationsOf(n).some((d) => this.isColourValued(d)));
	}

	/**
	 * LEG 1's question for one (name, combination): does the theme flip change
	 * the declaration that supplies the value, or does the value move with the
	 * theme through what it references?
	 */
	isPaired(name: string, C: string[], theme: string, seen = new Set<string>()): boolean {
		if (seen.has(name)) return false;
		seen.add(name);
		const light = this.winner(name, C);
		const dark = this.winner(name, [...C, theme]);
		if (light === undefined) return true; // nothing declared for light: leg 2's case, not this one
		if (dark !== undefined && dark !== light) return true;
		if (/light-dark\(/i.test(light.value)) return true;
		const resolved = this.resolve(light.value, C);
		if (resolved !== null && isTransparent(resolved)) return true; // paints nothing under either theme
		// paired by inheritance: a var() chain whose referent flips
		const refs = [...light.value.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1] as string);
		return refs.length > 0 && refs.some((r) => this.isPaired(r, C, theme, seen));
	}

	isConsumed(name: string): boolean {
		return this.consumersOf(name).length > 0 || this.jsText.includes(name);
	}
}

/** Split `a, b` at top-level commas (a `rgb(1,2,3)` argument keeps its own). */
function splitTopLevel(s: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let cur = '';
	for (const ch of s) {
		if (ch === '(') depth++;
		if (ch === ')') depth--;
		if (ch === ',' && depth === 0) {
			out.push(cur.trim());
			cur = '';
		} else cur += ch;
	}
	out.push(cur.trim());
	return out;
}

const comboLabel = (C: string[]): string => (C.length === 0 ? 'base' : C.join('+'));

interface Findings {
	untwinned: string[];
	orphans: string[];
	dead: string[];
	lightDead: string[];
	conflicting: string[];
	underAtRule: string[];
	themeChanged: string[];
}

/**
 * The whole judgement, over any set of sheets — the real served set below,
 * synthetic ones in the positive controls. `exempt` is what the registers
 * remove from each leg; the hygiene tests assert the registers themselves.
 */
function analyse(
	corpus: Corpus,
	exempt: { invariant: Set<string>; vendor: Set<string>; dead: Set<string> } = {
		invariant: new Set(),
		vendor: new Set(),
		dead: new Set(),
	},
): Findings {
	const f: Findings = {
		untwinned: [],
		orphans: [],
		dead: [],
		lightDead: [],
		conflicting: [],
		underAtRule: [],
		themeChanged: [],
	};
	const themes = corpus.themeValues();
	const combos = corpus.combinations();
	const colourNames = corpus.colourNames();

	for (const name of colourNames) {
		const decls = corpus.declarationsOf(name);
		// leg 4b: a root palette under a conditional at-rule is outside the attribute axis
		for (const d of decls) {
			if (d.atRules.length > 0)
				f.underAtRule.push(`${name} under ${d.atRules.join(' ')} (${d.file})`);
		}
		// leg 4a: same combination, two sheets/elements, different values → winner is load-order
		const byCombo = new Map<string, RootDecl[]>();
		for (const d of decls) {
			const k = `${d.positive.join('&')}|${d.negated.join('&')}`;
			byCombo.set(k, [...(byCombo.get(k) ?? []), d]);
		}
		for (const [k, group] of byCombo) {
			const sources = new Set(group.map((d) => `${d.file}#${d.element}`));
			const values = new Set(group.map((d) => d.value.replace(/\s+/g, '')));
			if (sources.size > 1 && values.size > 1)
				f.conflicting.push(`${name} @ ${k || 'base'}: ${[...sources].join(' vs ')}`);
		}

		const consumed = corpus.isConsumed(name);
		const vendored = exempt.vendor.has(name);
		const dead = exempt.dead.has(name);

		// leg 3: declared, never consumed
		if (!consumed && !vendored) f.dead.push(name);
		// leg 3b: declared for light, consumed only under dark
		if (consumed && !vendored && !dead && corpus.winner(name, []) !== undefined) {
			const cs = corpus.consumersOf(name);
			if (cs.length > 0 && cs.every((c) => c.darkScoped) && !corpus.jsText.includes(name))
				f.lightDead.push(name);
		}

		for (const theme of themes) {
			for (const C of combos) {
				const light = corpus.winner(name, C);
				const dark = corpus.winner(name, [...C, theme]);
				// leg 2: dark winner, no light winner
				if (light === undefined && dark !== undefined && !vendored && !dead)
					f.orphans.push(`${name} @ ${comboLabel(C)} (${dark.file})`);
				// leg 1: consumed, not exempt, not paired under this combination
				if (
					light !== undefined &&
					consumed &&
					!dead &&
					!exempt.invariant.has(name) &&
					!corpus.isPaired(name, C, theme)
				)
					f.untwinned.push(`${name} @ ${comboLabel(C)} = ${light.value} (${light.file})`);
			}
		}
	}

	// anti-vacuity population: every base-theme-changed token
	for (const theme of themes) {
		const base = combos.find((c) => c.length === 0) ?? [];
		for (const name of colourNames) {
			const l = corpus.resolve(`var(${name})`, base);
			const d = corpus.resolve(`var(${name})`, [...base, theme]);
			if (l === d || l === null || d === null) continue;
			f.themeChanged.push(name);
		}
	}
	return f;
}

// ---------------------------------------------------------------------------
// The served corpus. Compiled once, here — `buildOne` is async, test bodies are
// not. main.css first: every other sheet is injected into its document after it.
// ---------------------------------------------------------------------------

const targets = entrypoints();
const ordered = [MAIN_LESS, ...targets.filter((t) => t !== MAIN_LESS)];
const sheets: Sheet[] = await Promise.all(
	ordered.map(async (file) => ({ file, css: (await buildOne(file)).css })),
);

/**
 * Served JS: a token read from `getComputedStyle` or a shadow-DOM sheet is a
 * consumer too. The roots come from the ONE place that names them
 * (test/helpers/browser_corpus.ts), which already drops vendored `lib/`.
 */
const jsFiles = browserSources();
const jsText = jsFiles.map((f) => readFileSync(join(REPO_ROOT, f), 'utf8')).join('\n');

const corpus = new Corpus(sheets, jsText);

/** Vendor names ACTUALLY present in the vendor file — an absent name gets no exemption. */
const vendorText = new Map<string, string>();
for (const v of VENDOR_NAMESPACES) {
	const root = libRoot(v.lib);
	const path = root === null ? null : join(root, v.file);
	vendorText.set(v.prefix, path !== null && existsSync(path) ? readFileSync(path, 'utf8') : '');
}
const vendorNames = new Set(
	corpus
		.names()
		.filter((n) =>
			VENDOR_NAMESPACES.some(
				(v) => n.startsWith(v.prefix) && (vendorText.get(v.prefix) ?? '').includes(n),
			),
		),
);

const bankedDead = new Set(DEAD_TOKENS.map((e) => e.token));
const bankedOrphans = new Set(DARK_ONLY_ORPHANS.flatMap((e) => e.tokens));
const bankedLightDead = new Set(LIGHT_DEAD_TOKENS.map((e) => e.token));
const invariant = new Set(THEME_INVARIANT.map((e) => e.token));

const findings = analyse(corpus, { invariant, vendor: vendorNames, dead: bankedDead });

const list = (items: string[]): string => items.map((i) => `  ${i}`).join('\n');
const nameOf = (finding: string): string => finding.split(' ')[0] as string;

// ---------------------------------------------------------------------------

describe('palette_axis_parity_tripwire', () => {
	test('the corpus is the whole served set, at the measured size (a zero-length pass is not a pass)', () => {
		expect(targets.length, 'entrypoints derived by scripts/build_css.ts').toBeGreaterThanOrEqual(
			MIN_ENTRYPOINTS,
		);
		expect(targets).toContain(MAIN_LESS);
		expect(
			corpus.names().length,
			'custom properties declared on a global root',
		).toBeGreaterThanOrEqual(MIN_ROOT_NAMES);
		expect(corpus.colourNames().length, 'colour-valued root names').toBeGreaterThanOrEqual(
			MIN_COLOUR_NAMES,
		);
		const toolColourNames = new Set(
			corpus.decls
				.filter((d) => d.file.startsWith('tools/') && corpus.isColourValued(d))
				.map((d) => d.name),
		);
		expect(
			toolColourNames.size,
			'colour-valued names declared by tool sheets — the population the retired gate never saw',
		).toBeGreaterThanOrEqual(MIN_TOOL_COLOUR_NAMES);
		expect(corpus.consumers.length, 'var() references in the served set').toBeGreaterThanOrEqual(
			MIN_VAR_REFS,
		);
		expect(jsFiles.length, 'served JS files scanned for token readers').toBeGreaterThanOrEqual(
			MIN_JS_FILES,
		);
		// the axes are DERIVED: a theme value and the combination that ships today
		expect(corpus.themeValues(), 'theme values named by served roots').toContain(
			`${THEME_ATTR}=dark`,
		);
		expect(
			corpus.combinations().length,
			`palette combinations derived from served roots: ${corpus.combinations().map(comboLabel).join(', ')}`,
		).toBeGreaterThanOrEqual(MIN_COMBINATIONS);
		expect(
			findings.themeChanged.length,
			'tokens whose resolved value the dark theme changes',
		).toBeGreaterThanOrEqual(MIN_THEME_CHANGED);
	});

	test('leg 1 — every consumed colour token has a value chosen for dark, under every combination', () => {
		expect(
			findings.untwinned,
			`A colour-valued custom property is declared for light and, under the named combination, the SAME declaration serves dark: the token keeps its light value where the ink over it follows the theme (the 1.09:1 --tool_identify_soft slab, the .menu_mobile_wrapper bug).\n\nFix: declare the dark value where the light one lives — a tool sheet adds its own \`:root[data-theme="dark"] { … }\` beside its \`:root\` (tool_print, tool_identify), or a line in theme_dark.less. NEVER move a tool token into the core palette (css_token_duplication_tripwire forbids it), and never fix a ratio by darkening the brand fill. If the hue is one value on purpose, register it in THEME_INVARIANT with the reason.\n\nUntwinned:\n${list(findings.untwinned)}`,
		).toEqual([]);
	});

	test('leg 2 — no dark-only orphan beyond the banked day-one set', () => {
		const orphanNames = new Set(findings.orphans.map(nameOf));
		const unbanked = findings.orphans.filter((o) => !bankedOrphans.has(nameOf(o)));
		expect(
			unbanked,
			`A custom property has a value under the dark root and NONE under the same combination's light root: light computes it to the empty value, so every rule consuming it drops or paints its fallback literal (tool_assistant paints three different greens for one state).\n\nDeclare the light half on the same sheet's \`:root\`.\n\nOrphans:\n${list(unbanked)}`,
		).toEqual([]);
		// the bank is shrink-only AND stale-proof: an entry that stopped being an orphan is red
		const stale = [...bankedOrphans].filter((t) => !orphanNames.has(t));
		expect(
			stale,
			`DARK_ONLY_ORPHANS lists a token that is no longer dark-only — lower the bank (delete the entry) so the fix cannot silently regress:\n${list(stale)}`,
		).toEqual([]);
	});

	test('leg 3 — no dead colour token beyond the banked day-one set, and the bank is exact', () => {
		const dead = new Set(findings.dead);
		const unbanked = [...dead].filter((t) => !bankedDead.has(t));
		expect(
			unbanked,
			`A colour-valued custom property is declared on a global root and consumed by NO served rule and NO served JS. A twin for it would be a twin for nothing — delete it, or give it the consumer it was declared for.\n\nDead:\n${list(unbanked)}`,
		).toEqual([]);
		const stale = [...bankedDead].filter((t) => !dead.has(t));
		expect(
			stale,
			`DEAD_TOKENS lists a token that is no longer dead (consumed now, or deleted) — lower the bank:\n${list(stale)}`,
		).toEqual([]);
	});

	test('leg 3b — no light-dead colour token beyond the banked day-one set, and the bank is exact', () => {
		const lightDead = new Set(findings.lightDead);
		const unbanked = [...lightDead].filter((t) => !bankedLightDead.has(t));
		expect(
			unbanked,
			`A colour token is declared for LIGHT, yet every rule consuming it is scoped under the dark root: in light the surface those rules paint comes from something else — a literal or an alias the token was meant to replace (\`--debug_info_bar_bg\`, finding C10: light paints @color_grey_4_light and the token never reaches it).\n\nConsume the token unconditionally and drop the dark-scoped duplicate rule.\n\nLight-dead:\n${list(unbanked)}`,
		).toEqual([]);
		const stale = [...bankedLightDead].filter((t) => !lightDead.has(t));
		expect(
			stale,
			`LIGHT_DEAD_TOKENS lists a token that now has a light-reachable consumer — lower the bank:\n${list(stale)}`,
		).toEqual([]);
	});

	test('leg 4 — the cascade is decidable: no cross-sheet conflict, no root palette under an at-rule', () => {
		expect(
			findings.conflicting,
			`Two served sheets (or two root elements) declare the same custom property at the same combination with DIFFERENT values. Tool sheets are injected by load_style() in whatever order the user opens tools, so the winner is runtime state no static reading can know — and this gate's legs 1–3 read a winner. Declare each name once per combination.\n\nConflicts:\n${list(findings.conflicting)}`,
		).toEqual([]);
		expect(
			findings.underAtRule,
			`A colour token is declared on a global root INSIDE a conditional at-rule (\`@media (prefers-color-scheme: …)\`). The palette axis is the \`data-theme\` attribute the client sets; an OS-keyed root palette is outside it and outside this gate. Put the value under the attribute root.\n\nUnder at-rules:\n${list(findings.underAtRule)}`,
		).toEqual([]);
	});

	test('standalone documents carry their own twins (no theme_dark.less reaches them)', () => {
		for (const file of STANDALONE_SHEETS) {
			expect(targets, `${file} is listed as a standalone sheet but is not an entrypoint`).toContain(
				file,
			);
			const own = new Corpus([sheets.find((s) => s.file === file) as Sheet], '');
			const local = analyse(own);
			expect(
				local.untwinned,
				`${file} renders into the PDF.js iframe, where main.css and theme_dark.less do not exist: a colour token it declares for light must have its dark twin IN THIS SHEET.\n\nUntwinned:\n${list(local.untwinned)}`,
			).toEqual([]);
		}
		// Honest: today the two sheets declare no root token, so this leg judges nothing.
		// It is kept so the day one of them grows a `:root { --x: … }` it is judged
		// in the only document that can see it — not as an anti-vacuity claim.
	});

	test('the registers describe the tree (an exemption that outlived its reason is red)', () => {
		for (const e of THEME_INVARIANT) {
			expect(
				e.reason.length,
				`${e.token}: a theme-invariant entry needs a substantive reason`,
			).toBeGreaterThan(40);
			const light = corpus.winner(e.token, []);
			expect(
				light,
				`${e.token} is registered as theme-invariant but is not declared for light (${e.file})`,
			).toBeDefined();
			expect(
				(light as RootDecl).file.endsWith(e.file.split('/').pop() as string) ||
					(light as RootDecl).file === MAIN_LESS,
				`${e.token}: the register names ${e.file}; the served declaration is in ${(light as RootDecl).file}`,
			).toBe(true);
			expect(
				corpus.isConsumed(e.token),
				`${e.token} is registered as theme-invariant but nothing consumes it — it belongs in DEAD_TOKENS (or in the bin), not here`,
			).toBe(true);
			for (const theme of corpus.themeValues()) {
				const paired = corpus.combinations().every((C) => corpus.isPaired(e.token, C, theme));
				expect(
					paired,
					`${e.token} is registered as theme-invariant but now HAS a dark value — the exemption outlived its reason; delete the entry`,
				).toBe(false);
			}
		}
		for (const v of VENDOR_NAMESPACES) {
			expect(
				vendorText.get(v.prefix),
				`${v.lib}/${v.file} (registry lib '${v.lib}') is missing on disk — the ${v.prefix} exemption has nothing to verify against`,
			).not.toBe('');
			const covered = [...vendorNames].filter((n) => n.startsWith(v.prefix));
			expect(
				covered.length,
				`no served token under ${v.prefix} is present in ${v.lib}/${v.file} — stale vendor entry`,
			).toBeGreaterThan(0);
		}
		for (const e of DEAD_TOKENS)
			expect(e.file.length, `${e.token}: a banked dead token names its file`).toBeGreaterThan(10);
		for (const e of DARK_ONLY_ORPHANS)
			expect(e.fix.length, `${e.file}: a banked orphan block states the fix`).toBeGreaterThan(40);
	});

	test('subsumption proof — every family the retired theme_token_parity gate paired is inside this corpus', () => {
		// Not the enforcement (legs 1–2 are); the anti-vacuity of "subsumes": if the
		// four families vanished from the corpus, "generalised" would be a claim.
		const family = corpus
			.colourNames()
			.filter(
				(n) => CARRIED_FAMILIES.some((p) => n.startsWith(p)) && corpus.winner(n, []) !== undefined,
			);
		expect(family.length).toBeGreaterThanOrEqual(MIN_CARRIED_FAMILY_NAMES);
		const untwinnedFamily = findings.untwinned.filter((u) =>
			CARRIED_FAMILIES.some((p) => u.startsWith(p)),
		);
		expect(untwinnedFamily).toEqual([]);
	});

	// -----------------------------------------------------------------------
	// Positive controls: the detector is not vacuous, and the division of
	// labour with the contrast gate is documented by a pair that passes here.
	// -----------------------------------------------------------------------

	const core = (extra = ''): Sheet => ({
		file: MAIN_LESS,
		css: `:root { --canvas: #ffffff; --ink: #222222; --edge: var(--ink); }
		      :root[data-theme="dark"] { --canvas: #1b1d20; --ink: #e5e7ea; }
		      body { color: var(--ink); background: var(--canvas); border-color: var(--edge); }
		      ${extra}`,
	});
	const tool = (css: string): Sheet => ({ file: 'tools/tool_x/css/tool_x.less', css });

	test('control — a planted light-only surface token is caught (leg 1)', () => {
		const f = analyse(
			new Corpus(
				[
					core(),
					tool(':root { --tool_x_soft: #eaf2f4 } .x_panel { background: var(--tool_x_soft) }'),
				],
				'',
			),
		);
		expect(f.untwinned.map(nameOf)).toEqual(['--tool_x_soft']);
	});

	test('control — a planted COPIED twin passes here (the contrast gate, not this one, reads its legibility)', () => {
		const f = analyse(
			new Corpus(
				[
					core(),
					tool(
						':root { --tool_x_soft: #eaf2f4 } :root[data-theme="dark"] { --tool_x_soft: #eaf2f4 } .x_panel { background: var(--tool_x_soft) }',
					),
				],
				'',
			),
		);
		expect(f.untwinned).toEqual([]);
	});

	test('control — pairing by inheritance: a var() chain is paired iff its referent is', () => {
		const paired = analyse(
			new Corpus([core(), tool(':root { --tool_x: var(--ink) } .x { color: var(--tool_x) }')], ''),
		);
		expect(paired.untwinned).toEqual([]);
		const unpaired = analyse(
			new Corpus(
				[
					core(':root { --fixed: #777777 }'),
					tool(':root { --tool_x: var(--fixed) } .x { color: var(--tool_x) }'),
				],
				'',
			),
		);
		expect(unpaired.untwinned.map(nameOf).sort()).toEqual(['--fixed', '--tool_x']);
	});

	test('control — a dark-only token is an orphan (leg 2); a dead token and a light-dead token are caught (leg 3)', () => {
		const f = analyse(
			new Corpus(
				[
					core(
						':root { --only_dark_reads_me: #ff00ff; --nobody_reads_me: #00ff00 } :root[data-theme="dark"] .x { color: var(--only_dark_reads_me) }',
					),
					tool(
						':root[data-theme="dark"] { --tool_x_bg: #101010 } .x { background: var(--tool_x_bg, #fafafa) }',
					),
				],
				'',
			),
		);
		expect(f.orphans.map(nameOf)).toEqual(['--tool_x_bg']);
		expect(f.dead).toEqual(['--nobody_reads_me']);
		expect(f.lightDead).toEqual(['--only_dark_reads_me']);
		// a JS reader is a consumer
		const js = analyse(
			new Corpus([core(':root { --nobody_reads_me: #00ff00 }')], "ui.css_var('--nobody_reads_me')"),
		);
		expect(js.dead).toEqual([]);
	});

	test('control — the model refuses what it cannot decide (leg 4) and sees :not() and light-dark()', () => {
		const conflict = analyse(
			new Corpus([core(), tool(':root { --ink: #000000 } .x { color: var(--ink) }')], ''),
		);
		expect(conflict.conflicting.length).toBe(1);
		const media = analyse(
			new Corpus([core('@media (prefers-color-scheme: dark) { :root { --canvas: #000000 } }')], ''),
		);
		expect(media.underAtRule.length).toBe(1);
		// a light-only declaration through :not() is still a declaration with no dark value
		const notOnly = analyse(
			new Corpus(
				[
					core(
						':root:not([data-theme="dark"]) { --ring: #0000ff } .x { outline-color: var(--ring) }',
					),
				],
				'',
			),
		);
		expect(notOnly.untwinned.map(nameOf)).toEqual(['--ring']);
		const notPaired = analyse(
			new Corpus(
				[
					core(
						':root:not([data-theme="dark"]) { --ring: #0000ff } :root[data-theme="dark"] { --ring: #8888ff } .x { outline-color: var(--ring) }',
					),
				],
				'',
			),
		);
		expect(notPaired.untwinned).toEqual([]);
		const ld = analyse(
			new Corpus(
				[core(':root { --pair: light-dark(#ffffff, #000000) } .x { color: var(--pair) }')],
				'',
			),
		);
		expect(ld.untwinned).toEqual([]);
	});
});
