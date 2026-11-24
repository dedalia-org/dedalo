/**
 * Relation resolution: turning the ids a published row CARRIES into the rows they POINT AT.
 *
 * The diffusion process flattens Dédalo's relational graph into standalone tables, and a
 * relation survives as a JSON array of `section_id`s sitting inside a TEXT column. A
 * client that wants the related rows would otherwise have to read that array and issue a
 * second request per column. These two functions do that server-side, in one round trip.
 *
 * TWO DIRECTIONS, and they are not symmetric:
 *
 *   - FORWARD (`resolveRelations`, `?resolve_relations`) — outbound. The caller names the
 *     columns to expand and the table each one points at, because nothing in the cell
 *     itself says where its ids live. Any column, any table.
 *
 *   - INVERSE (`resolveInverseRelations`, `?resolve_inverse_relations`) — inbound. Always
 *     and only the `dd_relations` column, which diffusion fills with LOCATORS of the
 *     records that point AT this one: `{section_tipo, section_id}`. `section_tipo` is an
 *     ontology type ("rsc170"), not a table, so a map is still needed to land it — but
 *     that map is a property of the publication, not of the request, so `true` loads it
 *     from the `publication_schema` table and the caller supplies nothing.
 *
 * CONTRACT — resolution is DECORATION, never a failure mode. A cell that cannot be
 * resolved (unparseable, wrong shape, target table absent, query fails) is left exactly as
 * it was, and the request still succeeds with the rest of its data. Every `catch` in this
 * file is that promise, not a swallowed bug. Consequently a client must always be prepared
 * to see the raw id array it asked to have expanded.
 *
 * BOUNDS — resolution is client-directed fan-out, so it is capped in every dimension it
 * has: MAX_RESOLVE_DEPTH (3) on nesting, MAX_RESOLVE_ROWS (50) on ids per cell, and
 * MAX_RESOLVE_KEYS (10) on how many columns one request may name. The first two used to be
 * the whole story and were claimed to keep a cheap request from turning into thousands of
 * queries; they bound one CELL, while the cost of a request is rows × keys × ids × depth
 * (audit 2026-08-26, PUB-05). The product is bounded in turn by the per-request query
 * budget charged in db/pool.ts (security/request-budget.ts) — the backstop that holds
 * however these caps are combined.
 *
 * MUTATION — the row objects are written IN PLACE (the arrays are shallow-copied, the rows
 * inside them are not). Rows here are freshly fetched per request and owned by the caller
 * that just built them, so this is safe; it is the same bargain utils/parse-json makes.
 */

import { dbExecute } from '../db/pool';
import { validateTableName, validateColumnName } from '../db/query-builder';
import { parseJsonStrings } from '../utils/parse-json';
import { BudgetExceededError, ValidationError } from '../errors';
import { COLUMNS, PUBLICATION_SCHEMA_TABLE, PUBLICATION_SCHEMA_ID, MAX_RESOLVE_DEPTH, MAX_RESOLVE_ROWS, MAX_RESOLVE_KEYS } from '../constants';
import { TTLCache } from '../db/schema-cache';
import type { DbRow } from '../db/types';

/** column → target table (forward). */
export type RelationMap = Record<string, string>;
/** section_tipo → target table (inverse). */
export type InverseRelationMap = Record<string, string>;

const schemaCache = new TTLCache<InverseRelationMap>(30);
const ERRNO_NO_SUCH_TABLE = 1146;

/**
 * The publication's own `section_tipo` → table map, written by diffusion into
 * `publication_schema` row 1 as JSON under a `dd_relations` key. This is what makes
 * `?resolve_inverse_relations=true` possible: the mapping is a fact about how this
 * database was published, so the server can look it up instead of asking the client to
 * know the ontology.
 *
 * A missing table/row/key is a 400, not a 500: it means this publication was not written
 * with a schema row, so `true` is a request the client cannot make here — it must pass an
 * explicit map. Cached 30 s, like the schema introspection, because it changes only on
 * republication.
 */
export async function getPublicationSchema(db: string): Promise<InverseRelationMap> {
  const cacheKey = `${db}:dd_relations`;
  const cached = schemaCache.get(cacheKey);
  if (cached) return cached;

  validateTableName(PUBLICATION_SCHEMA_TABLE);

  const sql = `SELECT data FROM \`${PUBLICATION_SCHEMA_TABLE}\` WHERE id = ?`;
  let rows: DbRow[];
  try {
    rows = await dbExecute<DbRow[]>(db, sql, [PUBLICATION_SCHEMA_ID]);
  } catch (error) {
    // errno 1146 (no such table): a publication written without a schema table — the
    // Dédalo v7 diffusion engine writes none — is the same client-side 400 as an empty one.
    // Bun's MySQLError carries the server's number in `errno` (its `code` is Bun's own).
    if (error instanceof Error && (error as { errno?: number }).errno === ERRNO_NO_SUCH_TABLE) {
      throw new ValidationError('publication_schema table not found or empty');
    }
    throw error;
  }

  const row = (rows as Record<string, unknown>[])[0];
  if (!row || !row.data) {
    throw new ValidationError('publication_schema table not found or empty');
  }

  const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
  const ddRelations = data?.dd_relations as InverseRelationMap | undefined;
  if (!ddRelations || typeof ddRelations !== 'object') {
    throw new ValidationError('dd_relations mapping not found in publication_schema');
  }

  schemaCache.set(cacheKey, ddRelations);
  return ddRelations;
}

/**
 * DoS bound #3 — the CARDINALITY of the request map, the dimension the original two caps
 * did not cover (audit 2026-08-26, PUB-05). Depth bounds nesting and MAX_RESOLVE_ROWS
 * bounds one cell, but the number of COLUMNS to expand was whatever the caller sent, and
 * the cost of a request is rows × keys × rows-per-cell × depth. A map with a hundred keys
 * multiplied the other two caps by a hundred.
 *
 * Refused, not truncated: unlike a cell's id list (data we did not write, silently capped),
 * the map is the caller's own question, and answering half of it without saying so would be
 * a wrong answer rather than a partial one.
 */
function assertResolveCardinality(map: Record<string, string>, parameter: string): void {
  const keys = Object.keys(map).length;
  if (keys > MAX_RESOLVE_KEYS) {
    throw new ValidationError(
      `${parameter} names ${keys} columns; at most ${MAX_RESOLVE_KEYS} may be resolved in one request`,
    );
  }
}

// The relation map arrives as a JSON string in a query parameter, so it is UNTRUSTED
// input twice over: it must be valid JSON, and it must be a flat object of strings —
// every value ends up naming a table (and possibly a column), which is then interpolated
// into SQL after identifier validation. Rejecting the shape here means resolveColumn only
// ever deals with strings.
//
// The re-throw guard matters: JSON.parse and our own ValidationErrors both land in the
// same catch, and without it a precise "value must be a string" message would be
// flattened into a misleading "must be valid JSON".
function parseRelationMap(value: string): RelationMap {
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new ValidationError('resolve_relations must be a JSON object like {"image":"image"}');
    }
    for (const [key, val] of Object.entries(parsed)) {
      if (typeof val !== 'string') {
        throw new ValidationError(`resolve_relations value for "${key}" must be a string, got ${typeof val}`);
      }
    }
    assertResolveCardinality(parsed as RelationMap, 'resolve_relations');
    return parsed as RelationMap;
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    throw new ValidationError('resolve_relations must be valid JSON');
  }
}

function parseInverseRelationMap(value: string): InverseRelationMap {
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new ValidationError('resolve_inverse_relations must be a JSON object like {"rsc170":"images"}');
    }
    for (const [key, val] of Object.entries(parsed)) {
      if (typeof val !== 'string') {
        throw new ValidationError(`resolve_inverse_relations value for "${key}" must be a string, got ${typeof val}`);
      }
    }
    assertResolveCardinality(parsed as InverseRelationMap, 'resolve_inverse_relations');
    return parsed as InverseRelationMap;
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    throw new ValidationError('resolve_inverse_relations must be valid JSON');
  }
}

/**
 * Forward resolution over a page of rows.
 *
 * READ THE DOT CAREFULLY — it means two different things on the two sides of a mapping,
 * and this is the single most confusing thing in the file:
 *
 *   {"eventos.documentos": "image"}   dot in the KEY   → a PATH: resolve `eventos`, then
 *                                                        resolve `documentos` INSIDE each
 *                                                        resolved eventos row.
 *   {"birthplace_id": "location.term_id"} dot in the VALUE → a TARGET: match against
 *                                                        `location`.`term_id` instead of
 *                                                        the usual `section_id`.
 *
 * A dotted key therefore also implies its own prefix must be resolved: `eventos.documentos`
 * silently adds `eventos → eventos` (resolve the column against the same-named table) so
 * that there are rows to descend into. Naming both explicitly is allowed — an explicit
 * `{"eventos": "events_table", "eventos.documentos": "image"}` wins, because the explicit
 * key is set in `topLevelKeys` and the implicit default only fills a gap.
 */
export async function resolveRelations(
  db: string,
  rows: Record<string, unknown>[],
  relationMapRaw: string,
  depth: number = 0,
): Promise<Record<string, unknown>[]> {
  const relationMap = parseRelationMap(relationMapRaw);

  // Split the flat request map into "what to expand on THIS row" and "what to expand on
  // the rows that come back", keyed by full path so resolveColumn can re-derive its own
  // children.
  const topLevelKeys: RelationMap = {};
  const deepKeys: Record<string, string> = {};

  for (const [key, target] of Object.entries(relationMap)) {
    if (key.includes('.')) {
      const [column, deepField] = key.split('.', 2);
      deepKeys[key] = target;
      // The prefix column must be resolved for the nested step to have anything to work
      // on; default it to the same-named table, unless the caller already said otherwise.
      if (!topLevelKeys[column]) {
        topLevelKeys[column] = column;
      }
    } else {
      topLevelKeys[key] = target;
    }
  }

  if (depth >= MAX_RESOLVE_DEPTH) {
    return rows;
  }

  const result = [...rows];

  // One resolution per (row, column). This is an N+1 by construction — the cost is bounded
  // by the page `limit` above and the caps below, not avoided. Batching every row's ids
  // into one IN() per column would be the optimisation, at the price of re-splitting the
  // result back out per row.
  for (const row of result) {
    for (const [column, target] of Object.entries(topLevelKeys)) {
      // A column the caller asked to expand but that this table does not have is not an
      // error: the same map is often applied across a heterogeneous set of tables.
      if (!(column in row)) continue;
      if (column === '_resolved_from') continue;

      const cellValue = row[column];

      try {
        row[column] = await resolveColumn(
          db,
          cellValue,
          target,
          column,
          deepKeys,
          depth,
        );
      } catch (error) {
        // The per-request query budget is NOT an unresolvable column: it is the request
        // being stopped. Swallowing it here returned 200 with silently truncated columns —
        // the DoS bound held, but the documented 429 was unreachable on the only path that
        // can actually spend the budget (audit 2026-08-26, PUB-05).
        if (error instanceof BudgetExceededError) throw error;
        // skip unresolvable columns, leave original value
      }
    }
  }

  return result;
}

/**
 * Expand ONE cell into the rows it references, then recurse into those rows if the request
 * asked for a nested step.
 *
 * Returns the resolved rows on success and the ORIGINAL cell value on any of the several
 * ways a cell can turn out not to be a relation at all — this function's every early
 * `return cellValue` is the "resolution is decoration" contract in action, not an
 * oversight. Only a genuinely broken query throws (and the caller catches that too).
 */
async function resolveColumn(
  db: string,
  cellValue: unknown,
  target: string,
  column: string,
  deepKeys: Record<string, string>,
  depth: number,
): Promise<unknown> {
  // auto case: parse the cell value to determine target table dynamically.
  //
  // A "link" column does not point at a fixed table — the cell itself says where it
  // lands: {"table":"interview","section_id":1}. So the table name comes from the
  // DATABASE CONTENT rather than from the client, which is precisely why it still has to
  // clear validateTableName before being interpolated: "published" is not "trusted", and
  // this is the one place in the API where an identifier originates in stored data.
  if (target === 'auto') {
    if (typeof cellValue !== 'string') return cellValue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(cellValue);
    } catch {
      return cellValue;
    }
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      if (obj.table && obj.section_id) {
        const table = String(obj.table);
        const sectionId = Number(obj.section_id);
        validateTableName(table);
        return fetchRows(db, table, [sectionId]);
      }
    }
    return cellValue;
  }

  // standard case: cell value is a JSON array of section_ids.
  //
  // Two input shapes, and BOTH are real: the cell may still be the raw TEXT the driver
  // returned, or it may already be an array because utils/parse-json got to it first
  // (executeQuery parses JSON-looking columns before this ever runs, but the auto path and
  // some cells do not go through it). Handling both is what keeps resolution independent of
  // where its rows came from.
  //
  // Within the array, an entry may be a bare id or an object carrying `section_id` —
  // diffusion writes both, depending on the component that produced the relation.
  let sectionIds: (number | string)[];

  if (typeof cellValue === 'string') {
    try {
      const parsed = JSON.parse(cellValue);
      if (Array.isArray(parsed)) {
        sectionIds = parsed.map(item => {
          if (typeof item === 'object' && item !== null && 'section_id' in item) {
            return (item as Record<string, unknown>).section_id as number;
          }
          return Number(item);
        }).filter(n => !isNaN(n));
      } else {
        return cellValue;
      }
    } catch {
      return cellValue;
    }
  } else if (Array.isArray(cellValue)) {
    sectionIds = cellValue.map(item => {
      if (typeof item === 'object' && item !== null && 'section_id' in (item as object)) {
        return (item as Record<string, unknown>).section_id as number;
      }
      return Number(item);
    }).filter(n => !isNaN(n));
  } else {
    return cellValue;
  }

  if (sectionIds.length === 0) return cellValue;

  // Dot notation: "table.column" means match against a non-section_id column.
  // Needed because not every relation is expressed as a section_id — a cell may carry
  // thesaurus term_ids, say, in which case the join column is `term_id`, not the key.
  let matchColumn: string = COLUMNS.SECTION_ID;
  let table = target;

  if (target.includes('.')) {
    const [tbl, col] = target.split('.', 2);
    table = tbl;
    matchColumn = col;
    validateColumnName(matchColumn);
  }

  validateTableName(table);

  // DoS bound #1 — the WIDTH of the fan-out. A single cell decides how many ids go into
  // one IN(...) list, and cells are data we did not write; a record with thousands of
  // relations must not turn one request into a thousand-way lookup (multiplied by every
  // row on the page, and again by every nested level). Truncation is deliberate and
  // silent: a partially resolved column still serves the request, and there is no error
  // to report because nothing went wrong.
  if (sectionIds.length > MAX_RESOLVE_ROWS) {
    sectionIds = sectionIds.slice(0, MAX_RESOLVE_ROWS);
  }

  const resolved = await fetchRowsByIds(db, table, matchColumn, sectionIds);

  // Deep resolution: check if there are nested resolve keys for this column.
  // `deepKeys` is keyed by full path ("eventos.documentos"); strip our own prefix to learn
  // what to expand on the rows we just fetched ("documentos").
  const childDeepKeys: Record<string, string> = {};
  for (const [deepKey, deepTarget] of Object.entries(deepKeys)) {
    const prefix = `${column}.`;
    if (deepKey.startsWith(prefix)) {
      const childField = deepKey.slice(prefix.length);
      childDeepKeys[childField] = deepTarget;
    }
  }

  // DoS bound #2 — the DEPTH of the fan-out, which is the dangerous one: each level
  // multiplies the queries of the level above, so an uncapped chain is exponential.
  // MAX_RESOLVE_DEPTH stops it dead. Note the recursive call passes `{}` for deepKeys, so
  // the child cannot spawn grandchildren of its own — a dotted key buys exactly one extra
  // level, and the cap is the ceiling on nesting rather than the usual case.
  if (Object.keys(childDeepKeys).length > 0 && depth < MAX_RESOLVE_DEPTH - 1) {
    const childRelationRaw = JSON.stringify(childDeepKeys);
    for (const resolvedRow of resolved) {
      for (const [childField, childTarget] of Object.entries(childDeepKeys)) {
        if (!(childField in resolvedRow)) continue;
        try {
          resolvedRow[childField] = await resolveColumn(
            db,
            resolvedRow[childField],
            childTarget,
            childField,
            {},
            depth + 1,
          );
        } catch (error) {
          if (error instanceof BudgetExceededError) throw error;
          // skip unresolvable child columns
        }
      }
    }
  }

  return resolved;
}

/**
 * The one statement every resolution path ends in. `table` and `matchColumn` are already
 * identifier-validated by the callers (they cannot be bound); the ids are bound, always,
 * one placeholder each — never joined into the string.
 *
 * The ids are coerced to the type the column expects: numeric for the `section_id` key,
 * string otherwise, since a "table.column" target typically matches a textual id (a
 * thesaurus `term_id`), and a numeric bind against a text column would not match.
 *
 * Rows come back through parseJsonStrings, so a resolved row is as fully interpreted as a
 * top-level one — including the nested id arrays that a deep resolution then descends into.
 */
async function fetchRowsByIds(
  db: string,
  table: string,
  matchColumn: string,
  ids: (number | string)[],
): Promise<Record<string, unknown>[]> {
  const placeholders = ids.map(() => '?').join(',');
  const params = matchColumn === COLUMNS.SECTION_ID
    ? ids.map(id => Number(id))
    : ids.map(id => String(id));

  const sql = `SELECT * FROM \`${table}\` WHERE \`${matchColumn}\` IN (${placeholders})`;
  const rows = await dbExecute<DbRow[]>(db, sql, params);
  return parseJsonStrings(rows as Record<string, unknown>[]);
}

// Note there is no `lang` narrowing anywhere in this file: resolving a relation against a
// multilingual table returns ALL language variants of the target record.
async function fetchRows(
  db: string,
  table: string,
  sectionIds: number[],
): Promise<Record<string, unknown>[]> {
  return fetchRowsByIds(db, table, COLUMNS.SECTION_ID, sectionIds);
}

/**
 * Inverse resolution: expand the `dd_relations` column — who points AT this record.
 *
 * The column holds LOCATORS, Dédalo's universal cross-reference: `{section_tipo,
 * section_id}`, where `section_tipo` is an ontology type ("rsc170") rather than a table
 * name. Resolving one therefore takes two steps — map the tipo to the table it was
 * published as, then read the row. Only the mapping is negotiable, which is why this
 * function takes a map (explicit, or `true` to load the publication's own).
 *
 * The column is REPLACED by the resolved rows, so `dd_relations` changes type under the
 * client: an array of locators becomes an array of records. Locators whose tipo is absent
 * from the map, or whose row will not load, are dropped silently — an inverse relation to
 * a section the publisher chose not to publish is normal, not an error.
 */
export async function resolveInverseRelations(
  db: string,
  rows: Record<string, unknown>[],
  inverseMapRaw: string | true,
): Promise<Record<string, unknown>[]> {
  let inverseMap: InverseRelationMap;

  if (inverseMapRaw === true) {
    inverseMap = await getPublicationSchema(db);
  } else {
    inverseMap = parseInverseRelationMap(inverseMapRaw);
  }

  const result = [...rows];

  for (const row of result) {
    // Absent column: this table simply has no inverse relations. Not an error — the map
    // is routinely applied to a mixed set of tables.
    const cellValue = row[COLUMNS.DD_RELATIONS];
    if (cellValue === undefined || cellValue === null) continue;

    // As in the forward path, the cell may arrive raw or already parsed.
    let locators: unknown[];
    if (typeof cellValue === 'string') {
      try {
        locators = JSON.parse(cellValue);
      } catch {
        continue;
      }
    } else if (Array.isArray(cellValue)) {
      locators = cellValue;
    } else {
      continue;
    }

    const resolved: Record<string, unknown>[] = [];

    // One query per locator, so the same MAX_RESOLVE_ROWS bound the forward path puts on ids
    // per cell applies here. Without it a heavily cross-referenced record fans out as far as
    // its dd_relations column goes — and this runs for EVERY row on the page, so an
    // unbounded column turns one listing into an unbounded number of queries.
    const bounded = locators.slice(0, MAX_RESOLVE_ROWS);

    for (const locator of bounded) {
      // A locator may be stored as a JSON string inside the array. Malformed data is skipped,
      // never thrown: this parse used to sit outside the guard below, so a single unparseable
      // element would abort the entire REQUEST — the one thing this file promises never to do.
      let loc: unknown;
      if (typeof locator === 'string') {
        try {
          loc = JSON.parse(locator);
        } catch {
          continue;
        }
      } else {
        loc = locator;
      }

      if (typeof loc !== 'object' || loc === null) continue;

      // Both fields are mandatory and a section_id of 0 is meaningless, so a locator
      // missing either is skipped rather than turned into a query for nothing.
      const sectionTipo = String((loc as Record<string, unknown>).section_tipo ?? '');
      const sectionId = Number((loc as Record<string, unknown>).section_id ?? 0);

      if (!sectionTipo || !sectionId || isNaN(sectionId)) continue;

      // An unmapped tipo is the normal case, not a failure: the map covers the sections
      // this publication chose to expose, and inbound links from anything else are dropped.
      const targetTable = inverseMap[sectionTipo];
      if (!targetTable) continue;

      try {
        // The table name comes from the map, which for `true` came out of the DATABASE —
        // validated for the same reason the `auto` path validates: stored ≠ trusted.
        validateTableName(targetTable);
        const fetched = await fetchRows(db, targetTable, [sectionId]);
        resolved.push(...fetched);
      } catch (error) {
        if (error instanceof BudgetExceededError) throw error;
        // skip unresolvable locators
      }
    }

    row[COLUMNS.DD_RELATIONS] = resolved;
  }

  return result;
}

// The query-string forms of the two parameters. `resolve_relations` needs nothing but an
// empty-to-undefined guard, so it is a passthrough that exists to keep both parameters
// going through one normalisation step at every call site.
export function normalizeResolveRelations(value: string | undefined | null): string | undefined {
  if (!value) return undefined;
  return value;
}

// The asymmetric one: `resolve_inverse_relations` accepts a JSON map OR the literal
// "true"/"1", meaning "load the map from publication_schema". This is where that string
// becomes the boolean the resolver branches on — a JSON map is passed through untouched.
export function normalizeResolveInverseRelations(value: string | undefined | null): string | true | undefined {
  if (!value) return undefined;
  if (value === 'true' || value === '1') return true;
  return value;
}

export { parseRelationMap, parseInverseRelationMap };