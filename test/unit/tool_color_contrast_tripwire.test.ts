/**
 * TOOL COLOUR CONTRAST (DEC-12) — a tool's colour never reaches text unpaired.
 *
 * Every tool has ONE identity hue (`--<tool>` in its sheet). The hues are
 * mid-tones picked for recognition: white clears 4.5:1 on about half of them,
 * near-black on the other half, some on neither. So text never sits on the raw
 * hue. scripts/tool_colors.ts derives, per tool and per theme, a button fill
 * (the hue moved in OKLCH lightness) + the ink for it, and the header wash, into
 * the GENERATED client/dedalo/core/tools_common/css/tool_colors.less.
 *
 * The failure this exists for (2026-09-27): tool_propagate_component_data
 * repainted core `.warning` buttons with its red and kept the core near-black
 * ink — 2.63:1, unreadable; tool_ontology_parser did the same with its green
 * (3.01:1). The pair was split across two files (fill in the tool, ink in
 * buttons.less), which is why no review caught it.
 *
 * SEVEN assertions:
 *  1. the generated file is what the generator produces from today's hues
 *     (a hue edited without `bun run css:tool-colors` is stale output);
 *  2. every generated fill/ink pair clears 4.5:1 — MEASURED HERE with this
 *     file's own WCAG code, not the generator's;
 *  3. the header's muted ink clears 4.5:1 on every tool's header wash, both
 *     themes (the wash is the hue mixed into the surface: a dark hue darkens it);
 *  4. no tool sheet paints a `button` with its raw hue — a button takes the
 *     tool colour only through `.tool_action_button()` (tool_mixins.less),
 *     which carries fill + ink + glyph as one set;
 *  5. no CORE sheet (compiled main.css) paints a tool LAUNCHER button
 *     (`button.tool_<x>`, stamped by ui.tool.build_section_tool_button): the
 *     launcher is a toolbar button and takes the toolbar's look (buttons.less,
 *     no fill at rest). area_ontology painted tool_ontology_parser's launcher
 *     with the raw ontology green under the `.warning` ink (~2.5:1) — outside
 *     tools/, so assertion 4 never saw it (2026-09-30);
 *  6. the BOX-FREE scope `[data-tool="<tool>"]` exists for every tool, in BOTH
 *     themes, as the third member of the SAME selector list (never a separate
 *     block, never a stray `[data-tool]` rule) and never outranks
 *     `.tool_header.<tool>` — MEASURED by a specificity calculator in this file
 *     (the dark twin must stay (0,4,0): `:is()` takes the max of its arguments).
 *     Assertion 1 alone cannot see the scope dropped from the generator: file
 *     and generator would drop it together;
 *  7. the checkbox/radio accent OUTCOME: for a synthetic `<input>` under a
 *     `[data-tool]` box, a `.wrapper_tool` and a `.tool_header`, in both themes,
 *     the winning `accent-color` declaration of the compiled main.css — resolved
 *     by test/helpers/css_cascade.ts (importance, specificity, source order over
 *     EVERY rule that matches) — is the tool fill. Inferring it from where one
 *     rule sits missed a later `[data-tool] input{accent-color:red}` elsewhere
 *     in the sheet. The scoped rule also never outranks `.wrapper_tool`'s
 *     specificity.
 * The scope declares tokens only (never paints text), and its fill/ink pairs
 * live in the same blocks, so assertion 2 already measures them.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectHues, OUT_FILE, render } from '../../scripts/tool_colors.ts';
import {
	type CascadeRule,
	cmpSpec,
	fmtSpec,
	type ProbeChain,
	type ProbeElement,
	parseRules,
	resolveDeclaration,
	specificity,
	splitTop,
} from '../helpers/css_cascade.ts';
import { toolDirectoryNames } from '../helpers/tool_directory_corpus.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8');

const MIN = 4.5;

// ---- WCAG 2.x, independent of the generator ----
const channel = (c: number) => {
	const s = c / 255;
	return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const rgb = (hex: string): [number, number, number] => {
	const n = Number.parseInt(hex.replace('#', '').slice(0, 6), 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const lum = (hex: string) => {
	const [r, g, b] = rgb(hex).map(channel) as [number, number, number];
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: string, b: string) => {
	const x = lum(a);
	const y = lum(b);
	return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
/** `color-mix(in srgb, hue share, surface)` — the space tool_common mixes in. */
const mix = (hue: string, surface: string, share: number) => {
	const h = rgb(hue);
	const s = rgb(surface);
	return `#${h
		.map((c, i) =>
			Math.round(c * share + (s[i] as number) * (1 - share))
				.toString(16)
				.padStart(2, '0'),
		)
		.join('')}`;
};

type Block = { selector: string; decls: Record<string, string> };
/** The generated file is flat: `<selector> { --x: v; … }`. */
const generatedBlocks = (text: string): Block[] =>
	[...text.replace(/\/\/[^\n]*/g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
		selector: (m[1] as string).trim(),
		decls: Object.fromEntries(
			[...(m[2] as string).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((d) => [
				d[1] as string,
				(d[2] as string).trim(),
			]),
		),
	}));
/**
 * Element-`button` rules of a compiled tool sheet that paint the tool's RAW hue
 * (`@tool_color` compiles to `var(--<tool>)`). `.button` / `.button_*` classes
 * are icon masks — a hover tint on a glyph, not a fill under text — and stay open.
 */
const rawHueButtons = (tool: string, css: string): string[] =>
	[...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
		.filter((m) => /(^|[\s>+~(,])button(?![\w-])/.test(m[1] as string))
		.filter((m) =>
			new RegExp(`background(-color)?\\s*:\\s*var\\(--${tool}\\)`).test(m[2] as string),
		)
		.map((m) => (m[1] as string).trim().replace(/\s+/g, ' '));

/**
 * Rules of a compiled CORE sheet that set a background on an element `button`
 * carrying a `tool_<x>` class — a tool launcher repainted outside its toolbar look.
 */
const launcherPaints = (css: string): string[] =>
	[...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
		.filter((m) => /(^|[\s>+~(,])button(\.[\w-]+)*\.tool_[\w]+/.test(m[1] as string))
		.filter((m) => /(^|[;\s])background(-color)?\s*:/.test(m[2] as string))
		.map((m) => (m[1] as string).trim().replace(/\s+/g, ' '));

/** `var(--tool_x, #hex)` → `#hex` (the resolved fallback the generator writes). */
const fallbackHex = (v: string) => v.match(/#[0-9a-fA-F]{6}\b/)?.[0] ?? v;

const DARK_PREFIX = ':root[data-theme="dark"]';
const scopeOf = (tool: string) => `[data-tool="${tool}"]`;
/** Selector members a tool's blocks must carry, in the generator's order. */
const expectedMembers = (tool: string) => [
	`.tool_header.${tool}`,
	`.wrapper_tool.${tool}`,
	scopeOf(tool),
];

/**
 * What is wrong with the box-free scope in a generated tool_colors text. OUTCOME
 * checks: shape (one light + one dark block per tool, the scope INSIDE the same
 * list, nothing stray), and the specificity the cascade will see.
 */
const scopeProblems = (text: string, tools: string[]): string[] => {
	const problems: string[] = [];
	const all = generatedBlocks(text);
	if ((text.match(/\[data-tool=/g) ?? []).length !== tools.length * 2)
		problems.push(`[data-tool=] occurrences != ${tools.length * 2} (missing or stray scope)`);
	if (/!important/.test(text)) problems.push('!important in the generated file');
	for (const tool of tools) {
		const mine = all.filter((b) => b.selector.includes(`.tool_header.${tool},`));
		const light = mine.filter((b) => !b.selector.startsWith(DARK_PREFIX));
		const dark = mine.filter((b) => b.selector.startsWith(DARK_PREFIX));
		if (light.length !== 1 || dark.length !== 1) {
			problems.push(
				`${tool}: expected one light and one dark block, got ${light.length}/${dark.length}`,
			);
			continue;
		}
		const want = expectedMembers(tool);
		const lightMembers = splitTop((light[0] as Block).selector);
		if (lightMembers.join('|') !== want.join('|'))
			problems.push(
				`${tool}: light members [${lightMembers.join(' | ')}] != [${want.join(' | ')}]`,
			);
		const darkSel = (dark[0] as Block).selector;
		const m = darkSel.match(/^:root\[data-theme="dark"\] :is\(([\s\S]*)\)$/);
		const darkMembers = m ? splitTop(m[1] as string) : [];
		if (!m || darkMembers.join('|') !== want.join('|'))
			problems.push(
				`${tool}: dark selector is not ':root[data-theme="dark"] :is(<the three members>)': ${darkSel}`,
			);
		// the cascade: the scope never outranks the header it is a sibling of
		const scopeSpec = specificity(scopeOf(tool));
		const headerSpec = specificity(`.tool_header.${tool}`);
		if (cmpSpec(scopeSpec, headerSpec) > 0)
			problems.push(
				`${tool}: scope ${fmtSpec(scopeSpec)} outranks .tool_header ${fmtSpec(headerSpec)}`,
			);
		for (const member of lightMembers)
			if (cmpSpec(specificity(member), headerSpec) > 0)
				problems.push(
					`${tool}: light member ${member} ${fmtSpec(specificity(member))} outranks .tool_header ${fmtSpec(headerSpec)}`,
				);
		const darkSpec = specificity(darkSel);
		if (cmpSpec(darkSpec, [0, 4, 0]) !== 0)
			problems.push(`${tool}: dark selector specificity ${fmtSpec(darkSpec)} != (0,4,0)`);
	}
	return problems;
};

describe('tool colour contrast (DEC-12)', () => {
	const generated = readFileSync(OUT_FILE, 'utf8');
	const blocks = generatedBlocks(generated);

	test('the generated file is fresh', () => {
		expect(
			generated === render(collectHues().hues),
			'tool_colors.less does not match its generator — a tool hue changed without `bun run css:tool-colors`.',
		).toBe(true);
	});

	test('every generated fill/ink pair clears 4.5:1 (measured here)', () => {
		expect(blocks.length).toBeGreaterThan(60);
		// not vacuous: every tool, both themes
		expect(blocks.length).toBe(collectHues().hues.length * 2);
		const low: string[] = [];
		for (const { selector, decls } of blocks) {
			for (const fill of ['--tool_fill', '--tool_fill_hover']) {
				const r = ratio(decls[fill] as string, decls['--tool_on_fill'] as string);
				if (!(r >= MIN))
					low.push(
						`${selector} ${fill} ${decls[fill]} / ${decls['--tool_on_fill']} = ${r.toFixed(2)}`,
					);
			}
		}
		expect(
			low,
			'Regenerate with `bun run css:tool-colors`; never hand-edit the generated file.',
		).toEqual([]);
	});

	test("the header's muted ink clears 4.5:1 on every tool's wash, both themes", () => {
		const common = read('client/dedalo/core/tools_common/css/tool_common.less');
		const share =
			Number(
				common.match(/--tool_wash:\s*color-mix\(in srgb,\s*var\(--tool_edge[^)]*\)\s*(\d+)%/)?.[1],
			) / 100;
		const mutedLight = common.match(
			/:root:not\(\[data-theme="dark"\]\) \.tool_header \{\s*--fg_muted:\s*(#[0-9a-f]{6})/i,
		)?.[1];
		const dark = read('client/dedalo/core/page/css/layout/theme_dark.less');
		const mutedDark = dark.match(/^\s*--fg_muted:\s*(#[0-9a-f]{6})/im)?.[1];
		const surfaceDark = dark.match(/^\s*--bg_surface_alt:\s*(#[0-9a-f]{6})/im)?.[1];
		const tokens = read('client/dedalo/core/page/css/layout/vars_tokens.less');
		const surfaceLight = tokens.match(/^\s*--color_grey_15:\s*(#[0-9a-f]{6})/im)?.[1]; // --bg_surface_alt in light
		for (const v of [share, mutedLight, mutedDark, surfaceDark, surfaceLight])
			expect(v).toBeTruthy();

		expect(blocks.length).toBeGreaterThan(60);
		const low: string[] = [];
		for (const { selector, decls } of blocks) {
			const isDark = selector.startsWith(':root[data-theme="dark"]');
			const edge = fallbackHex(decls['--tool_edge'] as string);
			const wash = mix(edge, (isDark ? surfaceDark : surfaceLight) as string, share);
			const r = ratio((isDark ? mutedDark : mutedLight) as string, wash);
			if (!(r >= MIN)) low.push(`${selector}: muted on wash ${wash} = ${r.toFixed(2)}`);
		}
		expect(
			low,
			'Lower the wash share in tool_common.less (--tool_wash) or darken/lighten the header --fg_muted.',
		).toEqual([]);
	});

	test('positive control: the button scan catches a planted raw-hue fill, and only that', () => {
		const planted = [
			'.wrapper_tool.tool_x > .c button { background-color: var(--tool_x); }',
			'.wrapper_tool.tool_x button.warning:hover { background: var(--tool_x); }',
			// legal: an icon mask class, the mixin's generated fill, another token
			'.column_section_id > .button_edit.list_tool_x:hover { background-color: var(--tool_x); }',
			'.wrapper_tool.tool_x button { background-color: var(--tool_fill); }',
			'.wrapper_tool.tool_x button { background-color: var(--tool_x_fill); }',
		].join('\n');
		expect(rawHueButtons('tool_x', planted)).toEqual([
			'.wrapper_tool.tool_x > .c button',
			'.wrapper_tool.tool_x button.warning:hover',
		]);
	});

	test('no tool sheet paints a button with its raw hue', () => {
		// compiled CSS: `@tool_color` has become `var(--tool_x)`. An ELEMENT
		// `button` selector only — `.button_edit` / `.button` masks are icons (a
		// hover tint on a glyph), not a fill under text.
		const sheets = toolDirectoryNames()
			.map((tool) => ({ tool, file: `tools/${tool}/css/${tool}.css` }))
			.filter(({ file }) => existsSync(join(REPO_ROOT, file)));
		expect(sheets.length).toBeGreaterThan(30);
		const offenders = sheets.flatMap(({ tool, file }) =>
			rawHueButtons(tool, read(file)).map((s) => `${file}: ${s}`),
		);
		expect(
			offenders,
			'Use `.tool_action_button();` (tool_mixins.less): it paints the generated fill WITH its ink and glyph colour.',
		).toEqual([]);
	});

	test('positive control: the launcher scan catches a core repaint, and only that', () => {
		const planted = [
			'.area_x > .buttons_container button.tool_x { background-color: var(--color_x); }',
			'.b button.warning.tool_x:hover { background: red; }',
			// legal: an icon mask class, a non-background rule, a non-tool class
			'.wrapper_tool .button.tool_button { background-color: red; }',
			'.b button.tool_x { margin: 0; }',
			'.b button.warning { background-color: red; }',
		].join('\n');
		expect(launcherPaints(planted)).toEqual([
			'.area_x > .buttons_container button.tool_x',
			'.b button.warning.tool_x:hover',
		]);
	});

	test('no core sheet repaints a tool launcher button', () => {
		const css = read('client/dedalo/core/page/css/main.css');
		expect(css.length).toBeGreaterThan(100_000);
		expect(
			launcherPaints(css),
			'A tool launcher is a toolbar button: it takes the toolbar look (buttons.less), never a per-tool fill.',
		).toEqual([]);
	});

	test('the box-free [data-tool] scope exists for every tool, both themes, and never outranks the header', () => {
		const { hues } = collectHues();
		expect(hues.length).toBeGreaterThan(30);
		expect(
			scopeProblems(
				generated,
				hues.map((h) => h.tool),
			),
		).toEqual([]);
	});

	test('positive control: the scope scan flags each planted breakage, and passes the real shape', () => {
		const tool = 'tool_x';
		const [h, w, sc] = expectedMembers(tool) as [string, string, string];
		const decl = '\t--tool_edge: var(--tool_x, #000000);\n';
		const good = `${h}, ${w}, ${sc} {\n${decl}}\n${DARK_PREFIX} :is(${h}, ${w}, ${sc}) {\n${decl}}\n`;
		const run = (text: string) => scopeProblems(text, [tool]);
		expect(run(good)).toEqual([]);
		// scope dropped from both blocks (what the freshness check alone cannot see)
		expect(run(good.replaceAll(`, ${sc}`, '')).length).toBeGreaterThan(0);
		// dropped from the dark twin only
		expect(run(good.replace(`, ${sc}) {`, ') {')).length).toBeGreaterThan(0);
		// compounded onto the header: (0,3,0) outranks .tool_header.tool_x
		expect(run(good.replaceAll(sc, `${sc}.tool_header.tool_x`)).length).toBeGreaterThan(0);
		// a stray dark rule on the bare scope, outside the :is() list
		expect(run(`${good}${DARK_PREFIX} ${sc} {\n${decl}}\n`).length).toBeGreaterThan(0);
		// a doubled attribute raises the scope above the header
		expect(run(good.replaceAll(sc, sc + sc)).length).toBeGreaterThan(0);
		// !important
		expect(run(good.replace(decl, '\t--tool_edge: red !important;\n')).length).toBeGreaterThan(0);
		// the real file with one tool's scope removed is caught too
		const t0 = collectHues().hues[0]?.tool as string;
		expect(
			scopeProblems(
				generated.replaceAll(`, ${scopeOf(t0)}`, ''),
				collectHues().hues.map((x) => x.tool),
			).length,
		).toBeGreaterThan(0);
	});

	test('positive control: the specificity calculator', () => {
		const spec = (s: string) => fmtSpec(specificity(s));
		expect(spec('.tool_header.tool_x')).toBe('(0,2,0)');
		expect(spec('[data-tool="tool_x"]')).toBe('(0,1,0)');
		expect(spec('[data-tool] input[type="checkbox"]')).toBe('(0,2,1)');
		expect(spec('.wrapper_tool input[type="checkbox"]')).toBe('(0,2,1)');
		expect(spec('input[type=checkbox]')).toBe('(0,1,1)');
		expect(spec(':root[data-theme="dark"] :is(.a.b, .c, [d="e"])')).toBe('(0,4,0)');
		expect(spec(':root[data-theme="dark"] :is(.a, .b.c.d)')).toBe('(0,5,0)');
		expect(spec(':where([data-tool]) input')).toBe('(0,0,1)');
		expect(spec('#a .b:not(.c, #d)')).toBe('(2,1,0)');
		expect(spec('[data-tool="a,b]"]')).toBe('(0,1,0)'); // quoted `]` and `,` do not end/split
		expect(splitTop('.a, :is(.b, .c), [d="e,f"]')).toEqual(['.a', ':is(.b, .c)', '[d="e,f"]']);
	});

	test('the cascade resolver decides what it is asked, and refuses what it cannot decide', () => {
		const rules = parseRules(`
			input { accent-color: a; }
			.w input { accent-color: b; }
			.w > input:not(.x) { accent-color: c; }
			.w input { accent-color: d !important; }
			.w input:checked, .w input::before, .w + input { accent-color: e; }
			.z input { accent-color: f; }
			@media (min-width: 1px) { .w .y input { accent-color: g; } }
			html[data-theme="dark"] .w input[type="checkbox"] { accent-color: h; }
		`);
		const probe = (theme: string | undefined, input: Record<string, string> = {}): ProbeChain => [
			{ tag: 'html', attrs: theme ? { 'data-theme': theme } : {} },
			{ tag: 'body' },
			{ tag: 'div', classes: ['w'] },
			{ tag: 'input', attrs: { type: 'checkbox', ...input } },
		];
		const win = (chain: ProbeChain, property = 'accent-color') =>
			resolveDeclaration(rules, property, chain)?.value;
		// !important beats the heavier selectors; :checked / ::before / `+` do not match the probe
		expect(win(probe(undefined))).toBe('d');
		// importance, then specificity (dark rule is heavier but not important), then order
		const normal = parseRules(
			'input{accent-color:a}.w input{accent-color:b}.w > input:not(.x){accent-color:c}.w input{accent-color:d}',
		);
		expect(resolveDeclaration(normal, 'accent-color', probe(undefined))?.value).toBe('c'); // (0,2,1)+(0,1,0) > (0,1,1)
		const order = parseRules('.w input{accent-color:b}.w input{accent-color:d}');
		expect(resolveDeclaration(order, 'accent-color', probe(undefined))?.value).toBe('d'); // tie: later wins
		// the same-block last declaration wins; a property nobody sets is undefined
		expect(
			resolveDeclaration(
				parseRules('input{accent-color:a;accent-color:z}'),
				'accent-color',
				probe(undefined),
			)?.value,
		).toBe('z');
		expect(win(probe(undefined), 'color')).toBeUndefined();
		// a theme-scoped rule only competes in its theme
		const themed = parseRules('input{accent-color:a}html[data-theme="dark"] input{accent-color:h}');
		expect(resolveDeclaration(themed, 'accent-color', probe('dark'))?.value).toBe('h');
		expect(resolveDeclaration(themed, 'accent-color', probe('light'))?.value).toBe('a');
		// `>` needs the DIRECT parent; a descendant combinator may skip levels; `>` without spaces parses too
		const comb = (css: string) =>
			resolveDeclaration(parseRules(css), 'accent-color', probe(undefined))?.value;
		expect(comb('body > input{accent-color:x}')).toBeUndefined();
		expect(comb('body input{accent-color:x}')).toBe('x');
		expect(comb('html>body>.w>input{accent-color:x}')).toBe('x');
		expect(comb('body > .w input{accent-color:x}')).toBe('x');
		expect(comb('html > .w input{accent-color:x}')).toBeUndefined();
		expect(comb('.w ~ input, .w + input{accent-color:x}')).toBeUndefined();
		// a selector the matcher cannot decide throws instead of guessing
		expect(() =>
			resolveDeclaration(
				parseRules('input:nth-child(2){accent-color:a}'),
				'accent-color',
				probe(undefined),
			),
		).toThrow(/cannot decide/);
	});

	/** An `<input>` of `type` under each place the tool fill must reach, in each theme. */
	const ACCENT_PROBES: { name: string; chain: ProbeChain }[] = [];
	for (const theme of [undefined, 'light', 'dark'] as const) {
		for (const type of ['checkbox', 'radio']) {
			const html: ProbeElement = { tag: 'html', attrs: theme ? { 'data-theme': theme } : {} };
			const input = { tag: 'input', attrs: { type } };
			const where = `${theme ?? 'no theme'} ${type}`;
			ACCENT_PROBES.push(
				{
					name: `[data-tool] > input, ${where}`,
					chain: [html, { tag: 'body' }, { tag: 'div', attrs: { 'data-tool': 'tool_x' } }, input],
				},
				{
					name: `[data-tool] div input, ${where}`,
					chain: [
						html,
						{ tag: 'body' },
						{ tag: 'div', attrs: { 'data-tool': 'tool_x' } },
						{ tag: 'div' },
						input,
					],
				},
				{
					name: `.wrapper_tool > input, ${where}`,
					chain: [
						html,
						{ tag: 'body' },
						{ tag: 'div', classes: ['wrapper_tool', 'tool_x'] },
						input,
					],
				},
				{
					name: `.tool_header > input, ${where}`,
					chain: [html, { tag: 'body' }, { tag: 'div', classes: ['tool_header', 'tool_x'] }, input],
				},
			);
		}
	}
	const TOOL_FILL = 'var(--tool_fill, var(--checkbox_checked_bg))';
	/** What stops the tool fill from being the winning accent-color for each probe. */
	const accentProblems = (rules: CascadeRule[]): string[] =>
		ACCENT_PROBES.flatMap(({ name, chain }) => {
			const winner = resolveDeclaration(rules, 'accent-color', chain);
			if (!winner) return [`${name}: no accent-color rule at all`];
			const ok = !winner.important && winner.value.replace(/\s+/g, ' ') === TOOL_FILL;
			return ok
				? []
				: [
						`${name}: wins ${winner.selector} ${fmtSpec(winner.specificity)}${winner.important ? ' !important' : ''} → ${winner.value}`,
					];
		});

	const mainCss = () => read('client/dedalo/core/page/css/main.css');

	test('the checkbox/radio accent OUTCOME is the tool fill for every place a tool colour must reach', () => {
		expect(ACCENT_PROBES.length).toBe(24);
		expect(accentProblems(parseRules(mainCss()))).toEqual([]);
	});

	test('the scoped accent rule never outranks the wrapper rule it is a sibling of', () => {
		const rules = parseRules(mainCss());
		const scoped = rules.filter(
			(r) =>
				r.members.includes('[data-tool] input[type="checkbox"]') &&
				r.members.includes('[data-tool] input[type="radio"]') &&
				/accent-color\s*:/.test(r.body),
		);
		expect(
			scoped.length,
			'no accent-color rule scoped to [data-tool] in the compiled main.css',
		).toBe(1);
		const rule = scoped[0] as CascadeRule;
		const wrapper = '.wrapper_tool input[type="checkbox"]';
		expect(rule.members).toContain(wrapper);
		for (const member of rule.members)
			expect(cmpSpec(specificity(member), specificity(wrapper))).toBeLessThanOrEqual(0);
	});

	test('positive control: the accent outcome gate catches a later, a heavier and an important rival, and only those', () => {
		const css = mainCss();
		const bad = (text: string) => accentProblems(parseRules(text));
		expect(bad(css)).toEqual([]);
		// a later rule of equal specificity (the mutation the position-based gate missed)
		expect(bad(`${css}\n[data-tool] input[type="checkbox"]{accent-color:red}`).join('\n')).toMatch(
			/data-tool.*checkbox.*→ red/,
		);
		// the same, on the exact selector of the unrelated rule near the end of main.css
		expect(bad(`${css}\n[data-tool] input[type="radio"]{accent-color:red}`).length).toBeGreaterThan(
			0,
		);
		// an EARLIER but heavier rule still wins
		expect(
			bad(`html body div[data-tool] input[type="checkbox"]{accent-color:red}\n${css}`).length,
		).toBeGreaterThan(0);
		// !important beats any specificity
		expect(bad(`input{accent-color:red !important}\n${css}`).length).toBeGreaterThan(0);
		// the wrapper and header probes are guarded too
		expect(
			bad(`${css}\n.tool_header input[type="radio"]{accent-color:red}`).length,
		).toBeGreaterThan(0);
		// the scoped rule dropped: the global rule wins and the probe says so
		expect(bad(css.replaceAll('[data-tool] input', '[data-gone] input')).length).toBeGreaterThan(0);
		// rivals that cannot match any probe change nothing
		expect(bad(`${css}\n.elsewhere input[type="checkbox"]{accent-color:red}`)).toEqual([]);
		expect(bad(`${css}\n[data-tool] input[type="checkbox"]:checked{accent-color:red}`)).toEqual([]);
		expect(bad(`${css}\n[data-tool] input[type="checkbox"]::before{accent-color:red}`)).toEqual([]);
		expect(bad(`${css}\n[data-tool] input[type="file"]{accent-color:red}`)).toEqual([]);
	});
});
