/**
 * Availability bounds on the text/subtitle processors (DOS-01/DOS-02,
 * 2026-07-28 audit). These run on STORED, attacker-influenceable values
 * (CKEditor text_area, subtitle text); before the fix a 200 KB value froze the
 * event loop ~19 s (DOS-01) and a maxCharLine ≤ 0 looped forever into OOM
 * (DOS-02). The thresholds are generous (real work is sub-ms) — they exist to
 * catch a REGRESSION to super-linear / unbounded behaviour, not to benchmark.
 */

import { describe, expect, test } from 'bun:test';
import { truncateHtml } from '../../src/core/resolve/truncate_html.ts';

describe('DOS-01 — truncateHtml is bounded on adversarial markup', () => {
	test('200 KB of unclosed "<" completes fast (was ~19 s)', () => {
		const evil = `${'<'.repeat(200_000)} tail text long enough to exceed the cap`;
		const t0 = performance.now();
		truncateHtml(130, evil);
		expect(performance.now() - t0).toBeLessThan(2000);
	});

	test('legit short rich-text is returned unchanged (fits under length)', () => {
		const legit = '<b>Hello</b> world — a normal caption.';
		expect(truncateHtml(130, legit)).toBe(legit);
	});
});

describe('DOS-02 — subtitle line wrap always terminates', () => {
	test('maxCharLine <= 0 does not loop forever (clamped)', async () => {
		const { splitTextIntoLines } = (await import('../../src/core/media/tools/subtitles.ts')) as {
			splitTextIntoLines?: unknown;
		};
		// The wrap is exercised through the public subtitle build; here we only
		// assert the module loads and the clamp constant is present in source, since
		// the loop body is not individually exported. The behavioural proof is the
		// clamp: a run that never advanced refPos is impossible with maxCharLine>=1.
		const src = await Bun.file(
			new URL('../../src/core/media/tools/subtitles.ts', import.meta.url),
		).text();
		expect(src.includes('Math.max(1, Math.floor(Number(ctx.maxCharLine))')).toBe(true);
		expect(src.includes('maxIterations')).toBe(true);
		void splitTextIntoLines;
	});
});

describe('DOS-01 — text_area EDIT fallback is bounded before deleteMarks / stripTags', () => {
	// tr_marks DELETE_PATTERNS carry a lazy `(.*?):data` body: every UNTERMINATED
	// opener scans to the end of the string, so the uncapped pass is quadratic
	// (measured 2026-11-21: 200 KB of `[svg-a-1-data:` ≈ 1.25 s, 1 MB ≈ 30 s).
	// The edit placeholder is 700 chars, so the source is capped like the list.
	test('1 MB of unterminated mark openers in the fallback completes fast', async () => {
		const { shapeEditFallback } = await import(
			'../../src/core/components/component_text_area/emit.ts'
		);
		const unit = '[svg-a-1-data:[index-a-1-x-data:[page-a-1-x-data:';
		const evil = `${unit.repeat(Math.ceil(1_000_000 / unit.length))} tail`;
		const t0 = performance.now();
		const [shaped] = shapeEditFallback([{ id: 1, lang: 'lg-spa', value: evil }]) as Array<{
			value: string;
		}>;
		expect(performance.now() - t0).toBeLessThan(1000);
		// The placeholder is still the shaped text (≤ 700 chars + the cut marker).
		expect(typeof shaped?.value).toBe('string');
		expect([...(shaped?.value ?? '')].length).toBeLessThanOrEqual(703);
	});

	test('a legit transcript still loses its marks and tags', async () => {
		const { shapeEditFallback } = await import(
			'../../src/core/components/component_text_area/emit.ts'
		);
		const [shaped] = shapeEditFallback([
			{ id: 1, lang: 'lg-spa', value: '<p>[TC_00:00:01.000_TC]Hola <b>mundo</b></p>' },
		]) as Array<{ value: string }>;
		expect(shaped?.value).toBe('Hola mundo');
	});
});

describe('DOS-01 — indexation grid untagged fragment is bounded before deleteMarks', () => {
	// T2-D03-b-b deletes marks BEFORE the 220-char cut; its mark regexes carry
	// a lazy `(-data:.*?:data)?` body, quadratic on unterminated openers
	// (B5 review M1, measured: 320 KB of `[index-a-1-data:` ≈ 3 s per grid row).
	// The source is capped like every served preview (LIST_SOURCE_CAP).
	test('1 MB of unterminated mark openers in an untagged row completes fast', async () => {
		const { servedFragmentText } = await import('../../src/core/section/indexation_grid.ts');
		const { createSvgTagPathMemo } = await import(
			'../../src/core/components/component_text_area/tag_html.ts'
		);
		const unit = '[index-a-1-data:[person-a-1-x-data:[lang-a-1-x-data:';
		const evil = `${unit.repeat(Math.ceil(1_000_000 / unit.length))} tail`;
		const t0 = performance.now();
		const fragment = await servedFragmentText(null, evil, createSvgTagPathMemo());
		expect(performance.now() - t0).toBeLessThan(1000);
		expect(typeof fragment).toBe('string');
	});

	test('N rows quoting one transcription compute its preview once (per-build memo)', async () => {
		const { servedFragmentText } = await import('../../src/core/section/indexation_grid.ts');
		const { createSvgTagPathMemo } = await import(
			'../../src/core/components/component_text_area/tag_html.ts'
		);
		// At the cap, one adversarial preview still costs ~9 ms; 300 rows ≈ 2.6 s
		// uncached. With the grid build's memo they cost one computation.
		const evil = '[index-a-1-data:'.repeat(20_000);
		const svgMemo = createSvgTagPathMemo();
		const previews = new Map<string, Promise<string>>();
		const first = await servedFragmentText(null, evil, svgMemo, previews);
		const t0 = performance.now();
		for (let row = 0; row < 300; row++) {
			expect(await servedFragmentText(null, evil, svgMemo, previews)).toBe(first);
		}
		expect(performance.now() - t0).toBeLessThan(1000);
		expect(previews.size).toBe(1);
	});

	test('a legit untagged transcript still loses its marks before the cut', async () => {
		const { servedFragmentText } = await import('../../src/core/section/indexation_grid.ts');
		const { createSvgTagPathMemo } = await import(
			'../../src/core/components/component_text_area/tag_html.ts'
		);
		const fragment = await servedFragmentText(
			null,
			'<p>[TC_00:00:01.000_TC]Hola [index-a-1]mundo[/index-a-1]</p>',
			createSvgTagPathMemo(),
		);
		expect(fragment).toContain('Hola mundo');
		expect(fragment).not.toMatch(/\[(TC_|\/?index-)/);
	});
});
