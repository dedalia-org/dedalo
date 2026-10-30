/**
 * MEDIA URL VERSION TRIPWIRE — every media component behaves the same
 * (WC-2026-10-29-posterframe-url-version, the media render-cache pass).
 *
 * A media URL is versioned by its FILE, never by the render: a per-render
 * `?t=<Date.now()>` re-downloads every image, pdf, svg, model and video on every
 * paint, pagination and revisit. The standard, pinned here across
 * client/dedalo/core/component_{av,3d,image,pdf,svg}:
 *  1. NO per-render cache-bust (`'?t='`) — named exemptions only.
 *  2. ONE client builder: files_info URLs go through `get_media_url`
 *     (component_media_common/js/media_url.js), defined nowhere else; no bare
 *     `DEDALO_MEDIA_URL + x.file_path` — named exemptions only.
 *  3. ONE server media-URL token: `<mtime ms>-<size>` is built only in
 *     src/core/media/url_version.ts.
 *  4. The search renderer is lazy in every media component (CONVENTIONS S3-37 #3).
 *     (The thesaurus tree's own mtime-only icon URL, src/core/ts_object/ts_object.ts,
 *     is WC-2026-09-01-ts-object-svg-url — not a media component URL, out of scope.)
 * Every exemption must still match (a stale one is red).
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { browserSources } from '../helpers/browser_corpus.ts';
import { REPO_ROOT as ROOT, writePathSourceFiles } from '../helpers/write_path_corpus.ts';

const MODELS = ['av', '3d', 'image', 'pdf', 'svg'] as const;

const CLIENT_FILES = browserSources();
const MEDIA_FILES = CLIENT_FILES.filter((f) =>
	MODELS.some((m) => f.startsWith(`client/dedalo/core/component_${m}/js/`)),
);
const read = (f: string) => readFileSync(join(ROOT, f), 'utf8');
const codeLines = (f: string) =>
	read(f)
		.split('\n')
		.filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l));

/** file → exact count of allowed matches, with the reason. */
const CACHE_BUST_EXEMPT: Record<string, { count: number; reason: string }> = {
	'client/dedalo/core/component_av/js/view_player_edit_av.js': {
		count: 1,
		reason:
			'subtitles VTT: rewritten by transcription saves, not in files_info — no file version on the client',
	},
};
const BARE_URL_EXEMPT: Record<string, { count: number; reason: string }> = {
	'client/dedalo/core/component_image/js/vector_editor.js': {
		count: 1,
		reason: 'the raster href is PERSISTED into the svg envelope on save — it must stay a bare path',
	},
};

function census(re: RegExp): Map<string, number> {
	const hits = new Map<string, number>();
	for (const f of MEDIA_FILES) {
		const n = codeLines(f).filter((l) => re.test(l)).length;
		if (n > 0) hits.set(f, n);
	}
	return hits;
}

function assertOnlyExempt(hits: Map<string, number>, exempt: Record<string, { count: number }>) {
	const unexpected = [...hits].filter(([f, n]) => exempt[f]?.count !== n);
	expect(unexpected).toEqual([]);
	const stale = Object.entries(exempt).filter(([f, e]) => hits.get(f) !== e.count);
	expect(stale).toEqual([]);
}

test('anti-vacuity: the census sees every media component and the builder in use', () => {
	for (const m of MODELS) {
		expect(MEDIA_FILES.some((f) => f.includes(`/component_${m}/`))).toBe(true);
	}
	const sites = MEDIA_FILES.reduce(
		(n, f) => n + codeLines(f).filter((l) => /get_media_url\(/.test(l)).length,
		0,
	);
	expect(sites).toBeGreaterThanOrEqual(30);
});

test('no per-render cache-bust in any media component', () => {
	assertOnlyExempt(census(/[`'"]\?t=/), CACHE_BUST_EXEMPT);
});

test('files_info URLs go through get_media_url, the one client builder', () => {
	assertOnlyExempt(census(/DEDALO_MEDIA_URL\s*\+\s*[\w.]+\.file_path/), BARE_URL_EXEMPT);
	const definers = CLIENT_FILES.filter((f) => /(const|function)\s+get_media_url\b/.test(read(f)));
	expect(definers).toEqual(['client/dedalo/core/component_media_common/js/media_url.js']);
});

test('the server version token is built in one place', () => {
	const builders = writePathSourceFiles().filter((f) => /mtimeMs\)\}-/.test(read(f)));
	expect(builders).toEqual(['src/core/media/url_version.ts']);
});

test('the search renderer is lazy in every media component', () => {
	for (const m of MODELS) {
		const src = read(`client/dedalo/core/component_${m}/js/component_${m}.js`);
		expect(src).not.toMatch(/^\s*import\s*\{[^}]*render_search_component_/m);
		expect(src).toMatch(new RegExp(`await import\\([^)]*render_search_component_${m}\\.js`));
	}
});
