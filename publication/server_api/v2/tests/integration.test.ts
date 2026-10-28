import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { __setTestDbExecute } from '../src/db/pool';
import type { DbRow } from '../src/db/types';
import { dbNames } from '../src/config';
import { MAX_RESOLVE_ROWS } from '../src/constants';

// ---------------------------------------------------------------------------
// Mocked database layer: pattern-matches the SQL the services produce.
// ---------------------------------------------------------------------------

// A CONFIGURED database name, not an invented one: the REAL assertKnownDb now guards
// every route and dbExecute, so an unpublished name 404s — which is the allowlist doing
// its job, and is what 'unknown database is a 404 problem' below asserts.
const MOCK_DB = dbNames[0];

const interviewRows = [
  {
    section_id: 1,
    lang: 'lg-eng',
    code: 'OH-001',
    title: 'Interview with María',
    transcription: '[tc-0-10] intro text [page-n-1] the guerra started here [tc-10-20] more about guerra and exile [page-n-2] ending',
    image: 'img1.jpg',
    dd_relations: '[{"section_tipo":"rsc170","section_id":2}]',
  },
  {
    section_id: 1,
    lang: 'lg-spa',
    code: 'OH-001',
    title: 'Entrevista con María',
    transcription: 'texto en castellano sobre la guerra',
    image: 'img1.jpg',
    dd_relations: null,
  },
  {
    section_id: 2,
    lang: 'lg-eng',
    code: 'OH-002',
    title: 'Second interview',
    transcription: 'nothing relevant',
    image: null,
    dd_relations: null,
  },
];

const INTERVIEW_COLUMNS = ['section_id', 'lang', 'code', 'title', 'transcription', 'image', 'dd_relations'];
const THEMES_COLUMNS = ['section_id', 'term_id', 'term', 'parent'];

export const sqlLog: Array<{ sql: string; params: unknown[] }> = [];

/** Set by the fulltext-error describe: the MATCH statements raise this instead of answering. */
let fulltextRefusal: Error | null = null;

function columnsResult(table: string, withTableName: boolean): Record<string, string>[] {
  const cols = table === 'interview' ? INTERVIEW_COLUMNS : table === 'ts_themes' ? THEMES_COLUMNS : [];
  return cols.map(name => ({
    ...(withTableName ? { TABLE_NAME: table } : {}),
    COLUMN_NAME: name,
    DATA_TYPE: name === 'transcription' ? 'longtext' : name === 'section_id' ? 'int' : 'varchar',
  }));
}

/**
 * A real database rejects a column it does not have. This mock used to answer 200 for any
 * column name at all, which is precisely why a typo in sort/fields/filter could reach
 * production as a 500 with a green test suite: the fixture was more forgiving than MariaDB.
 * Anything back-tick-quoted in the statement must therefore be a column the fixture declares.
 */
function assertMockColumnsExist(s: string): void {
  const known = new Set([
    ...INTERVIEW_COLUMNS,
    ...THEMES_COLUMNS,
    // The AV join's own columns (AV_VIDEO_COLUMN / AV_TRANSCRIPTION_COLUMN defaults) plus the
    // aliases the services introduce.
    'rsc35',
    'rsc36',
    'relevance',
    'total',
    'video',
    'data',
  ]);
  // Table names are back-ticked too; skip the one right after FROM/JOIN/INTO.
  const tableNames = new Set(['interview', 'ts_themes', 'audiovisual', 'informant', 'publication_schema']);

  for (const [, identifier] of s.matchAll(/`([A-Za-z_][A-Za-z0-9_]*)`/g)) {
    if (tableNames.has(identifier) || known.has(identifier)) continue;
    throw new Error(`Unknown column '${identifier}' in 'field list'`);
  }
}

async function mockDbExecute(_db: string, sql: string, params: unknown[] = []): Promise<DbRow[]> {
  // No allowlist check here any more: dbExecute runs the REAL assertKnownDb before it
  // reaches this fake, so the 404-for-unknown-database path is production code.
  sqlLog.push({ sql, params });
  const s = sql.replace(/\s+/g, ' ').trim();

  if (!s.includes('INFORMATION_SCHEMA')) assertMockColumnsExist(s);

  // MariaDB raises errno 1191 when MATCH targets a column with no FULLTEXT index — a client
  // problem the search service translates. The fixture table declares the index, so nothing
  // else in the suite can provoke it; this switch exists for the one describe that proves the
  // mapping, and for nothing else.
  if (fulltextRefusal !== null && s.includes('MATCH(')) throw fulltextRefusal;

  if (s.includes('INFORMATION_SCHEMA.TABLES')) {
    return [
      { TABLE_NAME: 'interview', TABLE_ROWS: interviewRows.length },
      { TABLE_NAME: 'ts_themes', TABLE_ROWS: 5 },
    ];
  }
  if (s.includes('INFORMATION_SCHEMA.COLUMNS')) {
    if (params.length > 0) return columnsResult(String(params[0]), false);
    return [...columnsResult('interview', true), ...columnsResult('ts_themes', true)];
  }
  if (s.includes('COUNT(*)')) {
    if (s.includes('MATCH(')) return [{ total: 1 }];
    return [{ total: interviewRows.length }];
  }
  if (s.includes('MATCH(')) {
    return [structuredClone({ ...interviewRows[0], relevance: 1.5 })];
  }
  if (s.includes('LEFT JOIN informant')) {
    return [{
      section_id: 1, code: 'OH-001', title: 'Interview with María',
      transcription: '[tc-0-10] hello [tc-10-20] guerra talk here [tc-20-30] tail',
      video: 'v.mp4', image: 'img1.jpg', name: 'María', surname: 'García',
    }];
  }
  // The media table is backtick-quoted and comes from AV_MEDIA_TABLE (default `audiovisual`).
  if (s.includes('LEFT JOIN `audiovisual`')) {
    let rows = interviewRows.filter(r => r.section_id === Number(params[0]));
    if (s.includes('`lang` = ?')) rows = rows.filter(r => r.lang === params[1]);
    return structuredClone(rows.map(r => ({ ...r, video: 'v.mp4' })));
  }
  // The thesaurus UNION behind av-indexation terms. Modelled on the real thing: a
  // derived table only has the columns it PROJECTS, so filtering on t.indexation when
  // the UNION branches don't select it is an error — which is exactly the bug this
  // mock now catches (the catch in the service used to turn it into a silent []).
  if (s.includes('UNION ALL')) {
    if (!/SELECT term_id, term, indexation FROM/.test(s)) {
      throw new Error("Unknown column 't.indexation' in 'where clause'");
    }
    return [
      { term_id: 'ts_themes_1', term: 'guerra civil' },
      { term_id: 'ts_onomastic_5', term: 'María García' },
    ];
  }
  if (s.includes('publication_schema')) {
    return [{ data: JSON.stringify({ dd_relations: { rsc170: 'interview' } }) }];
  }
  if (s.includes('WHERE `section_id` = ?')) {
    let rows = interviewRows.filter(r => r.section_id === Number(params[0]));
    if (s.includes('AND `lang` = ?')) rows = rows.filter(r => r.lang === params[1]);
    return structuredClone(rows);
  }
  if (s.includes('WHERE `section_id` IN')) {
    return structuredClone(interviewRows.filter(r => (params as number[]).includes(r.section_id)));
  }
  if (s.includes('FROM `interview`') || s.includes('FROM `ts_themes`')) {
    let rows = structuredClone(interviewRows) as Record<string, unknown>[];
    if (s.includes('LIMIT ?')) {
      const hasOffset = s.includes('OFFSET ?');
      const limit = Number(params[params.length - (hasOffset ? 2 : 1)]);
      const offset = hasOffset ? Number(params[params.length - 1]) : 0;
      rows = rows.slice(offset, offset + limit);
    }
    return rows;
  }
  return [];
}

// NO `mock.module` HERE, DELIBERATELY. It replaces a module for the whole PROCESS — bun
// runs all 24 test files in one — so mocking '../src/db/pool' also replaced it for
// tests/pool.test.ts, whose entire job is to test the REAL pool. On the Linux CI runner
// that file first died at load (a mock factory missing an export) and then, once the
// factory was completed, its memoization test silently asserted against the stub
// (2026-08-14). macOS never reproduced either, so the gate was platform-dependent.
//
// The seam below is scoped and reversible: only dbExecute's SQL round-trip is replaced,
// the real allowlist still guards it, and afterAll puts it back.
beforeAll(() => __setTestDbExecute(mockDbExecute));
afterAll(() => __setTestDbExecute(null));

const { dispatch, routeRequest } = await import('../src/router');
const { handleToolCall } = await import('../src/mcp/tools');
const { handleBatch } = await import('../src/routes/batch');
const { resolveRelations, resolveInverseRelations } = await import('../src/services/resolve.service');
const { config } = await import('../src/config');

async function get(path: string): Promise<{ res: Response; body: any }> {
  const res = await dispatch('GET', path);
  const body = await res.json().catch(() => undefined);
  return { res, body };
}

// ---------------------------------------------------------------------------

describe('API integration (mocked DB)', () => {
  test('GET / returns the API index with links', async () => {
    const { res, body } = await get('/');
    expect(res.status).toBe(200);
    expect(body.links.databases).toContain('/databases');
  });

  test('GET /databases lists configured databases', async () => {
    const { res, body } = await get('/databases');
    expect(res.status).toBe(200);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data[0]).toHaveProperty('name');
  });

  test('GET /health reports per-database status', async () => {
    const { res, body } = await get('/health');
    expect(res.status).toBe(200);
    expect(body.status).toBe('ok');
    expect(Object.values(body.databases)).toContain('connected');
  });

  test('GET /{db}/tables lists tables with counts', async () => {
    const { res, body } = await get(`/${MOCK_DB}/tables`);
    expect(res.status).toBe(200);
    expect(body.data).toEqual([
      { name: 'interview', row_count: 3, column_count: INTERVIEW_COLUMNS.length },
      { name: 'ts_themes', row_count: 5, column_count: THEMES_COLUMNS.length },
    ]);
  });

  test('GET /{db}/tables/{table} returns schema; unknown table is 404', async () => {
    const { res, body } = await get(`/${MOCK_DB}/tables/interview`);
    expect(res.status).toBe(200);
    expect(body.data.name).toBe('interview');
    expect(body.data.columns.length).toBe(INTERVIEW_COLUMNS.length);

    const missing = await get(`/${MOCK_DB}/tables/nope`);
    expect(missing.res.status).toBe(404);
    expect(missing.res.headers.get('Content-Type')).toBe('application/problem+json');
  });

  test('unknown database is a 404 problem', async () => {
    const { res, body } = await get('/not_a_db/tables');
    expect(res.status).toBe(404);
    expect(body.title).toBe('Not Found');
    expect(body.instance).toBe('/not_a_db/tables');
  });

  test('GET records returns envelope with pagination', async () => {
    const { res, body } = await get(`/${MOCK_DB}/tables/interview/records?limit=2`);
    expect(res.status).toBe(200);
    expect(body.data.length).toBe(2);
    expect(body.pagination).toEqual({ limit: 2, offset: 0 });
    expect(res.headers.get('Link')).toContain('rel="next"');
  });

  test('count=true adds total and Link uses it', async () => {
    const { res, body } = await get(`/${MOCK_DB}/tables/interview/records?limit=2&offset=2&count=true`);
    expect(body.pagination.total).toBe(3);
    expect(res.headers.get('Link')).toContain('rel="prev"');
    expect(res.headers.get('Link')).not.toContain('rel="next"');
  });

  test('filters produce parameterized WHERE clauses', async () => {
    sqlLog.length = 0;
    const { res } = await get(`/${MOCK_DB}/tables/interview/records?filter%5Bcode%5D%5Blike%5D=OH-%25&filter%5Blang%5D=lg-eng&sort=-section_id`);
    expect(res.status).toBe(200);

    const dataQuery = sqlLog.find(q => q.sql.includes('SELECT *'));
    expect(dataQuery).toBeTruthy();
    expect(dataQuery!.sql).toContain('`code` LIKE ?');
    expect(dataQuery!.sql).toContain('`lang` = ?');
    expect(dataQuery!.sql).toContain('ORDER BY `section_id` DESC');
    expect(dataQuery!.params.slice(0, 2)).toEqual(['OH-%', 'lg-eng']);
  });

  test('invalid filter operator is a 400 problem', async () => {
    const { res, body } = await get(`/${MOCK_DB}/tables/interview/records?filter%5Bcode%5D%5Blke%5D=x`);
    expect(res.status).toBe(400);
    expect(body.title).toBe('Validation Error');
  });

  test('invalid limit is a 400 problem with pointer', async () => {
    const { res, body } = await get(`/${MOCK_DB}/tables/interview/records?limit=99999`);
    expect(res.status).toBe(400);
    expect(body.errors[0].pointer).toBe('limit');
  });

  test('GET record returns all language variants with meta', async () => {
    const { res, body } = await get(`/${MOCK_DB}/tables/interview/records/1`);
    expect(res.status).toBe(200);
    expect(body.data.length).toBe(2);
    expect(body.meta).toEqual({ section_id: 1, languages: ['lg-eng', 'lg-spa'] });
  });

  test('GET record with lang narrows to one variant and sets Content-Language', async () => {
    const { res, body } = await get(`/${MOCK_DB}/tables/interview/records/1?lang=lg-spa`);
    expect(res.status).toBe(200);
    expect(body.data.length).toBe(1);
    expect(body.data[0].title).toBe('Entrevista con María');
    expect(res.headers.get('Content-Language')).toBe('lg-spa');
  });

  test('GET record 404s for missing id or missing lang variant', async () => {
    expect((await get(`/${MOCK_DB}/tables/interview/records/999`)).res.status).toBe(404);
    expect((await get(`/${MOCK_DB}/tables/interview/records/2?lang=lg-cat`)).res.status).toBe(404);
  });

  test('GET record rejects lang on tables without lang column', async () => {
    const { res, body } = await get(`/${MOCK_DB}/tables/ts_themes/records/1?lang=lg-eng`);
    expect(res.status).toBe(400);
    expect(body.detail).toContain('lang');
  });

  test('GET record rejects non-numeric id', async () => {
    const { res } = await get(`/${MOCK_DB}/tables/interview/records/abc`);
    expect(res.status).toBe(400);
  });

  test('fields selection keeps lang for variant identification', async () => {
    sqlLog.length = 0;
    const { res } = await get(`/${MOCK_DB}/tables/interview/records/1?fields=code,title`);
    expect(res.status).toBe(200);
    const dataQuery = sqlLog.find(q => q.sql.includes('SELECT `code`'));
    expect(dataQuery!.sql).toContain('`lang`');
  });

  test('fulltext search returns relevance and fragments', async () => {
    const { res, body } = await get(`/${MOCK_DB}/tables/interview/search?q=guerra&count=true`);
    expect(res.status).toBe(200);
    expect(body.data[0].relevance).toBe(1.5);
    expect(body.data[0].fragments[0].text).toContain('<mark>guerra</mark>');
    expect(body.pagination.total).toBe(1);
  });

  test('fulltext search requires q', async () => {
    const { res } = await get(`/${MOCK_DB}/tables/interview/search`);
    expect(res.status).toBe(400);
  });

  test('fulltext search on a missing column is a 400, not a 500', async () => {
    const { res, body } = await get(`/${MOCK_DB}/tables/interview/search?q=x&column=nope`);
    expect(res.status).toBe(400);
    expect(body.detail).toContain('Unknown column');
  });

  test('text fragments on a missing column is a 400', async () => {
    const { res } = await get(`/${MOCK_DB}/tables/interview/records/1/fragments?terms=x&column=nope`);
    expect(res.status).toBe(400);
  });

  test('text fragments include page references', async () => {
    const { res, body } = await get(`/${MOCK_DB}/tables/interview/records/1/fragments?terms=guerra&max_occurrences=5`);
    expect(res.status).toBe(200);
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data[0].text).toContain('<mark>guerra</mark>');
    expect(body.data[0].page).toBe(1);
    expect(body.meta).toEqual({ section_id: 1, terms: 'guerra' });
  });

  test('av fragments include timecoded media URLs', async () => {
    const { res, body } = await get(`/${MOCK_DB}/tables/interview/records/1/av-fragments?terms=guerra&max_occurrences=5`);
    expect(res.status).toBe(200);
    const fragment = body.data[0];
    expect(fragment.transcription).toContain('<mark>guerra</mark>');
    expect(fragment.media.video_url).toContain('vbegin=');
    expect(fragment.media.tc_in).toBeGreaterThanOrEqual(0);
  });

  test('fragments 404 for missing record', async () => {
    const { res } = await get(`/${MOCK_DB}/tables/interview/records/999/fragments?terms=x`);
    expect(res.status).toBe(404);
  });

  test('av-indexation-fragment resolves a locator', async () => {
    const { res, body } = await get(`/${MOCK_DB}/av-indexation-fragment?section_id=1&tc_in=10&tc_out=20`);
    expect(res.status).toBe(200);
    expect(body.data.media.video_url).toContain('vbegin=10');
    expect(body.data.speakers[0].name).toBe('María García');
    // The point of the endpoint: the words spoken in THIS window, not the whole transcription.
    // Asserting only the status and the media URL is how the extraction bug below stayed hidden.
    expect(body.data.transcription).toBe('guerra talk here');
  });

  // Regression. The transcription is '[tc-0-10] hello [tc-10-20] guerra talk here [tc-20-30] tail'.
  // The old scan closed its window only when the start marker was not at index 0, so:
  //   - the 0–10 window never closed and returned the ENTIRE transcription;
  //   - every later window used one marker as both start and end, so the slice held nothing but
  //     the marker, and the caller got an EMPTY STRING back.
  // Each case below fails against that code.
  test.each([
    [0, 10, 'hello'],
    [10, 20, 'guerra talk here'],
    [20, 30, 'tail'],
  ])('av-indexation-fragment cuts the %i-%i window to exactly its passage', async (tcIn, tcOut, expected) => {
    const { res, body } = await get(
      `/${MOCK_DB}/av-indexation-fragment?section_id=1&tc_in=${tcIn}&tc_out=${tcOut}`,
    );

    expect(res.status).toBe(200);
    expect(body.data.transcription).toBe(expected);
  });

  test('av-indexation-fragment spans every segment the window overlaps', async () => {
    // A window straddling two segments must return both — overlap, not containment.
    const { res, body } = await get(`/${MOCK_DB}/av-indexation-fragment?section_id=1&tc_in=5&tc_out=15`);

    expect(res.status).toBe(200);
    expect(body.data.transcription).toBe('hello guerra talk here');
  });

  test('av-indexation-fragment serves the whole transcription when the locator carries no window', async () => {
    // tc_in/tc_out default to 0: there is no window to cut, so "everything" is the usable answer.
    const { res, body } = await get(`/${MOCK_DB}/av-indexation-fragment?section_id=1`);

    expect(res.status).toBe(200);
    expect(body.data.transcription).toBe('hello guerra talk here tail');
  });

  test('av-indexation-fragment returns the indexed terms for a tagged locator', async () => {
    // Regression: the terms UNION filtered on t.indexation without projecting it, so
    // the query always errored and the service's catch returned an empty list. Terms
    // were silently ALWAYS empty; the endpoint looked healthy.
    const { res, body } = await get(
      `/${MOCK_DB}/av-indexation-fragment?section_id=1&component_tipo=rsc36&tag_id=3&tc_in=10&tc_out=20`,
    );

    expect(res.status).toBe(200);
    expect(body.data.terms).toEqual([
      { term_id: 'ts_themes_1', term: 'guerra civil' },
      { term_id: 'ts_onomastic_5', term: 'María García' },
    ]);
  });

  test('resolve_inverse_relations=true expands dd_relations rows', async () => {
    const { res, body } = await get(`/${MOCK_DB}/tables/interview/records/1?lang=lg-eng&resolve_inverse_relations=true`);
    expect(res.status).toBe(200);
    const ddRelations = body.data[0].dd_relations;
    expect(Array.isArray(ddRelations)).toBe(true);
    expect(ddRelations[0].section_id).toBe(2);
  });

  test('batch executes data queries through the same routes', async () => {
    const { executeBatch } = await import('../src/services/batch.service');
    const result = await executeBatch({
      queries: [
        { id: 'tables', path: `/${MOCK_DB}/tables` },
        { id: 'records', path: `/${MOCK_DB}/tables/interview/records`, params: { limit: 1, 'filter[lang]': 'lg-eng' } },
        { id: 'missing', path: `/${MOCK_DB}/tables/nope` },
      ],
    });
    const byId = Object.fromEntries(result.results.map(r => [r.id, r]));
    expect(byId.tables.status).toBe(200);
    expect(byId.records.status).toBe(200);
    expect((byId.records.data as any).pagination.limit).toBe(1);
    expect(byId.missing.status).toBe(404);
  });
});

describe('routeRequest (mocked DB)', () => {
  const BASE = `http://localhost:3100${config.BASE_PATH}`;

  test('strips BASE_PATH before matching', async () => {
    const res = await routeRequest(new Request(`${BASE}/databases`));
    expect(res.status).toBe(200);
  });

  test('serves the root index for the bare base path', async () => {
    const res = await routeRequest(new Request(`${BASE}/`));
    expect(res.status).toBe(200);
  });

  test('favicon returns 204', async () => {
    const res = await routeRequest(new Request(`${BASE}/favicon.ico`));
    expect(res.status).toBe(204);
  });

  test('docs asset prefixes are routed to asset handlers', async () => {
    const res = await routeRequest(new Request(`${BASE}/docs/swagger/swagger-ui.css`));
    expect(res.status).toBe(200);
  });

  test('unknown route throws NotFoundError', async () => {
    expect(routeRequest(new Request(`${BASE}/nope`))).rejects.toThrow('Route not found');
  });
});

describe('POST /batch route (mocked DB)', () => {
  const post = (body: string, contentType = 'application/json') =>
    handleBatch(new Request('http://localhost/batch', {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body,
    }));

  test('rejects wrong content type', async () => {
    expect(post('{}', 'text/plain')).rejects.toThrow('Content-Type');
  });

  test('rejects invalid JSON body', async () => {
    expect(post('{not json')).rejects.toThrow('valid JSON');
  });

  test('executes a valid batch', async () => {
    const res = await post(JSON.stringify({
      queries: [{ id: 'a', path: `/${MOCK_DB}/tables`, params: {} }],
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as { results: Array<{ id: string; status: number }> };
    expect(body.results[0]).toMatchObject({ id: 'a', status: 200 });
  });
});

describe('resolve relations (mocked DB)', () => {
  test('forward resolution replaces id arrays with rows', async () => {
    const rows = [{ section_id: 9, image: '[2]' }] as Record<string, unknown>[];
    const resolved = await resolveRelations(MOCK_DB, rows, '{"image":"interview"}');
    const image = resolved[0].image as Array<{ section_id: number }>;
    expect(Array.isArray(image)).toBe(true);
    expect(image[0].section_id).toBe(2);
  });

  test('resolves locator-style arrays with section_id objects', async () => {
    const rows = [{ rel: [{ section_id: 1 }] }] as Record<string, unknown>[];
    const resolved = await resolveRelations(MOCK_DB, rows, '{"rel":"interview"}');
    expect((resolved[0].rel as unknown[]).length).toBeGreaterThan(0);
  });

  test('auto target resolves table/section_id objects', async () => {
    const rows = [{ link: '{"table":"interview","section_id":1}' }] as Record<string, unknown>[];
    const resolved = await resolveRelations(MOCK_DB, rows, '{"link":"auto"}');
    expect(Array.isArray(resolved[0].link)).toBe(true);
  });

  test('non-array cell values are left untouched', async () => {
    const rows = [{ image: 'plain-string.jpg' }] as Record<string, unknown>[];
    const resolved = await resolveRelations(MOCK_DB, rows, '{"image":"interview"}');
    expect(resolved[0].image).toBe('plain-string.jpg');
  });

  test('deep dot-notation keys resolve nested columns', async () => {
    const rows = [{ eventos: '[1]' }] as Record<string, unknown>[];
    const resolved = await resolveRelations(MOCK_DB, rows, '{"eventos":"interview","eventos.image":"interview"}');
    expect(Array.isArray(resolved[0].eventos)).toBe(true);
  });

  test('inverse resolution with explicit map', async () => {
    const rows = [{ dd_relations: '[{"section_tipo":"rsc170","section_id":2}]' }] as Record<string, unknown>[];
    const resolved = await resolveInverseRelations(MOCK_DB, rows, '{"rsc170":"interview"}');
    const dd = resolved[0].dd_relations as Array<{ section_id: number }>;
    expect(dd[0].section_id).toBe(2);
  });

  test('inverse resolution skips unknown section_tipo', async () => {
    const rows = [{ dd_relations: '[{"section_tipo":"zzz","section_id":2}]' }] as Record<string, unknown>[];
    const resolved = await resolveInverseRelations(MOCK_DB, rows, '{"rsc170":"interview"}');
    expect(resolved[0].dd_relations).toEqual([]);
  });
});

describe('MCP server', () => {
  test('handleMcpRequest answers a JSON-RPC initialize', async () => {
    const { handleMcpRequest } = await import('../src/mcp/server');
    const res = await handleMcpRequest(new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0.0' },
        },
      }),
    }));
    expect(res.status).toBeLessThan(500);
  });
});

describe('MCP tools (mocked DB)', () => {
  const text = (result: { content: Array<{ text: string }> }) => result.content[0].text;
  const parsed = (result: { content: Array<{ text: string }> }) => JSON.parse(text(result));

  test('list_databases', async () => {
    const result = await handleToolCall('list_databases', {});
    expect(parsed(result).databases).toEqual(dbNames);
  });

  test('get_schema for all tables and one table', async () => {
    const all = parsed(await handleToolCall('get_schema', { db: MOCK_DB }));
    expect(all.map((t: { name: string }) => t.name)).toContain('interview');

    const one = parsed(await handleToolCall('get_schema', { db: MOCK_DB, table: 'interview' }));
    expect(one.name).toBe('interview');
  });

  test('search_records with structured filters and sort', async () => {
    const result = parsed(await handleToolCall('search_records', {
      db: MOCK_DB,
      table: 'interview',
      filters: [{ field: 'code', op: 'like', value: 'OH-%' }],
      sort: '-section_id',
      limit: 2,
      count: true,
    }));
    expect(result.data.length).toBe(2);
    expect(result.total).toBe(3);
  });

  test('get_record returns language variants', async () => {
    const result = parsed(await handleToolCall('get_record', { db: MOCK_DB, table: 'interview', section_id: 1 }));
    expect(result.data.length).toBe(2);
    expect(result.languages).toEqual(['lg-eng', 'lg-spa']);
  });

  test('count_records with filters and with fulltext q', async () => {
    const filtered = parsed(await handleToolCall('count_records', {
      db: MOCK_DB, table: 'interview', filters: [{ field: 'lang', value: 'lg-eng' }],
    }));
    expect(filtered.total).toBe(3);

    const fulltext = parsed(await handleToolCall('count_records', { db: MOCK_DB, table: 'interview', q: 'guerra' }));
    expect(fulltext.total).toBe(1);
  });

  test('fulltext_search and fragment tools', async () => {
    const search = parsed(await handleToolCall('fulltext_search', { db: MOCK_DB, table: 'interview', q: 'guerra' }));
    expect(search.data[0].fragments.length).toBeGreaterThan(0);

    const fragments = parsed(await handleToolCall('get_text_fragment', {
      db: MOCK_DB, table: 'interview', section_id: 1, terms: 'guerra', max_occurrences: 3,
    }));
    expect(fragments.data[0].text).toContain('<mark>');

    const av = parsed(await handleToolCall('get_av_fragment', {
      db: MOCK_DB, section_id: 1, terms: 'guerra',
    }));
    expect(av.data[0].media).toBeTruthy();

    const locator = parsed(await handleToolCall('get_av_indexation_fragment', {
      db: MOCK_DB, section_id: 1, tc_in: 10, tc_out: 25,
    }));
    expect(locator.data.transcription).toContain('guerra talk here');
  });

  test('errors surface as text content, not exceptions', async () => {
    const unknownTool = await handleToolCall('does_not_exist', {});
    expect(text(unknownTool)).toContain('Unknown tool');

    const badFilter = await handleToolCall('search_records', {
      db: MOCK_DB, table: 'interview', filters: [{ field: 'code', op: 'like' }],
    });
    expect(text(badFilter)).toContain('Error:');

    const badDb = await handleToolCall('get_schema', { db: 'nope' });
    expect(text(badDb)).toContain('Unknown database');
  });
});

describe('inverse relation resolution (bounds and malformed data)', () => {
  // The file's stated contract is that resolution is DECORATION: a cell it cannot resolve is
  // left as-is and the request still succeeds. One JSON.parse sat outside that guard, so a
  // single unparseable element in a dd_relations array threw out of the whole REQUEST (500) —
  // the one thing the contract promises never to happen. Needs malformed published data to hit.
  test('a malformed locator is skipped, not fatal to the request', async () => {
    const rows = [
      {
        section_id: 9,
        dd_relations: '["{{{ not json at all", {"section_tipo":"rsc170","section_id":2}]',
      },
    ] as Record<string, unknown>[];

    const resolved = await resolveInverseRelations(MOCK_DB, rows, true);

    // It survived, AND the well-formed locator beside the broken one still resolved.
    const ddRelations = resolved[0].dd_relations as Array<Record<string, unknown>>;
    expect(Array.isArray(ddRelations)).toBe(true);
    expect(ddRelations.length).toBe(1);
    expect(ddRelations[0].section_id).toBe(2);
  });

  test('fan-out is capped at MAX_RESOLVE_ROWS per cell', async () => {
    // One query per locator, for every row on the page. Uncapped, a heavily cross-referenced
    // record turns a single listing into an unbounded number of queries — the forward path
    // has always bounded this; the inverse path did not.
    const locators = Array.from({ length: MAX_RESOLVE_ROWS + 25 }, () => ({
      section_tipo: 'rsc170',
      section_id: 2,
    }));
    const rows = [{ section_id: 9, dd_relations: JSON.stringify(locators) }] as Record<string, unknown>[];

    const resolved = await resolveInverseRelations(MOCK_DB, rows, true);

    const ddRelations = resolved[0].dd_relations as unknown[];
    expect(ddRelations.length).toBeLessThanOrEqual(MAX_RESOLVE_ROWS);
  });
});

describe('unknown columns are a client error (400), not a server error (500)', () => {
  // A typo in sort/fields/filter used to reach MariaDB, come back as an "unknown column"
  // driver error, and be served as 500 Internal Server Error — the server blaming itself for
  // the client's typo. http_semantics.md has always documented these as 400 validation errors.
  // Verified against the real published DB before the fix: all three answered 500.
  test.each([
    ['sort', '?sort=does_not_exist'],
    ['fields', '?fields=does_not_exist'],
    ['filter', '?filter[does_not_exist][eq]=1'],
  ])('an unknown %s column is rejected with 400 and names the column', async (_kind, query) => {
    const { res, body } = await get(`/${MOCK_DB}/tables/interview/records${query}`);

    expect(res.status).toBe(400);
    expect(body.detail).toContain('does_not_exist');
  });

  test('an unknown fields column on a single record is also 400', async () => {
    const { res, body } = await get(`/${MOCK_DB}/tables/interview/records/1?fields=does_not_exist`);

    expect(res.status).toBe(400);
    expect(body.detail).toContain('does_not_exist');
  });

  test('real columns still pass', async () => {
    const { res } = await get(`/${MOCK_DB}/tables/interview/records?sort=-section_id&fields=section_id,title`);
    expect(res.status).toBe(200);
  });
});

describe('a missing FULLTEXT index is the client’s problem, not a 500', () => {
  // MariaDB answers a MATCH on an unindexed column with errno 1191. Left unmapped it reaches
  // the error handler as an unknown driver failure — a 500 blaming the server for a column the
  // caller chose. search.service maps it to a ValidationError naming the column, and these are
  // the only paths that exercise that mapping (the fixture table declares the index).
  afterEach(() => {
    fulltextRefusal = null;
  });

  test('the search statement (errno 1191) becomes a ValidationError naming the column', async () => {
    const { ValidationError } = await import('../src/errors');
    const { fulltextSearch } = await import('../src/services/search.service');
    fulltextRefusal = Object.assign(new Error('ER_FT_MATCHING_KEY_NOT_FOUND'), { errno: 1191 });

    const failed = fulltextSearch(MOCK_DB, 'interview', { q: 'guerra', column: 'title', limit: 5, offset: 0 });

    await expect(failed).rejects.toThrow(ValidationError);
    await expect(failed).rejects.toThrow('Column "title" has no FULLTEXT index');
  });

  test('the count statement maps the mysql2-era string code the same way', async () => {
    const { ValidationError } = await import('../src/errors');
    const { fulltextSearch } = await import('../src/services/search.service');
    fulltextRefusal = Object.assign(new Error('ER_FT_MATCHING_KEY_NOT_FOUND'), {
      code: 'ER_FT_MATCHING_KEY_NOT_FOUND',
    });

    const failed = fulltextSearch(MOCK_DB, 'interview', {
      q: 'guerra',
      column: 'title',
      limit: 0,
      offset: 0,
      withTotal: true,
    });

    await expect(failed).rejects.toThrow(ValidationError);
    await expect(failed).rejects.toThrow('Column "title" has no FULLTEXT index');
  });

  test('any other failure is rethrown untouched — never dressed up as a client error', async () => {
    const { fulltextSearch } = await import('../src/services/search.service');
    fulltextRefusal = new Error('MariaDB server has gone away');

    await expect(
      fulltextSearch(MOCK_DB, 'interview', { q: 'guerra', column: 'title', limit: 5, offset: 0 }),
    ).rejects.toThrow('MariaDB server has gone away');
  });
});
