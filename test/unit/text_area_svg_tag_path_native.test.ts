/**
 * SVG TAG URL = THE MEDIA COMPONENT'S FULL PATH (T0-10, audit D03;
 * WC-2026-11-11-svg-tag-url-full-media-path).
 *
 * A `[svg-…]` text tag carries a LOCATOR naming a media component on a record.
 * Its glyph URL is that component's file, i.e. the full media path grammar —
 * `folder + initial_media_path + '/' + quality + bucket + '/' + id.ext`, where
 * the bucket is the record's `additional_path` folder or else the
 * `max_items_folder` number. Three consumers render it and must agree:
 *   - the LIST read (component_text_area emit hook, the served audience);
 *   - the PUBLISHED cell (diffusion parse_tag_to_html, `/dedalo/<mediaDir>` base);
 *   - the tag ENDPOINT (302 to the file, the edit view's path).
 * Before T0-10 the first two built `folder/quality/id.svg` from a pure grammar
 * twin (no initial path, no bucket, model hard-coded to component_svg) and the
 * endpoint resolved section-scoped (no `additional_path`).
 *
 * Expected tails are HAND-WRITTEN literals — never recomputed through
 * buildMediaLocation (that would test the builder against itself).
 *
 * Axes:
 *   G1  test177 on test3 (max_items_folder 1000) → `/0` bucket; a file is
 *       PLANTED in the marked suite media root so the tail is proven to join to
 *       a real file, not just to a plausible string.
 *   G2  a `zz` situation (owner-authorised 2026-11-11): section
 *       `initial_media_path` + svg component with `max_items_folder` AND
 *       `additional_path` → a sibling input_text. One record names a folder, one
 *       leaves it empty (bucket fallback).
 *   G3  a NON-MEDIA model in a locator → `src=""` (PHP null), endpoint 404; and
 *       refused `additional_path` values (`..`, a `"` that would close the src
 *       attribute once the published render entity-decodes) are contained per
 *       mark — `src=""`, the list read still answers.
 *   G4  one text with more distinct locators than SVG_TAG_RESOLUTIONS_PER_TEXT:
 *       the first 64 resolve, the rest render `src=""`, ONE warning says so.
 */

import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../../src/config/config.ts';
import { handleTagRequest } from '../../src/core/components/component_text_area/tag_endpoint.ts';
import { SVG_TAG_RESOLUTIONS_PER_TEXT } from '../../src/core/components/component_text_area/tag_html.ts';
import { getMatrixTableFromTipo } from '../../src/core/ontology/resolver.ts';
import { readSection } from '../../src/core/section/read.ts';
import { createSession, SESSION_COOKIE } from '../../src/core/security/session_store.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { parseTagValueToHtml } from '../../src/diffusion/resolve/ddo_fns.ts';
import { registerSessionCleanup } from '../helpers/session_cleanup.ts';
import { TEST_MEDIA_MARKER } from '../helpers/test_media_root.ts';

registerSessionCleanup();

const SECTION = 'zzsvgpath1';
const HOST_TEXT_AREA = 'zzsvgpath2';
const SVG = 'zzsvgpath3';
const FOLDER_INPUT = 'zzsvgpath4';
const LIST = 'zzsvgpath5';

/** The record holding the tags (its text_area is read back in LIST mode). */
const HOST_ID = 1599;

/** One mark per axis; tag_id identifies it in every rendering. */
const MARKS = [
	// G1 — test177 (component_svg, max_items_folder 1000) on test3 record 1.
	{ id: 1, locator: "{'section_tipo':'test3','section_id':'1','component_tipo':'test177'}" },
	// G2 — initial_media_path 'ext' + additional_path folder 'named'.
	{
		id: 2,
		locator: "{'section_tipo':'zzsvgpath1','section_id':1501,'component_tipo':'zzsvgpath3'}",
	},
	// G2 — initial_media_path 'ext' + EMPTY additional_path → bucket 1000.
	{
		id: 3,
		locator: "{'section_tipo':'zzsvgpath1','section_id':'1502','component_tipo':'zzsvgpath3'}",
	},
	// G3 — a non-media model (input_text) named by the locator.
	{
		id: 4,
		locator: "{'section_tipo':'zzsvgpath1','section_id':1501,'component_tipo':'zzsvgpath4'}",
	},
	// G3 — additional_path value '..' is REFUSED by normalizeAdditionalPath.
	{
		id: 5,
		locator: "{'section_tipo':'zzsvgpath1','section_id':1503,'component_tipo':'zzsvgpath3'}",
	},
	// G3 — additional_path value with a `"` (attribute breakout) is REFUSED.
	{
		id: 6,
		locator: "{'section_tipo':'zzsvgpath1','section_id':1504,'component_tipo':'zzsvgpath3'}",
	},
] as const;

/** Hand-written media-root-relative tails (null = no URL: src=""). */
const EXPECTED_TAIL: Record<number, string | null> = {
	1: '/svg/web/0/test177_test3_1.svg',
	2: '/svg/ext/web/named/zzsvgpath3_zzsvgpath1_1501.svg',
	3: '/svg/ext/web/1000/zzsvgpath3_zzsvgpath1_1502.svg',
	4: null,
	5: null,
	6: null,
};

const HOST_VALUE = `<p>${MARKS.map((mark) => `[svg-n-${mark.id}-g${mark.id}-data:${mark.locator}:data]`).join(' ')}</p>`;

const S = situation({
	tld: 'zzsvgpath',
	name: 'svg tag full media path (T0-10)',
	nodes: [
		{
			tipo: SECTION,
			model: 'section',
			parent: 'dd14',
			// initial_media_path lives on the SECTION, keyed by the media component.
			properties: { initial_media_path: { [SVG]: 'ext' } },
		},
		{ tipo: HOST_TEXT_AREA, model: 'component_text_area', parent: SECTION, is_translatable: true },
		{
			tipo: SVG,
			model: 'component_svg',
			parent: SECTION,
			properties: { max_items_folder: 1000, additional_path: FOLDER_INPUT },
		},
		{ tipo: FOLDER_INPUT, model: 'component_input_text', parent: SECTION },
		{ tipo: LIST, model: 'section_list', parent: SECTION, relations: [{ tipo: HOST_TEXT_AREA }] },
	],
	records: [
		{
			section_tipo: SECTION,
			section_id: 1501,
			columns: { string: { [FOLDER_INPUT]: [{ id: 1, value: 'named', lang: 'lg-nolan' }] } },
		},
		{ section_tipo: SECTION, section_id: 1502 },
		{
			section_tipo: SECTION,
			section_id: 1503,
			columns: { string: { [FOLDER_INPUT]: [{ id: 1, value: '../escape', lang: 'lg-nolan' }] } },
		},
		{
			section_tipo: SECTION,
			section_id: 1504,
			columns: {
				string: { [FOLDER_INPUT]: [{ id: 1, value: 'a" onerror="alert(1)', lang: 'lg-nolan' }] },
			},
		},
		{
			section_tipo: SECTION,
			section_id: HOST_ID,
			columns: { string: { [HOST_TEXT_AREA]: [{ id: 1, value: HOST_VALUE, lang: 'lg-spa' }] } },
		},
	],
});

/** The G1 file planted in the suite media root (a leftover is swept first, removed after). */
const PLANTED_FILE = (): string =>
	join(config.media.rootPath as string, EXPECTED_TAIL[1] as string);

/** Every rendered svg <img> src keyed by its data-tag_id. */
function svgSrcsByTagId(html: string): Map<number, string> {
	const out = new Map<number, string>();
	for (const img of html.match(/<img[^>]*class="svg"[^>]*>/g) ?? []) {
		const tagId = /data-tag_id="(\d+)"/.exec(img);
		const src = /src="([^"]*)"/.exec(img);
		if (tagId === null || src === null) throw new Error(`malformed svg <img>: ${img}`);
		out.set(Number(tagId[1]), src[1] as string);
	}
	return out;
}

/** The expected src for a base: base + tail, or '' where no URL resolves. */
function expectedSrc(base: string, tagId: number): string {
	const tail = EXPECTED_TAIL[tagId];
	return tail === null || tail === undefined ? '' : `${base}${tail}`;
}

/** Every mark's expected src under one base. */
function expectedSrcs(base: string): Record<number, string> {
	return Object.fromEntries(MARKS.map(({ id }) => [id, expectedSrc(base, id)]));
}

/** The G1 URL each audience returned — the gate resolves THESE against the media root. */
const g1Urls: { list?: string; published?: string; endpoint?: string } = {};

let sessionCookie = '';
let plantedByUs = false;
/** The bucket dir, when this gate had to create it (removed again after). */
let createdDir: string | null = null;

beforeAll(async () => {
	await ensureSituation(S);
	expect(await getMatrixTableFromTipo(SECTION)).toBe('matrix_test');
	sessionCookie = `${SESSION_COOKIE}=${createSession(-1, 'root', true)}`;

	// The suite media root must be the MARKED one before anything is written.
	const root = config.media.rootPath as string;
	expect(existsSync(join(root, TEST_MEDIA_MARKER))).toBe(true);
	const file = PLANTED_FILE();
	// The root is the marked suite root: a leftover from an aborted run is swept.
	rmSync(file, { force: true });
	const dir = join(file, '..');
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
		createdDir = dir;
	}
	writeFileSync(file, '<svg xmlns="http://www.w3.org/2000/svg"/>');
	plantedByUs = true;
}, 60_000);

afterAll(async () => {
	if (plantedByUs) rmSync(PLANTED_FILE());
	if (createdDir !== null) rmdirSync(createdDir);
	expect(existsSync(PLANTED_FILE())).toBe(false);
	expect(await dropSituation(S)).toBe(0);
}, 60_000);

describe('svg tag URL carries the full media path — every audience', () => {
	test('LIST read (served audience: config.media.webBase)', async () => {
		const { data } = await readSection({
			action: 'read',
			source: { tipo: SECTION, section_tipo: SECTION, mode: 'list', lang: 'lg-spa' },
			sqo: {
				section_tipo: [SECTION],
				filter_by_locators: [{ section_tipo: SECTION, section_id: String(HOST_ID) }],
				limit: 1,
				offset: 0,
			},
		} as never);
		const item = (data as { tipo?: string; section_id?: number; entries?: unknown }[]).find(
			(entry) => entry.tipo === HOST_TEXT_AREA && entry.section_id === HOST_ID,
		);
		expect(item).toBeDefined();
		const values = (item as { entries: { value?: unknown }[] }).entries;
		const html = values.map((entry) => String(entry?.value ?? '')).join('');
		const srcs = svgSrcsByTagId(html);
		g1Urls.list = srcs.get(1);
		expect(Object.fromEntries(srcs)).toEqual(expectedSrcs(config.media.webBase));
		expect(html).not.toContain('onerror');
	}, 60_000);

	test('PUBLISHED cell (diffusion parse_tag_to_html: /dedalo/<mediaDir> base)', async () => {
		const html = await parseTagValueToHtml(HOST_VALUE);
		const srcs = svgSrcsByTagId(html);
		g1Urls.published = srcs.get(1);
		expect(Object.fromEntries(srcs)).toEqual(expectedSrcs(`/dedalo/${config.mediaDir}`));
		// The published render entity-DECODES its output: a quote let through the
		// folder would be a live attribute here.
		expect(html).not.toContain('onerror');
	});

	test('ENDPOINT (302 Location; non-resolvable → 404)', async () => {
		const observed: Record<number, string> = {};
		const expected: Record<number, string> = {};
		for (const { id, locator } of MARKS) {
			const url = new URL('http://localhost/dedalo/core/component_text_area/tag/');
			url.searchParams.set('id', locator.replaceAll("'", '"'));
			const response = await handleTagRequest(
				new Request(url, { headers: { cookie: sessionCookie } }),
				url,
			);
			observed[id] =
				response.status === 302 ? `302 ${response.headers.get('Location')}` : `${response.status}`;
			if (id === 1) g1Urls.endpoint = response.headers.get('Location') ?? undefined;
			const src = expectedSrc(config.media.webBase, id);
			expected[id] = src === '' ? '404' : `302 ${src}`;
		}
		expect(observed).toEqual(expected);
	});

	test('G1 — the URL the ENGINE returned resolves to the planted file', () => {
		const root = config.media.rootPath as string;
		const bases = {
			list: config.media.webBase,
			published: `/dedalo/${config.mediaDir}`,
			endpoint: config.media.webBase,
		} as const;
		for (const audience of ['list', 'published', 'endpoint'] as const) {
			const url = g1Urls[audience];
			expect(`${audience}: ${url?.startsWith(bases[audience])}`).toBe(`${audience}: true`);
			const onDisk = join(root, (url as string).slice(bases[audience].length));
			expect(`${audience}: ${existsSync(onDisk)}`).toBe(`${audience}: true`);
		}
	});
});

describe('G4 — distinct locators per text are bounded (no unbounded record reads)', () => {
	test('first 64 resolve, the rest render src="", ONE warning with the counts', async () => {
		expect(SVG_TAG_RESOLUTIONS_PER_TEXT).toBe(64);
		const total = 70;
		const text = Array.from(
			{ length: total },
			(_, index) =>
				`[svg-n-${index + 1}--data:{'section_tipo':'test3','section_id':'${index + 1}','component_tipo':'test177'}:data]`,
		).join('');
		const warn = spyOn(console, 'warn').mockImplementation(() => {});
		let html = '';
		let warned: string[] = [];
		try {
			html = await parseTagValueToHtml(text);
			// Read BEFORE restoring: mockRestore resets the recorded calls.
			warned = warn.mock.calls.map((call) => String(call[0]));
		} finally {
			warn.mockRestore();
		}
		const expected: Record<number, string> = {};
		for (let n = 1; n <= total; n++) {
			expected[n] = n <= 64 ? `/dedalo/${config.mediaDir}/svg/web/0/test177_test3_${n}.svg` : '';
		}
		expect(Object.fromEntries(svgSrcsByTagId(html))).toEqual(expected);
		const boundLines = warned.filter((line) => line.includes('over the per-text bound'));
		expect(boundLines).toEqual([
			'[component_text_area] svg tag locators over the per-text bound, src="" for 6 distinct locator(s) (resolved 64, bound 64)',
		]);
	});
});
