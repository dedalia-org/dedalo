/**
 * SPLIT-ORIGIN RICH-TEXT IMAGES (TODO-067) — a CKEditor image's `src` is stored
 * on the relative `/dedalo/<mediaDir>` root and served to the app on `webBase`.
 *
 * The editor inserts the upload endpoint's url (webBase) verbatim. Persisting it
 * would embed the media origin in the record (WC-042); serving the stored
 * relative form back would 404 on a split-origin install (the app origin serves
 * no media). So the write gate relativizes and the emit hook rebases.
 *
 * Child process for the same reason as text_area_svg_split_origin.test.ts: the
 * preload pins DEDALO_MEDIA_WEB_BASE to '', config freezes at first import, so
 * the split-origin case only exists in a fresh process. Through the real doors
 * (saveComponentData → stored row → readSection EDIT), not the helper: the
 * wiring is what can regress.
 */

import { describe, expect, test } from 'bun:test';

const SPLIT_ORIGIN_BASE = 'http://media.example.test:8080/dedalo/media/';

const CHILD_PROGRAM = `
const { config } = await import('./src/config/config.ts');
const { situation, ensureSituation, dropSituation } = await import(
  './src/core/test_data/situations/situation.ts'
);
const { insertMatrixRecordWithCounter, deleteMatrixRecord } = await import(
  './src/core/db/matrix_write.ts'
);
const { readMatrixRecord } = await import('./src/core/db/matrix.ts');
const { getMatrixTableFromTipo } = await import('./src/core/ontology/resolver.ts');
const { dispatchRqo } = await import('./src/core/api/dispatch.ts');
const { sql } = await import('./src/core/db/postgres.ts');
const { createSession, getSession } = await import('./src/core/security/session_store.ts');
const { resolvePrincipal } = await import('./src/core/security/permissions.ts');
const { readSection } = await import('./src/core/section/read.ts');

const SECTION = 'zzimgsrc1';
const TEXT_AREA = 'zzimgsrc2';
const S = situation({
  tld: 'zzimgsrc',
  name: 'text_area media src audience',
  nodes: [
    { tipo: SECTION, model: 'section', parent: 'dd14' },
    { tipo: TEXT_AREA, model: 'component_text_area', parent: SECTION, is_translatable: true },
  ],
});

function srcOf(html, where) {
  const src = /<img[^>]*src="([^"]*)"/.exec(String(html === null ? '' : html));
  if (src === null) throw new Error('no <img src> in ' + where + ': ' + String(html));
  return src[1];
}

await ensureSituation(S);
const table = (await getMatrixTableFromTipo(SECTION)) || 'matrix_test';
let id = 0;
try {
  id = await insertMatrixRecordWithCounter(table, SECTION, {});
  // What the editor sends: the url the upload endpoint answered (webBase).
  const sent = '<p><img src="' + config.media.webBase + '/image/web/pic.jpg"></p>';
  // The client's own save door: dispatch -> saveComponentData -> the echo.
  const session = getSession(createSession(-1, 'root', true));
  const saved = await dispatchRqo(
    {
      action: 'save',
      dd_api: 'dd_core_api',
      prevent_lock: true,
      source: { typo: 'source', type: 'component', model: 'component_text_area', tipo: TEXT_AREA,
        section_tipo: SECTION, section_id: id, mode: 'edit', lang: 'lg-spa', action: null },
      data: { section_id: id, section_tipo: SECTION, tipo: TEXT_AREA, lang: 'lg-spa',
        from_component_tipo: TEXT_AREA, changed_data: [{ action: 'insert', key: 0, value: { value: sent } }] },
    },
    { requestId: 'text_area_media_src_split_origin', clientIp: '127.0.0.1', session,
      csrfCandidate: session ? session.csrfToken : null, principal: await resolvePrincipal(-1) },
  );
  if (saved.body.ok !== true) throw new Error('save refused: ' + JSON.stringify(saved.body));
  const echoItem = ((saved.body.data && saved.body.data.data) || []).find((e) => e.tipo === TEXT_AREA);
  const echoed = echoItem && ((echoItem.entries || []).find((v) => v && v.value) || {}).value;
  const record = await readMatrixRecord(table, SECTION, id);
  const stored = ((record && record.columns.string && record.columns.string[TEXT_AREA]) || [])[0];
  const { data } = await readSection({
    action: 'read',
    source: { tipo: SECTION, section_tipo: SECTION, mode: 'edit', lang: 'lg-spa' },
    sqo: {
      section_tipo: [SECTION],
      filter_by_locators: [{ section_tipo: SECTION, section_id: String(id) }],
      limit: 1,
      offset: 0,
    },
  });
  const item = data.find((e) => e.tipo === TEXT_AREA && e.section_id === id);
  if (item === undefined) throw new Error('the edit read emitted no ' + TEXT_AREA + ' item');
  const served = ((item.entries || []).find((v) => v && v.value) || {}).value;
  console.log(
    JSON.stringify({
      webBase: config.media.webBase,
      mediaDir: config.mediaDir,
      storedSrc: srcOf(stored && stored.value, 'the stored row'),
      echoSrc: srcOf(echoed, 'the save echo'),
      servedSrc: srcOf(served, 'the edit read'),
    }),
  );
} finally {
  if (id > 0) await deleteMatrixRecord(table, SECTION, id);
  // The dd542 activity row the dispatch save appended (dd546 = the saved tipo).
  await sql.unsafe(
    "DELETE FROM matrix_activity WHERE section_tipo = 'dd542' AND string->'dd546'->0->>'value' = $1",
    [TEXT_AREA],
  );
  await dropSituation(S);
}
process.exit(0);
`;

interface Probe {
	webBase: string;
	mediaDir: string;
	storedSrc: string;
	echoSrc: string;
	servedSrc: string;
}

function probe(mediaWebBase: string): Probe {
	const run = Bun.spawnSync(['bun', '-e', CHILD_PROGRAM], {
		cwd: `${import.meta.dir}/../..`,
		env: { ...process.env, DEDALO_MEDIA_WEB_BASE: mediaWebBase },
	});
	const stdout = run.stdout.toString();
	const stderr = run.stderr.toString();
	expect(`exit ${run.exitCode}\n${stderr}`).toBe('exit 0\n');
	const line = stdout.trim().split('\n').at(-1) ?? '';
	try {
		return JSON.parse(line) as Probe;
	} catch {
		throw new Error(`child produced no result JSON.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
	}
}

describe('component_text_area <img src>: stored relative, served on webBase', () => {
	test('SPLIT ORIGIN — the stored row holds no media origin, the edit read serves it', () => {
		const result = probe(SPLIT_ORIGIN_BASE);
		expect(result.webBase).toBe('http://media.example.test:8080/dedalo/media');
		expect(result.storedSrc).toBe(`/dedalo/${result.mediaDir}/image/web/pic.jpg`);
		expect(result.servedSrc).toBe(`${result.webBase}/image/web/pic.jpg`);
		// The save echo is the client's post-save baseline: it must equal the read.
		expect(result.echoSrc).toBe(result.servedSrc);
	}, 120_000);

	test('SAME ORIGIN (key unset) — stored and served are the relative url (no-op)', () => {
		const result = probe('');
		const relative = `/dedalo/${result.mediaDir}/image/web/pic.jpg`;
		expect(result.storedSrc).toBe(relative);
		expect(result.servedSrc).toBe(relative);
		expect(result.echoSrc).toBe(relative);
	}, 120_000);
});
