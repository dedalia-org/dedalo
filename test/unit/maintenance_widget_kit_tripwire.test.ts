/**
 * TRIPWIRE — maintenance widgets speak the ONE widget_kit vocabulary
 * (client/dedalo/core/area_maintenance/css/widget_kit.less), 2026-10-28.
 *
 * update_code drifted into its own dialect and it showed: a `▸` text-glyph
 * disclosure (0.8rem, left) where the whole application uses the arrow_down.svg
 * chevron (`.icon_arrow`); a readout key column sized per readout
 * (`max-content`), so two readouts stacked in one widget never aligned, and
 * two other widgets patching that locally with two different widths; LESS
 * `@color_*` compile-time colours that ignore data-theme. update_ontology had
 * copied the glyph. Fixed once in the kit — this gate keeps widgets on it:
 *
 *   A. no disclosure styling outside the kit (`\25B8`/`▸` glyph, the
 *      `::-webkit-details-marker` reset) — a fold is `.dd_fold`;
 *   B. every `<details>` a widget builds carries `dd_fold`;
 *   C. no `grid-template-columns` inside a `.dd_readout` rule — a widget that
 *      needs another key width sets `--dd_k_width` on its root;
 *   D. no LESS `@color_*` in a widget stylesheet — theme tokens only;
 *   E. no `--color_warning` in a widget stylesheet — the kit's amber
 *      `@dd_warn_*` (2026-10-28: #c4511d sat a few degrees from danger red, so
 *      a "warning" pill read as a second "blocked").
 *
 * DOES NOT PROVE: that the result looks right (that is the browser review), or
 * anything about widgets outside area_maintenance/widgets.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { trackedRepoFiles } from '../helpers/css_reference_corpus';

const ROOT = join(import.meta.dir, '../..');
const WIDGETS = 'client/dedalo/core/area_maintenance/widgets/';

// the TRACKED tree through the registered shared lister (census_derivation_tripwire)
const WIDGET_FILES = trackedRepoFiles()
	.filter(f => f.startsWith(WIDGETS))
	.map(f => f.slice(WIDGETS.length));
const LESS = WIDGET_FILES.filter(f => /^[^/]+\/css\/[^/]+\.less$/.test(f)).sort();
const JS = WIDGET_FILES.filter(f => /^[^/]+\/js\/[^/]+\.js$/.test(f)).sort();

const read = (rel: string): string => readFileSync(join(ROOT, WIDGETS, rel), 'utf8');

// the rules, as functions, so the positive controls below run the SAME code
const glyphFold = (src: string): boolean => /\\25B8|▸|::-webkit-details-marker/.test(src);
const readoutColumns = (src: string): boolean => /\.dd_readout\s*\{[^{}]*grid-template-columns/.test(src);
const lessColour = (src: string): boolean => /@color_[a-z0-9_]+/.test(src);
const redWarning = (src: string): boolean => /--color_warning\b/.test(src);
const unfoldedDetails = (src: string): string[] => {
	const bad: string[] = [];
	for (const m of src.matchAll(/element_type\s*:\s*'details'[^}]*\}/g)) {
		const cls = /class_name\s*:\s*['`"]([^'`"]*)/.exec(m[0]);
		if (!cls || !cls[1].split(/\s+/).includes('dd_fold')) bad.push(m[0].slice(0, 80));
	}
	return bad;
};

describe('maintenance_widget_kit_tripwire', () => {
	test('the corpus is the whole widget tree (floored)', () => {
		expect(LESS.length).toBeGreaterThanOrEqual(35);
		expect(JS.length).toBeGreaterThanOrEqual(60);
		expect(LESS).toContain('update_code/css/update_code.less');
	});

	test('positive controls: each rule fires on its own violation', () => {
		expect(glyphFold("&:before { content: '\\25B8'; }")).toBe(true);
		expect(glyphFold('&::-webkit-details-marker { display: none; }')).toBe(true);
		expect(readoutColumns('.dd_readout {\n\tgrid-template-columns: 1fr 1fr;\n}')).toBe(true);
		expect(readoutColumns('.dd_readout {\n\t--dd_k_width: 9rem;\n}')).toBe(false);
		expect(lessColour('color: @color_danger;')).toBe(true);
		expect(lessColour('color: var(--color_danger);')).toBe(false);
		expect(redWarning('color: var(--color_warning);')).toBe(true);
		expect(redWarning('color: @dd_warn_ink;')).toBe(false);
		expect(unfoldedDetails("ui.create_dom_element({ element_type : 'details', class_name : 'x' })")).toHaveLength(1);
		expect(unfoldedDetails("ui.create_dom_element({ element_type : 'details', parent : p })")).toHaveLength(1);
		expect(unfoldedDetails("ui.create_dom_element({ element_type: 'details', class_name: 'dd_fold x' })")).toHaveLength(0);
	});

	test('A. no disclosure styling outside the kit', () => {
		expect(LESS.filter(f => glyphFold(read(f)))).toEqual([]);
	});

	test('B. every <details> a widget builds is a .dd_fold', () => {
		const offenders = JS.flatMap(f => unfoldedDetails(read(f)).map(s => `${f}: ${s}`));
		expect(offenders).toEqual([]);
	});

	test('C. no per-readout key column — --dd_k_width on the widget root', () => {
		expect(LESS.filter(f => readoutColumns(read(f)))).toEqual([]);
	});

	test('D. widget stylesheets use theme tokens, never LESS @color_*', () => {
		expect(LESS.filter(f => lessColour(read(f)))).toEqual([]);
	});

	test('E. warning is the kit amber, never --color_warning', () => {
		expect(LESS.filter(f => redWarning(read(f)))).toEqual([]);
	});
});
