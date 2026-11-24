/**
 * The query DSL: `filter[field][op]=value` and `sort=a,-b` in, SQL fragments plus
 * bound parameters out.
 *
 * The module is deliberately two halves with a data structure between them:
 *
 *   parse  →  FilterCondition[] / OrderClause[]  →  build
 *
 * Parsing owns the GRAMMAR (what a client may write); building owns the SQL. The
 * intermediate array is what lets a service inject its own conditions — the `lang`
 * and `section_id` predicates in records.service are made with `condition()` — so
 * server-added and client-supplied filters travel the identical validate-and-bind
 * path. There is no second way to reach the WHERE clause.
 *
 * The security contract of the build half, which is the reason it exists at all:
 * a field name is an IDENTIFIER and cannot be bound as a parameter, so it is
 * re-validated here and back-tick quoted; every VALUE becomes a `?` and lives in
 * the returned params array. The two are positional and must stay together — the
 * caller appends the fragment and the params in the same order (db/query-builder).
 *
 * Note what the DSL cannot express, by design: conditions are ANDed, there is no
 * OR and no grouping. That keeps the generated WHERE flat and predictable, at the
 * cost of a query language a client cannot use to construct an arbitrary predicate.
 */

import { ValidationError } from '../errors';

export const VALID_OPERATORS = new Set(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'like', 'in', 'not_in', 'is_null', 'is_not_null']);

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Exactly one or two bracket groups. `[^\]]+` cannot span a `]`, so `filter[a][b][c]`
// and `filter[]` fail to match and are rejected outright rather than being read
// leniently — a filter the server silently misunderstands is worse than a 400.
const FILTER_KEY_RE = /^filter\[([^\]]+)\](?:\[([^\]]+)\])?$/;

export interface FilterCondition {
  field: string;
  operator: string;
  values: (string | number | null)[];
}

export interface OrderClause {
  field: string;
  direction: 'ASC' | 'DESC';
}

function validateIdentifier(name: string, label: string): void {
  if (!IDENTIFIER_RE.test(name)) {
    throw new ValidationError(`Invalid ${label}: ${name}`);
  }
}

/**
 * Builds a condition in code rather than from a query string — used by the services
 * for the predicates the SERVER adds (a `lang` narrowing, the `section_id` of a
 * single-record read). Such a condition is not validated here; buildWhere is what
 * validates, and it validates everything it is given regardless of origin.
 */
export function condition(field: string, operator: string, values: (string | number | null)[]): FilterCondition {
  return { field, operator, values };
}

// Parses filter[field]=value and filter[field][op]=value query parameters.
// Repeated keys each produce one condition; all conditions are ANDed.
export function parseFilterParams(searchParams: URLSearchParams): FilterCondition[] {
  const conditions: FilterCondition[] = [];

  for (const [key, value] of searchParams.entries()) {
    // Anything that is not a filter belongs to another parser (limit, sort, lang…),
    // so it is skipped — but a key that LOOKS like a filter and is malformed must
    // not slip through as "not a filter", hence the bare `filter` case is caught too.
    if (key !== 'filter' && !key.startsWith('filter[')) continue;

    const match = FILTER_KEY_RE.exec(key);
    if (!match) {
      throw new ValidationError(`Malformed filter parameter: "${key}". Expected filter[field]=value or filter[field][op]=value`);
    }

    const field = match[1].trim();
    const operator = (match[2] ?? 'eq').trim().toLowerCase();

    validateIdentifier(field, 'filter field');

    if (!VALID_OPERATORS.has(operator)) {
      throw new ValidationError(`Invalid filter operator: "${operator}". Valid: ${[...VALID_OPERATORS].join(', ')}`);
    }

    // The null tests take no operand, so whatever the client sent as the value is
    // discarded — `filter[parent][is_null]=` (empty, as a URL requires) is the
    // canonical form, and `…[is_null]=1` means the same thing rather than 400ing.
    if (operator === 'is_null' || operator === 'is_not_null') {
      conditions.push({ field, operator, values: [] });
      continue;
    }

    // Pipe, not comma: commas are common inside real published values (names,
    // titles), pipes are not. An empty list would build `IN ()`, which is a SQL
    // syntax error, so it is refused here rather than at the database.
    if (operator === 'in' || operator === 'not_in') {
      const values = value.split('|').map(v => v.trim()).filter(v => v !== '');
      if (values.length === 0) {
        throw new ValidationError(`Filter "${key}" requires at least one pipe-separated value`);
      }
      conditions.push({ field, operator, values });
      continue;
    }

    // Single-operand operators keep the value verbatim — no trim. A trailing space
    // may be exactly what the client is filtering for, and `like` patterns carry
    // the client's own `%` wildcards, which are its business, not ours.
    conditions.push({ field, operator, values: [value] });
  }

  return conditions;
}

/**
 * Parses sort=title,-date into ORDER BY clauses (leading "-" = descending).
 *
 * The check is on the SHAPE of the name, not on its existence: a well-formed name
 * for a column the table does not have is passed through, and the database is what
 * rejects it. That is safe (the identifier regex has already made injection
 * impossible) but it is why a typo'd sort field surfaces as a server error rather
 * than a validation error.
 */
export function parseSort(sort: string): OrderClause[] {
  const clauses: OrderClause[] = [];

  // Empty segments are dropped rather than rejected, so a trailing comma or a
  // stray space in a hand-built URL is not an error. A bare "-" leaves an empty
  // field name, which the identifier check then refuses.
  for (const part of sort.split(',').map(p => p.trim()).filter(Boolean)) {
    const direction = part.startsWith('-') ? 'DESC' : 'ASC';
    const field = part.startsWith('-') ? part.slice(1).trim() : part;

    validateIdentifier(field, 'sort field');
    clauses.push({ field, direction });
  }

  return clauses;
}

const NUMERIC_RE = /^-?\d+(\.\d+)?$/;

/**
 * A range operand that is a plain number binds AS a number, so the comparison is
 * numeric even on a text column: publication columns often hold numbers as text
 * (`date_in` = '-150'), and compared as strings '-150' >= '-100' and '9' > '10'.
 * Anything else (an ISO date, a code) stays text and compares as text. Integers
 * past 2^53 stay text: a double would round them.
 */
function rangeOperand(value: string | number | null): string | number | null {
  if (typeof value !== 'string' || !NUMERIC_RE.test(value)) return value;
  const number = Number(value);
  return Number.isInteger(number) && !Number.isSafeInteger(number) ? value : number;
}

/**
 * Renders conditions into a WHERE fragment (without the `WHERE` keyword) and the
 * positionally matching parameter list. An empty condition list yields an empty
 * string, which is how the caller knows to omit the clause entirely.
 *
 * This is the LAST place a field name is checked before it is concatenated into
 * SQL, and it re-validates every one — including conditions built in code by
 * `condition()`, which never passed through the query-string parser. Trusting the
 * caller here is what would turn a future refactor into an injection.
 */
export function buildWhere(conditions: FilterCondition[]): { sql: string; params: (string | number | null)[] } {
  const clauses: string[] = [];
  const params: (string | number | null)[] = [];

  for (const { field, operator, values } of conditions) {
    validateIdentifier(field, 'filter field');
    const quoted = `\`${field}\``;

    // Every branch below emits placeholders and pushes the operands; no operand is
    // ever formatted into the SQL string. The IN/NOT IN branches expand to one `?`
    // per value — the only place the placeholder count is dynamic — and the null
    // tests push nothing, keeping the params array aligned with the placeholders.
    switch (operator) {
      case 'eq':
        clauses.push(`${quoted} = ?`);
        params.push(values[0]);
        break;
      case 'ne':
        clauses.push(`${quoted} != ?`);
        params.push(values[0]);
        break;
      case 'gt':
        clauses.push(`${quoted} > ?`);
        params.push(rangeOperand(values[0]));
        break;
      case 'gte':
        clauses.push(`${quoted} >= ?`);
        params.push(rangeOperand(values[0]));
        break;
      case 'lt':
        clauses.push(`${quoted} < ?`);
        params.push(rangeOperand(values[0]));
        break;
      case 'lte':
        clauses.push(`${quoted} <= ?`);
        params.push(rangeOperand(values[0]));
        break;
      case 'like':
        clauses.push(`${quoted} LIKE ?`);
        params.push(values[0]);
        break;
      case 'in':
        clauses.push(`${quoted} IN (${values.map(() => '?').join(',')})`);
        params.push(...values);
        break;
      case 'not_in':
        clauses.push(`${quoted} NOT IN (${values.map(() => '?').join(',')})`);
        params.push(...values);
        break;
      case 'is_null':
        clauses.push(`${quoted} IS NULL`);
        break;
      case 'is_not_null':
        clauses.push(`${quoted} IS NOT NULL`);
        break;
      // Unreachable from a query string (parseFilterParams already checked the
      // operator against VALID_OPERATORS), but reachable from `condition()`. The
      // switch is an allowlist, so an unknown operator must throw rather than fall
      // through and silently drop a predicate — a dropped filter would WIDEN the
      // result set, which is the dangerous direction to fail in.
      default:
        throw new ValidationError(`Invalid filter operator: "${operator}"`);
    }
  }

  // AND only — see the module header. Conditions never carry their own SQL text, so
  // this join cannot produce anything the switch above did not emit.
  return { sql: clauses.join(' AND '), params };
}

// `direction` is not interpolated user input: it is a closed union produced by
// parseSort, so only the two literals can reach the SQL. The field still is user
// input, hence the same validate-then-quote as everywhere else.
export function buildOrder(clauses: OrderClause[]): string {
  return clauses.map(({ field, direction }) => {
    validateIdentifier(field, 'sort field');
    return `\`${field}\` ${direction}`;
  }).join(', ');
}
