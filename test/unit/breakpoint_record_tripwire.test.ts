/**
 * BREAKPOINT RECORD tripwire (DEC-12; CSS coherence audit 2026-09, clause 2.e —
 * findings M5 "nine `@media` literals bypass the scale / `@width_break_point_2` is
 * dead", M6 "five empty `@media` blocks + a duplicate condition", T1 "the absent
 * gate, not the compiler, is why literals appear").
 *
 * WHAT WAS WRONG. The responsive scale was never a record. Four aliases sat in
 * `layout/vars.less` with no statement of what any tier was FOR, no gate, and a
 * docs line (`css-architecture.md:126`, `:350` — now `docs/core/ui/css_architecture.md`) that said "do not re-declare
 * breakpoints in component files" and enforced nothing. The two costs an unstated
 * record always charges both landed:
 *
 *   - NINE `@media` conditions wrote the number instead of the meaning — 1280,
 *     1100, 1024 ×3, 960, 520, `48rem`, `min-width: 2000` — across six sheets. Two
 *     of those sheets (`tool_sitebuilder`) import no vars at all, so the scale was
 *     not even in scope; one (`tool_import_dedalo_csv`) used the ALIAS three times
 *     and the literal once, in the same file. Nothing a user saw was wrong: every
 *     1024/960 literal happened to still coincide with its tier. That is precisely
 *     the failure mode a gate exists for — the day a tier moves, the literals stay
 *     put and the layout tears silently at one width.
 *   - `@width_break_point_2` (780px, "images minimum width") was declared at
 *     inception and referenced by ZERO rules for three years. The scale ADVERTISED
 *     four tiers and had three. A tier nobody uses is a lie in the record: the next
 *     author reads it as a supported width and writes a rule against a number the
 *     rest of the app has never branched on.
 *
 * And five `@media` blocks compiled to nothing at all (bodies commented out), one
 * of them the sole use of the hardcoded 1280px, plus two byte-identical
 * `@media` blocks in a row in `search.less` so the first could never apply.
 *
 * WHAT THIS ASSERTS — two instruments over two corpora, because neither alone is
 * honest (see "WHY BOTH" below):
 *
 *   1. SOURCE: no `@media` condition in the built `.less` corpus contains a raw
 *      length, every LESS variable a condition names is declared in THE record
 *      file, and no `.less` outside the record re-declares a record name (LESS is
 *      last-declaration-wins, so a component sheet writing
 *      `@width_break_point_0: 800px` after its `@import './vars'` silently moves
 *      the tier for that sheet while every condition still spells the record's
 *      name — an adversarial pass landed exactly that, green, before this leg).
 *   2. COMPILED: every width/height threshold in every `@media` condition of every
 *      SERVED sheet (all 43 entrypoints, compiled in memory by the real build
 *      pipeline) is a record value, or a record value + 1 (the `min-width`
 *      complement of a `max-width` tier, a real idiom at 2 sites). This is the
 *      outcome: whatever the source spelling — literal, interpolated
 *      `@{name}`, `unit(1024, px)`, `(@tier - 64)`, a shadowed name, a literal
 *      hidden behind a `url(http://…)` on the same line — the number that ships
 *      is judged against the record.
 *   3. Every tier the record declares is BRANCHED ON by at least one `@media`
 *      condition — the dead-`_2` check. A tier is a threshold; one that is only
 *      ever used as a plain width value (`.x { width: @tier }`) has still never
 *      been branched on and is dead by this gate's definition.
 *   4. The record's FLOOR (`@min_target_viewport`, the narrowest viewport the
 *      layout is intended to survive) is never used as a THRESHOLD. It is the
 *      number "does this work on a phone?" gets answered against, not a width to
 *      branch on, and a rule that branches on it would quietly redefine it.
 *   5. No `@media` block is empty after evaluation — every one contributes at
 *      least one emitted declaration to the CSS that ships. Variable declarations,
 *      detached rulesets and mixin DEFINITIONS inside the block do not count: all
 *      three sit in the evaluated tree as declarations and emit nothing.
 *
 * THE RECORD IS HARVESTED BY SHAPE, NOT BY NAME. `layout/vars.less` is 91 `@name:`
 * lines, 85 of them `var(--color_*)` aliases; the breakpoint record is exactly the
 * lines whose value is a bare LENGTH. So this gate reads "every length-valued
 * variable declared in the record file", never `@width_break_point_\d+`. Rename
 * every tier tomorrow and the gate still finds them, still counts their uses, and
 * still refuses a literal — which is the point: two of this project's own
 * tripwires were defeated by a rename, and a regex over the current prefix would
 * be a third. The compiled leg is name-blind by construction.
 *
 * WHY BOTH. LESS substitutes the variable during compilation, so
 * `@media (max-width: @width_break_point_0)` and `@media (max-width: 1024px)` are
 * the SAME bytes in `main.css`. The compiled leg therefore cannot tell a literal
 * that COINCIDES with a tier from the tier itself — the exact state the tree was
 * in for three years, where 1024 ×3 and 960 ×1 were literals nobody could see —
 * and it can never see the dead tier. Only the source leg can. But the source
 * leg is a scanner over LESS text, and a scanner models a finite set of
 * constructs: an adversarial pass (2026-09-06) defeated the first version of it
 * six different ways — a shadowing re-declaration, `@{name}` interpolation,
 * `(@tier - 64)` and `(@tier * 0.8)`, `unit(1024, px)` behind nested parens, and
 * a literal on the same line as a `url(http://…)` — every one of which compiled
 * to a served threshold outside the record with the gate green. Each is now
 * refused at source AND the compiled leg is the net under the scanner: a
 * construct the scanner does not model still has to produce a number, and the
 * number is judged. The same pass also greened the empty-block visitor with a
 * variable-only and a mixin-definition-only body, and the liveness check with a
 * tier used only as a plain width value; both are closed and both have a
 * positive control below. Assertion 5, by contrast, can ONLY be compiled — an
 * empty block leaves no trace in the bytes (LESS drops it), so the post-evaluation
 * AST is the only place that outcome is visible at all.
 *
 * THE CORPUS IS THE BUILD'S OWN. `allLessFiles()` and `entrypoints()` are imported
 * from `scripts/build_css.ts`: the set this gate judges is by construction the set
 * the build compiles and the client serves. A gate with its own glob drifts from
 * the tool the day a directory moves.
 *
 * DOES NOT PROVE.
 *   - That any tier DOES anything. A referenced tier may gate a rule that changes
 *     nothing visible; a phone tier may exist with no phone layout behind it (it
 *     does — `vars.less` says so in its own words). Only the viewport-matrix
 *     browser gate (clause 2.g) can judge a rendered width; this one judges the
 *     record's integrity.
 *   - That a served threshold which EQUALS a record value came from the record.
 *     The compiled leg accepts 1024px however it was written; only the source
 *     leg refuses the literal spelling, and the source leg is a scanner. A
 *     construct that both evades the scanner AND lands exactly on a record value
 *     (a shadowing declaration with the SAME value; arithmetic that happens to
 *     equal a tier) is green here. The shadow check closes the first; the second
 *     is refused at source by the "only a bare `1` beside a record variable"
 *     rule, but a maintainer who invents a fresh evasion that hits a tier exactly
 *     has produced drift this gate cannot distinguish from correctness.
 *   - Anything about the JS half of the scale. Five JS sites compare against
 *     `innerWidth`/`matchMedia` with hand-copied numbers (1024, 960, 800 ×3 — one
 *     under a comment claiming it "must match `@width_break_point_0`", over a value
 *     that matches no tier). Clause 2.e leg 3 covers them and is not implemented
 *     here.
 *   - Anything about a `.less` the build cannot see. The corpus is
 *     `allLessFiles()`, which skips `/lib/`, `vendor/` and `node_modules` —
 *     vendored sheets are not ours to gate. It is also blind to CSS injected from
 *     JS (`dd-modal`'s shadow sheet is a string literal in `dd-modal.js`), to
 *     `@import (css)` passthroughs, and to `@supports`/`@container` conditions.
 *   - That a partial nobody imports is clean. The compiled leg and assertion 5
 *     reach only what an entrypoint reaches; the source leg reads every `.less`.
 *   - That the record's VALUES are right. 600px for the phone tier and 360px for
 *     the floor are design decisions; nothing here judges a number, only that
 *     every number lives in one place and every place is alive.
 *   - That an `@media` block DOES something. Assertion 5 asks whether it emits a
 *     declaration, not whether that declaration changes anything (a rule that
 *     restates its parent's value passes).
 *   - That non-`@media` dead code is gone. 139 empty NON-media rulesets remain in
 *     the tree (audit M6); assertion 5 is scoped to `@media` because that is what
 *     clause 2.e claims. Widening it is a separate, larger deletion.
 *
 * COST: 190 file reads + 43 in-memory LESS compiles (~0.4 s), each compile
 * serving both the compiled leg and the empty-block visitor. DB-less,
 * network-less → hermetic tier.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import less from 'less';
import { allLessFiles, entrypoints } from '../../scripts/build_css.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..');

/**
 * THE record. Its location is pinned on purpose: "one record" is the invariant, so
 * a second file declaring tiers must be a deliberate edit here — and if the record
 * moves without this line moving, the harvest comes back empty and the anti-vacuity
 * floor below turns the gate red rather than green.
 */
const RECORD_FILE = 'client/dedalo/core/page/css/layout/vars.less';

/**
 * FLOORS — measured on this tree 2026-09-06. Every one sits AT the corpus, not far
 * under it: a refactor that stops the parser seeing conditions (a comment-stripping
 * bug, a moved directory, an `@media` written through interpolation) would
 * otherwise green this gate by judging nothing.
 */
/** `allLessFiles()` returned 190. */
const MIN_LESS_FILES = 185;
/** `entrypoints()` returned 43. */
const MIN_ENTRYPOINTS = 40;
/** 122 `@media` conditions parsed out of the source corpus. */
const MIN_MEDIA_CONDITIONS = 115;
/** 110 of those name a record variable (the rest are print / prefers-* / pointer). */
const MIN_RECORD_BOUND_CONDITIONS = 105;
/** The record holds 6 length-valued entries: 5 tiers + 1 floor. */
const MIN_RECORD_ENTRIES = 6;
/** 188 `@media` conditions in the 43 COMPILED sheets (partials multiply through their importers). */
const MIN_COMPILED_MEDIA_CONDITIONS = 180;
/** 176 width/height threshold tokens across those compiled conditions. */
const MIN_COMPILED_THRESHOLDS = 170;

/**
 * Record entries that are FLOORS, not tiers: a number the layout is measured
 * AGAINST, which no `@media` may branch on. Banked by name because "floor" is not
 * derivable from the declaration's shape — both a tier and a floor are a length.
 * Rename one and this entry stops matching, which reds the gate and forces the
 * bank to be re-stated: fail-safe in the direction that matters.
 */
const FLOOR_ENTRIES: ReadonlyArray<{ name: string; reason: string }> = [
	{
		name: 'min_target_viewport',
		reason:
			'360px — the narrowest viewport the layout is INTENDED to survive. It exists so "does the app work on a phone?" has a number to be answered against (today the honest answer is no); the viewport-matrix gate renders at it. A `@media` referencing it would silently turn the floor into a fourth small tier.',
	},
];

/**
 * EMPTY `@media` blocks still in the tree, banked per file, SHRINK-ONLY. The audit
 * found five; `layout.less:557` (the sole use of the hardcoded 1280px) is deleted,
 * these four are not — they are `@media` wrappers whose entire body is `//`
 * comments, so they compile to nothing and have never applied.
 *
 * The bank is a COUNT per file, not a line number, so an unrelated edit above one
 * of them does not red this gate. It is exact in both directions: one more empty
 * block anywhere is red, and DELETING one is red too until the count here is
 * lowered — a stale bank hides the progress and lets it come back.
 *
 * These files are owned by another pass; the sites are named in the report that
 * lands with this gate. The fix is deletion, not a smaller number here.
 */
const EMPTY_MEDIA_BANK: ReadonlyArray<{ file: string; count: number; reason: string }> = [
	{
		file: 'client/dedalo/core/menu/css/menu.less',
		count: 3,
		reason:
			'menu.less:48, :620, :665 — three `max-width: @width_break_point_3` wrappers whose bodies are entirely commented out (a `--menu_heigth` override, a line-height, a height). All three blame to d31bad80c1 and have emitted nothing since. Delete the wrappers.',
	},
];

// ---------------------------------------------------------------------------
// Source reading
// ---------------------------------------------------------------------------

/**
 * Strip LESS comments before any source scan. Both forms matter here: the audit's
 * own censuses over-counted because `@media` appears inside prose (this tree
 * documents its breakpoints in comments, at length), and a commented-out
 * `@media (max-width: 1280px)` is not a threshold — it is a note.
 *
 * A `//` is a comment only at a COMMENT POSITION — start of line, or after
 * whitespace / `;` / `{` / `}`. The first version stripped every `//` to end of
 * line, and `url(http://x.png) @media (max-width: 1024px) { … }` on one line
 * therefore hid a raw literal from the scan (the `//` of the scheme ate the rest
 * of the line). `://` and `(//cdn/…` are no longer comment starts.
 */
const stripComments = (src: string): string =>
	src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[\s;{}])\/\/[^\n]*/g, '$1 ');

/**
 * `@{name}` → `@name`. LESS interpolation is a legal way to reference a variable
 * inside an `@media` condition, and the first version of this scanner did not see
 * through it: `@zz_bp: 800px; @media (max-width: @{zz_bp})` compiled to a private
 * 800px threshold with the gate green. Interpolating a RECORD variable is a
 * reference like any other and stays legal; interpolating a private one is judged
 * as the stray it is.
 */
const deinterpolate = (src: string): string => src.replace(/@\{([a-zA-Z][\w-]*)\}/g, '@$1');

type MediaCondition = { file: string; line: number; text: string };

/**
 * Every `@media` condition in a source: the text between `@media` and its opening
 * brace, whitespace-normalised. Normalisation is what makes the raw-length check
 * formatting-blind — `@media screen and ( max-width : 1024px )` written across two
 * lines reads the same as the one-line form.
 */
const mediaConditions = (file: string, rawSrc: string): MediaCondition[] => {
	const src = deinterpolate(stripComments(rawSrc));
	const out: MediaCondition[] = [];
	for (const match of src.matchAll(/@media\b([^{;]*)\{/g)) {
		out.push({
			file,
			line: src.slice(0, match.index).split('\n').length,
			text: (match[1] ?? '').replace(/\s+/g, ' ').trim(),
		});
	}
	return out;
};

/** LESS variable names a condition references (`@width_break_point_0` → `width_break_point_0`). */
const variablesIn = (condition: string): string[] =>
	[...condition.matchAll(/@([a-zA-Z][\w-]*)/g)].map((m) => m[1] as string);

/** Every `@name: value;` declaration in a LESS source (comments already stripped). */
const declarationsIn = (src: string): Array<{ name: string; value: string }> =>
	[...src.matchAll(/@([a-zA-Z][\w-]*)\s*:\s*([^;{}]+);/g)].map((m) => ({
		name: m[1] as string,
		value: (m[2] as string).trim(),
	}));

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

/** A bare CSS length: a number carrying a length unit, and nothing else. */
const BARE_LENGTH = /^-?(?:\d+\.?\d*|\.\d+)(px|rem|em|ex|ch|vw|vh|vmin|vmax|cm|mm|q|in|pt|pc)$/i;

/**
 * The record: every LESS variable in the record file whose value is a bare length.
 * Harvested BY SHAPE — the file's other 85 declarations are `var(--color_*)`
 * aliases, so "the length-valued ones" IS the breakpoint block, under any names
 * those tiers are ever given.
 */
const harvestRecordFrom = (src: string): Map<string, string> => {
	const record = new Map<string, string>();
	for (const { name, value } of declarationsIn(stripComments(src))) {
		if (BARE_LENGTH.test(value)) record.set(name, value);
	}
	return record;
};
const harvestRecord = (): Map<string, string> =>
	harvestRecordFrom(readFileSync(join(REPO_ROOT, RECORD_FILE), 'utf8'));

/** `1024.0PX` → `1024px`, so a served token and a record value compare as numbers. */
const normaliseLength = (token: string): string => {
	const m = /^(-?(?:\d+\.?\d*|\.\d+))([a-z%]*)$/i.exec(token);
	if (!m) return token;
	return `${Number(m[1])}${(m[2] as string).toLowerCase()}`;
};

/**
 * The values a SERVED threshold may take: every record value, plus each value + 1
 * in its own unit — the `min-width: (@tier + 1)` complement of a `max-width` tier.
 */
const allowedServedValues = (rec: Map<string, string>): Set<string> => {
	const out = new Set<string>();
	for (const value of rec.values()) {
		const m = /^(-?(?:\d+\.?\d*|\.\d+))([a-z]+)$/i.exec(value);
		if (!m) continue;
		const unit = (m[2] as string).toLowerCase();
		out.add(`${Number(m[1])}${unit}`);
		out.add(`${Number(m[1]) + 1}${unit}`);
	}
	return out;
};

// ---------------------------------------------------------------------------
// Thresholds in a condition
// ---------------------------------------------------------------------------

/** A number carrying a length unit, anywhere inside a condition. */
const LENGTH_LITERAL =
	/(?<![\w.@-])(?:\d+\.?\d*|\.\d+)(?:px|rem|em|ex|ch|vw|vh|vmin|vmax|cm|mm|q|in|pt|pc)\b/gi;
/** Any number, with whatever unit it carries (or none). */
const ANY_NUMBER = /(?<![\w.@-])(?:\d+\.?\d*|\.\d+)(?:[a-z%]+)?/gi;

/**
 * The TOP-LEVEL parenthesised feature groups of a condition, by balanced-paren
 * walk rather than regex: `(max-width: unit(1024, px))` is ONE group holding a
 * nested call. The first version used `\(([^()]*)\)`, which matched only the
 * innermost `(1024, px)` — a group that names no width — and let the threshold
 * through.
 */
const featureGroups = (condition: string): string[] => {
	const groups: string[] = [];
	let depth = 0;
	let start = -1;
	for (let i = 0; i < condition.length; i++) {
		const ch = condition[i];
		if (ch === '(') {
			if (depth === 0) start = i + 1;
			depth++;
		} else if (ch === ')') {
			depth--;
			if (depth === 0 && start >= 0) groups.push(condition.slice(start, i));
		}
	}
	return groups;
};

/**
 * The threshold tokens of one `@media` condition — every number that acts as a
 * width or height, plus every length literal wherever it sits.
 *
 *   a. any length-unit literal, anywhere in the condition. This is what catches
 *      the eight historical width literals AND the (since removed) browser
 *      installer's `48rem` — the trap the record now documents, since inside an `@media` condition `rem`
 *      resolves against the BROWSER's 16px, not this app's 13px root, so `48rem`
 *      silently meant ~768px rather than the ~624px its author computed.
 *   b. inside a top-level feature group that mentions width or height, every
 *      number — unitless too (`(max-width: 0)`, the range form `(width >= 600)`),
 *      nested too (`unit(1024, px)`), and with LESS variable names removed first
 *      so `@width_break_point_0` does not read as a `0`.
 *
 * ONE exemption, and it is narrow on purpose: in SOURCE, a bare `1` in a group
 * that names a LESS variable — `(@width_break_point_0 + 1)`, the `min-width`
 * complement of a `max-width` tier. Any other operand is refused: `(@tier - 64)`
 * and `(@tier * 0.8)` are private thresholds wearing arithmetic (both compiled
 * green under the first version, which exempted the whole group), and
 * `@tier + 20px` is a raw length wearing an expression. In COMPILED text there is
 * no variable left to stand beside, so nothing is exempt there.
 */
const thresholdTokens = (condition: string): string[] => {
	const hits = new Set<string>(condition.match(LENGTH_LITERAL) ?? []);
	for (const group of featureGroups(condition)) {
		if (!/width|height/i.test(group)) continue;
		const namesVariable = /@[a-zA-Z]/.test(group);
		const body = group.replace(/@[a-zA-Z][\w-]*/g, ' ');
		for (const token of body.match(ANY_NUMBER) ?? []) {
			if (namesVariable && token === '1') continue;
			hits.add(token);
		}
	}
	return [...hits];
};

// ---------------------------------------------------------------------------
// Compiling: the served bytes and the empty blocks, from one render each
// ---------------------------------------------------------------------------

type EmptyMedia = { file: string; line: number; condition: string };

/**
 * A LESS plugin whose visitor runs AFTER evaluation and BEFORE `ToCSSVisitor`
 * (`isPreVisitor`), which is the only window where the question is answerable:
 * mixins are expanded and variables substituted, but the empty-node sweep that
 * would erase the evidence has not run. A block is empty when its whole evaluated
 * subtree holds zero EMITTING declarations.
 *
 * Three evaluated nodes look like content and emit nothing, and the first version
 * of this visitor counted all three as content: a variable declaration
 * (`@zz: 0;` — a `Declaration` with `variable: true`), a detached ruleset
 * (`@dr: { … }` — the same, its value a `DetachedRuleset`), and a mixin
 * DEFINITION (`.m() { color: red }` — a `MixinDefinition` whose `rules` hold real
 * `Declaration`s that ship only where the mixin is CALLED). All three are skipped.
 *
 * A source brace-walk would be the cheap proxy and it is wrong in a knowable way:
 * `@media x { .a {} }` and `@media x { .mixin_that_expands_to_nothing(); }` are
 * both non-empty in source and both emit nothing.
 */
const emptyMediaPlugin = (sink: EmptyMedia[]) => ({
	install(lessLib: typeof less, pluginManager: { addVisitor: (v: unknown) => void }) {
		const api = lessLib as unknown as {
			visitors: { Visitor: new (impl: unknown) => { visit: (n: unknown) => unknown } };
		};
		class EmptyMediaVisitor {
			readonly isReplacing = false;
			readonly isPreEvalVisitor = false;
			/** run before ToCSSVisitor strips empty nodes — see the note above. */
			readonly isPreVisitor = true;
			private readonly native = new api.visitors.Visitor(this);
			run(root: unknown) {
				return this.native.visit(root);
			}
			// biome-ignore lint/suspicious/noExplicitAny: the LESS AST is untyped.
			visitMedia(node: any) {
				let declarations = 0;
				// biome-ignore lint/suspicious/noExplicitAny: the LESS AST is untyped.
				const walk = (n: any): void => {
					if (!n || typeof n !== 'object') return;
					if (n.type === 'MixinDefinition') return; // ships only where called
					if (n.type === 'Declaration') {
						if (n.variable !== true) declarations++; // `@x: …` emits nothing
						return;
					}
					const children = n.rules ?? n.ruleset?.rules ?? n.value?.rules;
					if (Array.isArray(children)) for (const child of children) walk(child);
				};
				walk(node);
				if (declarations === 0) {
					const filename: string = node.fileInfo?.().filename ?? node._fileInfo?.filename ?? '?';
					const source = (() => {
						try {
							return readFileSync(filename, 'utf8');
						} catch {
							return '';
						}
					})();
					const index: number = node.getIndex?.() ?? node._index ?? 0;
					sink.push({
						file: filename.startsWith(`${REPO_ROOT}/`)
							? filename.slice(REPO_ROOT.length + 1)
							: filename,
						line: source === '' ? 0 : source.slice(0, index).split('\n').length,
						condition: String(node.features?.toCSS?.({}) ?? '').trim(),
					});
				}
				return node;
			}
		}
		pluginManager.addVisitor(new EmptyMediaVisitor());
	},
});

type Compiled = { css: string; empties: EmptyMedia[] };

/** Compile one LESS source through the empty-media visitor and keep the CSS. Options
 *  mirror `buildOne()` minus the source map, which nothing here reads. */
const compileOne = async (source: string, filename: string): Promise<Compiled> => {
	const empties: EmptyMedia[] = [];
	// `plugins` is absent from less's option typings, and the untyped call resolves
	// to the callback overload (`void`) — so both sides are cast, once, here.
	const options = {
		filename,
		paths: [dirname(filename)],
		plugins: [emptyMediaPlugin(empties)],
	} as unknown as Less.Options;
	const result = (await less.render(source, options)) as unknown as { css: string };
	return { css: result.css, empties };
};

/** Every entrypoint compiled once: its served `@media` conditions (block comments
 *  stripped — a compiled sheet keeps `/* … *\/` prose, and one tool's mentions
 *  `@media print` in a docblock) and its empty `@media` blocks, the latter
 *  deduplicated by site — a partial imported by 36 tool sheets would otherwise be
 *  counted 36 times. */
const compileBuild = async (): Promise<{
	served: MediaCondition[];
	empties: EmptyMedia[];
}> => {
	const seen = new Map<string, EmptyMedia>();
	const served: MediaCondition[] = [];
	for (const entry of entrypoints()) {
		const filename = join(REPO_ROOT, entry);
		const { css, empties } = await compileOne(readFileSync(filename, 'utf8'), filename);
		served.push(...mediaConditions(entry, css));
		for (const hit of empties) seen.set(`${hit.file}:${hit.line}`, hit);
	}
	return {
		served,
		empties: [...seen.values()].sort((a, b) =>
			`${a.file}:${a.line}`.localeCompare(`${b.file}:${b.line}`),
		),
	};
};

// ---------------------------------------------------------------------------
// Liveness
// ---------------------------------------------------------------------------

/**
 * Record entries no `@media` condition branches on. Floors are excluded here and
 * judged by their own test (they MUST have zero). Counted over conditions, not over
 * raw text: `.x { width: @tier }` is a use, but not a branch, and a tier the app
 * has never branched on is exactly the lie the dead-`_2` finding describes.
 */
const deadTiers = (
	rec: Map<string, string>,
	conds: MediaCondition[],
	floors: Set<string>,
): string[] => {
	const branched = new Set(conds.flatMap((c) => variablesIn(c.text)));
	return [...rec]
		.filter(([name]) => !floors.has(name) && !branched.has(name))
		.map(([name, value]) => `@${name} (${value})`)
		.sort();
};

// ---------------------------------------------------------------------------

const lessFiles = allLessFiles();
const sources = new Map(lessFiles.map((f) => [f, readFileSync(join(REPO_ROOT, f), 'utf8')]));
const conditions = lessFiles.flatMap((file) => mediaConditions(file, sources.get(file) as string));
const record = harvestRecord();
const floorNames = new Set(FLOOR_ENTRIES.map((f) => f.name));
const compiled = await compileBuild();

describe('breakpoint_record_tripwire', () => {
	test('the corpus is the build’s own and is not empty (a zero-length pass is not a pass)', () => {
		expect(lessFiles.length).toBeGreaterThanOrEqual(MIN_LESS_FILES);
		expect(entrypoints().length).toBeGreaterThanOrEqual(MIN_ENTRYPOINTS);
		expect(conditions.length).toBeGreaterThanOrEqual(MIN_MEDIA_CONDITIONS);
		expect(record.size).toBeGreaterThanOrEqual(MIN_RECORD_ENTRIES);
		// and the record is actually WIRED: most conditions must resolve through it.
		const bound = conditions.filter((c) => variablesIn(c.text).some((v) => record.has(v)));
		expect(bound.length).toBeGreaterThanOrEqual(MIN_RECORD_BOUND_CONDITIONS);
		// the compiled corpus too — a build that stopped emitting `@media` would
		// otherwise pass the compiled leg with nothing to judge.
		expect(compiled.served.length).toBeGreaterThanOrEqual(MIN_COMPILED_MEDIA_CONDITIONS);
		const servedThresholds = compiled.served.flatMap((c) => thresholdTokens(c.text));
		expect(servedThresholds.length).toBeGreaterThanOrEqual(MIN_COMPILED_THRESHOLDS);
	});

	test('no @media condition contains a raw length (source)', () => {
		const offenders = conditions
			.map((c) => ({ c, hits: thresholdTokens(c.text) }))
			.filter((x) => x.hits.length > 0)
			.map(
				(x) =>
					`${x.c.file}:${x.c.line} — ${x.hits.join(', ')} in \`@media${x.c.text ? ` ${x.c.text}` : ''}\``,
			);
		expect(
			offenders.sort().join('\n'),
			`A raw length in an \`@media\` condition is drift: it says nothing about which layout mode it belongs to, and the next author copies the number instead of the meaning. Nine sites bypassed the scale before 2026-09-05 and that is exactly how it drifted. Use a tier from ${RECORD_FILE}; if none fits, DECLARE one there with a comment saying what it is for. The only arithmetic allowed on a tier is \`+ 1\` (the min-width complement).\n\nOffenders:`,
		).toBe('');
	});

	test('every variable a @media condition names is declared in THE record', () => {
		const strays = new Set<string>();
		for (const condition of conditions) {
			for (const name of variablesIn(condition.text)) {
				if (!record.has(name)) strays.add(`${condition.file}:${condition.line} — @${name}`);
			}
		}
		expect(
			[...strays].sort().join('\n'),
			`A \`@media\` branched on a length declared outside ${RECORD_FILE}. A private tier is the same defect as a literal wearing a name: the record stops being the record. Move the declaration into the record file with a comment saying what the tier is for.\n\nStrays:`,
		).toBe('');
	});

	test('no .less outside the record re-declares a record name (LESS is last-declaration-wins)', () => {
		const shadows: string[] = [];
		for (const file of lessFiles) {
			if (file === RECORD_FILE) continue;
			const src = stripComments(sources.get(file) as string);
			for (const { name, value } of declarationsIn(src)) {
				if (record.has(name)) shadows.push(`${file} — @${name}: ${value}`);
			}
		}
		expect(
			shadows.sort().join('\n'),
			`A record name is re-declared outside ${RECORD_FILE}. LESS resolves a variable to its LAST declaration in scope, so a sheet that writes \`@tier: 800px\` after its \`@import './vars'\` moves the tier for that sheet while every condition still spells the record's name — the record stops being the record and nothing in the source says so. Delete the re-declaration; if the sheet needs a different width, that is a new tier, declared in the record with a reason.\n\nShadowing declarations:`,
		).toBe('');
	});

	test('every threshold the SERVED sheets branch on is a record value (or its +1 complement)', () => {
		const allowed = allowedServedValues(record);
		const offenders: string[] = [];
		for (const c of compiled.served) {
			const outside = thresholdTokens(c.text)
				.map(normaliseLength)
				.filter((t) => !allowed.has(t));
			if (outside.length > 0) {
				offenders.push(`${c.file} — ${outside.join(', ')} in \`@media ${c.text}\``);
			}
		}
		expect(
			[...new Set(offenders)].sort().join('\n'),
			`A compiled sheet branches on a width that is not in ${RECORD_FILE}. This is the outcome the source checks exist to prevent, judged on the bytes the client serves: however the number was written — literal, interpolated, shadowed, computed, hidden from the scanner — it shipped, and it is not a tier. Allowed today: ${[...allowed].sort().join(', ')}.\n\nServed off-record thresholds:`,
		).toBe('');
	});

	test('every tier the record declares is branched on by at least one @media condition', () => {
		expect(
			deadTiers(record, conditions, floorNames).join(', '),
			'A tier nobody branches on is a LIE in the record: it advertises a supported width the app has never switched layout at. `@width_break_point_2` (780px) was declared at inception and referenced by zero rules for three years — the scale said four tiers and had three. Either write the `@media` rules the tier promises, delete it, or move it into FLOOR_ENTRIES with a reason if it is a measurement target rather than a threshold. (A use as a plain width value — `.x { width: @tier }` — is not a branch and does not count.)\n\nDeclared-but-never-branched-on:',
		).toBe('');
	});

	test('the record’s floors are floors: no @media branches on one', () => {
		const misuse: string[] = [];
		for (const condition of conditions) {
			for (const name of variablesIn(condition.text)) {
				if (floorNames.has(name)) misuse.push(`${condition.file}:${condition.line} — @${name}`);
			}
		}
		expect(
			misuse.sort().join('\n'),
			'A floor is the width the layout is MEASURED at, not one it branches on. Branching on it silently redefines it into a tier and leaves the app with no stated minimum again.\n\nMisused as a threshold:',
		).toBe('');
	});

	test('every floor the bank names is still declared in the record', () => {
		const missing = FLOOR_ENTRIES.filter((f) => !record.has(f.name)).map((f) => `@${f.name}`);
		expect(
			missing.join(', '),
			`A banked floor is gone from ${RECORD_FILE} — renamed, moved, or deleted. Re-state FLOOR_ENTRIES against the record as it now reads; leaving a stale name here silently exempts nothing and, worse, would let a renamed floor be used as a tier.\n\nMissing:`,
		).toBe('');
	});

	test('no @media block compiles to nothing, beyond the banked shrink-only sites', () => {
		const counted = new Map<string, EmptyMedia[]>();
		for (const hit of compiled.empties) {
			const list = counted.get(hit.file) ?? [];
			list.push(hit);
			counted.set(hit.file, list);
		}
		const banked = new Map(EMPTY_MEDIA_BANK.map((e) => [e.file, e.count]));

		const grown: string[] = [];
		for (const [file, hits] of counted) {
			const allowed = banked.get(file) ?? 0;
			if (hits.length > allowed) {
				grown.push(
					`${file}: ${hits.length} empty @media, ${allowed} banked — ${hits.map((h) => `:${h.line} (${h.condition})`).join(', ')}`,
				);
			}
		}
		expect(
			grown.sort().join('\n'),
			'An `@media` block whose evaluated body holds no emitting declaration compiles to NOTHING: it is a threshold the app appears to honour and does not. Five shipped that way, one of them the only use of a hardcoded 1280px. Delete the block (or give it the rules it promises). Variable declarations, detached rulesets and mixin definitions inside it do not count — they emit nothing.\n\nUnbanked empty blocks:',
		).toBe('');

		const stale: string[] = [];
		for (const entry of EMPTY_MEDIA_BANK) {
			const found = counted.get(entry.file)?.length ?? 0;
			if (found < entry.count) stale.push(`${entry.file}: ${found} left, ${entry.count} banked`);
		}
		expect(
			stale.sort().join('\n'),
			'The bank is SHRINK-ONLY and it is stale: fewer empty blocks remain than it excuses. Lower the count (or delete the entry) — a bank left high hides the progress and lets the block come back green.\n\nStale bank entries:',
		).toBe('');
	});

	// -----------------------------------------------------------------------
	// Positive controls. Each detector is shown to fire on the exact historical
	// defect — and on each construct the adversarial pass used to slip past the
	// first version — and to stay silent on the exact idiom that must survive.
	// -----------------------------------------------------------------------

	test('the threshold detector fires on every literal the audit found', () => {
		const historical = [
			'screen and (max-width: 1280px)', // layout.less:557, the empty block
			'screen and (max-width: 1100px)', // tool_sitebuilder.less:110, imports no vars at all
			'screen and (max-width: 1024px)', // component_dataframe / tool_print / tool_import_dedalo_csv
			'screen and (max-width: 960px)', // tool_print.less:1130
			'screen and (max-width: 520px)', // update_ontology.less:339
			'screen and (max-width: 48rem)', // the removed installer.less's — the rem trap
			'screen and (min-width: 2000px)', // add_hierarchy.less:92
			'(max-width: 0)', // unitless zero is still a threshold
			'(width >= 600)', // range syntax, unitless
		];
		for (const condition of historical) {
			expect(thresholdTokens(condition), condition).not.toEqual([]);
		}
	});

	test('the threshold detector fires on the constructs that defeated its first version', () => {
		// Each of these compiled to a served threshold outside the record with the
		// gate green (adversarial pass, 2026-09-06). None may pass at source again.
		const evasions: Array<[string, string[]]> = [
			['(max-width: unit(1024, px))', ['1024']], // nested call: the old regex saw only `(1024, px)`
			['(max-width: (@width_break_point_0 - 64))', ['64']], // arithmetic on a tier = private tier
			['(max-width: (@width_break_point_0 * 0.8))', ['0.8']],
			['(max-width: (@width_break_point_0 + 20px))', ['20px']],
			['(max-width: 1e3px)', ['1e']], // LESS emits `1e 3px`; the `1e` alone is off-record
		];
		for (const [condition, expected] of evasions) {
			expect(thresholdTokens(condition).sort(), condition).toEqual(expected.sort());
		}
	});

	test('the source scanner finds conditions and ignores prose (the seam between the two)', () => {
		// The corpus half of the source leg: real `.less` in this tree documents its
		// breakpoints in comments at length, so a scanner that reads prose would
		// report literals nobody ships — and one that read too little would report
		// none at all. Both directions, on one synthetic source, plus the two
		// scanner evasions: a `//` that is a URL scheme, and `@{…}` interpolation.
		const found = mediaConditions(
			'planted.less',
			[
				'// @media screen and (max-width: 1280px) { } — a note, not a threshold',
				'/* @media (max-width: 999px) {} */',
				'.a { @media screen and (max-width: 1024px) { color: red; } }',
				'@media print { .b { display: none; } }',
				'.c { background: url(http://x/y.png) } @media (max-width: 1100px) { .d { color: red; } }',
				'.e { color: red; } // trailing comment with @media (max-width: 777px) {',
				'@media (max-width: @{zz_bp}) { .f { color: red; } }',
			].join('\n'),
		);
		expect(found.map((c) => c.text)).toEqual([
			'screen and (max-width: 1024px)',
			'print',
			'(max-width: 1100px)',
			'(max-width: @zz_bp)',
		]);
		expect(found.flatMap((c) => thresholdTokens(c.text))).toEqual(['1024px', '1100px']);
		expect(found.flatMap((c) => variablesIn(c.text))).toEqual(['zz_bp']);
	});

	test('the threshold detector does NOT fire on the idioms that must survive', () => {
		const legitimate = [
			'screen and (max-width: @width_break_point_0)',
			'screen and (min-width: (@width_break_point_0 + 1))', // the +1 complement, 2 real sites
			'screen and ( max-width :\n@width_break_point_1 )', // formatting-blind
			'print',
			'(prefers-reduced-motion: reduce)',
			'(prefers-color-scheme: dark)',
			'(hover: none) and (pointer: coarse)',
			'(-webkit-min-device-pixel-ratio: 2)', // a ratio is not a length
			'(min-resolution: 2dppx)',
			'(aspect-ratio: 16/9)', // not a width, no length unit
		];
		for (const condition of legitimate) {
			expect(thresholdTokens(condition), condition).toEqual([]);
		}
	});

	test('the served-value leg accepts exactly the record and its +1 complements', () => {
		const allowed = allowedServedValues(
			new Map([
				['tier_a', '1024px'],
				['floor', '360px'],
			]),
		);
		expect([...allowed].sort()).toEqual(['1024px', '1025px', '360px', '361px'].sort());
		expect(normaliseLength('1024.0PX')).toBe('1024px');
		// a served 800px, a served 48rem and a served unitless 0 are all off-record
		for (const token of ['800px', '48rem', '0']) {
			expect(allowed.has(normaliseLength(token)), token).toBe(false);
		}
	});

	test('the empty-@media visitor is not vacuous (planted blocks ARE caught, content is not)', async () => {
		const planted = await compileOne(
			[
				'.kept { color: red; }',
				'@media screen and (max-width: 900px) { }',
				'@media screen and (max-width: 800px) { .a { color: blue; } }',
				'@media screen and (max-width: 700px) { .b { } }',
				'@media screen and (max-width: 650px) { @zz: 0; }', // variable declaration only
				'@media screen and (max-width: 640px) { .m() { color: red; } }', // mixin definition only
				'@media screen and (max-width: 630px) { @dr: { color: red; } }', // detached ruleset only
				'',
			].join('\n'),
			join(REPO_ROOT, 'client/dedalo/core/page/css/layout/planted.less'),
		);
		// the bare-empty block, the one holding only an empty ruleset (the case a
		// source brace-walk cannot see), and the three that hold a node which LOOKS
		// like a declaration and ships nothing.
		expect(planted.empties.map((h) => h.condition).sort()).toEqual([
			'screen and (max-width: 630px)',
			'screen and (max-width: 640px)',
			'screen and (max-width: 650px)',
			'screen and (max-width: 700px)',
			'screen and (max-width: 900px)',
		]);
		// and the compiled CSS agrees: only the 800px block shipped.
		expect(mediaConditions('planted', planted.css).map((c) => c.text)).toEqual([
			'screen and (max-width: 800px)',
		]);
	});

	test('the dead-tier detector fires on the tier that was dead for three years, and on a value-only use', () => {
		// The liveness rule, replayed against a synthetic record and corpus: the shape
		// of the check, not the tree's current state, is what is asserted here — so
		// the day every tier is live the detector is still known to work.
		const synthetic = new Map([
			['width_break_point_1', '960px'], // branched on below
			['width_break_point_2', '780px'], // the historical corpse
			['width_break_point_v', '700px'], // used as a VALUE below, never branched on
			['min_target_viewport', '360px'], // a floor: exempt here, judged elsewhere
		]);
		const corpus = [
			'.a { width: @width_break_point_v; }',
			'@media screen and (max-width: @width_break_point_1) { .a { color: red; } }',
		].join('\n');
		const conds = mediaConditions('synthetic.less', corpus);
		expect(deadTiers(synthetic, conds, new Set(['min_target_viewport']))).toEqual([
			'@width_break_point_2 (780px)',
			'@width_break_point_v (700px)',
		]);
	});

	test('the record harvest is shape-based, not name-based (a rename does not blind it)', () => {
		// Same file, tiers renamed out of the `width_break_point` family: the harvest
		// must still return them, and must still ignore the colour aliases.
		const src = readFileSync(join(REPO_ROOT, RECORD_FILE), 'utf8');
		const found = harvestRecordFrom(src.replace(/@width_break_point_/g, '@tier_'));
		expect(found.size).toBe(record.size);
		expect([...found.keys()].filter((n) => n.startsWith('tier_')).length).toBeGreaterThan(0);
		expect([...found.values()].every((v) => BARE_LENGTH.test(v))).toBe(true);
	});
});
