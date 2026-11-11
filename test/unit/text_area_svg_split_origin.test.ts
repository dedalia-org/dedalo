/**
 * SPLIT-ORIGIN SVG GLYPHS IN A text_area LIST CELL — the two audiences of one
 * rendered tag (2026-09-01).
 *
 * An install may serve media from a DIFFERENT ORIGIN than the application
 * (`DEDALO_MEDIA_WEB_BASE`: app on the Bun port, Apache media on another).
 * The `[svg-…]` tags a text_area LIST cell renders then have two readers, and
 * they need different URLs:
 *
 *  - the ENGINE'S OWN CLIENT (component_text_area/emit.ts, the app-serving list
 *    read path) must receive a URL on `config.media.webBase`. A root-relative
 *    one resolves against the APP origin, which in `publication` access mode
 *    serves no media — every glyph 404s silently, with a broken-image
 *    placeholder and nothing in the log (measured: :3500 → 404, :8080 → 200);
 *  - PUBLICATION / DIFFUSION (ddo_fns.ts parseTagValueToHtml, the parse_tag_to_html door) must
 *    keep the root-relative `/dedalo/<mediaDir>/…` form — WC-042 lists it under
 *    "Deliberately NOT on it": published data must not embed this app's origin.
 *
 * WHY THIS GATE RUNS IN A CHILD PROCESS. `test/preload/test_database.ts` pins
 * DEDALO_MEDIA_WEB_BASE to '' for the whole suite, so IN-SUITE `webBase` is
 * byte-identical to the root-relative literal and ANY assertion phrased in
 * terms of webBase passes with the defect fully intact. config freezes at first
 * import, so the split-origin case can only exist in a fresh process — the
 * `bun -e` pattern of test/unit/media_web_base.test.ts:33-46. The child inherits
 * the preload's DB pins, so it reads the SUITE database.
 *
 * WHY THROUGH readSection AND NOT THE HELPER. The bug was the WIRING (emit.ts
 * passing no options and so inheriting the publication resolver), not the URL
 * builder. A gate on the base alone would pin a pure function while the
 * consuming call stayed revertible with the suite green. So the child BUILDS a
 * scratch `zz` situation (section + translatable text_area + the component_svg
 * the marker points at + section_list naming the text_area), stores a real
 * `[svg-…]` marker, and reads it back through `readSection` in LIST mode — the
 * engine's own app-serving path, emit hook included. It renders the SAME marker
 * through diffusion's `parseTagValueToHtml` in the same process to
 * obtain the publication audience under the very
 * same config, which is what makes "the two audiences diverge" an outcome
 * rather than two separate readings of one constant.
 */

import { describe, expect, test } from 'bun:test';

/** The absolute media origin the split-origin case is measured under. */
const SPLIT_ORIGIN_BASE = 'http://media.example.test:8080/dedalo/media/';

/** The image id the stored marker's locator resolves to (component_section_id). */
const IMAGE_FILE = 'zzsvgaud4_zzsvgaud1_59.svg';

/**
 * The child program. Plain JS in a string (no ${…}, no backticks): it is handed
 * to `bun -e` with cwd = the repo root, so its relative imports resolve there.
 * It refuses to print a result it did not actually obtain — a missing list value
 * or a missing <img> throws, so this gate cannot go quietly green.
 */
const CHILD_PROGRAM = `
const { config } = await import('./src/config/config.ts');
const { situation, ensureSituation, dropSituation } = await import(
  './src/core/test_data/situations/situation.ts'
);
const { insertMatrixRecordWithCounter, deleteMatrixRecord } = await import(
  './src/core/db/matrix_write.ts'
);
const { getMatrixTableFromTipo } = await import('./src/core/ontology/resolver.ts');
const { readSection } = await import('./src/core/section/read.ts');
const { parseTagValueToHtml } = await import('./src/diffusion/resolve/ddo_fns.ts');

const SECTION = 'zzsvgaud1';
const TEXT_AREA = 'zzsvgaud2';
const LIST = 'zzsvgaud3';
// The media component the marker points at (T0-10: the URL is the locator's own
// media model — a non-media component_tipo resolves to no URL at all).
const SVG = 'zzsvgaud4';
// A real stored marker: TR grammar, locator with single quotes (PHP form).
const TAG =
  "<p>[svg-n-1-glyph-data:{'section_tipo':'zzsvgaud1','section_id':59,'component_tipo':'zzsvgaud4'}:data]</p>";

function srcOf(html, where) {
  const img = /<img[^>]*class="svg"[^>]*>/.exec(String(html === null ? '' : html));
  if (img === null) throw new Error('no rendered svg <img> in ' + where + ': ' + String(html));
  const src = /src="([^"]*)"/.exec(img[0]);
  if (src === null) throw new Error('rendered svg <img> without src in ' + where);
  return src[1];
}

const S = situation({
  tld: 'zzsvgaud',
  name: 'text_area svg tag audience',
  nodes: [
    { tipo: SECTION, model: 'section', parent: 'dd14' },
    { tipo: TEXT_AREA, model: 'component_text_area', parent: SECTION, is_translatable: true },
    { tipo: SVG, model: 'component_svg', parent: SECTION },
    // Without a section_list naming the column, the list read emits no
    // component at all and there would be nothing to assert on.
    { tipo: LIST, model: 'section_list', parent: SECTION, relations: [{ tipo: TEXT_AREA }] },
  ],
});

await ensureSituation(S);
const table = (await getMatrixTableFromTipo(SECTION)) || 'matrix_test';
let id = 0;
try {
  id = await insertMatrixRecordWithCounter(table, SECTION, {
    string: { [TEXT_AREA]: [{ id: 1, value: TAG, lang: 'lg-spa' }] },
  });
  const rqo = {
    action: 'read',
    source: { tipo: SECTION, section_tipo: SECTION, mode: 'list', lang: 'lg-spa' },
    sqo: {
      section_tipo: [SECTION],
      filter_by_locators: [{ section_tipo: SECTION, section_id: String(id) }],
      limit: 1,
      offset: 0,
    },
  };
  const { data } = await readSection(rqo);
  const item = data.find((e) => e.tipo === TEXT_AREA && e.section_id === id);
  if (item === undefined) throw new Error('the list read emitted no ' + TEXT_AREA + ' item');
  const values = Array.isArray(item.value) ? item.value : item.entries;
  if (!Array.isArray(values)) throw new Error('list item carries no values: ' + JSON.stringify(item));
  const listValue = (values.find((v) => v && v.value) || {}).value;
  console.log(
    JSON.stringify({
      webBase: config.media.webBase,
      mediaDir: config.mediaDir,
      // THE APP-SERVING PATH: readSection -> emit hook -> renderTagsWithResolvedSvg.
      appSrc: srcOf(listValue, 'the list read'),
      // THE PUBLICATION PATH: the same marker through diffusion's own
      // parse_tag_to_html door, same config — so the AUDIENCE that door picks is
      // under test, not a value this probe chose.
      pubSrc: srcOf(await parseTagValueToHtml(TAG), 'the publication rendering'),
    }),
  );
} finally {
  if (id > 0) await deleteMatrixRecord(table, SECTION, id);
  await dropSituation(S);
}
process.exit(0);
`;

interface Probe {
	webBase: string;
	mediaDir: string;
	appSrc: string;
	pubSrc: string;
}

/**
 * One fresh engine process under the given DEDALO_MEDIA_WEB_BASE.
 * '' is how the config computation spells UNSET (and outranks ../private/.env,
 * which on a split-origin dev machine sets the key) — so the no-op case is
 * measured, never inherited.
 */
function probe(mediaWebBase: string): Probe {
	const run = Bun.spawnSync(['bun', '-e', CHILD_PROGRAM], {
		cwd: `${import.meta.dir}/../..`,
		env: { ...process.env, DEDALO_MEDIA_WEB_BASE: mediaWebBase },
	});
	const stdout = run.stdout.toString();
	const stderr = run.stderr.toString();
	expect(`exit ${run.exitCode}\n${stderr}`).toBe('exit 0\n');
	const line = stdout.trim().split('\n').at(-1) ?? '';
	let parsed: Probe;
	try {
		parsed = JSON.parse(line) as Probe;
	} catch {
		throw new Error(`child produced no result JSON.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
	}
	return parsed;
}

describe('component_text_area svg tags: the served audience vs the published one', () => {
	test('SPLIT ORIGIN — the list read serves the ABSOLUTE base, publication stays relative', () => {
		const result = probe(SPLIT_ORIGIN_BASE);
		// The child really did see the override (guards a silently ignored env).
		expect(result.webBase).toBe('http://media.example.test:8080/dedalo/media');

		// (a) THE APP-SERVING PATH, driven through readSection in LIST mode.
		expect(result.appSrc).toBe(`${result.webBase}/svg/web/${IMAGE_FILE}`);
		expect(result.appSrc.startsWith('http://media.example.test:8080/')).toBe(true);

		// (b) THE PUBLICATION PATH under the SAME config — root-relative, no origin.
		expect(result.pubSrc).toBe(`/dedalo/${result.mediaDir}/svg/web/${IMAGE_FILE}`);
		expect(result.pubSrc.startsWith('http')).toBe(false);

		// The whole design in one line: same marker, same process, two audiences.
		expect(result.appSrc).not.toBe(result.pubSrc);
	}, 120_000);

	test('SAME ORIGIN (key unset) — the two audiences are byte-identical (the no-op property)', () => {
		const result = probe('');
		expect(result.webBase).toBe(`/dedalo/${result.mediaDir}`);
		expect(result.appSrc).toBe(`/dedalo/${result.mediaDir}/svg/web/${IMAGE_FILE}`);
		// (c) Nothing about the shipped, same-origin wire shape moved.
		expect(result.appSrc).toBe(result.pubSrc);
	}, 120_000);
});
