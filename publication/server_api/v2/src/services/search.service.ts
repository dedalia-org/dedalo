/**
 * The three search surfaces, all read-only:
 *
 *   - `fulltextSearch`  — find records: MariaDB `MATCH … AGAINST` over a FULLTEXT-indexed
 *                         column, ranked by relevance.
 *   - `textFragments`   — find passages inside ONE known record (books, theses), with page
 *                         references from Dédalo's `[page-n-N]` markers.
 *   - `avFragments`     — the same, for an audiovisual record: passages carry the
 *                         `[tc-in-out]` timecode window, so the answer is a video clip.
 *
 * The division of labour matters: the DATABASE decides which records match (that is what
 * the FULLTEXT index is for), and JAVASCRIPT cuts the excerpts (utils/fragments) — the
 * index can rank a document but cannot hand back a windowed, `<mark>`-highlighted
 * passage. So the fragment functions never search; they fetch one row and scan it, which
 * is why they take a `section_id` rather than a query.
 *
 * Every entry point asserts the table (and, where it interpolates one, the column) exists
 * before composing SQL — see schema.service for why that ordering is the security story.
 */

import { validateColumnName } from '../db/query-builder';
import { dbExecute } from '../db/pool';
import { avSchema, config } from '../config';
import { parseJsonStrings } from '../utils/parse-json';
import { NotFoundError, ValidationError, isMissingTableOrColumnError } from '../errors';
import { COLUMNS } from '../constants';
import { extractFragments, pageAtPosition, timecodesAtPosition } from '../utils/fragments';
import { resolveRelations, resolveInverseRelations, normalizeResolveRelations, normalizeResolveInverseRelations } from './resolve.service';
import { assertTableExists, tableHasColumn } from './schema.service';
import type { TextFragment, AvFragment, MediaInfo } from '../db/types';
import type { DbRow } from '../db/types';
import { clampLimit, clampOffset } from '../validators';

export interface FulltextOptions {
  q: string;
  column: string;
  limit: number;
  offset: number;
  withTotal?: boolean;
  /** One language variant only; without it a hit comes back once per language row. */
  lang?: string;
  resolve_relations?: string;
  resolve_inverse_relations?: string;
}

// `column` is client-supplied and gets back-tick interpolated (MATCH cannot bind an
// identifier), so it must both match the identifier grammar and be proven to exist
// before it reaches a statement. Existence is only half the story — the column also
// needs a FULLTEXT index, and INFORMATION_SCHEMA.COLUMNS cannot tell us that; MariaDB
// answers it, which is what mapFulltextError below is for.
async function assertSearchableColumn(db: string, table: string, column: string): Promise<void> {
  validateColumnName(column);
  if (!(await tableHasColumn(db, table, column))) {
    throw new ValidationError(`Unknown column "${column}" in table "${table}". Pass ?column= with a FULLTEXT-indexed text column`);
  }
}

// MariaDB raises 1191 when MATCH targets a column without a FULLTEXT index —
// a client problem, not a server one.
const ERRNO_FT_MATCHING_KEY_NOT_FOUND = 1191;

function mapFulltextError(error: unknown, column: string): never {
  // The Bun MariaDB adapter surfaces the numeric errno; keep the mysql2-era string
  // code as a fallback so the mapping holds whichever shape the driver reports.
  const { code, errno } = error as { code?: string; errno?: number };
  if (error instanceof Error && (errno === ERRNO_FT_MATCHING_KEY_NOT_FOUND || code === 'ER_FT_MATCHING_KEY_NOT_FOUND')) {
    throw new ValidationError(`Column "${column}" has no FULLTEXT index; fulltext search is not available on it`);
  }
  throw error;
}

/**
 * FULLTEXT search over one column, in BOOLEAN MODE — so the user's `q` is not just a bag
 * of words but a small query language of its own (`+must -not "exact phrase"`), passed
 * through to MariaDB verbatim. It is a bound parameter, so there is nothing to escape;
 * a malformed operator sequence is MariaDB's to reject, not ours to parse.
 *
 * `relevance` is the MATCH score aliased into the projection so callers can see the
 * ranking they were given, and ORDER BY relies on it. Repeating MATCH in SELECT and
 * WHERE is the idiomatic form: MariaDB recognises the identical expression and does not
 * score the row twice.
 */
export async function fulltextSearch(
  db: string,
  table: string,
  options: FulltextOptions,
): Promise<{ rows: Record<string, unknown>[]; total?: number }> {
  // Clamped, not trusted — this statement writes its own LIMIT rather than going through
  // db/query-builder.ts, so it needs the same backstop the builder has (validators.ts
  // clampLimit): the page bound must hold for every door and every caller, not only for
  // requests that arrived through an entry schema.
  const { q, column, withTotal = false } = options;
  const limit = clampLimit(options.limit);
  const offset = clampOffset(options.offset);

  await assertTableExists(db, table);
  await assertSearchableColumn(db, table, column);

  const escapedCol = `\`${column}\``;

  // Same rule as the record list: a lang on a table without the column is a 400, never ignored.
  const { lang } = options;
  if (lang && !(await tableHasColumn(db, table, COLUMNS.LANG))) {
    throw new ValidationError(`Table "${table}" has no "${COLUMNS.LANG}" column; the lang parameter is not supported`);
  }
  const langClause = lang ? ` AND \`${COLUMNS.LANG}\` = ?` : '';
  const langParams = lang ? [lang] : [];

  // limit=0 is the count-only request (the `count_records` MCP tool takes this path):
  // skip the search entirely and fall through to the COUNT below.
  let rows: Record<string, unknown>[] = [];
  if (limit > 0) {
    const sql = `
      SELECT *, MATCH(${escapedCol}) AGAINST(? IN BOOLEAN MODE) as relevance
      FROM \`${table}\`
      WHERE MATCH(${escapedCol}) AGAINST(? IN BOOLEAN MODE)${langClause}
      ORDER BY relevance DESC
      LIMIT ? OFFSET ?
    `;
    const result = await dbExecute<DbRow[]>(db, sql, [q, q, ...langParams, limit, offset])
      .catch(error => mapFulltextError(error, column));

    // Each hit is decorated with the passages that produced it. The excerpt window (320
    // chars, up to 3 per term) is fixed here rather than exposed: these are result
    // previews, not the fragment endpoints, which do take caller-supplied bounds.
    // Note the boolean-mode operators in `q` are matched literally by the JS scan, so a
    // term written `+guerra` simply finds nothing to highlight — the row is still returned.
    rows = parseJsonStrings(result as Record<string, unknown>[]).map(row => {
      const text = (row[column] as string) || '';
      const fragments = extractFragments(text, q, 320, 3);
      return { ...row, fragments };
    });

    const relMap = normalizeResolveRelations(options.resolve_relations);
    const invMap = normalizeResolveInverseRelations(options.resolve_inverse_relations);
    if (relMap) {
      rows = await resolveRelations(db, rows, relMap);
    }
    if (invMap) {
      rows = await resolveInverseRelations(db, rows, invMap);
    }
  }

  // A second statement, not a window function: the count must ignore LIMIT/OFFSET, and
  // it is only paid for when the caller asks (`count=true`).
  let total: number | undefined;
  if (withTotal) {
    const countSql = `
      SELECT COUNT(*) as total
      FROM \`${table}\`
      WHERE MATCH(${escapedCol}) AGAINST(? IN BOOLEAN MODE)${langClause}
    `;
    const countRows = await dbExecute<DbRow[]>(db, countSql, [q, ...langParams])
      .catch(error => mapFulltextError(error, column));
    total = (countRows as Array<{ total: number }>)[0]?.total ?? 0;
  }

  return { rows, total };
}

export interface FragmentOptions {
  terms: string;
  column?: string;
  lang?: string;
  max_characters: number;
  max_occurrences: number;
}

/**
 * Fetch the ONE row a fragment request scans.
 *
 * A section_id can name several rows (one per language), but a fragment is cut from a
 * single text, so this deliberately collapses to `LIMIT 1`. Without an explicit `lang`
 * that means the first variant in `lang` order — the ORDER BY is what makes "first"
 * deterministic instead of whatever the engine returns.
 */
async function fetchRecordText(
  db: string,
  table: string,
  id: number,
  columns: string[],
  lang?: string,
): Promise<Record<string, unknown>> {
  // A `lang` on a table that has no such column is ignored here rather than rejected —
  // the filter is simply not applied (contrast getRecord, which 400s).
  const hasLang = await tableHasColumn(db, table, COLUMNS.LANG);

  const selectCols = columns.map(col => `\`${col}\``).join(', ');
  let sql = `SELECT ${selectCols} FROM \`${table}\` WHERE \`${COLUMNS.SECTION_ID}\` = ?`;
  const params: (string | number)[] = [id];

  if (lang && hasLang) {
    sql += ` AND \`${COLUMNS.LANG}\` = ?`;
    params.push(lang);
  }
  if (hasLang) {
    sql += ` ORDER BY \`${COLUMNS.LANG}\` ASC`;
  }
  sql += ' LIMIT 1';

  const rows = await dbExecute<DbRow[]>(db, sql, params);

  if (rows.length === 0) {
    const langSuffix = lang ? ` (lang: ${lang})` : '';
    throw new NotFoundError(`Record not found: ${table}/${id}${langSuffix}`);
  }

  return rows[0] as Record<string, unknown>;
}

/**
 * Passages from a long text, with the page they fall on.
 *
 * `page` comes from Dédalo's inline `[page-n-N]` markers, so it is the page of the
 * ORIGINAL document, not a computed offset — and it is optional, because a text that was
 * never paginated carries no markers. `position` is the character offset of the match in
 * the (scan-capped) text: the stable handle a client can use to ask for more context.
 *
 * No FULLTEXT index is involved: the scan is a literal, regex-escaped substring search
 * done in JS, so this works on any text column — matching inside words, and matching the
 * short words a fulltext index would not have. `column` need only exist.
 */
export async function textFragments(
  db: string,
  table: string,
  id: number,
  options: FragmentOptions,
): Promise<TextFragment[]> {
  const { terms, column = COLUMNS.TRANSCRIPTION, lang, max_characters, max_occurrences } = options;

  await assertTableExists(db, table);
  await assertSearchableColumn(db, table, column);

  const row = await fetchRecordText(db, table, id, [column], lang);
  const text = (row[column] as string) || '';

  return extractFragments(text, terms, max_characters, max_occurrences).map(fragment => ({
    text: fragment.text,
    page: pageAtPosition(text, fragment.position),
    position: fragment.position,
  }));
}

/**
 * Passages from an audiovisual record's transcription, each turned into a playable clip.
 *
 * This is `textFragments` with the timeline attached: the transcription is annotated with
 * `[tc-in-out]` markers, so the character position of a match maps back to a moment in
 * the video, and the fragment is returned as a media URL carrying that window. The record
 * row and its media row are joined here because the text and the video file that the text
 * transcribes live in different published tables.
 *
 * The join is LEFT: a record whose media is missing still yields its passages, with empty
 * URLs. `speakers` is always `[]` on this path — the diarisation the shape allows for is
 * only populated by the indexation service.
 */
export async function avFragments(
  db: string,
  table: string,
  id: number,
  options: FragmentOptions,
): Promise<AvFragment[]> {
  const { terms, lang, max_characters, max_occurrences } = options;

  await assertTableExists(db, table);

  const hasLang = await tableHasColumn(db, table, COLUMNS.LANG);

  // Media table/column are configured (AV_* keys, boot-validated identifiers), not
  // hardcoded to the oral-history ontology — see src/config.ts.
  let sql = `
    SELECT i.*, a.\`${COLUMNS.IMAGE}\`, a.\`${avSchema.videoColumn}\` as video
    FROM \`${table}\` i
    LEFT JOIN \`${avSchema.mediaTable}\` a ON i.\`${COLUMNS.SECTION_ID}\` = a.\`${COLUMNS.SECTION_ID}\`
    WHERE i.\`${COLUMNS.SECTION_ID}\` = ?
  `;
  const params: (string | number)[] = [id];

  if (lang && hasLang) {
    sql += ` AND i.\`${COLUMNS.LANG}\` = ?`;
    params.push(lang);
  }
  if (hasLang) {
    sql += ` ORDER BY i.\`${COLUMNS.LANG}\` ASC`;
  }
  sql += ' LIMIT 1';

  const rows = await dbExecute<DbRow[]>(db, sql, params).catch(error => {
    if (isMissingTableOrColumnError(error)) {
      throw new ValidationError(
        `AV fragments are not available on this database: its "${avSchema.mediaTable}" table is missing or lacks the AV_* columns (${(error as Error).message})`,
      );
    }
    throw error;
  });

  if (rows.length === 0) {
    const langSuffix = lang ? ` (lang: ${lang})` : '';
    throw new NotFoundError(`Record not found: ${table}/${id}${langSuffix}`);
  }

  const row = parseJsonStrings(rows[0] as Record<string, unknown>);
  // The transcription may be published under a friendly name or under its raw component
  // tipo (AV_TRANSCRIPTION_COLUMN, e.g. `rsc36`), depending on how the table was written;
  // accept either rather than force a configuration choice on every publication.
  const transcription =
    (row.transcription as string) || (row[avSchema.transcriptionColumn] as string) || '';

  return extractFragments(transcription, terms, max_characters, max_occurrences).map(fragment => {
    // The timecode of a match is the window OPEN at that character: markers precede the
    // speech they time, so the covering window is the last one before the match position.
    const { tcIn, tcOut } = timecodesAtPosition(transcription, fragment.position);
    return {
      transcription: fragment.text,
      media: buildMediaInfo(row, tcIn, tcOut),
      speakers: [],
    };
  });
}

/**
 * The clip URL is where the timecode window becomes usable: `?vbegin=&vend=` is the
 * contract a Dédalo media player reads to seek and stop, so a "fragment" of an interview
 * is delivered as a URL, not as bytes — this API never touches media files. Missing media
 * yields '' rather than a broken URL, so a client can test the field directly.
 * MEDIA_BASE_URL is where the published files are actually served from (another host, in
 * general), which is why it is configuration and not a route of this API.
 */
export function buildMediaInfo(row: Record<string, unknown>, tcIn: number, tcOut: number): MediaInfo {
  const video = row.video as string | undefined;
  const image = row.image as string | undefined;

  return {
    video_url: video ? `${config.MEDIA_BASE_URL}/${video}?vbegin=${tcIn}&vend=${tcOut}` : '',
    image_url: image ? `${config.MEDIA_BASE_URL}/${image}` : '',
    tc_in: tcIn,
    tc_out: tcOut,
  };
}
