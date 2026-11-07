/**
 * TOOL COLORS — derive every tool's button fill + ink from its ONE identity hue.
 *
 * A tool declares `--<tool>` (its identity hue) in its own sheet's `:root`; the
 * dark twin lives in the sheet's `:root[data-theme="dark"]` block or in
 * theme_dark.less. Those hues are MID-TONES chosen for recognition, not for
 * carrying text: white clears 4.5:1 on about half of them, near-black on the
 * other half, and some on neither. So text never sits on the raw hue. This
 * script derives, per tool and per theme:
 *
 *   --tool_edge     the identity hue itself (header edge, accents — no text on it),
 *                   RESOLVED per theme (the tool sheet that declares the hue
 *                   loads lazily; main.css must not depend on it)
 *   --tool_fill     the hue moved in OKLCH LIGHTNESS ONLY (chroma/hue kept, so
 *                   it still reads as the tool) until its ink clears 4.5:1
 *   --tool_fill_hover  the fill moved a further HOVER_STEP away from its ink
 *   --tool_on_fill  the ink for that fill: white or --fg_on_brand's near-black,
 *                   whichever needs the smaller lightness move
 *
 * Each entry is scoped to three selectors: `.tool_header.<tool>`,
 * `.wrapper_tool.<tool>` and the box-free `[data-tool="<tool>"]` (a tool-owned
 * element outside the wrapper/header, e.g. a floating panel; it gets the four
 * tokens only — buttons there apply `.tool_action_button()` themselves).
 *
 * The hue is `--<tool>` — ONE name, no variants: a sheet that names it
 * otherwise gets no generated entry (tool_header_contract_tripwire assertion 1).
 *
 * and writes them to client/dedalo/core/tools_common/css/tool_colors.less
 * (GENERATED — never edit it; change the tool's hue and re-run).
 *
 *   bun run css:tool-colors            # regenerate
 *   bun run css:tool-colors --check    # fail if the generated file is stale
 *   bun run css:tool-colors --report   # per-tool contrast table, writes nothing
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '..');
const TOOLS_DIR = join(REPO_ROOT, 'tools');
const LAYOUT_DIR = join(REPO_ROOT, 'client/dedalo/core/page/css/layout');
export const OUT_FILE = join(REPO_ROOT, 'client/dedalo/core/tools_common/css/tool_colors.less');

/** WCAG AA floor for normal text. */
export const MIN_TEXT_RATIO = 4.5;
/** The two inks a fill may carry. Dark = --fg_on_brand (identical in both themes). */
export const INK_LIGHT = '#ffffff';
export const INK_DARK = '#16181b';

// ---------- colour math ----------

type RGB = [number, number, number];

const hexToRgb = (hex: string): RGB => {
	let h = hex.replace('#', '');
	if (h.length === 3) h = [...h].map((c) => c + c).join('');
	const n = Number.parseInt(h.slice(0, 6), 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const rgbToHex = (rgb: RGB): string =>
	`#${rgb
		.map((c) =>
			Math.round(Math.min(255, Math.max(0, c)))
				.toString(16)
				.padStart(2, '0'),
		)
		.join('')}`;

const toLinear = (c: number): number => {
	const s = c / 255;
	return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const fromLinear = (c: number): number =>
	255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

const luminance = (hex: string): number => {
	const [r, g, b] = hexToRgb(hex).map(toLinear) as RGB;
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export const contrast = (a: string, b: string): number => {
	const x = luminance(a);
	const y = luminance(b);
	return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

type OKLCH = [number, number, number];

const hexToOklch = (hex: string): OKLCH => {
	const [r, g, b] = hexToRgb(hex).map(toLinear) as RGB;
	const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
	const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
	const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
	const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
	const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
	const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
	return [L, Math.hypot(A, B), Math.atan2(B, A)];
};

const oklchToRgb = ([L, C, H]: OKLCH): { rgb: RGB; inGamut: boolean } => {
	const A = C * Math.cos(H);
	const B = C * Math.sin(H);
	const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
	const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
	const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
	const lin = [
		4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
		-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
		-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
	];
	const eps = 1e-4;
	return {
		rgb: lin.map(fromLinear) as RGB,
		inGamut: lin.every((c) => c >= -eps && c <= 1 + eps),
	};
};

/** OKLCH → hex, reducing chroma (never lightness or hue) until the colour is in sRGB. */
const oklchToHex = ([L, C, H]: OKLCH): string => {
	let c = C;
	for (;;) {
		const { rgb, inGamut } = oklchToRgb([L, c, H]);
		if (inGamut || c <= 0) return rgbToHex(rgb);
		c = Math.max(0, c - 0.002);
	}
};

export type Derived = {
	hue: string;
	fill: string;
	hover: string;
	ink: string;
	ratio: number;
	moved: number;
};

/** Hover = the fill moved a further step AWAY from its ink, so hovering can only raise contrast. */
export const HOVER_STEP = 0.06;

/**
 * Move `hue` in OKLCH lightness toward the side that `ink` needs until the
 * pair clears MIN_TEXT_RATIO. Returns null when it cannot (never happens for
 * the two inks at the ends of the scale, but stated rather than assumed).
 */
const clampFor = (hue: string, ink: string): Derived | null => {
	const [L0, C, H] = hexToOklch(hue);
	const step = ink === INK_LIGHT ? -0.002 : 0.002;
	for (let L = L0; L >= 0 && L <= 1; L += step) {
		const fill = oklchToHex([L, C, H]);
		const ratio = contrast(fill, ink);
		if (ratio >= MIN_TEXT_RATIO) {
			const hover = oklchToHex([Math.min(1, Math.max(0, L + Math.sign(step) * HOVER_STEP)), C, H]);
			return { hue, fill, hover, ink, ratio, moved: Math.abs(L - L0) };
		}
	}
	return null;
};

/** The pair needing the smaller lightness move wins: the fill stays closest to the identity hue. */
export const deriveFill = (hue: string): Derived => {
	const candidates = [clampFor(hue, INK_LIGHT), clampFor(hue, INK_DARK)].filter(
		(d): d is Derived => d !== null,
	);
	if (candidates.length === 0)
		throw new Error(`tool_colors: no ink reaches ${MIN_TEXT_RATIO}:1 on ${hue}`);
	candidates.sort((a, b) => a.moved - b.moved || b.ratio - a.ratio);
	return candidates[0] as Derived;
};

// ---------- hue discovery ----------

const HEX = /^#[0-9a-fA-F]{3,8}$/;

/** `--name: value;` declarations in a `:root` block text (last one wins). */
const decls = (block: string): Map<string, string> => {
	const out = new Map<string, string>();
	for (const m of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g))
		out.set(m[1] as string, (m[2] as string).trim());
	return out;
};

/** Top-level blocks whose selector matches `selector` exactly (whitespace-normalized). */
const blocks = (src: string, selector: string): string => {
	const noComments = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
	let out = '';
	const re = /([^{}]+)\{([^{}]*)\}/g;
	for (const m of noComments.matchAll(re)) {
		if (((m[1] as string).split(';').pop() as string).trim().replace(/\s+/g, ' ') === selector)
			out += `${m[2]}\n`;
	}
	return out;
};

const lessVars = (src: string): Map<string, string> => {
	const out = new Map<string, string>();
	for (const m of src.matchAll(/^@([\w-]+)\s*:\s*([^;]+);/gm))
		out.set(m[1] as string, (m[2] as string).trim());
	return out;
};

const LIGHT_PALETTE = decls(
	blocks(readFileSync(join(LAYOUT_DIR, 'vars_tokens.less'), 'utf8'), ':root'),
);
const DARK_PALETTE = decls(
	blocks(readFileSync(join(LAYOUT_DIR, 'theme_dark.less'), 'utf8'), ':root[data-theme="dark"]'),
);

/** Resolve a hex / `var(--x)` / `@x` value to a hex, through the given scopes in order. */
const resolveValue = (
	value: string,
	scopes: Map<string, string>[],
	lvars: Map<string, string>,
	depth = 0,
): string | null => {
	if (depth > 8) return null;
	const v = value.replace(/!important/, '').trim();
	if (HEX.test(v)) return v.toLowerCase();
	const at = v.match(/^@([\w-]+)$/);
	if (at) {
		const next = lvars.get(at[1] as string);
		return next ? resolveValue(next, scopes, lvars, depth + 1) : null;
	}
	const ref = v.match(/^var\(\s*(--[\w-]+)\s*(?:,[^)]*)?\)$/);
	if (ref) {
		for (const scope of scopes) {
			const next = scope.get(ref[1] as string);
			if (next) return resolveValue(next, scopes, lvars, depth + 1);
		}
	}
	return null;
};

export type ToolHues = { tool: string; name: string; light: string; dark: string };

export const collectHues = (): { hues: ToolHues[]; skipped: string[] } => {
	const hues: ToolHues[] = [];
	const skipped: string[] = [];
	for (const tool of readdirSync(TOOLS_DIR).sort()) {
		const file = join(TOOLS_DIR, tool, 'css', `${tool}.less`);
		if (!existsSync(file)) continue;
		const src = readFileSync(file, 'utf8');
		const lvars = lessVars(src);
		const ownLight = decls(blocks(src, ':root'));
		const ownDark = decls(blocks(src, ':root[data-theme="dark"]'));
		const name = `--${tool}`;
		const lightRaw = ownLight.get(name);
		if (!lightRaw) {
			skipped.push(tool);
			continue;
		}
		const light = resolveValue(lightRaw, [ownLight, LIGHT_PALETTE], lvars);
		const darkRaw = ownDark.get(name) ?? DARK_PALETTE.get(name) ?? lightRaw;
		const dark = resolveValue(darkRaw, [ownDark, DARK_PALETTE, ownLight, LIGHT_PALETTE], lvars);
		if (!light || !dark)
			throw new Error(`tool_colors: cannot resolve ${name} (${lightRaw} / ${darkRaw}) in ${file}`);
		hues.push({ tool, name, light, dark });
	}
	return { hues, skipped };
};

// ---------- output ----------

export const render = (hues: ToolHues[]): string => {
	const lines: string[] = [
		"// GENERATED by scripts/tool_colors.ts — DO NOT EDIT. Change the tool's own",
		'// `--<tool>` hue and run `bun run css:tool-colors`.',
		'//',
		'// Per tool: --tool_edge = the identity hue (edges/accents, never under text);',
		`// --tool_fill = that hue moved in OKLCH lightness until --tool_on_fill clears ${MIN_TEXT_RATIO}:1.`,
		'// The trailing comment is the measured WCAG ratio of fill/ink.',
		'',
	];
	for (const { tool, name, light, dark } of hues) {
		const l = deriveFill(light);
		const d = deriveFill(dark);
		// Third member: the BOX-FREE scope. A tool-owned element outside any
		// .wrapper_tool / .tool_header (a map overlay, a floating panel) stamps
		// `data-tool="<tool>"` and receives the four tokens — nothing else (no
		// wash, no edge bar, no button styling: that stays `.tool_action_button()`).
		// SAME block, never a separate one: :is() takes the MAX specificity of its
		// arguments, so the dark twin stays (0,4,0) and [data-tool] (0,1,0) never
		// outranks .tool_header.<tool> (0,2,0). Core also stamps data-tool on the
		// section/component tool LAUNCHERS (ui.js); harmless — no core rule reads
		// --tool_fill/--tool_edge on a launcher. `.tool_header.${tool},` stays first
		// (tool_header_contract_tripwire greps for it).
		const sel = `.tool_header.${tool}, .wrapper_tool.${tool}, [data-tool="${tool}"]`;
		lines.push(
			`${sel} {`,
			// the hue token WITH its resolved value as fallback: the token lives in
			// the tool's own sheet, which loads lazily — the header (and a modal's
			// placeholder header) renders before it, and the edge must not wait
			`\t--tool_edge: var(${name}, ${light});`,
			`\t--tool_fill: ${l.fill};`,
			`\t--tool_fill_hover: ${l.hover};`,
			`\t--tool_on_fill: ${l.ink}; // ${l.ratio.toFixed(2)}:1`,
			'}',
			`:root[data-theme="dark"] :is(${sel}) {`,
			`\t--tool_edge: var(${name}, ${dark});`,
			`\t--tool_fill: ${d.fill};`,
			`\t--tool_fill_hover: ${d.hover};`,
			`\t--tool_on_fill: ${d.ink}; // ${d.ratio.toFixed(2)}:1`,
			'}',
		);
	}
	return `${lines.join('\n')}\n`;
};

if (import.meta.main) {
	const { hues, skipped } = collectHues();
	if (Bun.argv.includes('--report')) {
		const surfLight = '#f6f6f6';
		const surfDark = '#1f2227';
		for (const { tool, light, dark } of hues) {
			const l = deriveFill(light);
			const d = deriveFill(dark);
			console.log(
				`${tool.padEnd(32)} L ${light}→${l.fill} ${l.ink === INK_LIGHT ? 'W' : 'K'} ${l.ratio.toFixed(2)} edge ${contrast(light, surfLight).toFixed(2)}` +
					` | D ${dark}→${d.fill} ${d.ink === INK_LIGHT ? 'W' : 'K'} ${d.ratio.toFixed(2)} edge ${contrast(dark, surfDark).toFixed(2)}`,
			);
		}
		if (skipped.length)
			console.log(`\nno --<tool> hue declared (inherit the default): ${skipped.join(', ')}`);
		process.exit(0);
	}
	const out = render(hues);
	if (Bun.argv.includes('--check')) {
		const current = existsSync(OUT_FILE) ? readFileSync(OUT_FILE, 'utf8') : '';
		if (current !== out) {
			console.error('tool_colors.less is stale — run `bun run css:tool-colors`');
			process.exit(1);
		}
		console.log('tool_colors.less up to date');
		process.exit(0);
	}
	writeFileSync(OUT_FILE, out);
	console.log(`wrote ${OUT_FILE} (${hues.length} tools; no hue: ${skipped.join(', ') || 'none'})`);
}
